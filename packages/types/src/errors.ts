import type { AuthMode } from "./auth";

// Browser globals — declared here so the module compiles without `lib: ["dom"]`.
// At runtime these are only accessed behind `typeof` guards.
declare const window: unknown;
declare const navigator: { onLine?: boolean } | undefined;

// ---------------------------------------------------------------------------
// ChatErrorCode — all server error codes
// ---------------------------------------------------------------------------

// Note: `not_available` is intentionally excluded — it is an admin/CRUD code,
// not a chat error code. The SDK defines it separately in AtlasErrorCode.
//
// Scope: this catalog covers codes the chat-stream endpoint emits. Admin / mode /
// favorites / regional-routing routes return their own codes (`demo_readonly`,
// `workspace_migrating`, `misdirected_request`, `duplicate_favorite`,
// `favorite_cap_exceeded`, `invalid_favorite_text`, etc.). Those are catalogued
// in `apps/docs/content/docs/reference/error-codes.mdx` under the
// "Route-Response Error Codes" section. When adding a non-chat error code to a
// route, document it there rather than widening CHAT_ERROR_CODES — the
// compile-time exhaustiveness check here exists specifically to keep the chat
// surface tight.
export const CHAT_ERROR_CODES = [
  "auth_error",
  "session_expired",
  "rate_limited",
  "conversation_budget_exceeded",
  "configuration_error",
  "no_datasource",
  "invalid_request",
  "provider_model_not_found",
  "provider_auth_error",
  "provider_rate_limit",
  "provider_timeout",
  "provider_unreachable",
  "provider_error",
  "internal_error",
  "validation_error",
  "not_found",
  "forbidden",
  "forbidden_role",
  "org_not_found",
  "plan_limit_exceeded",
  "trial_expired",
  "billing_check_failed",
  "workspace_check_failed",
  "workspace_suspended",
  "workspace_throttled",
  "workspace_deleted",
] as const;

/** Union of all error codes the server can return in the `error` field. */
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

/** Type guard — checks whether a string is a known `ChatErrorCode`. */
export function isChatErrorCode(value: string): value is ChatErrorCode {
  return (CHAT_ERROR_CODES as ReadonlyArray<string>).includes(value);
}

// ---------------------------------------------------------------------------
// Retryable classification — transient vs permanent errors
// ---------------------------------------------------------------------------

/**
 * Exhaustive map from every `ChatErrorCode` to its retryable classification.
 *
 * Using `Record<ChatErrorCode, boolean>` ensures a compile-time error if a
 * new code is added to `CHAT_ERROR_CODES` without classifying it here.
 */
const RETRYABLE_MAP: Record<ChatErrorCode, boolean> = {
  // Transient — retrying may succeed
  rate_limited: true,
  provider_timeout: true,
  provider_unreachable: true,
  provider_error: true,
  provider_rate_limit: true,
  internal_error: true,
  // Permanent — retrying will not help
  auth_error: false,
  session_expired: false,
  configuration_error: false,
  no_datasource: false,
  invalid_request: false,
  provider_model_not_found: false,
  provider_auth_error: false,
  validation_error: false,
  not_found: false,
  forbidden: false,
  forbidden_role: false,
  org_not_found: false,
  plan_limit_exceeded: false,
  trial_expired: false,
  billing_check_failed: true,
  workspace_check_failed: true,
  workspace_suspended: false,
  workspace_throttled: true,
  workspace_deleted: false,
  // F-77 — retrying on the same conversation will keep failing because
  // the aggregate counter only resets on a new conversation. The UI
  // surfaces a "start a new conversation" affordance instead of retry.
  conversation_budget_exceeded: false,
};

/** Returns `true` if the given error code represents a transient, retryable failure. */
export function isRetryableError(code: ChatErrorCode): boolean {
  return RETRYABLE_MAP[code];
}

// ---------------------------------------------------------------------------
// ClientErrorCode — client-side error classification
// ---------------------------------------------------------------------------

/**
 * Client-side error codes for conditions detected before/without a server response.
 * These are distinct from `ChatErrorCode` (server-originated codes).
 */
export const CLIENT_ERROR_CODES = [
  "api_unreachable",
  "auth_failure",
  "rate_limited_http",
  "server_error",
  "offline",
] as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// ChatErrorInfo
// ---------------------------------------------------------------------------

/**
 * Structured error info extracted from a chat error response.
 *
 * - `title`  — Primary user-facing message (always present).
 * - `detail` — Optional secondary message with extra context.
 * - `retryAfterSeconds` — Seconds to wait before retrying (rate_limited only).
 *   Clamped to [0, 300].
 * - `code` — The server error code, if the response was valid JSON with a known code.
 * - `clientCode` — Client-side error classification (network/offline/HTTP status).
 *   Present when the error is detected client-side before parsing a server response.
 * - `retryable` — Whether the client should offer to retry. Three states:
 *   - `true` — transient error, retrying may succeed.
 *   - `false` — permanent error, retrying will not help.
 *   - `undefined` — error code is unknown or response was not valid JSON;
 *     the client cannot determine retryability.
 * - `requestId` — Server-assigned request ID (UUID) for log correlation.
 */
export interface ChatErrorInfo {
  title: string;
  detail?: string;
  retryAfterSeconds?: number;
  code?: ChatErrorCode;
  clientCode?: ClientErrorCode;
  retryable?: boolean;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// ChatContextWarning — mid-stream "answer is degraded" frame (#1988 B5)
// ---------------------------------------------------------------------------

/**
 * Codes for non-fatal preflight degradations that the agent ran past so the
 * user could still get an answer, at the cost of dropped context. Each code
 * names the specific context that was lost — the title/detail copy is built
 * server-side so the client never has to translate codes to copy.
 *
 * - `semantic_layer_unavailable` — the org-scoped whitelist + semantic index
 *   could not be loaded (typically internal-DB pool exhaustion). The agent
 *   falls back to the file-based default semantic layer.
 * - `learned_patterns_unavailable` — the learned-patterns lookup failed.
 *   The agent runs without question-similarity hints.
 */
export const CHAT_CONTEXT_WARNING_CODES = [
  "semantic_layer_unavailable",
  "learned_patterns_unavailable",
] as const;

export type ChatContextWarningCode = (typeof CHAT_CONTEXT_WARNING_CODES)[number];

/**
 * Mid-stream warning frame written to the AI-SDK UI message stream when the
 * agent's preflight loaders failed but the run was allowed to proceed with
 * degraded context. Sibling shape to {@link ChatErrorInfo} — same
 * `title`/`detail`/`requestId` fields — but discriminated by the literal
 * `severity: "warning"` so a client can route warnings and hard errors
 * through one parser without misclassifying a degradation as a failure.
 *
 * The discriminator is load-bearing: the AI-SDK transport delivers errors
 * and these warnings on the same `data-*` channel, and a UI that surfaces
 * a warning as a fatal modal would scare users away from a good answer.
 */
export interface ChatContextWarning {
  severity: "warning";
  code: ChatContextWarningCode;
  title: string;
  detail?: string;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// matchError — server-side pattern matching for common failures
// ---------------------------------------------------------------------------

/**
 * Result from `matchError()` — a pattern-matched, user-safe error.
 *
 * `code` is a suggested `ChatErrorCode`. Callers may override it based
 * on context (e.g. ECONNREFUSED in the chat route is `provider_unreachable`,
 * but in startup it's `internal_error`).
 */
export interface MatchedError {
  code: ChatErrorCode;
  message: string;
}

/**
 * Extract a hostname from an error message (e.g. "connect ECONNREFUSED 127.0.0.1:5432").
 * Never returns credentials or full connection strings.
 */
function extractHostFromError(msg: string): string {
  // Node.js format: "connect ECONNREFUSED 127.0.0.1:5432" or "connect ECONNREFUSED ::1:5432"
  const refusedMatch = msg.match(/ECONNREFUSED\s+(\S+)/i);
  if (refusedMatch) return refusedMatch[1];

  // ENOTFOUND format: "getaddrinfo ENOTFOUND some.host.com"
  const notFoundMatch = msg.match(/ENOTFOUND\s+(\S+)/i);
  if (notFoundMatch) return notFoundMatch[1];

  return "(unknown host)";
}

/**
 * Pattern-match common runtime errors into user-safe messages.
 *
 * Returns `null` when no pattern matches — the caller should fall through
 * to a generic `internal_error` response with a request ID.
 *
 * @param error  - The caught error (any type).
 * @param opts.timeoutSeconds - Configured query/request timeout, included in
 *   timeout messages so users know the limit. Defaults to 30.
 */
export function matchError(
  error: unknown,
  opts?: { timeoutSeconds?: number },
): MatchedError | null {
  const msg = error instanceof Error ? error.message : String(error);

  // Pool exhaustion — too many active database connections (transient)
  if (/too many (clients already|connections)|connection pool exhausted|remaining connection slots are reserved/i.test(msg)) {
    return {
      code: "rate_limited",
      message: "Database connection pool exhausted — try again in a few seconds, or reduce concurrent queries",
    };
  }

  // ECONNREFUSED — database or service unreachable
  if (/ECONNREFUSED/i.test(msg)) {
    const host = extractHostFromError(msg);
    return {
      code: "internal_error",
      message: `Database unreachable at ${host} — check that the database is running and accessible`,
    };
  }

  // ENOTFOUND — DNS resolution failure
  if (/ENOTFOUND/i.test(msg)) {
    const host = extractHostFromError(msg);
    return {
      code: "internal_error",
      message: `Could not resolve hostname "${host}" — check your connection URL`,
    };
  }

  // SSL / TLS errors — match specific error contexts, not bare keywords
  if (/SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ssl\s+connection|tls\s+handshake|certificate\s+(has expired|verify|error|rejected)/i.test(msg)) {
    return {
      code: "internal_error",
      message: "SSL connection failed — check sslmode in your connection string",
    };
  }

  // Timeout — query or request exceeded the configured limit
  if (/timeout|timed out|AbortError/i.test(msg)) {
    const seconds = Math.max(1, opts?.timeoutSeconds ?? 30);
    return {
      code: "provider_timeout",
      message: `Query exceeded the ${seconds}-second timeout — try a simpler query or increase ATLAS_QUERY_TIMEOUT`,
    };
  }

  // 502 / 503 — upstream provider unavailable (word boundaries prevent matching port numbers etc.)
  if (/\b502\s+Bad Gateway\b|\b503\s+Service Unavailable\b/i.test(msg)) {
    return {
      code: "provider_unreachable",
      message: "AI provider API unavailable — this is usually temporary, retry in a few seconds",
    };
  }

  // fetch failed — Node.js/undici connection failure (no ECONNREFUSED detail)
  if (/fetch failed/i.test(msg)) {
    return {
      code: "provider_unreachable",
      message: "Network request failed — the remote service may be down or unreachable",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// authErrorMessage
// ---------------------------------------------------------------------------

/**
 * Map an auth mode to a user-friendly error message.
 *
 * Different auth modes require different guidance:
 * - `simple-key`: the user needs to check or re-enter their API key.
 * - `managed`: the session likely expired; a fresh sign-in is needed.
 * - `byot`: the external token may have expired or been revoked.
 * - `none`: auth should not fail in this mode; a generic message is shown.
 */
export function authErrorMessage(authMode: AuthMode): string {
  switch (authMode) {
    case "simple-key":
      return "Invalid or missing API key. Check your key and try again.";
    case "managed":
      return "Your session has expired. Please sign in again.";
    case "byot":
      return "Authentication failed. Your token may have expired.";
    case "none":
      return "An unexpected authentication error occurred. Please refresh the page.";
    default: {
      const _exhaustive: never = authMode;
      return `Authentication failed (unknown mode: ${_exhaustive}).`;
    }
  }
}

// ---------------------------------------------------------------------------
// parseChatError
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// classifyClientError — detect network/offline/HTTP errors before JSON parsing
// ---------------------------------------------------------------------------

/**
 * Detect client-side error conditions from the raw Error object.
 *
 * The AI SDK wraps fetch failures in an Error whose message is the response body
 * (for HTTP errors) or the fetch error message (for network failures). We detect:
 *
 * - `TypeError` / "fetch failed" / "Failed to fetch" / "NetworkError" → `api_unreachable`
 * - `navigator.onLine === false` → `offline`
 * - HTTP status text patterns: "401" → `auth_failure`, "429" → `rate_limited_http`,
 *   "5xx" → `server_error`
 */
export function classifyClientError(error: Error): ClientErrorCode | null {
  const msg = error.message;

  // Skip classification if the message looks like a JSON response body —
  // parseChatError will extract the server error code from the JSON instead.
  if (msg.startsWith("{") || msg.startsWith("[")) {
    return null;
  }

  // Offline detection — only in browser environments (window + navigator.onLine).
  // Server-side runtimes (bun, node) may define `navigator` without a meaningful
  // `onLine` property, so we require `window` to exist and `navigator.onLine`
  // to be explicitly `false` (not just falsy/undefined).
  if (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    navigator.onLine === false
  ) {
    return "offline";
  }

  // Network failures — TypeError from fetch, or common network error messages
  if (
    error.name === "TypeError" ||
    /fetch failed|failed to fetch|networkerror|network\s+request\s+failed|ECONNREFUSED|ENOTFOUND|ERR_CONNECTION_REFUSED/i.test(msg)
  ) {
    return "api_unreachable";
  }

  // HTTP status detection — AI SDK sometimes puts status in the error message
  // Match patterns like "401", "Unauthorized", "429 Too Many Requests", "500 Internal Server Error"
  if (/\b401\b|Unauthorized/i.test(msg) && !/\bretry/i.test(msg)) {
    return "auth_failure";
  }
  if (/\b429\b|Too Many Requests/i.test(msg)) {
    return "rate_limited_http";
  }
  if (/\b50[0-9]\b|Internal Server Error|Bad Gateway|Service Unavailable/i.test(msg)) {
    return "server_error";
  }

  return null;
}

/**
 * Map a client-side error code to a user-friendly `ChatErrorInfo`.
 */
function clientErrorInfo(clientCode: ClientErrorCode, authMode: AuthMode): ChatErrorInfo {
  switch (clientCode) {
    case "offline":
      return {
        title: "You appear to be offline.",
        detail: "Reconnecting when your network is restored...",
        clientCode,
        retryable: true,
      };
    case "api_unreachable":
      return {
        title: "Unable to connect to Atlas.",
        detail: "Check your API URL configuration and ensure the server is running.",
        clientCode,
        retryable: true,
      };
    case "auth_failure":
      return {
        title: authErrorMessage(authMode),
        clientCode,
        retryable: false,
      };
    case "rate_limited_http":
      return {
        title: "Too many requests.",
        detail: "Please try again in a moment.",
        retryAfterSeconds: 30,
        clientCode,
        retryable: true,
      };
    case "server_error":
      return {
        title: "Something went wrong on our end.",
        detail: "Please try again.",
        clientCode,
        retryable: true,
      };
    default: {
      const _exhaustive: never = clientCode;
      return { title: `Unknown error (${_exhaustive}).` };
    }
  }
}

/**
 * Parse an AI SDK chat error into a user-friendly `ChatErrorInfo`.
 *
 * Expects `error.message` to contain a JSON string with `{ error, message, retryAfterSeconds? }`.
 * Falls back to a generic title when the body is not valid JSON (e.g. network failures,
 * HTML error pages, or unexpected formats), preserving the original message as `detail`
 * (truncated to 200 characters).
 *
 * Also classifies client-side errors (network failures, offline, HTTP status) before
 * attempting JSON parse, setting the `clientCode` field on the result.
 */
export function parseChatError(error: Error, authMode: AuthMode): ChatErrorInfo {
  // --- Client-side classification (network/offline/HTTP) ---
  const clientCode = classifyClientError(error);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(error.message);
  } catch {
    // Could not parse JSON — classify based on client-side detection
    if (clientCode) {
      return clientErrorInfo(clientCode, authMode);
    }
    const raw = error.message.length > 200 ? error.message.slice(0, 200) + "..." : error.message;
    return { title: "Something went wrong. Please try again.", detail: raw };
  }

  const rawCode = typeof parsed.error === "string" ? parsed.error : undefined;
  const serverMessage = typeof parsed.message === "string" ? parsed.message : undefined;
  const requestId = typeof parsed.requestId === "string" ? parsed.requestId : undefined;

  if (rawCode === undefined || !isChatErrorCode(rawCode)) {
    return { title: serverMessage ?? "Something went wrong. Please try again.", requestId };
  }

  const retryable = isRetryableError(rawCode);

  switch (rawCode) {
    case "auth_error":
      return { title: authErrorMessage(authMode), code: rawCode, retryable, requestId };

    case "rate_limited": {
      const raw = typeof parsed.retryAfterSeconds === "number" ? parsed.retryAfterSeconds : undefined;
      const clamped = raw !== undefined ? Math.max(0, Math.min(raw, 300)) : undefined;
      return {
        title: "Too many requests.",
        detail: clamped !== undefined
          ? `Try again in ${clamped} seconds.`
          : serverMessage ?? "Please wait before trying again.",
        retryAfterSeconds: clamped,
        code: rawCode,
        retryable,
        requestId,
      };
    }

    case "conversation_budget_exceeded":
      return {
        title: "This conversation has reached its limit.",
        detail: serverMessage ?? "Start a new conversation to continue. The current thread has hit the per-conversation step ceiling.",
        code: rawCode,
        retryable,
        requestId,
      };

    case "configuration_error":
      return { title: "Atlas is not fully configured.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "no_datasource":
      return { title: "No data source configured.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "invalid_request":
      return { title: "Invalid request.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "provider_model_not_found":
      return { title: "The configured AI model was not found.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "provider_auth_error":
      return { title: "The AI provider could not authenticate.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "provider_rate_limit":
      return { title: "The AI provider is rate limiting requests.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "provider_timeout":
      return { title: "The AI provider timed out.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "provider_unreachable":
      return { title: "Could not reach the AI provider.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "provider_error":
      return { title: "The AI provider returned an error.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "internal_error":
      return { title: serverMessage ?? "An unexpected error occurred.", code: rawCode, retryable, requestId };

    case "validation_error":
      return { title: "Validation error.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "not_found":
      return { title: "Not found.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "forbidden":
      return { title: "Access denied.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "session_expired":
      return { title: "Your session has expired.", detail: serverMessage ?? "Please sign in again.", code: rawCode, retryable, requestId };

    case "forbidden_role":
      return { title: "Admin role required.", detail: serverMessage, code: rawCode, retryable, requestId };

    case "org_not_found":
      return { title: "No active organization.", detail: serverMessage ?? "Select an organization and try again.", code: rawCode, retryable, requestId };

    case "plan_limit_exceeded":
      return { title: "Plan limit exceeded.", detail: serverMessage ?? "Upgrade your plan or wait until the next billing period.", code: rawCode, retryable, requestId };

    case "trial_expired":
      return { title: "Trial expired.", detail: serverMessage ?? "Upgrade to a paid plan to continue using Atlas.", code: rawCode, retryable, requestId };

    case "billing_check_failed":
      return { title: "Billing check failed.", detail: serverMessage ?? "Unable to verify billing status. Please try again.", code: rawCode, retryable, requestId };

    case "workspace_check_failed":
      return { title: "Workspace check failed.", detail: serverMessage ?? "Unable to verify workspace status. Please try again.", code: rawCode, retryable, requestId };

    case "workspace_suspended":
      return { title: "Workspace suspended.", detail: serverMessage ?? "Contact your workspace administrator to reactivate it.", code: rawCode, retryable, requestId };

    case "workspace_throttled":
      return { title: "Workspace throttled.", detail: serverMessage ?? "Your workspace has been temporarily throttled due to unusual activity. Requests will be delayed.", code: rawCode, retryable, requestId };

    case "workspace_deleted":
      return { title: "Workspace deleted.", detail: serverMessage ?? "This workspace has been permanently deleted. Create a new workspace to continue.", code: rawCode, retryable, requestId };

    default: {
      const _exhaustive: never = rawCode;
      return { title: serverMessage ?? `Something went wrong (${_exhaustive}).`, requestId };
    }
  }
}
