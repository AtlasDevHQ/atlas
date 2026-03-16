/**
 * Webhook integration routes.
 *
 * - POST /webhook/:channelId — inbound webhook endpoint
 *
 * Authentication is per-channel: API key via `X-Webhook-Secret` header,
 * or HMAC-SHA256 via `X-Webhook-Signature` header.
 *
 * Async mode provides at-most-once delivery — no retry on callback failure.
 */

import crypto from "crypto";
import { Hono } from "hono";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import type { WebhookChannel, WebhookPluginConfig, WebhookQueryResult } from "./config";

// ---------------------------------------------------------------------------
// Runtime dependency interface
// ---------------------------------------------------------------------------

export interface WebhookRuntimeDeps {
  channels: Map<string, WebhookChannel>;
  log: PluginLogger;
  executeQuery: WebhookPluginConfig["executeQuery"];
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function verifyApiKey(
  channel: WebhookChannel,
  request: Request,
): boolean {
  const provided = request.headers.get("x-webhook-secret");
  if (!provided) return false;
  const expected = Buffer.from(channel.secret);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function verifyHmac(
  channel: WebhookChannel,
  body: string,
  request: Request,
): boolean {
  const signature = request.headers.get("x-webhook-signature");
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", channel.secret)
    .update(body)
    .digest("hex");

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// ---------------------------------------------------------------------------
// Callback URL validation — prevents SSRF via request-body overrides
// ---------------------------------------------------------------------------

function isAllowedCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const hostname = parsed.hostname;
    if (
      hostname === "localhost" ||
      hostname === "[::1]" ||
      hostname.startsWith("127.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname === "169.254.169.254" ||
      // 172.16.0.0/12
      (hostname.startsWith("172.") && (() => {
        const second = parseInt(hostname.split(".")[1], 10);
        return second >= 16 && second <= 31;
      })())
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

function formatResult(result: WebhookQueryResult, format: "json" | "text") {
  if (format === "text") {
    return { success: true as const, result: result.answer };
  }
  return {
    success: true as const,
    result: {
      answer: result.answer,
      sql: result.sql,
      columns: result.data[0]?.columns ?? [],
      rows: result.data[0]?.rows ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createWebhookRoutes(deps: WebhookRuntimeDeps): Hono {
  const webhook = new Hono();
  const { channels, log } = deps;

  webhook.post("/webhook/:channelId", async (c) => {
    const channelId = c.req.param("channelId");

    const channel = channels.get(channelId);
    if (!channel) {
      log.warn({ channelId }, "Webhook request for unknown channel");
      return c.json({ error: "Unknown channel" }, 404);
    }

    const body = await c.req.raw.clone().text();

    if (channel.authType === "api-key") {
      if (!verifyApiKey(channel, c.req.raw)) {
        log.warn({ channelId }, "Webhook API key verification failed");
        return c.json({ error: "Invalid authentication" }, 401);
      }
    } else {
      if (!verifyHmac(channel, body, c.req.raw)) {
        log.warn({ channelId }, "Webhook HMAC verification failed");
        return c.json({ error: "Invalid signature" }, 401);
      }
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), channelId },
        "Webhook received invalid JSON body",
      );
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const query = payload.query;
    if (!query || typeof query !== "string" || !query.trim()) {
      return c.json({ error: "Missing or empty query" }, 400);
    }

    // Determine callback URL: request-level overrides channel-level
    const rawCallbackUrl =
      (typeof payload.callbackUrl === "string" ? payload.callbackUrl : undefined) ??
      channel.callbackUrl;

    // Validate callback URL to prevent SSRF
    let callbackUrl: string | undefined;
    if (rawCallbackUrl) {
      if (!isAllowedCallbackUrl(rawCallbackUrl)) {
        return c.json({ error: "Invalid callback URL" }, 400);
      }
      callbackUrl = rawCallbackUrl;
    }

    const responseFormat = channel.responseFormat ?? "json";

    // Async mode: accept immediately, deliver result to callbackUrl when done.
    // At-most-once delivery — failed deliveries are logged but not retried.
    if (callbackUrl) {
      const requestId = crypto.randomUUID();
      log.info({ channelId, requestId, query: query.slice(0, 100) }, "Webhook async request accepted");

      const deliverCallback = async (payload: Record<string, unknown>) => {
        try {
          const resp = await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30_000),
          });
          if (!resp.ok) {
            log.error({ channelId, requestId, status: resp.status }, "Callback delivery failed");
          }
        } catch (fetchErr) {
          log.error(
            { err: fetchErr instanceof Error ? fetchErr.message : String(fetchErr), channelId, requestId },
            "Callback delivery request failed",
          );
        }
      };

      const processAsync = async () => {
        try {
          const result = await deps.executeQuery(query);
          await deliverCallback({ requestId, ...formatResult(result, responseFormat) });
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err.message : String(err), channelId, requestId },
            "Webhook async query execution failed",
          );
          // Deliver error to callback so the caller knows the request failed
          await deliverCallback({ requestId, success: false, error: "Query execution failed" });
        }
      };

      processAsync().catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err), channelId, requestId },
          "Unhandled error in webhook async processing",
        );
      });

      return c.json({ accepted: true, requestId }, 202);
    }

    // Synchronous mode
    log.info({ channelId, query: query.slice(0, 100) }, "Webhook sync request");

    try {
      const result = await deps.executeQuery(query);
      return c.json(formatResult(result, responseFormat));
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), channelId },
        "Webhook query execution failed",
      );
      return c.json({ error: "Query execution failed" }, 500);
    }
  });

  return webhook;
}
