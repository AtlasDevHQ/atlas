/**
 * Chat route — accepts a conversation and streams agent responses.
 *
 * Middleware stack:
 * withRequestId → auth → rate limit → withRequestContext(user) → validateEnvironment → conversation persistence → runAgent → stream.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { validationHook } from "./validation-hook";
import { withRequestId, type AuthEnv } from "./middleware";
import { z } from "zod";
import { type UIMessage, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { APICallError, LoadAPIKeyError, NoSuchModelError } from "ai";
import { matchError, isRetryableError, isChatErrorCode } from "@useatlas/types";
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
import { checkWorkspaceStatus } from "@atlas/api/lib/workspace";
import { checkAbuseStatus } from "@atlas/api/lib/security/abuse";
import { checkPlanLimits } from "@atlas/api/lib/billing/enforcement";
import {
  createConversation,
  addMessage,
  getConversation,
  generateTitle,
} from "@atlas/api/lib/conversations";
import { setStreamWriter, clearStreamWriter } from "@atlas/api/lib/tools/python-stream";
import { ErrorSchema } from "./shared-schemas";

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

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const chatRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Chat"],
  summary: "Chat with the agent (streaming)",
  description:
    "Sends a conversation to the Atlas agent and streams the response as Server-Sent Events using the Vercel AI SDK UI message stream protocol. " +
    "Each SSE event is a JSON object with a 'type' field: 'text-delta' for incremental text, 'tool-call' for tool invocations, " +
    "'tool-result' for tool outputs, 'step-start' for new agent steps, and 'finish' for completion. " +
    "The response includes an `x-conversation-id` header when conversation persistence is enabled.",
  request: {
    body: {
      content: { "application/json": { schema: ChatRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "SSE stream using the Vercel AI SDK UI message stream protocol. Each event is a JSON object with a 'type' field (text-delta, tool-call, tool-result, step-start, finish).",
      content: {
        "text/event-stream": { schema: z.string() },
      },
    },
    400: {
      description: "Bad request (malformed JSON, missing datasource, or invalid configuration)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Conversation not found (invalid conversationId)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error (invalid request body)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    502: {
      description: "LLM provider error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description: "Provider unreachable, auth error, or rate limited",
      content: { "application/json": { schema: ErrorSchema } },
    },
    504: {
      description: "Request timed out",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const chat = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

chat.use(withRequestId);

chat.openapi(chatRoute, async (c) => {
  const req = c.req.raw;
  const requestId = c.get("requestId");

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
      { error: "auth_error", message: "Authentication system error", retryable: false, requestId },
      500,
    );
  }
  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    const errorBody: Record<string, unknown> = { error: "auth_error", message: authResult.error, retryable: false, requestId };
    if (authResult.ssoRedirectUrl) {
      errorBody.ssoRedirectUrl = authResult.ssoRedirectUrl;
    }
    return c.json(
      errorBody,
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
        retryable: true,
        requestId,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  // IP allowlist check — enterprise feature, after auth so we have org context
  let checkIPAllowlist: ((orgId: string, clientIP: string | null) => Promise<{ allowed: boolean }>) | undefined;
  try {
    ({ checkIPAllowlist } = await import("@atlas/ee/auth/ip-allowlist"));
  } catch {
    // ee module not installed — IP allowlist feature unavailable, skip
  }
  if (checkIPAllowlist) {
    const orgId = authResult.user?.activeOrganizationId;
    if (orgId) {
      const ipCheck = await checkIPAllowlist(orgId, ip);
      if (!ipCheck.allowed) {
        log.warn({ requestId, orgId, ip }, "IP not in workspace allowlist");
        return c.json(
          { error: "ip_not_allowed", message: "Your IP address is not in the workspace's allowlist.", retryable: false, requestId },
          403,
        );
      }
    }
  }

  // Workspace status check — block suspended/deleted workspaces
  const wsCheck = await checkWorkspaceStatus(authResult.user?.activeOrganizationId);
  if (!wsCheck.allowed) {
    return c.json(
      { error: wsCheck.errorCode, message: wsCheck.errorMessage, retryable: wsCheck.errorCode && isChatErrorCode(wsCheck.errorCode) ? isRetryableError(wsCheck.errorCode) : false, requestId },
      wsCheck.httpStatus ?? 403,
    );
  }

  // Abuse check — block suspended workspaces, reject throttled ones with 429
  const abuseOrgId = authResult.user?.activeOrganizationId;
  if (abuseOrgId) {
    const abuse = checkAbuseStatus(abuseOrgId);
    if (abuse.level === "suspended") {
      log.warn({ requestId, orgId: abuseOrgId }, "Workspace suspended due to abuse");
      return c.json(
        { error: "workspace_suspended", message: "Workspace suspended due to unusual activity. Contact your administrator.", retryable: false, requestId },
        403,
      );
    }
    if (abuse.level === "throttled" && abuse.throttleDelayMs) {
      const retryAfterSeconds = Math.ceil(abuse.throttleDelayMs / 1000);
      log.warn({ requestId, orgId: abuseOrgId, delayMs: abuse.throttleDelayMs }, "Workspace throttled due to abuse");
      return c.json(
        {
          error: "workspace_throttled",
          message: "Workspace is temporarily throttled due to high usage. Please retry shortly.",
          retryable: true,
          retryAfterSeconds,
          requestId,
        },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }
  }

  // Plan limit check — block or warn when usage approaches/exceeds plan limits
  const planCheck = await checkPlanLimits(authResult.user?.activeOrganizationId);
  if (!planCheck.allowed) {
    return c.json(
      {
        error: planCheck.errorCode,
        message: planCheck.errorMessage,
        retryable: isChatErrorCode(planCheck.errorCode) ? isRetryableError(planCheck.errorCode) : false,
        requestId,
        ...(planCheck.errorCode === "plan_limit_exceeded" && { usage: planCheck.usage }),
      },
      planCheck.httpStatus,
    );
  }

  // Capture plan warning for response headers (set after stream is created)
  const planWarning = planCheck.allowed ? planCheck.warning : undefined;

  // Bind user to AsyncLocalStorage so downstream code (logQueryAudit, etc.)
  // has access to user identity. The middleware already set up requestId context;
  // this nested call adds the user after inline auth completes.
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
            retryable: false,
            requestId,
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
            retryable: false,
            requestId,
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
            retryable: false,
            requestId,
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
            retryable: false,
            requestId,
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
            return c.json({ error: "not_found", message: "Conversation not found.", retryable: false, requestId }, 404);
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
              orgId: authResult.user?.activeOrganizationId,
            });
            if (created) conversationId = created.id;
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to create conversation");
          }
        }
      }

      try {
        // Build a dynamic registry when actions are enabled
        let toolRegistry: import("@atlas/api/lib/tools/registry").ToolRegistry | undefined;
        const warnings: string[] = [];
        const includeActions = process.env.ATLAS_ACTIONS_ENABLED === "true";
        if (includeActions) {
          try {
            const { buildRegistry } = await import("@atlas/api/lib/tools/registry");
            const result = await buildRegistry({ includeActions });
            toolRegistry = result.registry;
            warnings.push(...result.warnings);
          } catch (err) {
            const errObj = err instanceof Error ? err : new Error(String(err));
            log.error(
              { err: errObj },
              "Failed to build tool registry — falling back to default tools",
            );
            warnings.push(
              "Actions were requested but the tool registry failed to build. Action tools are unavailable for this session. Inform the user that actions are currently unavailable and suggest they check server logs or retry later.",
            );
          }
        }

        // Merge plugin tools (if any) on top of the current registry
        const prePluginRegistry = toolRegistry;
        try {
          const { getPluginTools } = await import("@atlas/api/lib/plugins/tools");
          const pluginTools = getPluginTools();
          if (pluginTools) {
            const { ToolRegistry, defaultRegistry } = await import("@atlas/api/lib/tools/registry");
            const base = toolRegistry ?? defaultRegistry;
            toolRegistry = ToolRegistry.merge(base, pluginTools);
            toolRegistry.freeze();
          }
        } catch (err) {
          toolRegistry = prePluginRegistry;
          const errObj = err instanceof Error ? err : new Error(String(err));
          log.error(
            { err: errObj },
            "Failed to merge plugin tools — continuing without plugin tools",
          );
          warnings.push(
            `Plugin tools failed to load: ${errObj.message}. Chat will continue without plugin tools. Inform the user that plugin-provided tools are unavailable for this session.`,
          );
        }

        // Call runAgent first so errors (provider auth, config, etc.) are
        // caught by the outer try-catch and returned as proper JSON errors.
        // The agent stream is then merged into a UIMessageStream that supports
        // writing custom data parts (Python progress events).
        const agentResult = await runAgent({
          messages,
          ...(toolRegistry && { tools: toolRegistry }),
          conversationId,
          ...(warnings.length > 0 && { warnings }),
        });

        // Register stream writer so Python tool can send progress events.
        // The writer is set before merge() triggers tool execution reads.
        const stream = createUIMessageStream({
          execute: ({ writer }) => {
            // Surface plan warning as a data annotation so clients can display it
            if (planWarning) {
              writer.write({ type: "data-plan-warning", data: planWarning });
            }
            setStreamWriter(requestId, writer);
            writer.merge(agentResult.toUIMessageStream());
          },
          onFinish: () => {
            clearStreamWriter(requestId);
          },
          onError: (error) => {
            clearStreamWriter(requestId);
            log.error(
              { err: error instanceof Error ? error : new Error(String(error)), requestId },
              "Stream error",
            );
            return `An error occurred while generating a response (ref: ${requestId.slice(0, 8)}). Try sending your message again.`;
          },
        });

        const streamResponse = createUIMessageStreamResponse({
          stream,
          headers: {
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-transform",
            ...(conversationId ? { "x-conversation-id": conversationId } : {}),
            ...(planWarning ? { "x-plan-limit-warning": JSON.stringify(planWarning) } : {}),
          },
        });

        // Fire-and-forget: trigger onboarding "first query" milestone.
        // AtlasUser.label is the user's email in managed auth mode.
        if (authResult.user?.id && authResult.user.label?.includes("@")) {
          const uid = authResult.user.id;
          const uemail = authResult.user.label;
          const uorg = authResult.user.activeOrganizationId ?? "default";
          void import("@atlas/api/lib/email/hooks")
            .then(({ onFirstQueryExecuted }) => {
              onFirstQueryExecuted({ userId: uid, email: uemail, orgId: uorg });
            })
            .catch((err: unknown) => {
              log.debug({ err: err instanceof Error ? err.message : String(err) }, "Onboarding email hook not available — non-blocking");
            });
        }

        // Fire-and-forget: persist assistant response after stream completes.
        if (conversationId) {
          const cid = conversationId;
          void Promise.resolve(agentResult.text)
            .then((text) => {
              try {
                addMessage({ conversationId: cid, role: "assistant", content: [{ type: "text", text }] });
              } catch (persistErr) {
                log.warn({ err: persistErr instanceof Error ? persistErr.message : String(persistErr), conversationId: cid }, "Failed to persist assistant message");
              }
            })
            .catch((err: unknown) => {
              log.error({ err: err instanceof Error ? err.message : String(err), conversationId: cid }, "Agent stream failed — assistant response not available");
            });
        }

        // The streaming response is a raw Response from createUIMessageStreamResponse.
        // OpenAPIHono expects typed c.json() returns, but SSE streams bypass that.
        // Throw as HTTPException so the global onError handler returns the raw response
        // via getResponse(), bypassing the OpenAPI typed return requirement.
        throw new HTTPException(200, { res: streamResponse });
      } catch (err) {
        // Re-throw HTTPException (stream response) — handled by global onError
        if (err instanceof HTTPException) throw err;

        const errObj = err instanceof Error ? err : new Error(String(err));
        const message = errObj.message;

        // --- Structured AI SDK error types (checked first) ---

        if (GatewayModelNotFoundError.isInstance(err)) {
          log.error(
            { err: errObj, category: "provider_model_not_found" },
            "Gateway model not found",
          );
          return c.json(
            {
              error: "provider_model_not_found",
              message:
                "Model not found on the AI Gateway. Check that your ATLAS_MODEL uses the correct provider/model format (e.g., anthropic/claude-sonnet-4.6).",
              retryable: isRetryableError("provider_model_not_found"),
              requestId,
            },
            400,
          );
        }

        if (NoSuchModelError.isInstance(err)) {
          log.error(
            { err: errObj, category: "provider_model_not_found" },
            "Model not found",
          );
          return c.json(
            {
              error: "provider_model_not_found",
              message:
                "The configured model was not found. Check ATLAS_MODEL and ATLAS_PROVIDER settings.",
              retryable: isRetryableError("provider_model_not_found"),
              requestId,
            },
            400,
          );
        }

        if (LoadAPIKeyError.isInstance(err)) {
          log.error(
            { err: errObj, category: "provider_auth_error" },
            "API key not loaded",
          );
          return c.json(
            {
              error: "provider_auth_error",
              message:
                "LLM provider API key could not be loaded. Check that the required API key environment variable is set.",
              retryable: isRetryableError("provider_auth_error"),
              requestId,
            },
            503,
          );
        }

        // APICallError carries the HTTP status code from the provider response
        if (APICallError.isInstance(err)) {
          const status = err.statusCode;

          if (status === 401 || status === 403) {
            log.error(
              { err: errObj, category: "provider_auth_error", statusCode: status },
              "Provider auth error",
            );
            return c.json(
              {
                error: "provider_auth_error",
                message:
                  "LLM provider authentication failed. Check that your API key is valid and has not expired.",
                retryable: isRetryableError("provider_auth_error"),
                requestId,
              },
              503,
            );
          }

          if (status === 429) {
            log.error(
              { err: errObj, category: "provider_rate_limit", statusCode: status },
              "Provider rate limit",
            );
            return c.json(
              {
                error: "provider_rate_limit",
                message:
                  "LLM provider rate limit reached. Wait a moment and try again.",
                retryable: isRetryableError("provider_rate_limit"),
                requestId,
              },
              503,
            );
          }

          if (status === 408 || /timeout/i.test(message)) {
            log.error(
              { err: errObj, category: "provider_timeout", statusCode: status },
              "Request timed out",
            );
            return c.json(
              {
                error: "provider_timeout",
                message:
                  "The request timed out. The LLM provider took too long to respond. " +
                  "Try again, or if using a local model, ensure it has sufficient resources.",
                retryable: isRetryableError("provider_timeout"),
                requestId,
              },
              504,
            );
          }

          // Catch-all for any other APICallError status codes (5xx, etc.)
          log.error(
            { err: errObj, category: "provider_error", statusCode: status },
            "Provider error",
          );
          return c.json(
            {
              error: "provider_error",
              message: `The LLM provider returned an error (HTTP ${status}). This is usually a temporary issue. Try again in a moment.`,
              retryable: isRetryableError("provider_error"),
              requestId,
            },
            502,
          );
        }

        // --- Pattern-matched errors (non-APICallError exceptions) ---
        // In the chat route, errors from runAgent are typically provider-related,
        // so we override matchError's generic messages with provider-appropriate ones.

        const matched = matchError(err);
        if (matched) {
          const isConnectionError = /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(message);
          const code = (matched.code === "internal_error" && isConnectionError)
            ? "provider_unreachable" as const
            : matched.code === "provider_unreachable" ? "provider_unreachable" as const
            : matched.code;
          const httpStatus = code === "rate_limited" ? 429
            : code === "provider_unreachable" ? 503
            : code === "provider_timeout" ? 504
            : 500;
          // Use provider-appropriate messages instead of database-oriented matchError defaults
          const userMessage = code === "provider_unreachable"
            ? "Could not reach the LLM provider. Check your network connection and provider status."
            : code === "provider_timeout"
              ? "The request timed out. The LLM provider took too long to respond. Try again, or if using a local model, ensure it has sufficient resources."
              : matched.message;
          if (code === "rate_limited") {
            // Pool exhaustion is transient — warn, don't error
            log.warn({ err: errObj, category: code }, "Matched error: %s", code);
            return c.json(
              { error: code, message: userMessage, retryable: true, retryAfterSeconds: 5, requestId },
              { status: 429, headers: { "Retry-After": "5" } },
            );
          }
          log.error({ err: errObj, category: code }, "Matched error: %s", code);
          return c.json(
            { error: code, message: userMessage, retryable: isRetryableError(code), requestId },
            httpStatus as 429 | 500 | 503 | 504,
          );
        }

        // Fallback — safe 500 with requestId for log correlation.
        // Full error details (stack trace, original message) are serialized
        // server-side via pino's err serializer; only a generic message +
        // request ID reach the client.
        log.error(
          { err: errObj, category: "internal_error" },
          "Unclassified error",
        );
        return c.json(
          {
            error: "internal_error",
            message: `An unexpected error occurred. Quote ref ${requestId.slice(0, 8)} when reporting this issue.`,
            retryable: isRetryableError("internal_error"),
            requestId,
          },
          500,
        );
      }
    },
  );
});

export { chat };
