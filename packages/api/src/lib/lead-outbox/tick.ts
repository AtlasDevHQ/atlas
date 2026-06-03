/**
 * Outbox flusher per-tick orchestrator (#2734, slice 8 of 1.6.0).
 *
 * Composes the slice-2 `flushBatch` with the slice-8 depth snapshot +
 * threshold warning. Lives in its own module so the unit test in
 * `__tests__/depth.test.ts` can drive a single async function with
 * stub deps — no `mock.module`, no Effect runtime, no global gauge
 * provider — which is exactly the Layer-handoff contract: `layers.ts`
 * builds the deps, `runOutboxTick` does the work.
 *
 * Order of operations matters. Snapshot runs BEFORE dispatch so the
 * gauge value an operator sees between ticks is "queue depth as of
 * tick start". Reversing the order would make the gauge under-report
 * during a backlog (the dispatch drains some rows, the snapshot then
 * sees the residual, depth-warn never trips even when the queue is
 * actually growing tick-over-tick).
 */

import {
  flushBatch,
  type OutboxDB,
  type OutboxDispatcher,
  type OutboxRetryScheduler,
  type FlushResult,
} from "./outbox";
import {
  queryDepthSnapshot,
  type OutboxDepthSnapshot,
  type OutboxWarnRateLimiter,
  type WarnDecision,
} from "./depth";

/**
 * Minimal OTel Gauge shape. Typed structurally rather than imported
 * from `@opentelemetry/api` so tests can hand in a Bun `mock.fn()` and
 * the production wiring still type-checks against the real `Gauge`
 * interface in `lib/metrics.ts`.
 */
export interface GaugeRecorder {
  record(value: number): void;
}

/**
 * Logger shape used by the tick. Structurally typed so the test can
 * substitute a Bun mock without depending on `pino`.
 */
export interface OutboxTickLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Deps for the depth-observation half of a tick (snapshot → gauges →
 * threshold warn). A subset of `OutboxTickDeps` so the backstop sweep in
 * `layers.ts` can refresh gauges after a draining claim without dragging
 * the dispatcher in.
 */
export interface OutboxObserveDeps {
  readonly db: OutboxDB;
  readonly limiter: OutboxWarnRateLimiter;
  readonly pendingGauge: GaugeRecorder;
  readonly deadGauge: GaugeRecorder;
  readonly logger: OutboxTickLogger;
  /** Injected for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface OutboxTickDeps extends OutboxObserveDeps {
  readonly dispatcher: OutboxDispatcher;
  readonly batchLimit: number;
  /**
   * Per-row retry scheduler (#2874). When present, `flushBatch` wakes the
   * flusher at each transiently-failed row's due-time. Optional so the
   * unit tests and the pure tick contract stay independent of the
   * Layer-owned doorbell.
   */
  readonly retryScheduler?: OutboxRetryScheduler;
}

export interface OutboxObserveResult {
  readonly snapshot: OutboxDepthSnapshot;
  readonly warned: boolean;
}

export interface OutboxTickResult {
  readonly snapshot: OutboxDepthSnapshot;
  readonly flush: FlushResult;
  readonly warned: boolean;
}

/**
 * Snapshot queue depth, record both gauges, and emit the rate-limited
 * backlog warn. Runs BEFORE dispatch on a full tick so the gauge reflects
 * pre-tick depth; the backstop sweep calls it AFTER a draining claim to
 * refresh the gauge (`layers.ts`).
 *
 * Exceptions from `queryDepthSnapshot` propagate so the caller's outer
 * `Effect.tryPromise` records a tick failure. The warn emission is
 * best-effort — if the logger throws (it shouldn't, pino never does) the
 * rate-limit state is already advanced so the next tick won't double-warn.
 */
export async function observeOutboxDepth(deps: OutboxObserveDeps): Promise<OutboxObserveResult> {
  const now = deps.now ?? Date.now;
  const snapshot = await queryDepthSnapshot(deps.db);
  deps.pendingGauge.record(snapshot.pending);
  deps.deadGauge.record(snapshot.dead);

  const warn: WarnDecision | null = deps.limiter.evaluate(snapshot, now());
  if (warn) {
    deps.logger.warn(
      {
        depth: warn.depth,
        threshold: warn.threshold,
        oldestPendingCreatedAt: warn.oldestPendingCreatedAt?.toISOString() ?? null,
        oldestPendingAgeMs: warn.oldestPendingAgeMs,
        event: "lead_outbox.depth_threshold_warn",
      },
      `crm_outbox pending depth ${warn.depth} exceeds threshold ${warn.threshold} — Twenty dispatch may be backed up`,
    );
  }
  return { snapshot, warned: warn != null };
}

/**
 * Run a single full flusher cycle: observe depth → dispatch. Returns
 * enough context for the caller (production: the scheduler Layer; tests:
 * assertions) to surface tick results. Used for kick-driven ticks (and
 * the first tick after boot) where there is genuinely something to
 * dispatch; the idle backstop sweep takes the leaner `flushBatch`-only
 * path in `layers.ts` to keep an idle pod's statement count near 1/sweep.
 *
 * Exceptions from `observeOutboxDepth` or `flushBatch` propagate so the
 * caller's outer `Effect.tryPromise` records a tick failure.
 */
export async function runOutboxTick(deps: OutboxTickDeps): Promise<OutboxTickResult> {
  const observed = await observeOutboxDepth(deps);
  const flush = await flushBatch(deps.db, deps.dispatcher, deps.batchLimit, deps.retryScheduler);
  return { snapshot: observed.snapshot, flush, warned: observed.warned };
}
