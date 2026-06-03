/**
 * Outbox flusher per-tick orchestrator (#2734, slice 8 of 1.6.0;
 * eventized in #2874).
 *
 * Composes the slice-2 `flushBatch` with the slice-8 depth snapshot +
 * threshold warning. Lives in its own module so the unit test in
 * `__tests__/depth.test.ts` can drive a single async function with
 * stub deps — no `mock.module`, no Effect runtime, no global gauge
 * provider — which is exactly the Layer-handoff contract: `layers.ts`
 * builds the deps, `drainOutbox` does the work.
 *
 * Order of operations (#2874): `drainOutbox` claims rows FIRST, in
 * BATCH_LIMIT chunks, until a batch comes back not-full (the due-row
 * backlog is exhausted), THEN snapshots depth. Two reasons the snapshot
 * trails the drain in the edge-triggered design:
 *   1. A full batch means more rows are due — parking after one batch
 *      would strand a backlog until the next backstop (Codex P1).
 *   2. A kick that drains the queue to empty must leave the gauge at the
 *      POST-drain depth; a pre-drain snapshot would pin `pending_count`
 *      at the pre-dispatch value until the next enqueue (Codex P2).
 * The post-drain residual it reports is exactly the stuck backlog
 * (pending-but-not-due rows in backoff), which is the right signal for
 * the depth-threshold warn.
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

/**
 * Whether `drainOutbox` refreshes the depth gauges after draining:
 *  - `always` — boot/kick wakes always refresh, so an event-driven wake
 *    leaves a fresh `pending_count` even when it claimed nothing.
 *  - `when-claimed` — an idle backstop skips the snapshot to stay at ~1
 *    statement/sweep; it only refreshes when the sweep actually drained
 *    rows (a restart-orphaned backlog the timers missed).
 */
export type OutboxObservePolicy = "always" | "when-claimed";

export interface OutboxDrainResult {
  /** Counts ACCUMULATED across every batch claimed this drain. */
  readonly flush: FlushResult;
  /** How many CLAIM round-trips ran (≥1). */
  readonly batches: number;
  /** Post-drain depth snapshot, or null when an idle backstop skipped it. */
  readonly snapshot: OutboxDepthSnapshot | null;
  readonly warned: boolean;
  /** True when the drain hit `maxBatches` with a still-full final batch. */
  readonly drainCapped: boolean;
}

/**
 * Upper bound on CLAIM round-trips per wake. 200 × `FLUSH_BATCH_LIMIT`
 * (50) = 10k rows drained before the fiber yields back to the backstop,
 * so one wake can't monopolise the fiber on a pathological backlog — the
 * remainder rolls to the next backstop sweep (which `drainCapped` logs,
 * so the truncation is never silent).
 */
export const MAX_DRAIN_BATCHES = 200;

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
 * Drain all currently-due rows, then (per `observe`) refresh the depth
 * gauges. The single flusher entry point (#2874): the scheduler Layer
 * calls it for every wake — boot, inline kick, per-row retry timer, and
 * backstop sweep — varying only the `observe` policy.
 *
 * Claims in `batchLimit` chunks and keeps going while a batch comes back
 * full, so a burst or restart-recovered backlog drains in one wake
 * instead of one batch per backstop interval (Codex P1). Bounded by
 * `maxBatches`; a still-full final batch sets `drainCapped` so the caller
 * can log the deferred remainder (no silent truncation).
 *
 * The depth snapshot trails the drain so `pending_count` converges to the
 * post-drain residual (Codex P2) — see the module header for why the
 * order flipped from the pre-#2874 poll design. An idle backstop
 * (`when-claimed` + nothing claimed) skips the snapshot entirely.
 *
 * Exceptions from `flushBatch` or `observeOutboxDepth` propagate so the
 * caller's outer `Effect.tryPromise` records a tick failure.
 */
export async function drainOutbox(
  deps: OutboxTickDeps & { observe: OutboxObservePolicy; maxBatches?: number },
): Promise<OutboxDrainResult> {
  const maxBatches = deps.maxBatches ?? MAX_DRAIN_BATCHES;
  let flush: FlushResult = { claimed: 0, ok: 0, transient: 0, permanent: 0 };
  // Assigned in the do-body before any read (the loop always runs once).
  let lastClaimed: number;
  let batches = 0;
  do {
    const batch = await flushBatch(deps.db, deps.dispatcher, deps.batchLimit, deps.retryScheduler);
    flush = {
      claimed: flush.claimed + batch.claimed,
      ok: flush.ok + batch.ok,
      transient: flush.transient + batch.transient,
      permanent: flush.permanent + batch.permanent,
    };
    lastClaimed = batch.claimed;
    batches += 1;
  } while (lastClaimed >= deps.batchLimit && batches < maxBatches);
  const drainCapped = lastClaimed >= deps.batchLimit && batches >= maxBatches;

  if (deps.observe === "always" || flush.claimed > 0) {
    const observed = await observeOutboxDepth(deps);
    return {
      flush,
      batches,
      snapshot: observed.snapshot,
      warned: observed.warned,
      drainCapped,
    };
  }
  return { flush, batches, snapshot: null, warned: false, drainCapped };
}
