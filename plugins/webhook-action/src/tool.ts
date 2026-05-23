/**
 * Webhook tool — outbound HTTPS POST with HMAC-SHA256 signing.
 *
 * The signature header is `X-Atlas-Signature` — hex of
 * `HMAC_SHA256(signing_secret, raw_body)`. Receivers verify by
 * computing the same MAC over the raw request body and constant-
 * time comparing against the header. This is the same shape as the
 * Stripe / GitHub / Shopify webhook conventions.
 */

import crypto from "crypto";
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
 */
export function hmacSign(signingSecret: string, body: string): string {
  return crypto.createHmac("sha256", signingSecret).update(body).digest("hex");
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
 */
const RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

export async function executeWebhookPost(
  config: WebhookActionPluginConfig,
  params: WebhookPostParams,
): Promise<WebhookPostResult> {
  const body = JSON.stringify(params.payload);
  const signature = hmacSign(config.signing_secret, body);
  const retryPolicy = config.retry_policy ?? "exponential";

  const attempt = async (): Promise<Response> =>
    fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atlas-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });

  let lastError: unknown;
  const maxAttempts = retryPolicy === "exponential" ? RETRY_DELAYS_MS.length + 1 : 1;

  for (let i = 0; i < maxAttempts; i++) {
    let response: Response | null = null;
    try {
      response = await attempt();
    } catch (err) {
      // Network / timeout error — retryable under exponential, not under none.
      lastError = err;
      if (retryPolicy === "none") throw err;
      // Plugins have no logger context handle here (initialize ctx is
      // not threaded into the tool execute closure); console.warn is the
      // only breadcrumb path. Visible in the agent loop's stderr so an
      // operator can correlate retries with destination outages.
      console.warn(
        `[webhook-action] attempt ${i + 1}/${maxAttempts} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response) {
      if (response.ok) {
        return { status: response.status, signature };
      }
      // 4xx is a destination-side rejection — surface immediately even
      // under exponential. Only 5xx is treated as transient.
      if (response.status < 500) {
        const detail = await safeErrorDetail(response);
        throw new Error(
          `Webhook POST failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
        );
      }
      lastError = new Error(`Webhook POST failed: HTTP ${response.status}`);
      console.warn(
        `[webhook-action] attempt ${i + 1}/${maxAttempts} returned HTTP ${response.status}`,
      );
    }

    if (i < maxAttempts - 1) {
      await sleep(RETRY_DELAYS_MS[i] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Webhook POST failed: ${String(lastError)}`);
}

async function safeErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    // intentionally ignored: response body is unreadable (already consumed
    // or stream closed) — status code on the thrown error still carries
    // the signal; the body excerpt was a best-effort breadcrumb.
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
