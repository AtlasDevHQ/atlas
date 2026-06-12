/**
 * Chat route — accepts a conversation and streams agent responses.
 *
 * Middleware stack:
 * withRequestId → auth → rate limit → withRequestContext(user) → validateEnvironment → conversation persistence → runAgent → stream.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, IpAllowlistPolicy } from "@atlas/api/lib/effect/services";
import { HTTPException } from "hono/http-exception";
import { validationHook } from "./validation-hook";
import { withRequestId, resolveMode, type AuthEnv } from "./middleware";
import { z } from "zod";
import { type UIMessage, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { APICallError, LoadAPIKeyError, NoSuchModelError } from "ai";
import { matchError, isRetryableError, type ChatContextWarning } from "@useatlas/types";
import { runAgent } from "@atlas/api/lib/agent";
import { corsResponseHeaders } from "@atlas/api/lib/cors";
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
import { markOrgActive } from "@atlas/api/lib/db/org-activity";
import { checkAgentBillingGate } from "@atlas/api/lib/billing/agent-gate";
import {
  createConversation,
  verifyGroupBelongsToOrg,
  addMessage,
  getConversation,
  generateTitle,
  persistAssistantSteps,
  reserveConversationBudget,
  resolveGroupForConnection,
  settleConversationSteps,
  updateConversationRoutingMode,
  updateConversationRestExcluded,
  updateConversationRestFocus,
  resolveRoutingMode,
} from "@atlas/api/lib/conversations";
import type { ConversationRoutingMode } from "@useatlas/types/conversation";
import {
  bindConversationToDashboard,
  resolveBoundDashboard,
  buildCardSummary,
} from "@atlas/api/lib/bound-chat-context";
// `buildBoundDashboardRegistry` is loaded lazily inside the request
// handler — it statically imports `tools/explore`, and existing tests
// (e.g. action-permissions.test.ts) partial-mock `tools/explore`.
// Keeping it dynamic mirrors the pattern used for the default
// `buildRegistry` below.
import { setStreamWriter, clearStreamWriter } from "@atlas/api/lib/tools/python-stream";
import { getSetting } from "@atlas/api/lib/settings";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { ErrorSchema } from "./shared-schemas";

const DEFAULT_CONVERSATION_STEP_CAP = 500;
const DEFAULT_AGENT_MAX_STEPS = 25;

/**
 * Resolve `ATLAS_CONVERSATION_STEP_CAP` with sensible fallbacks. Returns
 * 0 ("disabled") when the setting is `0`, an empty string, or invalid —
 * any non-positive integer disables the cap. F-77. `orgId` threads the
 * workspace tier (#3406).
 */
function getConversationStepCap(orgId?: string): number {
  const raw = getSetting("ATLAS_CONVERSATION_STEP_CAP", orgId);
  if (raw === undefined) return DEFAULT_CONVERSATION_STEP_CAP;
  if (raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CONVERSATION_STEP_CAP;
  return Math.floor(n);
}

/**
 * #3066 — order-independent equality for two string sets. Used to decide
 * whether the body's REST exclude-set differs from the conversation's
 * stored set before burning an UPDATE. Duplicates collapse (a set, not a
 * list), so `["a","a"]` and `["a"]` compare equal — which is correct for
 * an exclude-set keyed on `install_id`.
 */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const v of setA) if (!setB.has(v)) return false;
  return true;
}

/**
 * Resolve `ATLAS_AGENT_MAX_STEPS` for the F-77 upfront reservation.
 * Mirrors the agent loop's `getAgentMaxSteps()` clamp ([1, 100], default
 * 25) so the upfront charge matches the worst-case spend per request.
 * `orgId` threads the workspace tier (#3406) — must match the loop's
 * resolution or the reservation diverges from the actual budget.
 */
function getReservationStepBudget(orgId?: string): number {
  const raw = getSetting("ATLAS_AGENT_MAX_STEPS", orgId);
  if (raw === undefined || raw === "") return DEFAULT_AGENT_MAX_STEPS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AGENT_MAX_STEPS;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

const log = createLogger("chat");

// ---------------------------------------------------------------------------
// #1980 — error classification shared across pre-stream and mid-stream paths
// ---------------------------------------------------------------------------

/**
 * Provider Retry-After response headers can be arbitrarily large in the RFC.
 * 5 minutes is the longest delta the chat surface honours — beyond that the
 * UI should treat the call as failed and ask the user to start over.
 */
const PROVIDER_RETRY_AFTER_MAX_SECONDS = 300;

const retryAfterLog = createLogger("chat-retry-after");

/**
 * Parse a provider's `Retry-After` response header into seconds.
 *
 * Returns `undefined` when the header is missing, non-numeric, negative,
 * or in the HTTP-date form. RFC 7231 also permits an HTTP-date, but
 * providers almost never emit it and supporting it would require a
 * clock-drift-aware parser. Otherwise returns a non-negative integer
 * clamped to `PROVIDER_RETRY_AFTER_MAX_SECONDS`.
 */
function parseProviderRetryAfter(
  responseHeaders: Record<string, string> | undefined,
  requestId?: string,
): number | undefined {
  if (!responseHeaders) return undefined;
  // AI SDK normalizes header keys to lowercase, but providers/proxies
  // sometimes preserve mixed case — probe both.
  const raw = responseHeaders["retry-after"] ?? responseHeaders["Retry-After"];
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) {
    // Surface the parse miss so operators see new providers / proxies
    // emitting unexpected formats (HTTP-date, comments, etc.). The
    // underlying APICallError is still classified and logged at the
    // call site — this is operator visibility, not user-facing.
    retryAfterLog.debug(
      { raw, ...(requestId !== undefined && { requestId }) },
      "Provider Retry-After could not be parsed as delta-seconds",
    );
    return undefined;
  }
  return Math.min(Math.floor(n), PROVIDER_RETRY_AFTER_MAX_SECONDS);
}

/**
 * Codes the chat-route classifier emits.
 *
 * Narrower than the full `ChatErrorCode` union because middleware-produced
 * codes (`auth_error`, `validation_error`, `not_found`, `forbidden`, plan /
 * billing / workspace gates, etc.) are emitted *before* the classifier runs
 * and never travel through it. Restricting the emit set lets
 * `CLASSIFIER_STATUS_MAP` express a 1:1 code↔httpStatus invariant — adding a
 * branch to `classifyChatError` that returns a code outside this union is a
 * compile error.
 */
type ClassifierCode =
  | "provider_model_not_found"
  | "provider_auth_error"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_unreachable"
  | "provider_error"
  | "rate_limited"
  | "internal_error";

/**
 * The 1:1 code↔httpStatus contract for codes emitted by the classifier.
 *
 * Other status codes (401, 403, 404, 422) appear in the chat route's
 * OpenAPI declaration but are produced upstream of the classifier (auth
 * middleware, validation hook, conversation-ownership check) — they are
 * intentionally absent here.
 */
const CLASSIFIER_STATUS_MAP = {
  provider_model_not_found: 400,
  provider_auth_error: 503,
  provider_rate_limit: 503,
  provider_timeout: 504,
  provider_unreachable: 503,
  provider_error: 502,
  rate_limited: 429,
  internal_error: 500,
} as const satisfies Record<ClassifierCode, 400 | 429 | 500 | 502 | 503 | 504>;

type ClassifierHttpStatus = (typeof CLASSIFIER_STATUS_MAP)[ClassifierCode];

/**
 * Result of classifying an agent-loop error.
 *
 * Stores only `code`, `message`, and an optional `retryAfterSeconds`. The
 * derived fields (`httpStatus`, `retryable`) are looked up at call sites
 * via `CLASSIFIER_STATUS_MAP` and `isRetryableError` so there is exactly
 * one source of truth for each invariant.
 */
type ChatErrorClassification = {
  readonly code: ClassifierCode;
  readonly message: string;
  readonly retryAfterSeconds?: number;
};

/**
 * Classify a thrown or streamed agent-loop error.
 *
 * Single source of truth for the chat surface — invoked by both the
 * synchronous catch block (which builds the JSON HTTP response) and the
 * SSE `onError` path (which serializes the result into the AI SDK error
 * chunk's `errorText`). One classifier guarantees pre-stream and
 * mid-stream errors carry the same `code` / `retryAfterSeconds`, so a
 * client can't tell whether a failure happened before or after the first
 * byte and shouldn't have to.
 */
function classifyChatError(err: unknown, requestId?: string): ChatErrorClassification {
  if (GatewayModelNotFoundError.isInstance(err)) {
    return {
      code: "provider_model_not_found",
      message:
        "Model not found on the AI Gateway. Check that your ATLAS_MODEL uses the correct provider/model format (e.g., anthropic/claude-sonnet-4.6).",
    };
  }
  if (NoSuchModelError.isInstance(err)) {
    return {
      code: "provider_model_not_found",
      message:
        "The configured model was not found. Check ATLAS_MODEL and ATLAS_PROVIDER settings.",
    };
  }
  if (LoadAPIKeyError.isInstance(err)) {
    return {
      code: "provider_auth_error",
      message:
        "LLM provider API key could not be loaded. Check that the required API key environment variable is set.",
    };
  }
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    const retryAfterSeconds = parseProviderRetryAfter(err.responseHeaders, requestId);
    if (status === 401 || status === 403) {
      return {
        code: "provider_auth_error",
        message:
          "LLM provider authentication failed. Check that your API key is valid and has not expired.",
        ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
      };
    }
    if (status === 429) {
      return {
        code: "provider_rate_limit",
        message: "LLM provider rate limit reached. Wait a moment and try again.",
        ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
      };
    }
    if (status === 408 || /timeout/i.test(err.message)) {
      return {
        code: "provider_timeout",
        message:
          "The request timed out. The LLM provider took too long to respond. " +
          "Try again, or if using a local model, ensure it has sufficient resources.",
        ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
      };
    }
    return {
      code: "provider_error",
      message: `The LLM provider returned an error (HTTP ${status}). This is usually a temporary issue. Try again in a moment.`,
      ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
    };
  }
  // Pattern-matched fallback for non-APICallError exceptions. In this route
  // an unreachable host is the LLM, not the analytics datasource, so we pass
  // `subsystem: "provider"` — `matchError` then labels a connection failure
  // `provider_unreachable` directly (no post-hoc re-routing needed here).
  const matched = matchError(err, { subsystem: "provider" });
  if (matched) {
    if (matched.code === "provider_unreachable") {
      return {
        code: "provider_unreachable",
        message:
          "Could not reach the LLM provider. Check your network connection and provider status.",
      };
    }
    if (matched.code === "provider_timeout") {
      return {
        code: "provider_timeout",
        message:
          "The request timed out. The LLM provider took too long to respond. " +
          "Try again, or if using a local model, ensure it has sufficient resources.",
      };
    }
    if (matched.code === "rate_limited") {
      // Pool exhaustion is transient — the connection registry recovers
      // within seconds. The 5s suggestion mirrors the underlying
      // backoff in the pg pool code; surfacing it lets the UI show a
      // concrete delta instead of a vague "try again later".
      return {
        code: "rate_limited",
        message: matched.message,
        retryAfterSeconds: 5,
      };
    }
    // Any other matched code (provider_*, internal_error) falls through
    // to the unclassified path with the generic matched message —
    // currently no other matcher exists, but a future entry would.
  }
  return {
    code: "internal_error",
    message: "An unexpected error occurred.",
  };
}

/** Look up the HTTP status for a code emitted by `classifyChatError`. */
function statusForClassifierCode(code: ClassifierCode): ClassifierHttpStatus {
  return CLASSIFIER_STATUS_MAP[code];
}

/**
 * Serialize a `ChatErrorClassification` into the JSON body the SSE
 * error frame carries as `errorText`. Same shape as the synchronous
 * error response so a single `parseChatError()` works for both
 * transports — clients can't tell whether a failure happened before
 * or after the first byte.
 */
function buildMidStreamErrorFrame(err: unknown, requestId: string): string {
  const cls = classifyChatError(err, requestId);
  return JSON.stringify({
    error: cls.code,
    message: cls.message,
    retryable: isRetryableError(cls.code),
    ...(cls.retryAfterSeconds !== undefined && {
      retryAfterSeconds: cls.retryAfterSeconds,
    }),
    requestId,
  });
}

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
  /**
   * #2345 — per-turn execution target override. Set by the chat header's
   * env/member picker when the user temporarily routes one question at a
   * different replica (e.g. the conversation lives on "us-int" but the
   * user asks "and what does the EU mirror show?"). Does not persist
   * beyond the turn; the conversation's stored `connection_id` is
   * unchanged. Falls back to the conversation's connection_id when
   * omitted.
   */
  connectionId: z.string().optional(),
  /**
   * #2345 — content scope (connection group) for entity / dashboard
   * overlays. Sent at conversation creation by the combined group +
   * member picker; subsequent turns omit this field and inherit the
   * value from the persisted conversation row. Per-turn overrides target
   * execution, not content scope, so this field is rarely supplied on a
   * follow-up turn.
   */
  connectionGroupId: z.string().optional(),
  /**
   * #2518 — three-state Auto/Pin/All cross-environment picker mode.
   * When supplied, the chat route persists it onto the conversation row
   * AND uses it to drive `executeSQL` routing for this turn. Omitted
   * turns inherit the conversation's stored value (or `"pin"` for
   * pre-#2518 rows). The Zod enum is the single source of truth for
   * acceptable values — there's no DB-layer CHECK constraint (see
   * migration 0077).
   */
  routingMode: z.enum(["auto", "pin", "all"]).optional(),
  /**
   * #3066 — per-conversation REST datasource exclude-set. The scope
   * picker sends the excluded `install_id`s; the route persists them
   * onto the conversation row AND stamps them into the request context
   * so the REST resolver drops them for this turn. SQL routing is
   * unaffected.
   *
   * Presence is meaningful: an explicitly-sent `[]` clears any prior
   * exclusion (re-includes everything), whereas an OMITTED field inherits
   * the conversation's stored set. The web transport drops null/undefined
   * body fields, so the client must send the array (even `[]`) whenever
   * the picker was touched — otherwise a re-include silently keeps the
   * stale exclusion (the #3073 transport-omits-null bug class).
   *
   * Normalized to a canonical set at validation (`[...new Set(ids)]`) so the
   * persisted value can't carry duplicates for a set-shaped contract; `undefined`
   * (omitted) is preserved so the inherit-vs-clear branch still works.
   */
  restExcludedDatasourceIds: z
    .array(z.string())
    .transform((ids) => [...new Set(ids)])
    .optional(),
  /**
   * #3067 — per-conversation REST-only focus. The scope picker sends the
   * focused `install_id` (or `null` to clear focus); the route persists it
   * onto the conversation row AND stamps it into the request context so the
   * agent loop resolves only that datasource and suspends `executeSQL`.
   *
   * Presence is meaningful, like the exclude-set: an explicit `null` CLEARS
   * focus (back to default scope), whereas an OMITTED field inherits the
   * conversation's stored focus. The web transport must therefore send the
   * field (including `null`) whenever the picker was touched, or a clear
   * silently keeps the stale focus (the #3073 transport-omits-null bug class).
   *
   * An empty string is rejected (`.min(1)`): the only valid focus values are a
   * non-empty `install_id` (set) or `null` (clear). Allowing `""` through would
   * persist it as focus yet read back as "not focused" at the runtime truthy
   * gate — invalid stored state with the UI and agent disagreeing (CodeRabbit).
   */
  restFocusDatasourceId: z
    .string()
    .min(1, "restFocusDatasourceId must be a non-empty install_id or null.")
    .nullable()
    .optional(),
  /**
   * #2363 — bound dashboard editor. When the chat drawer opens on
   * `/dashboards/[id]` the client supplies the dashboard id once (on
   * the conversation-creating turn). The route stamps
   * `conversations.bound_dashboard_id` and subsequent turns inherit
   * the binding from the persisted row, so the field is optional on
   * follow-up turns.
   */
  boundDashboardId: z.string().uuid().optional(),
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
  return runEffect(c, Effect.gen(function* () {
    const req = c.req.raw;
    const { requestId } = yield* RequestContext;

    // Auth check — before context so user identity is available to all downstream logs
    const authAttempt = yield* Effect.tryPromise({
      try: () => authenticateRequest(req),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (authAttempt._tag === "Left") {
      log.error(
        {
          err: authAttempt.left,
          requestId,
        },
        "Auth dispatch failed",
      );
      return c.json(
        { error: "auth_error", message: "Authentication system error", retryable: false, requestId },
        500,
      );
    }
    const authResult: AuthResult = authAttempt.right;
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
  
    // Rate limit check — after auth so we have user identity. The chat
    // route uses its own carve-out bucket (F-74) so a 25-step LLM run does
    // not deplete the same allowance that serves cheap admin reads.
    const ip = getClientIP(req);
    const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
    const rateCheck = checkRateLimit(rateLimitKey, {
      bucket: "chat",
      orgId: authResult.user?.activeOrganizationId,
    });
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
  
    // IP allowlist — via `IpAllowlistPolicy` Tag (#2570). Resolved
    // through the runEffect-provided `EnterpriseLayer`; the no-op
    // default always allows when EE isn't loaded.
    {
      const orgId = authResult.user?.activeOrganizationId;
      if (orgId) {
        const policy = yield* IpAllowlistPolicy;
        const ipCheck = yield* policy.checkIPAllowlist(orgId, ip);
        if (!ipCheck.allowed) {
          log.warn({ requestId, orgId, ip }, "IP not in workspace allowlist");
          return c.json(
            { error: "ip_not_allowed", message: "Your IP address is not in the workspace's allowlist.", retryable: false, requestId },
            403,
          );
        }
      }
    }
  
    // #3451 — workspace status, abuse, and plan-limit enforcement via the
    // shared billing gate (lib/billing/agent-gate.ts): the same composition
    // the `executeAgentQuery` seam runs for /query, chat platforms, and the
    // scheduler, so web chat can never drift from those surfaces. This
    // route streams via `runAgent` directly and never reaches the seam, so
    // it calls the gate here and maps the block to the chat error envelope.
    // The 80–109% warning arrives on the allowed arm and is folded into the
    // `data-context-warning` stream at the writer below.
    const gateCheck = yield* Effect.promise(() => checkAgentBillingGate(authResult.user?.activeOrganizationId));
    if (!gateCheck.allowed) {
      log.warn(
        { requestId, orgId: authResult.user?.activeOrganizationId, errorCode: gateCheck.errorCode },
        "Chat blocked by billing enforcement",
      );
      const blockBody = {
        error: gateCheck.errorCode,
        message: gateCheck.errorMessage,
        retryable: gateCheck.retryable,
        requestId,
        ...(gateCheck.retryAfterSeconds !== undefined && { retryAfterSeconds: gateCheck.retryAfterSeconds }),
        ...(gateCheck.usage && { usage: gateCheck.usage }),
      };
      if (gateCheck.retryAfterSeconds !== undefined) {
        return c.json(blockBody, {
          status: gateCheck.httpStatus,
          headers: { "Retry-After": String(gateCheck.retryAfterSeconds) },
        });
      }
      return c.json(blockBody, gateCheck.httpStatus);
    }

    // #2377 — stamp workspace activity now that the org is authenticated and
    // confirmed live (status check above). The BYOT catalog refresh scheduler
    // reads `organization.last_active_at` to keep refreshing this workspace's
    // model catalog; without a recent stamp the workspace ages into the
    // dormancy gate and its catalog stops refreshing. Throttled +
    // fire-and-forget + managed-auth-gated inside the helper — a no-op on the
    // hot path almost always, and never able to fail the chat turn.
    markOrgActive(authResult.user?.activeOrganizationId);

    // Migration write-lock — block new conversations while workspace is migrating
    const chatOrgId = authResult.user?.activeOrganizationId;
    if (chatOrgId) {
      const migrationCheck = yield* Effect.tryPromise({
        try: async () => {
          const { isWorkspaceMigrating } = await import("@atlas/api/lib/residency/readonly");
          return isWorkspaceMigrating(chatOrgId);
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.either);

      if (migrationCheck._tag === "Right" && migrationCheck.right) {
        log.warn({ requestId, orgId: chatOrgId }, "Chat rejected — workspace is migrating");
        return c.json(
          { error: "workspace_migrating", message: "This workspace is currently being migrated to a new region. Please try again shortly.", retryable: true, requestId },
          409,
        );
      }
      if (migrationCheck._tag === "Left") {
        // Fail closed — block writes when migration status is uncertain
        log.warn({ err: migrationCheck.left.message, requestId, orgId: chatOrgId }, "Migration write-lock check failed — rejecting chat as a precaution");
        return c.json(
          { error: "migration_check_failed", message: "Unable to verify workspace migration status. Please try again in a moment.", retryable: true, requestId },
          503,
        );
      }
    }

    // Captured from the billing gate above; folded into the unified
    // `data-context-warning` stream at the writer below.
    const planWarning = gateCheck.warning;
  
    // Resolve atlas mode for this request (published vs developer)
    const atlasMode = resolveMode(
      req.headers.get("cookie"),
      req.headers.get("x-atlas-mode"),
      authResult,
    );

    // Bind user to AsyncLocalStorage so downstream code (logQueryAudit, etc.)
    // has access to user identity. The middleware already set up requestId context;
    // this nested call adds the user after inline auth completes.
    // #2072 — stamp 'chat' on the surface so chat-only approval rules
    // fire here but mcp/scheduler/slack-only rules do not.
    //
    // #2345 — the routing fields are resolved INSIDE this callback
    // because they depend on the parsed body + the persisted
    // conversation row. We re-enter `withRequestContext` once both are
    // known so plugin tools / agent helpers see them in AsyncLocalStorage
    // without a second middleware pass.
    return withRequestContext(
      { requestId, user: authResult.user, atlasMode, approvalSurface: "chat" },
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
        // #2363 — bound dashboard editor. The id supplied by the client
        // is honored only on the conversation-creating turn (and only
        // after dashboard org-ownership is verified inside
        // `bindConversationToDashboard`). Follow-up turns ignore the
        // body field and inherit the binding from the conversation row.
        const requestedBoundDashboardId = parsed.data.boundDashboardId;
        // Populated after conversation load/create when the row carries
        // a `bound_dashboard_id`. Drives the bound-mode tool registry
        // + system-prompt swap below.
        // Tracks why the chat ended up unbound when the client asked
        // for binding. Drives a `bound_unavailable` contextWarning the
        // drawer renders so the user knows their edits aren't being
        // captured (instead of the silent degrade-to-default-agent
        // fallback that the early review caught).
        let boundFailureReason:
          | "dashboard_not_found"
          | "conversation_not_found"
          | "error"
          | "no_db"
          | null = null;
        let boundDashboardForAgent:
          | {
              cardSummary: string;
              toolContext: {
                dashboardId: string;
                orgId: string | null | undefined;
                // #2364 — propagate userId so the bound editor tools can
                // route writes through the user's draft when the drafts
                // flag is on.
                // #2367 — also used by the screenshot tool as part of the
                // per-user cache key.
                userId?: string | null;
                // #2367 — forwarded `Cookie:` header so the screenshot
                // tool's headless browser can authenticate against the
                // bound dashboard's web route without a fresh sign-in.
                cookieHeader?: string | null;
              };
            }
          | null = null;
        // F-77 — track the upfront reservation so the post-stream
        // settlement can refund any unused budget. `null` means no
        // reservation was charged (cap disabled, new conversation, or
        // fail-open path).
        let reservedStepBudget: number | null = null;
        // #2345 — per-turn override resolves last so:
        //   1. The conversation's stored `connection_id` is the default.
        //   2. The body's `connectionId` (header picker) supersedes it
        //      for this turn only — never persisted back to the row.
        //   3. The conversation's stored `connection_group_id` is the
        //      content scope. Persisted at conversation creation; not
        //      changed by per-turn overrides.
        let effectiveConnectionId: string | undefined = parsed.data.connectionId;
        let effectiveConnectionGroupId: string | undefined = parsed.data.connectionGroupId;
        // #2518 — three-state picker mode. Body value (this turn) >
        // stored value on the row (back-compat default 'pin' if NULL).
        // The runtime treats undefined here as 'pin' to preserve
        // pre-#2518 single-execution semantics for legacy conversations.
        let effectiveRoutingMode: ConversationRoutingMode | undefined = parsed.data.routingMode;
        // #3066 — per-conversation REST exclude-set. Body value (this
        // turn, from the scope picker) > stored value on the row.
        // PRESENCE is meaningful: an explicit `[]` re-includes everything,
        // an OMITTED field inherits the row's set. We keep `undefined` vs
        // `[]` distinct all the way through so a re-include actually clears
        // the row (the transport-omits-null bug class, #3073).
        let effectiveRestExcluded: string[] | undefined =
          parsed.data.restExcludedDatasourceIds;
        // #3067 — per-conversation REST-only focus. Body value (this turn,
        // from the scope picker) > stored value on the row. PRESENCE is
        // meaningful: an explicit `null` clears focus, an OMITTED field
        // inherits the row's value. We keep `undefined` (omitted) vs `null`
        // (clear) distinct all the way through so a clear actually nulls the
        // row (the transport-omits-null bug class, #3073).
        let effectiveRestFocus: string | null | undefined =
          parsed.data.restFocusDatasourceId;

        // #2424 — when the body supplies `connectionGroupId`, verify it
        // belongs to the caller's active org BEFORE persisting it onto the
        // conversation row. Migration 0067 intentionally omits the FK
        // constraint; this layer is the org-ownership gate. Without it a
        // stale agent / buggy plugin / malicious admin could write a cross-org
        // pointer that downstream reads (#2422 territory) would surface as
        // `null` while the bad pointer survives in the row.
        //
        // Only validate body-supplied values: `resolveGroupForConnection`
        // below already org-scopes via the post-#2415 IS NOT DISTINCT FROM
        // predicate, and the existing-conversation branch reads the value
        // back from a row whose org-ownership was checked at create time.
        if (parsed.data.connectionGroupId) {
          const verdict = await verifyGroupBelongsToOrg(
            parsed.data.connectionGroupId,
            authResult.user?.activeOrganizationId,
          );
          if (verdict === "not_found") {
            return c.json(
              {
                error: "invalid_connection_group",
                message: "The requested environment is not available in this workspace.",
                retryable: false,
                requestId,
              },
              400,
            );
          }
          if (verdict === "error") {
            return c.json(
              {
                error: "internal_error",
                message: "Could not verify environment ownership. Please retry.",
                retryable: true,
                requestId,
              },
              500,
            );
          }
          // `no_db` falls through — self-hosted single-tenant without
          // internal DB has no group concept to begin with.
        }

        // Conversation persistence — Ownership verification blocks here (can 404); message writes are fire-and-forget via internalExecute.
        if (hasInternalDB()) {
          if (conversationId) {
            // Ownership verification — NOT best-effort, this is a security check
            const existing = await getConversation(conversationId, authResult.user?.id, authResult.user?.activeOrganizationId);
            if (!existing.ok) {
              return c.json({ error: "not_found", message: "Conversation not found.", retryable: false, requestId }, 404);
            }
            // #2345 — resolve effective routing. The conversation's
            // stored values are the default; the body override (header
            // picker) supersedes for this turn only. `connectionGroupId`
            // is rarely overridden per-turn (content scope is sticky to
            // the conversation), but we still respect the body value
            // when present for symmetry with `connectionId`.
            if (effectiveConnectionId === undefined && existing.data.connectionId) {
              effectiveConnectionId = existing.data.connectionId;
            }
            if (effectiveConnectionGroupId === undefined && existing.data.connectionGroupId) {
              effectiveConnectionGroupId = existing.data.connectionGroupId;
            }
            // #2518 — inherit picker mode from the conversation row when
            // the body omits it. NULL on the row is read as 'pin' at the
            // routing edge (executeSQL); we leave effectiveRoutingMode
            // undefined here so the absence vs. explicit-pin distinction
            // survives all the way to `withRequestContext`.
            if (effectiveRoutingMode === undefined && existing.data.routingMode) {
              effectiveRoutingMode = existing.data.routingMode;
            }
            // #3066 — inherit the exclude-set from the row when the body
            // omits it. An explicit `[]` from the body is NOT omitted (it
            // re-includes everything), so the `=== undefined` guard keeps
            // that distinct from "field absent → use the row".
            if (
              effectiveRestExcluded === undefined &&
              Array.isArray(existing.data.restExcludedDatasourceIds)
            ) {
              effectiveRestExcluded = existing.data.restExcludedDatasourceIds;
            }
            // #3067 — inherit REST-only focus from the row when the body omits
            // it. An explicit `null` from the body is NOT omitted (it clears
            // focus), so the `=== undefined` guard keeps "clear" distinct from
            // "field absent → use the row".
            if (effectiveRestFocus === undefined) {
              effectiveRestFocus = existing.data.restFocusDatasourceId ?? null;
            }
            // Persist the picker mode if the body explicitly set one for
            // this turn. We compare against the stored value to avoid
            // burning an UPDATE on every chat turn when nothing changed.
            if (
              parsed.data.routingMode !== undefined &&
              parsed.data.routingMode !== existing.data.routingMode
            ) {
              // Fire-and-forget within the request lifetime: a transient
              // write failure shouldn't block the chat turn (the runtime
              // will still honor the body's routingMode for this turn).
              // Note we don't await — the helper logs its own failures.
              updateConversationRoutingMode(
                conversationId,
                parsed.data.routingMode,
                authResult.user?.id,
                authResult.user?.activeOrganizationId,
              ).catch((err: unknown) => {
                log.warn(
                  {
                    err: err instanceof Error ? err.message : String(err),
                    conversationId,
                  },
                  "updateConversationRoutingMode rejected",
                );
              });
            }
            // #3066 — persist the exclude-set when the body explicitly set
            // one this turn AND it differs from the stored set. Set-equality
            // is order-independent so a reorder doesn't burn an UPDATE; an
            // explicit `[]` that clears a prior non-empty set DOES persist
            // (that's the re-include path the transport must support).
            if (
              parsed.data.restExcludedDatasourceIds !== undefined &&
              !sameStringSet(
                parsed.data.restExcludedDatasourceIds,
                existing.data.restExcludedDatasourceIds ?? [],
              )
            ) {
              // Fire-and-forget, same contract as routing-mode above: the
              // runtime honours the body's set for this turn even if the
              // persist fails; the helper logs its own failures.
              updateConversationRestExcluded(
                conversationId,
                parsed.data.restExcludedDatasourceIds,
                authResult.user?.id,
                authResult.user?.activeOrganizationId,
              ).catch((err: unknown) => {
                log.warn(
                  {
                    err: err instanceof Error ? err.message : String(err),
                    conversationId,
                  },
                  "updateConversationRestExcluded rejected",
                );
              });
            }
            // #3067 — persist REST-only focus when the body explicitly set one
            // this turn AND it differs from the stored value. An explicit
            // `null` that clears a prior focus DOES persist (the clear path the
            // transport must support); normalize the row's value with `?? null`
            // so a string→null or null→string change is detected.
            if (
              parsed.data.restFocusDatasourceId !== undefined &&
              parsed.data.restFocusDatasourceId !==
                (existing.data.restFocusDatasourceId ?? null)
            ) {
              // Fire-and-forget, same contract as routing-mode / exclude-set
              // above: the runtime honours the body's focus for this turn even
              // if the persist fails; the helper logs its own failures.
              updateConversationRestFocus(
                conversationId,
                parsed.data.restFocusDatasourceId,
                authResult.user?.id,
                authResult.user?.activeOrganizationId,
              ).catch((err: unknown) => {
                log.warn(
                  {
                    err: err instanceof Error ? err.message : String(err),
                    conversationId,
                  },
                  "updateConversationRestFocus rejected",
                );
              });
            }
            // F-77 — aggregate per-conversation step ceiling. The per-request
            // caps (stepCountIs(25), 180s wall-clock) bound a single agent
            // run; this gate bounds the long-tail follow-up flow on a single
            // conversationId. The reservation charges the row by the worst-
            // case step budget atomically, so concurrent runs cannot all pass
            // the gate at `cap − 1` — the ceiling is enforced at the row, not
            // here. Settlement on stream finish refunds the unused portion.
            // `no_db` / `error` reservation results fail open so a transient
            // internal-DB glitch never 429s the whole chat surface; sustained
            // outages surface via a throttled `log.warn` from the helper.
            const stepCap = getConversationStepCap(authResult.user?.activeOrganizationId);
            if (stepCap > 0) {
              const stepBudget = getReservationStepBudget(authResult.user?.activeOrganizationId);
              const reservation = await reserveConversationBudget(
                conversationId,
                stepBudget,
                stepCap,
              );
              if (reservation.status === "exceeded") {
                log.warn(
                  { requestId, conversationId, totalSteps: reservation.totalSteps, cap: stepCap },
                  "Conversation budget exceeded — rejecting follow-up message",
                );
                // Audit so abuse detection picks up workspaces grinding the cap.
                // Pass `scope: "workspace"` explicitly so a future system-actor
                // codepath cannot silently invert the row's scope to "platform".
                logAdminAction({
                  actionType: ADMIN_ACTIONS.conversation.budgetExceeded,
                  targetType: "conversation",
                  targetId: conversationId,
                  status: "failure",
                  scope: "workspace",
                  metadata: { totalSteps: reservation.totalSteps, cap: stepCap },
                });
                return c.json(
                  {
                    error: "conversation_budget_exceeded",
                    message: "This conversation has reached its step limit. Start a new conversation to continue.",
                    retryable: false,
                    requestId,
                  },
                  429,
                );
              }
              if (reservation.status === "ok") {
                reservedStepBudget = stepBudget;
              }
              // status === "no_db" | "error" → fail open, no reservation
              // charged. The helper has already logged the failure (rate-
              // limited) so the operator sees sustained outages.
            }
            // Persist the latest user message. `addMessage` is fire-and-
            // forget via `internalExecute`; the synchronous try/catch only
            // covers pool-init throws — async insert failures are logged
            // inside `internalExecute`'s circuit breaker.
            try {
              const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
              if (lastUserMsg) {
                addMessage({ conversationId, role: "user", content: lastUserMsg.parts });
              }
            } catch (err) {
              log.warn(
                { err: err instanceof Error ? err.message : String(err), requestId, conversationId },
                "Failed to persist user message (pool init throw)",
              );
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
              // #2345 — when the create payload supplies a connectionId
              // without an explicit connectionGroupId, resolve the
              // group from the connection's 0062 1:1 mapping so the
              // persisted row carries both columns. Best-effort: a null
              // group_id (legacy single-connection deploy) falls back
              // to legacy behavior — the runtime treats undefined as
              // "no group scope" without surfacing an error.
              if (
                effectiveConnectionId &&
                effectiveConnectionGroupId === undefined
              ) {
                const resolved = await resolveGroupForConnection(
                  effectiveConnectionId,
                  authResult.user?.activeOrganizationId,
                );
                if (resolved) {
                  effectiveConnectionGroupId = resolved;
                }
              }
              const created = await createConversation({
                userId: authResult.user?.id,
                title,
                surface: "web",
                connectionId: effectiveConnectionId ?? null,
                connectionGroupId: effectiveConnectionGroupId ?? null,
                // #2518 — persist the picker mode the user picked at
                // creation. NULL on the row reads as 'pin' downstream
                // for back-compat, so omitting this on legacy callers
                // is structurally safe.
                routingMode: effectiveRoutingMode ?? null,
                // #3066 — persist the exclude-set the user picked at
                // creation. Undefined ⇒ column default '{}' (all in scope).
                restExcludedDatasourceIds: effectiveRestExcluded,
                // #3067 — persist REST-only focus the user picked at creation.
                // Undefined / null ⇒ NULL (not focused). The transport sends
                // null when the picker is in default mode, so `?? null` keeps a
                // newly-created default-mode conversation un-focused.
                restFocusDatasourceId: effectiveRestFocus ?? null,
                orgId: authResult.user?.activeOrganizationId,
              });
              if (created) {
                conversationId = created.id;
                // Persist the user message that triggered conversation creation
                if (firstUserMsg) {
                  addMessage({ conversationId, role: "user", content: firstUserMsg.parts });
                }
                // #2363 — stamp the bound-dashboard pointer immediately
                // after creation, BEFORE the agent runs, so the first
                // turn already sees the bound-mode registry. Best-effort:
                // a bind failure (dashboard not found / cross-org / DB
                // glitch) logs + falls back to the default agent loop.
                // The drawer client will see the empty card summary on
                // its next refresh and can prompt the user to retry.
                if (requestedBoundDashboardId) {
                  const bound = await bindConversationToDashboard(
                    conversationId,
                    requestedBoundDashboardId,
                    { orgId: authResult.user?.activeOrganizationId },
                  );
                  if (!bound.ok) {
                    log.warn(
                      {
                        requestId,
                        conversationId,
                        dashboardId: requestedBoundDashboardId,
                        reason: bound.reason,
                      },
                      "Failed to bind conversation to dashboard — chat will run unbound",
                    );
                    // Remember the bind failure so we can push a
                    // contextWarning into the stream below — without it
                    // the drawer would silently run the default agent
                    // and the user would never know their edits weren't
                    // being captured.
                    boundFailureReason = bound.reason;
                  }
                }
              }
            } catch (err) {
              log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to create conversation");
            }
          }
        }

        // #2363 — resolve the bound dashboard (if any) AFTER conversation
        // load/create. Reads the persisted `bound_dashboard_id` so
        // follow-up turns inherit the binding without resending it.
        // Falls back to the default agent when the resolve returns
        // `not_bound` / `dashboard_not_found` (deleted between turns) /
        // `error` — the route never hard-fails on a binding lookup.
        if (conversationId) {
          const resolved = await resolveBoundDashboard(conversationId, {
            orgId: authResult.user?.activeOrganizationId,
          });
          if (resolved.ok) {
            boundDashboardForAgent = {
              cardSummary: buildCardSummary(resolved.dashboard.cards),
              toolContext: {
                dashboardId: resolved.dashboard.id,
                orgId: authResult.user?.activeOrganizationId,
                // #2364 — propagate userId so the bound editor tools
                // can route mutations through the per-user draft when
                // `ATLAS_DASHBOARD_DRAFTS_ENABLED=true`. Anonymous
                // bound chats stay on the legacy direct-published path.
                // #2367 — also used by the screenshot tool as part of
                // the per-user cache key (forward-compat with the per-
                // user draft view that lands as drafts mature).
                userId: authResult.user?.id ?? null,
                // #2367 — forwarded to the screenshot tool's headless
                // browser so it can authenticate against the dashboard's
                // web route without doing a fresh sign-in.
                cookieHeader: req.headers.get("cookie"),
              },
            };
          } else if (resolved.reason === "error") {
            log.warn(
              { requestId, conversationId, reason: resolved.reason },
              "resolveBoundDashboard failed — falling back to default agent",
            );
            boundFailureReason = "error";
          } else if (resolved.reason === "dashboard_not_found" && requestedBoundDashboardId) {
            // The dashboard got deleted between turns (FK SET NULL
            // cleared the binding). Treat as a bind failure so the
            // drawer surfaces the loss rather than silently turning
            // into an unbound chat that won't edit anything.
            boundFailureReason = "dashboard_not_found";
          } else if (requestedBoundDashboardId && resolved.reason === "not_bound" && !boundFailureReason) {
            // The client supplied boundDashboardId but the persisted
            // row carries no binding. If the bind step above set
            // `boundFailureReason`, we already know why. Otherwise
            // something stripped the binding between the bind UPDATE
            // and this resolve — surface as a generic error so the
            // drawer alerts the user instead of "agent works but
            // won't edit" silent failure.
            log.warn(
              { requestId, conversationId, dashboardId: requestedBoundDashboardId },
              "Bound chat resolved as not_bound despite request — possible binding race",
            );
            boundFailureReason = "error";
          }
          // not_bound (no request) / no_db / dashboard_not_found without
          // a requested bind → silent fallback to default agent (the
          // chat surface is the root `/` page, not the drawer).
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
  
          // Merge plugin tools (if any) on top of the current registry.
          // #2363 — skip the merge entirely when the agent is bound to a
          // dashboard. The bound editor surface is intentionally narrow
          // (explore + executeSQL + 6 editor tools) and plugin / action
          // tools just confuse the model mid-edit. The bound registry
          // is built fresh below.
          if (!boundDashboardForAgent) {
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
          } else {
            // Bound mode — replace the registry entirely with the
            // dashboard editor toolset. Dropping action / plugin /
            // python tools is the whole point of binding. Dynamic
            // import keeps `tools/explore` out of chat.ts's static
            // graph so partial-mock tests stay green.
            const { buildBoundDashboardRegistry } = await import(
              "@atlas/api/lib/tools/bound-dashboard-registry"
            );
            toolRegistry = buildBoundDashboardRegistry(boundDashboardForAgent.toolContext);
          }
  
          // #1988 B5 — out-array the agent's preflight loaders push into
          // when the org semantic layer or learned-patterns lookup fail.
          // We forward each as an SSE `data-context-warning` frame below
          // so the UI can render a "degraded answer" banner. The legacy
          // system-prompt `warnings` string is still populated; both paths
          // run together because the model needs to know it's working with
          // reduced context AND the user needs to know their answer was
          // generated against fallback data.
          const contextWarnings: ChatContextWarning[] = [];

          // Surface bind/resolve failures from the bound-chat surface
          // as a context warning the drawer renders. Without this the
          // chat runs against the default agent — fine semantics, but
          // the user gets a "agent ignores my edit requests" experience
          // with no signal anything went wrong. (Review followup —
          // silent-failure C2 + C3.)
          if (boundFailureReason && requestedBoundDashboardId) {
            const detail =
              boundFailureReason === "dashboard_not_found"
                ? "That dashboard is no longer available — edits in this chat will not take effect. Open a different dashboard to continue editing."
                : boundFailureReason === "no_db"
                  ? "Dashboard editing is unavailable: the workspace database is not reachable. Try again shortly."
                  : "Could not load the dashboard context for this chat — edits will not be applied. Reopen the chat drawer to retry.";
            contextWarnings.push({
              severity: "warning",
              code: "bound_dashboard_unavailable",
              title: "Dashboard editing unavailable",
              detail,
              requestId,
            });
          }

          // Call runAgent first so errors (provider auth, config, etc.) are
          // caught by the outer try-catch and returned as proper JSON errors.
          // The agent stream is then merged into a UIMessageStream that supports
          // writing custom data parts (Python progress events).
          //
          // #2345 — nest the agent invocation inside a `withRequestContext`
          // that carries the resolved `connectionId` / `connectionGroupId`
          // so plugin tools and downstream helpers see the routing in
          // AsyncLocalStorage. Both fields are stripped when undefined
          // so the existing `getRequestContext()` consumers continue to
          // see the legacy shape on conversations without group scope.
          const agentResult = await withRequestContext(
            {
              requestId,
              user: authResult.user,
              atlasMode,
              approvalSurface: "chat",
              ...(effectiveConnectionId !== undefined && {
                connectionId: effectiveConnectionId,
              }),
              ...(effectiveConnectionGroupId !== undefined && {
                connectionGroupId: effectiveConnectionGroupId,
              }),
              // #2518 — picker mode reaches `executeSQL` via the request
              // context so the agent's `scope` parameter can be overridden
              // before reaching `resolveRoutingPlan`. When neither the
              // body nor the persisted row carries a value, the
              // conversation predates the picker column (NULL on the row)
              // — apply the back-compat default 'pin' here so the agent's
              // scope hints don't suddenly start fanning out on
              // pre-#2518 chats. The tool's own default ('auto') only
              // kicks in for non-chat callers (MCP / scheduler / direct
              // tool tests).
              routingMode: resolveRoutingMode(effectiveRoutingMode),
              // #3066 — the resolved exclude-set reaches the REST datasource
              // resolver (agent.ts) via the request context. Stripped when
              // undefined (and when empty — an empty set excludes nothing,
              // so omitting it keeps the legacy "no exclusions" shape).
              ...(effectiveRestExcluded !== undefined &&
                effectiveRestExcluded.length > 0 && {
                  restExcludedDatasourceIds: effectiveRestExcluded,
                }),
              // #3067 — the resolved focus reaches the agent loop via the
              // request context. Stamped only when truthy (a non-null
              // install_id); a null/cleared focus keeps the legacy
              // not-focused shape so default-scope turns are unchanged.
              ...(effectiveRestFocus
                ? { restFocusDatasourceId: effectiveRestFocus }
                : {}),
            },
            () =>
              runAgent({
                messages,
                ...(toolRegistry && { tools: toolRegistry }),
                conversationId,
                ...(warnings.length > 0 && { warnings }),
                contextWarnings,
                ...(boundDashboardForAgent && {
                  boundDashboardContext: { cardSummary: boundDashboardForAgent.cardSummary },
                }),
              }),
          );
  
          // Register stream writer so Python tool can send progress events.
          // The writer is set before merge() triggers tool execution reads.
          // #1980 — both `toUIMessageStream`'s onError (per-chunk error
          // events from streamText) and `createUIMessageStream`'s onError
          // (the merge promise rejecting) serialize a structured
          // ChatErrorInfo-shaped JSON body so the client can route the
          // failure through the same `parseChatError()` it uses for
          // pre-stream errors. Both call sites delegate to the shared
          // classifier so codes, retryability, and Retry-After deltas
          // stay aligned.
          const stream = createUIMessageStream({
            execute: ({ writer }) => {
              // Fold the plan-budget signal into the same structured
              // `data-context-warning` channel as the agent's preflight
              // degradations so the client only has to handle one wire
              // shape. unshift so the budget signal renders above any
              // preflight ones — it usually warrants the most attention.
              if (planWarning) {
                contextWarnings.unshift({
                  severity: "warning",
                  code: "plan_limit_warning",
                  title: "Approaching plan limit",
                  detail: planWarning.message,
                });
              }
              // Each frame carries `severity: "warning"` so a client
              // routing these through the same parser as the `data-error`
              // frame (#1980) does not misclassify a degraded answer as
              // a failure. The route stamps `requestId` only when the
              // warning didn't already carry one. Today no emit site
              // attaches its own correlation id (the agent's Effect
              // catchAll arms push only the wire-DTO fields); the
              // ternary keeps the surface safe to extend without
              // re-auditing this loop.
              //
              // Ordering is load-bearing: this loop runs BEFORE
              // `writer.merge(agentResult.toUIMessageStream(...))` below,
              // so the UI receives the warning frame(s) ahead of any
              // model text-delta. A "render banner before content"
              // assumption in the UI depends on this — moving the loop
              // after merge would race the first delta.
              for (const warning of contextWarnings) {
                writer.write({
                  type: "data-context-warning",
                  data: warning.requestId ? warning : { ...warning, requestId },
                });
              }
              setStreamWriter(requestId, writer);
              writer.merge(
                agentResult.toUIMessageStream({
                  onError: (error) => {
                    log.error(
                      { err: error instanceof Error ? error : new Error(String(error)), requestId },
                      "Mid-stream error (toUIMessageStream)",
                    );
                    return buildMidStreamErrorFrame(error, requestId);
                  },
                }),
              );
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
              return buildMidStreamErrorFrame(error, requestId);
            },
          });
  
          // Streaming responses bypass Hono's CORS middleware (we throw a raw
          // Response via HTTPException so OpenAPIHono's onError returns it
          // unchanged). Re-apply CORS headers here so cross-origin embedders
          // (e.g. @useatlas/react widget on a different domain) receive
          // Access-Control-Allow-Origin. (#2037)
          const streamResponse = createUIMessageStreamResponse({
            stream,
            headers: {
              "X-Accel-Buffering": "no",
              "Cache-Control": "no-cache, no-transform",
              ...corsResponseHeaders(c.req.header("Origin") ?? ""),
              ...(conversationId ? { "x-conversation-id": conversationId } : {}),
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
  
          // Fire-and-forget: persist assistant response (text + tool results) after stream completes.
          if (conversationId) {
            persistAssistantSteps({ conversationId, steps: agentResult.steps, label: "chat" });
            // F-77 — settlement. The reservation charged the row by the
            // worst-case step budget upfront so concurrent runs couldn't
            // overshoot the cap. Once the agent loop resolves we refund
            // the unused portion. If the stream errors out we keep the
            // full reservation charged — that's the conservative cost
            // accounting choice (an attacker spinning up streams that
            // fail mid-flight still pays full budget).
            if (reservedStepBudget !== null) {
              const convIdForSettle = conversationId;
              const reservedForSettle = reservedStepBudget;
              void Promise.resolve(agentResult.steps)
                .then((steps) => {
                  settleConversationSteps(convIdForSettle, reservedForSettle, steps.length);
                })
                .catch((err: unknown) => {
                  log.warn(
                    {
                      err: err instanceof Error ? err.message : String(err),
                      requestId,
                      conversationId: convIdForSettle,
                    },
                    "F-77 step-cap settlement skipped — agent stream failed; reservation stays charged",
                  );
                });
            }
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
          const cls = classifyChatError(err, requestId);
          const httpStatus = statusForClassifierCode(cls.code);
          const retryable = isRetryableError(cls.code);

          // Pool exhaustion is transient (the connection registry recycles
          // within seconds), so log at warn — it's not operator-actionable.
          // Everything else is a genuine error.
          if (cls.code === "rate_limited") {
            log.warn(
              { err: errObj, category: cls.code },
              "Matched error: %s",
              cls.code,
            );
          } else {
            log.error(
              {
                err: errObj,
                category: cls.code,
                ...(APICallError.isInstance(err) && { statusCode: err.statusCode }),
              },
              "Chat error: %s",
              cls.code,
            );
          }

          // The unclassified fallback gets a ref-id message so the operator
          // can correlate the user's report with server logs.
          const userMessage =
            cls.code === "internal_error"
              ? `An unexpected error occurred. Quote ref ${requestId.slice(0, 8)} when reporting this issue.`
              : cls.message;

          const body = {
            error: cls.code,
            message: userMessage,
            retryable,
            ...(cls.retryAfterSeconds !== undefined && {
              retryAfterSeconds: cls.retryAfterSeconds,
            }),
            requestId,
          };

          if (cls.retryAfterSeconds !== undefined) {
            return c.json(body, {
              status: httpStatus,
              headers: { "Retry-After": String(cls.retryAfterSeconds) },
            });
          }
          return c.json(body, httpStatus);
        }
      },
    );
  }), { label: "chat" });
});

export { chat };
