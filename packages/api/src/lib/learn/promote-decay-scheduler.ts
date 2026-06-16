/**
 * Nightly auto-promote / decay scheduler for learned query patterns
 * (PRD #3617 B-2, #3636).
 *
 * Once a tick (default 24h) this:
 *   - PROMOTES pending `query_pattern` rows that clear a tunable gate
 *     (confidence + repetition + latency budget) from pending → approved, so
 *     the learning loop maintains itself without an admin in the loop.
 *   - DECAYS (DEMOTES, never deletes) auto-promoted rows that have gone unseen
 *     past a tunable window back to pending, so the injected set stays fresh.
 *
 * The decision is the pure {@link decidePromoteDecay} function; this module owns
 * only the I/O — fetching candidates, applying the result, and invalidating the
 * retrieval cache for affected workspaces. The fiber that calls
 * {@link runPromoteDecayTick} on a schedule is wired in `lib/effect/layers.ts`,
 * modeled on the semantic-expert scheduler.
 *
 * `semantic_amendment` rows are deliberately out of scope — they rewrite YAML on
 * approval and keep human review (mirrors the expert auto-approve carve-out).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getSetting } from "@atlas/api/lib/settings";
import { DEFAULT_LATENCY_BUDGET_MS } from "@atlas/api/lib/learn/pattern-cache";
// Type-only import — erased at compile time, so it does NOT eagerly load
// db/internal and the dynamic import + mock seam in runPromoteDecayTick stays
// intact. Reusing the row type keeps `toCandidate` from drifting from the SQL.
import type { PromoteDecayCandidateRow } from "@atlas/api/lib/db/internal";
import {
  decidePromoteDecay,
  type PromoteDecayThresholds,
  type PromoteDecayCandidate,
} from "@atlas/api/lib/learn/promote-decay";

const log = createLogger("promote-decay-scheduler");

/** Narrow an unknown thrown value to a log-safe message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Default interval: 24 hours. */
export const DEFAULT_PROMOTE_DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Gate defaults (mirror the registry defaults in lib/settings.ts). */
const DEFAULT_PROMOTE_CONFIDENCE = 0.7;
const DEFAULT_PROMOTE_MIN_REPETITIONS = 5;
const DEFAULT_DECAY_UNSEEN_DAYS = 30;

/** Upper bound on rows evaluated per tick — a runaway-table backstop. The
 *  scheduler logs when the cap is hit so a silently-truncated tick is visible. */
const CANDIDATE_LIMIT = 10000;

/** Summary of a single tick. */
export interface PromoteDecayTickResult {
  candidates: number;
  promoted: number;
  demoted: number;
  errors: number;
}

/**
 * Whether the nightly promote/decay job is enabled.
 *
 * Platform-scoped (like the expert scheduler): a single process-global fiber
 * forked once at boot by `makeSchedulerLive`, so there is no per-workspace
 * tick. Resolved via `getSetting()` so a platform DB override (admin settings
 * page) beats the env var (platform DB override > env > default). Consumed once
 * at boot — changes require a restart (`requiresRestart` in the registry).
 */
export function isPromoteDecaySchedulerEnabled(): boolean {
  const v = getSetting("ATLAS_LEARN_PROMOTE_DECAY_ENABLED");
  return v === "true" || v === "1";
}

/**
 * Tick interval in milliseconds.
 *
 * Resolves `ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS` through `getSetting()`
 * (platform DB override > env > default 24). Platform-scoped and boot-consumed —
 * see {@link isPromoteDecaySchedulerEnabled}.
 */
export function getPromoteDecaySchedulerIntervalMs(): number {
  const raw = getSetting("ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS");
  if (!raw) return DEFAULT_PROMOTE_DECAY_INTERVAL_MS;
  const hours = parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_PROMOTE_DECAY_INTERVAL_MS;
  return hours * 60 * 60 * 1000;
}

/** Parse a raw setting value, falling back to `fallback` on a missing /
 *  non-finite / out-of-range value (a typo can't silently widen a gate). `min`
 *  is the inclusive lower bound the value must clear. The caller reads the key
 *  with a literal `getSetting("KEY")` so the registry-reader guard (#3382) can
 *  see each key's reader. */
function parseNumeric(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * Resolve the promote/decay gate from the settings registry at platform scope.
 *
 * Read once per tick (no orgId), so these are platform-level values — a
 * workspace override of `ATLAS_LEARN_LATENCY_BUDGET_MS` affects only
 * retrieval-time down-weighting, not the promotion gate. The confidence
 * threshold reuses the same `ATLAS_LEARN_CONFIDENCE_THRESHOLD` key that gates
 * retrieval, so "eligible to inject" and "eligible to auto-promote" share one
 * knob.
 */
export function resolvePromoteDecayThresholds(): PromoteDecayThresholds {
  const decayUnseenDays = parseNumeric(
    getSetting("ATLAS_LEARN_DECAY_UNSEEN_DAYS"),
    DEFAULT_DECAY_UNSEEN_DAYS,
    1,
  );
  return {
    confidenceThreshold: parseNumeric(
      getSetting("ATLAS_LEARN_CONFIDENCE_THRESHOLD"),
      DEFAULT_PROMOTE_CONFIDENCE,
      0,
    ),
    minRepetitions: parseNumeric(
      getSetting("ATLAS_LEARN_PROMOTE_MIN_REPETITIONS"),
      DEFAULT_PROMOTE_MIN_REPETITIONS,
      1,
    ),
    latencyBudgetMs: parseNumeric(
      getSetting("ATLAS_LEARN_LATENCY_BUDGET_MS"),
      DEFAULT_LATENCY_BUDGET_MS,
      1,
    ),
    decayUnseenMs: decayUnseenDays * 24 * 60 * 60 * 1000,
  };
}

/** Project a DB candidate row (snake_case) onto the pure-decision input shape
 *  (camelCase) — the one place the two representations are bridged. The raw row
 *  types `type`/`status` as bare `string` (Postgres text); the SELECT in
 *  `getPromoteDecayCandidates` filters `type = 'query_pattern'` and
 *  `status IN ('pending','approved')`, so narrowing them to the wire unions here
 *  is the single, documented `string → union` coercion. */
function toCandidate(row: PromoteDecayCandidateRow): PromoteDecayCandidate {
  return {
    id: row.id,
    type: row.type as PromoteDecayCandidate["type"],
    status: row.status as PromoteDecayCandidate["status"],
    confidence: row.confidence,
    repetitionCount: row.repetition_count,
    avgDurationMs: row.avg_duration_ms,
    lastSeenAt: row.last_seen_at,
    autoPromoted: row.auto_promoted,
  };
}

/**
 * Run a single promote/decay tick.
 *
 * 1. Bail if there's no internal DB (self-hosted without one).
 * 2. Fetch promotion + decay candidates (scoped to `query_pattern`).
 * 3. Apply the pure decision against the resolved gate.
 * 4. Promote / demote the resulting id sets (each guarded so a concurrent admin
 *    action can't be clobbered — see the DB helpers).
 * 5. Invalidate the retrieval cache for every affected workspace.
 *
 * Never throws — errors are logged and surfaced in `result.errors`.
 */
export async function runPromoteDecayTick(): Promise<PromoteDecayTickResult> {
  const result: PromoteDecayTickResult = { candidates: 0, promoted: 0, demoted: 0, errors: 0 };

  try {
    const {
      hasInternalDB,
      getPromoteDecayCandidates,
      promoteLearnedPatterns,
      demoteLearnedPatterns,
    } = await import("@atlas/api/lib/db/internal");

    if (!hasInternalDB()) {
      log.debug("No internal DB — skipping promote/decay tick");
      return result;
    }

    const candidates = await getPromoteDecayCandidates(CANDIDATE_LIMIT);
    result.candidates = candidates.length;
    if (candidates.length === CANDIDATE_LIMIT) {
      log.warn(
        { limit: CANDIDATE_LIMIT },
        "Promote/decay candidate scan hit its cap — some rows were not evaluated this tick",
      );
    }
    if (candidates.length === 0) {
      log.debug("Promote/decay tick: no candidates");
      return result;
    }

    const thresholds = resolvePromoteDecayThresholds();
    const { promote, demote } = decidePromoteDecay(
      candidates.map(toCandidate),
      thresholds,
      Date.now(),
    );

    // Settle promote and demote INDEPENDENTLY. A `Promise.all` would reject as
    // soon as either side throws and unwind to the outer catch — losing the
    // OTHER side's already-committed count AND skipping cache invalidation for
    // its just-flipped rows, leaving stale agent context until the 5-min TTL
    // lapses (#3636 review). Each batch DB write is its own transaction, so a
    // success on one side is durable regardless of the other.
    const affected = new Set<string | null>();
    const [promoteRes, demoteRes] = await Promise.allSettled([
      promoteLearnedPatterns(promote),
      demoteLearnedPatterns(demote),
    ]);
    if (promoteRes.status === "fulfilled") {
      result.promoted = promoteRes.value.count;
      for (const orgId of promoteRes.value.orgIds) affected.add(orgId);
    } else {
      result.errors++;
      log.error(
        { err: errorMessage(promoteRes.reason), ids: promote.length },
        "Auto-promote batch failed",
      );
    }
    if (demoteRes.status === "fulfilled") {
      result.demoted = demoteRes.value.count;
      for (const orgId of demoteRes.value.orgIds) affected.add(orgId);
    } else {
      result.errors++;
      log.error(
        { err: errorMessage(demoteRes.reason), ids: demote.length },
        "Auto-demote batch failed",
      );
    }

    // A promotion/demotion changes which patterns the agent sees, so evict the
    // 5-min retrieval cache for every affected workspace (mirrors the admin
    // approve/reject path). Imported here, not at module top, to avoid a cycle
    // through the settings → internal → pattern-cache graph. Wrapped on its own
    // so a cache-import/invalidation failure is logged distinctly rather than
    // masquerading as a tick-wide failure that discards the committed counts.
    if (affected.size > 0) {
      try {
        const { invalidatePatternCache } = await import("@atlas/api/lib/learn/pattern-cache");
        for (const orgId of affected) invalidatePatternCache(orgId);
      } catch (err) {
        result.errors++;
        log.error(
          { err: errorMessage(err) },
          "Promote/decay cache invalidation failed — rows were flipped but cache stays stale until TTL",
        );
      }
    }

    log.info(
      {
        candidates: result.candidates,
        promoted: result.promoted,
        demoted: result.demoted,
        errors: result.errors,
      },
      "Promote/decay tick complete",
    );
  } catch (err) {
    log.error(
      { err: errorMessage(err) },
      "Promote/decay tick failed",
    );
    result.errors++;
  }

  return result;
}
