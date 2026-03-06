/**
 * Synchronous JSON query endpoint — programmatic access to the Atlas agent.
 *
 * POST /api/v1/query accepts a plain question, runs the agent to completion,
 * and returns a structured JSON response with the answer, SQL queries, data,
 * step count, and token usage.
 *
 * Middleware chain follows the same auth → rate limit → context → validate → agent
 * pattern as chat.ts, but returns structured JSON instead of a stream and adds
 * Zod request validation.
 */

import { Hono } from "hono";
import { z } from "zod";
import { APICallError, LoadAPIKeyError, NoSuchModelError } from "ai";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";
import { executeAgentQuery } from "@atlas/api/lib/agent-query";
import { validateEnvironment } from "@atlas/api/lib/startup";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  createConversation,
  addMessage,
  getConversation,
  generateTitle,
} from "@atlas/api/lib/conversations";


const log = createLogger("query");

export const QueryRequestSchema = z.object({
  question: z.string().trim().min(1, "question must not be empty"),
  conversationId: z.string().uuid().optional(),
});

export const QueryResponseSchema = z.object({
  answer: z.string(),
  sql: z.array(z.string()),
  data: z.array(
    z.object({
      columns: z.array(z.string()),
      rows: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
  steps: z.number().int(),
  usage: z.object({
    totalTokens: z.number().int(),
  }),
  pendingActions: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        target: z.string(),
        summary: z.string(),
        approveUrl: z.string(),
        denyUrl: z.string(),
      }),
    )
    .optional(),
});

/**
 * Derive the public base URL for constructing action approve/deny URLs.
 * Prefers ATLAS_PUBLIC_URL env var, otherwise derives from the request.
 */
function deriveBaseUrl(req: Request): string {
  if (process.env.ATLAS_PUBLIC_URL) {
    return process.env.ATLAS_PUBLIC_URL.replace(/\/$/, "");
  }
  const url = new URL(req.url);
  if (process.env.ATLAS_TRUST_PROXY === "true") {
    const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
    return `${proto}://${host}`;
  }
  log.warn("ATLAS_PUBLIC_URL not set — deriving action URLs from request. Set ATLAS_PUBLIC_URL in production");
  return `${url.protocol}//${url.host}`;
}

const query = new Hono();

query.post("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  // --- Auth ---
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return c.json(
      { error: "auth_error", message: "Authentication system error" },
      500,
    );
  }
  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    return c.json(
      { error: "auth_error", message: authResult.error },
      authResult.status as 401 | 403 | 500,
    );
  }

  // --- Rate limit ---
  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    log.warn(
      { requestId, rateLimitKey, retryAfterMs: rateCheck.retryAfterMs },
      "Rate limit exceeded",
    );
    const retryAfterSeconds = Math.ceil(
      (rateCheck.retryAfterMs ?? 60000) / 1000,
    );
    return c.json(
      {
        error: "rate_limited",
        message: "Too many requests. Please wait before trying again.",
        retryAfterSeconds,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  return withRequestContext(
    { requestId, user: authResult.user },
    async () => {
      // --- Startup diagnostics ---
      const diagnostics = await validateEnvironment();
      if (diagnostics.length > 0) {
        return c.json(
          {
            error: "configuration_error",
            message: diagnostics.map((d) => d.message).join("\n\n"),
            diagnostics,
          },
          400,
        );
      }

      const { resolveDatasourceUrl: resolveUrl } = await import("@atlas/api/lib/db/connection");
      if (!resolveUrl()) {
        return c.json(
          {
            error: "no_datasource",
            message:
              "No analytics datasource configured. Set ATLAS_DATASOURCE_URL to query your data.",
          },
          400,
        );
      }

      // --- Parse & validate request body ---
      let body: unknown;
      try {
        body = await c.req.json();
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Failed to parse request body",
        );
        return c.json(
          {
            error: "invalid_request",
            message: "Invalid JSON body.",
          },
          400,
        );
      }

      const parsed = QueryRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: "validation_error",
            message: "Invalid request body.",
            details: parsed.error.issues,
          },
          422,
        );
      }

      const { question } = parsed.data;
      let conversationId = parsed.data.conversationId;

      try {
        const queryResult = await executeAgentQuery(question, requestId);

        // Persist conversation — best-effort. createConversation awaits an INSERT; addMessage calls are fire-and-forget.
        if (hasInternalDB()) {
          try {
            if (conversationId) {
              // Verify ownership before appending to existing conversation
              const existing = await getConversation(conversationId, authResult.user?.id);
              if (!existing.ok) {
                log.warn({ conversationId, userId: authResult.user?.id }, "Conversation not found or not owned — skipping persistence");
                conversationId = undefined;
              }
            }
            if (!conversationId) {
              const created = await createConversation({
                userId: authResult.user?.id,
                title: generateTitle(question),
                surface: "api",
              });
              if (created) conversationId = created.id;
            }
            if (conversationId) {
              addMessage({ conversationId, role: "user", content: [{ type: "text", text: question }] });
              addMessage({ conversationId, role: "assistant", content: [{ type: "text", text: queryResult.answer }] });
            }
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Conversation persistence failed");
          }
        }

        // Enrich pending actions with approve/deny URLs
        let enrichedPendingActions: {
          id: string;
          type: string;
          target: string;
          summary: string;
          approveUrl: string;
          denyUrl: string;
        }[] | undefined;

        if (queryResult.pendingActions?.length) {
          const baseUrl = deriveBaseUrl(req);
          enrichedPendingActions = queryResult.pendingActions.map((a) => ({
            ...a,
            approveUrl: `${baseUrl}/api/v1/actions/${a.id}/approve`,
            denyUrl: `${baseUrl}/api/v1/actions/${a.id}/deny`,
          }));
        }

        return c.json({
          ...queryResult,
          ...(conversationId && { conversationId }),
          ...(enrichedPendingActions && { pendingActions: enrichedPendingActions }),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "";

        // --- Structured AI SDK error types ---

        if (GatewayModelNotFoundError.isInstance(err)) {
          log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_model_not_found" }, "Gateway model not found");
          return c.json({ error: "provider_model_not_found", message: "Model not found on the AI Gateway. Check that your ATLAS_MODEL uses the correct provider/model format." }, 400);
        }

        if (NoSuchModelError.isInstance(err)) {
          log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_model_not_found" }, "Model not found");
          return c.json({ error: "provider_model_not_found", message: "The configured model was not found. Check ATLAS_MODEL and ATLAS_PROVIDER settings." }, 400);
        }

        if (LoadAPIKeyError.isInstance(err)) {
          log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_auth_error" }, "API key not loaded");
          return c.json({ error: "provider_auth_error", message: "LLM provider API key could not be loaded. Check that the required API key environment variable is set." }, 503);
        }

        if (APICallError.isInstance(err)) {
          const status = err.statusCode;
          if (status === 401 || status === 403) {
            log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_auth_error", statusCode: status }, "Provider auth error");
            return c.json({ error: "provider_auth_error", message: "LLM provider authentication failed. Check that your API key is valid and has not expired." }, 503);
          }
          if (status === 429) {
            log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_rate_limit", statusCode: status }, "Provider rate limit");
            return c.json({ error: "provider_rate_limit", message: "LLM provider rate limit reached. Wait a moment and try again." }, 503);
          }
          if (status === 408 || /timeout/i.test(message)) {
            log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_timeout", statusCode: status }, "Request timed out");
            return c.json({ error: "provider_timeout", message: "The request timed out. The LLM provider took too long to respond. Try again, or if using a local model, ensure it has sufficient resources." }, 504);
          }
          log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_error", statusCode: status }, "Provider error");
          return c.json({ error: "provider_error", message: `The LLM provider returned an error (HTTP ${status}). This is usually a temporary issue. Try again in a moment.` }, 502);
        }

        // --- Regex fallbacks ---

        if (/timeout|timed out|AbortError/i.test(message)) {
          log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_timeout" }, "Request timed out");
          return c.json({ error: "provider_timeout", message: "The request timed out. The LLM provider took too long to respond. Try again, or if using a local model, ensure it has sufficient resources." }, 504);
        }

        if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
          log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_unreachable" }, "Provider unreachable");
          return c.json({ error: "provider_unreachable", message: "Could not reach the LLM provider. Check your network connection and provider status." }, 503);
        }

        log.error(
          { err: err instanceof Error ? err : new Error(String(err)), category: "internal_error" },
          "Unexpected error",
        );
        return c.json(
          {
            error: "internal_error",
            message: `An unexpected error occurred (ref: ${requestId.slice(0, 8)}). If this persists, check the server logs.`,
          },
          500,
        );
      }
    },
  );
});

export { query };
