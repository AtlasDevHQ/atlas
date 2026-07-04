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
 * env-tier fallback). Hot-reloaded (#4236): the interval is re-read via
 * `getSettingAuto` when arming each next tick, so an admin-console change
 * takes effect by the following tick without a process restart.
 *
 * Lifecycle: self-rescheduling `setTimeout` chain with `unref()` (doesn't pin
 * the process), an initial cycle on start, a single-running guard, and an
 * in-flight overlap guard so a slow cycle never races the next tick.
 * Promise-native cycle → the Promise `withSpan` (self-spanned, so it never
 * slots into `SCHEDULER_WORK_SPAN_NAMES` in `effect/layers.ts`). Its former
 * siblings (`openapi-spec-refresh.ts`, `byot-catalog-refresh.ts`) were folded
 * onto `registerPeriodicFiber` by #4195; this job is a candidate for the same
 * treatment.
 *
 * @see ../knowledge/sync.ts — the per-collection sync + cycle walk.
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
 * `setTimeout`/`setInterval` clamp delays above 2^31−1 ms (~24.85 days) down to
 * 1ms — so an over-large interval would hot-loop, the exact opposite of intent.
 * We cap at the max representable delay instead (≈596.5h). See #4236 review.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * The periodic sync interval (ms). Reads the settings-registry knob
 * `ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS` (default 24). Fractional hours are
 * legal (an operator can soak-test at 0.1h); non-positive / unparseable
 * values fall back to the default rather than hot-looping the timer, and
 * over-large values are clamped to `MAX_TIMER_DELAY_MS` (a bigger value would
 * overflow the 32-bit timer and hot-loop at 1ms — see #4236).
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
  const ms = hours * 60 * 60 * 1000;
  if (ms > MAX_TIMER_DELAY_MS) {
    log.warn(
      { raw, maxHours: MAX_TIMER_DELAY_MS / (60 * 60 * 1000) },
      "ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS exceeds the max timer delay — clamping to avoid a 32-bit overflow hot-loop",
    );
    return MAX_TIMER_DELAY_MS;
  }
  return ms;
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
// Lifecycle (self-rescheduling setTimeout — each tick re-reads the interval so
// the settings knob hot-reloads, #4236)
// ---------------------------------------------------------------------------

let _timer: ReturnType<typeof setTimeout> | null = null;
let _running = false;
/** A still-running cycle, so a slow tick never overlaps the next one. */
let _inFlight = false;
/** A start-time test/caller override; null = re-read the registry per tick. */
let _intervalOverrideMs: number | null = null;
/** The delay the pending timer was armed with (observable by tests). */
let _armedIntervalMs: number | null = null;

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
 * Clamp a millisecond delay into `setTimeout`'s safe range. Non-finite /
 * non-positive → the 24h default; over-large → `MAX_TIMER_DELAY_MS` (a bigger
 * value overflows the 32-bit timer and hot-loops at 1ms). Applied to BOTH
 * arming paths — the registry read and an explicit start-time override — so the
 * overflow guard is a genuine guarantee, not just a registry-path one (#4236).
 */
function clampTimerDelayMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS;
  return Math.min(ms, MAX_TIMER_DELAY_MS);
}

/**
 * Arm the next tick, re-reading the configured interval so a settings change
 * (admin console / DB override, ~30s registry hot-reload) takes effect by the
 * following tick — no restart. An explicit start-time override stays fixed.
 * Logs when the re-read interval differs from the previously-armed one so an
 * operator has evidence a cadence change actually took effect (#4236).
 */
function armNextTick(): void {
  if (!_running) return;
  // getKnowledgeSyncIntervalMs already returns a clamped value; clamp again so
  // an explicit start-time override (which bypasses that function) can't
  // overflow the timer either — the guard covers every arming path.
  const interval = clampTimerDelayMs(_intervalOverrideMs ?? getKnowledgeSyncIntervalMs());
  if (_armedIntervalMs !== null && _armedIntervalMs !== interval) {
    log.info(
      { previousMs: _armedIntervalMs, intervalMs: interval },
      "Knowledge bundle sync interval changed — new cadence applies from this tick",
    );
  }
  _armedIntervalMs = interval;
  // Self-rescheduling chain: the re-arm must survive a synchronous throw in the
  // cycle kickoff (setInterval used to guarantee this) — otherwise the loop
  // would die with `_running` still true and no pending timer. try/finally
  // keeps the chain alive; the cycle's own async errors are handled in
  // `runCycleWithDefectGuard`.
  _timer = setTimeout(() => {
    try {
      runCycleWithDefectGuard();
    } catch (err: unknown) {
      // Defensive / near-unreachable: runCycleWithDefectGuard delegates to an
      // async cycle (rejections, not sync throws) and its only sync statements
      // are the in-flight guard + a debug log. This catch exists so a future
      // refactor that adds a throwing sync pre-check can't kill the chain.
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Knowledge bundle sync tick threw synchronously — re-arming anyway",
      );
    } finally {
      armNextTick();
    }
  }, interval);
  _timer.unref();
}

/**
 * Start the knowledge bundle sync scheduler. Runs an initial cycle
 * immediately, then repeats at the configured interval, re-reading the
 * settings knob when arming each next tick. No-op if already running. A
 * non-positive / non-finite `intervalMs` override falls back to the
 * (already-validated) configured interval rather than hot-looping.
 */
export function startKnowledgeBundleSyncScheduler(intervalMs?: number): void {
  if (_running) {
    log.debug("Knowledge bundle sync scheduler already running — skipping start");
    return;
  }
  _intervalOverrideMs =
    intervalMs !== undefined && Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : null;
  _running = true;
  log.info(
    { intervalMs: _intervalOverrideMs ?? getKnowledgeSyncIntervalMs() },
    "Starting knowledge bundle sync scheduler (interval re-read each tick)",
  );

  runCycleWithDefectGuard();
  armNextTick();
}

export function stopKnowledgeBundleSyncScheduler(): void {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _running = false;
  _intervalOverrideMs = null;
  _armedIntervalMs = null;
  log.info("Knowledge bundle sync scheduler stopped");
}

export function isKnowledgeBundleSyncSchedulerRunning(): boolean {
  return _running;
}

/**
 * Test-only: reset scheduler state to pristine (as if never started). Unlike
 * production `stop()` — which leaves a real in-flight cycle to finish — this
 * also clears `_inFlight`, so a slow mocked cycle from a prior test can't leak
 * its guard into the next test's initial cycle (#4236 review).
 */
export function _resetKnowledgeBundleSyncScheduler(): void {
  stopKnowledgeBundleSyncScheduler();
  _inFlight = false;
}

/** Test-only: the delay (ms) the pending tick was armed with, or null. */
export function _getArmedKnowledgeSyncIntervalMs(): number | null {
  return _armedIntervalMs;
}

/**
 * Manual-trigger entry point (admin surface / tests). Runs a single cycle and
 * returns its structured result. Per-collection "Sync now" goes through
 * `syncCollection` on the admin route instead — this triggers the whole walk.
 */
export async function triggerKnowledgeBundleSyncCycle(): Promise<KnowledgeSyncCycleResult> {
  return runKnowledgeBundleSyncCycle();
}
