/**
 * Email-outbox flusher per-tick orchestrator (#2942).
 *
 * Composes `flushBatch` with the depth snapshot + threshold warning.
 * Lives in its own module so the unit test can drive a single async
 * function with stub deps — no `mock.module`, no Effect runtime, no
 * global gauge provider — which is the Layer-handoff contract:
 * `layers.ts` builds the deps, `runEmailOutboxTick` does the work.
 *
 * Order of operations matters. Snapshot runs BEFORE dispatch so the
 * gauge value an operator sees between ticks is "queue depth as of tick
 * start". Reversing it would make the gauge under-report during a
 * backlog (dispatch drains some rows, the snapshot then sees the
 * residual, depth-warn never trips even when the queue is growing).
 */

import { flushBatch, type EmailOutboxDB, type EmailDispatcher, type FlushResult } from "./outbox";
import {
  queryDepthSnapshot,
  type OutboxDepthSnapshot,
  OutboxWarnRateLimiter,
  type WarnDecision,
} from "./depth";

/**
 * Minimal OTel Gauge shape. Typed structurally rather than imported
 * from `@opentelemetry/api` so tests can hand in a plain recorder and
 * the production wiring still type-checks against the real `Gauge`.
 */
export interface GaugeRecorder {
  record(value: number): void;
}

/**
 * Logger shape used by the tick. Structurally typed so the test can
 * substitute a stub without depending on `pino`.
 */
export interface OutboxTickLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface OutboxTickDeps {
  readonly db: EmailOutboxDB;
  readonly dispatcher: EmailDispatcher;
  readonly batchLimit: number;
  readonly limiter: OutboxWarnRateLimiter;
  readonly pendingGauge: GaugeRecorder;
  readonly deadGauge: GaugeRecorder;
  readonly logger: OutboxTickLogger;
  /** Injected for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface OutboxTickResult {
  readonly snapshot: OutboxDepthSnapshot;
  readonly flush: FlushResult;
  readonly warned: boolean;
}

/**
 * Run a single flusher cycle: snapshot → gauges → threshold warn →
 * dispatch. Returns enough context for the caller (production: the
 * scheduler Layer; tests: assertions) to surface tick results.
 *
 * Exceptions from `queryDepthSnapshot` or `flushBatch` propagate so the
 * caller's outer `Effect.tryPromise` records a tick failure.
 */
export async function runEmailOutboxTick(deps: OutboxTickDeps): Promise<OutboxTickResult> {
  const { db, dispatcher, batchLimit, limiter, pendingGauge, deadGauge, logger } = deps;
  const now = deps.now ?? Date.now;

  const snapshot = await queryDepthSnapshot(db);
  pendingGauge.record(snapshot.pending);
  deadGauge.record(snapshot.dead);

  const warn: WarnDecision | null = limiter.evaluate(snapshot, now());
  if (warn) {
    logger.warn(
      {
        depth: warn.depth,
        threshold: warn.threshold,
        oldestPendingCreatedAt: warn.oldestPendingCreatedAt?.toISOString() ?? null,
        oldestPendingAgeMs: warn.oldestPendingAgeMs,
        event: "email_outbox.depth_threshold_warn",
      },
      `email_outbox pending depth ${warn.depth} exceeds threshold ${warn.threshold} — transactional email delivery may be backed up`,
    );
  }

  const flush = await flushBatch(db, dispatcher, batchLimit);
  return { snapshot, flush, warned: warn != null };
}
