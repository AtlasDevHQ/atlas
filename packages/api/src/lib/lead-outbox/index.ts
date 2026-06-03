/**
 * Public surface of the lead-outbox module (#2729). Generic queue
 * mechanics live here; the Twenty-specific dispatcher lives in
 * `ee/src/saas-crm/index.ts` so the core → ee inversion stays enforced.
 */

export {
  enqueue,
  recoverInFlight,
  flushBatch,
  getBackstopSweepIntervalMs,
  isFlusherEnabled,
  computeRetryAfterTimestamp,
  computeRetryDelayMs,
  FLUSH_BATCH_LIMIT,
  STARTUP_RECOVERY_STALE_MS,
  SHUTDOWN_RECOVERY_STALE_MS,
  MIN_BACKSTOP_SWEEP_SECONDS,
  MAX_BACKSTOP_SWEEP_SECONDS,
  DEFAULT_BACKSTOP_SWEEP_SECONDS,
  type OutboxDB,
  type EnqueueInput,
  type ClaimedOutboxRow,
  type OutboxPersistHelpers,
  type DispatchOutcome,
  type OutboxDispatcher,
  type OutboxRetryScheduler,
  type OutboxStatus,
  type FlushResult,
  type RecoveryResult,
} from "./outbox";

export {
  FlusherSignal,
  setActiveFlusherSignal,
  getActiveFlusherSignal,
  kickActiveFlusher,
  clampRetryDelay,
  MAX_RETRY_TIMER_MS,
  type SignalTimers,
  type WaitReason,
} from "./signal";

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
  drainOutbox,
  observeOutboxDepth,
  MAX_DRAIN_BATCHES,
  type OutboxTickDeps,
  type OutboxObserveDeps,
  type OutboxObservePolicy,
  type OutboxDrainResult,
  type OutboxObserveResult,
  type GaugeRecorder,
  type OutboxTickLogger,
} from "./tick";
