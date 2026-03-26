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

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { APICallError, LoadAPIKeyError, NoSuchModelError } from "ai";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";
import { isRetryableError, isChatErrorCode } from "@useatlas/types";
import { executeAgentQuery } from "@atlas/api/lib/agent-query";
import { validateEnvironment } from "@atlas/api/lib/startup";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { checkWorkspaceStatus } from "@atlas/api/lib/workspace";
import { checkPlanLimits } from "@atlas/api/lib/billing/enforcement";
import { checkAbuseStatus } from "@atlas/api/lib/security/abuse";
import {
  createConversation,
  addMessage,
  getConversation,
  generateTitle,
} from "@atlas/api/lib/conversations";
import { authPreamble, requireAuth } from "./auth-preamble";
import { withRequestId, type AuthEnv } from "./middleware";
import { ErrorSchema } from "./shared-schemas";


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

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const queryRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Query"],
  summary: "Ask a question",
  description:
    "Runs the Atlas agent to completion and returns a structured JSON response with the answer, SQL queries executed, result data, step count, and token usage.",
  request: {
    body: {
      content: { "application/json": { schema: QueryRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Successful query response",
      content: { "application/json": { schema: QueryResponseSchema } },
    },
    400: {
      description: "Bad request (malformed JSON or missing datasource)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    422: {
      description: "Validation error (invalid request body)",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }),
        },
      },
    },
    404: {
      description: "Workspace not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const query = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

query.use(withRequestId);

// Normalize JSON parse errors. Only catch SyntaxError (malformed JSON); let
// other 400s (e.g. Zod query/path param validation) propagate with their message.
query.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      if (err.cause instanceof SyntaxError) {
        log.warn("Malformed JSON body in request");
        return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
      }
      return c.json({ error: "invalid_request", message: err.message || "Bad request." }, 400);
    }
  }
  throw err;
});

query.openapi(
  queryRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const req = c.req.raw;

      // --- Auth + Rate limit ---
      const preamble = yield* Effect.promise(() => authPreamble(req, requestId));
      requireAuth(preamble);
      const { authResult } = preamble;

      // Bind user identity into AsyncLocalStorage for downstream logging/audit
      return withRequestContext({ requestId, user: authResult.user }, async () => {

        // Workspace status check — block suspended/deleted workspaces
        const wsCheck = await checkWorkspaceStatus(authResult.user?.activeOrganizationId);
        if (!wsCheck.allowed) {
          const wsError = wsCheck.errorCode ?? "workspace_error";
          const wsMessage = wsCheck.errorMessage ?? "Workspace access denied.";
          const wsStatus = wsCheck.httpStatus ?? 403;
          throw new HTTPException(wsStatus as 403, {
            res: Response.json(
              { error: wsError, message: wsMessage, retryable: isChatErrorCode(wsError) ? isRetryableError(wsError) : false, requestId },
              { status: wsStatus },
            ),
          });
        }
    
        // Abuse check — block suspended workspaces, reject throttled ones with 429
        const abuseOrgId = authResult.user?.activeOrganizationId;
        if (abuseOrgId) {
          const abuse = checkAbuseStatus(abuseOrgId);
          if (abuse.level === "suspended") {
            log.warn({ requestId, orgId: abuseOrgId }, "Workspace suspended due to abuse");
            throw new HTTPException(403, {
              res: Response.json(
                { error: "workspace_suspended", message: "Workspace suspended due to unusual activity. Contact your administrator.", retryable: false, requestId },
                { status: 403 },
              ),
            });
          }
          if (abuse.level === "throttled" && abuse.throttleDelayMs) {
            const retryAfterSeconds = Math.ceil(abuse.throttleDelayMs / 1000);
            log.warn({ requestId, orgId: abuseOrgId, delayMs: abuse.throttleDelayMs }, "Workspace throttled due to abuse");
            throw new HTTPException(429, {
              // Use raw Response (not Response.json) to include Retry-After header
              res: new Response(
                JSON.stringify({
                  error: "workspace_throttled",
                  message: "Workspace is temporarily throttled due to high usage. Please retry shortly.",
                  retryable: true,
                  retryAfterSeconds,
                  requestId,
                }),
                { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) } },
              ),
            });
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
    
        // Capture plan warning for JSON response
        const planWarning = planCheck.allowed ? planCheck.warning : undefined;
    
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
    
        const { question, conversationId: parsedConversationId } = c.req.valid("json");
        let conversationId = parsedConversationId;
    
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
                  orgId: authResult.user?.activeOrganizationId,
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
          const { pendingActions: rawPendingActions, ...restResult } = queryResult;
          let enrichedPendingActions: {
            id: string;
            type: string;
            target: string;
            summary: string;
            approveUrl: string;
            denyUrl: string;
          }[] | undefined;
    
          if (rawPendingActions?.length) {
            const baseUrl = deriveBaseUrl(req);
            enrichedPendingActions = rawPendingActions.map((a) => ({
              ...a,
              approveUrl: `${baseUrl}/api/v1/actions/${a.id}/approve`,
              denyUrl: `${baseUrl}/api/v1/actions/${a.id}/deny`,
            }));
          }
    
          return c.json({
            ...restResult,
            ...(conversationId && { conversationId }),
            ...(enrichedPendingActions && { pendingActions: enrichedPendingActions }),
            ...(planWarning && { planWarning }),
          }, 200);
        } catch (err) {
          if (err instanceof HTTPException) throw err;
    
          const message = err instanceof Error ? err.message : "";
    
          // --- Structured AI SDK error types ---
    
          if (GatewayModelNotFoundError.isInstance(err)) {
            log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_model_not_found" }, "Gateway model not found");
            return c.json({ error: "provider_model_not_found", message: "Model not found on the AI Gateway. Check that your ATLAS_MODEL uses the correct provider/model format.", requestId }, 400);
          }
    
          if (NoSuchModelError.isInstance(err)) {
            log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_model_not_found" }, "Model not found");
            return c.json({ error: "provider_model_not_found", message: "The configured model was not found. Check ATLAS_MODEL and ATLAS_PROVIDER settings.", requestId }, 400);
          }
    
          if (LoadAPIKeyError.isInstance(err)) {
            log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_auth_error" }, "API key not loaded");
            return c.json({ error: "provider_auth_error", message: "LLM provider API key could not be loaded. Check that the required API key environment variable is set.", requestId }, 503);
          }
    
          if (APICallError.isInstance(err)) {
            const status = err.statusCode;
            if (status === 401 || status === 403) {
              log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_auth_error", statusCode: status }, "Provider auth error");
              return c.json({ error: "provider_auth_error", message: "LLM provider authentication failed. Check that your API key is valid and has not expired.", requestId }, 503);
            }
            if (status === 429) {
              log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_rate_limit", statusCode: status }, "Provider rate limit");
              return c.json({ error: "provider_rate_limit", message: "LLM provider rate limit reached. Wait a moment and try again.", requestId }, 503);
            }
            if (status === 408 || /timeout/i.test(message)) {
              log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_timeout", statusCode: status }, "Request timed out");
              return c.json({ error: "provider_timeout", message: "The request timed out. The LLM provider took too long to respond. Try again, or if using a local model, ensure it has sufficient resources.", requestId }, 504);
            }
            log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_error", statusCode: status }, "Provider error");
            return c.json({ error: "provider_error", message: `The LLM provider returned an error (HTTP ${status}). This is usually a temporary issue. Try again in a moment.`, requestId }, 502);
          }
    
          // --- Regex fallbacks ---
    
          if (/timeout|timed out|AbortError/i.test(message)) {
            log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_timeout" }, "Request timed out");
            return c.json({ error: "provider_timeout", message: "The request timed out. The LLM provider took too long to respond. Try again, or if using a local model, ensure it has sufficient resources.", requestId }, 504);
          }
    
          if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
            log.error({ err: err instanceof Error ? err : new Error(String(err)), category: "provider_unreachable" }, "Provider unreachable");
            return c.json({ error: "provider_unreachable", message: "Could not reach the LLM provider. Check your network connection and provider status.", requestId }, 503);
          }
    
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)), category: "internal_error" },
            "Unexpected error",
          );
          return c.json(
            {
              error: "internal_error",
              message: `An unexpected error occurred (ref: ${requestId.slice(0, 8)}). If this persists, check the server logs.`,
              requestId,
            },
            500,
          );
        }
      }); // withRequestContext
    }), { label: "query" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        422,
      );
    }
  },
);

export { query };
