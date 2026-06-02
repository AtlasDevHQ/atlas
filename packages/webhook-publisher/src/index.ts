/**
 * `@useatlas/webhook-publisher` — framework-free outbound webhook sender.
 *
 * Unifies Atlas's outbound senders (sub-processor change feed, SLA alerts,
 * webhook-action plugin) onto one `deliverWebhook` primitive with pluggable
 * HMAC signing strategies, so no consumer's on-the-wire format drifts.
 *
 * @example
 * ```ts
 * import { deliverWebhook, timestamped, cappedExponentialDelays } from "@useatlas/webhook-publisher";
 *
 * const outcome = await deliverWebhook({
 *   url: subscription.url,
 *   payload: event,
 *   sign: timestamped({ secret: token }),
 *   retry: { maxAttempts: 3, delaysMs: cappedExponentialDelays({ baseMs: 1000, count: 2 }) },
 *   timeoutMs: 10_000,
 * });
 * if (outcome.kind !== "ok") log.warn({ outcome }, "delivery failed");
 * ```
 */

export { deliverWebhook, cappedExponentialDelays } from "./deliver";
export type {
  DeliverWebhookOptions,
  DeliveryOutcome,
  RetryPolicy,
  Fetcher,
  FailedAttempt,
  AttemptFailure,
} from "./deliver";

export { timestamped, rawBody } from "./sign";
export type { SignStrategy, SignedRequest } from "./sign";
