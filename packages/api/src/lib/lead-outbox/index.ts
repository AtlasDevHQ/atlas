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
  FLUSH_BATCH_LIMIT,
  type OutboxDB,
  type EnqueueInput,
  type ClaimedOutboxRow,
  type OutboxPersistHelpers,
  type DispatchOutcome,
  type OutboxDispatcher,
  type FlushResult,
} from "./outbox";

export {
  nextDelayMs,
  DEAD_AFTER_ATTEMPTS,
  CLAIM_DELAY_SQL,
} from "./backoff";

export { classifyHttpStatus, type Classification } from "./classify";
