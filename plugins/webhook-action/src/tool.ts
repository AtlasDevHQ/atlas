/**
 * Webhook tool — outbound HTTPS POST with HMAC-SHA256 signing.
 *
 * The signature header is `X-Atlas-Signature` — hex of
 * `HMAC_SHA256(signing_secret, raw_body)`. Receivers verify by
 * computing the same MAC over the raw request body and constant-
 * time comparing against the header. This is the same shape as the
 * Stripe / GitHub / Shopify webhook conventions.
 *
 * The signing + retry + per-attempt timeout internals come from
 * `@useatlas/webhook-publisher` (strategy `rawBody`) — the shared
 * primitive that backs all three of Atlas's outbound senders. The
 * on-the-wire format is unchanged: `rawBody` emits the same bare-hex
 * `X-Atlas-Signature` + `Content-Type: application/json`, and the
 * `none` / `exponential` retry policy + 30s timeout are preserved.
 */

import { deliverWebhook, rawBody, type RetryPolicy } from "@useatlas/webhook-publisher";
import { tool } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config type — `index.ts` validates this shape via Zod at factory time.
// ---------------------------------------------------------------------------

export interface WebhookActionPluginConfig {
  /** Destination URL — must be https. */
  readonly url: string;
  /** HMAC-SHA256 signing secret. */
  readonly signing_secret: string;
  /** Retry behavior on 5xx / network failure. Defaults to "exponential". */
  readonly retry_policy?: "none" | "exponential";
  /** Optional approval mode. Defaults to "admin-only" for safety. */
  readonly approvalMode?: "auto" | "manual" | "admin-only";
}

// ---------------------------------------------------------------------------
// HMAC signature
// ---------------------------------------------------------------------------

/**
 * Compute `X-Atlas-Signature` for a given body. Exported for tests and
 * for receiver-side verification helpers that ship with the docs.
 * Delegates to the `rawBody` signing strategy from
 * `@useatlas/webhook-publisher` — identical bare-hex
 * `HMAC_SHA256(signing_secret, body)`.
 */
export function hmacSign(signingSecret: string, body: string): string {
  return rawBody({ secret: signingSecret })(body).signature;
}

// ---------------------------------------------------------------------------
// Raw POST (config-driven)
// ---------------------------------------------------------------------------

export interface WebhookPostParams {
  /** JSON-serializable payload. Stringified to a stable form before signing. */
  payload: unknown;
}

export interface WebhookPostResult {
  /** Destination's HTTP status code. */
  status: number;
  /** Hex-encoded HMAC of the request body — surfaced for audit / debugging. */
  signature: string;
}

/**
 * Exponential ramp for transient 5xx / network failures. Total budget
 * ~5.25s across 4 attempts — short enough that the agent loop's
 * tool-call timeout doesn't fire mid-retry, long enough that a brief
 * destination blip recovers without surfacing as a tool failure.
 * Supplied to `deliverWebhook` as the `delaysMs` schedule (one extra
 * attempt than gaps → `maxAttempts = RETRY_DELAYS_MS.length + 1`).
 */
const RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

/** Per-attempt timeout — matches the pre-extraction sender. */
const TIMEOUT_MS = 30_000;

export async function executeWebhookPost(
  config: WebhookActionPluginConfig,
  params: WebhookPostParams,
): Promise<WebhookPostResult> {
  const retryPolicy = config.retry_policy ?? "exponential";
  const retry: RetryPolicy =
    retryPolicy === "exponential"
      ? { maxAttempts: RETRY_DELAYS_MS.length + 1, delaysMs: RETRY_DELAYS_MS }
      : { maxAttempts: 1, delaysMs: [] };

  const outcome = await deliverWebhook({
    url: config.url,
    payload: params.payload,
    sign: rawBody({ secret: config.signing_secret }),
    retry,
    timeoutMs: TIMEOUT_MS,
    onFailedAttempt: ({ attempt, maxAttempts, failure }) => {
      // Plugins have no logger context handle here (initialize ctx is not
      // threaded into the tool execute closure); console.warn is the only
      // breadcrumb path. Visible in the agent loop's stderr so an operator
      // can correlate retries with destination outages. Only retryable
      // failures log — the pre-extraction code never logged a breadcrumb
      // for a 4xx (it threw immediately).
      if (failure.kind === "transport_error") {
        console.warn(
          `[webhook-action] attempt ${attempt}/${maxAttempts} failed: ${failure.error}`,
        );
      } else if (failure.status >= 500) {
        console.warn(
          `[webhook-action] attempt ${attempt}/${maxAttempts} returned HTTP ${failure.status}`,
        );
      }
    },
  });

  if (outcome.kind === "ok") {
    return { status: outcome.status, signature: outcome.signature };
  }
  if (outcome.kind === "http_error") {
    // The package reads a bounded body excerpt only for permanent (4xx)
    // rejections with a non-empty readable body, so `responseText` is
    // present exactly where the old `safeErrorDetail` appended one and
    // absent for an exhausted 5xx (or an empty/unreadable 4xx body).
    throw new Error(
      `Webhook POST failed: HTTP ${outcome.status}${outcome.responseText ? ` — ${outcome.responseText}` : ""}`,
    );
  }
  // transport_error — network blip / timeout, retries exhausted.
  throw new Error(outcome.error);
}

// ---------------------------------------------------------------------------
// AI SDK tool factory
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = `POST a JSON payload to the configured outbound webhook with HMAC-SHA256 signing.`;

export function createWebhookTool(config: WebhookActionPluginConfig) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: z.object({
      payload: z
        .unknown()
        .describe("JSON-serializable payload. Sent as the POST body and signed with HMAC-SHA256."),
    }),
    execute: async ({ payload }) => executeWebhookPost(config, { payload }),
  });
}
