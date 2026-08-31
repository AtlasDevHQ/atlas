/**
 * **The review gate, named** (#5568,
 * [ADR-0036](../../../../../docs/adr/0036-atlas-as-company-brain.md) §T4/§T9,
 * [ADR-0043](../../../../../docs/adr/0043-the-company-keystone-is-asked-for-never-researched.md)).
 *
 * *"An agent proposes a fact → a human reviews it → it is promoted."* That
 * sentence is the brain's central control, and until this module existed no
 * file said it. Tracing it crossed ~16,500 lines across `lib/brain/`,
 * `lib/content-mode/` and `api/routes/`, and the only thing that named the
 * concept was ~20 prose cross-references in docstrings — which is to say the
 * gate was a claim about the code rather than a thing in it.
 *
 * This module is a **facade over machinery that already existed**. It moves no
 * subsystem, owns no SQL, writes no row, and makes no gate decision of its own:
 * every verb below composes an existing internal, and each of those internals
 * keeps its own tests, its own docstring and its own callers. What is new is
 * that a reader — or a reviewer, or the ADR-0043 wizard — can find the four
 * verbs in one place and see that they are four faces of one gate.
 *
 * ## The reviewer's four verbs
 *
 * | Verb | Composes | Decides |
 * |---|---|---|
 * | {@link queued} | `candidates.loadFactCandidates` | what is awaiting review |
 * | {@link previewApprove} | `oversight.loadSupersessionPreview` + `loadWideningPreview` | what approving would DO, before it is done |
 * | {@link approve} | `content-mode/adapters/brain-facts.promoteBrainFacts` | draft → published, with refusals, widening and supersession |
 * | {@link reject} | `correction.correctFact` (`retract`) | tombstone + an auditable human-authored correction episode |
 *
 * ## ⚠️ Approve is the only asymmetric one, and #5568 is what fixed it
 *
 * Reject has always been per-fact and addressable: it takes an id. Approve was
 * not addressable **at all** — `promoteBrainFacts(tx, orgId)` selected every
 * `status='draft'` row in the workspace, so *"approve"* meant *"publish this
 * workspace's entire draft backlog, across facts, semantic entities and
 * dashboards, through an unrelated route"*. ADR-0043 promises the Company
 * Keystone wizard's confirmation screen is *"the review gate wearing a
 * friendlier skin — same table, **same promotion adapter**, same audit row"*,
 * and that promise is unsatisfiable while the adapter can only publish
 * everything: a wizard confirming five keystone answers cannot call it without
 * publishing every unrelated draft in the tenant.
 *
 * So {@link approve} takes an optional id scope, and `promoteBrainFacts` grew
 * the filter **on itself** rather than gaining a second writer beside it — the
 * `brain_facts.status` single-writer rule (`check-brain-fact-promotion.sh`)
 * holds unchanged, with no allowlist growth. The scope is a deliberate
 * carve-out from *"every publish is the one atomic workspace-wide
 * transaction"*, and its rationale is recorded where the content-mode rule
 * requires: `docs/development/content-mode.md`'s carve-out list.
 *
 * **The scoped arm applies the same promotion policy as the unscoped one** —
 * the same `classifyFactForPromotion` refusals, the same `WIDEN_AND_PROMOTE`
 * grant widening, the same audit rows and the same supersession behaviour,
 * filtered to the ids, inside one transaction. That is not a convention this
 * module asks callers to honour; it is structural, because the scope is applied
 * at the adapter's draft READ and every later statement is keyed off the ids
 * that read returned. `brain-facts-scoped-promotion.test.ts` pins it by running
 * both arms over identical fixture rows and comparing the reports.
 *
 * ## What this module deliberately is NOT
 *
 * - **Not a transaction owner.** {@link approve} takes the caller's
 *   `ModeTxClient`, exactly as `promoteBrainFacts` does, so a scoped approve
 *   can still commit atomically with whatever else its caller is doing — which
 *   is the whole shape ADR-0043's wizard needs. ⚠️ **This is why `approve`
 *   returns an `Effect` while its three siblings return a `Promise`**, and the
 *   asymmetry is deliberate rather than unfinished: the read verbs own their
 *   own query and can settle, whereas `approve` is a phase inside somebody
 *   else's transaction and must compose with `runPublishPhases`. Flattening it
 *   to a `Promise` would mean this module opening a transaction, which is the
 *   one thing the bullet above says it must not do.
 * - **Not a route.** No wire contract moves here. `/api/v1/admin/publish` and
 *   `/api/v1/admin/brain-facts/*` call the same internals they called before.
 * - **Not an authority check.** Each internal keeps its own: `loadFactCandidates`
 *   and the previews resolve the reader's ACL from `BrainPrincipalContext` and
 *   throw `BrainReaderUnresolvedError` on an unusable one; `correctFact` runs
 *   `correctionAuthorityRefusal`. A facade that re-checked would be a second
 *   source of truth for the thing `acl.ts` exists to be the only source of.
 */

import type { Effect } from "effect";
import type {
  BrainFactCandidateListResponse,
  BrainFactWillSupersede,
  BrainFactWillWiden,
} from "@useatlas/types";
import { promoteBrainFacts } from "@atlas/api/lib/content-mode/adapters/brain-facts";
import type {
  ModeTxClient,
  PromotionReport,
  PublishPhaseError,
} from "@atlas/api/lib/content-mode/port";
import {
  loadFactCandidates,
  type BrainCandidateReader,
  type LoadCandidatesOptions,
} from "@atlas/api/lib/brain/candidates";
import { loadSupersessionPreview, loadWideningPreview } from "@atlas/api/lib/brain/oversight";
import {
  correctFact,
  type CorrectionDeps,
  type CorrectionOutcome,
  type CorrectionRequest,
} from "@atlas/api/lib/brain/correction";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

/**
 * What is awaiting review.
 *
 * A pass-through to `loadFactCandidates`, whose `status` option defaults to
 * `draft` — the review queue. Named here so the queue is reachable from the
 * gate rather than only from the module that happens to hold its SQL.
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable
 *   principals — see `candidates.ts`.
 */
export function queued(
  db: BrainCandidateReader,
  options: LoadCandidatesOptions,
): Promise<BrainFactCandidateListResponse> {
  return loadFactCandidates(db, options);
}

/** What {@link approve} would do to this reader's workspace, before it is done. */
export interface ApprovePreview {
  /** Published rivals a promotion would retire (#4912). */
  readonly willSupersede: BrainFactWillSupersede;
  /** Grants a promotion would widen from evidence (#4823, ADR-0036 §T5). */
  readonly willWiden: BrainFactWillWiden;
}

/**
 * The two irreversible consequences of approving, disclosed before the act.
 *
 * Both loaders are reader-scoped. `factIds` narrows them to the drafts a scoped
 * {@link approve} would offer; omitted, they answer *"what would a publish of
 * this workspace's whole backlog do"* — the question the admin console's
 * publish modal asks, unchanged.
 *
 * ⭐ **The scope has to reach here, not only `approve`.** A disclosure and the
 * act it discloses must answer about the same rows: an ADR-0043 wizard
 * confirming five keystone answers, shown every supersession and widening in
 * the tenant, would be told about irreversible consequences its approve is not
 * going to perform. That is the disagreement #4912 forbids, pointing the other
 * way — over-disclosure rather than silence, but still a preview that does not
 * describe the transaction.
 *
 * The narrowing binds the DRAFT side only. In the supersession preview `p` is
 * the published rival being retired, which the reviewer never selected;
 * filtering it would hide the row the disclosure exists to name.
 *
 * ⚠️ `[]` scopes to nothing here too, exactly as in {@link approve} — the two
 * must read an empty selection the same way or the preview and the act
 * disagree on the one input most likely to be miscomputed.
 *
 * Issued as one request from two statements, never one snapshot — the contract
 * `loadFactOversight` documents for its own.
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable principals.
 */
export async function previewApprove(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  requestId?: string,
  factIds?: readonly string[],
): Promise<ApprovePreview> {
  const [willSupersede, willWiden] = await Promise.all([
    loadSupersessionPreview(db, ctx, requestId, factIds),
    loadWideningPreview(db, ctx, requestId, factIds),
  ]);
  return { willSupersede, willWiden };
}

/**
 * Promote reviewed facts — the whole workspace's draft backlog, or exactly the
 * facts named.
 *
 * `factIds` omitted is the workspace-wide publish phase the content-mode
 * registry has always run, unchanged. `factIds` present is the scoped
 * facts-only arm (#5568): the same policy, the same transaction, those rows.
 *
 * ⚠️ **An empty array approves NOTHING; only `undefined` is unscoped.** A
 * caller that computed an empty selection and fell through to workspace-wide
 * would publish a tenant's entire backlog because a reviewer ticked no boxes.
 * The distinction is enforced in the adapter and pinned by its tests.
 *
 * Runs inside the CALLER's transaction, deliberately — see this module's header.
 */
export function approve(
  tx: ModeTxClient,
  orgId: string,
  factIds?: readonly string[],
): Effect.Effect<PromotionReport, PublishPhaseError, never> {
  return promoteBrainFacts(tx, orgId, factIds);
}

/**
 * Reject one candidate — the gate's negative verb.
 *
 * The `retract` correction verb, which stamps `invalidated_at` and materializes
 * an immutable human-authored correction episode recording who rejected it and
 * why. It is **never a delete and never a demotion**: the row survives, stays
 * readable to an as-of query, and leaves the review queue, the publish preview
 * and `draftCounts`. It writes no `status` — `brain_facts.status` keeps exactly
 * one writer.
 *
 * `verb` is fixed here rather than taken from the caller: this is the gate's
 * reject, and `supersede` / `re-authority` / `pin` are corrections that make a
 * different claim. A caller wanting one of those wants `correctFact` directly,
 * which is why `correction.ts` stays exported.
 */
export function reject(
  request: Omit<CorrectionRequest, "verb">,
  deps: CorrectionDeps = {},
): Promise<CorrectionOutcome> {
  return correctFact({ ...request, verb: "retract" }, deps);
}
