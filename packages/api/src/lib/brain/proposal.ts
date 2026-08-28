/**
 * `proposeFact` — the fourth writer onto `reconcileFacts`, and the verb
 * ADR-0036 §T7 has named since the ADR was written (#5482).
 *
 * ## What it is, and what it is NOT
 *
 * It asserts a **net-new** claim on a human's testimony. That is precisely the
 * thing `correct_fact` cannot do: all four correction verbs presuppose an
 * existing tier-2 fact, so until this module there was no way for a person to
 * tell Atlas something it did not already believe. A wrong EXISTING fact is
 * `correct_fact`'s job and always was; this verb is for the claim that is
 * simply absent.
 *
 * It is a new **entry point**, not new machinery. ADR-0036 §T6 makes reconcile a
 * stage rather than a step of the extraction fiber, so entity resolution, grant
 * derivation, corroboration dedupe and the advisory contradiction set all come
 * for free by entering through the one seam every other producer enters through
 * (`extract.ts`, `warehouse-producer.ts`, `correction.ts` are the other three).
 * This module carries the episode write and the mapping from a reconcile report
 * to something a caller can act on. It writes no `brain_facts` SQL at all, which
 * is what makes the draft-only guarantee structural rather than asserted:
 * `INSERT_FACT_SQL` never names `status`, so 0180's `DEFAULT 'draft'` applies,
 * and `scripts/check-brain-fact-promotion.sh` refuses any second writer.
 *
 * ## The edge is `provenance`, not `derives-from`
 *
 * `correction.ts` draws a distinction that matters here. `retract`/`supersede`
 * write `derives-from`, because the correction episode REFUTES the claim;
 * `re-authority`/`pin` write `provenance`, because the human is VOUCHING for it.
 * A proposal is a vouch — the person is offering their testimony as evidence FOR
 * the claim — so it takes the `provenance` edge, which is also the one feeding
 * `actor-identity.ts`'s distinct-source corroboration count and
 * `staleness.ts`'s decay anchor.
 *
 * Nothing here chooses that: `reconcileFacts` writes `INSERT_PROVENANCE_EDGE_SQL`
 * for both the created and the corroborated arm, and this module reaches the
 * graph through no other statement. The edge type is therefore a consequence of
 * the seam, not a decision this file could get wrong — which is the reason the
 * seam was worth entering through.
 *
 * ## ⚠️ "Draft-only" is the headline and it is not the whole truth
 *
 * A NOVEL claim lands at `status = 'draft'` and waits for the review surface,
 * which already drains connector-extracted drafts — so a proposal sitting there
 * is a working loop, not a broken one, and this module ships no publish path.
 *
 * But `reconcile.ts` deliberately does not filter corroboration by review state.
 * A proposal that AGREES with an existing live fact writes a `provenance` edge
 * to it **immediately and unreviewed**, strengthening the distinct-source count
 * and resetting the staleness anchor. That is the stealthier half: nothing
 * appears on a review queue for a human to catch, and no draft exists to reject.
 *
 * This is why {@link proposeFact} is reachable ONLY from the confirm endpoint
 * and never from the agent loop (#5482's dependency on #5496). One entry point
 * behind one gate covers both halves; a gate on the draft-creating path alone
 * would have left the corroboration path wide open, which is the shape the
 * grill named.
 *
 * ## Authority: an ordinary member, deliberately
 *
 * NOT owner/admin, and that asymmetry with `correct_fact` is the design rather
 * than an oversight. A correction lands authoritative immediately, without the
 * review queue — hence the review gate's own bar. A proposal lands as a draft
 * that a reviewer must publish, so the DRAFT STATE is the safety, and gating the
 * verb to admins would kill the compounding loop it exists to feed: the loop
 * needs ordinary testimony, and the people who know a fact are usually not the
 * people who administer the workspace.
 *
 * The residual risk that argument does NOT cover is the corroboration path
 * above, since that one bypasses review — and it is covered instead by the
 * confirm gate, which is why that gate carries the weight here rather than the
 * exit gate.
 *
 * What is still required is that the actor RESOLVES: a request whose identity
 * could not be established is refused rather than attributed to nobody, which is
 * the same posture every other brain write takes.
 */

import { randomUUID } from "node:crypto";

import { BRAIN_PROPOSAL_PRODUCER } from "@useatlas/schemas";

import { createLogger } from "@atlas/api/lib/logger";
import { ORG_PRINCIPAL, type BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { HUMAN_SOURCE } from "@atlas/api/lib/brain/sources";
import {
  RECONCILE_BLOCK_REASONS,
  reconcileFacts,
  withBrainTransaction,
  type ReconcileExecutor,
  type ReconcileTransactionRunner,
  type UnkeyedSlot,
} from "@atlas/api/lib/brain/reconcile";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import type { ClaimVocabulary } from "@atlas/api/lib/brain/identity";

const log = createLogger("brain-proposal");

/** Which read surface a proposal refusal names in its diagnostics. */
const PROPOSAL_SURFACE = "proposal" as const;

/**
 * The proposal episode — the immutable human-authored record of the claim.
 *
 * A near-twin of `correction.ts`'s `CORRECTION_EPISODE_INSERT_SQL`, and
 * deliberately its own statement rather than a shared one with a parameterized
 * `source_id` prefix. The two differ in the one place a shared statement would
 * hide: a correction episode is evidence ABOUT an existing fact and inherits
 * that fact's grant, while a proposal episode is evidence FOR a new one and
 * mints its own (see {@link proposalGrantTokens}). Sharing the SQL would have
 * put those two grant derivations behind one call site, which is the shape
 * `ingest/grant.ts`'s header rules out for exactly this hazard.
 *
 * `source = 'human'` (the connector-class vocabulary already reserves it), a
 * fresh `proposal:`-prefixed `source_id` per proposal — two proposals of the
 * same claim are two episodes, and the corroboration dedupe at the seam is what
 * keeps the second from duplicating a belief.
 *
 * `extracted_at` is stamped AT INSERT, for `correction.ts`'s reason exactly:
 * this path IS the episode's processing, and the fact-side effect commits in the
 * same transaction — so leaving the row on the extraction queue would hand a
 * human's own words to the LLM extraction fiber to be re-derived as a second,
 * machine-produced claim.
 */
export const PROPOSAL_EPISODE_INSERT_SQL = `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, locator, occurred_at, visible_to, extracted_at)
       VALUES ($1, 'human', $2, $3, $4, NULL, $5::timestamptz,
               ARRAY(SELECT jsonb_array_elements_text($6::jsonb)), $5::timestamptz)
       RETURNING id::text AS id`;

/** Why a proposal was refused. Machine-readable, mirroring `CORRECTION_REFUSAL_REASONS`. */
export const PROPOSAL_REFUSAL_REASONS = {
  /**
   * The claim asserts nothing at some position — a blank slot, or a surface
   * that normalizes away to no identity at all (`-`, `___`).
   *
   * The ONE block reason reachable from a well-formed request, and unlike
   * `correction.ts`'s equivalent it can fire at any of the three positions
   * rather than only the object: every slot here is the human's own free text,
   * where a supersession inherits its subject and predicate from the target row.
   */
  malformedClaim: "MALFORMED_CLAIM",
} as const;

export type ProposalRefusalReason =
  (typeof PROPOSAL_REFUSAL_REASONS)[keyof typeof PROPOSAL_REFUSAL_REASONS];

/** The claim a caller proposes, with `validFrom` already parsed. */
export interface ProposalClaimInput {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /** When the claim began to hold. `null`/omitted defaults to the proposal's own timestamp. */
  readonly validFrom?: Date | null;
  /** The user's stated rationale, recorded verbatim in the proposal episode. */
  readonly reason?: string;
}

export interface ProposalRequest {
  readonly ctx: BrainPrincipalContext;
  readonly claim: ProposalClaimInput;
  readonly requestId?: string;
  /**
   * The workspace's curated identity vocabulary. REQUIRED and never degraded,
   * for `reconcile.ts`'s stated reason: this is the seam where a claim's keys
   * are materialized, so a silent default would key this row under a different
   * identity function than every other row in the workspace.
   */
  readonly vocabulary: ClaimVocabulary;
}

export interface ProposalDeps {
  readonly withTransaction?: ReconcileTransactionRunner;
  /** Test clock. */
  readonly now?: () => Date;
  /** Test id source for the episode's `source_id` suffix. */
  readonly newProposalId?: () => string;
}

/** What became of a proposal. */
export type ProposalOutcome =
  | {
      readonly kind: "proposed";
      readonly result: {
        readonly factId: string;
        /**
         * Always `"draft"`, and typed as the literal rather than a string so a
         * future edit that tried to report anything else is a compile error.
         * Nothing in this module can produce another value — the seam does not
         * name `status` — and the type says so out loud.
         */
        readonly status: "draft";
        readonly proposalEpisodeId: string;
        /** The subject and/or object could not be resolved to a stored entity. */
        readonly provisional: boolean;
        /** Advisory `in-tension-with` edges written alongside it. */
        readonly tensionEdges: number;
      };
    }
  | {
      readonly kind: "corroborated";
      readonly result: {
        readonly factId: string;
        readonly proposalEpisodeId: string;
        /** False when this episode had already been recorded as evidence. */
        readonly evidenceAdded: boolean;
      };
    }
  | {
      readonly kind: "refused";
      readonly reason: ProposalRefusalReason;
      readonly message: string;
    };

/**
 * The grant a proposal's episode carries: the workspace-wide principal.
 *
 * The same answer `warehouse-producer.ts` gives for ITS net-new claims, and for
 * the same reason — a claim that comes from no channel, no meeting and no
 * mailbox has no narrower audience to derive one from. The alternative worth
 * ruling out explicitly is `user:<id>`, scoping the proposal to its author:
 * that is not a tighter version of this, it is a DEAD DRAFT. The review surface
 * is ACL-gated, so a draft visible only to its proposer is invisible to every
 * reviewer, refused at every publish forever by #4769's `GRANT_UNUSABLE`
 * classifier, and unrepairable — the exact shape `ingest/grant.ts` warns about
 * one subsystem over.
 *
 * Built from `acl.ts`'s exported constant rather than the literal `"org"`, on
 * that module's rule: `['everyone']` passes the 0180 CHECK and grants nobody,
 * so grant tokens are never spelled by hand.
 *
 * ⚠️ A proposal is therefore workspace-visible from the moment it is confirmed,
 * as a draft. That is a real consequence and the right one — the claim is being
 * offered to the company, which is what proposing means — but it is why the
 * confirm card says so in as many words before the human clicks.
 *
 * ## ⚠️ ADR-0036 §T9 lock 3 says "never a silent `[org]`" — read the word SILENT
 *
 * Lock 3 is written about the entry point this issue does NOT build: **lazy
 * session-episode materialization**, where a chat session becomes the tier-3
 * episode and the candidate inherits THAT session's ACL context, defaulting to
 * "the actor plus what the source episode already carried". There the rule is
 * exactly right — a conversation has a real, narrower audience, and defaulting
 * past it would widen a private exchange into an org-wide claim with nobody
 * deciding to.
 *
 * This verb has no source episode to inherit from. It mints one, from a human's
 * direct testimony, the way `correction.ts` does. Applied literally here, "the
 * actor plus what the source episode carried" reduces to the actor alone — the
 * dead draft above — and the failure is not merely a narrower grant:
 * `promotion.ts`'s `widenGrantFromEvidence` UNIONS the evidence episodes' grants
 * at the review gate, which is the only place ADR-0036 §T5 permits widening. So a
 * narrowly-granted proposal that a reviewer publishes becomes a PUBLISHED company
 * fact nobody but its author and the reviewer can read. Narrowing here does not
 * defer the disclosure decision to the gate; it permanently truncates it.
 *
 * What lock 3 forbids is a SILENT `[org]` — a default nobody chose and the human
 * never saw. This one is neither. It is a named function with this rationale
 * attached, and the confirm card states it in as many words ("visible to your
 * workspace") before the human clicks, which is the whole point of the entry
 * gate the same section added. A disclosed grant a person consented to is the
 * thing lock 3 wants; an undisclosed default is what it rules out.
 *
 * When the session-episode path lands, it brings its own derivation and lock 3
 * governs it directly. This function is not it, and must not become its default.
 */
export function proposalGrantTokens(): readonly string[] {
  return [ORG_PRINCIPAL];
}

/**
 * Record a human-proposed claim as a draft — or, when the claim is already
 * believed, as fresh evidence for the existing fact.
 *
 * ⚠️ NOT reachable from the agent loop. The only production caller is
 * `POST /api/v1/brain-proposals/confirm`, after a human clicked Confirm and the
 * server verified a single-use, workspace-bound token. See the module header for
 * why the corroboration arm makes that non-negotiable.
 */
export async function proposeFact(
  request: ProposalRequest,
  deps: ProposalDeps = {},
): Promise<ProposalOutcome> {
  const { ctx, claim, requestId, vocabulary } = request;
  const now = deps.now ?? (() => new Date());
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const newProposalId = deps.newProposalId ?? randomUUID;

  // ── Identity ──────────────────────────────────────────────────────────
  //
  // No authority tier is checked, deliberately (see the module header). What IS
  // required is that the actor resolved: an `unresolved` origin is an
  // authenticated request whose identity could NOT be established, and
  // attributing a claim to nobody is the one thing the seam already refuses
  // (`SOURCE_PRINCIPAL_UNRESOLVED`). Refusing here rather than there produces
  // the same rollback with a diagnosis that names the cause.
  if (ctx.origin === "unresolved") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, PROPOSAL_SURFACE);
  }

  // Grammar-valid principal for the proposed fact's provenance `actor`. The
  // `unauthenticated-local` arm records the CLASS rather than an id — that
  // deployment declared it has no ids to record. Same derivation as
  // `correction.ts`, which is what keeps one human's proposals and corrections
  // attributable to one principal.
  const actor = ctx.userId ?? "local-operator";
  const sourcePrincipal = ctx.userId !== null ? `user:${ctx.userId}` : "human:local-operator";
  const grantTokens = proposalGrantTokens();

  const at = now();
  const validFrom = claim.validFrom ?? at;
  const reason = claim.reason?.trim();

  const report = await withTransaction(async (tx: ReconcileExecutor) => {
    const proposalSourceId = `proposal:${newProposalId()}`;
    const body = JSON.stringify({
      kind: "proposal",
      claim: { subject: claim.subject, predicate: claim.predicate, object: claim.object },
      ...(reason ? { reason } : {}),
      actor,
      at: at.toISOString(),
    });
    const episodeInsert = await tx.query(PROPOSAL_EPISODE_INSERT_SQL, [
      ctx.workspaceId,
      proposalSourceId,
      actor,
      body,
      at.toISOString(),
      JSON.stringify(grantTokens),
    ]);
    const episodeId = firstId(episodeInsert.rows);
    if (episodeId === null) {
      throw new Error(
        `brain proposal: episode insert returned no id (workspace ${ctx.workspaceId})`,
      );
    }

    const reconcileReport = await reconcileFacts(
      {
        episode: {
          id: episodeId,
          workspaceId: ctx.workspaceId,
          source: HUMAN_SOURCE,
          sourceId: proposalSourceId,
          sourceActor: actor,
          occurredAt: at,
          visibleTo: grantTokens,
        },
        candidates: [
          {
            subject: claim.subject,
            predicate: claim.predicate,
            object: claim.object,
            validFrom,
            // NO `predicateCardinality`, and no `anchorReach` — the two are one
            // decision and omitting both is the whole of it.
            //
            // `correction.ts`'s `supersede` hard-codes `single` because a human
            // REPLACING a slot's value has asserted by their action that the
            // slot holds one value. A proposal makes no such assertion: someone
            // saying "Ana is on the billing team" has said nothing about
            // whether anyone else is, and reading `single` off it would be the
            // laundered-guess defect #5027 removed, re-made from a weaker
            // premise. Omitting it takes reconcile's conservative default
            // (`multi` — values coexist), so a proposal mints no advisory
            // `in-tension-with` edge at its own slot.
            //
            // `anchorReach` then has nothing to carry: it bounds how far a
            // cardinality hint reaches, and there is no hint. Its default
            // (`producer-hint`) is byte-identical here for that reason, and it
            // is left off rather than spelled `curated-only` so the absence
            // reads as "this producer has no hint" instead of "this producer
            // has a hint it is being careful with".
            //
            // The workspace's own curated `single` entries still fire through
            // `TENSION_SWEEP_SQL`, which is the authority #5027 says may make a
            // predicate-wide single-valuedness claim. A proposer is not it.
          },
        ],
        vocabulary,
        // The shared wire constant, not a local literal: the review surface's
        // origin badge branches on this exact value (#5483), and the two
        // packages sharing one spelling is what keeps the label from drifting
        // off the writer.
        producer: BRAIN_PROPOSAL_PRODUCER,
        // An authored claim is not extracted from anything.
        extractedAt: null,
        sourcePrincipal,
        // `resolveEntity` is deliberately OMITTED, which takes
        // `passthroughEntityResolver`.
        //
        // Not an oversight and not laziness — it is forced. The store-backed
        // resolver (`entityStoreResolver()`) checks out its OWN connection, and
        // `reconcileFacts` calls it before opening its transaction precisely so
        // that is safe. Here the transaction is ALREADY open — this call passes
        // `withTransaction: fn => fn(tx)` below to keep the episode and the fact
        // atomic — so a store lookup would be a nested checkout under a held
        // connection, which is the bounded-pool starvation deadlock
        // `withBrainTransaction` documents. `correction.ts` omits it for the
        // same reason.
        //
        // The abstain is honest rather than degraded: with no comparables, an
        // entity-valued object stays `unknown` and reaches a REVIEWER as tension
        // instead of superseding something — which is exactly the right posture
        // for a claim whose whole point is that a human will look at it.
      },
      // Reuse THIS transaction — the default runner would nest a second pool
      // checkout under the held connection.
      { withTransaction: (fn) => fn(tx), now: () => at },
    );
    return { report: reconcileReport, episodeId };
  });

  const { report: reconcileReport, episodeId } = report;
  const outcome = reconcileReport.outcomes[0];

  if (outcome === undefined) {
    throw new Error(
      `brain proposal: reconcile returned no outcome for a single candidate (workspace ${ctx.workspaceId}, episode ${episodeId})`,
    );
  }

  if (outcome.kind === "blocked") {
    if (outcome.reason === RECONCILE_BLOCK_REASONS.malformedClaim) {
      // ⚠️ THE ONE BLOCK REASON REACHABLE FROM A WELL-FORMED REQUEST — and,
      // unlike `correction.ts`'s narrower arm, reachable from any position and
      // from any cause.
      //
      // That module discriminates on the CAUSE, admitting only
      // `degenerate-surface` as the supplier's fault: its subject and predicate
      // are copied off the target row, so a `vocabulary-target` cause there is
      // the workspace's configuration failing a human whose input was fine.
      //
      // Here all three slots ARE the supplier's input, and the discriminator
      // does not transfer. A `vocabulary-target` cause means this workspace's
      // vocabulary maps the human's word to something that normalizes away —
      // still not their fault, but the actionable answer is the same one and
      // they are the only person present to act on it: rephrase, because that
      // wording cannot be keyed here. A 500 saying the seam's contract changed
      // would be aimed at us about a request that is simply unusable, which is
      // the wrong diagnosis in both directions.
      //
      // So the refusal is raised for the reason rather than the cause, and the
      // POSITIONS travel with the log line so an operator can tell a bad alias
      // entry from a human typing `-`.
      log.warn(
        {
          workspaceId: ctx.workspaceId,
          episodeId,
          unkeyed: outcome.unkeyed,
          requestId,
        },
        "brain proposal refused: the claim asserts nothing at some position",
      );
      return {
        kind: "refused",
        reason: PROPOSAL_REFUSAL_REASONS.malformedClaim,
        message: malformedClaimMessage(claim, outcome.unkeyed),
      };
    }
    // Every other block reason is about the EPISODE — provenance, grant, source
    // principal — and this function just wrote that episode itself, with a
    // workspace-wide grant and a resolved principal. Reaching one means the
    // seam's contract moved underneath this caller, which is an incident report
    // rather than a refusal. The transaction has already rolled back nothing
    // (reconcile blocks before writing), so no fact exists either way.
    throw new Error(
      `brain proposal: reconcile blocked a proposal for ${outcome.reason}, which this entry point constructs away (workspace ${ctx.workspaceId}, episode ${episodeId})`,
    );
  }

  if (outcome.kind === "corroborated") {
    log.info(
      {
        workspaceId: ctx.workspaceId,
        episodeId,
        factId: outcome.factId,
        evidenceAdded: outcome.evidenceAdded,
        requestId,
      },
      "brain proposal corroborated an existing fact",
    );
    return {
      kind: "corroborated",
      result: {
        factId: outcome.factId,
        proposalEpisodeId: episodeId,
        evidenceAdded: outcome.evidenceAdded,
      },
    };
  }

  log.info(
    {
      workspaceId: ctx.workspaceId,
      episodeId,
      factId: outcome.factId,
      provisional: outcome.provisional,
      tensionEdges: outcome.tensionEdges,
      requestId,
    },
    "brain proposal created a draft fact",
  );
  return {
    kind: "proposed",
    result: {
      factId: outcome.factId,
      // Not read off the row: nothing in this path can write `status`, so the
      // literal IS the guarantee. See the module header.
      status: "draft",
      proposalEpisodeId: episodeId,
      provisional: outcome.provisional,
      tensionEdges: outcome.tensionEdges,
    },
  };
}

/**
 * The actionable half of a `MALFORMED_CLAIM` refusal: which of the human's own
 * words asserted nothing.
 *
 * Names the POSITIONS and not the cause. The cause separates a degenerate
 * surface from a vocabulary target, which is an operator's distinction — the
 * person reading this can only rephrase either way, and telling them their
 * workspace has a bad alias entry is an answer they cannot act on.
 *
 * ⚠️ The blank positions are recomputed here rather than read off `unkeyed`, and
 * that is not redundancy. `MALFORMED_CLAIM` has TWO halves at the seam and they
 * report differently: the no-identity half fills `unkeyed` with a role and a
 * cause per slot, while the BLANK half (`trim() === ""`) blocks before any key
 * is computed and carries no detail at all. Trusting `unkeyed` alone therefore
 * degrades the commonest case — a human leaving a field empty — to "The claim
 * asserts nothing", which names nothing to fix. The recomputation is a
 * three-slot `trim()` over this function's own inputs, not a second copy of the
 * seam's guard: it decides only what to SAY, never whether to refuse.
 */
function malformedClaimMessage(
  claim: ProposalClaimInput,
  unkeyed: readonly UnkeyedSlot[] | undefined,
): string {
  const blank = (
    [
      ["subject", claim.subject],
      ["predicate", claim.predicate],
      ["object", claim.object],
    ] as const
  )
    .filter(([, surface]) => surface.trim() === "")
    .map(([role]) => role);
  const roles = [...new Set([...blank, ...(unkeyed ?? []).map((slot) => slot.role)])];
  const where = roles.length === 0 ? "The claim" : `The claim's ${listOf(roles)}`;
  return (
    `${where} asserts nothing that can be recorded — a blank value, or one that reduces to nothing once ` +
    "punctuation and casing are stripped. Nothing was recorded. Restate the claim with a concrete " +
    "subject, predicate and value (for example: “Ana” · “is the DRI for” · “billing”)."
  );
}

/** `a`, `a and b`, `a, b and c` — the refusal reads as prose, not as a set. */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** First `id` off a `RETURNING id` result, or `null`. */
function firstId(rows: readonly unknown[]): string | null {
  const row = rows[0];
  if (row === undefined || row === null || typeof row !== "object") return null;
  const id = (row as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
}
