/**
 * Public surface of the lead-outbox module (#2729). Generic queue
 * mechanics live here; the Twenty-specific dispatcher lives in
 * `ee/src/saas-crm/index.ts` so the core → ee inversion stays enforced.
 */

export {
  enqueue,
  recoverInFlight,
  flushBatch,
  getTickIntervalMs,
  isFlusherEnabled,
  computeRetryAfterTimestamp,
  FLUSH_BATCH_LIMIT,
  STARTUP_RECOVERY_STALE_MS,
  SHUTDOWN_RECOVERY_STALE_MS,
  MIN_TICK_SECONDS,
  MAX_TICK_SECONDS,
  DEFAULT_TICK_SECONDS,
  type OutboxDB,
  type EnqueueInput,
  type ClaimedOutboxRow,
  type OutboxPersistHelpers,
  type DispatchOutcome,
  type OutboxDispatcher,
  type OutboxStatus,
  type FlushResult,
  type RecoveryResult,
} from "./outbox";

export {
  nextDelayMs,
  DEAD_AFTER_ATTEMPTS,
  CLAIM_DELAY_SQL,
} from "./backoff";

export { classifyHttpStatus, type Classification } from "./classify";

export {
  queryDepthSnapshot,
  getWarnThreshold,
  OutboxWarnRateLimiter,
  DEFAULT_WARN_THRESHOLD,
  WARN_INTERVAL_MS,
  MIN_WARN_THRESHOLD,
  MAX_WARN_THRESHOLD,
  type OutboxDepthSnapshot,
  type WarnDecision,
} from "./depth";

export {
  runOutboxTick,
  type OutboxTickDeps,
  type OutboxTickResult,
  type GaugeRecorder,
  type OutboxTickLogger,
} from "./tick";
