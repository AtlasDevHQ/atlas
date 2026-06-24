/**
 * Demo mode routes — email-gated public demo with lead capture.
 *
 * Mounted at /api/v1/demo when ATLAS_DEMO_ENABLED=true.
 * Completely separate from the main auth/chat flow.
 *
 * Routes:
 *   POST /start          — email gate, returns demo token
 *   POST /chat           — demo chat (mirrors main chat route with demo limits)
 *   GET  /conversations   — list demo user's conversations
 *   GET  /conversations/:id — get demo conversation with messages
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { z } from "@hono/zod-openapi";
import { type UIMessage, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { APICallError, LoadAPIKeyError, NoSuchModelError } from "ai";
import { matchError, isRetryableError } from "@useatlas/types";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";
import { runAgent } from "@atlas/api/lib/agent";
import { validateEnvironment } from "@atlas/api/lib/startup";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { logFirstAnswerLatency, isFirstTurn } from "@atlas/api/lib/activation-metrics";
import { getClientIP } from "@atlas/api/lib/auth/middleware";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { parsePagination } from "./shared-schemas";
import {
  createConversation,
  addMessage,
  getConversation,
  listConversations,
  generateTitle,
  persistAssistantSteps,
} from "@atlas/api/lib/conversations";
import { setStreamWriter, clearStreamWriter } from "@atlas/api/lib/tools/python-stream";
import { corsResponseHeaders } from "@atlas/api/lib/cors";
import {
  signDemoToken,
  verifyDemoToken,
  demoUserId,
  checkDemoRateLimit,
  getDemoMaxSteps,
  demoRunAgentModelParams,
  captureDemoLead,
  countDemoConversations,
} from "@atlas/api/lib/demo";
import { withRequestId, type AuthEnv } from "./middleware";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";

const log = createLogger("demo");

/**
 * Permissive error schema for route definitions. Handlers return extra fields
 * (retryAfterSeconds, retryable, requestId, diagnostics, details) beyond the
 * base ErrorSchema — a record type allows those without breaking type inference.
 */
const DemoErrorSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Error classification (#3197 + #3202)
// ---------------------------------------------------------------------------

/** Codes the demo classifier emits — a subset of `ChatErrorCode`. */
type DemoErrorCode =
  | "provider_model_not_found"
  | "provider_auth_error"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_error"
  | "provider_unreachable"
  | "rate_limited"
  | "internal_error";

/** 1:1 code→HTTP status for the synchronous catch path. Mirror of chat.ts's
 * `CLASSIFIER_STATUS_MAP` + reference/error-codes.mdx — a provider outage must
 * surface as 503/504, not a misleading 500. */
const DEMO_STATUS_BY_CODE = {
  provider_model_not_found: 400,
  provider_auth_error: 503,
  provider_rate_limit: 503,
  provider_timeout: 504,
  provider_error: 502,
  provider_unreachable: 503,
  rate_limited: 429,
  internal_error: 500,
} as const satisfies Record<DemoErrorCode, 400 | 429 | 500 | 502 | 503 | 504>;

interface DemoErrorClassification {
  readonly code: DemoErrorCode;
  readonly message: string;
}

/**
 * Flatten an error + its `cause` chain into one string. `matchError` inspects
 * only `error.message`, but the AI SDK wraps a transport failure (ECONNREFUSED /
 * ENOTFOUND / "fetch failed") in an `APICallError` whose connection detail lives
 * on `.cause`, not the top-level message — so without this a mid-stream provider
 * outage would miss the `provider_unreachable` match (#3202/#3206 Codex).
 */
function flattenErrorMessage(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (typeof current === "string" && current.length > 0) parts.push(current);
  return parts.join(" | ");
}

/**
 * Classify a demo agent-loop error. Single source of truth for the demo surface,
 * invoked by BOTH the synchronous catch (which builds the JSON HTTP response) and
 * the mid-stream `createUIMessageStream` `onError` path (which serializes the SSE
 * error frame). One classifier guarantees a provider outage carries the same
 * `code` whether it surfaces before the stream is returned (runAgent throwing) or
 * WHILE the stream is consumed (#3202) — exactly the gap chat.ts's
 * `classifyChatError` already closes for the main chat route.
 *
 * The agent loop's exceptions are the LLM provider (executeSQL errors are caught
 * as tool results), so the non-SDK-typed fallback passes `subsystem: "provider"`
 * — `matchError` then labels a connection failure (ECONNREFUSED/ENOTFOUND)
 * `provider_unreachable` rather than the datasource-framed `internal_error`.
 */
export function classifyDemoError(err: unknown, requestId: string): DemoErrorClassification {
  const message = err instanceof Error ? err.message : String(err);
  if (GatewayModelNotFoundError.isInstance(err)) {
    return { code: "provider_model_not_found", message: "Model not found on the AI Gateway." };
  }
  if (NoSuchModelError.isInstance(err)) {
    return { code: "provider_model_not_found", message: "The configured model was not found." };
  }
  if (LoadAPIKeyError.isInstance(err)) {
    return { code: "provider_auth_error", message: "LLM provider API key could not be loaded." };
  }
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    if (status === 401 || status === 403) {
      return { code: "provider_auth_error", message: "LLM provider authentication failed." };
    }
    if (status === 429) {
      return { code: "provider_rate_limit", message: "LLM provider rate limit reached." };
    }
    if (status === 408 || /timeout/i.test(message)) {
      return { code: "provider_timeout", message: "The request timed out." };
    }
    if (typeof status === "number") {
      return { code: "provider_error", message: `LLM provider error (HTTP ${status}).` };
    }
    // No HTTP status → the SDK wrapped a transport/connection failure (e.g.
    // ECONNREFUSED/ENOTFOUND/"fetch failed" on `.cause`). Fall through to the
    // connection-aware matchError below so it maps to provider_unreachable
    // rather than a misleading `provider_error (HTTP undefined)` (#3206 Codex).
  }
  // Inspect the message AND the cause chain so a connection failure the SDK
  // buried on `APICallError.cause` still maps to provider_unreachable.
  const matched = matchError(new Error(flattenErrorMessage(err)), { subsystem: "provider" });
  if (
    matched &&
    (matched.code === "provider_unreachable" ||
      matched.code === "provider_timeout" ||
      matched.code === "rate_limited")
  ) {
    return { code: matched.code, message: matched.message };
  }
  return {
    code: "internal_error",
    message: `An unexpected error occurred. Quote ref ${requestId.slice(0, 8)} when reporting.`,
  };
}

/**
 * Serialize a demo classification into the SSE error frame the AI SDK carries as
 * `errorText`. Same `{ error, message, retryable, requestId }` shape as the
 * synchronous JSON response (and chat.ts's `buildMidStreamErrorFrame`), so a
 * provider outage raised mid-stream is no longer indistinguishable from a normal
 * response error — the client gets a structured frame either way (#3202).
 */
export function buildDemoMidStreamErrorFrame(err: unknown, requestId: string): string {
  const cls = classifyDemoError(err, requestId);
  return JSON.stringify({
    error: cls.code,
    message: cls.message,
    retryable: isRetryableError(cls.code),
    requestId,
  });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const DemoStartSchema = z.object({
  email: z.string().email("Invalid email address"),
});

const MessagePartSchema = z.object({ type: z.string() }).passthrough();

const UIMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(MessagePartSchema),
  id: z.string(),
});

export const DemoChatRequestSchema = z.object({
  messages: z.array(UIMessageSchema).min(1),
  conversationId: z.string().uuid().optional(),
});

const DemoStartResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.number(),
  returning: z.boolean(),
  conversationCount: z.number().int(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract and verify demo token from Authorization header. */
function extractDemoEmail(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  return verifyDemoToken(match[1]);
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const demoStartRoute = createRoute({
  method: "post",
  path: "/start",
  tags: ["Demo"],
  summary: "Start a demo session",
  description:
    "Email-gated demo entry point. Validates the email, signs a short-lived demo JWT, and captures the lead. " +
    "IP-based rate limiting prevents abuse. Returns a token for subsequent demo API calls.",
  request: {
    body: {
      content: { "application/json": { schema: DemoStartSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Demo session started",
      content: { "application/json": { schema: DemoStartResponseSchema } },
    },
    400: {
      description: "Invalid JSON body",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    422: {
      description: "Validation error (invalid email)",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded (IP-based)",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    500: {
      description: "Demo mode not properly configured",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
  },
});

const demoChatRoute = createRoute({
  method: "post",
  path: "/chat",
  tags: ["Demo"],
  summary: "Chat in demo mode (streaming)",
  description:
    "Mirrors the main chat endpoint with demo-specific limits. Requires a valid demo token from /demo/start. " +
    "Streams the response as Server-Sent Events using the Vercel AI SDK UI message stream protocol. " +
    "Demo conversations are persisted when an internal database is available.",
  request: {
    body: {
      content: { "application/json": { schema: DemoChatRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "Streaming SSE response using the Vercel AI SDK UI message stream protocol. " +
        "Each event is a JSON object with a 'type' field (text-delta, tool-call, tool-result, step-start, finish).",
      content: {
        "text/event-stream": {
          schema: z.string(),
        },
      },
    },
    400: {
      description: "Bad request (malformed JSON, missing datasource, configuration error, or model not found)",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    401: {
      description: "Valid demo token required",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    404: {
      description: "Conversation not found (invalid conversationId)",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    422: {
      description: "Validation error (invalid request body)",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    429: {
      description: "Demo rate limit exceeded",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    502: {
      description: "LLM provider error",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    503: {
      description: "Provider unreachable, auth error, or rate limited",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    504: {
      description: "Request timed out",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
  },
});

const listDemoConversationsRoute = createRoute({
  method: "get",
  path: "/conversations",
  tags: ["Demo"],
  summary: "List demo conversations",
  description:
    "Returns a paginated list of conversations for the demo user identified by their demo token. " +
    "Returns an empty list when no internal database is configured.",
  request: {
    query: z.object({
      limit: z.string().optional().openapi({ description: "Maximum number of items to return (1-100, default 50)" }),
      offset: z.string().optional().openapi({ description: "Number of items to skip (default 0)" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of demo conversations",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: {
      description: "Valid demo token required",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    500: {
      description: "Failed to load conversations",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
  },
});

const getDemoConversationRoute = createRoute({
  method: "get",
  path: "/conversations/{id}",
  tags: ["Demo"],
  summary: "Get a demo conversation",
  description:
    "Returns a single demo conversation with all its messages. Requires a valid demo token and enforces ownership.",
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ description: "Conversation UUID" }),
    }),
  },
  responses: {
    200: {
      description: "Conversation with messages",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: {
      description: "Valid demo token required",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    404: {
      description: "Conversation not found",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
    500: {
      description: "Failed to load conversation",
      content: { "application/json": { schema: DemoErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const demo = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

demo.use(withRequestId);

demo.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

// POST /start — email gate, returns demo token
demo.openapi(demoStartRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const requestId = crypto.randomUUID();

    // IP-based rate limit to prevent abuse (email enumeration, DB flooding)
    const ip = getClientIP(c.req.raw);
    const startRateCheck = checkDemoRateLimit(ip ?? "anon-start");
    if (!startRateCheck.allowed) {
      const retryAfterSeconds = Math.ceil((startRateCheck.retryAfterMs ?? 60000) / 1000);
      return c.json(
        { error: "rate_limited", message: "Too many requests. Please wait.", retryAfterSeconds, requestId },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const bodyResult = yield* Effect.tryPromise({
      try: () => c.req.json(),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (bodyResult._tag === "Left") {
      log.debug({ err: bodyResult.left.message }, "Demo /start: invalid JSON body");
      return c.json(
        { error: "invalid_request", message: "Invalid JSON body.", requestId },
        400,
      );
    }
    const body: unknown = bodyResult.right;

    const parsed = DemoStartSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", message: "A valid email address is required.", requestId },
        422,
      );
    }

    const email = parsed.data.email.toLowerCase().trim();

    // Sign token
    const tokenResult = signDemoToken(email);
    if (!tokenResult) {
      log.error("Demo token signing failed — BETTER_AUTH_SECRET may not be set");
      return c.json(
        { error: "configuration_error", message: "Demo mode is not properly configured.", requestId },
        500,
      );
    }

    // Capture lead (best-effort)
    const userAgent = c.req.header("user-agent") ?? null;
    const [leadResult, conversationCount] = yield* Effect.promise(() => Promise.all([
      captureDemoLead({ email, ip, userAgent, requestId }),
      countDemoConversations(email),
    ]));

    log.info(
      { email: email.replace(/(.{2}).*(@.*)/, "$1***$2"), returning: leadResult.returning },
      "Demo session started",
    );

    return c.json({
      token: tokenResult.token,
      expiresAt: tokenResult.expiresAt,
      returning: leadResult.returning,
      conversationCount,
    }, 200);
  }), { label: "demo start" });
});

// POST /chat — demo chat (mirrors main chat route with demo limits)
demo.openapi(demoChatRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  // #3925 — cold-start time-to-first-answer clock. The demo is the purest
  // cold path (zero signup), so its first-answer latency is the headline
  // conversion signal. Stamped at request entry; finished in stream onFinish.
  const turnStartedAtMs = Date.now();

  // Demo token auth
  const email = extractDemoEmail(req);
  if (!email) {
    return c.json(
      { error: "auth_error", message: "Valid demo token required. Start a demo session first.", retryable: false, requestId },
      401,
    );
  }

  const userId = demoUserId(email);

  // Demo rate limit
  const rateCheck = checkDemoRateLimit(email);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return c.json(
      {
        error: "rate_limited",
        message: "Demo rate limit reached. Please wait before trying again.",
        retryAfterSeconds,
        retryable: true,
        requestId,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  // Bind request context (no org for demo users).
  // #2072 — demo runs the same flow as chat from the user's POV.
  // #3615 — and is human-initiated like the web chat route, so stamp the
  // same 'human' audit discriminator rather than letting it default to 'agent'.
  const demoUser = createAtlasUser(userId, "simple-key", `demo:${email}`);
  return withRequestContext(
    { requestId, user: demoUser, agentOrigin: "chat", actor: { kind: "human" } },
    async () => {
      // Startup diagnostics
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

      // Datasource guard
      const { resolveDatasourceUrl } = await import("@atlas/api/lib/db/connection");
      if (!resolveDatasourceUrl()) {
        return c.json(
          {
            error: "no_datasource",
            message: "Demo datasource not configured.",
            retryable: false,
            requestId,
          },
          400,
        );
      }

      // Parse body
      let body: unknown;
      try {
        body = await c.req.json();
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Failed to parse request body",
        );
        return c.json(
          { error: "invalid_request", message: "Invalid JSON body.", retryable: false, requestId },
          400,
        );
      }

      const parsed = DemoChatRequestSchema.safeParse(body);
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

      // Conversation persistence — demo uses surface="demo"
      if (hasInternalDB()) {
        if (conversationId) {
          const existing = await getConversation(conversationId, userId);
          if (!existing.ok) {
            return c.json({ error: "not_found", message: "Conversation not found.", retryable: false, requestId }, 404);
          }
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
              userId,
              title,
              surface: "demo",
            });
            if (created) conversationId = created.id;
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to create demo conversation");
          }
        }
      }

      try {
        // #3931 — demo turns run on the configured demo model (Haiku on the
        // gateway by default); `demoRunAgentModelParams()` yields `{}` on a
        // non-gateway deploy so runAgent resolves the platform default.
        // Passing `aiModel` makes the demo model authoritative, so
        // `token_usage.model`/`provider` reflect it.
        // Demo uses default tools only — no actions, no plugin tools
        const agentResult = await runAgent({
          messages,
          conversationId,
          maxSteps: getDemoMaxSteps(),
          ...demoRunAgentModelParams(),
        });

        const stream = createUIMessageStream({
          execute: ({ writer }) => {
            setStreamWriter(requestId, writer);
            writer.merge(agentResult.toUIMessageStream());
          },
          onFinish: ({ isAborted, finishReason }) => {
            clearStreamWriter(requestId);
            // #3925 — cold-start time-to-first-answer for the zero-signup demo
            // path. Skip aborted/errored finishes (onFinish still fires after
            // onError emits an error frame) so only delivered answers count.
            if (isAborted || finishReason === "error") return;
            logFirstAnswerLatency({
              surface: "demo",
              startedAtMs: turnStartedAtMs,
              finishedAtMs: Date.now(),
              firstTurn: isFirstTurn(messages),
              requestId,
              ...(conversationId ? { conversationId } : {}),
            });
          },
          onError: (error) => {
            clearStreamWriter(requestId);
            // #3202 — a provider error raised WHILE the stream is consumed (e.g.
            // ECONNREFUSED/ENOTFOUND mid-generation) lands here, not the sync
            // catch below (runAgent returns the streamText result before the
            // stream is read). Classify it the same way so the client gets a
            // structured `provider_unreachable`/503-equivalent frame rather than
            // a generic string — matching chat.ts's mid-stream contract.
            const cls = classifyDemoError(error, requestId);
            const logFn = cls.code === "rate_limited" || cls.code === "provider_rate_limit" ? log.warn : log.error;
            logFn.call(
              log,
              { err: error instanceof Error ? error : new Error(String(error)), category: cls.code, requestId },
              "Demo stream error (mid-stream): %s",
              cls.code,
            );
            return buildDemoMidStreamErrorFrame(error, requestId);
          },
        });

        // Streaming responses bypass Hono's CORS middleware (we throw a raw
        // Response via HTTPException so OpenAPIHono's onError returns it
        // unchanged). Re-apply the CORS headers here so cross-origin
        // browser fetches receive Access-Control-Allow-Origin. (#2037)
        const streamResponse = createUIMessageStreamResponse({
          stream,
          headers: {
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-transform",
            ...corsResponseHeaders(c.req.header("Origin") ?? ""),
            ...(conversationId ? { "x-conversation-id": conversationId } : {}),
          },
        });

        // Fire-and-forget: persist assistant response (text + tool results) after stream completes.
        if (conversationId) {
          persistAssistantSteps({ conversationId, steps: agentResult.steps, label: "demo" });
        }

        // Streaming response bypasses OpenAPI typed returns via HTTPException + res
        throw new HTTPException(200, { res: streamResponse });
      } catch (err) {
        // Re-throw HTTPException (stream response) — handled by global onError.
        if (err instanceof HTTPException) throw err;

        // Early-throw path: runAgent threw synchronously, before the stream was
        // returned. Classified by the same `classifyDemoError` the mid-stream
        // onError uses (#3202), so the response is identical whether the failure
        // surfaces before or after the first byte. Provider outages map to
        // 503/504 via DEMO_STATUS_BY_CODE, not a misleading 500 (#3197).
        const errObj = err instanceof Error ? err : new Error(String(err));
        const cls = classifyDemoError(err, requestId);
        const httpStatus = DEMO_STATUS_BY_CODE[cls.code];
        const retryable = isRetryableError(cls.code);
        if (cls.code === "rate_limited" || cls.code === "provider_rate_limit") {
          log.warn({ err: errObj, category: cls.code, statusCode: httpStatus, requestId }, "Demo error: %s", cls.code);
        } else {
          log.error({ err: errObj, category: cls.code, statusCode: httpStatus, requestId }, "Demo error: %s", cls.code);
        }
        return c.json(
          { error: cls.code, message: cls.message, retryable, requestId },
          httpStatus as 500,
        );
      }
    },
  );
});

// GET /conversations — list demo user's conversations
demo.openapi(listDemoConversationsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const email = extractDemoEmail(c.req.raw);
    if (!email) {
      return c.json({ error: "auth_error", message: "Valid demo token required.", requestId }, 401);
    }

    if (!hasInternalDB()) {
      return c.json({ conversations: [], total: 0 }, 200);
    }

    const userId = demoUserId(email);
    const { limit, offset } = parsePagination(c, { limit: 50, maxLimit: 100 });
    const items = yield* Effect.promise(() => listConversations({ userId, limit, offset }));
    return c.json(items, 200);
  }), { label: "list demo conversations" });
});

// GET /conversations/:id — get demo conversation with messages
demo.openapi(getDemoConversationRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const email = extractDemoEmail(c.req.raw);
    if (!email) {
      return c.json({ error: "auth_error", message: "Valid demo token required.", requestId }, 401);
    }

    const userId = demoUserId(email);
    const id = c.req.param("id");
    const conv = yield* Effect.promise(() => getConversation(id, userId));

    if (!conv.ok) {
      return c.json({ error: "not_found", message: "Conversation not found.", requestId }, 404);
    }

    return c.json(conv.data, 200);
  }), { label: "get demo conversation" });
});

export { demo };
