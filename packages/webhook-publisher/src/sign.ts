/**
 * Pluggable HMAC-SHA256 signing strategies for outbound webhooks.
 *
 * Atlas ships two on-the-wire conventions, both kept here so no consumer's
 * format ever drifts:
 *
 *   timestamped (house standard — sub-processor feed + SLA alerts)
 *     X-Webhook-Signature: sha256=<hmac(`${ts}:${body}`)>
 *     X-Webhook-Timestamp: <unix-seconds>
 *     Verified by the inbound `@useatlas/webhook` plugin
 *     (`verifyHmacWithTimestamp`) and the customer verify-helper in the
 *     sub-processor-feed docs. The `sha256=` prefix is Stripe/GitHub style.
 *
 *   rawBody (Stripe/GitHub style — webhook-action plugin)
 *     X-Atlas-Signature: <hmac(rawBody)>
 *     No timestamp, no prefix — bare hex over the exact request body.
 *
 * A strategy is a pure function of the serialized body. `deliverWebhook`
 * signs the body exactly once and reuses the headers across retries, so the
 * timestamp (when present) is stable for the whole delivery — matching the
 * pre-extraction senders byte-for-byte.
 */

import crypto from "node:crypto";

const CONTENT_TYPE_JSON = "application/json";

/** The signature value plus the full header set to send with the request. */
export interface SignedRequest {
  /**
   * The value placed in the signature header — surfaced so callers can echo
   * it back for audit (the webhook-action plugin returns it to the agent).
   * For `timestamped` this includes the `sha256=` prefix; for `rawBody` it is
   * bare hex.
   */
  readonly signature: string;
  /** Headers to merge into the outbound request, including `Content-Type`. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A signing strategy: given the serialized request body, produce the
 * signature and the headers that carry it. Pure and synchronous.
 */
export type SignStrategy = (body: string) => SignedRequest;

/**
 * Timestamped strategy — `X-Webhook-Signature: sha256=<hmac(`${ts}:${body}`)>`
 * plus `X-Webhook-Timestamp`. This is the Atlas house standard, matched by the
 * inbound verifier and the documented customer verify-helper.
 *
 * The timestamp is captured when the strategy is built (immediately before
 * delivery) so it is identical across every retry of a single delivery.
 * Inject `timestampSeconds` for deterministic tests.
 */
export function timestamped(opts: {
  readonly secret: string;
  /** Unix seconds. Defaults to `Math.floor(Date.now() / 1000)`. */
  readonly timestampSeconds?: number;
}): SignStrategy {
  const ts = opts.timestampSeconds ?? Math.floor(Date.now() / 1000);
  return (body) => {
    const signature = `sha256=${crypto
      .createHmac("sha256", opts.secret)
      .update(`${ts}:${body}`)
      .digest("hex")}`;
    return {
      signature,
      headers: {
        "Content-Type": CONTENT_TYPE_JSON,
        "X-Webhook-Timestamp": String(ts),
        "X-Webhook-Signature": signature,
      },
    };
  };
}

/**
 * Raw-body strategy — `X-Atlas-Signature: <hmac(rawBody)>` (bare hex, no
 * timestamp). Stripe/GitHub/Shopify webhook convention; receivers verify by
 * recomputing the MAC over the raw request body.
 */
export function rawBody(opts: { readonly secret: string }): SignStrategy {
  return (body) => {
    const signature = crypto
      .createHmac("sha256", opts.secret)
      .update(body)
      .digest("hex");
    return {
      signature,
      headers: {
        "Content-Type": CONTENT_TYPE_JSON,
        "X-Atlas-Signature": signature,
      },
    };
  };
}
