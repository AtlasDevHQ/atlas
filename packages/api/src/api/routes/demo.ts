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

import { Hono } from "hono";
import { z } from "zod";
import { type UIMessage, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { APICallError, LoadAPIKeyError, NoSuchModelError } from "ai";
import { matchError, isRetryableError } from "@useatlas/types";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";
import { runAgent } from "@atlas/api/lib/agent";
import { validateEnvironment } from "@atlas/api/lib/startup";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { getClientIP } from "@atlas/api/lib/auth/middleware";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  createConversation,
  addMessage,
  getConversation,
  listConversations,
  generateTitle,
} from "@atlas/api/lib/conversations";
import { setStreamWriter, clearStreamWriter } from "@atlas/api/lib/tools/python-stream";
import {
  signDemoToken,
  verifyDemoToken,
  demoUserId,
  checkDemoRateLimit,
  getDemoMaxSteps,
  captureDemoLead,
  countDemoConversations,
} from "@atlas/api/lib/demo";

const log = createLogger("demo");

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
// Routes
// ---------------------------------------------------------------------------

const demo = new Hono();

// POST /start — email gate, returns demo token
demo.post("/start", async (c) => {
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

  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, "Demo /start: invalid JSON body");
    return c.json(
      { error: "invalid_request", message: "Invalid JSON body.", requestId },
      400,
    );
  }

  const parsed = DemoStartSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", message: "A valid email address is required.", requestId },
      422,
    );
  }

  const email = parsed.data.email.toLowerCase().trim();

  // Sign token
  const result = signDemoToken(email);
  if (!result) {
    log.error("Demo token signing failed — BETTER_AUTH_SECRET may not be set");
    return c.json(
      { error: "configuration_error", message: "Demo mode is not properly configured.", requestId },
      500,
    );
  }

  // Capture lead (best-effort)
  const userAgent = c.req.header("user-agent") ?? null;
  const [leadResult, conversationCount] = await Promise.all([
    captureDemoLead({ email, ip, userAgent }),
    countDemoConversations(email),
  ]);

  log.info(
    { email: email.replace(/(.{2}).*(@.*)/, "$1***$2"), returning: leadResult.returning },
    "Demo session started",
  );

  return c.json({
    token: result.token,
    expiresAt: result.expiresAt,
    returning: leadResult.returning,
    conversationCount,
  });
});

// POST /chat — demo chat (mirrors main chat route with demo limits)
demo.post("/chat", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

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

  // Bind request context (no org for demo users)
  const demoUser = createAtlasUser(userId, "simple-key", `demo:${email}`);
  return withRequestContext(
    { requestId, user: demoUser },
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
        // Demo uses default tools only — no actions, no plugin tools
        const agentResult = await runAgent({
          messages,
          conversationId,
          maxSteps: getDemoMaxSteps(),
        });

        const stream = createUIMessageStream({
          execute: ({ writer }) => {
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
              "Demo stream error",
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
          },
        });

        // Fire-and-forget: persist assistant response
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
              log.error({ err: err instanceof Error ? err.message : String(err), conversationId: cid }, "Demo agent stream failed");
            });
        }

        return streamResponse;
      } catch (err) {
        // Error handling mirrors main chat route
        const errObj = err instanceof Error ? err : new Error(String(err));
        const message = errObj.message;

        if (GatewayModelNotFoundError.isInstance(err)) {
          log.error({ err: errObj, category: "provider_model_not_found" }, "Gateway model not found");
          return c.json(
            { error: "provider_model_not_found", message: "Model not found on the AI Gateway.", retryable: false, requestId },
            400,
          );
        }

        if (NoSuchModelError.isInstance(err)) {
          log.error({ err: errObj, category: "provider_model_not_found" }, "Model not found");
          return c.json(
            { error: "provider_model_not_found", message: "The configured model was not found.", retryable: false, requestId },
            400,
          );
        }

        if (LoadAPIKeyError.isInstance(err)) {
          log.error({ err: errObj, category: "provider_auth_error" }, "API key not loaded");
          return c.json(
            { error: "provider_auth_error", message: "LLM provider API key could not be loaded.", retryable: false, requestId },
            503,
          );
        }

        if (APICallError.isInstance(err)) {
          const status = err.statusCode;
          if (status === 401 || status === 403) {
            return c.json({ error: "provider_auth_error", message: "LLM provider authentication failed.", retryable: false, requestId }, 503);
          }
          if (status === 429) {
            return c.json({ error: "provider_rate_limit", message: "LLM provider rate limit reached.", retryable: true, requestId }, 503);
          }
          if (status === 408 || /timeout/i.test(message)) {
            return c.json({ error: "provider_timeout", message: "The request timed out.", retryable: true, requestId }, 504);
          }
          return c.json({ error: "provider_error", message: `LLM provider error (HTTP ${status}).`, retryable: true, requestId }, 502);
        }

        const matched = matchError(err);
        if (matched) {
          const httpStatus = matched.code === "rate_limited" ? 429 : 500;
          return c.json(
            { error: matched.code, message: matched.message, retryable: isRetryableError(matched.code), requestId },
            httpStatus as 500,
          );
        }

        log.error({ err: errObj, category: "internal_error" }, "Unclassified demo error");
        return c.json(
          {
            error: "internal_error",
            message: `An unexpected error occurred. Quote ref ${requestId.slice(0, 8)} when reporting.`,
            retryable: false,
            requestId,
          },
          500,
        );
      }
    },
  );
});

// GET /conversations — list demo user's conversations
demo.get("/conversations", async (c) => {
  const requestId = crypto.randomUUID();
  const email = extractDemoEmail(c.req.raw);
  if (!email) {
    return c.json({ error: "auth_error", message: "Valid demo token required.", requestId }, 401);
  }

  if (!hasInternalDB()) {
    return c.json({ conversations: [], total: 0 });
  }

  try {
    const userId = demoUserId(email);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 100);
    const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;
    const result = await listConversations({ userId, limit, offset });
    return c.json(result);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Failed to list demo conversations",
    );
    return c.json(
      { error: "internal_error", message: "Failed to load conversations.", requestId },
      500,
    );
  }
});

// GET /conversations/:id — get demo conversation with messages
demo.get("/conversations/:id", async (c) => {
  const requestId = crypto.randomUUID();
  const email = extractDemoEmail(c.req.raw);
  if (!email) {
    return c.json({ error: "auth_error", message: "Valid demo token required.", requestId }, 401);
  }

  try {
    const userId = demoUserId(email);
    const id = c.req.param("id");
    const result = await getConversation(id, userId);

    if (!result.ok) {
      return c.json({ error: "not_found", message: "Conversation not found.", requestId }, 404);
    }

    return c.json(result.data);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Failed to get demo conversation",
    );
    return c.json(
      { error: "internal_error", message: "Failed to load conversation.", requestId },
      500,
    );
  }
});

export { demo };
