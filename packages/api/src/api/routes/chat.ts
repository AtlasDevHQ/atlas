/**
 * Chat route — accepts a conversation and streams agent responses.
 *
 * Middleware stack:
 * auth → rate limit → withRequestContext → validateEnvironment → conversation persistence → runAgent → stream.
 */

import { Hono } from "hono";
import { z } from "zod";
import { type UIMessage } from "ai";
import { APICallError, LoadAPIKeyError, NoSuchModelError } from "ai";
import { runAgent } from "@atlas/api/lib/agent";
import { validateEnvironment } from "@atlas/api/lib/startup";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";
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

const log = createLogger("chat");

// ---------------------------------------------------------------------------
// Zod schemas — exported for OpenAPI spec generation
// ---------------------------------------------------------------------------

const MessagePartSchema = z.object({ type: z.string() }).passthrough();

const UIMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(MessagePartSchema),
  id: z.string(),
});

export const ChatRequestSchema = z.object({
  messages: z.array(UIMessageSchema).min(1),
  conversationId: z.string().uuid().optional(),
});

const chat = new Hono();

chat.post("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  // Auth check — before context so user identity is available to all downstream logs
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        requestId,
      },
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

  // Rate limit check — after auth so we have user identity
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

  // withRequestContext binds requestId + user to AsyncLocalStorage for the
  // entire async call chain (including logQueryAudit deep inside executeSQL).
  return withRequestContext(
    { requestId, user: authResult.user },
    async () => {
      // Startup diagnostics — fast-fail with actionable errors
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

      // Datasource guard — diagnostics pass (it's a warning) but chat requires a datasource
      const { resolveDatasourceUrl } = await import("@atlas/api/lib/db/connection");
      if (!resolveDatasourceUrl()) {
        return c.json(
          {
            error: "no_datasource",
            message:
              "No analytics datasource configured. Set ATLAS_DATASOURCE_URL to query your data.",
          },
          400,
        );
      }

      // Parse request body separately so malformed JSON gets a 400, not 500
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

      const parsed = ChatRequestSchema.safeParse(body);
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

      const messages = parsed.data.messages as UIMessage[];
      let conversationId = parsed.data.conversationId;

      // Conversation persistence — Ownership verification blocks here (can 404); message writes are fire-and-forget via internalExecute.
      if (hasInternalDB()) {
        if (conversationId) {
          // Ownership verification — NOT best-effort, this is a security check
          const existing = await getConversation(conversationId, authResult.user?.id);
          if (!existing.ok) {
            return c.json({ error: "not_found", message: "Conversation not found." }, 404);
          }
          // Persist the latest user message
          try {
            const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
            if (lastUserMsg) {
              addMessage({ conversationId, role: "user", content: lastUserMsg.parts });
            }
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to persist user message");
          }
        } else {
          try {
            // Create new conversation — best-effort
            const firstUserMsg = messages.find((m) => m.role === "user");
            const title = firstUserMsg
              ? generateTitle(
                  firstUserMsg.parts
                    ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
                    .map((p) => p.text)
                    .join(" ") ?? "",
                )
              : "New conversation";
            const created = await createConversation({
              userId: authResult.user?.id,
              title,
              surface: "web",
            });
            if (created) conversationId = created.id;
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to create conversation");
          }
        }
      }

      try {
        // Build a dynamic registry when actions are enabled
        let toolRegistry;
        const includeActions = process.env.ATLAS_ACTIONS_ENABLED === "true";
        if (includeActions) {
          try {
            const { buildRegistry } = await import("@atlas/api/lib/tools/registry");
            toolRegistry = await buildRegistry({ includeActions });
          } catch (err) {
            log.error(
              { err: err instanceof Error ? err : new Error(String(err)) },
              "Failed to build tool registry — falling back to default tools",
            );
          }
        }

        // Merge plugin tools (if any) on top of the current registry
        const { getPluginTools } = await import("@atlas/api/lib/plugins/tools");
        const pluginTools = getPluginTools();
        if (pluginTools) {
          const { ToolRegistry, defaultRegistry } = await import("@atlas/api/lib/tools/registry");
          const base = toolRegistry ?? defaultRegistry;
          toolRegistry = ToolRegistry.merge(base, pluginTools);
          toolRegistry.freeze();
        }

        const result = await runAgent({ messages, ...(toolRegistry && { tools: toolRegistry }) });
        const streamResponse = result.toUIMessageStreamResponse();

        // Set conversation ID header so the client can track continuity
        if (conversationId) {
          streamResponse.headers.set("x-conversation-id", conversationId);

          // Fire-and-forget: persist assistant response after stream completes
          const cid = conversationId;
          void Promise.resolve(result.text)
            .then((text) => {
              addMessage({ conversationId: cid, role: "assistant", content: [{ type: "text", text }] });
            })
            .catch((err: unknown) => {
              log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to persist assistant message");
            });
        }

        return streamResponse;
      } catch (err) {
        const message = err instanceof Error ? err.message : "";

        // --- Structured AI SDK error types (checked first) ---

        if (GatewayModelNotFoundError.isInstance(err)) {
          log.error(
            {
              err: err instanceof Error ? err : new Error(String(err)),
              category: "provider_model_not_found",
            },
            "Gateway model not found",
          );
          return c.json(
            {
              error: "provider_model_not_found",
              message:
                "Model not found on the AI Gateway. Check that your ATLAS_MODEL uses the correct provider/model format (e.g., anthropic/claude-sonnet-4.6).",
            },
            400,
          );
        }

        if (NoSuchModelError.isInstance(err)) {
          log.error(
            {
              err: err instanceof Error ? err : new Error(String(err)),
              category: "provider_model_not_found",
            },
            "Model not found",
          );
          return c.json(
            {
              error: "provider_model_not_found",
              message:
                "The configured model was not found. Check ATLAS_MODEL and ATLAS_PROVIDER settings.",
            },
            400,
          );
        }

        if (LoadAPIKeyError.isInstance(err)) {
          log.error(
            {
              err: err instanceof Error ? err : new Error(String(err)),
              category: "provider_auth_error",
            },
            "API key not loaded",
          );
          return c.json(
            {
              error: "provider_auth_error",
              message:
                "LLM provider API key could not be loaded. Check that the required API key environment variable is set.",
            },
            503,
          );
        }

        // APICallError carries the HTTP status code from the provider response
        if (APICallError.isInstance(err)) {
          const status = err.statusCode;

          if (status === 401 || status === 403) {
            log.error(
              {
                err: err instanceof Error ? err : new Error(String(err)),
                category: "provider_auth_error",
                statusCode: status,
              },
              "Provider auth error",
            );
            return c.json(
              {
                error: "provider_auth_error",
                message:
                  "LLM provider authentication failed. Check that your API key is valid and has not expired.",
              },
              503,
            );
          }

          if (status === 429) {
            log.error(
              {
                err: err instanceof Error ? err : new Error(String(err)),
                category: "provider_rate_limit",
                statusCode: status,
              },
              "Provider rate limit",
            );
            return c.json(
              {
                error: "provider_rate_limit",
                message:
                  "LLM provider rate limit reached. Wait a moment and try again.",
              },
              503,
            );
          }

          if (status === 408 || /timeout/i.test(message)) {
            log.error(
              {
                err: err instanceof Error ? err : new Error(String(err)),
                category: "provider_timeout",
                statusCode: status,
              },
              "Request timed out",
            );
            return c.json(
              {
                error: "provider_timeout",
                message:
                  "The request timed out. The LLM provider took too long to respond. " +
                  "Try again, or if using a local model, ensure it has sufficient resources.",
              },
              504,
            );
          }

          // Catch-all for any other APICallError status codes (5xx, etc.)
          log.error(
            {
              err: err instanceof Error ? err : new Error(String(err)),
              category: "provider_error",
              statusCode: status,
            },
            "Provider error",
          );
          return c.json(
            {
              error: "provider_error",
              message: `The LLM provider returned an error (HTTP ${status}). This is usually a temporary issue. Try again in a moment.`,
            },
            502,
          );
        }

        // --- Regex fallbacks for non-APICallError exceptions ---

        if (/timeout|timed out|AbortError/i.test(message)) {
          log.error(
            {
              err: err instanceof Error ? err : new Error(String(err)),
              category: "provider_timeout",
            },
            "Request timed out",
          );
          return c.json(
            {
              error: "provider_timeout",
              message:
                "The request timed out. The LLM provider took too long to respond. " +
                "Try again, or if using a local model, ensure it has sufficient resources.",
            },
            504,
          );
        }

        if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
          log.error(
            {
              err: err instanceof Error ? err : new Error(String(err)),
              category: "provider_unreachable",
            },
            "Provider unreachable",
          );
          return c.json(
            {
              error: "provider_unreachable",
              message:
                "Could not reach the LLM provider. Check your network connection and provider status.",
            },
            503,
          );
        }

        // Fallback — safe 500 with requestId for correlation
        log.error(
          {
            err: err instanceof Error ? err : new Error(String(err)),
            category: "internal_error",
          },
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

export { chat };
