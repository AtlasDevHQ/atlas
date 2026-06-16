/**
 * Pure promote/decay decision for learned query patterns (PRD #3617 B-2, #3636).
 *
 * This module holds NO I/O — it takes a snapshot of candidate rows, a set of
 * thresholds, and the current time, and returns the ids to promote
 * (pending → approved) and demote (approved → pending). Keeping the policy pure
 * makes the gate and the decay window testable without the nightly fiber or a
 * database; the scheduler (`promote-decay-scheduler.ts`) supplies the rows and
 * applies the result.
 *
 * Scope is deliberately narrow:
 *   - Only `query_pattern` rows are touched. `semantic_amendment` rows keep
 *     human review (they rewrite YAML on approval) and are never auto-promoted.
 *   - Decay only ever demotes rows the job itself promoted (`autoPromoted`),
 *     never a human's explicit approval.
 */

// Type-only import — erased at compile time, zero runtime coupling. Ties the
// decision's `type`/`status` discriminants to the wire SSOT so the literal
// comparisons below can't drift from the canonical value set.
import type { LearnedPatternStatus, LearnedPatternType } from "@useatlas/types";

/** Tunable gates for one promote/decay pass. */
export interface PromoteDecayThresholds {
  /** Minimum confidence (0–1) for a pending row to auto-promote. */
  confidenceThreshold: number;
  /** Minimum `repetition_count` for a pending row to auto-promote. */
  minRepetitions: number;
  /**
   * Maximum `avg_duration_ms` for a pending row to auto-promote. A row whose
   * latency was never measured (`avgDurationMs === null`) never clears this
   * gate — we don't amplify a pattern whose speed we've never observed.
   */
  latencyBudgetMs: number;
  /**
   * An auto-promoted row unseen for longer than this window (ms) is demoted
   * back to pending so the injected set stays fresh.
   */
  decayUnseenMs: number;
}

/** Minimal row shape the decision needs — a projection of `learned_patterns`. */
export interface PromoteDecayCandidate {
  id: string;
  /** Row type; only `"query_pattern"` is ever acted on. */
  type: LearnedPatternType;
  /** Lifecycle status. */
  status: LearnedPatternStatus;
  confidence: number;
  repetitionCount: number;
  /** Rolling-mean wall-clock (ms), or null until first observed. */
  avgDurationMs: number | null;
  /** ISO timestamp the pattern was last observed running, or null. */
  lastSeenAt: string | null;
  /** Whether a prior pass auto-promoted this row. */
  autoPromoted: boolean;
}

/** The ids to flip in each direction. */
export interface PromoteDecayDecision {
  /** Pending rows clearing the gate → set status `approved`, `auto_promoted`. */
  promote: string[];
  /** Stale auto-promoted approved rows → set status back to `pending`. */
  demote: string[];
}

/** A finite, non-negative latency measurement we can compare to the budget. */
function hasMeasuredLatency(avgDurationMs: number | null): avgDurationMs is number {
  return avgDurationMs !== null && Number.isFinite(avgDurationMs) && avgDurationMs >= 0;
}

/**
 * Milliseconds since the pattern was last observed running, or `null` when
 * there is no usable timestamp (never seen, or an unparseable value). A row
 * `incrementPatternCount` has measured at least once carries both
 * `avg_duration_ms` and `last_seen_at` (they're stamped together), so a row
 * eligible on the latency gate will always have a usable timestamp here.
 */
function msSinceLastSeen(p: PromoteDecayCandidate, now: number): number | null {
  if (p.lastSeenAt === null) return null;
  const seen = Date.parse(p.lastSeenAt);
  if (Number.isNaN(seen)) return null;
  return now - seen;
}

/** Whether a pending row clears every auto-promote gate. */
function shouldPromote(p: PromoteDecayCandidate, t: PromoteDecayThresholds, now: number): boolean {
  if (
    !(
      p.type === "query_pattern" &&
      p.status === "pending" &&
      p.confidence >= t.confidenceThreshold &&
      p.repetitionCount >= t.minRepetitions &&
      hasMeasuredLatency(p.avgDurationMs) &&
      p.avgDurationMs <= t.latencyBudgetMs
    )
  ) {
    return false;
  }
  // Recency gate: a pattern unseen past the decay window must NOT be
  // (re-)promoted until a fresh observation stamps `last_seen_at`. Without this,
  // decay is futile — the other gates look only at cumulative confidence /
  // repetition / rolling latency, none of which a decay-demote changes, so a
  // stale-but-popular row demoted for going unseen would clear the gate again on
  // the very next tick and flip approved → pending → approved forever (#3636
  // review). Mirroring the demote window keeps "stale enough to demote" and
  // "fresh enough to (re-)promote" as exact complements.
  const sinceSeen = msSinceLastSeen(p, now);
  return sinceSeen !== null && sinceSeen <= t.decayUnseenMs;
}

/** Whether an approved, machine-promoted row has gone stale past the window. */
function shouldDemote(p: PromoteDecayCandidate, t: PromoteDecayThresholds, now: number): boolean {
  if (p.type !== "query_pattern" || p.status !== "approved" || !p.autoPromoted) return false;
  const sinceSeen = msSinceLastSeen(p, now);
  if (sinceSeen === null) return false; // can't prove staleness without a timestamp
  return sinceSeen > t.decayUnseenMs;
}

/**
 * Partition candidate patterns into ids to promote and ids to demote.
 *
 * Pure: depends only on its inputs. `now` is epoch milliseconds (caller passes
 * `Date.now()`) so the decay window is deterministic in tests.
 */
export function decidePromoteDecay(
  patterns: readonly PromoteDecayCandidate[],
  thresholds: PromoteDecayThresholds,
  now: number,
): PromoteDecayDecision {
  const promote: string[] = [];
  const demote: string[] = [];
  for (const p of patterns) {
    if (shouldPromote(p, thresholds, now)) promote.push(p.id);
    else if (shouldDemote(p, thresholds, now)) demote.push(p.id);
  }
  return { promote, demote };
}
