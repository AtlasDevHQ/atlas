/**
 * The eligible set — the workspace-and-group's injectable learned query patterns,
 * from which relevance picks per turn (#4571, CONTEXT.md § Learned query
 * patterns).
 *
 * The ONE pure statement of injection eligibility + ordering, shared by both
 * consumers so they can never drift (mirrors the briefing-assembly precedent in
 * `semantic/expert/briefing.ts`):
 *
 *   - the SQL fetch (`getApprovedPatterns` in `db/internal.ts`) orders by
 *     {@link ELIGIBLE_SET_ORDER_BY_SQL} under {@link ELIGIBLE_SET_SAFETY_CAP}, so
 *     the LIMIT keeps human-approved rows and the highest-confidence machine rows;
 *   - the in-memory relevance stage (`getRelevantPatterns` in `pattern-cache.ts`)
 *     runs {@link selectEligiblePatterns} to apply the eligibility predicate and
 *     the same ordering before keyword ranking.
 *
 * The domain rule this encodes (CONTEXT.md):
 *   - **Approval is an eligibility bypass, not a confidence write.** A
 *     human-approved pattern is eligible regardless of confidence.
 *   - **Confidence gates the machine road only.** A machine-promoted pattern
 *     must clear the confidence threshold to be eligible.
 *   - **Ordering**: human-approved first (they never fall off any cap), then
 *     confidence DESC, then last-observed DESC as the saturation tiebreak.
 *
 * PURE: no DB, no settings, no logger, no clock — a function of its inputs alone,
 * so its tests import it directly with no `mock.module()` (like `rolling-mean.ts`
 * and `pattern-ranking.ts`). It defines its own minimal {@link EligibilityFields}
 * rather than importing the full `ApprovedPatternRow`, so it stays dependency-free
 * and generic over any row that carries the three decision fields.
 */

/**
 * The subset of a learned-pattern row the eligibility decision + ordering reads.
 * A structural minimum so the helpers stay generic over `ApprovedPatternRow`
 * (and any test fixture) without a runtime import of the DB layer.
 */
export interface EligibilityFields {
  /** The machine's evidence meter (0–1). Gates the machine road only. */
  readonly confidence: number;
  /** True when the nightly auto-promote job promoted this row (the machine road);
   *  false when a human approved it (the eligibility-bypass road). */
  readonly auto_promoted: boolean;
  /** Last-observed timestamp or null until first observed. In production this is
   *  PostgreSQL `timestamptz::text` (space-separated, `+00` offset — not strict
   *  ISO-8601), parsed leniently by `Date.parse`; unparseable/null sorts last.
   *  The saturation tiebreak among confidence ties. */
  readonly last_seen_at: string | null;
}

/**
 * A generous per-(workspace, group) ceiling on the injectable set pulled from
 * the DB — replaces the old arbitrary 100-row confidence-DESC pre-cut (#4571).
 * High enough that the full eligible set of any real library fits: because
 * human-approved rows sort first under {@link ELIGIBLE_SET_ORDER_BY_SQL}, the
 * LIMIT drops only the lowest-confidence machine rows — no human-approved pattern
 * is truncated at fetch time UNLESS a single (workspace, group) has more than
 * this many human-approved patterns, the recorded exit to full-text retrieval
 * (PRD #4570), adopted on evidence, not preemptively. Also bounds the pattern
 * cache's memory.
 */
export const ELIGIBLE_SET_SAFETY_CAP = 1000;

/**
 * The canonical eligible-set ordering as a SQL `ORDER BY` fragment — human-
 * approved first (`auto_promoted = false`), then confidence DESC, then
 * last-observed DESC (NULLS LAST). {@link compareEligibleOrder} mirrors it
 * clause-for-clause. `last_seen_at` is table-qualified so the sort binds to the
 * real `timestamptz` column (chronological) rather than the query's
 * `last_seen_at::text` output alias (which would sort lexically) — that keeps it
 * in agreement with the comparator's epoch-millis sort regardless of session
 * timezone. Referenced verbatim by `getApprovedPatterns` (which selects `FROM
 * learned_patterns`); it embeds no user input, so it is safe to interpolate.
 */
export const ELIGIBLE_SET_ORDER_BY_SQL =
  "(auto_promoted = false) DESC, confidence DESC, learned_patterns.last_seen_at DESC NULLS LAST";

/**
 * Whether a human approved this pattern (as opposed to the nightly auto-promote
 * job). A live review decision reaches `status = 'approved'` by two roads: a
 * human review stamps `auto_promoted = false` (see `admin-learned-patterns.ts`),
 * the machine stamps `auto_promoted = true` — so `auto_promoted === false` marks
 * a human approval. (Workspace-bundle import replays an already-decided row
 * carrying its recorded flag; a pre-#4571 bundle lacks it and fails closed to
 * the machine road — see `admin-migrate.ts`.) A partial row missing the flag is
 * likewise treated as machine, so a fixture can never accidentally grant the
 * bypass.
 */
export function isHumanApproved(row: Pick<EligibilityFields, "auto_promoted">): boolean {
  return row.auto_promoted === false;
}

/**
 * Whether a pattern is eligible for injection. Human approval is an
 * unconditional eligibility grant (it bypasses the confidence gate); the gate
 * applies ONLY to machine-promoted rows. This is the seam that makes an approved
 * low-confidence pattern injectable on the next turn.
 */
export function isEligibleForInjection(row: EligibilityFields, confidenceThreshold: number): boolean {
  return isHumanApproved(row) || row.confidence >= confidenceThreshold;
}

/** Numeric sort key for `last_seen_at` — the epoch millis, or -Infinity for
 *  null/unparseable so those sort last under a DESC comparison (NULLS LAST). */
function lastSeenRank(ts: string | null): number {
  if (ts === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Total order mirroring {@link ELIGIBLE_SET_ORDER_BY_SQL}: human-approved first,
 * then confidence DESC, then last-observed DESC (NULLS LAST). Returns 0 on a
 * genuine tie (both never-observed included) so the sort stays stable and never
 * yields NaN.
 */
export function compareEligibleOrder(a: EligibilityFields, b: EligibilityFields): number {
  // 1. Human-approved first — they never fall off any cap.
  const humanRank = Number(isHumanApproved(b)) - Number(isHumanApproved(a));
  if (humanRank !== 0) return humanRank;

  // 2. Confidence DESC.
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;

  // 3. Last-observed DESC, NULLS LAST — the saturation tiebreak.
  const ra = lastSeenRank(a.last_seen_at);
  const rb = lastSeenRank(b.last_seen_at);
  if (ra === rb) return 0; // equal timestamps, or both null (both -Infinity)
  return rb - ra;
}

/**
 * The pure eligible-set selection: keep the injectable rows (human-approved
 * unconditionally, machine-promoted only above the confidence threshold) and
 * order them canonically. Generic over any row carrying {@link EligibilityFields}
 * so it returns the caller's full row type unchanged for downstream ranking.
 * Non-mutating (`toSorted`).
 */
export function selectEligiblePatterns<T extends EligibilityFields>(
  rows: readonly T[],
  confidenceThreshold: number,
): T[] {
  return rows
    .filter((row) => isEligibleForInjection(row, confidenceThreshold))
    .toSorted(compareEligibleOrder);
}
