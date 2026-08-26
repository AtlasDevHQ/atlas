/**
 * The **Claim Vocabulary** admin surface — direct authoring, the *In force* pane
 * and the *Pending* queue (#5087 + #5088, ADR-0037 §6, umbrella #5025).
 *
 * Mounted under `/api/v1/admin/brain-vocabulary`:
 *
 *   GET  /surfaces     — the authoring picker: norms the corpus actually produced
 *   GET  /in-force     — approved edges + curated cardinalities, plus coverage
 *   GET  /pending      — the queue: both proposal kinds, with their evidence
 *   POST /preview      — one decision's blast radius (child 1's engine)
 *   POST /author       — write an alias edge directly
 *   POST /remove       — take one back out
 *   POST /decide       — approve or reject one pending proposal, either kind
 *   POST /cardinality  — curate or un-curate a canonical predicate
 *
 * ## What this surface is FOR, and why it ships before the queue
 *
 * The Pending queue is empty on day one: `#5034`'s producer fires only on claims
 * with a non-null `object_cmp`, and *"on day one it returns zero rows"*.
 * Cardinality needs three correction events. **Direct authoring works from day
 * one** and is, per T7 §6, the only route by which #5000's own entry
 * (`is priced at → priced at`) is ever written — the structural proposer
 * provably cannot propose it, and that zero is pinned as a test.
 *
 * So the authoring half does something the day it ships, and #5000 closes on
 * **prod verification**, which needs a surface that can show the edge in force.
 * The queue (`/pending`, `/decide`, #5088) is correct and empty until a producer
 * fires, which is why it landed last rather than first.
 *
 * ## Two authorities, and both are enforced
 *
 * `adminAuth` gates the router at admin/owner/platform_admin. That is coarse —
 * it reads the SESSION's role — so every write also passes the workspace's own
 * re-resolved principal (`resolveBrainReaderContext`, which re-resolves
 * `member.role` against the workspace being written, #2890) to the seam, where
 * `authorEntitled` applies ADR-0037 §6's owner/admin bar. Neither is redundant:
 * the router keeps a non-admin session out of the surface, the seam keeps an
 * admin of ANOTHER workspace out of this one's vocabulary.
 *
 * ## Refusals are 4xx, never a 200 carrying `outcome: "refused"`
 *
 * `refusalStatus` below maps every typed refusal onto a status, and the seam's
 * prose travels verbatim in `ErrorSchema.message`. Two reasons, and the second
 * is the load-bearing one: a failed write behind a 200 is read as success by
 * every generic client in the stack; and the messages name WHICH side of a pair
 * is empty, WHICH norm is already aliased, and what to do instead — so a client
 * that mapped a code to its own sentence would be a second spelling of a rule
 * the server owns.
 *
 * ## No key ever reaches a body
 *
 * Every request and response here speaks SURFACES and NORMS.
 * `keys-not-on-the-wire.test.ts` is the guard and ADR-0037 §6 is the rule: a
 * consumer that can branch on a claim's identity key makes the vocabulary a
 * compatibility surface, at which point an alias stops being removable. The
 * cardinality routes take a `predicateSurface` and derive the key server-side
 * for exactly that reason — `BlastRadiusRequest`'s own docstring calls a
 * key-accepting request type *"the seam through which one reaches a route
 * body"*, and this file is that route body.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { resolveBrainReaderContext } from "@atlas/api/lib/brain/reader-context";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import type { SlotPosition } from "@atlas/api/lib/brain/identity";
import { loadWorkspaceVocabulary } from "@atlas/api/lib/brain/vocabulary";
import {
  OBSERVED_SURFACE_PAGE_MAX,
  SURFACE_FILTER_MAX_CHARS,
  loadObservedSurfaces,
} from "@atlas/api/lib/brain/vocabulary-surfaces";
import {
  loadInForceVocabulary,
  loadVocabularyCoverage,
} from "@atlas/api/lib/brain/vocabulary-in-force";
import {
  PENDING_PAGE_MAX,
  loadPendingQueue,
  type PendingPositionCounts,
} from "@atlas/api/lib/brain/vocabulary-pending";
import {
  loadBlastRadius,
  type StructurallyEmptyReason,
} from "@atlas/api/lib/brain/vocabulary-preview";
import {
  authorAliasEdge,
  decideAliasProposal,
  removeInForceAliasEdge,
  type AliasAuthoringRefusal,
  type AliasDecisionRefusal,
  type AliasRemovalRefusal,
} from "@atlas/api/lib/brain/vocabulary-decide";
import {
  declarePredicateCardinalityForSurface,
  decidePredicateCardinalityForSurface,
  priorAuditFields,
  type CardinalityRefusal,
} from "@atlas/api/lib/brain/cardinality";
import type { PositionalDecision } from "@atlas/api/lib/brain/vocabulary-visibility";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type {
  AuthMode,
  BrainVocabularyAuthorResponse,
  BrainVocabularyCardinalityWriteResponse,
  BrainVocabularyDecideResponse,
  BrainVocabularyPendingResponse,
  BrainVocabularyPositionCounts,
  BrainVocabularyPreviewResponse,
  BrainVocabularyRemoveResponse,
  BrainVocabularyScope,
  BrainVocabularyStructurallyEmptyReason,
} from "@useatlas/types";
import {
  BRAIN_VOCABULARY_PENDING_KINDS,
  BRAIN_VOCABULARY_SLOT_POSITIONS,
  BrainVocabularyAuthorRequestSchema,
  BrainVocabularyAuthorResponseSchema,
  BrainVocabularyCardinalityRequestSchema,
  BrainVocabularyCardinalityWriteResponseSchema,
  BrainVocabularyDecideRequestSchema,
  BrainVocabularyDecideResponseSchema,
  BrainVocabularyInForceResponseSchema,
  BrainVocabularyPendingResponseSchema,
  BrainVocabularyPreviewRequestSchema,
  BrainVocabularyPreviewResponseSchema,
  BrainVocabularyRemoveRequestSchema,
  BrainVocabularyRemoveResponseSchema,
  BrainVocabularySurfaceListSchema,
} from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, noActiveOrgBody, requireOrgContext } from "./admin-router";
// The BARREL, like `admin-brain-facts.ts` — not the two leaf modules. The route
// tests `mock.module` `@atlas/api/lib/audit`, so a leaf import walks past the
// double and writes a real row.
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";

const log = createLogger("admin-brain-vocabulary");

/**
 * An alias write's SLOT — the address these verbs act on (#5448).
 *
 * ⚠️ A type rather than three loose params, because `position` + `fromNorm`
 * (+ `toNorm`) travel together through every alias audit row AND through the
 * `targetId`, and the `position:fromNorm` formatting was written out twice
 * before this existed. One of the two is how the convention drifts.
 */
interface AliasSlot {
  readonly position: string;
  readonly fromNorm: string;
  readonly toNorm?: string;
}

/** The slot's audit address. ONE site, so `/author` and `/remove` cannot diverge. */
function slotAddress(slot: AliasSlot): string {
  return `${slot.position}:${slot.fromNorm}`;
}

/**
 * Emit one claim-vocabulary audit row (#5448).
 *
 * Collapses six call sites that differed only in verb, target and payload. The
 * three invariants they all share are asserted HERE rather than re-typed six
 * times, which is what stops the seventh from quietly omitting one:
 *
 * - `targetType` is always `brainVocabulary`.
 * - `workspaceId` is always in the metadata.
 * - ⚠️ FIRE-AND-FORGET, on `brainFact.tensionSweep`'s reasoning. These routes
 *   have already COMMITTED by the time a row is built, and `logAdminActionAwait`
 *   surfaces an error so the admin retries — which `checkedWrite` exists on this
 *   very router to prevent. An open circuit breaker costs the durable row, not
 *   the trail: the pino line is emitted either way.
 *
 * ⚠️ `targetId` is a SURFACE or a slot, never a row id — these writes address
 * slots, and `brain_predicate_cardinality` has no id at all (it is keyed on the
 * predicate). Metadata never carries a canonical identity key:
 * `keys-not-on-the-wire.test.ts` refuses `predicate_key` in a read surface, and
 * an audit row an operator reads is one.
 */
function vocabularyAudit(
  actionType: (typeof ADMIN_ACTIONS.brainVocabulary)[keyof typeof ADMIN_ACTIONS.brainVocabulary],
  workspaceId: string,
  targetId: string,
  metadata: Record<string, unknown>,
): void {
  logAdminAction({
    actionType,
    targetType: "brainVocabulary",
    targetId,
    metadata: { workspaceId, ...metadata },
  });
}

/**
 * Every response is parsed through its own wire schema before it goes out.
 *
 * `admin-brain-facts.ts`'s `checked` verbatim, and for its reason: Hono does not
 * validate responses, so without this the shared schema is a promise the API
 * makes and never checks — and the browser is where it fails, as a
 * `schema_mismatch` that blanks the surface with no server-side trace.
 *
 * It matters more here than there. Every response object on this surface is
 * `z.strictObject`, and the extra key those strict objects exist to refuse is a
 * norm-adjacent identity KEY: an EXTRA field is normally stripped by `z.object`
 * and would ship silently.
 */
function checked<T>(schema: { parse: (value: unknown) => T }, payload: unknown): T {
  return schema.parse(payload);
}

/**
 * The same guard on a WRITE route, where a failure means something different.
 *
 * ⚠️ On a read, `checked()` throwing is exactly right: nothing happened, and a
 * 500 is the honest answer. On the three WRITE routes the transaction has
 * **already committed** — the edge is in force and the corpus has been re-keyed,
 * or the predicate is curated — so the same throw produces *"Failed to author
 * brain vocabulary alias edge."* over a write that succeeded. An approver reads
 * that as "it did not work".
 *
 * That is the mirror image of the rule this file's header already states about
 * refusals behind a 200 — a write's outcome must not be misreported in either
 * direction. So the describe-it step is separated from the do-it step: the write
 * is reported as having LANDED, with the description problem named as the
 * server-side defect it is.
 *
 * ⚠️ **The message says RELOAD, not "do not retry".** An earlier cut of this
 * docstring justified the helper by claiming a retry "is refused with
 * `already-aliased`, which reads as a second failure" — and that claim was
 * itself false, sitting one paragraph above its own refutation. Re-POSTing
 * `/author` finds the approved proposal and returns `already_approved` → 200;
 * `/remove` finds the rejected row and returns `already_removed` → 200. Both
 * paths are idempotent by construction, which is what the
 * converge-on-an-existing-row design buys. `/cardinality` is idempotent too —
 * `declarePredicateCardinality` is `ON CONFLICT DO UPDATE` — but it answers a
 * plain `{ cardinality }` with no "already applied" arm, so on that route the
 * shared message's *"will simply report the change as already applied"* is the
 * weaker claim *a retry re-asserts the same value and is a no-op*; the reload is
 * still the right instruction, and the outcome is still safe. Telling an approver not to retry a
 * safe operation was a smaller lie than the one this helper replaced, and still
 * one — recorded here because a docstring that means two things is worth nothing
 * on the one that matters, and this is the helper whose entire job is honesty.
 *
 * The 500 status stays. A body that says "landed" behind a 200 is read as
 * success by exactly the generic clients this file's header worries about, and
 * the status is what stops that; the message is what stops the human reading it
 * as "nothing happened".
 */
function checkedWrite<T>(
  schema: { parse: (value: unknown) => T },
  payload: unknown,
  /**
   * ⚠️ DISCRIMINATED on the verb, because the three writes do not share an
   * identifier.
   *
   * A flat `{ verb, proposalId }` rendered *"The curation succeeded and is in
   * force — proposal is priced at"* for a cardinality write, which has no
   * proposal at all: it is an upsert on `brain_predicate_cardinality`. That
   * handed the approver a nonexistent identifier for the one write that arms
   * retroactive supersession, from inside the helper written to stop lying to
   * them about committed writes.
   */
  context: (
    // ⚠️ `rejection` appears on BOTH arms, and binding it to only one was a
    // defect this helper's own rule forbids. Round 2 added it to the
    // predicate-surface arm — but an ALIAS rejection carries a `proposalId`, so
    // it structurally could not say `"rejection"` and fell back to
    // `"authoring"`. An approver who rejected a pair was told *"The authoring
    // succeeded and is in force — proposal abc"*: a claimed workspace-wide
    // re-key that did not happen, which is the worst-direction misreport
    // `checkedWrite` exists to prevent.
    | { readonly verb: "authoring" | "removal" | "rejection"; readonly proposalId: string }
    | { readonly verb: "curation" | "rejection"; readonly predicateSurface: string }
  ) & { readonly requestId: string },
):
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly body: { readonly error: string; readonly message: string; readonly requestId: string };
    } {
  try {
    return { ok: true, body: schema.parse(payload) };
  } catch (err) {
    // ⚠️ `"predicateSurface" in context`, not a `verb` test. `context` is an
    // INTERSECTION (`(A | B) & { requestId }`), and TypeScript does not narrow a
    // discriminated union through one — so the verb test compiled on the
    // condition and failed on both branches' payloads. The `in` operator narrows
    // an intersection correctly.
    const named =
      "predicateSurface" in context
        ? {
            subject: `predicate "${context.predicateSurface}"`,
            field: { predicateSurface: context.predicateSurface },
          }
        : { subject: `proposal ${context.proposalId}`, field: { proposalId: context.proposalId } };
    log.error(
      {
        ...named.field,
        verb: context.verb,
        requestId: context.requestId,
        err: err instanceof Error ? err.message : String(err),
      },
      "brain vocabulary: a COMMITTED write could not be described by its own response schema — the write landed; the projection drifted",
    );
    return {
      ok: false,
      body: {
        error: "response_schema_mismatch",
        message:
          // ⚠️ "is in force" only for the verbs that PUT something in force. A
          // rejection records that a pair stays separate or a predicate stays
          // multi-valued; nothing is in force, and saying so is the same
          // misreport in the opposite direction.
          `The ${context.verb} ${context.verb === "rejection" ? "was recorded" : "succeeded and is in force"} — ${named.subject} — but Atlas could not ` +
          "build a response describing it, which is a defect on our side. Reload the page to see " +
          "the current state; retrying is safe and will simply report the change as already " +
          "applied.",
        requestId: context.requestId,
      },
    };
  }
}

/** The workspace-resolved principal every read and write on this surface uses. */
function approverContext(
  mode: AuthMode,
  user: AtlasUser | undefined,
  orgId: string,
  requestId: string,
) {
  return Effect.tryPromise({
    try: () =>
      resolveBrainReaderContext(getInternalDB(), { workspaceId: orgId, mode, user, requestId }),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });
}

/**
 * Refusal → HTTP status.
 *
 * `admin-brain-facts.ts`'s `refusalStatus` shape and its semantics: request
 * shape is 400, authority is 403, and a target-state mismatch is 409 — *"try
 * again after fixing the target"*, because the state can change out from under
 * the client.
 *
 * `previously-rejected` is the one that reads oddly as a 409 and is one anyway:
 * 0190's rejection memory is PERMANENT (#4507), so nothing the client does
 * clears it — but it is still a statement about the target rather than about the
 * request, and the message says the recovery is a database console. It shares
 * that shape with `warehouseTarget` next door, which is likewise not
 * client-fixable.
 */
function refusalStatus(
  refusal:
    | AliasAuthoringRefusal
    | AliasRemovalRefusal
    | AliasDecisionRefusal
    | CardinalityRefusal,
): 400 | 403 | 409 {
  switch (refusal) {
    case "not-entitled":
    case "workspace-mismatch":
    // ⚠️ 403, not 400, and both are UNREACHABLE from this router — every decide
    // request it builds carries a `human` approver. Mapped anyway because the
    // `never` default below is what forces a new seam arm to be considered, and
    // the consideration for these two is that they are AUTHORITY denials about
    // the actor's CLASS. A 400 would tell a caller their request was malformed
    // when the answer is that no actor of that class may ever do this.
    case "machine-may-not-reject":
    case "not-auto-approvable":
      return 403;
    case "degenerate-norm":
    case "self-edge":
    case "degenerate-key":
    case "unattributed":
    case "producer-proposed-multi":
      return 400;
    case "empty-population":
    case "previously-rejected":
    case "already-aliased":
    case "would-cycle":
    case "direction-conflict":
    case "direction-not-in-pair":
    // ⚠️ 409 with its two siblings, not 400, and the grouping is the argument.
    // All three are mismatches between the request and the STORED PAIR — a
    // client cannot tell from its own body that a direction was needed, only
    // from the row — which is the "try again after fixing the target" shape.
    // Splitting this one to 400 would put the three direction refusals in two
    // status classes while they are one kind of answer.
    case "direction-required":
    case "not-in-force":
    case "already-decided":
      return 409;
    default: {
      // A new refusal member must be MAPPED, not defaulted. A `?? 400` here
      // would give an authority denial the status of a typo the first time
      // somebody adds one — which is the wrong direction for a surface whose
      // refusals are the only thing standing between an admin and a
      // workspace-wide re-key.
      const unexpected: never = refusal;
      throw new Error(`Unhandled vocabulary refusal: ${JSON.stringify(unexpected)}`);
    }
  }
}

/**
 * The DIRECT-AUTHORING refusal statuses — both 400, and exhaustively so.
 *
 * Separate from {@link refusalStatus} rather than a call into it, because that
 * function's return type is the wide `400 | 403 | 409` for every input and the
 * cardinality route declares no 409 (its seam cannot produce one — see
 * `DeclarationResult`). Narrowing here is what lets the route's declared
 * responses and its reachable ones agree at COMPILE time rather than by
 * inspection; the `never` default is what keeps them agreeing when the seam
 * grows an arm.
 *
 * ⚠️ **Swapping this back to {@link refusalStatus} is undetectable at runtime by
 * construction** — both map the two reachable refusals to 400, so no test can
 * tell them apart. Stated so a reviewer does not go hunting for the falsifier
 * that cannot exist: the guarantee lives in the return TYPE and in the
 * committed `openapi.json` (which records no 409 on this route), and the
 * openapi-drift gate is what enforces it.
 */
function declarationRefusalStatus(
  refusal: Extract<CardinalityRefusal, "degenerate-key" | "unattributed">,
): 400 {
  switch (refusal) {
    case "degenerate-key":
    case "unattributed":
      return 400;
    default: {
      const unexpected: never = refusal;
      throw new Error(`Unhandled declaration refusal: ${JSON.stringify(unexpected)}`);
    }
  }
}

/**
 * A position's disclosure accounting, on the wire.
 *
 * ⚠️ ONE mapper, used by `/in-force` and `/pending` alike. The two panes render
 * the same badge from the same four numbers, and the field rename
 * (`decision` → `scope`, `consistent` → `countsConsistent`) is the kind of
 * two-line map that gets copied and then diverges by one field — at which point
 * one pane says "workspace-wide" for a read the other calls "scoped to you".
 */
function toWireCounts(counts: PendingPositionCounts): BrainVocabularyPositionCounts {
  return {
    position: counts.position,
    scope: counts.decision,
    total: counts.total,
    scoped: counts.scoped,
    withheld: counts.withheld,
    countsConsistent: counts.consistent,
  };
}

/**
 * Why a reader may not curate or decide a predicate's cardinality.
 *
 * Spelled once because `/cardinality` and `/decide` deny on the SAME bar for the
 * same reason, and two copies of a refusal message is how one of them stops
 * mentioning that the consequence is retroactive.
 */
function cardinalityDenialMessage(ctx: BrainPrincipalContext): string {
  return ctx.origin === "authenticated"
    ? `Curating a predicate needs the owner or admin entitlement; this reader is ` +
        `"${ctx.role ?? "no org role"}". A \`single\` entry makes every existing published ` +
        "pair in that slot supersedable at the next publish, retroactively."
    : `Curating a predicate needs a resolved reader identity; this one is "${ctx.origin}".`;
}

/** The refusal body — the seam's own prose, its code, and a requestId. */
function refusalBody(
  refusal:
    | AliasAuthoringRefusal
    | AliasRemovalRefusal
    | AliasDecisionRefusal
    | CardinalityRefusal,
  message: string,
  requestId: string,
) {
  return { error: refusal, message, requestId };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const commonResponses = {
  400: {
    description:
      "Invalid request — a norm that normalizes away to nothing, a pair that normalizes to one norm, or no active organization",
    content: { "application/json": { schema: ErrorSchema } },
  },
  401: {
    description: "Authentication required",
    content: { "application/json": { schema: AuthErrorSchema } },
  },
  403: {
    description:
      "Forbidden — direct authoring and removal need the owner or admin entitlement (ADR-0037 §6), re-resolved against the workspace being written rather than read off the session",
    content: { "application/json": { schema: AuthErrorSchema } },
  },
  404: {
    description: "Internal database not configured",
    content: { "application/json": { schema: ErrorSchema } },
  },
  500: {
    description: "Internal server error",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

const surfacesRoute = createRoute({
  method: "get",
  path: "/surfaces",
  tags: ["Admin — Claim Vocabulary"],
  summary: "Norms the corpus has actually produced at a slot position",
  description:
    "The authoring picker. Returns the lexical norms present in live `brain_facts` rows at one slot position, each with the most common surface that folds into it, its live claim count, and how many distinct spellings it merges. " +
    "⚠️ Authoring is a PICKER and never a norm text box, and this endpoint is why. `lexicalNorm` is ASCII-only case folding with a specific separator class, so a human cannot reliably predict what the pipeline produced from `499 a month` vs `499 A Month` vs `499-a-month` — and a wrong guess authors an edge whose `from_norm` no fact has ever produced. It inserts cleanly, the closure recomputes, the re-key moves zero rows and the preview reads 0: indistinguishable from a merge that worked. `q` FILTERS this list; it never supplies a value. " +
    "Scoped by the positional-visibility rule: predicate-position surfaces are workspace-scoped only (a verb phrase discloses nothing an approver could not guess), entity-position surfaces are gated by the reader's own fail-closed visibility predicate. `truncated` means the corpus has more norms than this page carries — filter rather than concluding a spelling is absent.",
  request: {
    // ⚠️ This schema is ENFORCED, not decorative. The handler used to declare it
    // and then hand-parse `c.req.raw.url` — two statements of one contract, of
    // which only the hand-rolled one ran, and the declared one (the weaker of
    // the two) was what the OpenAPI document advertised. `position` is an enum
    // here, so an unknown value is refused by the same `validationHook` that
    // guards every body on this surface rather than by a bespoke branch.
    query: z.object({
      position: z
        .enum(BRAIN_VOCABULARY_SLOT_POSITIONS)
        .openapi({ description: `One of: ${BRAIN_VOCABULARY_SLOT_POSITIONS.join(", ")}` }),
      q: z
        .string()
        .max(SURFACE_FILTER_MAX_CHARS)
        .optional()
        .openapi({ description: "Case-insensitive substring filter over the surface and the norm" }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(OBSERVED_SURFACE_PAGE_MAX)
        .optional()
        .openapi({ description: `Maximum norms (default and max ${OBSERVED_SURFACE_PAGE_MAX})` }),
    }),
  },
  responses: {
    200: {
      description: "Norms observed at this position, most-used first",
      content: { "application/json": { schema: BrainVocabularySurfaceListSchema } },
    },
    ...commonResponses,
  },
});

const inForceRoute = createRoute({
  method: "get",
  path: "/in-force",
  tags: ["Admin — Claim Vocabulary"],
  summary: "What is currently shaping identity",
  description:
    "Approved alias edges and curated predicate cardinalities currently in force, plus the coverage numbers the empty state needs. " +
    "Carries the SAME positional-visibility rule the pending queue uses, applied to populations: predicate-position edges unscoped, entity-position edges reader-scoped on BOTH sides — re-derived at read time by joining `brain_facts` on the two norms, because `brain_vocabulary_proposal` stores no fact ids and the vocabulary is permanently ACL-less (ADR-0037 §6, correcting T11 §5(b)). " +
    "`counts` carries a WITHHELD count per position, never a silent omission: the vocabulary is workspace-global, so its SIZE is not a secret even when its contents are, and an approver must be able to tell \"12 entity edges you cannot see\" from \"none\". `countsConsistent` reports a concurrent write that made the two statements disagree, rather than clamping the delta to a reassuring zero. " +
    "⚠️ An entity edge withheld because you cannot READ its populations is also un-removable by you. That hole is fail-closed and correct, and it is logged server-side rather than skipped silently — a workspace whose only admin cannot see a bad edge's populations has no in-product recovery path. An edge withheld only because its claims have all been retracted is NOT in that position: the removal gate counts retracted claims, so it stays recoverable. " +
    "`coverage` is what makes the empty state a coverage statement rather than a congratulation: there is no caught-up state for a vocabulary, only what has been decided and what has not yet been observed. `comparableFacts` is why Pending is empty specifically — the structural proposer fires only on claims with comparable objects.",
  responses: {
    200: {
      description: "Edges, cardinalities, per-position disclosure counts, and coverage",
      content: { "application/json": { schema: BrainVocabularyInForceResponseSchema } },
    },
    ...commonResponses,
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/preview",
  tags: ["Admin — Claim Vocabulary"],
  summary: "One decision's blast radius",
  description:
    "The counterfactual behind every approval and every removal on this surface (#5086): what becomes supersedable if you do this, and what becomes safe again. A removal is a re-key too, so it carries the same preview an approval does — on the `disarming` side. " +
    "The answer is a DISCRIMINATED union. `structurally-empty` means the counterfactual cannot produce pairs by construction and says which of five reasons — an object-position alias (the collision never reads `object_key`, so such an alias changes what corroborates, not what supersedes), a predicate already curated `single`, a predicate never curated at all, a surface that norms away to nothing, or a removal naming a norm with no approved parent. Those are NOT zeros: \"0 pairs\" and \"this decision cannot produce pairs\" are the same number and opposite facts. " +
    "`computed` carries both deltas, each with a workspace-wide `total`, a reader-scoped bounded sample gated on BOTH sides, a `withheld` count, and `countsConsistent`. `floor` is always true and must be rendered as one: a cardinality flip is not a batch — it applies to every future claim in the slot. `subtreeTruncated` means the alias subtree walk hit the depth bound, so both sides describe a smaller population than was asked about. " +
    "Takes a predicate SURFACE, never a predicate key.",
  request: {
    body: {
      content: { "application/json": { schema: BrainVocabularyPreviewRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The blast radius",
      content: { "application/json": { schema: BrainVocabularyPreviewResponseSchema } },
    },
    ...commonResponses,
  },
});

const authorRoute = createRoute({
  method: "post",
  path: "/author",
  tags: ["Admin — Claim Vocabulary"],
  summary: "Write an alias edge directly",
  description:
    "Direct human authoring (ADR-0037 §6) — the only route by which #5000's own entry is ever written, since the structural proposer provably cannot propose it. " +
    "Writes THROUGH the proposal table: a `human`-sourced proposal decided `approved` in the SAME transaction. Writing the edge directly would be one line shorter and would leave a later removal with no row to stamp `rejected` on, so the next producer run re-proposes the pair a human just deleted — #4507's failure returning through the one path authoring exists to serve. " +
    "Atomic: the proposal row, the edge, the closure rebuild and the workspace-wide drift re-key commit together or not at all. A failing re-key leaves no proposal row and no edge. " +
    "REFUSED when either norm has no live claim at that position, and the refusal names which side is empty — an alias for a norm the corpus has never produced is indistinguishable from a merge that worked. Also refused for a pair carrying permanent rejection memory: authoring over a removal would make every removal undoable by the next producer run. " +
    "Converges on an existing pending proposal rather than inserting a second row — migration 0190's unordered-pair constraint makes that not a choice — and refuses to silently flip a producer's directed proposal.",
  request: {
    body: {
      content: { "application/json": { schema: BrainVocabularyAuthorRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "The edge is approved and in force. `convergedOnProposal` says whether the decision landed on a proposal a producer had already queued",
      content: { "application/json": { schema: BrainVocabularyAuthorResponseSchema } },
    },
    ...commonResponses,
    409: {
      description:
        "The edge cannot be authored — a side with no live claim, a pair carrying permanent rejection memory, a norm that already has an approved parent, an edge that would close a cycle, or a direction that contradicts an existing directed proposal. The message says which and what to do instead",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const removeRoute = createRoute({
  method: "post",
  path: "/remove",
  tags: ["Admin — Claim Vocabulary"],
  summary: "Take an alias edge back out of force",
  description:
    "Removal is a RECOMPUTATION rather than a destructive write (ADR-0037 §6): the edge is dropped, the position's closure is rebuilt from what remains — so an edge this one was hiding lands back on its prior target — and every affected claim is re-keyed from its SURFACE, which is the only expression that gets the undo direction right. " +
    "It leaves permanent rejection memory, and that is what makes it stick: without it a producer re-writes what a human removed. An edge the region importer copied travels without its proposal row (#5035), so this route CREATES the memory in that case rather than removing an edge nothing can remember — `memoryCreated` says when it did. " +
    "Addressed by PAIR, in either order: the edge's own stored order decides which norm is the child. Needs the same owner/admin entitlement authoring does — a removal is the graver verb of the two.",
  request: {
    body: {
      content: { "application/json": { schema: BrainVocabularyRemoveRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The edge is gone, the closure is rebuilt, and the corpus is re-keyed",
      content: { "application/json": { schema: BrainVocabularyRemoveResponseSchema } },
    },
    ...commonResponses,
    409: {
      description: "No approved edge joins this pair at this position",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const pendingRoute = createRoute({
  method: "get",
  path: "/pending",
  tags: ["Admin — Claim Vocabulary"],
  summary: "Proposals awaiting a decision — both kinds, one queue",
  description:
    "The Pending queue (#5088). Alias proposals and predicate-cardinality proposals in ONE list, newest first, sharing the ordering, the filters and the decide verbs — neither kind gets a bespoke approval path that can drift from the other. " +
    "⚠️ The EVIDENCE is not shared, and deliberately has no common \"seen N times\" column. An alias entry carries the distinct subjects whose live claims exhibit the pair agreeing about one object; a cardinality entry carries the distinct subjects a human has superseded at that predicate AND how many supersessions produced them. The two gates are 2 and 3 and they are not comparable magnitudes — agreement-without-a-slot is positive and typed where a correction event is circumstantial — so one column at equal visual weight would invert the epistemic ranking the thresholds encode. Each count carries its `threshold`, because the evidence is RE-DERIVED at read time (migration 0190 stores none) and the corpus moves: an entry can honestly read below the bar that raised it. " +
    "⚠️ `direction` is `null` for an undirected proposal and that is the COMMON case, not an edge case — direction reads a positive warehouse allowlist and never the negation of a guard, so on a workspace with no warehouse producer every proposal is undirected. A client must NEVER prefill from it: approval of an undirected proposal is refused with `direction-required` rather than picking, because picking is the silent workspace-wide re-key the vocabulary exists to put a human in front of. " +
    "Scoped by the SAME positional-visibility rule the In-force pane uses — the same code path, not a copy: predicate-position proposals unscoped, entity-position proposals reader-scoped on BOTH norms. `aliasCounts` and `cardinalityCounts` carry a withheld count per position, never a silent omission. " +
    "⚠️ Rows proposed and decided in ONE transaction — direct human authoring writes through the proposal table — are excluded, so authoring never renders as outstanding work.",
  request: {
    query: z.object({
      kind: z
        .enum(BRAIN_VOCABULARY_PENDING_KINDS)
        .optional()
        .openapi({ description: "Show one kind only. Absent means both — the queue's whole point" }),
      position: z
        .enum(BRAIN_VOCABULARY_SLOT_POSITIONS)
        .optional()
        .openapi({ description: "Alias proposals at one position. Cardinality entries are always predicate-position" }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(PENDING_PAGE_MAX)
        .optional()
        .openapi({ description: `Maximum entries across both kinds (default and max ${PENDING_PAGE_MAX})` }),
    }),
  },
  responses: {
    200: {
      description: "Pending proposals with their evidence, plus the disclosure counts",
      content: { "application/json": { schema: BrainVocabularyPendingResponseSchema } },
    },
    ...commonResponses,
  },
});

const decideRoute = createRoute({
  method: "post",
  path: "/decide",
  tags: ["Admin — Claim Vocabulary"],
  summary: "Approve or reject one pending proposal",
  description:
    "The shared decide verb for both queue kinds (#5088). " +
    "⚠️ **An undirected alias proposal cannot be approved without a supplied `direction`**, and the refusal is `direction-required` rather than a silent pick: `A → B` and `B → A` re-key opposite row sets and have different blast radii, so a default would launder a deliberate abstention into a machine opinion. A DIRECTED proposal may be confirmed with a matching direction but never flipped — `direction-conflict` — because the reviewer read one direction and re-keying in the other is indistinguishable afterwards. Direction is never inferred from population size: a newly-adopted canonical spelling is RARER than the sloppy one it replaces, so \"bigger wins\" points backwards during exactly the migration this feature performs. " +
    "A rejection on an APPROVED alias row is a REMOVAL — it drops the edge, recomputes the closure and re-keys the corpus — and `removedEdge` says which transition ran. Both transitions leave permanent rejection memory; that is what stops a producer re-emitting what a human removed. " +
    "A cardinality entry is addressed by predicate SURFACE, never by a key, and the canonical key is derived server-side through the workspace's own vocabulary. " +
    "`nothing_to_decide` is a truthful 200, not a failure: the row is absent, already decided, or another reviewer won the race. It is never retried into a second apply.",
  request: {
    body: {
      content: { "application/json": { schema: BrainVocabularyDecideRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The decision landed, or there was nothing to decide",
      content: { "application/json": { schema: BrainVocabularyDecideResponseSchema } },
    },
    ...commonResponses,
    409: {
      description:
        "The decision cannot be applied — an undirected proposal with no supplied direction, a direction that is not an ordering of the proposal's pair, a direction contradicting a directed proposal, or a vocabulary refusal (already aliased, would cycle). The message says which and what to do instead",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const cardinalityRoute = createRoute({
  method: "post",
  path: "/cardinality",
  tags: ["Admin — Claim Vocabulary"],
  summary: "Curate or un-curate a canonical predicate",
  description:
    "Direct human authoring of a predicate's cardinality (ADR-0037 §3(d)3) — the human IS the approval, so this writes `approved` in one step. " +
    "⚠️ **The blast radius is retroactive.** Flipping a predicate to `single` makes every existing published pair in that slot supersedable at the NEXT publish, with no per-row record of the regime each fact was written under — so call `/preview` with `cardinality-flip` first and render its count as the FLOOR it is. " +
    "`multi` is the un-curation: the adjudicated record that values coexist, and the only way to take a predicate back out of `single` short of deletion. Absent from the table already MEANS `multi`, so a stored `multi` is a human declining the question. " +
    "Takes a predicate SURFACE. The canonical key is derived server-side through the workspace's own vocabulary, so the alias closure is applied — curating `is priced at` after `is priced at → priced at` is approved correctly curates `priced at`.",
  request: {
    body: {
      content: { "application/json": { schema: BrainVocabularyCardinalityRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The entry is approved and in force",
      content: { "application/json": { schema: BrainVocabularyCardinalityWriteResponseSchema } },
    },
    ...commonResponses,
    // No 409 here. `declarePredicateCardinality` is `ON CONFLICT DO UPDATE` — a
    // human authoring over their own workspace's earlier decision is the thing
    // the gate is FOR — so it returns only `degenerate-key`, `unattributed` or
    // success. `already-decided` and `producer-proposed-multi` belong to the
    // PRODUCER path and cannot arise here, and advertising them was the same
    // defect the `AliasAuthoringRefusal` narrowing removed one route over.
    500: {
      description:
        "Internal server error. `response_schema_mismatch` is the one case where the write LANDED and only its description failed — reload rather than treating it as a failed write",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminBrainVocabulary = createAdminRouter();

adminBrainVocabulary.use(requireOrgContext());

adminBrainVocabulary.openapi(surfacesRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const query = c.req.valid("query");

      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const page = yield* Effect.tryPromise({
        try: () =>
          loadObservedSurfaces(getInternalDB(), ctx, {
            position: query.position,
            filter: query.q,
            limit: query.limit,
            requestId,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(
        checked(BrainVocabularySurfaceListSchema, {
          position: page.position,
          surfaces: page.surfaces,
          truncated: page.truncated,
          scope: page.decision,
        }),
        200,
      );
    }),
    { label: "list brain vocabulary surfaces" },
  );
});

adminBrainVocabulary.openapi(inForceRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const payload = yield* Effect.tryPromise({
        try: async () => {
          // One request, two loaders — `/oversight`'s "one request, not one
          // snapshot" contract. The coverage counts are workspace-wide and
          // content-free; the in-force view is scoped. Merging them here keeps
          // each loader's own contract (and its own tests) intact.
          const db = getInternalDB();
          const [view, coverage] = await Promise.all([
            loadInForceVocabulary(db, ctx, { requestId }),
            loadVocabularyCoverage(db, orgId),
          ]);
          return {
            edges: view.edges.map((e) => ({
              position: e.position,
              fromNorm: e.fromNorm,
              toNorm: e.toNorm,
              approvedBy: e.approvedBy,
              approvedAt: e.approvedAt,
              hasRejectionMemory: e.proposalId !== null,
            })),
            counts: view.counts.map((n) => ({
              position: n.position,
              scope: n.decision,
              total: n.total,
              scoped: n.scoped,
              withheld: n.withheld,
              countsConsistent: n.consistent,
            })),
            cardinalities: view.cardinalities,
            cardinalityCounts: {
              position: view.cardinalityCounts.position,
              scope: view.cardinalityCounts.decision,
              total: view.cardinalityCounts.total,
              scoped: view.cardinalityCounts.scoped,
              withheld: view.cardinalityCounts.withheld,
              countsConsistent: view.cardinalityCounts.consistent,
            },
            coverage,
            truncated: view.truncated,
          };
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(checked(BrainVocabularyInForceResponseSchema, payload), 200);
    }),
    { label: "load brain vocabulary in force" },
  );
});

adminBrainVocabulary.openapi(pendingRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const query = c.req.valid("query");
      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const queue = yield* Effect.tryPromise({
        try: () =>
          loadPendingQueue(getInternalDB(), ctx, {
            requestId,
            kind: query.kind,
            position: query.position,
            limit: query.limit,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      // ⚠️ ANNOTATED, not handed straight to `checked()`. `checked` takes
      // `payload: unknown`, so without this the whole queue — two entry arms,
      // two evidence unions, four nested record types — crossed engine→wire with
      // nothing compile-checking it, and any rename would have been a 500 on the
      // entire pane discovered by whichever test happened to run the pg path.
      // `/author` and `/remove` already annotate for exactly this reason.
      const response: BrainVocabularyPendingResponse = {
        entries: queue.entries,
        aliasCounts: queue.aliasCounts.map(toWireCounts),
        // `null` travels as `null` — a kind the caller filtered out has no
        // counts, and synthesizing zeros here would put the fabricated fact back
        // one layer up from where the loader stopped producing it.
        cardinalityCounts:
          queue.cardinalityCounts === null ? null : toWireCounts(queue.cardinalityCounts),
        truncated: queue.truncated,
        incomplete: queue.incomplete,
      };
      return c.json(checked(BrainVocabularyPendingResponseSchema, response), 200);
    }),
    { label: "list pending brain vocabulary proposals" },
  );
});

adminBrainVocabulary.openapi(decideRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const body = c.req.valid("json");
      const ctx = yield* approverContext(mode, user, orgId, requestId);

      if (body.kind === "cardinality") {
        // ⚠️ §6's owner/admin gate is applied HERE, and only on this arm. The
        // asymmetry with the alias arm below LOOKS like an oversight and is the
        // opposite: `decideAliasProposal` owns the entitlement decision for a
        // proposal and applies the POSITION-dependent bar (`approverEntitled`),
        // which `vocabulary-decide.ts`'s header argues at length — a predicate
        // edge's evidence lives inside the brain's own ACL'd corpus and a verb
        // phrase discloses nothing. Re-applying the stricter authoring bar here
        // would be a second, contradicting spelling of a rule the seam owns.
        //
        // `decidePredicateCardinality` has no such check and says so: *"Entitlement
        // is the CALLER's to enforce."* So this arm carries it, at the same bar
        // `/cardinality` uses one route over, and for the same reason: a `single`
        // entry re-keys nothing but arms supersession for every future claim.
        const reviewer = recordedAuthor(ctx);
        if (reviewer === null) {
          log.warn(
            { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
            "Predicate cardinality decision refused — the reader does not clear the owner/admin bar",
          );
          return c.json(
            refusalBody("not-entitled", cardinalityDenialMessage(ctx), requestId),
            403,
          );
        }

        const decided = yield* Effect.tryPromise({
          try: async () => {
            const vocabulary = await loadWorkspaceVocabulary(orgId);
            return decidePredicateCardinalityForSurface(getInternalDB(), orgId, {
              predicateSurface: body.predicateSurface,
              verdict: body.decision,
              reviewedBy: reviewer,
              predicateAlias: vocabulary.predicate,
              requestId,
            });
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        });

        // `unaddressable` is a REQUEST problem, not a race — the surface norms
        // away to nothing, so it addresses no row and no retry will change that.
        // Folded into `nothing_to_decide` it produced the client sentence
        // *"someone else got there first"*, which is a confident, specific and
        // wrong explanation. 409 with the seam's own vocabulary instead.
        if (decided.kind === "unaddressable") {
          return c.json(
            refusalBody(
              "degenerate-key",
              `"${body.predicateSurface}" normalizes away to nothing, so it names no predicate ` +
                "and addresses no proposal. Pick the surface from the queue row rather than " +
                "typing it — case and separator folding means the spelling you expect is often " +
                "not the one Atlas recorded.",
              requestId,
            ),
            // `refusalStatus`, not a hardcoded 400. The two agree today, and
            // that function's `never` default exists precisely so the mapping
            // has ONE site — a second copy is how one of them stops agreeing.
            refusalStatus("degenerate-key"),
          );
        }

        // ⚠️ Two arms, and the split is `checkedWrite`'s own rule applied to
        // itself. Its failure message says *"The curation succeeded and is in
        // force"* — true on `decided`, and a LIE on `nothing_to_decide`, where
        // nothing was written. An earlier cut weighed the branch as "a second
        // spelling of the same honesty rule for the sake of one status code";
        // the cost is not the status code, it is telling an approver that a
        // retroactive supersession curation is in force when it is not, from
        // inside the helper written to stop exactly that. `/author` draws the
        // same line on its `already_approved` arm.
        // ⚠️ Branch POSITIVELY on the one member that means the write happened.
        // The earlier shape was two `if`s and an unguarded fall-through to
        // SUCCESS, so a fourth union member would be reported to the approver as
        // "Curated: … now holds one value at a time" for a write that may not
        // have happened — on the one verb that arms retroactive supersession.
        // Every other refusal path in this file has a `never` default.
        if (decided.kind !== "decided") {
          if (decided.kind !== "not-pending") {
            const unexpected: never = decided;
            throw new Error(
              `Unhandled cardinality decision result: ${JSON.stringify(unexpected)}`,
            );
          }
          const nothing: BrainVocabularyDecideResponse = {
            outcome: "nothing_to_decide",
            // ⚠️ No id: `brain_predicate_cardinality` is keyed on the predicate
            // key itself, and that key may not reach a body (ADR-0037 §6).
            proposalId: null,
          };
          return c.json(checked(BrainVocabularyDecideResponseSchema, nothing), 200);
        }

        // #5448's sibling row. Emitted only past the `decided` guard above, so
        // it never claims a decision that did not move a row — and BOTH
        // verdicts, because a rejection is a decision that permanently binds
        // producers and is exactly as worth attributing as an approval.
        vocabularyAudit(ADMIN_ACTIONS.brainVocabulary.decide, orgId, body.predicateSurface, {
          kind: "cardinality",
          predicateSurface: body.predicateSurface,
          decision: body.decision,
          // ⚠️ WHAT was decided, not only that something was. Approving a
          // pending `single` arms retroactive supersession exactly as
          // `POST /cardinality` does, and a row saying only `approved` sends
          // an operator asking *"what did this arm?"* back to the mutable
          // column — the split this whole issue closed on the other door.
          // The seam had to widen to carry it (`CardinalityDecisionResult`).
          cardinality: decided.cardinality,
        });

        const cardinalityResponse: BrainVocabularyDecideResponse =
          body.decision === "approved"
            ? { outcome: "approved", proposalId: null }
            : { outcome: "rejected", proposalId: null, removedEdge: false };
        // ⚠️ `checkedWrite`'s refusal arm is UNREACHABLE from here today, and
        // that is stated rather than left for a reviewer to hunt for the missing
        // test. `cardinalityResponse` is a literal two lines up with no dynamic
        // field, so it always parses; the arm exists because the write has
        // already COMMITTED at this point, and the day this response carries a
        // value read back from the row, a 200 with an unparsed body would report
        // a retroactive supersession curation whose shape nobody checked. The
        // verb below is on the same footing — defensive, not exercised.
        const described = checkedWrite(BrainVocabularyDecideResponseSchema, cardinalityResponse, {
          // The VERDICT, not the route. A rejection records that values coexist;
          // saying "the curation succeeded and is in force" over it reports the
          // opposite of what was written.
          verb: body.decision === "approved" ? "curation" : "rejection",
          predicateSurface: body.predicateSurface,
          requestId,
        });
        return described.ok ? c.json(described.body, 200) : c.json(described.body, 500);
      }

      const outcome = yield* Effect.tryPromise({
        try: () =>
          decideAliasProposal(
            body.decision === "approved"
              ? {
                  id: body.proposalId,
                  workspaceId: orgId,
                  decision: "approved",
                  approver: { kind: "human", ctx },
                  // ⚠️ Passed through UNDEFINED when the client sent none. No
                  // `??` fallback to the stored pair: `resolveDirection` refuses
                  // an undirected proposal without one, and supplying the stored
                  // order here would be exactly the "implicit first norm wins"
                  // that refusal exists to prevent — spelled in the route body,
                  // where no test of the seam would ever see it.
                  direction: body.direction,
                }
              : {
                  id: body.proposalId,
                  workspaceId: orgId,
                  decision: "rejected",
                  approver: { kind: "human", ctx },
                },
            { requestId },
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      switch (outcome.kind) {
        case "approved": {
          const approvedBody: BrainVocabularyDecideResponse = {
            outcome: "approved",
            proposalId: outcome.id,
          };
          vocabularyAudit(ADMIN_ACTIONS.brainVocabulary.decide, orgId, outcome.id, {
            kind: "alias",
            proposalId: outcome.id,
            decision: "approved",
            // The DIRECTION the approver supplied, or its absence. An
            // undirected proposal is decided by choosing an ordering of the
            // pair, and which way it was pointed is the whole content of the
            // decision — a row saying only "approved" would not record it.
            direction: body.decision === "approved" ? (body.direction ?? null) : null,
          });
          const described = checkedWrite(BrainVocabularyDecideResponseSchema, approvedBody, {
            verb: "authoring",
            proposalId: outcome.id,
            requestId,
          });
          return described.ok ? c.json(described.body, 200) : c.json(described.body, 500);
        }
        case "rejected": {
          const rejectedBody: BrainVocabularyDecideResponse = {
            outcome: "rejected",
            proposalId: outcome.id,
            // The one field that distinguishes a refusal from a removal. Both
            // leave permanent rejection memory; only the second dropped an edge
            // and re-keyed the corpus, and an approver told merely "rejected"
            // would not know that happened.
            removedEdge: outcome.removedEdge,
          };
          vocabularyAudit(ADMIN_ACTIONS.brainVocabulary.decide, orgId, outcome.id, {
            kind: "alias",
            proposalId: outcome.id,
            decision: "rejected",
            // A rejection that dropped an edge re-keyed the corpus back. That
            // is a removal wearing a rejection's name, and the trail has to
            // say which happened for the same reason the response does.
            removedEdge: outcome.removedEdge,
          });
          const described = checkedWrite(BrainVocabularyDecideResponseSchema, rejectedBody, {
            // A rejection that dropped an edge is a REMOVAL; one that did not is
            // a REJECTION. Neither is an authoring, and calling it one claimed a
            // re-key that never ran.
            verb: outcome.removedEdge ? "removal" : "rejection",
            proposalId: outcome.id,
            requestId,
          });
          return described.ok ? c.json(described.body, 200) : c.json(described.body, 500);
        }
        case "not_decidable": {
          // 200, not 409 — `/remove`'s `already_removed` reasoning. The queue is
          // shared and a double-click or a lost race is not a failure; the
          // `outcome` field is what distinguishes it from a decision that ran.
          // Nothing was written, so plain `checked()`.
          //
          // ⚠️ FOUR causes, and the seam does not distinguish them on purpose
          // (`AliasDecisionOutcome.not_decidable`): absent, another workspace's,
          // already `rejected`, or no transition from the current status — which
          // includes `applying`, i.e. a decision IN FLIGHT. The client's copy
          // says "already decided, or being decided right now" rather than
          // asserting somebody else finished, because this module's own header
          // calls rendering an in-flight decision as settled the thing that must
          // not happen.
          const nothingBody: BrainVocabularyDecideResponse = {
            outcome: "nothing_to_decide",
            proposalId: outcome.id,
          };
          return c.json(checked(BrainVocabularyDecideResponseSchema, nothingBody), 200);
        }
        case "refused":
          return c.json(
            refusalBody(outcome.refusal, outcome.message, requestId),
            refusalStatus(outcome.refusal),
          );
      }
    }),
    { label: "decide brain vocabulary proposal" },
  );
});

adminBrainVocabulary.openapi(previewRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const body = c.req.valid("json");
      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const radius = yield* Effect.tryPromise({
        try: () => loadBlastRadius(getInternalDB(), ctx, body, { requestId }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      // ANNOTATED, like `/pending` and `/author` — it catches a RENAMED or
      // dropped field, which is what an annotation can catch.
      //
      // ⚠️ It does NOT catch a field ADDED to the engine's radius: excess-property
      // checking applies to this literal's own keys, not to the value of `radius`,
      // so a fifth side spread out of `ObjectPositionRadius` would compile here
      // and 500 every object-position preview against `z.strictObject`. That
      // direction is held by `_ObjectRadiusSidesMatchTheWire` in
      // `vocabulary-object-radius.ts`, which fails the build in the module that
      // would grow the side rather than in this one.
      const response: BrainVocabularyPreviewResponse = { radius };
      return c.json(checked(BrainVocabularyPreviewResponseSchema, response), 200);
    }),
    { label: "preview brain vocabulary blast radius" },
  );
});

adminBrainVocabulary.openapi(authorRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      // `request`, not `body` — the `authored` arm below declares its own
      // response `body`, which shadows this one for the whole block, so the
      // audit row could not name what was asked for while both were `body`.
      const request = c.req.valid("json");
      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const outcome = yield* Effect.tryPromise({
        try: () => authorAliasEdge(orgId, request, ctx, { requestId }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      switch (outcome.kind) {
        case "authored": {
          // ANNOTATED, not a bare object literal. `checked`/`checkedWrite` take
          // `payload: unknown`, so without this the discriminated union bought
          // nothing at compile time — re-adding `convergedOnProposal` to the
          // `already_approved` arm below compiled cleanly and failed as a 500.
          // Excess-property checking plus discriminant narrowing do the job the
          // union was written for.
          const body: BrainVocabularyAuthorResponse = {
            outcome: "authored",
            proposalId: outcome.id,
            convergedOnProposal: outcome.convergedOnProposal,
          };
          // #5448's sibling row. Only the `authored` arm — `already_approved`
          // wrote nothing, and a row there would claim a decision that was made
          // by someone else at some other time.
          vocabularyAudit(
            ADMIN_ACTIONS.brainVocabulary.author,
            orgId,
            slotAddress(request),
            {
              position: request.position,
              fromNorm: request.fromNorm,
              toNorm: request.toNorm,
              proposalId: outcome.id,
              // Whether this landed on a proposal a producer had already raised.
              // The response tells the approver the trail will record the
              // producer's source rather than direct authoring; this is that
              // trail, so it has to carry the same distinction.
              convergedOnProposal: outcome.convergedOnProposal,
            },
          );
          const described = checkedWrite(
            BrainVocabularyAuthorResponseSchema,
            body,
            { verb: "authoring", proposalId: outcome.id, requestId },
          );
          return described.ok ? c.json(described.body, 200) : c.json(described.body, 500);
        }
        case "already_approved": {
          // Plain `checked()`, not `checkedWrite()`: nothing was written on this
          // arm, so a schema failure here is an ordinary 500 about a read.
          //
          // No `convergedOnProposal` — the union does not carry it on this arm,
          // and the annotation is what makes adding it back a compile error. It
          // used to be hard-coded `true`, which is FALSE whenever the
          // pre-existing approved row was itself hand-authored (the common
          // double-submit case), and that field decides what the approver is
          // told the audit trail will say.
          const body: BrainVocabularyAuthorResponse = {
            outcome: "already_approved",
            proposalId: outcome.id,
          };
          return c.json(checked(BrainVocabularyAuthorResponseSchema, body), 200);
        }
        case "not_decidable":
          return c.json(
            {
              error: "conflict",
              message:
                `A decision on that pair is already in flight (proposal ${outcome.id}). ` +
                "Reload the surface — retrying would be a second apply of a decision that is " +
                "already being made.",
              requestId,
            },
            409,
          );
        case "refused":
          return c.json(
            refusalBody(outcome.refusal, outcome.message, requestId),
            refusalStatus(outcome.refusal),
          );
      }
    }),
    { label: "author brain vocabulary alias edge" },
  );
});

adminBrainVocabulary.openapi(removeRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      // `request`, not `body` — the `removed` arm shadows it, exactly as the
      // authoring handler above does.
      const request = c.req.valid("json");
      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const outcome = yield* Effect.tryPromise({
        try: () => removeInForceAliasEdge(orgId, request, ctx, { requestId }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      switch (outcome.kind) {
        case "removed": {
          const body: BrainVocabularyRemoveResponse = {
            outcome: "removed",
            proposalId: outcome.id,
            memoryCreated: outcome.memoryCreated,
          };
          // #5448's sibling row, and the sharpest version of the erosion the
          // issue names: a removal DELETES the edge, so `approved_by` does not
          // survive even as a stale value. Only the `removed` arm —
          // `already_removed` wrote nothing.
          vocabularyAudit(
            ADMIN_ACTIONS.brainVocabulary.remove,
            orgId,
            slotAddress(request),
            {
              position: request.position,
              fromNorm: request.fromNorm,
              toNorm: request.toNorm,
              proposalId: outcome.id,
              // Whether Atlas had to MINT the rejection memory because the edge
              // arrived from another region without a decision record. That is a
              // second, permanent write this verb performed, and it is invisible
              // anywhere else once the edge is gone.
              memoryCreated: outcome.memoryCreated,
            },
          );
          const described = checkedWrite(
            BrainVocabularyRemoveResponseSchema,
            body,
            { verb: "removal", proposalId: outcome.id, requestId },
          );
          return described.ok ? c.json(described.body, 200) : c.json(described.body, 500);
        }
        case "already_removed":
          // 200, not 409. The pair is in the state the caller asked for, and a
          // double-click on a confirm button must not read as a failure — the
          // `outcome` field is what distinguishes it from a removal that ran.
          //
          // No `memoryCreated`: nothing was written, so the field has no value
          // to report rather than a false one. The union is what makes that
          // expressible.
          {
            const body: BrainVocabularyRemoveResponse = {
              outcome: "already_removed",
              proposalId: outcome.id,
            };
            return c.json(checked(BrainVocabularyRemoveResponseSchema, body), 200);
          }
        case "refused":
          return c.json(
            refusalBody(outcome.refusal, outcome.message, requestId),
            refusalStatus(outcome.refusal),
          );
      }
    }),
    { label: "remove brain vocabulary alias edge" },
  );
});

adminBrainVocabulary.openapi(cardinalityRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const body = c.req.valid("json");
      const ctx = yield* approverContext(mode, user, orgId, requestId);

      // §6's owner/admin gate, applied HERE because
      // `declarePredicateCardinality` says so in as many words: *"Entitlement is
      // the CALLER's to enforce — §6's owner/admin gate lives at the route,
      // beside every other entitlement decision, rather than being re-derived by
      // a store primitive that has no request context."* Same bar as authoring
      // an alias, and for the same reason: a `single` entry re-keys nothing but
      // arms supersession for every future claim in the slot.
      const author = recordedAuthor(ctx);
      if (author === null) {
        // LOGGED, like `authorAliasEdge` and `removeInForceAliasEdge` both do
        // for the identical denial. A `single` entry arms retroactive
        // supersession for every future claim in the slot, so an attempt to set
        // one without the entitlement is exactly the event `acl.ts` says you
        // want in the log — and the refusal message travels out in the response,
        // which is the caller's copy, not a server-side record.
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Predicate cardinality write refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          refusalBody("not-entitled", cardinalityDenialMessage(ctx), requestId),
          403,
        );
      }

      const result = yield* Effect.tryPromise({
        try: async () => {
          const db = getInternalDB();
          // The canonical key is derived INSIDE `cardinality.ts` rather than
          // here, and that is a guard rather than a preference:
          // `keys-not-on-the-wire.test.ts` refuses to see an identity key named
          // in any discovered read surface — a total prohibition in the ORM
          // spelling, deliberately over-broad — and a route body is precisely
          // where one must not appear. This file speaks surfaces; the module
          // keyed on `predicate_key` does the rest.
          //
          // The workspace's OWN vocabulary, not `identityVocabulary`: curating
          // `is priced at` once `is priced at → priced at` is approved must land
          // on `priced at`, the slot the claims actually occupy.
          const vocabulary = await loadWorkspaceVocabulary(orgId);
          return declarePredicateCardinalityForSurface(db, orgId, {
            predicateSurface: body.predicateSurface,
            cardinality: body.cardinality,
            authoredBy: author,
            predicateAlias: vocabulary.predicate,
          });
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      if (!result.ok) {
        return c.json(
          refusalBody(result.refusal, result.message, requestId),
          declarationRefusalStatus(result.refusal),
        );
      }

      // THE row #5448 measured missing. Emitted for BOTH directions — the
      // un-curation to `multi` is the flip that overwrites `reviewed_by`, so it
      // is the one whose absence erases a prior decision outright.
      //
      // Placed after the commit and before the response is described, so a
      // `response_schema_mismatch` 500 still leaves the write attributed: the
      // write LANDED on that path, and an audit trail that drops the rows whose
      // description failed is missing exactly the rows an operator is looking
      // for.
      //
      // Fire-and-forget for the reason the catalog entry records: awaiting would
      // report a committed write as a failure, which is the misreport
      // `checkedWrite` exists on this router to prevent.
      // The SURFACE as the target. There is no row id to name — the table is
      // keyed on `(workspace, predicate_key)` — and the key may not travel.
      vocabularyAudit(
        ADMIN_ACTIONS.brainVocabulary.cardinality,
        orgId,
        body.predicateSurface,
        {
          predicateSurface: body.predicateSurface,
          cardinality: result.cardinality,
          ...priorAuditFields(result.previous),
        },
      );

      // `checkedWrite`, not `checked`: `declarePredicateCardinalityForSurface`
      // has COMMITTED by the time this body is built, and the write it describes
      // arms retroactive supersession for every future claim in the slot. The
      // third committed write on this surface, and it was the one still reporting
      // a landed change as a plain failure.
      // ANNOTATED like the other two writes. Round 2's own rationale — the
      // discriminated unions buy nothing while the payload is `unknown` —
      // reached `/author` and `/remove` and skipped this one, so an extra key
      // here still compiled and failed at runtime as the 500 the annotation
      // exists to prevent.
      const cardinalityBody: BrainVocabularyCardinalityWriteResponse = {
        cardinality: result.cardinality,
      };
      const described = checkedWrite(
        BrainVocabularyCardinalityWriteResponseSchema,
        cardinalityBody,
        { verb: "curation", predicateSurface: body.predicateSurface, requestId },
      );
      return described.ok ? c.json(described.body, 200) : c.json(described.body, 500);
    }),
    { label: "declare brain predicate cardinality" },
  );
});


/**
 * The author id to record, or `null` when this reader may not author at all.
 *
 * Switched on the ORIGIN rather than written `ctx.userId ?? SENTINEL`, for
 * `recordedApprover`'s reason exactly: `??` applies the local-operator sentinel
 * to every origin whose `userId` happens to be null, so a future
 * `BrainPrincipalContext` arm would silently inherit "the declared local
 * operator" — an audit falsification one origin over, on the column migration
 * 0192 calls the first thing an audit of a retroactive re-key reads.
 */
function recordedAuthor(ctx: BrainPrincipalContext): string | null {
  switch (ctx.origin) {
    case "authenticated":
      return (ctx.role === "owner" || ctx.role === "admin") && ctx.userId ? ctx.userId : null;
    case "unauthenticated-local":
      return "local-operator";
    case "unresolved":
      return null;
  }
}

/** Compile-time pin: the router only ever speaks the three known positions. */
type _PositionsAreSlotPositions = [
  Exclude<(typeof BRAIN_VOCABULARY_SLOT_POSITIONS)[number], SlotPosition>,
] extends [never]
  ? true
  : never;
const _positionsAreSlotPositions: _PositionsAreSlotPositions = true;
void _positionsAreSlotPositions;

/**
 * ⚠️ Compile-time pin: every internal {@link PositionalDecision} has a wire
 * spelling. THE mapping this file performs with no other check.
 *
 * `scope: page.decision` and `scope: n.decision` below convert the seam's union
 * into `BrainVocabularyScope`, and the two were written independently in two
 * packages with nothing tying them together — the only enforcement was a
 * runtime `z.enum` inside `checked()`, which fails as a 500 on the whole pane
 * rather than as a type error.
 *
 * That is not hypothetical: `vocabulary-visibility.ts` already contemplates
 * splitting `audit-override` out of `reader-scoped` so an approver can tell "you
 * can see everything" from "an override was in force". Under the old shape that
 * change compiled and broke `/in-force` at runtime. Here it stops compiling.
 *
 * Directional on purpose. This pin catches a NEW internal arm with no wire
 * spelling; `BRAIN_VOCABULARY_SCOPES`' own `Exclude` pin (in `@useatlas/schemas`)
 * catches the reverse. Neither alone is enough, because `satisfies` cannot see a
 * schema enum that is narrower than its type.
 */
type _DecisionsHaveWireScopes = [Exclude<PositionalDecision, BrainVocabularyScope>] extends [never]
  ? true
  : never;
const _decisionsHaveWireScopes: _DecisionsHaveWireScopes = true;
void _decisionsHaveWireScopes;

/**
 * ⚠️ The SAME pin for the blast-radius reason, which is the seam the one above
 * was written for and then not applied to.
 *
 * `/preview` hands the engine's `BlastRadius` straight to `checked()`, so
 * `StructurallyEmptyReason` (engine) and `BrainVocabularyStructurallyEmptyReason`
 * (wire) were two independently hand-written five-member unions with nothing
 * between them. Rename `"no-such-edge"` in the engine and `/preview` 500s the
 * whole panel at runtime — the exact failure the scope pin's own docstring
 * argues about, one route over.
 *
 * It matters more here than there, because this is the branch whose entire
 * purpose is SAYING WHICH: a reason the client cannot name degrades to "a reason
 * this page does not recognise", and that arm has to stay rare enough to be
 * believed.
 */
type _EngineReasonsHaveWireSpellings = [
  Exclude<StructurallyEmptyReason, BrainVocabularyStructurallyEmptyReason>,
] extends [never]
  ? true
  : never;
const _engineReasonsHaveWireSpellings: _EngineReasonsHaveWireSpellings = true;
void _engineReasonsHaveWireSpellings;

export { adminBrainVocabulary };
