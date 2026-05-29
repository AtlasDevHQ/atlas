/**
 * Public surface of the email-outbox module (#2942). A stripped-down
 * mirror of `lib/lead-outbox/`: durable queue for transactional email
 * (password reset, signup verification OTP) so a SUSTAINED provider
 * outage no longer permanently drops a send. Generic queue mechanics
 * live in `outbox.ts`; the concrete dispatcher (wrapping `sendEmail`)
 * lives in `dispatch.ts`.
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
  type EmailOutboxDB,
  type EmailOutboxMessage,
  type EnqueueEmailInput,
  type ClaimedEmailRow,
  type EmailDispatchOutcome,
  type EmailDispatcher,
  type EmailOutboxStatus,
  type FlushResult,
  type RecoveryResult,
} from "./outbox";

export { nextDelayMs, DEAD_AFTER_ATTEMPTS, CLAIM_DELAY_SQL } from "./backoff";

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
  runEmailOutboxTick,
  type OutboxTickDeps,
  type OutboxTickResult,
  type GaugeRecorder,
  type OutboxTickLogger,
} from "./tick";

export { makeEmailDispatcher, type EmailSendFn } from "./dispatch";
