/**
 * Scheduler-driven periodic sync for bundle-sync knowledge collections
 * (#4211, ADR-0028 §5 follow-up).
 *
 * Each `bundle-sync` install points a collection at an endpoint serving its
 * OKF bundle; this fiber pulls every enabled install on a cadence and re-runs
 * the #4207 ingest (`lib/knowledge/sync.ts` owns the fetch hardening + the
 * upsert-by-path diff; this module owns only the lifecycle). Synced changes
 * always land `draft` — the review gate holds on the scheduled path exactly
 * as on manual "Sync now".
 *
 * Cadence: `ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS` — a settings-registry knob
 * (default 24, i.e. nightly), NOT a bespoke env var (CLAUDE.md SaaS-first
 * configuration rule; the env var of the same name is the registry's standard
 * env-tier fallback). Read once at scheduler start (`requiresRestart: true`,
 * mirroring `ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS`).
 *
 * Lifecycle mirrors `openapi-spec-refresh.ts` / `byot-catalog-refresh.ts`:
 * `setInterval`-based with `unref()` (doesn't pin the process), an initial
 * cycle on start, a single-running guard, and an in-flight overlap guard so a
 * slow cycle never races the next tick. Promise-native cycle → the Promise
 * `withSpan` (self-spanned, so it never slots into `SCHEDULER_WORK_SPAN_NAMES`
 * in `effect/layers.ts` — same note as the spec-refresh sibling).
 *
 * @see ../knowledge/sync.ts — the per-collection sync + cycle walk.
 * @see ./openapi-spec-refresh.ts — the lifecycle pattern this follows.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { withSpan } from "@atlas/api/lib/tracing";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  runKnowledgeSyncCycle,
  type KnowledgeSyncCycleResult,
} from "@atlas/api/lib/knowledge/sync";

const log = createLogger("knowledge-bundle-sync-scheduler");

/** Default interval: 24 hours — the issue's "nightly default". */
export const DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The periodic sync interval (ms). Reads the settings-registry knob
 * `ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS` (default 24). Fractional hours are
 * legal (an operator can soak-test at 0.1h); non-positive / unparseable
 * values fall back to the default rather than hot-looping `setInterval`.
 */
export function getKnowledgeSyncIntervalMs(): number {
  const raw = getSettingAuto("ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS");
  if (raw === undefined || raw === "") return DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS;
  const hours = Number.parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    log.warn(
      { raw },
      "ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS is non-positive or unparseable — using the 24h default",
    );
    return DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS;
  }
  return hours * 60 * 60 * 1000;
}

/**
 * Run a single sync cycle over every enabled bundle-sync install. Never throws
 * — `runKnowledgeSyncCycle` isolates per-collection failures (logged + counted
 * + recorded in `knowledge_sync_state`) so a down endpoint can't stall the
 * others or kill the scheduler loop.
 */
export async function runKnowledgeBundleSyncCycle(): Promise<KnowledgeSyncCycleResult> {
  return withSpan(
    "atlas.scheduler.knowledge_bundle_sync",
    {},
    async () => {
      log.info("Knowledge bundle sync cycle starting");
      const result = await runKnowledgeSyncCycle();
      // `runKnowledgeSyncCycle` logs a detailed completion line when the
      // working set is non-empty; emit the heartbeat for the empty set too so
      // the cadence is observable on quiet deploys. A failed installs query
      // (`queryFailed`) must NOT emit the idle heartbeat — its zero counts
      // mean "couldn't look", not "nothing to sync" (the cycle already logged
      // the query error).
      if (result.inspected === 0 && !result.queryFailed) {
        log.info("Knowledge bundle sync cycle complete — no enabled bundle-sync collections");
      }
      return result;
    },
    (result) => ({
      "atlas.knowledge_sync.inspected": result.inspected,
      "atlas.knowledge_sync.succeeded": result.succeeded,
      "atlas.knowledge_sync.failed": result.failed,
      "atlas.knowledge_sync.query_failed": result.queryFailed,
    }),
  );
}

// ---------------------------------------------------------------------------
// Lifecycle (setInterval-based, mirrors openapi-spec-refresh.ts)
// ---------------------------------------------------------------------------

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;
/** A still-running cycle, so a slow tick never overlaps the next one. */
let _inFlight = false;

function runCycleWithDefectGuard(): void {
  if (_inFlight) {
    log.debug("Knowledge bundle sync cycle still in flight — skipping this tick");
    return;
  }
  _inFlight = true;
  runKnowledgeBundleSyncCycle()
    .catch((err: unknown) => {
      // The cycle catches per-collection failures internally; this guard only
      // fires on an unexpected defect so the loop survives to the next tick.
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Knowledge bundle sync cycle defected past its internal catch",
      );
    })
    .finally(() => {
      _inFlight = false;
    });
}

/**
 * Start the knowledge bundle sync scheduler. Runs an initial cycle
 * immediately, then repeats at the configured interval. No-op if already
 * running. A non-positive / non-finite `intervalMs` override falls back to the
 * (already-validated) configured interval rather than hot-looping.
 */
export function startKnowledgeBundleSyncScheduler(intervalMs?: number): void {
  if (_running) {
    log.debug("Knowledge bundle sync scheduler already running — skipping start");
    return;
  }
  const interval =
    intervalMs !== undefined && Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : getKnowledgeSyncIntervalMs();
  _running = true;
  log.info({ intervalMs: interval }, "Starting knowledge bundle sync scheduler");

  runCycleWithDefectGuard();
  _timer = setInterval(runCycleWithDefectGuard, interval);
  _timer.unref();
}

export function stopKnowledgeBundleSyncScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _running = false;
  log.info("Knowledge bundle sync scheduler stopped");
}

export function isKnowledgeBundleSyncSchedulerRunning(): boolean {
  return _running;
}

/** Test-only: reset scheduler state. */
export function _resetKnowledgeBundleSyncScheduler(): void {
  stopKnowledgeBundleSyncScheduler();
}

/**
 * Manual-trigger entry point (admin surface / tests). Runs a single cycle and
 * returns its structured result. Per-collection "Sync now" goes through
 * `syncCollection` on the admin route instead — this triggers the whole walk.
 */
export async function triggerKnowledgeBundleSyncCycle(): Promise<KnowledgeSyncCycleResult> {
  return runKnowledgeBundleSyncCycle();
}
