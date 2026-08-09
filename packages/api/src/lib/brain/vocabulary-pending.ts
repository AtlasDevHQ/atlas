/**
 * The **Pending** pane — one queue, two evidence models (#5088, ADR-0037 §6 +
 * #5025's two grill checkpoints).
 *
 * ## One queue means one LIST, not one row schema
 *
 * Both halves are machine-fed — `ALIAS_PROPOSAL_SQL` for aliases,
 * `proposeFromCorrectionEvents` for cardinality — and what they are evidence OF
 * is different in kind:
 *
 * |            | Alias                                        | Cardinality                                  |
 * |------------|----------------------------------------------|----------------------------------------------|
 * | Evidence   | **structural** — agreement without a slot     | **behavioral** — repeated human corrections   |
 * | Gate       | `ALIAS_PROPOSAL_REPEAT_THRESHOLD` = **2**     | `CORRECTION_REPEAT_THRESHOLD` = **3**         |
 * | Consequence| moves a population between slots              | arms supersession for every future claim      |
 *
 * So: the LIST, the ordering, the decide verbs and the preview affordance are
 * shared — neither kind gets a bespoke approval path that can drift from the
 * other — and the EVIDENCE rendering is not. There is deliberately no common
 * *"seen N times"* column, because `2` and `3` are not comparable magnitudes and
 * one column at equal visual weight inverts the epistemic ranking the thresholds
 * encode. #5034 chose 2 rather than reusing the correction gate's 3 precisely
 * because *agreement-without-a-slot is positive and typed where a correction
 * event is circumstantial.*
 *
 * ⚠️ **The issue's own shorthand for the two units is wrong, and the surface must
 * not repeat it.** #5088 says *"2 subjects agree"* / *"3 corrections"* — but
 * `CORRECTION_REPEAT_COUNT_SQL` is `COUNT(DISTINCT n.subject_key)`, and its
 * docstring argues that choice at length (*a reviewer editing one slot four times
 * has told us about that slot, not about the predicate*). **Both thresholds are
 * distinct-SUBJECT counts.** Rendering one as *"3 corrections"* would make the
 * two look like different units while they are the same one, which is the
 * comparison the AC set out to prevent, achieved by a false label. So a
 * cardinality entry carries BOTH numbers — {@link CorrectionEvidence.subjects},
 * the gate's own, and {@link CorrectionEvidence.events}, how many supersessions
 * produced it — and the units are spelled as phrases rather than as nouns.
 *
 * ## Evidence is RE-DERIVED, because migration 0190 stores none
 *
 * 0190's header says so outright: *"No evidence columns (which facts generated
 * the proposal). #5034 owns the proposal query and is where the evidence shape
 * gets decided."* And `confidence` cannot stand in for the count —
 * `structuralConfidence` is a saturating map, so inverting it is neither exact
 * nor honest.
 *
 * Re-derivation has the same cost the positional rule has, and it is worth
 * naming: the number moves when the corpus moves. A pair proposed at two
 * agreeing subjects can read three by the time a human looks, or one if a claim
 * was retracted — including BELOW the threshold that raised it. That is correct
 * (the question is *what does the corpus say now*) and it is why the threshold
 * travels with the count rather than being assumed by the renderer.
 *
 * ## Visibility is the SEAM's, imported and never re-spelled
 *
 * `vocabulary-visibility.ts` owns the positional rule (#5087) and this is its
 * second consumer. `oversight.ts`'s anti-drift rule is the reason: *a disclosure
 * that restates a rule drifts from it — import the join the transaction will
 * run.* The alias arm splices {@link visibleNormsSql} as ONE CTE referenced by
 * two `EXISTS` (both sides, one scan, one set), exactly as `loadPositionEdges`
 * does; the cardinality arm takes {@link positionalScopeClause}'s predicate arm,
 * because `brain_predicate_cardinality` is keyed on a canonical predicate and so
 * every row in it is a predicate-position statement.
 *
 * ⚠️ `includeRetracted` is left DEFAULT-OFF here, and that is the correct half of
 * the pair. These are DISPLAY reads: an entry whose claims are all withdrawn
 * describes nothing an approver is looking at. The wider set belongs to the
 * removal GATE, where collapsing "no live claims" into "not visible to you" would
 * make an in-force edge permanently unremovable.
 *
 * ## No key reaches a caller
 *
 * `brain_predicate_cardinality` cannot address a row without naming
 * `predicate_key`, so — `loadCardinalities`' shape — the key stays inside the
 * joins and the projection carries a representative SURFACE. A decide request
 * names that surface and `decidePredicateCardinalityForSurface` derives the key
 * inside the module that owns the column.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { aclVisibilityClause } from "@atlas/api/lib/brain/acl";
import { SLOT_POSITIONS, type SlotPosition } from "@atlas/api/lib/brain/identity";
import { comparableDifferentSql, comparableSameSql } from "@atlas/api/lib/brain/object-cmp";
import type { PredicateCardinality } from "@atlas/api/lib/brain/types";
import type {
  BrainVocabularyAgreementExample,
  BrainVocabularyAliasEvidence,
  BrainVocabularyCorrectionEvidence,
  BrainVocabularyCorrectionExample,
  BrainVocabularyPendingAlias,
  BrainVocabularyPendingCardinality,
  BrainVocabularyPendingDirection,
  BrainVocabularyPendingKind,
} from "@useatlas/types";
import { ALIAS_PROPOSAL_REPEAT_THRESHOLD } from "@atlas/api/lib/brain/alias-proposal";
import { CORRECTION_REPEAT_THRESHOLD } from "@atlas/api/lib/brain/cardinality";
import { HUMAN_SOURCE } from "@atlas/api/lib/brain/sources";
import {
  logFailClosedHole,
  positionalScopeClause,
  visibleNormsSql,
  withheldCount,
  type PositionalDecision,
  type WithheldCount,
} from "@atlas/api/lib/brain/vocabulary-visibility";
import type { Exact } from "@atlas/api/lib/type-utils";

const log = createLogger("brain-vocabulary-pending");

/** The reader this module needs. Satisfied by the internal pool. */
export interface PendingReader {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/**
 * Most entries one page carries, across BOTH kinds.
 *
 * `IN_FORCE_PAGE_MAX`'s POSTURE — half its bound, because a review queue is read
 * row by row and each row here carries evidence — and reported through
 * {@link PendingQueue.truncated} — a silent cap on a review queue reads as
 * *"that is all there is to decide"*, which on this surface is the one sentence
 * that must never be said by accident.
 */
export const PENDING_PAGE_MAX = 100;

/**
 * Most evidence rows one entry samples.
 *
 * Small on purpose: this is *what agreed*, not a corpus browser. An approver
 * needs enough to recognise the pattern, and the COUNT beside it is what carries
 * the magnitude.
 */
export const PENDING_EVIDENCE_SAMPLE_MAX = 5;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * ⚠️ ALIASES of the wire types below, not hand-written twins.
 *
 * `vocabulary-object-radius.ts`'s {@link ObjectRadiusPair} states the rule and
 * the reason it states it: that type WAS a twin, in this same arc, and renaming
 * a field on one spelling would have 500'd a whole pane with nothing but a
 * runtime `z.strictObject` between the two. These five shapes are the same
 * situation — the `/pending` handler's response annotation does NOT close it,
 * because excess-property checking applies to the literal's own keys and not to
 * the value of `entries`.
 *
 * Field-level docs live on the wire declarations in `@useatlas/types`, which is
 * the SSOT; what is recorded here is only what a reader of THIS module needs and
 * the wire cannot say — the producer each number comes from.
 */

/**
 * One live claim pair exhibiting the agreement an alias proposal rests on.
 *
 * `object` is the object BOTH claims assert. They agree about it — that IS the
 * evidence.
 */
export type AgreementExample = BrainVocabularyAgreementExample;

/**
 * What the corpus says about an alias pair, NOW.
 *
 * The `not-applicable` arm exists because the structural producer is
 * PREDICATE-ONLY — {@link ALIAS_PROPOSAL_SQL} holds two claims in one subject
 * slot and compares their `predicate_key`s — so at an entity position the
 * agreement question is not merely unanswered, it is unaskable. `subjects` is
 * that same query's number, re-asked at read time: unscoped and workspace-wide,
 * `/oversight`'s disclosure class (#4825), because an approver has to be able to
 * tell weak evidence from evidence they cannot read.
 *
 * The `unreadable` arm is the same argument one level down, and it is not
 * hypothetical: flat, this shape returned `subjects ?? 0` with
 * `countsConsistent: false`, and the client explained the zero it never read.
 * "0 agree", "unaskable" and "unread" are one number and three opposite facts.
 */
export type AliasEvidence = BrainVocabularyAliasEvidence;

/** One correction a human made at this predicate — the *link* half of the AC. */
export type CorrectionExample = BrainVocabularyCorrectionExample;

/**
 * What a workspace's own correction history says about a predicate.
 *
 * ⚠️ TWO numbers, because the gate's number is not the one the AC's shorthand
 * names. See the module header: `CORRECTION_REPEAT_COUNT_SQL` counts DISTINCT
 * SUBJECTS, so `subjects` is what crossed the threshold and `events` is how many
 * supersessions produced it. A surface rendering only the second would show a
 * number no gate reads; rendering only the first would leave *"and links to
 * them"* with nothing to link.
 */
export type CorrectionEvidence = BrainVocabularyCorrectionEvidence;

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** The two kinds in the one queue. */
export const PENDING_ENTRY_KINDS = [
  "alias",
  "cardinality",
] as const satisfies readonly BrainVocabularyPendingKind[];
export type PendingEntryKind = (typeof PENDING_ENTRY_KINDS)[number];

/** The direction a producer claimed, when it could claim one. An ALIAS — see above. */
export type PendingDirection = BrainVocabularyPendingDirection;

/** One pending alias proposal. */
export interface PendingAliasEntry {
  readonly kind: "alias";
  readonly id: string;
  readonly position: SlotPosition;
  /**
   * The pair, in the order the row stores it.
   *
   * ⚠️ NOT a direction. For an undirected proposal this is *"the pair in the
   * order it arrived"* (0190's own words), and treating the stored order as a
   * default is the *"implicit first norm wins"* the approval seam refuses.
   * {@link direction} is the only field that ever asserts one.
   */
  readonly pair: readonly [string, string];
  /**
   * The producer's direction, or `null`.
   *
   * ⚠️ `null` is the COMMON case, not an edge case. #5034 reads a positive
   * `WAREHOUSE_SOURCES` allowlist and never the negation of the tier guard, so
   * unclassifiable, neither-warehouse **and both**-warehouse all yield
   * undirected — and on a workspace with no warehouse producer, which is every
   * workspace until #5042, EVERY proposal is undirected.
   *
   * A surface must not prefill from it or from anything else. A default would
   * launder a deliberate abstention into a machine opinion, which is the shape
   * the positive allowlist exists to prevent.
   */
  readonly direction: PendingDirection | null;
  readonly sourceClass: string;
  readonly proposedBy: string;
  readonly proposedAt: string;
  /**
   * The producer's rank — `structuralConfidence` plus any extractor-hint bonus.
   *
   * ⚠️ **A RANK, not a probability.** Nothing calibrated it and `0.75` does not
   * mean three-in-four; its only job is to order a queue. Surfaced because it is
   * the one input that can tell two equally-repeated pairs apart, and because
   * the hint is otherwise invisible — it is never stored as a hint, only as its
   * effect on this number.
   */
  readonly rank: number;
  readonly evidence: AliasEvidence;
}

/** One pending cardinality proposal. */
export interface PendingCardinalityEntry {
  readonly kind: "cardinality";
  /**
   * A representative live surface for the canonical predicate — and the ADDRESS
   * a decide request uses.
   *
   * ⚠️ NOT the predicate key (`keys-not-on-the-wire.test.ts`, ADR-0037 §6).
   * `null` when every claim that produced the key has since been retracted,
   * which is a real state and is reported rather than filtered: an entry
   * proposing to arm supersession for a predicate with no live claims is exactly
   * what an approver should be able to find and reject. Such a row is
   * **undecidable from this surface** — there is no surface to name it by.
   *
   * ⚠️ There is deliberately no `decidable` boolean beside this. There was, and
   * it was fully derived from `predicateSurface !== null` — so the pair admitted
   * `{ predicateSurface: null, decidable: true }`, which renders exactly the
   * Approve button that 400s: the state the flag existed to prevent, made
   * spellable by the flag.
   */
  readonly predicateSurface: string | null;
  readonly cardinality: PredicateCardinality;
  readonly sourceClass: string;
  readonly proposedBy: string;
  readonly proposedAt: string;
  /** Live claims currently in this slot. */
  readonly claims: number;
  readonly evidence: CorrectionEvidence;
}

export type PendingEntry = PendingAliasEntry | PendingCardinalityEntry;

/**
 * ⚠️ Compile-time lock to the wire entries.
 *
 * These two are PINNED rather than aliased, unlike the five shapes above,
 * because they are the two that legitimately differ in spelling: `position` is
 * this package's {@link SlotPosition} and `cardinality` is its
 * {@link PredicateCardinality}. Aliasing would drag the wire unions into every
 * engine-side consumer to buy a guarantee the pin gives for free.
 *
 * ⚠️ An earlier version of this sentence claimed both unions were "already
 * bidirectionally pinned in the module that owns it". Only `SlotPosition` is
 * (`identity.ts`, a `satisfies` plus an `Exclude` pin); `PredicateCardinality`
 * is pinned NOWHERE ELSE. There is no functional gap — the `Exact` below
 * compares both unions bidirectionally itself, which is the whole point — but a
 * reader trusting that sentence would go looking for a guard that does not
 * exist, and might delete this one believing it redundant.
 *
 * BIDIRECTIONAL, for `_ObjectRadiusSidesMatchTheWire`'s reason: a field added
 * here is one no client can read and that `z.strictObject` rejects on the way
 * out; a field added to the wire is one the engine never populates and the
 * schema then demands. The `/pending` response annotation catches neither — it
 * checks the response literal's own keys, not the value of `entries`.
 */
const _pendingAliasMatchesTheWire: Exact<PendingAliasEntry, BrainVocabularyPendingAlias> = true;
void _pendingAliasMatchesTheWire;
const _pendingCardinalityMatchesTheWire: Exact<
  PendingCardinalityEntry,
  BrainVocabularyPendingCardinality
> = true;
void _pendingCardinalityMatchesTheWire;

/** One position's disclosure accounting — `InForcePositionCounts`' shape. */
export interface PendingPositionCounts extends WithheldCount {
  readonly position: SlotPosition;
  readonly decision: PositionalDecision;
}

export interface PendingQueue {
  /** Both kinds, ONE list, newest first. */
  readonly entries: readonly PendingEntry[];
  /** Per position, for the alias half. */
  readonly aliasCounts: readonly PendingPositionCounts[];
  /**
   * The same accounting for pending cardinality proposals — `null` when this
   * queue never asked the cardinality question.
   *
   * ⚠️ TWO causes, and a reader of only the first will misread the second. The
   * caller filtered the kind out, **or** filtered to an ENTITY position, where a
   * cardinality entry cannot exist: it is a predicate-position statement, so the
   * query is skipped rather than run-and-empty. Both are "never asked"; neither
   * is "asked and withheld", and a client that renders `null` as an ACL
   * boundary reports a by-construction exclusion as something a grant is hiding.
   *
   * ⚠️ Nullable rather than zeroed, and it is the same rule `totalKnown` states
   * one type down: a question that was never asked has no answer, and rendering
   * it as `0 of 0 · consistent` is a fabricated zero asserted as a fact.
   */
  readonly cardinalityCounts: PendingPositionCounts | null;
  /**
   * A list was CAPPED at {@link PENDING_PAGE_MAX}. The remedy is to filter.
   */
  readonly truncated: boolean;
  /**
   * Rows were DROPPED because they would not narrow. The remedy is not filtering
   * — no filter reaches them — it is a server-side fix.
   *
   * ⚠️ Its own field, and the conflation it replaces was a confidently wrong
   * instruction. One boolean carried both facts, and the client stated one
   * remedy for both: *"Filter to reach them — their absence does not mean they
   * were decided."* For a dropped row that is false, and it sends an approver
   * hunting through filters for a proposal no query will return.
   * `BrainFactWillWiden` splits exactly this into `truncated` vs `incomplete`
   * and argues the case.
   */
  readonly incomplete: boolean;
}

export interface PendingQueueOptions {
  readonly requestId?: string;
  /** Show one kind only. Absent means both — the queue's whole point. */
  readonly kind?: PendingEntryKind;
  /** Alias rows at one position only. Cardinality rows are always predicate. */
  readonly position?: SlotPosition;
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * Everything awaiting a decision, under the positional rule.
 *
 * ## ⚠️ `status = 'pending'`, and that is what excludes direct authoring
 *
 * ADR-0037 §6 makes direct human authoring write THROUGH the proposal table — a
 * `human`-sourced row decided `approved` in the SAME transaction — so the row
 * exists and was never outstanding work. The status filter is what keeps it out
 * of this list, and the AC states it as its own requirement because the obvious
 * alternative reads identically until you look: filtering on
 * `reviewed_at IS NULL` would ALSO exclude it today, and would start including
 * `applying` rows the moment ADR-0037 §7's re-key gets its own transaction
 * (0190's header says exactly when that becomes observable). A decision in
 * flight rendered as outstanding work is how two approvers apply one proposal.
 */
export async function loadPendingQueue(
  db: PendingReader,
  ctx: BrainPrincipalContext,
  opts: PendingQueueOptions = {},
): Promise<PendingQueue> {
  const workspaceId = ctx.workspaceId;
  const limit = clampLimit(opts.limit);
  const wantAlias = opts.kind === undefined || opts.kind === "alias";
  const wantCardinality =
    (opts.kind === undefined || opts.kind === "cardinality") &&
    // A cardinality entry is a predicate-position statement, so a queue filtered
    // to an entity position has none by construction. Skipped rather than
    // queried-and-empty, so the counts below report `deny-all`-free zeros for a
    // question that was never asked.
    (opts.position === undefined || opts.position === "predicate");

  const positions = opts.position === undefined ? SLOT_POSITIONS : [opts.position];

  const [aliasResults, cardinalityResult] = await Promise.all([
    wantAlias
      ? Promise.all(positions.map((p) => loadAliasProposals(db, ctx, p, limit, opts)))
      : Promise.resolve([]),
    wantCardinality ? loadCardinalityProposals(db, ctx, limit, opts) : Promise.resolve(null),
  ]);

  const entries: PendingEntry[] = [];
  const aliasCounts: PendingPositionCounts[] = [];
  let truncated = false;
  let incomplete = false;

  for (const result of aliasResults) {
    entries.push(...result.entries);
    truncated = truncated || result.truncated;
    incomplete = incomplete || result.incomplete;
    const arithmetic = withheldCount(result.total, result.scopedTotal);
    const counts: WithheldCount = {
      ...arithmetic,
      // `loadInForceVocabulary`'s rule: `withheldCount` can only see whether the
      // two numbers disagree, never that one of them was never read. A withheld
      // count computed from a stand-in is a number with no meaning, and calling
      // it consistent is the "nothing is hidden from you" the accounting refuses.
      consistent: arithmetic.consistent && result.totalKnown && result.scopedTotalKnown,
    };
    aliasCounts.push({ position: result.position, decision: result.decision, ...counts });
    logFailClosedHole({
      workspaceId,
      position: result.position,
      counts,
      decision: result.decision,
      aclDecision: result.aclDecision,
      userId: ctx.userId,
      requestId: opts.requestId,
    });
  }

  // ⚠️ `null` when the cardinality half was FILTERED OUT, and that is not a
  // zero. This module invented `totalKnown` precisely to separate *"there are
  // none"* from *"the count was not read"*, and the earlier spelling —
  // `?? true` — defaulted the not-read case to KNOWN, so a queue filtered to
  // `kind=alias` shipped `{ total: 0, scoped: 0, withheld: 0, countsConsistent:
  // true }` for a question nobody asked. The client rendered that as
  // "curated predicates · 0 of 0" with a clean scope badge, on the surface whose
  // whole purpose is what is awaiting a decision.
  //
  // ⚠️ The alias half signals the same fact DIFFERENTLY — `aliasCounts: []` —
  // and an earlier version of this comment called the two equivalent. They are
  // not, to a consumer: `[]` is unambiguous only because `positions` is never
  // empty, which is a runtime invariant nothing in the type states, and a client
  // reading `null` for one half and `[]` for the other has to know that to get
  // the empty state right. It did not, and printed the flat sentence for a queue
  // filtered to `kind=cardinality`. Making the encodings symmetric is a wire
  // change and is deliberately NOT made here; `emptyStateQualifier` reads both
  // spellings instead, and says so.
  const cardinalityCounts: PendingPositionCounts | null =
    cardinalityResult === null
      ? null
      : (() => {
          const arithmetic = withheldCount(
            cardinalityResult.total,
            cardinalityResult.scopedTotal,
          );
          return {
            position: "predicate" as const,
            decision: cardinalityResult.decision,
            ...arithmetic,
            consistent:
              arithmetic.consistent &&
              cardinalityResult.totalKnown &&
              cardinalityResult.scopedTotalKnown,
          };
        })();
  if (cardinalityResult !== null && cardinalityCounts !== null) {
    entries.push(...cardinalityResult.entries);
    truncated = truncated || cardinalityResult.truncated;
    incomplete = incomplete || cardinalityResult.incomplete;
    logFailClosedHole({
      workspaceId,
      position: "predicate",
      counts: cardinalityCounts,
      decision: cardinalityResult.decision,
      aclDecision: null,
      userId: ctx.userId,
      requestId: opts.requestId,
    });
  }

  // ONE list. The two kinds are interleaved by age rather than stacked, because
  // the AC's *shared: the list and the ordering* is what makes muscle memory
  // transfer — and because a cardinality flip queued yesterday is more urgent
  // than an alias queued last month regardless of which producer raised it.
  //
  // Sorted IN PLACE rather than with `toSorted`: the array is local and freshly
  // built here, so mutating it mutates nothing a caller holds.
  entries.sort((a, b) => (a.proposedAt < b.proposedAt ? 1 : a.proposedAt > b.proposedAt ? -1 : 0));
  if (entries.length > limit) {
    truncated = true;
    entries.length = limit;
  }

  return { entries, aliasCounts, cardinalityCounts, truncated, incomplete };
}

function clampLimit(requested: number | undefined): number {
  if (requested === undefined) return PENDING_PAGE_MAX;
  return Math.min(Math.max(1, Math.trunc(requested)), PENDING_PAGE_MAX);
}

// ---------------------------------------------------------------------------
// The alias half
// ---------------------------------------------------------------------------

interface AliasPage {
  readonly position: SlotPosition;
  readonly entries: readonly PendingAliasEntry[];
  readonly total: number;
  readonly totalKnown: boolean;
  readonly scopedTotal: number;
  readonly scopedTotalKnown: boolean;
  /** The page was capped. */
  readonly truncated: boolean;
  /** Rows were dropped because they would not narrow. See {@link PendingQueue.incomplete}. */
  readonly incomplete: boolean;
  readonly decision: PositionalDecision;
  readonly aclDecision: ReturnType<typeof positionalScopeClause>["aclDecision"];
}

/**
 * One position's visible pending alias proposals, with their evidence.
 *
 * The both-sides test applies {@link visibleNormsSql}'s set from a SINGLE
 * builder call, spliced as one CTE and referenced by two `EXISTS` —
 * `loadPositionEdges`' shape, for its reasons: one scan, the same set on both
 * sides, and one place for the rule to be edited.
 *
 * ## Evidence rides along rather than looping
 *
 * A `LEFT JOIN LATERAL` per row rather than a query per entry. N+1 over a
 * hundred-row queue is a hundred round trips, and — the reason that actually
 * matters — the counts and the list would then come from a hundred different
 * snapshots, so a pair could be listed with evidence that never coexisted with
 * it. `loadCardinalities` reaches for the same shape one module over.
 */
async function loadAliasProposals(
  db: PendingReader,
  ctx: BrainPrincipalContext,
  position: SlotPosition,
  limit: number,
  opts: PendingQueueOptions,
): Promise<AliasPage> {
  const visible = visibleNormsSql(position, ctx, {
    paramIndex: 1,
    alias: "vf",
    requestId: opts.requestId,
  });

  const total = await loadPendingAliasTotal(db, ctx.workspaceId, position, opts.requestId);

  if (visible.decision === "deny-all") {
    return {
      position,
      entries: [],
      total: total.n,
      totalKnown: total.known,
      // A denied reader genuinely sees zero — an answer, not a drift.
      scopedTotal: 0,
      scopedTotalKnown: true,
      truncated: false,
      incomplete: false,
      decision: visible.decision,
      aclDecision: visible.aclDecision,
    };
  }

  const wsParam = visible.nextParamIndex;
  const posParam = wsParam + 1;
  const limitParam = wsParam + 2;

  // ⚠️ The evidence clauses are built ONLY where the lateral is emitted, and
  // their params are appended on the same condition.
  //
  // Built unconditionally, the entity positions pushed the reader's ACL binds
  // onto a statement that never references them — `bind message supplies 10
  // parameters, but prepared statement requires 5`. That is the loud failure;
  // the quiet one is what it would have become if the arity had happened to
  // line up, which is a slot key compared against an ACL principal token,
  // joining nothing. `assertPlaceholdersBelowAclBase` guards that shape one
  // module over precisely because it is silent and under-discloses.
  const evidence =
    position === "predicate" ? buildEvidenceClauses(ctx, limitParam + 1, opts.requestId) : null;

  const params: unknown[] = [
    ...visible.params,
    ctx.workspaceId,
    position,
    limit + 1,
    ...(evidence?.params ?? []),
  ];

  const { rows } = await db.query(
    `WITH visible_norms AS ${visible.sql},
     pending AS (
       SELECT p.id,
              p.from_norm,
              p.to_norm,
              p.directed,
              p.source_class,
              p.confidence,
              p.proposed_by,
              p.proposed_at::text AS proposed_at,
              COUNT(*) OVER ()::int AS scoped_total
         FROM brain_vocabulary_proposal p
        WHERE p.workspace_id = $${wsParam}
          AND p.slot_position = $${posParam}
          AND p.status = 'pending'
          AND EXISTS (SELECT 1 FROM visible_norms v WHERE v.norm = p.from_norm)
          AND EXISTS (SELECT 1 FROM visible_norms v WHERE v.norm = p.to_norm)
        ORDER BY p.proposed_at DESC, p.id
        LIMIT $${limitParam}
     )
     SELECT p.*,
            ${evidence === null ? "NULL::int AS subjects" : "ev.subjects"},
            ${evidence === null ? "NULL::int AS scoped_subjects" : "ev.scoped_subjects"},
            ${evidence === null ? "NULL::jsonb AS examples" : "ev.examples"}
       FROM pending p${evidence === null ? "" : aliasEvidenceLateral(wsParam, evidence)}
      ORDER BY p.proposed_at DESC, p.id`,
    params,
  );

  const entries: PendingAliasEntry[] = [];
  // ⚠️ Counted PER COLUMN, not as one total. Several arms drop a row here, and
  // the single aggregate said only "3 rows would not narrow" — from which an
  // operator cannot tell an `::int` cast regression from an enum drift from a
  // renamed column, which is the whole reason the line exists.
  const dropped: Record<string, number> = {};
  const drop = (column: string): void => {
    dropped[column] = (dropped[column] ?? 0) + 1;
    unreadable += 1;
  };
  let unreadable = 0;
  let scopedTotal: number | null = null;
  let evidenceDrifted = false;

  for (const raw of rows.slice(0, limit)) {
    if (typeof raw !== "object" || raw === null) {
      drop("row");
      continue;
    }
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.from_norm !== "string" ||
      typeof row.to_norm !== "string" ||
      typeof row.directed !== "boolean" ||
      // ⚠️ `proposed_at` is DROPPED rather than defaulted to `""`. The queue is
      // ordered by it and the empty string sorts to the end of a text ordering,
      // so a defaulted row would silently take the oldest slot in the merged
      // list — `loadPositionEdges`' rule, with an ordering consequence on top of
      // the un-parseable date.
      typeof row.proposed_at !== "string" ||
      row.proposed_at === ""
    ) {
      drop("identity/proposed_at");
      continue;
    }
    // ⚠️ PROVENANCE is dropped like every other unnarrowable column, and it was
    // the `claims` defect one field over: `: ""` for both. Neither column is
    // nullable (0190 declares them `NOT NULL`, and `source_class` carries a
    // CHECK), so `""` is unreachable from Postgres and means the query drifted —
    // yet the pane renders it as the positive fact *"Raised by an unnamed
    // producer (unrecorded source)"*. That is the fabricated-zero shape wearing
    // a string's clothes, and it is MORE load-bearing here than a count: at an
    // entity position the evidence block has no structural answer to give and
    // tells the approver in as many words to judge the proposal on where it came
    // from. This is that.
    if (!readableProvenance(row, ctx.workspaceId, opts.requestId)) {
      drop("provenance");
      continue;
    }
    if (typeof row.scoped_total === "number") scopedTotal = row.scoped_total;

    const evidence = readAliasEvidence(position, row, ctx.workspaceId, opts.requestId);
    if (evidence.kind === "unreadable") evidenceDrifted = true;
    else if (evidence.kind === "structural" && !evidence.countsConsistent) evidenceDrifted = true;

    entries.push({
      kind: "alias",
      id: row.id,
      position,
      pair: [row.from_norm, row.to_norm],
      // ⚠️ The ONLY place a direction is asserted, and only when the producer
      // claimed one. An undirected row carries `null` all the way to the client,
      // which is what makes "never prefilled" a property of the data rather than
      // a discipline in the renderer.
      direction: row.directed ? { fromNorm: row.from_norm, toNorm: row.to_norm } : null,
      sourceClass: row.source_class,
      proposedBy: row.proposed_by,
      proposedAt: row.proposed_at,
      // 0 on drift, with the drift LOGGED — see `readRank`. That is a
      // deliberate departure from `ProposalRow.confidence`'s rule (an unreadable
      // rank must fail every comparison rather than clear one), and it is safe
      // only because this value orders and renders and never decides: the
      // decision path re-reads the column itself, and NaN would 500 the pane.
      rank: readRank(row.confidence, row.id, ctx.workspaceId, opts.requestId),
      evidence,
    });
  }

  if (unreadable > 0) {
    log.warn(
      { workspaceId: ctx.workspaceId, position, unreadable, dropped, requestId: opts.requestId },
      "brain vocabulary pending: alias proposal rows would not narrow and were dropped — the queue shows fewer entries than are awaiting a decision",
    );
  }
  if (scopedTotal === null && rows.length > 0) {
    log.warn(
      { workspaceId: ctx.workspaceId, position, rows: rows.length, requestId: opts.requestId },
      "brain vocabulary pending: the scoped-total window value did not arrive — the withheld count for this position cannot be trusted and is reported inconsistent",
    );
  }

  return {
    position,
    entries,
    total: total.n,
    totalKnown: total.known,
    scopedTotal: scopedTotal ?? entries.length,
    scopedTotalKnown: (scopedTotal !== null || rows.length === 0) && !evidenceDrifted,
    truncated: rows.length > limit,
    incomplete: unreadable > 0,
    decision: visible.decision,
    aclDecision: visible.aclDecision,
  };
}

/**
 * The reader's two visibility clauses for an evidence sample, plus the bind
 * cursor after them.
 *
 * ONE builder for both halves of the queue: the alias sample gates on the two
 * AGREEING claims, the correction sample on the replacement and the claim it
 * retired, and in both cases the rule is `willSupersedePairsSql`'s — *"something
 * you cannot see agrees with X"* discloses half a claim's history to a reader
 * the grant excluded from the other half. Two copies of the arithmetic is how
 * one of them ends up gating a sample on one side.
 */
interface EvidenceClauses {
  readonly leftAcl: string;
  readonly rightAcl: string;
  readonly params: readonly unknown[];
  readonly sampleParam: number;
  /** First placeholder a caller may use AFTER the sample bound. */
  readonly nextParamIndex: number;
}

function buildEvidenceClauses(
  ctx: BrainPrincipalContext,
  paramIndex: number,
  requestId: string | undefined,
  leftAlias = "ea",
  rightAlias = "eb",
  extraParams: readonly unknown[] = [],
): EvidenceClauses {
  const left = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: leftAlias,
    paramIndex,
    requestId,
  });
  const right = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: rightAlias,
    paramIndex: left.nextParamIndex,
    requestId,
  });
  // Anything the statement binds BETWEEN the reader's clauses and the sample
  // bound — the correction half's episode-source filter. Passed in rather than
  // appended by the caller so the cursor arithmetic stays in one place.
  const sampleParam = right.nextParamIndex + extraParams.length;
  return {
    leftAcl: left.sql,
    rightAcl: right.sql,
    params: [...left.params, ...right.params, ...extraParams, PENDING_EVIDENCE_SAMPLE_MAX],
    sampleParam,
    nextParamIndex: sampleParam + 1,
  };
}

/**
 * The structural agreement behind one predicate pair, re-asked.
 *
 * `ALIAS_PROPOSAL_SQL`'s three arms, scoped to this pair: same subject slot,
 * `comparableSameSql` on the objects, and the two predicate keys are the pair's
 * two norms. The `>` orientation is dropped because the pair is already ordered
 * by the row rather than by the self-join.
 *
 * ⚠️ `comparableSameSql` and NOT a hand-written `=`, so this disclosure and the
 * producer cannot drift into disagreeing about what *provably the same object*
 * means. Its stated residual is inherited: two byte-identical MALFORMED values
 * compare equal, and it lands softer here than anywhere — a wrong evidence row
 * costs an approver a look, not a merge.
 *
 * ⚠️ `a.object_cmp IS NOT NULL` is carried across too, and it is the arm that
 * makes the day-one behaviour legible rather than mysterious: `object_cmp` is
 * never backfilled, so on a workspace with no comparable objects every entry
 * honestly reads zero agreeing subjects.
 *
 * Two counts: the workspace-wide one (content-free) and the reader-scoped one,
 * so `withheld` means something. The SAMPLE is gated on both claims —
 * `willSupersedePairsSql`'s both-sides rule, unchanged.
 */
function aliasEvidenceLateral(wsParam: number, evidence: EvidenceClauses): string {
  const { leftAcl: aclA, rightAcl: aclB, sampleParam } = evidence;
  return `
       LEFT JOIN LATERAL (
         ${aggregateEvidenceSql(
           // ⚠️ `GROUP BY ea.subject_key` rather than `DISTINCT ON`, and the
           // difference is a GUARD rather than taste.
           // `keys-not-on-the-wire.test.ts` reads the span between `SELECT` and
           // `FROM` — so a `DISTINCT ON (ea.subject_key)` sits in projection
           // position and trips it, even though nothing is projected. The guard
           // is deliberately over-broad there (a missed key is the
           // unrecoverable direction), and it caught the first cut of this
           // statement. Grouping puts the key in the `GROUP BY`, which the scan
           // correctly treats as a join detail, and the aggregate still yields
           // exactly one row per subject.
           `SELECT min(ea.ingested_at) AS ingested_at,
                     bool_or(${aclA} AND ${aclB}) AS readable,
                     (array_agg(
                        jsonb_build_object(
                          'subject', ea.subject,
                          'object', ea.object,
                          'fromPredicate', ea.predicate,
                          'toPredicate', eb.predicate)
                        ORDER BY ea.ingested_at)
                      FILTER (WHERE ${aclA} AND ${aclB}))[1] AS example
                FROM brain_facts ea
                JOIN brain_facts eb
                  ON eb.workspace_id = ea.workspace_id
                 AND eb.subject_key = ea.subject_key
                 AND ${comparableSameSql("eb.object_cmp", "ea.object_cmp")}
                 AND eb.predicate_key = p.to_norm
                 AND eb.invalidated_at IS NULL
                 AND eb.valid_to IS NULL
               WHERE ea.workspace_id = $${wsParam}
                 AND ea.predicate_key = p.from_norm
                 AND ea.object_cmp IS NOT NULL
                 AND ea.invalidated_at IS NULL
                 AND ea.valid_to IS NULL
               GROUP BY ea.subject_key`,
           sampleParam,
           "",
         )}
       ) ev ON TRUE`;
}

/**
 * The shape BOTH evidence models share: count the rows, count the readable ones,
 * and carry a BOUNDED sample of the readable ones as `jsonb`.
 *
 * ⚠️ The sample's bound is a `row_number()` **partitioned by `readable`**, not a
 * `LIMIT`. A `LIMIT` on an aggregating `SELECT` bounds the one output row and
 * leaves the sample unbounded — which is the mistake this helper exists to stop
 * being made twice — and a `LIMIT` on the inner scan would bound the COUNTS too,
 * turning the gate's own number into "at most five". Partitioning is what lets
 * the sample carry N ROWS THIS READER MAY SEE while the counts stay whole.
 *
 * ⚠️ `readable` is a projected BOOLEAN rather than a `WHERE` arm, and that is the
 * half that makes `withheld` sayable at all: filtering the scan would make the
 * unscoped count unavailable, and the two must come from ONE statement or they
 * can straddle a concurrent write and disagree about a corpus neither saw.
 *
 * @param rows a `SELECT` projecting `readable`, `example` and an orderable
 *   column; `orderBy` names the ordering for the sample.
 */
function aggregateEvidenceSql(rows: string, sampleParam: number, extraColumns: string): string {
  return `SELECT COUNT(*)::int AS subjects,
                COUNT(*) FILTER (WHERE g.readable)::int AS scoped_subjects,${extraColumns}
                COALESCE(
                  jsonb_agg(g.example ORDER BY g.rn)
                    FILTER (WHERE g.readable AND g.rn <= $${sampleParam}),
                  '[]'::jsonb) AS examples
           FROM (
             SELECT d.*,
                    row_number() OVER (PARTITION BY d.readable ORDER BY d.ingested_at DESC) AS rn
               FROM (${rows}) d
           ) g`;
}

/** Pending alias proposals in the workspace at one position — a count, never content. */
async function loadPendingAliasTotal(
  db: PendingReader,
  workspaceId: string,
  position: SlotPosition,
  requestId: string | undefined,
): Promise<{ n: number; known: boolean }> {
  // ⚠️ `known: false`. An absent workspace means the count was never ASKED, and
  // this module's whole accounting exists to keep that distinguishable from
  // "there are none" — the same shape the cardinality-counts fix above closes.
  // ⚠️ `known: false`, and it LOGS — `readTotal` three lines down logs the
  // byte-identical "unknown rather than zero" outcome, and a silent twin beside
  // it is a return value indistinguishable from a genuine drift. Unreachable
  // from the route (`/pending` refuses without an org) but this is an exported
  // library entry point.
  if (!workspaceId) {
    log.warn(
      { requestId },
      "brain vocabulary pending: asked for a workspace-wide total with no workspace — the total is reported UNKNOWN rather than zero",
    );
    return { n: 0, known: false };
  }
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM brain_vocabulary_proposal
      WHERE workspace_id = $1 AND slot_position = $2 AND status = 'pending'`,
    [workspaceId, position],
  );
  return readTotal(
    rows[0],
    workspaceId,
    `pending alias proposals at the ${position} position`,
    requestId,
  );
}

function readAliasEvidence(
  position: SlotPosition,
  row: Record<string, unknown>,
  workspaceId: string,
  requestId: string | undefined,
): AliasEvidence {
  if (position !== "predicate") return { kind: "not-applicable", reason: "entity-position" };

  // `isCount` for `readCorrectionEvidence`'s reason.
  const subjects = isCount(row.subjects) ? row.subjects : null;
  const scoped = isCount(row.scoped_subjects) ? row.scoped_subjects : null;
  const examples = readAgreementExamples(row.examples);

  if (subjects === null || scoped === null || examples === null) {
    // ⚠️ REPORTED AS ITS OWN BRANCH, not zeroed beside a flag. "No subject in
    // your corpus exhibits this agreement" is a reason to reject; "the evidence
    // query drifted" is a reason to fix the server — and the zeroed shape let a
    // renderer explain the first while meaning the second, down to naming the
    // re-derivation as the cause.
    log.warn(
      { workspaceId, requestId, subjects: row.subjects, scoped: row.scoped_subjects },
      "brain vocabulary pending: an alias proposal's structural evidence would not narrow — reported as unreadable rather than as zero agreeing subjects",
    );
    return { kind: "unreadable" };
  }

  const arithmetic = withheldCount(subjects, scoped);
  return {
    kind: "structural",
    subjects: arithmetic.total,
    scopedSubjects: arithmetic.scoped,
    withheld: arithmetic.withheld,
    examples,
    threshold: ALIAS_PROPOSAL_REPEAT_THRESHOLD,
    countsConsistent: arithmetic.consistent,
  };
}

/**
 * `null` when the aggregate did not read back as a list of agreement rows.
 *
 * Distinguished from `[]` on purpose — {@link readAliasEvidence} maps the two to
 * different `countsConsistent` values, because "nothing agreed" and "the sample
 * would not parse" are the two facts this surface exists to keep apart.
 */
function readAgreementExamples(value: unknown): AgreementExample[] | null {
  if (!Array.isArray(value)) return null;
  const out: AgreementExample[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.subject !== "string" ||
      typeof r.object !== "string" ||
      typeof r.fromPredicate !== "string" ||
      typeof r.toPredicate !== "string"
    ) {
      return null;
    }
    out.push({
      subject: r.subject,
      object: r.object,
      fromPredicate: r.fromPredicate,
      toPredicate: r.toPredicate,
    });
  }
  return out;
}

/**
 * A count as the WIRE defines one — finite, integral, non-negative.
 *
 * ⚠️ Every response schema here says `z.number().int().nonnegative()`, so this
 * predicate and that schema have to agree or the disagreement becomes a 500 over
 * one row. `typeof x === "number"` does not agree with it: `NaN`, `Infinity`,
 * `-1` and `1.5` all pass the `typeof` and all fail the schema, which is exactly
 * the class of drifted value a narrowing guard exists to catch — so the loose
 * check let the interesting failures through and stopped only the boring ones.
 */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Whether a proposal row's PROVENANCE columns were actually read.
 *
 * Shared by both halves because both project the same two `NOT NULL` columns and
 * both rendered `""` as a fact. Returns a boolean rather than throwing so the
 * caller keeps its drop-and-count posture: one bad row must not take down a pane
 * that is showing an approver what is awaiting a decision.
 */
function readableProvenance(
  row: Record<string, unknown>,
  workspaceId: string,
  requestId: string | undefined,
): row is Record<string, unknown> & { source_class: string; proposed_by: string } {
  const ok =
    typeof row.source_class === "string" &&
    row.source_class !== "" &&
    typeof row.proposed_by === "string" &&
    row.proposed_by !== "";
  if (!ok) {
    log.warn(
      { workspaceId, requestId, sourceClass: row.source_class, proposedBy: row.proposed_by },
      "brain vocabulary pending: a proposal's provenance columns would not narrow — dropped rather than rendered as 'an unnamed producer (unrecorded source)', which is a fact the approver would weigh",
    );
  }
  return ok;
}

/**
 * The queue's display rank.
 *
 * 0 on drift rather than NaN — this value only ever orders and renders, and NaN
 * serializes to `null` through JSON, which the wire schema then rejects and the
 * whole pane 500s over one bad row. The drift is LOGGED, which is the part that
 * has to survive; `autoApproveEligible` re-reads the column itself at decision
 * time and is where a NaN must fail every comparison.
 */
function readRank(
  value: unknown,
  proposalId: string,
  workspaceId: string,
  requestId: string | undefined,
): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  log.warn(
    { workspaceId, proposalId, requestId, rank: value },
    "brain vocabulary pending: an alias proposal's confidence did not read back as a number — the queue orders it as 0; the decision path re-reads the column and refuses it there",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// The cardinality half
// ---------------------------------------------------------------------------

interface CardinalityPage {
  readonly entries: readonly PendingCardinalityEntry[];
  readonly total: number;
  readonly totalKnown: boolean;
  readonly scopedTotal: number;
  readonly scopedTotalKnown: boolean;
  readonly truncated: boolean;
  readonly incomplete: boolean;
  readonly decision: PositionalDecision;
}

/**
 * Pending cardinality proposals, at the predicate position's unscoped arm.
 *
 * `brain_predicate_cardinality` is keyed on a canonical predicate, so every row
 * in it is a predicate-position statement and takes the unscoped arm by the same
 * rule rather than by a second decision — `loadCardinalities`' argument,
 * unchanged.
 *
 * The correction evidence rides along on a `LATERAL`, for
 * {@link loadAliasProposals}' reason: one snapshot, one round trip.
 */
async function loadCardinalityProposals(
  db: PendingReader,
  ctx: BrainPrincipalContext,
  limit: number,
  opts: PendingQueueOptions,
): Promise<CardinalityPage> {
  const scope = positionalScopeClause("predicate", ctx, {
    paramIndex: 1,
    alias: "vf",
    requestId: opts.requestId,
  });
  // The workspace-wide count runs even on the DENIED path — content-free, and it
  // is what lets the empty state say "there are N you cannot see" instead of
  // asserting the workspace has none.
  const total = await loadPendingCardinalityTotal(db, ctx.workspaceId, opts.requestId);
  if (scope.decision === "deny-all") {
    return {
      entries: [],
      total: total.n,
      totalKnown: total.known,
      scopedTotal: 0,
      scopedTotalKnown: true,
      truncated: false,
      incomplete: false,
      decision: scope.decision,
    };
  }

  const wsParam = scope.nextParamIndex;
  const limitParam = wsParam + 1;
  // The SAME builder the alias half uses, with the episode-source filter passed
  // through as an extra bind so the cursor arithmetic stays in one place.
  const evidence = buildEvidenceClauses(
    ctx,
    limitParam + 1,
    opts.requestId,
    "cn",
    "co",
    [HUMAN_SOURCE],
  );
  const sourceParam = evidence.sampleParam - 1;

  const params: unknown[] = [...scope.params, ctx.workspaceId, limit + 1, ...evidence.params];

  const { rows } = await db.query(
    // The surface is read through a LATERAL over the scoped live set, keyed on
    // the row's predicate key — so the key stays inside the join and never
    // reaches the projection (`keys-not-on-the-wire.test.ts` reads projection
    // spans, and this statement's is surfaces, counts and timestamps).
    `SELECT c.cardinality,
            c.source_class,
            c.proposed_by,
            c.proposed_at::text AS proposed_at,
            s.predicate_surface,
            COALESCE(s.claims, 0)::int AS claims,
            ev.subjects,
            ev.scoped_subjects,
            ev.events,
            ev.examples,
            COUNT(*) OVER ()::int AS scoped_total
       FROM brain_predicate_cardinality c
       LEFT JOIN LATERAL (
         SELECT mode() WITHIN GROUP (ORDER BY vf.predicate) AS predicate_surface,
                COUNT(*)::int AS claims
           FROM brain_facts vf
          WHERE ${scope.sql} AND vf.predicate_key = c.predicate_key
       ) s ON TRUE
       LEFT JOIN LATERAL (${correctionEvidenceSql(evidence.leftAcl, evidence.rightAcl, sourceParam, evidence.sampleParam)}) ev ON TRUE
      WHERE c.workspace_id = $${wsParam}
        AND c.status = 'pending'
      ORDER BY c.proposed_at DESC, c.cardinality
      LIMIT $${limitParam}`,
    params,
  );

  const entries: PendingCardinalityEntry[] = [];
  const dropped: Record<string, number> = {};
  const drop = (column: string): void => {
    dropped[column] = (dropped[column] ?? 0) + 1;
    unreadable += 1;
  };
  let unreadable = 0;
  let scopedTotal: number | null = null;
  let evidenceDrifted = false;

  for (const raw of rows.slice(0, limit)) {
    if (typeof raw !== "object" || raw === null) {
      drop("row");
      continue;
    }
    const row = raw as Record<string, unknown>;
    // Narrowed to the two-member vocabulary rather than to `string`, and a
    // drifted value is COUNTED rather than allowed through to fail the wire
    // schema and take the whole pane down as a 500 over one row —
    // `loadCardinalities`' posture.
    if (row.cardinality !== "single" && row.cardinality !== "multi") {
      drop("cardinality");
      continue;
    }
    if (typeof row.proposed_at !== "string" || row.proposed_at === "") {
      drop("proposed_at");
      continue;
    }
    // The alias half's provenance rule, on the half that shares the columns.
    if (!readableProvenance(row, ctx.workspaceId, opts.requestId)) {
      drop("provenance");
      continue;
    }
    // ⚠️ DROPPED, never coalesced to 0 — this was `row.claims ?? 0` and that is
    // the module's own defect one field over. `claims` is load-bearing in the
    // ZERO direction: {@link PendingCardinalityEntry.predicateSurface}'s
    // docstring says an entry proposing to arm supersession for a predicate with
    // no live claims is exactly what an approver should find and reject, and the
    // client renders the number as *"N live claims in this slot"*. So a count
    // nobody read rendered as the strongest reject signal on the row. `COALESCE(…,
    // 0)::int` means Postgres cannot produce a non-number here; this is query
    // drift, and drift belongs in `incomplete` with the other unnarrowable rows.
    //
    // ⚠️ `isCount`, not `typeof === "number"`. The wire schema is
    // `z.number().int().nonnegative()`, so `NaN`, `Infinity`, `-1` and `1.5` are
    // all refused there — and a bare `typeof` check admits every one of them,
    // sending exactly the drifted values this guard exists for past the
    // drop-and-count path to 500 the whole pane at `checked()`. `readRank` a few
    // functions down already requires `Number.isFinite` for the same reason.
    if (!isCount(row.claims)) {
      drop("claims");
      continue;
    }
    if (typeof row.scoped_total === "number") scopedTotal = row.scoped_total;

    const evidence = readCorrectionEvidence(row, ctx.workspaceId, opts.requestId);
    if (evidence.kind === "unreadable" || !evidence.countsConsistent) evidenceDrifted = true;
    const predicateSurface =
      typeof row.predicate_surface === "string" ? row.predicate_surface : null;

    entries.push({
      kind: "cardinality",
      // ⚠️ `null` is what stops the surface offering a button it cannot honour.
      // A decide request addresses the row BY SURFACE (the key never reaches the
      // wire), so an entry whose every claim has been retracted has no address —
      // and rendering Approve on it would 400 about a surface nobody chose. The
      // client narrows on this field; it is not restated as a boolean.
      predicateSurface,
      cardinality: row.cardinality,
      sourceClass: row.source_class,
      proposedBy: row.proposed_by,
      proposedAt: row.proposed_at,
      claims: row.claims,
      evidence,
    });
  }

  if (unreadable > 0) {
    log.warn(
      { workspaceId: ctx.workspaceId, unreadable, dropped, requestId: opts.requestId },
      "brain vocabulary pending: cardinality proposal rows would not narrow and were dropped — proposals are awaiting a decision that this queue is not showing",
    );
  }
  if (scopedTotal === null && rows.length > 0) {
    log.warn(
      { workspaceId: ctx.workspaceId, rows: rows.length, requestId: opts.requestId },
      "brain vocabulary pending: the cardinality scoped-total window value did not arrive — the withheld count cannot be trusted and is reported inconsistent",
    );
  }

  return {
    entries,
    total: total.n,
    totalKnown: total.known,
    scopedTotal: scopedTotal ?? entries.length,
    scopedTotalKnown: (scopedTotal !== null || rows.length === 0) && !evidenceDrifted,
    truncated: rows.length > limit,
    incomplete: unreadable > 0,
    decision: scope.decision,
  };
}

/**
 * `CORRECTION_REPEAT_COUNT_SQL`'s join, asked for one predicate and widened to
 * carry the two things a queue row needs beyond the gate's number.
 *
 * ⚠️ **Not `CORRECTION_REPEAT_COUNT_SQL` spliced verbatim, and the difference is
 * declared rather than hidden.** That statement is a whole `SELECT` with its own
 * `$1..$3`, so it cannot be a `LATERAL` correlated on `c.predicate_key`; and it
 * projects one column where this needs three plus a sample. What is COPIED is
 * the predicate — `supersedes` edges, the replacement's episode at
 * {@link HUMAN_SOURCE}, and {@link comparableDifferentSql} on the two objects —
 * and it is copied arm for arm, including the `subject_key IS NOT NULL` guard.
 *
 * That is a real second spelling and it is the kind this subsystem warns about,
 * so it is bounded rather than waved away: it is a DISCLOSURE and never a gate.
 * Nothing decides anything on it. If it drifts, an approver sees a number that
 * disagrees with the one that raised the proposal — which the falsifier in
 * `vocabulary-pending-pg.test.ts` asserts cannot happen by running both against
 * one corpus.
 */
function correctionEvidenceSql(
  newAcl: string,
  oldAcl: string,
  sourceParam: number,
  sampleParam: number,
): string {
  return aggregateEvidenceSql(
    // ⚠️ GROUPED BY `cn.subject_key` so the OUTER `COUNT(*)` is the GATE's
    // number — distinct subjects — and not the event count. The two differ
    // exactly when a reviewer corrects one slot repeatedly, which is the case
    // `CORRECTION_REPEAT_COUNT_SQL` chose `COUNT(DISTINCT …)` to discount.
    // `events` is carried separately by the extra column below.
    //
    // `GROUP BY` rather than `DISTINCT ON` for the alias half's guard reason.
    `SELECT max(cn.ingested_at) AS ingested_at,
               bool_or(${newAcl} AND ${oldAcl}) AS readable,
               (array_agg(
                  jsonb_build_object(
                    'subject', cn.subject,
                    'fromObject', co.object,
                    'toObject', cn.object,
                    'factId', cn.id::text,
                    'at', cn.ingested_at::text)
                  ORDER BY cn.ingested_at DESC)
                FILTER (WHERE ${newAcl} AND ${oldAcl}))[1] AS example
          FROM brain_edges e
          JOIN brain_facts cn ON cn.id = e.from_fact_id AND cn.workspace_id = e.workspace_id
          JOIN brain_facts co ON co.id = e.to_fact_id AND co.workspace_id = e.workspace_id
          JOIN brain_episodes ep
            ON ep.id = cn.source_episode_id AND ep.workspace_id = cn.workspace_id
         WHERE e.workspace_id = c.workspace_id
           AND e.edge_type = 'supersedes'
           AND cn.predicate_key = c.predicate_key
           AND cn.subject_key IS NOT NULL
           AND ep.source = $${sourceParam}
           AND ${comparableDifferentSql("cn.object_cmp", "co.object_cmp")}
         GROUP BY cn.subject_key`,
    sampleParam,
    `
                (SELECT COUNT(*)::int
                   FROM brain_edges e2
                   JOIN brain_facts cn2 ON cn2.id = e2.from_fact_id
                                       AND cn2.workspace_id = e2.workspace_id
                   JOIN brain_facts co2 ON co2.id = e2.to_fact_id
                                       AND co2.workspace_id = e2.workspace_id
                   JOIN brain_episodes ep2
                     ON ep2.id = cn2.source_episode_id AND ep2.workspace_id = cn2.workspace_id
                  WHERE e2.workspace_id = c.workspace_id
                    AND e2.edge_type = 'supersedes'
                    AND cn2.predicate_key = c.predicate_key
                    AND cn2.subject_key IS NOT NULL
                    AND ep2.source = $${sourceParam}
                    AND ${comparableDifferentSql("cn2.object_cmp", "co2.object_cmp")}) AS events,`,
  );
}

async function loadPendingCardinalityTotal(
  db: PendingReader,
  workspaceId: string,
  requestId: string | undefined,
): Promise<{ n: number; known: boolean }> {
  // ⚠️ `known: false`, and it LOGS — `readTotal` three lines down logs the
  // byte-identical "unknown rather than zero" outcome, and a silent twin beside
  // it is a return value indistinguishable from a genuine drift. Unreachable
  // from the route (`/pending` refuses without an org) but this is an exported
  // library entry point.
  if (!workspaceId) {
    log.warn(
      { requestId },
      "brain vocabulary pending: asked for a workspace-wide total with no workspace — the total is reported UNKNOWN rather than zero",
    );
    return { n: 0, known: false };
  }
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM brain_predicate_cardinality
      WHERE workspace_id = $1 AND status = 'pending'`,
    [workspaceId],
  );
  return readTotal(rows[0], workspaceId, "pending cardinality proposals", requestId);
}

function readCorrectionEvidence(
  row: Record<string, unknown>,
  workspaceId: string,
  requestId: string | undefined,
): CorrectionEvidence {
  // `isCount`, not `typeof` — the wire says `int().nonnegative()`, and a
  // negative or fractional count reaching it 500s the pane instead of taking
  // this arm.
  const subjects = isCount(row.subjects) ? row.subjects : null;
  const scoped = isCount(row.scoped_subjects) ? row.scoped_subjects : null;
  const events = isCount(row.events) ? row.events : null;
  const examples = readCorrectionExamples(row.examples);

  if (subjects === null || scoped === null || events === null || examples === null) {
    log.warn(
      { workspaceId, requestId, subjects: row.subjects, events: row.events },
      "brain vocabulary pending: a cardinality proposal's correction evidence would not narrow — reported as unreadable rather than as zero corrections",
    );
    return { kind: "unreadable" };
  }

  const arithmetic = withheldCount(subjects, scoped);
  return {
    kind: "behavioral",
    subjects: arithmetic.total,
    events,
    scopedSubjects: arithmetic.scoped,
    withheld: arithmetic.withheld,
    examples,
    threshold: CORRECTION_REPEAT_THRESHOLD,
    // ⚠️ `events < subjects` is impossible — every distinct subject contributes
    // at least one event — so it is a third statement disagreeing with the other
    // two, and it clears the flag rather than being clamped into a plausible
    // pair of numbers.
    countsConsistent: arithmetic.consistent && events >= arithmetic.total,
  };
}

function readCorrectionExamples(value: unknown): CorrectionExample[] | null {
  if (!Array.isArray(value)) return null;
  const out: CorrectionExample[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.subject !== "string" ||
      typeof r.fromObject !== "string" ||
      typeof r.toObject !== "string" ||
      typeof r.factId !== "string" ||
      typeof r.at !== "string"
    ) {
      return null;
    }
    out.push({
      subject: r.subject,
      fromObject: r.fromObject,
      toObject: r.toObject,
      factId: r.factId,
      at: r.at,
    });
  }
  return out;
}

/**
 * One `COUNT(*)::int` total, with `known` separating *"there are none"* from
 * *"the count did not narrow"*.
 *
 * `loadCardinalityTotal`'s shape and its reason: a total silently read as zero
 * produces the *"nothing is withheld from you"* the whole accounting refuses.
 */
function readTotal(
  raw: unknown,
  workspaceId: string,
  what: string,
  requestId: string | undefined,
): { n: number; known: boolean } {
  const row: Record<string, unknown> | undefined =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  if (typeof row?.n !== "number") {
    // ⚠️ `requestId` — this is the line that fires when the number behind a
    // disclosure badge could not be read, i.e. the one an operator correlates
    // with a user's screenshot. Every other drift log in this module carries it.
    log.warn(
      { workspaceId, what, requestId },
      "brain vocabulary pending: a workspace-wide pending total did not narrow — reported as unknown rather than as zero",
    );
    return { n: 0, known: false };
  }
  return { n: row.n, known: true };
}
