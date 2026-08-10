/**
 * `correct_fact` — the four correction verbs and the correction-episode
 * materialization behind them (#4915, ADR-0036 §Temporal, conflict &
 * provenance).
 *
 * T4's SECOND human-authoritative entry point, beside the review gate:
 * a correction is a first-class human-authored EPISODE — immutable,
 * actor-attributed, highest-trust — whose effect lands authoritative
 * immediately rather than queueing as a draft. The reviewer gate exists to put
 * a human between machine extraction and trust; a correction already HAS its
 * human, so making it wait for a second one would review the reviewer.
 *
 * ## The four verbs, and what each may touch
 *
 *   - **retract** — the ONLY tombstone path, and the verb a GDPR erasure
 *     ROUTES THROUGH (the ADR's epithet; actual content deletion of the row
 *     and its episodes is a separate operation this verb does not perform).
 *     The row stays stored, and every FACT-SERVING read hides it, `asOf`
 *     included — #4916 keeps `invalidated_at IS NULL` in BOTH temporal
 *     branches, because hiding history is what this verb is for. The one
 *     exception is the tension cluster: `tensions.ts`'s counterpart SELECT
 *     deliberately does not filter `invalidated_at`, so a retracted claim is
 *     still listed — labelled by `invalidatedAt`, with its payload — as a
 *     withdrawn rival of any live claim it contested. That carve-out is why
 *     erasure of CONTENT has to be a separate operation and cannot be read
 *     off this verb. Stamps
 *     `invalidated_at` (never `status` — ADR-0036: withdrawal is a tombstone,
 *     not a demotion) and FLAGS every `derives-from` dependent for re-review.
 *     Flagging is a provenance marker (`reReview`), never a cascade: a
 *     dependent's own `invalidated_at`, `valid_to`, and `status` are untouched,
 *     because a conclusion may survive losing one of its premises and only a
 *     human can say so. The admin review route's `POST /:id/retract` runs THIS
 *     code path — one retract semantics, not two (#4772's negative verb
 *     unified here).
 *   - **supersede** — stamps the target's `valid_to` and records the
 *     `supersedes` edge by executing the SAME statements the publish gate runs
 *     (`SUPERSEDE_STAMP_EXPLICIT_SQL` / `INSERT_SUPERSEDES_EDGES_SQL`, #4912) —
 *     imported, not restated, so the two human arbitration paths cannot drift.
 *     The replacement claim enters through `reconcileFacts` as the second
 *     IMPLEMENTED producer (`correction`) on the seam ADR-0036 designs for
 *     three (connector · warehouse-derived · correction) — and is then
 *     promoted to `published` in the same transaction (see the allowlist note
 *     below). The stamp runs BEFORE the reconcile, deliberately: the belief
 *     being retired must already have a closed window when the replacement's
 *     tension pass runs, or reconcile would mint an `in-tension-with` edge
 *     against the very fact this verb is resolving — permanent conflict noise
 *     recording a question the human answered in the same transaction.
 *   - **re-authority** — re-anchors the claim's authority on the correcting
 *     human: the correction episode becomes EVIDENCE (a `provenance` edge, the
 *     same idempotent statement reconcile uses), and a `reAuthority` marker
 *     records who vouched and when. Because `LAST_OBSERVED_AT_SELECT` reads
 *     provenance-edge episodes, the human observation also resets the #4914
 *     decay clock — "a person checked" is the freshest observation there is.
 *   - **pin** — the same evidence edge plus a `pinned` marker. Advisory at
 *     rest, exactly like the decay signal it counteracts: nothing may auto-act
 *     on it, and (see the marker note below) nothing reads it yet either.
 *
 * Both vouching verbs REFUSE a target whose `valid_to` has already passed
 * (#4939): the reset they promise is delivered through the decay anchor, and
 * no as-of-now read consults the anchor of a fact it does not serve, so the
 * verb would report an effect nobody can observe. A future-dated `valid_to`
 * is a live claim with a scheduled end and is admitted — the same clock
 * reading `brainFactCurrentClause` does.
 *
 * ## Tier-1 has no correction path
 *
 * A warehouse-derived fact (`provenance.source = WAREHOUSE_SOURCE`) is refused
 * with an actionable error for EVERY verb: tier-1 is authoritative by
 * construction, so you fix the data or the semantic layer, not the brain. The
 * refusal is evaluated on the stored provenance because tier-1 proper is never
 * stored at all — an id that names no brain row is an ordinary not-found.
 *
 * The class comes from `lib/brain/sources.ts`, and that indirection is load
 * bearing rather than tidiness: ADR-0036 commits to warehouse-derived facts as
 * tier-1, but no milestone in the M1–M6 cut has scoped the producer yet — so
 * while both sides spelled their own literal, this refusal was one future
 * naming decision away from silently never firing (#4938).
 *
 * ## Why this file is on `check-brain-fact-promotion.sh`'s ALLOWLIST
 *
 * `PROMOTE_CORRECTION_FACT_SQL` writes `status = 'published'` — the exact
 * shape the guard exists to refuse. This is the "second gate-time writer" the
 * guard's own remediation text forecast for `correct_fact` (#4912): the write
 * is a human trust decision (the correction's author IS the reviewer),
 * actor-attributed, episode-recorded, and still screened through
 * `classifyFactForPromotion` so no-provenance-no-promotion and
 * no-grant-no-promotion hold on this path too. The `valid_to` stamp is not a
 * second spelling at all — it executes the publish adapter's own statement.
 *
 * ## Grant seed — the narrowest defensible set (the T9 pattern)
 *
 * The correction episode's grant is the TARGET FACT's own grant, verbatim:
 * everyone entitled to the claim is entitled to know it was corrected, and
 * nobody else learns a claim existed. The actor is inside that set by
 * construction — the ACL-gated target read is what found the fact. A freshly
 * created supersede replacement then inherits this grant through reconcile's
 * ordinary derive-at-ingest path, so it is served to exactly the audience the
 * superseded belief was; a CORROBORATED pre-existing rival keeps its own
 * grant, which reconcile never rewrites (the correction episode still lands
 * as evidence, so the next publish may widen it — #4823's ordinary path).
 *
 * ## Atomicity
 *
 * Every verb runs in ONE transaction (`withBrainTransaction`), opened after
 * all pure validation: the episode, its edges, the tombstone/stamp/marker, and
 * the flagged dependents commit together or not at all. A refusal discovered
 * mid-transaction throws {@link CorrectionRefusedError}, which rolls the
 * episode back — a correction that half-happened must not leave an authored
 * episode asserting it did.
 *
 * ## THIS layer owns the admin-actions audit row — not the entry points
 *
 * A correction has two entry points onto this one write: the admin HTTP routes
 * (`api/routes/admin-brain-facts.ts`) and the `correct_fact` agent tool
 * (`lib/tools/correct-fact.ts`). #4915 built both and wired the
 * `admin_action_log` vocabulary to only the first, so the same verb through
 * chat produced the in-brain episode and no forensic row (#4934). The row is
 * emitted HERE, once, for the `corrected` outcome only.
 *
 * The principle is one write, one audit row, emitted where the write is — so a
 * THIRD entry point inherits the audit trail instead of having to remember it,
 * and two entry points cannot drift into two metadata shapes (they already had:
 * `/retract` logged `flaggedForReReview` unconditionally, `/correct` only when
 * non-empty). `lib/` writing this table is thoroughly established —
 * `auth/middleware.ts`, `auth/invitations.ts`, `rate-limit/middleware.ts`,
 * `lib/brain/extract.ts` and two schedulers all do it — though the schedulers'
 * case is unattended loops labelling themselves with `systemActor`, which is a
 * different argument from this one.
 * `resolveEntry` reads actor, org and requestId off the AsyncLocalStorage
 * request context, which both entry points run inside, so attribution needs no
 * plumbing from either — and {@link emitCorrectionAudit} warns loudly if a
 * future caller arrives without one.
 *
 * REFUSALS AND NOT-FOUNDS STAY UNAUDITED — a scope call, not a semantic one
 * (#4934 non-goal). The table is NOT success-only: `AdminActionEntry.status`
 * takes `"failure"` and dozens of call sites pass it, including a refusal on
 * the closest precedent to this change (`sso.enforcement_block` in
 * `auth/middleware.ts`). So auditing refused corrections is legitimate and can
 * be added later; it just needs its own decision about volume, and about
 * whether a not-found — which is deliberately indistinguishable from "not
 * visible to you" — is an event at all.
 *
 * The write is AWAITED with a deadline rather than fire-and-forget — see
 * {@link emitCorrectionAudit} for why that is not a contradiction of "a failed
 * audit never affects a committed correction".
 */

import { randomUUID } from "node:crypto";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { diagnosticValue } from "@atlas/api/lib/audit/diagnostic-scrub";
import { ADMIN_ACTIONS, logAdminActionAwait, type AdminActionEntry } from "@atlas/api/lib/audit";
import {
  aclVisibilityClause,
  isUnknownArray,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import {
  inheritSlotFromFactRow,
  slotKey,
  type ClaimVocabulary,
  type InheritedSlot,
} from "@atlas/api/lib/brain/identity";
// ADR-0037 §3(d)2 — a human superseding a slot is positive evidence that it
// holds one value. The only cardinality proposer that can be observed from
// inside the brain (#5027).
import { proposeFromCorrectionEvents } from "@atlas/api/lib/brain/cardinality";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import {
  INSERT_PROVENANCE_EDGE_SQL,
  RECONCILE_BLOCK_REASONS,
  reconcileFacts,
  withBrainTransaction,
  type ReconcileExecutor,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";
import {
  brainFactCurrentClause,
  INSERT_SUPERSEDES_EDGES_SQL,
  SUPERSEDE_STAMP_EXPLICIT_SQL,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { classifyFactForPromotion, isJsonObject, type DraftFactRow } from "@atlas/api/lib/brain/promotion";
import {
  EPISODE_SOURCES,
  HUMAN_SOURCE,
  isEpisodeSource,
  isWarehouseDerivedSource,
} from "@atlas/api/lib/brain/sources";
import { BRAIN_CORRECTION_VERBS } from "@useatlas/schemas";
import type { BrainCorrectionVerb, BrainFactCorrectionResponse } from "@useatlas/types";

const log = createLogger("brain-correction");

/** Surface tag carried on this module's `BrainReaderUnresolvedError` throws. */
const CORRECTION_SURFACE = "correction";

/**
 * The verb vocabulary — re-exported from `@useatlas/schemas`, which holds the
 * one runtime tuple (with its exhaustiveness pin against the wire union), the
 * same way every other brain tuple is consumed API-side. A second spelling
 * here would be a membership-drift risk two compile pins would have to hold
 * shut.
 */
export const CORRECTION_VERBS = BRAIN_CORRECTION_VERBS;

export type CorrectionVerb = BrainCorrectionVerb;

/**
 * Why a correction was refused. Every refusal carries actionable prose beside
 * the code; the code is what a tool or route branches on, the prose is what a
 * human acts on.
 */
export const CORRECTION_REFUSAL_REASONS = {
  /** The actor's role does not carry the correction verb. */
  notAuthorized: "NOT_AUTHORIZED",
  /** Tier-1: warehouse-derived facts have no correction path. */
  warehouseTarget: "WAREHOUSE_TARGET",
  /**
   * The target's provenance names a source kind THIS region's vocabulary does
   * not contain, so whether it is warehouse-derived cannot be decided (#4964).
   *
   * Distinct from {@link warehouseTarget} on purpose, and the distinction is
   * the whole point: this is not an assertion that the fact IS tier-1, it is an
   * admission that the question is unanswerable here. Folding it into
   * `WAREHOUSE_TARGET` would show an operator "this fact is warehouse-derived"
   * for what is probably a newer chat vendor's message, and send them looking
   * for a warehouse table that does not exist.
   *
   * Reached whenever a stored `provenance.source` is outside THIS deployment's
   * vocabulary. The region-import lane is how that normally happens — it
   * restores a bundle's `source` verbatim (`api/routes/admin-migrate.ts`) — but
   * it is not the only way: a region rolled back below the release that added a
   * member reaches this arm with no import in its history. The predicate below
   * (the `unrecognizedSourceKind()` function) carries the argument for refusing
   * here rather than at the import.
   *
   * The HEALING half: the kind is a string, so a release that adds it to
   * `EPISODE_SOURCE_SPECS` lifts the quarantine. See {@link malformedSourceKind}
   * for the half that never heals.
   */
  unrecognizedSourceKind: "UNRECOGNIZED_SOURCE_KIND",
  /**
   * The target's `provenance.source` is present but is not a string at all —
   * `null`, a number, an object — so NO vocabulary can ever admit it
   * (`isEpisodeSource` requires a string).
   *
   * Split from {@link unrecognizedSourceKind} because the remediation is the
   * opposite. That one tells an operator to wait for a release; saying it here
   * would be a false promise, and it would be made about a fact that also
   * cannot be RETRACTED — the GDPR-erasure verb — so the operator waits out an
   * erasure deadline for a deploy that was never going to help. Reporting a
   * cause that cannot be acted on is the same defect as reporting this refusal
   * as tier-1, which is the distinction the reason above exists to draw.
   *
   * A data defect, so the fix is a provenance repair. Only the region import
   * can produce it: `reconcile.ts` always writes a string, and the import's
   * fact validator never inspects `.source`.
   */
  malformedSourceKind: "MALFORMED_SOURCE_KIND",
  /** Supersession retires a published belief; the target is not one. */
  targetNotPublished: "TARGET_NOT_PUBLISHED",
  /** The target's validity window is already closed (or already decided). */
  validityAlreadyClosed: "VALIDITY_ALREADY_CLOSED",
  /**
   * `re-authority` / `pin`: the target's validity window has ALREADY SHUT, so
   * no as-of-now read serves it and the vouch would have no observable effect
   * (#4939).
   *
   * Named for what is CHECKED, not for the usual cause: the predicate is
   * "`valid_to <= now()`", which a supersession produces but so does a
   * scheduled end that simply elapsed. A `TARGET_SUPERSEDED` spelling would
   * assert a replacement exists, and a caller branching on it would send the
   * user looking for one that may not.
   *
   * Distinct from {@link validityAlreadyClosed}, whose threshold is different:
   * `supersede` refuses ANY decided end date, a future one included, because a
   * second arbitration of the same claim is the thing it must not permit.
   */
  targetNotCurrent: "TARGET_NOT_CURRENT",
  /** `supersede` needs a replacement claim and none was given. */
  replacementMissing: "REPLACEMENT_MISSING",
  /** The replacement restates the target's own object — nothing to supersede. */
  replacementIdentical: "REPLACEMENT_IDENTICAL",
  /**
   * The replacement has no IDENTITY — its object normalizes away (`-`, `___`),
   * so the successor would occupy no slot (#5047). NOT a whitespace-only
   * object: `normalizeReplacement` trims that to `""` and it is refused as
   * {@link replacementMissing} at the pure-validation gate, long before
   * reconcile.
   *
   * ⚠️ NOT a second spelling of the ingest guard, and the distinction is what
   * keeps it legitimate. `reconcile.ts`'s `MALFORMED_CLAIM` is the one place
   * that DECIDES this — the check is not repeated here and this module never
   * calls `slotKey` to ask. What this member does is TRANSLATE that seam's
   * verdict into the module's own error type, so a human who typed `-` gets a
   * 400 naming what is wrong with their text instead of the 500 a raw throw
   * produced. `applySupersede`'s block arm is the only site that raises it.
   *
   * Reachable only through `supersede`: the other three verbs supply no claim.
   * Before #5047 the same input passed every gate and installed a successor
   * nothing could ever corroborate, contradict, or supersede — the case
   * the identical-guard's own comment (in `correctFact`'s supersede arm)
   * records as deliberately uncovered, on the argument that the ingest seam
   * would close it — which is what #5047 did.
   */
  replacementMalformed: "REPLACEMENT_MALFORMED",
  /** The replacement could not become a published fact (structural refusal). */
  replacementUnpublishable: "REPLACEMENT_UNPUBLISHABLE",
} as const;

export type CorrectionRefusalReason =
  (typeof CORRECTION_REFUSAL_REASONS)[keyof typeof CORRECTION_REFUSAL_REASONS];

/**
 * A refusal raised INSIDE the transaction, so the throw is what rolls the
 * correction episode back. Caught by {@link correctFact} and returned as an
 * ordinary outcome — a refused correction is a result, not an incident.
 */
export class CorrectionRefusedError extends Error {
  constructor(
    readonly reason: CorrectionRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "CorrectionRefusedError";
  }
}

export interface CorrectionReplacement {
  /** The corrected object; subject and predicate are inherited from the target. */
  readonly object: string;
  /** When the corrected value began to hold. Defaults to the correction time. */
  readonly validFrom?: Date | null;
}

export interface CorrectionRequest {
  readonly ctx: BrainPrincipalContext;
  readonly factId: string;
  readonly verb: CorrectionVerb;
  /** Free-text rationale, recorded verbatim in the correction episode body. */
  readonly reason?: string;
  /** Required for `supersede`, meaningless elsewhere. */
  readonly replacement?: CorrectionReplacement;
  readonly requestId?: string;
  /**
   * The workspace's identity vocabulary (ADR-0037 §6, #5022), threaded for
   * `reconcileFacts`' reason and used at BOTH of this module's key sites: the
   * supersede guard's slot comparison, and the replacement claim it hands to
   * reconcile.
   *
   * REQUIRED, and on the REQUEST rather than in `CorrectionDeps` beside the test
   * seams — because it is workspace STATE, not a seam, and defaulting it is the
   * hazard `identity.ts` spells out under "`alias` is REQUIRED": both sites have
   * to use the SAME vocabulary the ingest path used, or the guard refuses a
   * different set than the corpus considers identical and the replacement lands
   * keyed under a different identity function than every other row in the
   * workspace. Neither is visible at rest. Defaulting it here would also defeat
   * `ReconcileRequest.vocabulary` being required, since this module is the one
   * production caller that feeds it.
   *
   * POSITION-SCOPED since #5022: the guard below compares OBJECTS, so it reads
   * `vocabulary.object` and cannot silently pick up a predicate-position
   * approval.
   */
  readonly vocabulary: ClaimVocabulary;
}

export interface CorrectionDeps {
  /** Defaults to a transaction on the internal pool. */
  readonly withTransaction?: ReconcileTransactionRunner;
  /** Test clock. */
  readonly now?: () => Date;
  /** Test seam for the episode's unique `source_id` suffix. */
  readonly newCorrectionId?: () => string;
  /**
   * Test seam for {@link AUDIT_WRITE_TIMEOUT_MS}. Exists so the deadline on the
   * post-commit audit write is provable in milliseconds instead of seconds —
   * without it the only way to pin "a hung internal DB cannot hold a chat turn
   * open" is a 5-second test, which sits exactly on bun's default per-test
   * timeout.
   *
   * A positive, finite number of milliseconds no greater than 2_147_483_647.
   * Anything else falls back to the real bound — see `resolveAuditDeadline`,
   * which is where that is enforced, because the type cannot say it.
   */
  readonly auditWriteTimeoutMs?: number;
}

/** What became of one correction request. */
export type CorrectionOutcome =
  | { readonly kind: "corrected"; readonly result: BrainFactCorrectionResponse }
  | {
      readonly kind: "refused";
      readonly reason: CorrectionRefusalReason;
      readonly message: string;
    }
  /**
   * No such fact, already retracted, or not visible to this actor — the three
   * are deliberately indistinguishable, for `retractFactCandidate`'s original
   * reason: a distinct answer would confirm the existence of a fact the actor
   * may not see.
   */
  | { readonly kind: "not-found" };

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
//
// Exported for two test seams: `candidates-pg.test.ts` §7 executes these
// strings against the live schema (via `correctFact`, on that file's existing
// bootstrap), and `correction.test.ts` dispatches on their identity so a
// paraphrased second spelling of any statement fails loudly.
//
// NOTE for the next editor: this file is on `check-brain-fact-promotion.sh`'s
// ALLOWLIST — see the module header for the recorded rationale. That is a
// carve-out for the ONE `status` write below and the imported #4912 stamp,
// not license: any new statement here that touches `status`, `visible_to`, or
// `valid_to` needs the same argument the existing ones carry.

/**
 * The ACL-gated target read. `FOR UPDATE` serializes two corrections (or a
 * correction and a publish) racing on one fact, so every later statement in
 * the transaction acts on the row version this SELECT saw.
 *
 * `invalidated_at IS NULL`: a tombstoned fact is already withdrawn — every
 * verb on it answers not-found, indistinguishable from absence (see
 * {@link CorrectionOutcome}).
 *
 * `window_closed` is COMPUTED IN POSTGRES, and that is not a convenience
 * (#4939). Deciding it in TypeScript would compare a Postgres timestamp
 * against the Node process clock — skew-limited rather than exact at precisely
 * the boundary the refusal turns on — and would additionally have to parse a
 * column nothing else parses. Evaluated here, it reads the same CLOCK the
 * reads read. (Not the same instant: reads run in their own transactions, so
 * `now()` differs per transaction. What this buys is the elimination of the
 * clock-SOURCE skew, which is the part that can be eliminated.)
 *
 * It is `NOT brainFactCurrentClause(…)`, IMPORTED rather than restated, for
 * the reason `SUPERSEDE_STAMP_EXPLICIT_SQL` is imported one screen up: the whole
 * justification for computing this in Postgres is that the vouch refusal and
 * the reads it reasons about cannot disagree about which facts are current,
 * and a second hand-written spelling of `valid_to > now()` is exactly how they
 * would come to. A grace window or a `>=` added to that clause now reaches
 * this refusal by construction instead of silently desynchronizing from it —
 * which no boundary test would catch, since a moved boundary moves both the
 * fixture and the predicate.
 *
 * The raw `valid_to` still travels for `supersede`'s own gate (which refuses
 * ANY decided end date, future included) and for the refusal message's date.
 *
 * ## It projects the three identity keys (#5037)
 *
 * `keys-not-on-the-wire.test.ts` forbids that from a read surface, and this is
 * the second carve-out it grants — on ADR-0037 §8's row-copy rule, the same
 * rationale the region bundle's three files carry. What the prohibition protects
 * is a key reaching a CONSUMER that can branch on it, because the moment one
 * does, the vocabulary stops being an internal join detail and an alias becomes
 * un-removable. These keys reach exactly one destination: back into the slot
 * columns of the replacement row, through {@link InheritedSlot}. No route to the
 * wire exists — `BrainFactCorrectionResponse` carries no claim text at all, let
 * alone a key, and the module's own comment at the `supersededPredicate` site
 * already refuses to widen it for that reason.
 *
 * The alternative is what #5037 records as the defect: re-deriving
 * `alias_now(lexicalNorm(target.subject))` and getting the stored key only while
 * the vocabulary has not moved.
 *
 * `aclSql` must alias the fact table `f` and is interpolated — same contract
 * as `brainFactPreviewSql` and every other clause-taking builder in the slice.
 */
export function correctionTargetSql(aclSql: string, idParam: number): string {
  return `SELECT f.id::text AS id,
                f.subject,
                f.predicate,
                f.object,
                f.subject_key,
                f.predicate_key,
                f.object_key,
                f.status,
                f.provenance,
                f.visible_to,
                f.valid_to,
                NOT ${brainFactCurrentClause("f")} AS window_closed,
                f.source_episode_id::text AS source_episode_id
           FROM brain_facts f
          WHERE ${aclSql}
            AND f.id = $${idParam}::uuid
            AND f.invalidated_at IS NULL
            FOR UPDATE`;
}

/**
 * The correction episode — the immutable human-authored record of the verb.
 *
 * `source = 'human'` (the connector-class vocabulary already reserves it), a
 * fresh `correction:`-prefixed `source_id` per correction (two corrections of
 * one fact are two episodes; nothing dedupes them away), the acting principal
 * as `source_actor`, and the verb payload as the body.
 *
 * `extracted_at` is stamped AT INSERT — deliberately opposite to the connector
 * ingest path, whose header calls a stamped-at-ingest value a silent drop.
 * Here the correction path IS the episode's processing: the fact-side effect
 * commits in the same transaction, so leaving the row on the extraction queue
 * would hand a human's exact words to the LLM extraction fiber to be
 * re-derived as a second, machine-produced claim.
 */
export const CORRECTION_EPISODE_INSERT_SQL = `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, locator, occurred_at, visible_to, extracted_at)
       VALUES ($1, 'human', $2, $3, $4, NULL, $5::timestamptz,
               ARRAY(SELECT jsonb_array_elements_text($6::jsonb)), $5::timestamptz)
       RETURNING id::text AS id`;

/**
 * The tombstone — the only tombstone DECISION path, now that the review
 * surface's retract routes through this module (#4915 unification of #4772's
 * negative verb). The one other statement writing the column is the region
 * import's INSERT (`admin-migrate.ts`).
 *
 * ⚠️ That statement used to only RESTORE an existing `invalidated_at` verbatim —
 * a restore, not a new arbitration, the same distinction the promotion guard's
 * allowlist draws. Since #5047 it can also MINT one: a fact whose surface
 * normalizes away lands tombstoned with a placeholder key, matching what
 * migration 0194 does to the identical state. Still not an arbitration — it
 * retires a claim that asserts nothing at some position, which no reader could
 * ever have acted on — but the plain "restore, never mint" reading is no longer
 * true, and this module is not the only tombstone WRITER even though it remains
 * the only tombstone DECISION about a claim that says something. It never names `status`:
 * withdrawal is a tombstone, not a demotion — and the tombstone hides the row
 * from every fact-serving read, `asOf` included (#4916); only the tension
 * surfaces still list it, labelled, as a withdrawn rival. The ACL already ran
 * at {@link correctionTargetSql}, which also holds the row lock; the residual
 * predicates make the statement correct standalone.
 */
export const RETRACT_FACT_SQL = `UPDATE brain_facts
        SET invalidated_at = now(), updated_at = now()
      WHERE workspace_id = $1
        AND id = $2::uuid
        AND invalidated_at IS NULL
    RETURNING id::text AS id, invalidated_at`;

/**
 * The correction's lineage pointer, fact → correction episode. `derives-from`
 * rather than `provenance`, and the distinction is load-bearing: a
 * `provenance` edge says the episode is EVIDENCE FOR the claim — it feeds the
 * corroboration count and the decay anchor — which is exactly wrong for a
 * retraction or a supersession, where the episode refutes or retires the
 * claim. `re-authority` and `pin` use the provenance statement instead,
 * because there the human really is vouching for the claim. Idempotence guard
 * mirrors `INSERT_PROVENANCE_EDGE_SQL`'s.
 */
export const DERIVES_FROM_EDGE_SQL = `INSERT INTO brain_edges
         (workspace_id, edge_type, from_fact_id, to_episode_id)
       SELECT $1, 'derives-from', $2::uuid, $3::uuid
        WHERE NOT EXISTS (
          SELECT 1 FROM brain_edges
           WHERE workspace_id = $1
             AND edge_type = 'derives-from'
             AND from_fact_id = $2::uuid
             AND to_episode_id = $3::uuid)
       RETURNING id`;

/**
 * Live facts that derive from the target — the set a retraction flags.
 *
 * Deliberately NOT gated by the actor's ACL: the flag is a quality marker on
 * rows the retraction just undermined, and skipping the ones the actor cannot
 * see would leave exactly those unflagged forever (nobody else knows the
 * premise fell). Nothing about the dependents is DISCLOSED — the response
 * carries opaque ids only, the same class of handle the withheld-tension arm
 * already ships.
 */
export const DEPENDENT_FACTS_SQL = `SELECT ed.from_fact_id::text AS id
     FROM brain_edges ed
     JOIN brain_facts f
       ON f.workspace_id = ed.workspace_id
      AND f.id = ed.from_fact_id
    WHERE ed.workspace_id = $1
      AND ed.edge_type = 'derives-from'
      AND ed.to_fact_id = $2::uuid
      AND f.invalidated_at IS NULL
    ORDER BY f.ingested_at, f.id`;

/**
 * Merge a correction marker under a fact's provenance payload.
 *
 * `provenance || $3::jsonb` appends top-level keys and can only ever ADD or
 * replace the marker key itself — the structural keys reconcile wrote are
 * untouched because no marker spells them. Three markers ride this statement:
 * `reReview` (retract flags a dependent), `reAuthority`, and `pinned`. It
 * names none of the gated columns, which is what makes flagging a NON-cascade
 * by construction: this is the only statement a dependent is ever touched by.
 *
 * ## None of the three has a READER yet — say so, don't imply one (#4939)
 *
 * `projectProvenance` whitelists the keys it emits and drops all three, and no
 * other surface reads them. They are WRITE-DURABLE, not surfaced: the record a
 * future review surface will read.
 *
 * The same holds for what they mark. No IN-REGION path mints a `derives-from`
 * fact→fact edge — this module writes fact→EPISODE — so {@link
 * DEPENDENT_FACTS_SQL} returns `[]` on a self-contained deployment, and the
 * M5 write-back producer is what would change that. Not an absolute, though:
 * `admin-migrate.ts` restores `derives-from` edges verbatim, so an imported
 * workspace can arrive carrying them today.
 *
 * That is a bounded, deliberate state, and the rule it carries is: every
 * user-facing string about these markers must describe what is RECORDED, never
 * promise a place to go look. Where a human is told a number today, it is
 * because a RESPONSE carried it at the moment of the correction — `/retract`
 * and `/correct` return the flagged ids, the agent tool returns the count —
 * not because a surface renders the marker.
 *
 * The DURABLE, re-readable record is the `admin_action_log` row this module
 * writes below, and since #4934 it is written for EVERY entry point — the two
 * admin routes and the agent tool alike, which is what that issue fixed. So
 * the ids survive an agent-initiated retraction too; what the agent does not
 * get is sight of them.
 *
 * Spell that table precisely: `audit_log` is a DIFFERENT real table — SQL
 * query history — so naming it here would send an operator chasing a lost flag
 * to a query that returns zero rows and the conclusion that the write never
 * happened.
 *
 * Give one of the three a reader and the prose in `brain-corrections.mdx` and
 * this module's `pin` header bullet becomes an understatement that should be
 * corrected in the same change; `candidates.test.ts` fails on exactly that
 * transition, so the pairing is enforced rather than remembered.
 */
export const MERGE_PROVENANCE_MARKER_SQL = `UPDATE brain_facts
        SET provenance = provenance || $3::jsonb, updated_at = now()
      WHERE workspace_id = $1
        AND id = ANY($2::uuid[])
        AND invalidated_at IS NULL
    RETURNING id::text AS id`;

/**
 * Promote the correction-authored replacement — the allowlisted `status`
 * write this module exists to carry (see the header). Only ever pointed at
 * the fact `reconcileFacts` just created or corroborated IN THIS TRANSACTION,
 * after {@link classifyFactForPromotion} admitted it; the `status = 'draft'`
 * predicate keeps the statement correct standalone, exactly like
 * `PROMOTE_FACTS_SQL`'s.
 */
export const PROMOTE_CORRECTION_FACT_SQL = `UPDATE brain_facts
        SET status = 'published', updated_at = now()
      WHERE workspace_id = $1
        AND id = $2::uuid
        AND status = 'draft'
        AND invalidated_at IS NULL
    RETURNING id::text AS id`;

/** The replacement row, read back for the promotion classifier. */
export const REPLACEMENT_ROW_SQL = `SELECT f.id::text AS id,
                f.subject,
                f.predicate,
                f.object,
                f.status,
                f.source_episode_id::text AS source_episode_id,
                f.provenance,
                f.visible_to
           FROM brain_facts f
          WHERE f.workspace_id = $1
            AND f.id = $2::uuid
            FOR UPDATE`;

// ---------------------------------------------------------------------------
// The verb dispatcher
// ---------------------------------------------------------------------------

/**
 * Run the post-commit cardinality proposal under a deadline, and REPORT
 * whichever way it ends.
 *
 * ## Why the timer is cleared here and not by the timer promise's own `.finally`
 *
 * The first cut of this was `new Promise(…).finally(() => clearTimeout(timer))`,
 * and it did nothing: that `finally` is attached to the TIMER PROMISE, which
 * settles only when the timer fires — so `clearTimeout` ran after the timeout
 * had already elapsed and was unconditionally a no-op. On the fast path the
 * promise never settled at all, the callback never ran, and a 5s timer stayed
 * armed on every supersede correction, holding the event loop open.
 *
 * That is the EXACT defect `AUDIT_WRITE_TIMEOUT_MS`'s docstring records its two
 * hand-rolled precedents having, in a helper whose stated reason for existing
 * was to avoid it. Measured under bun: race settled at 52ms, `finally` ran at
 * 3080ms. The `finally` has to wrap the RACE, which is what
 * {@link emitCorrectionAudit} does 700 lines down and is the shape to copy.
 *
 * ## The losing branch is not discarded
 *
 * `Promise.race` does not CANCEL the query, and it marks the loser's rejection
 * as handled — so a real store error arriving after the deadline is dropped
 * with no line and not even an unhandled rejection. `emitCorrectionAudit` says
 * so in as many words and installs a continuation for it; this does the same.
 * Without it the only line an operator ever sees is "timed out", about a
 * statement that failed with a `42P01` two seconds later.
 *
 * ## What "timed out" does and does not mean for the proposal
 *
 * The transaction keeps running, so a slow proposal usually COMMITS after this
 * returns. The caller's message must not claim otherwise — the honest statement
 * is that the correction is unaffected and the proposal's fate is unknown,
 * which is what it says.
 *
 * NEVER THROWS: every outcome is logged and absorbed here, because the caller
 * is post-commit and its own error copy says "nothing was changed — retry".
 */
async function proposeUnderDeadline(
  work: () => Promise<unknown>,
  ms: number,
  meta: { readonly workspaceId: string; readonly factId: string; readonly requestId: string | undefined },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    // Invoked INSIDE the try, which is why this takes a THUNK rather than a
    // promise. `withTransaction` is `deps.withTransaction ?? withBrainTransaction`
    // — a plain function type nothing forces to be `async` — so an injected
    // runner that threw SYNCHRONOUSLY would land on an already-committed
    // correction and reach a caller whose error copy says "nothing was changed
    // — retry". The first cut took the promise as an argument, which put that
    // throw back outside the protection; `emitCorrectionAudit` builds its entry
    // inside its own `try` for exactly this reason.
    const pending = work();
    // A deadline does not CANCEL the query, and `Promise.race` marks the
    // loser's rejection handled — so a real store error arriving AFTER the
    // deadline would be dropped with no line and not even an unhandled
    // rejection.
    //
    // GUARDED on `timedOut`, both arms. Unguarded, this fires on the ordinary
    // fast-failure path too, where the `catch` below already reports it: one
    // event, two warns with identical `err` strings, and the second one wrong.
    // `emitCorrectionAudit`'s continuation carries the same guard.
    void pending
      .then(
        () => {
          if (!timedOut) return;
          log.warn(
            { ...meta },
            "brain correction: the cardinality repeat gate COMPLETED after its deadline — the earlier " +
              "timeout line for this requestId reports the same event, and any proposal it raised is present",
          );
        },
        (cause: unknown) => {
          if (!timedOut) return;
          log.warn(
            { ...meta, err: cause instanceof Error ? cause.message : String(cause) },
            "brain correction: the cardinality repeat gate FAILED after its deadline had already been " +
              "reported — this is the underlying cause behind the earlier timeout line for this " +
              "requestId, and no proposal landed",
          );
        },
      )
      // DETACHED — it settles after the response has gone out, so no `try` on
      // the correction path can reach it, and an unhandled rejection is
      // process-fatal by default. A committed correction's bookkeeping must not
      // be able to take down the worker.
      .catch(() => {
        // intentionally ignored: best-effort observability on a detached
        // promise. The only ways here are the logger itself throwing and the
        // `String(cause)` coercion above on a hostile rejection value (a
        // `Symbol`, a throwing `toString`) — neither of which a committed
        // correction's bookkeeping may take the worker down for.
      });

    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              `the cardinality repeat gate did not answer within ${ms}ms — the internal database is ` +
                "reachable but not responding, or CORRECTION_REPEAT_COUNT_SQL is scanning without an index",
            ),
          );
        }, ms);
      }),
    ]);
  } catch (err) {
    // BRANCHED on `timedOut`, and the two arms differ in what they can honestly
    // claim. An unbranched line was the first cut, and on a `42P01` thrown in
    // 2ms it said the gate "could not be evaluated within its deadline" — there
    // was no deadline event — and that the statement "may still commit", when
    // `withTransaction` had definitively rolled it back. A lying disclosure, in
    // the helper written to stop one.
    log.warn(
      // `pgErrorFields` + the Error object, not a bare message, on
      // `emitCorrectionAudit`'s precedent: this arm's own copy ends "diff
      // CORRECTION_REPEAT_COUNT_SQL", and the two failures it is most likely to
      // be reporting are a missing relation (`42P01` — diff the statement) and
      // pool exhaustion (`53300` — the statement is fine). Without the code
      // those read identically, and the message sends an operator to the wrong
      // one half the time.
      { ...meta, timedOut, ...pgErrorFields(err), err: err instanceof Error ? err : new Error(String(err)) },
      timedOut
        ? "brain correction: the cardinality repeat gate did not answer within its deadline — the " +
            "correction itself is COMMITTED and unaffected. The proposal's own fate is UNKNOWN: the " +
            "statement is not cancelled and may still commit. IF it settles, a follow-up line for this " +
            "requestId says which — but the failure this deadline exists for is a database that is " +
            "reachable and not answering, which may never produce one, so treat a missing follow-up as " +
            "the statement still being in flight. Either way the next supersede on this predicate " +
            "re-derives the count from the corpus rather than from a lost counter"
        : "brain correction: the cardinality repeat gate FAILED — the correction itself is COMMITTED " +
            "and unaffected, and the proposal did NOT land. The next supersede on this predicate " +
            "re-derives the count from the corpus; diff CORRECTION_REPEAT_COUNT_SQL",
    );
  } finally {
    // Around the RACE, so it runs whoever wins. This is the whole fix: a
    // `finally` on the TIMER PROMISE settles only when the timer fires, so
    // `clearTimeout` was always a no-op and the fast path left it armed.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/*
 * (`logDegeneratePredicate` and `DegeneratePredicateCause` lived here until
 * #5047 and are gone because the state they reported cannot occur.
 *
 * They existed for a `supersede` that committed while closing no canonical
 * predicate slot — reachable in two ways, a predicate SURFACE that normalizes
 * away and an unkeyed TARGET row, which #5037 taught them to tell apart. Both
 * are now unrepresentable at a COMMITTED supersede: the replacement inherits the
 * target's slot, and `reconcile.ts`'s `MALFORMED_CLAIM` guard refuses a
 * candidate whose slot key is null — so the verb is REFUSED
 * (`REPLACEMENT_MALFORMED`) and the transaction rolls back instead of reaching
 * the post-commit reporter. The target row itself cannot carry a null key at
 * all: `brain_facts`' three key columns are `NOT NULL` as of migration 0194, and
 * the legacy rows that could are tombstoned, which puts them outside what
 * `readTargetRow` will correct.
 *
 * So `supersededPredicate` is non-null on every committed `supersede`, and the
 * only `null` left is the honest one the other three verbs send: *this verb is
 * not evidence about cardinality*. Kept as a note rather than dead code with a
 * comment explaining why nothing reaches it.)
 */

/**
 * Tag a verb's response with the canonical predicate it closed, or with nothing.
 *
 * Two named helpers rather than an inline object literal at four call sites,
 * because the DEFAULT has to be loud. `noSupersededPredicate` is a caller
 * SAYING this verb is not evidence about cardinality; an omitted field would be
 * a caller who did not think about it, and the two are indistinguishable in a
 * diff. A fifth verb has to pick one.
 *
 * ⚠️ **Naming, not typing.** `noSupersededPredicate` returns the `null` LITERAL
 * so it is not assignable where a key is required, but nothing stops a caller
 * reaching for {@link withSupersededPredicate} on the wrong verb — the earlier
 * version of this docstring claimed the shape enforced *only a `supersede` sets
 * this*, and it does not. `scripts/mutations/cardinality.mutations.ts` is the
 * proof: the "`retract` feeds the proposer too" row COMPILES and is caught by
 * two tests. The invariant is test-enforced, and saying so is the point of this
 * paragraph. Tagging the outcome on the verb would make it structural; that is
 * worth doing when a fifth verb arrives, not before.
 */
async function withSupersededPredicate(
  /**
   * The canonical predicate the verb closed. NON-NULL on every path that
   * commits (#5047) — the type stays `string | null` only because it shares a
   * shape with {@link noSupersededPredicate}, whose `null` means something
   * different and is the one a reader must not confuse it with.
   */
  supersededPredicate: string | null,
  response: Promise<BrainFactCorrectionResponse>,
): Promise<{
  response: BrainFactCorrectionResponse;
  supersededPredicate: string | null;
}> {
  return { response: await response, supersededPredicate };
}

async function noSupersededPredicate(
  response: Promise<BrainFactCorrectionResponse>,
): Promise<{
  response: BrainFactCorrectionResponse;
  supersededPredicate: null;
}> {
  // `null` here is a caller SAYING this verb is not evidence about cardinality
  // — the only meaning the value still carries since #5047 removed the other.
  return { response: await response, supersededPredicate: null };
}

interface TargetRow {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /**
   * The target's STORED slot (#5037) — read, never re-derived.
   *
   * Built ONCE, by `readTargetRow`, off the row it describes. That placement is
   * load-bearing rather than tidy: an {@link InheritedSlot} records the fact id
   * it was read from, and constructing it anywhere else would let one row's slot
   * reach a correction about another. Built at the read, the two cannot come
   * apart — there is no second row in scope.
   *
   * A `null` key inside it is legal: the columns are nullable at rest and an
   * unkeyed legacy row genuinely has no slot. What is NOT legal is an ABSENT
   * column, which `readTargetRow` refuses as `correctionTargetSql` drift exactly
   * as it does for `valid_to`. A missing key defaulted to `null` would land the
   * replacement in the `(NULL, NULL)` slot — silently un-collidable — while the
   * id-based stamp retired the target anyway.
   */
  readonly slot: InheritedSlot;
  /**
   * The target's stored OBJECT key, read for ONE consumer: the
   * `replacementIdentical` guard, which decides whether the replacement restates
   * the value the fact already has.
   *
   * That comparison needs the target's STORED key for the same reason the slot
   * does — a re-derivation diverges under a moved vocabulary — except that here
   * the divergence falls on the guard deciding whether an irreversible write
   * happens at all.
   *
   * It is deliberately NOT part of {@link TargetRow.slot}: the replacement's
   * object is new, human-authored text and keys on its own terms, and a channel
   * that could carry an object key is a channel through which one gets inherited.
   * See {@link InheritedSlot}.
   */
  readonly objectKey: string | null;
  readonly status: string;
  readonly provenance: unknown;
  readonly grantTokens: readonly string[];
  /**
   * `Date | string | null`, not `unknown`: `readTargetRow` refuses anything
   * else as drift, so passing a different column in here is a compile error
   * and the two temporal gates below cannot silently read an unparseable
   * value as "no end date".
   */
  readonly validTo: Date | string | null;
  /**
   * Postgres' own answer to "is this claim's validity window already shut?",
   * against the same `now()` every read uses. See {@link correctionTargetSql}.
   */
  readonly windowClosed: boolean;
}

/**
 * Apply one correction verb.
 *
 * Returns an outcome, never throws for a DOMAIN refusal — a refused or
 * not-found correction is an ordinary result. Throws only for infrastructure
 * failure (the caller's 500 path) and {@link BrainReaderUnresolvedError} when
 * the actor's identity resolves to no usable principals.
 */
export async function correctFact(
  request: CorrectionRequest,
  deps: CorrectionDeps = {},
): Promise<CorrectionOutcome> {
  const { ctx, factId, verb, requestId, vocabulary } = request;
  const now = deps.now ?? (() => new Date());
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const newCorrectionId = deps.newCorrectionId ?? randomUUID;

  // ── Authority ─────────────────────────────────────────────────────────
  // A correction is a trust decision with immediate authoritative effect, so
  // it carries the review gate's own bar: org owner/admin. The
  // `unauthenticated-local` arm passes — that deployment has DECLARED the
  // local operator is the only identity there is, and the admin surface
  // already treats them as such.
  if (ctx.origin === "authenticated" && ctx.role !== "owner" && ctx.role !== "admin") {
    return {
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.notAuthorized,
      message:
        "Corrections are an admin verb: they land authoritative immediately, without the review queue. " +
        "Ask a workspace owner or admin to apply this correction, or flag the fact in review instead.",
    };
  }

  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, CORRECTION_SURFACE);
  }

  // ── Pure request validation, before any connection is checked out ────
  const replacement = normalizeReplacement(request.replacement);
  if (verb === "supersede") {
    if (replacement === null) {
      return {
        kind: "refused",
        reason: CORRECTION_REFUSAL_REASONS.replacementMissing,
        message:
          "Superseding needs the corrected value: pass a non-blank `replacement.object` (the subject and " +
          "predicate are inherited from the fact being superseded). To withdraw the claim without replacing " +
          "it, use `retract`.",
      };
    }
  }

  const actor = ctx.userId ?? "local-operator";
  // Grammar-valid principal for the replacement fact's provenance `actor`.
  // The `unauthenticated-local` arm records the class rather than an id —
  // that deployment declared it has no ids to record.
  const sourcePrincipal = ctx.userId !== null ? `user:${ctx.userId}` : "human:local-operator";

  // Bound OUTSIDE the try, and the try holds nothing but the transaction. The
  // audit write below is post-commit work, and a post-commit throw reaching
  // this catch would be classified as a refusal or rethrown to a caller whose
  // own error copy says "nothing was changed — retry" (`lib/tools/correct-fact.ts`).
  // Placement, not a comment, is what keeps that impossible.
  /**
   * The verb's response, plus the canonical predicate a `supersede` closed —
   * `null` on that second field for every other verb (#5027).
   *
   * Only `supersede` is evidence about cardinality: it is the one verb in which
   * a human asserts BY THEIR ACTION that this slot holds one value. `retract`
   * withdraws a claim without replacing it and says nothing about how many could
   * coexist; the two vouching verbs say the opposite of nothing.
   *
   * RETURNED from the transaction rather than assigned to a captured `let`, and
   * that is not a style preference: TypeScript's flow analysis cannot see an
   * assignment made inside an awaited callback, so a `let x: string | null = null`
   * read afterwards narrows to `never` at the guard — the branch reads as dead
   * to every type-aware tool, and any future type error inside it is masked.
   * It does NOT make *only a `supersede` sets this* structural, and an earlier
   * version of this line claimed it did. The tuple NAMES the outcome so a new
   * verb has to choose one of `withSupersededPredicate` /
   * `noSupersededPredicate`; the invariant itself is test-enforced, and
   * `scripts/mutations/cardinality.mutations.ts`'s "`retract` feeds the proposer
   * too" row is the proof — it compiles, and two tests catch it.
   */
  let outcome: {
    readonly response: BrainFactCorrectionResponse;
    readonly supersededPredicate: string | null;
  } | null;
  try {
    outcome = await withTransaction(async (tx) => {
      // ── The target, ACL-gated and row-locked ──────────────────────────
      const params: unknown[] = [...acl.params, factId];
      const targetResult = await tx.query(correctionTargetSql(acl.sql, params.length), params);
      const target = readTargetRow(targetResult.rows[0], ctx.workspaceId);
      if (target === null) return null;

      // Tier-1: refused for EVERY verb, before anything is written.
      if (isWarehouseDerived(target.provenance)) {
        throw new CorrectionRefusedError(
          CORRECTION_REFUSAL_REASONS.warehouseTarget,
          "This fact is warehouse-derived (tier-1), and tier-1 has no correction path: the warehouse is " +
            "authoritative by construction. Fix the underlying data, or fix the semantic layer that derives it — " +
            "the brain never overrides the warehouse.",
        );
      }

      // The undecidable case, refused for every verb too and for the same
      // invariant (#4964). Mutually exclusive with the arm above — a kind
      // cannot be both in the vocabulary and outside it — so the order is
      // readability (the known answer first), not precedence.
      const unknownKind = unrecognizedSourceKind(target.provenance);
      if (unknownKind !== null) {
        // The operator-facing half. The user gets the prose below; this is
        // where the two facts that actually locate the problem go — WHICH kind
        // was declined, and the vocabulary it was declined against. Deliberately
        // withheld from the HTTP response, so this line is the only place they
        // appear, which is why it carries `requestId` like every log on the
        // correction path rather than making an operator hop through `factId`.
        //
        // Says what was OBSERVED, not why. The region import is how this
        // normally arises, but nothing here can establish it: a region rolled
        // back below the release that added a member reaches this same arm with
        // no import in its history, and naming a cause the gate cannot check
        // would send an operator to the region-migration runbook for a deploy
        // problem — the same mistake as reporting this refusal as tier-1.
        log.warn(
          {
            requestId,
            workspaceId: ctx.workspaceId,
            factId,
            verb,
            // Bundle-controlled and entirely unvalidated — the import's FACT
            // validator requires only a non-empty `provenance` object and never
            // inspects `.source` (`api/routes/admin-migrate.ts`). Bounded here
            // because this line is emitted per ATTEMPT on a path the
            // `correct_fact` tool can retry; the marker matters because a
            // silently-truncated kind reads as complete to whoever greps the
            // vocabulary for it.
            source:
              unknownKind.kind.length > 200
                ? `${unknownKind.kind.slice(0, 200)}… (${unknownKind.kind.length} chars)`
                : unknownKind.kind,
            resolvable: unknownKind.resolvable,
            vocabulary: EPISODE_SOURCES,
          },
          unknownKind.resolvable
            ? "Refused a correction on a fact whose source kind is outside this deployment's vocabulary — its tier cannot be resolved here, so the correction path is quarantined until a release admits the kind (#4964)"
            : "Refused a correction on a fact whose provenance.source is not a string — no vocabulary can ever admit it, so this is a stored-data defect needing provenance repair, not an upgrade (#4964)",
        );
        throw new CorrectionRefusedError(
          unknownKind.resolvable
            ? CORRECTION_REFUSAL_REASONS.unrecognizedSourceKind
            : CORRECTION_REFUSAL_REASONS.malformedSourceKind,
          unknownKind.resolvable
            ? "This fact came from a source kind this deployment does not recognise, so whether it is " +
                "warehouse-derived (tier-1, which has no correction path) cannot be determined here. That " +
                "usually means the fact was imported from a region running a newer vocabulary and restored " +
                "verbatim rather than reinterpreted, or that this deployment was rolled back below the " +
                "release that introduced the kind. Corrections are refused until this deployment runs a " +
                "version that knows it — the fact itself is intact and readable, and no correction is lost."
            : "This fact's recorded source is malformed — it is not a source kind at all, so whether the " +
                "fact is warehouse-derived (tier-1, which has no correction path) cannot be determined, and " +
                "every correction verb is refused including retract. No release will resolve this: the " +
                "stored provenance itself has to be repaired. It reached this deployment through a region " +
                "import, which restores a bundle's provenance verbatim. Contact support with this fact's id.",
        );
      }

      // Supersede-only target-state checks, BEFORE the episode is written so
      // the common refusals never open a write at all.
      if (verb === "supersede") {
        if (target.status !== "published") {
          throw new CorrectionRefusedError(
            CORRECTION_REFUSAL_REASONS.targetNotPublished,
            "Supersession retires a published belief, and this fact is not published. " +
              "If it is a draft you no longer trust, `retract` it from the review queue instead — " +
              "there is nothing current to replace yet.",
          );
        }
        if (target.validTo !== null) {
          throw new CorrectionRefusedError(
            CORRECTION_REFUSAL_REASONS.validityAlreadyClosed,
            "This fact's validity window is already closed or already has a decided end date, so there is " +
              "no current belief to supersede. Correct the CURRENT fact for this subject and predicate instead.",
          );
        }
        // Compared on the SLOT KEY, not byte-exactly (#5020, ADR-0037 §1).
        // "Restates what the fact already says" has to mean what the rest of
        // the system means by the same claim, and since #5020 that is
        // `alias(lexicalNorm(surface))`: `Bob` and `bob` are ONE object slot.
        // Left byte-exact, this guard would pass such a replacement through to
        // `SUPERSEDE_STAMP_EXPLICIT_SQL` — closing a published belief and standing up a
        // successor in the identical slot, with a `supersedes` edge recording
        // an arbitration that settled nothing. That is the irreversible
        // direction reached through a spelling difference, which is exactly
        // what the guard exists to prevent.
        //
        // Two NULL keys count as identical, which is the same conservative
        // arm: neither surface asserts anything, so there is no belief to
        // retire and refusing costs a `valid_to` stamp nobody could justify.
        // (Note this is a comparison, never a WRITE — the keys are derived at
        // ingest and `check-brain-fact-promotion.sh` gates only UPDATEs.)
        //
        // ONE case it deliberately does NOT cover: a degenerate replacement
        // against a REAL target (`-` superseding `bob`) is `null !== "bob"`, so
        // it passes here. ✅ CLOSED BY #5047, and closed where this comment said
        // it would be rather than by a second test added here: the
        // `MALFORMED_CLAIM` guard — 0187's header item 3, and the last
        // prerequisite of `SET NOT NULL` — now refuses a candidate whose
        // `slotKey` is null at the INGEST seam, and `applySupersede`'s
        // replacement goes through that seam, so the block rolls this verb's
        // `valid_to` stamp back with it. What `applySupersede` adds is a
        // TRANSLATION of that verdict into {@link replacementMalformed}, not a
        // second decision: the check still happens once, at reconcile.
        //
        // So this guard is still not the place to test for a degenerate
        // replacement, and adding one here would be the second spelling of that
        // guard the earlier note warned about. `correction.test.ts` pins the
        // rollback rather than assuming it.
        //
        // The keys are RE-DERIVED from the surfaces rather than read: the
        // target read cannot project a key (`keys-not-on-the-wire.test.ts`), so
        // this is the one place ADR-0037 §8's "carry, never re-derive" cannot
        // be honoured literally. Equal to the stored key while the vocabulary
        // is deterministic AND unchanged since the target was ingested.
        //
        // ⚠️ THAT SECOND CONDITION IS NO LONGER FREE. #5022 left it vacuous —
        // `loadClaimVocabulary` had no caller and every path named
        // `identityVocabulary`, which cannot move — and #5023 ended that: the
        // ingest path (`extract.ts`) and all three callers of this module
        // (`admin-brain-facts.ts` ×2, `lib/tools/correct-fact.ts`) now load the
        // workspace's real vocabulary. So a target ingested BEFORE an alias
        // approval and corrected AFTER it is re-derived under a different
        // vocabulary than keyed it, and the comparison widens or narrows
        // relative to the stored slot — it can refuse a supersession the corpus
        // considers distinct, or permit one it considers identical.
        //
        // Still not repaired HERE, and the repair is still not local. Two issues
        // own the two halves: ADR-0037 §7's drift re-key rewrites the affected
        // rows inside the approval's own decide transaction (#5024), which
        // closes the skew at the source, and #5037 makes this site inherit the
        // target's stored keys instead of re-deriving them, which closes it at
        // the read. §8 explicitly declines a per-row vocabulary version stamp
        // that would let this site detect the skew on its own.
        //
        // ✅ THE SOURCE HALF LANDED (#5024). The exposure is the window between
        // an approval and the re-key of the rows it affects, and that window is
        // no longer unbounded — it is now the decide TRANSACTION. The re-key
        // runs inside it, against every row in the workspace at the approved
        // position including tombstoned and superseded ones, so no committed
        // state produced BY THIS SEAM has an approved edge disagreeing with the
        // corpus. Scoped deliberately: the region import commits approved edges
        // with no re-key at all — `admin-migrate.ts` inserts
        // `brain_vocabulary_edge`, rebuilds the closure, and (since #5035) lands
        // its facts with keys the SOURCE region computed. So the two still
        // disagree by construction after an import, for a different reason than
        // before: not because the rows are unkeyed, but because a carried key is
        // a fixpoint of the source's vocabulary and not necessarily of this
        // one — ADR-0037 §8's accepted under-match. A
        // correction either reads keys written under the pre-approval vocabulary
        // and re-derives under the same one, or reads post-approval keys and
        // re-derives under that one. Both are self-consistent.
        //
        // What survives, and why #5037 is still open: this site re-derives from
        // the SURFACE, so it agrees with the stored key only while `lexicalNorm`
        // and the vocabulary are the two things the ingest path used. The
        // vocabulary is now pinned by the paragraph above; the re-derivation
        // itself is not, and a target whose key was CARRIED verbatim by a region
        // import (#5035) never went through this workspace's `slotKey` at all.
        // Closing that is #5037's job — inherit, do not re-derive.
        //
        // Recorded plainly: this is the one place #5023 made a dormant residual
        // live, and it did so knowingly, because the alternative was leaving the
        // vocabulary unreadable by anything.
        //
        // ⚠️ #5037 closed it, and this site is why the fix is not only about the
        // slot. The replacement's object key is DERIVED — it is new,
        // human-authored text that has never been stored, so deriving is the only
        // thing available and is correct. The TARGET's is now READ off the row.
        // Left re-derived it carried the same divergence as the slot did, on the
        // guard that decides whether an irreversible write happens at all: under
        // a moved vocabulary the two spellings the vocabulary now unifies key
        // apart, the guard reads them as different, and `Bob` → `bob` passes
        // through to `SUPERSEDE_STAMP_EXPLICIT_SQL` — closing a published belief
        // to stand up a successor asserting the same value in the same slot.
        //
        // ⚠️ TWO NULLS STILL MATCH, and that is load-bearing rather than
        // incidental. A surface that asserts nothing keys to `null` at both
        // positions, and the arm this refusal takes for that pair is the one that
        // does NOT stamp `valid_to` on a row asserting nothing — the conservative
        // direction, pinned by "refuses when BOTH objects norm away". Guarding
        // this comparison on the target's key being non-null reads as tidier and
        // inverts exactly that: the pair falls through to a supersede, and the
        // module stamps where it used to refuse. Supersession has no inverse verb
        // anywhere in the product, so the tidier spelling is the unrecoverable
        // one.
        //
        // ⚠️ EITHER READING REFUSES. THE ARMS ARE A UNION, NOT A PRECEDENCE.
        //
        // This guard is a REFUSAL, so its two failure directions are not
        // symmetric: refusing wrongly costs a human one retry through
        // `re-authority`/`pin` (the message says so), while permitting wrongly
        // retires a published belief with no inverse verb anywhere in the
        // product. When two readings of "identical" disagree, the recoverable
        // move is to honour both, not to rank them.
        //
        // ⚠️ **Written as a union DELIBERATELY, and the shape is the point.** Two
        // earlier cuts of this slice each REPLACED the comparison — first with
        // the stored key alone, then with `stored ?? derived` — and each closed
        // the reported input class while opening the one next to it, because a
        // replacement moves behaviour in BOTH directions at once. A disjunct
        // added to a refusal can only ever refuse MORE. That makes this edit
        // incapable of the failure mode by construction rather than by argument,
        // and argument is what failed twice here.
        //
        // The two readings, and why neither alone is enough:
        //
        //   - `replacementKey === derivedTargetKey` — *does the replacement
        //     restate the TEXT?* This is `main`'s question verbatim and it is
        //     what the refusal MESSAGE claims. Keeping it unchanged is what
        //     makes this a strict superset of `main`'s refusals. It needs no
        //     null fallback: an unkeyed row derives just as well as a keyed one.
        //   - `replacementKey === target.objectKey` — *will the two rows be
        //     IDENTITY-identical?* This is #5037's question, and it is the one
        //     that catches an alias REMOVAL, where the stored key records a
        //     unification the current vocabulary no longer performs.
        //
        // They come apart in both directions, which is why the union is not
        // redundant. A stored NULL beside a keyable surface (an unkeyed import)
        // defeats the second arm alone. A stored key that DIVERGED from the local
        // derivation — a key carried verbatim from a foreign vocabulary by
        // #5035's import — defeats the first arm alone: object `Alice`, stored
        // `alicia`, a human re-typing `Alice` derives `alice`, and only the
        // first arm sees the restatement.
        //
        // Two nulls still match, on both arms, so the degenerate-surface refusal
        // is unchanged.
        const replacementKey =
          replacement === null ? null : slotKey(replacement.object, vocabulary.object);
        if (
          replacement !== null &&
          (replacementKey === slotKey(target.object, vocabulary.object) ||
            replacementKey === target.objectKey)
        ) {
          throw new CorrectionRefusedError(
            CORRECTION_REFUSAL_REASONS.replacementIdentical,
            `The replacement restates what the fact already says ("${target.object}"), so there is nothing ` +
              "to supersede. To re-assert the claim as human-verified, use `re-authority` or `pin` instead.",
          );
        }
      }

      // Vouch-only target-state check (#4939), same placement and reason as
      // supersede's above. Both vouching verbs claim an OBSERVABLE effect —
      // "resetting its staleness clock" — and both deliver it by writing a
      // provenance edge that `LAST_OBSERVED_AT_SELECT` aggregates. Nothing
      // consults that aggregate for a fact whose validity window has shut:
      // `brainFactCurrentClause` excludes it from `searchBrain` AND from the
      // review queue, and the one surface that still lists it — the tension
      // cluster — carries no decay signal at all. So the verb would report a
      // reset that cannot be seen anywhere; refusing is the honest arm.
      // Reachable rather than theoretical, too: an `asOf` read hands the agent
      // superseded ids, and `correct_fact` documents `factId` as coming
      // "exactly as returned by searchBrain".
      //
      // `windowClosed` — Postgres', not ours — rather than supersede's
      // `IS NOT NULL`: a FUTURE-dated `valid_to` is a live claim whose end is
      // merely scheduled and is still served, so refusing it would block a
      // vouch on a current belief. It is `brainFactCurrentClause` negated and
      // imported, evaluated on the database's own clock, which is what keeps
      // this refusal and the reads it reasons about from drifting apart.
      if ((verb === "re-authority" || verb === "pin") && target.windowClosed) {
        // The window is shut; WHY is not established here. A replacement is
        // the common cause and the only one with a correction-verb remedy, so
        // the message offers it as a possibility rather than a fact — the
        // reason this code is named for what it CHECKS.
        //
        // It deliberately does NOT suggest `supersede` on this fact as the
        // fallback: that verb refuses ANY non-null `valid_to`
        // ({@link validityAlreadyClosed}), so advising it here would send the
        // caller straight into a second refusal. An elapsed window with no
        // successor has no correction path at all — the claim has to be
        // re-observed through ingest — and saying so is better than a remedy
        // that cannot work.
        const closedAt = iso(target.validTo);
        throw new CorrectionRefusedError(
          CORRECTION_REFUSAL_REASONS.targetNotCurrent,
          `This claim's validity window closed${closedAt === null ? "" : ` on ${closedAt}`}, so no current ` +
            "read serves it and confirming it would change nothing you could observe. If another claim " +
            "replaced it, vouch for that one instead — search the same subject and predicate for the current " +
            "belief. If nothing replaced it, the window simply elapsed and there is no correction to apply: " +
            "the claim has to be observed again through ingest before it can be vouched for.",
        );
      }

      // ── The correction episode — the immutable human record ───────────
      const at = now();
      const correctionSourceId = `correction:${verb}:${newCorrectionId()}`;
      const body = JSON.stringify({
        kind: "correction",
        verb,
        factId: target.id,
        claim: { subject: target.subject, predicate: target.predicate, object: target.object },
        ...(verb === "supersede" && replacement !== null
          ? { replacement: { object: replacement.object } }
          : {}),
        ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
        actor,
        at: at.toISOString(),
      });
      const episodeInsert = await tx.query(CORRECTION_EPISODE_INSERT_SQL, [
        ctx.workspaceId,
        correctionSourceId,
        actor,
        body,
        at.toISOString(),
        JSON.stringify(target.grantTokens),
      ]);
      const episodeId = firstId(episodeInsert.rows);
      if (episodeId === null) {
        throw new Error(
          `brain correction: episode insert returned no id (workspace ${ctx.workspaceId}, fact ${target.id})`,
        );
      }

      // ── Verb effects ──────────────────────────────────────────────────
      const base: BrainFactCorrectionResponse = {
        verb,
        factId: target.id,
        correctionEpisodeId: episodeId,
        invalidatedAt: null,
        flaggedForReReview: [],
        supersededBy: null,
        validTo: null,
      };
      switch (verb) {
        case "retract":
          return noSupersededPredicate(
            applyRetract(tx, ctx.workspaceId, target, episodeId, at, base),
          );
        case "supersede":
          // `replacement` is non-null past the pure-validation gate above; the
          // assertion-free re-check keeps that reasoning local.
          if (replacement === null) {
            throw new Error("brain correction: supersede reached dispatch without a replacement");
          }
          // Read into a `const` before the argument list rather than inline: the
          // value is the FIRST argument to `withSupersededPredicate` and
          // `applySupersede(...)` is the second, so inlining puts a derivation
          // and a transaction-mutating call in one expression whose evaluation
          // order a reader has to work out.
          const supersededKey = target.slot.predicate;
          // The canonical predicate travels out with the response, for the
          // post-commit cardinality proposer (#5027). READ off the target row
          // since #5037, not re-derived from its surface: this is the third of
          // the module's three re-derivation sites, and it is the one whose
          // divergence is hardest to see, because the value leaves the
          // transaction. A key derived under a moved vocabulary proposes
          // cardinality for a predicate slot the corrected fact is not in — so
          // the proposal accretes evidence against a slot no correction ever
          // touched, and the slot that WAS corrected accretes none.
          //
          // ⚠️ NON-NULL on every path that reaches the proposer, since #5047.
          // `applySupersede` below hands this same slot to `reconcileFacts`,
          // whose `MALFORMED_CLAIM` guard refuses a candidate with a null slot
          // key — so a null here does not travel out with a committed response,
          // it REFUSES the verb and rolls the transaction back. The target row
          // cannot carry one either: the key columns are `NOT NULL` as of
          // migration 0194.
          //
          // That is why there is no longer a cause to decide here. Until #5047
          // this site classified the null two ways — a predicate SURFACE that
          // normalizes away versus an unkeyed TARGET row — for a post-commit
          // reporter that could not tell them apart from the key alone. Both
          // states are now unrepresentable at a committed supersede; see the
          // note where that reporter used to live.
          return withSupersededPredicate(
            supersededKey,
            applySupersede(tx, ctx.workspaceId, target, episodeId, at, base, {
              replacement,
              sourcePrincipal,
              actor,
              correctionSourceId,
              grantTokens: target.grantTokens,
              vocabulary,
              requestId,
            }),
          );
        case "re-authority":
          return noSupersededPredicate(
            applyVouch(tx, ctx.workspaceId, target, episodeId, at, base, "reAuthority", actor),
          );
        case "pin":
          return noSupersededPredicate(
            applyVouch(tx, ctx.workspaceId, target, episodeId, at, base, "pinned", actor),
          );
        default: {
          const unexpected: never = verb;
          throw new Error(`Unhandled correction verb: ${JSON.stringify(unexpected)}`);
        }
      }
    });
  } catch (err) {
    if (err instanceof CorrectionRefusedError) {
      // The throw already rolled the transaction (and any episode row) back.
      log.info(
        { workspaceId: ctx.workspaceId, factId, verb, reason: err.reason, requestId },
        "brain correction: verb refused",
      );
      return { kind: "refused", reason: err.reason, message: err.message };
    }
    throw err;
  }

  if (outcome === null) {
    log.info(
      { workspaceId: ctx.workspaceId, factId, verb, userId: ctx.userId, requestId },
      "brain correction: verb matched no row — absent, already retracted, or not visible to this actor",
    );
    return { kind: "not-found" };
  }
  const { response: result, supersededPredicate } = outcome;

  log.info(
    {
      workspaceId: ctx.workspaceId,
      factId,
      verb,
      userId: ctx.userId,
      correctionEpisodeId: result.correctionEpisodeId,
      supersededBy: result.supersededBy,
      flaggedForReReview: result.flaggedForReReview.length,
      requestId,
    },
    "brain correction: verb applied — human-authoritative, recorded as an immutable correction episode",
  );
  // Emitted from here, not from either entry point — see the module header.
  await emitCorrectionAudit({
    ctx,
    result,
    requestId,
    timeoutMs: resolveAuditDeadline(deps.auditWriteTimeoutMs),
  });

  // ── ADR-0037 §3(d)2 — the correction-event cardinality proposer (#5027) ──
  //
  // A human superseding a slot has asserted BY THEIR ACTION that it holds one
  // value. That is one of the three declared sources for a `single` cardinality
  // entry, and it is the only one that can be observed from inside the brain.
  //
  // POST-COMMIT, in its own transaction, and for `emitCorrectionAudit`'s reason
  // one paragraph stronger: this reads the `supersedes` edge the verb just
  // wrote, so it needs that edge committed, and a failure must not reach a
  // caller whose error copy says "nothing was changed — retry". Inside the
  // verb's transaction a catch could not deliver that at all — Postgres puts the
  // whole transaction in `25P02` after any statement error, so the correction's
  // own COMMIT would fail with it.
  //
  // It PROPOSES. Nothing is superseded by this write, now or ever: the row
  // lands `pending`, and `cardinalitySingleSql` reads only `approved` ones.
  // Guarded, so the three verbs that are not evidence about cardinality do not
  // pay a pool checkout for a call that returns immediately.
  //
  // The guard used to have a second job — a `supersede` that committed while
  // closing no canonical slot arrived as the same `null`, and hiding it was how
  // that case went unreported. Since #5047 the two are no longer confusable
  // because only one of them exists: a null slot key refuses the verb at the
  // ingest seam, so a committed `supersede` always carries a canonical
  // predicate, and `null` here means *this verb is not evidence about
  // cardinality* and nothing else.
  //
  // BOUNDED, because `internalQuery` bypasses the circuit breaker and the
  // internal pool sets no `statement_timeout`: a DEGRADED internal DB —
  // reachable, not answering — never throws, so an unbounded await here would
  // never settle, `correctFact` would never return, and the caller's own
  // timeout would report *"nothing was changed — retry"* about a correction
  // that IS committed. The retry then mints a SECOND correction episode for one
  // human decision. Same deadline and same knob as the audit write above, so
  // the two post-commit writes cannot drift into having different answers to
  // one hazard.
  if (supersededPredicate === null && verb === "supersede") {
    // ⚠️ UNREACHABLE, and logged anyway — which is the point (#5047).
    //
    // A committed `supersede` cannot carry a null canonical predicate: the
    // replacement inherits the target's slot, `reconcile.ts` refuses a null slot
    // key, and the target row's keys are `NOT NULL` since migration 0194. That
    // argument rests on three facts in three modules, and if any of them moves,
    // the failure is a supersede that silently stops feeding the ADR-0037 §3(d)2
    // cardinality proposer — the subsystem goes quiet with nothing to grep.
    //
    // Deleting `logDegeneratePredicate` removed the arm that used to say so. It
    // was right to delete: it reported two CAUSES that no longer exist and its
    // message described states that cannot occur. What was wrong was leaving no
    // arm at all, so the one state that must never be silent became the only one
    // that was. This says exactly what is known and claims nothing about why.
    log.error(
      { workspaceId: ctx.workspaceId, factId: result.factId, requestId },
      "brain correction: a supersede COMMITTED with no canonical predicate key — this should be impossible since #5047 (the ingest guard refuses a null slot key and `brain_facts` key columns are NOT NULL), so one of those invariants has moved. The correction itself is committed and correct; what is lost is the cardinality proposal for this predicate, silently, for every correction on this slot until it is fixed",
    );
  } else if (supersededPredicate !== null) {
    await proposeUnderDeadline(
      () => withTransaction((tx) => proposeFromCorrectionEvents(tx, ctx.workspaceId, supersededPredicate)),
      resolveAuditDeadline(deps.auditWriteTimeoutMs),
      { workspaceId: ctx.workspaceId, factId: result.factId, requestId },
    );
  }
  return { kind: "corrected", result };
}

/**
 * How long an awaited audit write may hold a committed correction's response
 * open. Same bound and same reason as `auth/middleware.ts` and
 * `admin-knowledge.ts`: `logAdminActionAwait` goes through `internalQuery`,
 * which deliberately bypasses the internal-DB circuit breaker, and the internal
 * pool sets no statement timeout — so without a deadline a DEGRADED internal DB
 * (reachable, not answering) would hang this call indefinitely. An UNREACHABLE
 * one is already bounded by the pool's `connectionTimeoutMillis`.
 *
 * Not yet shared with those two hand-rolled copies on purpose: consolidating
 * would mean editing `auth/middleware.ts`'s fail-closed 500 path, which is a
 * security-surface change that does not belong in a brain-audit fix. One thing
 * for whoever does consolidate: as of #4934 this copy CLEARS its deadline in a
 * `finally` and neither precedent does, so they leave a timer armed for the full
 * bound on every fast path. This is the side to keep.
 */
const AUDIT_WRITE_TIMEOUT_MS = 5_000;

/**
 * `setTimeout`'s 32-bit ceiling. Above it the delay is CLAMPED TO 1ms, with
 * nothing but a `TimeoutOverflowWarning` on stderr — so `Infinity`, the natural
 * spelling of "no deadline for this test", would silently make every audit
 * write time out instantly. That is the same failure the lower bound guards,
 * entered from the other end.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The deadline actually used, normalized here rather than at the read site so
 * the invariant lives beside the constant that expresses it: a POSITIVE, FINITE
 * number of milliseconds that a timer can represent. `??` alone would not do —
 * it only catches nullish, so `0`, a negative, `NaN` and anything past
 * {@link MAX_TIMER_MS} would all pass through and mean "time out immediately".
 */
function resolveAuditDeadline(ms: number | undefined): number {
  if (ms === undefined) return AUDIT_WRITE_TIMEOUT_MS;
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMER_MS) {
    // Named, not silently substituted. A mis-specified seam that quietly became
    // 5s is exactly the kind of silent fallback that turns a wrong test into a
    // five-second mystery.
    log.warn(
      { requested: ms, using: AUDIT_WRITE_TIMEOUT_MS, max: MAX_TIMER_MS },
      "brain correction: auditWriteTimeoutMs is out of range (must be finite, positive, and within the " +
        "32-bit timer ceiling) — falling back to the default audit deadline",
    );
    return AUDIT_WRITE_TIMEOUT_MS;
  }
  return ms;
}

/**
 * The forensic `admin_action_log` row for a correction that already committed.
 *
 * AWAITED, not fire-and-forget, and that is not a contradiction of #4934's
 * "a failed audit write never affects a committed correction" — the two claims
 * are about different things. The correction is never rolled back and this
 * function never throws; what awaiting buys is that a DROPPED row is LOUD.
 * `logAdminAction` posts the insert into the circuit breaker and returns, so
 * an open breaker discards the row with nothing but an internal counter — the
 * shape #4937's fix (#4944) adopted on the adjacent publish path after finding
 * it there, and a silent gap here reproduces the very bug this call site exists
 * to fix. CLAUDE.md: never silently swallow errors; prefer errors over silent
 * fallbacks.
 *
 * Failure is logged at ERROR and the correction still returns `corrected`,
 * because it HAS been corrected: the episode, the tombstone/stamp/marker and
 * the edges are committed, and reporting failure would invite a retry that
 * mints a SECOND correction episode for one human decision.
 *
 * The message names what actually survives, so the line is a usable recovery
 * instruction rather than an alarm — and it names DIFFERENT things depending on
 * how far the emitter got, which is what `writeAttempted` is for. Once
 * `logAdminActionAwait` has been called the actor-attributed `admin_action`
 * pino line exists (it emits BEFORE the insert), so only the queryable row is
 * at risk; a throw while BUILDING the entry never reached the writer, so no
 * pino line exists either and the correction episode in `brain_episodes` is the
 * sole surviving record.
 *
 * NEVER THROWS: the entry construction is inside the `try` rather than just the
 * `await`, so a synchronous throw there is contained instead of landing on an
 * already-committed correction and reaching a caller whose error copy says
 * "nothing was changed — retry". Two residuals, both deliberate: the `lost`
 * payload is assembled before the `try` because the `catch` reads it (it only
 * copies fields that are non-optional on `BrainFactCorrectionResponse`), and the
 * `catch`'s own `log.error` is outside the guarantee — a logger broken badly
 * enough to throw is not a failure mode this module can absorb.
 */
async function emitCorrectionAudit(args: {
  readonly ctx: BrainPrincipalContext;
  readonly result: BrainFactCorrectionResponse;
  readonly requestId: string | undefined;
  readonly timeoutMs: number;
}): Promise<void> {
  const { ctx, result, requestId, timeoutMs } = args;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  /** Distinguishes the write's own rejection from a post-deadline one. */
  let timedOut = false;
  /**
   * Whether `logAdminActionAwait` was ever CALLED. It emits the actor-attributed
   * `admin_action` pino line before its insert, so this is exactly the predicate
   * for "does that line exist" — and the recovery instruction below is a
   * different instruction depending on the answer.
   */
  let writeAttempted = false;
  // Everything an operator needs to reconstruct the row BY HAND, shared by all
  // three lines that can report it lost. The row IS the actor-attributed
  // record, so a line saying it is gone without the actor is not a recovery
  // instruction.
  const lost = {
    workspaceId: ctx.workspaceId,
    actorId: ctx.userId,
    factId: result.factId,
    verb: result.verb,
    correctionEpisodeId: result.correctionEpisodeId,
    requestId,
  } as const;
  try {
    // Retract keeps its dedicated action type so existing audit consumers see
    // one vocabulary for one semantics; the other three verbs share `correct`
    // with the verb in `metadata.verb`. `satisfies` rather than a bare
    // annotation so the literal types survive; `as const` alone would leave a
    // misspelled optional key (`staus`, `ipaddress`) compiling to a silent
    // no-op, because excess-property checking does not apply to a variable.
    //
    // `result.factId` rather than the caller's `factId`: the response carries
    // `f.id::text` as Postgres canonicalized it, while the agent tool accepts
    // the id as a bare `z.string()`, so an LLM echoing a differently-cased uuid
    // would otherwise produce a `target_id` that does not string-join to
    // `brain_facts.id`.
    const entry = {
      actionType:
        result.verb === "retract"
          ? ADMIN_ACTIONS.brainFact.retract
          : ADMIN_ACTIONS.brainFact.correct,
      targetType: "brainFact",
      targetId: result.factId,
      // Key ORDER is load-bearing here, unusually (#4939). The action-log
      // table previews `Object.entries(metadata).slice(0, 3)` in a truncating
      // cell, so a key that lands fourth is invisible on the surface an
      // operator actually opens. `flaggedForReReview` is the one entry NOTHING
      // else renders — no queue lists the flagged facts, and this row is their
      // only durable record — so it rides directly behind `verb`, which is
      // what makes a row readable at all. Everything after is recoverable
      // elsewhere: from the response, the fact row, or the request context.
      metadata: {
        verb: result.verb,
        ...(result.flaggedForReReview.length > 0
          ? { flaggedForReReview: result.flaggedForReReview }
          : {}),
        workspaceId: ctx.workspaceId,
        correctionEpisodeId: result.correctionEpisodeId,
        ...(result.invalidatedAt !== null ? { invalidatedAt: result.invalidatedAt } : {}),
        ...(result.supersededBy !== null ? { supersededBy: result.supersededBy } : {}),
        ...(result.validTo !== null ? { validTo: result.validTo } : {}),
      },
    } as const satisfies AdminActionEntry;

    // The module header claims a future entry point INHERITS the audit trail.
    // It inherits the row; it does not inherit the attribution — `resolveEntry`
    // reads the actor off the AsyncLocalStorage context and falls back to the
    // literal `"unknown"` with no complaint. The test is the ACTOR, not the
    // context: `withRequestContext({ requestId })` with no `user` is the
    // canonical scheduler/background shape, and it resolves to `"unknown"` just
    // as a missing context does. Both entry points today supply a user, so this
    // never fires; a future one that does not would produce a row that exists
    // and lies, which is a worse artifact than the missing row #4934 fixed.
    // The `unauthenticated-local` arm is exempt: that deployment has DECLARED
    // it has no ids to record (see the authority gate at the top of
    // `correctFact`), so `actor 'unknown'` is the correct row there, not a
    // finding. Warning on it would fire on every correction in a
    // correctly-configured deployment, which is how a guard gets deleted.
    if (ctx.origin !== "unauthenticated-local" && getRequestContext()?.user?.id === undefined) {
      log.warn(
        { ...lost },
        "brain correction: no actor in the request context at audit time — the admin_action_log row will " +
          "record actor 'unknown'. A correction entry point must run inside withRequestContext with a user",
      );
    }

    writeAttempted = true;
    const write = logAdminActionAwait(entry);
    // A deadline does not CANCEL the insert, and `Promise.race` discards the
    // losing branch's outcome. Without this continuation the pg error that
    // explains a slow write — `relation ... does not exist`, pool exhaustion —
    // is dropped and the only line an operator ever sees is "timed out".
    void write
      .then(
        () => {
          if (timedOut) {
            log.warn(
              { ...lost },
              "brain correction: admin_action_log write COMPLETED after its deadline — the earlier timeout " +
                "line for this requestId reports the same event; a row is present unless this deployment " +
                "has no internal DB",
            );
          }
        },
        (err: unknown) => {
          if (timedOut) {
            log.error(
              { ...lost, ...pgErrorFields(err), err: err instanceof Error ? err : new Error(String(err)) },
              "brain correction: admin_action_log write FAILED after its deadline — this is the underlying " +
                "cause behind the earlier timeout line for this requestId",
            );
          }
        },
      )
      // This chain is DETACHED — it settles after the response has gone out, so
      // no `try` on the correction path can reach it, and an unhandled rejection
      // is process-fatal by default. A committed correction's bookkeeping must
      // not be able to take down the worker.
      .catch(() => {
        // intentionally ignored: best-effort observability on a detached
        // promise; the only way here is the logger itself throwing.
      });

    await Promise.race([
      write,
      // Cleared in the `finally` — an uncleared 5s timer would hold the event
      // loop open on every correction, which on the agent-tool path is a
      // per-chat-turn cost.
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          timedOut = true;
          reject(new Error(`audit write timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (err: unknown) {
    log.error(
      {
        ...lost,
        writeAttempted,
        ...pgErrorFields(err),
        // The Error OBJECT, matching `auth/middleware.ts`, so pino's
        // `scrubErrSerializer` captures the stack. It rebuilds the error from a
        // whitelist and drops every own property outside it; `code` and
        // `constraint` are on that whitelist as of #4941, so they now ride on
        // the error too — see `pgErrorFields` for why the lift stays anyway.
        err: err instanceof Error ? err : new Error(String(err)),
      },
      // Two structurally different failures share this catch, and they need
      // different instructions. A WRITE failure is a database problem and the
      // `admin_action` pino line already exists (`logAdminActionAwait` emits it
      // BEFORE its insert); it also may still commit, because a deadline does
      // not cancel an insert — so "may not have been committed", since telling
      // an operator the row is gone invites a hand-inserted duplicate. A
      // BUILD failure never called the writer at all, so no pino line exists
      // and no amount of checking the database will help.
      writeAttempted
        ? "brain correction: admin_action_log row may not have been committed — the correction itself IS " +
            "committed. Check admin_action_log for this requestId before re-creating anything; the " +
            "surviving records are the correction episode in brain_episodes and the actor-attributed " +
            "`admin_action` pino line for this requestId"
        : "brain correction: the admin_action_log entry could not even be BUILT — neither a row nor an " +
            "`admin_action` pino line exists for this correction. This is a code or wiring defect, not a " +
            "database one; the only surviving record is the correction episode in brain_episodes",
    );
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

/**
 * A pg rejection's `code` / `constraint`, lifted onto the log payload as its
 * own fields — the difference between "which failure mode was this" being an
 * answer and a guess (`42P01` a missing relation, `53300` pool exhaustion).
 *
 * #4941 added both to `scrubErrSerializer`'s whitelist, so they now survive on
 * the serialized `err` too. This lift is therefore no longer the only copy, and
 * it stays for a reason that copy cannot cover: the `err:` field above is
 * normalized with `err instanceof Error ? err : new Error(String(err))`, which
 * discards a NON-`Error` thrower's own properties before the serializer ever
 * sees them. `pgErrorFields` reads the raw rejection, so on that path it is
 * still the only copy. It also names the fields at the top level under the
 * stable keys this module's test pins.
 *
 * Value policy is `diagnosticValue` — the SAME function the serializer's
 * whitelist uses, not a parallel bound: two doors onto one log line must not
 * enforce two different disclosure rules, and a duplicated constant is how they
 * would drift. `detail` is left off on both: pg echoes row values into it.
 *
 * The read is guarded because `emitCorrectionAudit` is contracted NEVER to
 * throw and this runs inside it, on an already-committed correction. A plain
 * destructure would invoke an accessor; if that accessor threw, the throw would
 * escape `correctFact` — the audit call sits after its try/catch — and reach a
 * caller whose error copy says "nothing was changed, retry", inviting a
 * duplicate brain mutation authored by a logging helper. Hence own non-accessor
 * reads (an accessor descriptor has no `value`, so the getter is never called)
 * plus a `catch` for a Proxy that traps the descriptor lookup itself — the two
 * defenses `errorDiagnostics` uses, for the same reasons.
 */
function pgErrorFields(err: unknown): { pgCode?: string; pgConstraint?: string } {
  if (typeof err !== "object" || err === null) return {};
  try {
    const pgCode = diagnosticValue(Object.getOwnPropertyDescriptor(err, "code")?.value);
    const pgConstraint = diagnosticValue(
      Object.getOwnPropertyDescriptor(err, "constraint")?.value,
    );
    return {
      ...(pgCode !== undefined && { pgCode }),
      ...(pgConstraint !== undefined && { pgConstraint }),
    };
  } catch (err_) {
    // intentionally ignored: a trapping diagnostic property must not turn a
    // best-effort audit log line into a throw out of a never-throw contract.
    void err_;
    return {};
  }
}

// ---------------------------------------------------------------------------
// Per-verb effects
// ---------------------------------------------------------------------------

async function applyRetract(
  tx: ReconcileExecutor,
  workspaceId: string,
  target: TargetRow,
  episodeId: string,
  at: Date,
  base: BrainFactCorrectionResponse,
): Promise<BrainFactCorrectionResponse> {
  const stamped = await tx.query(RETRACT_FACT_SQL, [workspaceId, target.id]);
  const row = stamped.rows[0];
  const invalidatedAt = isJsonObject(row) ? iso(row.invalidated_at) : null;
  if (invalidatedAt === null) {
    // The target was read FOR UPDATE with `invalidated_at IS NULL` in the same
    // transaction, so a non-matching UPDATE is statement drift, not a race —
    // and reporting a retraction that did not stamp would be the silent
    // partial this module must not produce.
    throw new Error(
      `brain correction: retract stamped no row for fact ${target.id} — RETRACT_FACT_SQL drifted from the target read`,
    );
  }

  await tx.query(DERIVES_FROM_EDGE_SQL, [workspaceId, target.id, episodeId]);

  // Flag, never cascade — see the module header.
  const dependents = await tx.query(DEPENDENT_FACTS_SQL, [workspaceId, target.id]);
  const dependentIds = idList(dependents.rows);
  let flagged: readonly string[] = [];
  if (dependentIds.length > 0) {
    const marker = JSON.stringify({
      reReview: {
        reason: "derives-from-retracted",
        retractedFactId: target.id,
        correctionEpisodeId: episodeId,
        flaggedAt: at.toISOString(),
      },
    });
    const flaggedResult = await tx.query(MERGE_PROVENANCE_MARKER_SQL, [
      workspaceId,
      dependentIds,
      marker,
    ]);
    flagged = idList(flaggedResult.rows);
    if (flagged.length < dependentIds.length) {
      // Reachable (a dependent retracted between the SELECT and the marker
      // UPDATE — those need no flag) and also the only trace if the marker
      // statement ever drifts, which would leave dependents permanently
      // unflagged with the retraction reporting success.
      log.warn(
        {
          workspaceId,
          factId: target.id,
          expected: dependentIds.length,
          flagged: flagged.length,
          missing: dependentIds.filter((id) => !flagged.includes(id)),
        },
        "brain correction: some derives-from dependents were not flagged — retracted concurrently, or MERGE_PROVENANCE_MARKER_SQL drifted",
      );
    }
    log.info(
      { workspaceId, factId: target.id, flagged: flagged.length },
      "brain correction: retraction flagged derives-from dependents for re-review — nothing cascaded",
    );
  }

  return { ...base, invalidatedAt, flaggedForReReview: flagged };
}

interface SupersedeInputs {
  readonly replacement: { readonly object: string; readonly validFrom: Date | null };
  readonly sourcePrincipal: string;
  readonly actor: string;
  readonly correctionSourceId: string;
  readonly grantTokens: readonly string[];
  /** The workspace's vocabulary, so the replacement keys the way ingest does. */
  readonly vocabulary: ClaimVocabulary;
  /**
   * The caller's request id, threaded for ONE consumer: the `log.error` beside
   * the 500 this function can throw (#5047).
   *
   * CLAUDE.md's rule is that every 500 carries one for log correlation, and the
   * line is otherwise the single place in this module that drops it — a user
   * reporting "I got a 500, requestId abc" could not be matched to it.
   */
  readonly requestId: string | undefined;
}

async function applySupersede(
  tx: ReconcileExecutor,
  workspaceId: string,
  target: TargetRow,
  episodeId: string,
  at: Date,
  base: BrainFactCorrectionResponse,
  inputs: SupersedeInputs,
): Promise<BrainFactCorrectionResponse> {
  // #4912's stamp FIRST, via the publish gate's own statement — before the
  // replacement reconciles. The ordering is load-bearing: reconcile's tension
  // pass flags every LIVE rival in the same SLOT (`subject_key`,
  // `predicate_key` since #5020) of a new single-cardinality claim, and the
  // target is exactly such a rival until its window closes — and since #5037
  // that holds unconditionally rather than "while the vocabulary has not
  // moved": the replacement inherits the target's STORED slot keys below, so it
  // keys into the target's slot by construction for a KEYED target, and
  // vacuously for an unkeyed one, whose slot is `(NULL, NULL)` and joins nothing
  // either way. (This paragraph used to reason from the inherited SURFACES,
  // which is the premise #5037 refutes — a surface re-derived under a moved
  // vocabulary lands in a DIFFERENT slot.) Stamping first means
  // the belief being retired is already
  // settled history when the pass runs (`TENSION_CANDIDATES_SQL` filters
  // `valid_to IS NULL`), so this verb cannot mint a permanent
  // `in-tension-with` edge recording a conflict the same transaction
  // resolves. Any OTHER live rival still earns its advisory edge, which is
  // correct — the human arbitrated this pair, not the whole field. A failure
  // later in the verb rolls the stamp back with everything else.
  // The inherited slot must be THIS target's (#5037). Trivially true today —
  // `readTargetRow` builds it off the row it narrows, and there is no second row
  // in scope — which is exactly why it is asserted rather than assumed: the
  // docstring on `InheritedSlot.fromFactId` claims the field is what makes a
  // mis-attached slot visible, and a field nothing reads makes nothing visible.
  // A future refactor that constructs the slot anywhere else gets the guarantee
  // the type advertises instead of the one a reader inferred.
  if (target.slot.fromFactId !== target.id) {
    throw new Error(
      `brain correction: the inherited slot was read from fact ${target.slot.fromFactId} but this correction targets ${target.id} — a slot was built outside readTargetRow`,
    );
  }

  const stampResult = await tx.query(SUPERSEDE_STAMP_EXPLICIT_SQL, [workspaceId, [target.id]]);
  const stampedId = firstId(stampResult.rows);
  if (stampedId === null) {
    // The target is row-locked and was pre-checked published/current in this
    // transaction, so an empty RETURNING is drift — and committing would
    // record a supersession that never stamped.
    throw new Error(
      `brain correction: supersede stamped no row for fact ${target.id} — the target checks and SUPERSEDE_STAMP_EXPLICIT_SQL disagree`,
    );
  }

  // The replacement claim enters through the SAME seam every producer does —
  // reconcile is what attaches the provenance edge, the grant, and (if a live
  // rival already asserts the value) the corroboration instead of a duplicate.
  const report = await reconcileFacts(
    {
      episode: {
        id: episodeId,
        workspaceId,
        source: HUMAN_SOURCE,
        sourceId: inputs.correctionSourceId,
        sourceActor: inputs.actor,
        occurredAt: at,
        visibleTo: inputs.grantTokens,
      },
      candidates: [
        {
          subject: target.subject,
          predicate: target.predicate,
          object: inputs.replacement.object,
          // ⚠️ The SLOT is INHERITED, not re-derived (#5037, ADR-0037 §8).
          //
          // The surfaces above still travel — they are what lands in the
          // replacement's SPO columns, and retention is what keeps an alias
          // reversible — but they no longer decide the slot. Passing surfaces
          // alone is what made this module stop carrying identity and start
          // re-deriving it the moment keys were computed at the reconcile seam,
          // and it is the operation ADR-0037 §1 rules out for every producer.
          //
          // The divergence is not hypothetical and the failure is silent: the
          // stamp above is id-based, so it fires whatever the vocabulary says.
          // Under a moved vocabulary — an alias removed, a correction racing the
          // drift rewrite, or a target whose keys #5035's import carried from a
          // FOREIGN vocabulary — a derived key retires the belief and lands its
          // successor in a different slot, unreachable from the slot every
          // future collision joins on. The audit trail says "superseded by X";
          // the slot says empty.
          //
          // The object is NOT inherited: it is new, human-authored text and keys
          // on its own terms. That asymmetry is the design, and `reconcile.ts`
          // enforces it rather than trusting this call site.
          inheritedSlot: target.slot,
          validFrom: inputs.replacement.validFrom ?? at,
          // DERIVED from the verb, not inherited from the row (#5027).
          //
          // This used to read `target.cardinality` — the extractor's LLM guess
          // on the original fact, laundered through a human verb into something
          // that looked authored. So whether a live rival in this slot earned an
          // advisory `in-tension-with` edge depended on what a model had said
          // about a different message.
          //
          // A human superseding a slot has asserted BY THEIR ACTION that it
          // holds one value — that is ADR-0037 §3(d)2's own premise, and the
          // whole basis of the proposer this verb now feeds. Reading it off the
          // verb is the same claim, made from the evidence that actually
          // supports it, and it makes the tension edges DETERMINISTIC where they
          // were a coin flip.
          //
          // Advisory in both directions, and that is why it can be decided here
          // at all: since #5027 this field gates `in-tension-with` edges and
          // nothing else. It reaches no `valid_to` stamp — that needs an
          // APPROVED entry in `brain_predicate_cardinality`, which this verb can
          // only ever PROPOSE.
          predicateCardinality: "single",
        },
      ],
      vocabulary: inputs.vocabulary,
      producer: "correction",
      // An authored claim is not extracted from anything.
      extractedAt: null,
      sourcePrincipal: inputs.sourcePrincipal,
    },
    // Reuse THIS transaction — the default runner would nest a second pool
    // checkout under the held connection, which is the bounded-pool starvation
    // deadlock `withBrainTransaction` documents.
    { withTransaction: (fn) => fn(tx), now: () => at },
  );
  const outcome = report.outcomes[0];
  if (
    outcome?.kind === "blocked" &&
    outcome.reason === RECONCILE_BLOCK_REASONS.malformedClaim &&
    // ⚠️ THE OBJECT POSITION **WITH A DEGENERATE-SURFACE CAUSE**, and the second
    // half of that is not a refinement — it is the whole correctness of this arm.
    //
    // The first cut gated on the POSITION alone, reasoning that the object is
    // the caller's own text where the subject and predicate are copied off the
    // target row (#5037). That reasoning is incomplete, and a review caught it
    // reproducing the very defect it fixes one layer over: `slotKey` is
    // `identityKey(alias(identityKey(surface)))`, so an object key is ALSO null
    // when this workspace's object-position vocabulary maps a real norm to
    // something that normalizes away. A human superseding with perfectly good
    // text, in a workspace with one bad alias entry, was told their replacement
    // "normalizes away to nothing" — fix-your-correct-input, on a request no
    // retry could ever satisfy.
    //
    // So the discriminator is the CAUSE, which `reconcile.ts` already computes
    // at the one place all three inputs are readable. Only `degenerate-surface`
    // is the supplier's fault; `vocabulary-target` and `inherited` are the
    // corpus's or the configuration's and fall through to the 500 below.
    (outcome.unkeyed ?? []).some(
      (slot) => slot.role === "object" && slot.cause === "degenerate-surface",
    )
  ) {
    // ⚠️ THE ONE BLOCK REASON THAT IS REACHABLE FROM A WELL-FORMED REQUEST, and
    // it became reachable with #5047. Every other arm of the seam's gate is
    // about the EPISODE — provenance, grant, principal — and this function just
    // wrote that episode from the target's own row, so those really are
    // unreachable by construction. `MALFORMED_CLAIM` is about the CANDIDATE, and
    // the candidate carries a human's free text: a replacement object of `-` or
    // `___` normalizes away, keys to null at the object position, and the ingest
    // guard refuses it.
    //
    // Raised as a REFUSAL rather than left to the throw below, because the two
    // produce the same rollback and opposite diagnoses. The throw is a 500 whose
    // message says the seam's contract changed underneath this caller — an
    // incident report, aimed at us, about a request that is simply wrong. A
    // refusal is a 400 that tells the human their replacement asserts nothing,
    // which is the true and actionable version of the same event.
    //
    // The SAFETY property either way is the one #5047's acceptance criteria
    // name: `SUPERSEDE_STAMP_EXPLICIT_SQL` already ran at the top of this
    // function, and leaving here — by throw or by refusal — rolls that stamp
    // back with the whole transaction, so the target's `valid_to` is not closed
    // in favour of a successor that was never stored. `correction.test.ts` pins
    // it rather than assuming it.
    throw new CorrectionRefusedError(
      CORRECTION_REFUSAL_REASONS.replacementMalformed,
      `The replacement "${inputs.replacement.object}" has no identity — it normalizes away to nothing, so ` +
        "it would occupy no slot and could never be corroborated, contradicted, or superseded in turn. " +
        "Supersede with the value the claim should now hold; to record that it holds no value, use " +
        "`retract` instead.",
    );
  }
  if (!outcome || outcome.kind === "blocked") {
    // Every EPISODE-level reason is unreachable by construction — the episode was
    // just written with the target's own usable grant and an explicit principal —
    // so those mean the seam's contract changed underneath this caller.
    //
    // `MALFORMED_CLAIM` at a NON-object position also lands here, and it is a
    // different animal: it means the target's inherited slot or this workspace's
    // vocabulary produced no identity, which is a corpus or configuration defect
    // rather than a request defect. A 500 with a `requestId` is the honest shape
    // — the caller can do nothing about it and must not be told to retype their
    // replacement. Logged with the positions so the operator does not have to
    // reconstruct which slot failed from the message.
    log.error(
      {
        workspaceId,
        factId: target.id,
        // The two correlation handles this line is useless without. `requestId`
        // is CLAUDE.md's rule for every 500 — the caller is handed one and every
        // other log line in this module carries it. `episodeId` is what the
        // message below tells the operator to join on: the reconcile warn logs
        // the episode and NOT the fact, so without it the two lines share only
        // `workspaceId`.
        requestId: inputs.requestId,
        episodeId,
        reason: outcome?.kind === "blocked" ? outcome.reason : "no outcome",
        unkeyed: outcome?.kind === "blocked" ? (outcome.unkeyed ?? []) : [],
      },
      "brain correction: reconcile blocked the replacement claim at a position the caller does not control — the correction rolled back whole, including the supersede stamp. A MALFORMED_CLAIM here names the TARGET's inherited slot or this workspace's vocabulary, not the replacement text; see the reconcile warn for the same episode, whose `cause` field says which",
    );
    throw new Error(
      `brain correction: reconcile blocked the replacement claim (${outcome ? outcome.reason : "no outcome"}) — ` +
        "the correction episode should satisfy every episode-level gate by construction",
    );
  }

  // Authoritative immediately: a still-draft replacement is promoted inside
  // this same transaction, screened through the SAME classifier the publish
  // gate runs. A refusal is unreachable for a row this transaction built, and
  // is treated as a hard refusal (rolling everything back) if it happens.
  const rowResult = await tx.query(REPLACEMENT_ROW_SQL, [workspaceId, outcome.factId]);
  const row = rowResult.rows[0];
  if (!isJsonObject(row) || typeof row.id !== "string" || typeof row.status !== "string") {
    throw new Error(
      `brain correction: replacement fact ${outcome.factId} could not be read back — REPLACEMENT_ROW_SQL drifted`,
    );
  }
  if (row.status === "draft") {
    const draftRow: DraftFactRow = {
      id: row.id,
      subject: typeof row.subject === "string" ? row.subject : "?",
      predicate: typeof row.predicate === "string" ? row.predicate : "?",
      object: typeof row.object === "string" ? row.object : "?",
      source_episode_id: typeof row.source_episode_id === "string" ? row.source_episode_id : null,
      provenance: row.provenance,
      visible_to: row.visible_to,
    };
    const refusal = classifyFactForPromotion(draftRow);
    if (refusal) {
      throw new CorrectionRefusedError(
        CORRECTION_REFUSAL_REASONS.replacementUnpublishable,
        `The replacement could not be published: ${refusal.detail}`,
      );
    }
    const promoted = await tx.query(PROMOTE_CORRECTION_FACT_SQL, [workspaceId, row.id]);
    if (firstId(promoted.rows) === null) {
      throw new Error(
        `brain correction: replacement fact ${row.id} was classified promotable but the promote matched no row`,
      );
    }
  } else if (row.status !== "published") {
    // `archived`, or an out-of-vocabulary status: there is no path from here
    // to a current published successor, and silently superseding with a
    // non-served fact would retire the target in favour of nothing.
    throw new CorrectionRefusedError(
      CORRECTION_REFUSAL_REASONS.replacementUnpublishable,
      `A fact already asserts "${target.subject} ${target.predicate} ${inputs.replacement.object}" but is ` +
        `'${row.status}', so it cannot serve as the current belief. Resolve that fact first, then supersede.`,
    );
  }

  // The arbitration record (new → old), via the publish gate's own statement.
  // The stamp already ran — first in the verb, see the top of this function.
  await tx.query(INSERT_SUPERSEDES_EDGES_SQL, [
    workspaceId,
    JSON.stringify([{ newId: outcome.factId, oldId: target.id }]),
  ]);
  await tx.query(DERIVES_FROM_EDGE_SQL, [workspaceId, target.id, episodeId]);

  return {
    ...base,
    supersededBy: outcome.factId,
    validTo: at.toISOString(),
  };
}

/**
 * `re-authority` and `pin` — the two vouching verbs. Identical mechanics
 * (evidence edge + marker), different marker key; the SEMANTICS live in the
 * marker and in the tool/route prose, not in divergent machinery.
 */
async function applyVouch(
  tx: ReconcileExecutor,
  workspaceId: string,
  target: TargetRow,
  episodeId: string,
  at: Date,
  base: BrainFactCorrectionResponse,
  markerKey: "reAuthority" | "pinned",
  actor: string,
): Promise<BrainFactCorrectionResponse> {
  await tx.query(INSERT_PROVENANCE_EDGE_SQL, [workspaceId, target.id, episodeId]);
  const marker = JSON.stringify({
    [markerKey]: { actor, at: at.toISOString(), correctionEpisodeId: episodeId },
  });
  const marked = await tx.query(MERGE_PROVENANCE_MARKER_SQL, [workspaceId, [target.id], marker]);
  if (firstId(marked.rows) === null) {
    throw new Error(
      `brain correction: ${markerKey} marker matched no row for fact ${target.id} — the target read and the marker UPDATE disagree`,
    );
  }
  return base;
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

/**
 * Tier-1 detection, off the stored payload: `reconcile.ts` writes
 * `provenance.source` structurally from the episode's stored source KIND, so
 * a warehouse-derived fact carries `WAREHOUSE_SOURCE` there. Tier-1 proper is
 * never stored in `brain_facts` at all — this guards the DERIVED class the ADR
 * likewise exempts from correction.
 *
 * The vocabulary, not the literal `"warehouse"`, and that is the whole strength
 * of this predicate: the kind comes from a producer ADR-0036 commits to but no
 * milestone has scoped, and while both sides spelled their own string their
 * agreement was a coincidence — a producer naming itself `"snowflake"` would
 * have silently stopped every tier-1 refusal without failing a test. See
 * `lib/brain/sources.ts`.
 *
 * It asks for the CLASS rather than `=== WAREHOUSE_SOURCE` (#4963). The two are
 * the same answer today, because `warehouse` is the warehouse class's only
 * member — but they differ in what a FUTURE member can do to this invariant. A
 * warehouse vendor that needed its own stored value (the same source-id-collision
 * argument that makes the chat class vendor-grained) would, under the old
 * comparison, have escaped tier-1 refusal the moment it was added, and the only
 * thing standing in the way was a paragraph in `sources.ts` asking it not to.
 * Reading the class moves that from prose to the spec map, where declaring the
 * class is how the member gets into the vocabulary at all.
 */
export function isWarehouseDerived(provenance: unknown): boolean {
  return isJsonObject(provenance) && isWarehouseDerivedSource(provenance.source);
}

/**
 * Does this fact's provenance name a source kind outside the vocabulary — one
 * whose CLASS, and therefore whose tier, this region cannot resolve (#4964)?
 *
 * ## The lane this closes
 *
 * `sources.ts`'s {@link isWarehouseDerivedSource} answers `false` for an
 * unrecognised kind. Until #4964 its docstring called that "the correctable
 * (safe) direction"; it now says the opposite, and this predicate is why. Safe
 * is right for a value a producer could only have stamped by passing the
 * vocabulary gate. But the region import is the ONE producer not gated: it
 * restores a bundle's `source` verbatim so a bundle written by a newer
 * vocabulary still imports (`api/routes/admin-migrate.ts`, and
 * `lib/brain/sources.ts`'s header for the argument). Through that lane an
 * imported `"warehouse:prod"`, `"snowflake"` or `"bigquery"` — the three drift
 * shapes `sources.ts` names — is not in the vocabulary, so it is not
 * warehouse-CLASS, so tier-1 refusal never fires and an ADR-0036 §T4 invariant
 * is downgraded with nothing logged at the moment it matters. Safe was the
 * wrong direction for exactly this input.
 *
 * ## Why the refusal is here and not at the import
 *
 * Refusing the BUNDLE was the other candidate and is worse. Migration 0180
 * leaves `brain_episodes.source` plain `text` with no CHECK, so Postgres
 * legally stores any string; the rule `lib/brain/acl.ts`'s header states for
 * GRANTS holds here for the same reason — Atlas code must not be stricter at
 * import than the database is at rest — because the failure mode is a workspace
 * that cannot migrate between regions and it surfaces at cutover. (That header
 * argues it against 0180's grant CHECK specifically; this column has no CHECK
 * at all.) Bundle validation is all-or-nothing (`{ ok: false }` → 400), so one
 * episode from a newer region would strand the whole workspace. Restoring the
 * evidence is not a new arbitration — the same line `RETRACT_FACT_SQL`'s
 * sole-writer scan draws. CORRECTING it is, and that is where a region may
 * decline to act on a kind it cannot classify.
 *
 * So the fact imports, reads, and is searchable; only its correction path is
 * quarantined. That is conservative in the direction §T4 cares about and it is
 * SELF-HEALING: the day this region deploys the vocabulary that knows the
 * kind, the predicate resolves a class and the correct gate — tier-1 refusal
 * or an ordinary correction — takes over with no data migration.
 *
 * ## What the quarantine does NOT cover, deliberately
 *
 * It gates {@link correctFact} and therefore all four verbs — including
 * `retract`, which is the only tombstone path and the GDPR-erasure verb. So an
 * imported unknown-kind fact cannot be ERASED either until the region learns
 * the kind. That is the same posture tier-1 already has (it refuses retract
 * too), and the alternative reopens the hole: if the unknown kind IS
 * warehouse-shaped, allowing retract is exactly the §T4 arbitration being
 * refused. The recovery is a deploy, which is worth knowing before this is
 * relied on to meet an erasure deadline.
 *
 * It does NOT gate PROMOTION. `classifyFactForPromotion` reads
 * `source_episode_id`, `provenance`'s non-emptiness and the grant — never
 * `provenance.source` —
 * so a draft derived from an unknown-kind episode can still be published while
 * being un-rejectable, which is the more permissive action of the two. That is
 * not the §T4 invariant leaking: tier-1 facts are computed live and have no
 * table at all (`lib/brain/acl.ts`), so anything sitting in `brain_facts` is
 * tier-2/3 and publishing it is an ordinary review decision, not an
 * arbitration over the warehouse. Stated rather than fixed because widening the
 * gate to the review queue is a different change from closing a fail-open, and
 * it would strand imported drafts in a queue no reviewer could clear.
 *
 * ## The line: key PRESENT but unresolvable
 *
 * A provenance carrying no `source` key at all stays correctable. That shape
 * predates this lane, nothing structurally guarantees the key (`promotion.ts`'s
 * refusals check `source_episode_id`, not `provenance.source`), and
 * quarantining it would retire the correction path for facts no import ever
 * touched — a regression dressed as a fix.
 *
 * But a key that is PRESENT and does not resolve is quarantined whatever its
 * type, which is deliberately wider than "present and a string". `null`, `42`
 * and `[]` are reachable on exactly the lane this exists to close and on no
 * other: `brain_facts` has two writers, and `reconcile.ts` always spreads
 * `source: episode.source` — a `string` by its own type — AFTER the producer's
 * detail, so it always wins and is always a string. The other writer is the
 * import, whose fact validator requires only that `provenance` be a non-empty
 * object and never inspects `.source` (`api/routes/admin-migrate.ts`). So a
 * bundle carrying `{ "source": null, "producer": "…" }` on a warehouse-derived
 * fact would otherwise defeat tier-1 refusal AND this quarantine both, which is
 * the whole hole restated one type away. Refusing it is not stricter than
 * 0180's `chk_brain_facts_provenance_nonempty` either: that CHECK has no
 * opinion about the interior shape of a `jsonb` column, so nothing legal at
 * rest becomes unimportable.
 *
 * Be honest about the residual, because the carve-out above is the same
 * evasion one key away: DELETING `source` from that bundle passes
 * `validateBundle`, returns `null` here, returns `false` from
 * {@link isWarehouseDerived}, and lands a fully correctable fact. It is
 * accepted anyway — facts predating this lane are the likelier population, and
 * the import route is operator-privileged, so the adversarial reading is weak.
 * The lane is narrowed, not sealed.
 *
 * ## Two conditions, and only one of them heals
 *
 * `resolvable` is the difference, and it is not cosmetic. A STRING outside the
 * vocabulary is version skew: a future release can add it to
 * `EPISODE_SOURCE_SPECS` and the quarantine lifts. A NON-STRING can never be
 * admitted — {@link isEpisodeSource} requires `typeof value === "string"` — so
 * no deploy will ever resolve it, and telling an operator to wait for one is a
 * false promise on a gate that also blocks `retract`, the GDPR-erasure verb.
 * That is the same defect as reporting this refusal as tier-1, so the two get
 * different refusal reasons and different prose. Repairing a malformed one is a
 * provenance fix, not an upgrade.
 *
 * @returns the offending kind and whether a future vocabulary could resolve it,
 * or `null` when there is none. Not a `boolean`, unlike its
 * {@link isWarehouseDerived} sibling: the refusal has to LOG which kind it
 * declined and BRANCH on whether it can heal, and returning both here is what
 * keeps the caller from re-reaching into an `unknown` payload with a cast.
 */
export function unrecognizedSourceKind(
  provenance: unknown,
): { readonly kind: string; readonly resolvable: boolean } | null {
  if (!isJsonObject(provenance)) return null;
  // `hasOwn`, not `"source" in provenance` and not a truthiness check on the
  // value: the absent-key carve-out above is the ONLY exemption, so it is the
  // only thing that may be tested for. An inherited `source` is not this
  // fact's provenance, and `{ source: "" }` is present-and-unresolvable like
  // any other bad value.
  if (!Object.hasOwn(provenance, "source")) return null;
  const { source } = provenance;
  if (isEpisodeSource(source)) return null;
  return { kind: describeSourceValue(source), resolvable: typeof source === "string" };
}

/**
 * Render a rejected `source` for an operator log, without trusting it.
 *
 * A string is itself. Anything else is reported as its TYPE, and neither
 * `String()` nor `JSON.stringify` is used to do better:
 *
 *   * `String()` THROWS on `{"toString": 1, "valueOf": 2}` — `ToPrimitive`
 *     finds both own properties shadowing `Object.prototype` and neither
 *     callable. That object survives `JSON.parse`, and the import's fact
 *     validator only requires a non-empty `provenance` object, so it reaches
 *     here from a bundle. A throw at this point escapes the refusal path
 *     entirely: it unwinds through the rollback as a non-`CorrectionRefusedError`,
 *     the caller gets a generic 500 instead of the designed 409, and the one
 *     log line naming the offending value never emits. Turning a deliberate
 *     refusal into a 500 by formatting its own error message is the failure
 *     this function exists to prevent.
 *   * `JSON.stringify` is total over `JSON.parse` output but renders
 *     `["warehouse"]` as content an operator reads as an in-vocabulary member,
 *     which contradicts the very refusal being logged.
 *
 * The type is the actionable fact anyway: a non-string is not a kind at all,
 * and the log carries `factId`, so the row itself is one query away.
 */
function describeSourceValue(source: unknown): string {
  if (typeof source === "string") return source;
  if (source === null) return "null";
  return `[${typeof source}]`;
}

function normalizeReplacement(
  replacement: CorrectionReplacement | undefined,
): { readonly object: string; readonly validFrom: Date | null } | null {
  if (!replacement) return null;
  const object = replacement.object.trim();
  if (object === "") return null;
  const validFrom = replacement.validFrom ?? null;
  if (validFrom !== null && Number.isNaN(validFrom.getTime())) {
    // Both entry seams validate `validFrom` as ISO-8601 (`.datetime()`), so
    // this backstop is for a future caller constructing the Date directly.
    // Degrading is safe — the nullable slot already means "no stated start",
    // and the verb then records the correction time — but degrading a HUMAN's
    // stated temporal boundary silently is not; the warn is the trace.
    log.warn(
      { object },
      "brain correction: replacement.validFrom is an invalid Date — recording the correction time as the validity start instead",
    );
    return { object, validFrom: null };
  }
  return { object, validFrom };
}

/**
 * Narrow the locked target row, or say precisely why it cannot be narrowed.
 *
 * Returns `null` ONLY when there was no row at all — the genuine
 * absent/retracted/invisible trio the caller reports as not-found. A row that
 * EXISTS but fails narrowing is query drift in `correctionTargetSql`, and it
 * THROWS (→ a 500 with a requestId) rather than masquerading as not-found:
 * every column here is `NOT NULL text` at rest, and the drifted triple would
 * otherwise flow into a `supersede` replacement's own subject and predicate —
 * a published fact asserting `? ?`, the silent partial the module forswears.
 * Same posture, same reason, as the grant-token throw below.
 */
function readTargetRow(row: unknown, workspaceId: string): TargetRow | null {
  if (row === undefined || row === null) return null;
  const drift = (what: string): never => {
    throw new Error(
      `brain correction: the target read returned a row this module cannot narrow (${what}) — correctionTargetSql drifted (workspace ${workspaceId})`,
    );
  };
  if (!isJsonObject(row)) return drift("not an object");
  if (typeof row.id !== "string" || row.id === "") return drift("no usable id");
  if (
    typeof row.subject !== "string" ||
    typeof row.predicate !== "string" ||
    typeof row.object !== "string" ||
    typeof row.status !== "string"
  ) {
    return drift(`non-text SPO/status for fact ${row.id}`);
  }
  const grantTokens = isUnknownArray(row.visible_to)
    ? row.visible_to.filter((t): t is string => typeof t === "string")
    : [];
  if (grantTokens.length === 0) {
    // Unreachable for a row the ACL-gated read served (the actor matched a
    // token), so this is query drift — and seeding an episode with an empty
    // grant would trip the 0180 CHECK mid-transaction with a worse message.
    throw new Error(
      `brain correction: target fact ${row.id} produced no usable grant tokens — the visible_to projection drifted`,
    );
  }
  // The two temporal gates read DIFFERENT columns, and each needs its own
  // drift arm — but they fail in OPPOSITE directions, which is why neither can
  // be left to a default. `windowClosed` absent would arrive as "not closed"
  // and silently re-ADMIT the vouch this refusal exists to refuse; `validTo`
  // absent would arrive as `undefined`, which is `!== null`, and silently
  // REFUSE a legitimate supersession. Either way the module would be answering
  // off a value it cannot read, which is the thing to refuse.
  //
  // `undefined` is the load-bearing case for both: `pg` produces it only when
  // the column was absent from the SELECT, which is drift, not a fact about
  // the row (the same distinction `attribution.ts` draws for
  // `pre_widening_visible_to`).
  if (row.valid_to === undefined) {
    return drift(`valid_to absent from the target projection for fact ${row.id}`);
  }
  if (
    row.valid_to !== null &&
    !(row.valid_to instanceof Date) &&
    typeof row.valid_to !== "string"
  ) {
    return drift(`unreadable valid_to (${typeof row.valid_to}) for fact ${row.id}`);
  }
  const validTo: Date | string | null = row.valid_to;
  // The three identity keys (#5037). `null` is a legal stored value — an unkeyed
  // legacy row — so only `undefined` is drift, which is the same `pg` signal
  // `valid_to` reads above: the column was absent from the SELECT. Defaulting it
  // to `null` instead would hand `InheritedSlot` a `(NULL, NULL)` slot for a row
  // that HAS one, so the replacement would land un-collidable while the id-based
  // stamp retired the target regardless — #5037's exact defect, reintroduced
  // through the narrowing rather than through the derivation.
  //
  // Narrowed through a helper that RETURNS the value rather than a loop that
  // validates it: a loop leaves the three reads unnarrowed afterwards, and
  // recovering them costs three `as string | null` assertions — which is the
  // shape that lets a later edit change the check and keep the assertion.
  // `factId` hoisted out of the closure deliberately: `row.id` was narrowed to
  // `string` above, but TypeScript does not carry a PROPERTY narrowing into an
  // arrow function, so `${row.id}` inside the closure is `unknown` and both
  // messages raise `restrict-template-expressions`. Hoisting keeps the narrowing
  // rather than suppressing the rule.
  const factId: string = row.id;
  const readKey = (column: "subject_key" | "predicate_key" | "object_key"): string | null => {
    const value = row[column];
    if (value === undefined) {
      return drift(`${column} absent from the target projection for fact ${factId}`);
    }
    if (value !== null && typeof value !== "string") {
      return drift(`unreadable ${column} (${typeof value}) for fact ${factId}`);
    }
    return value;
  };
  const slot = inheritSlotFromFactRow({
    id: row.id,
    subject_key: readKey("subject_key"),
    predicate_key: readKey("predicate_key"),
  });
  const objectKey = readKey("object_key");
  if (typeof row.window_closed !== "boolean") {
    // Postgres decides this (see `correctionTargetSql`); an absent or
    // non-boolean value means the projection drifted, and defaulting it either
    // way would silently disable or silently universalize the vouch refusal.
    return drift(`no boolean window_closed for fact ${row.id}`);
  }

  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    slot,
    objectKey,
    status: row.status,
    provenance: row.provenance,
    grantTokens,
    validTo,
    windowClosed: row.window_closed,
  };
}

function rowId(row: unknown): string | null {
  if (!isJsonObject(row)) return null;
  return typeof row.id === "string" && row.id !== "" ? row.id : null;
}

function firstId(rows: readonly unknown[]): string | null {
  return rows.length === 0 ? null : rowId(rows[0]);
}

function idList(rows: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const id = rowId(row);
    if (id !== null) ids.push(id);
  }
  return ids;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}
