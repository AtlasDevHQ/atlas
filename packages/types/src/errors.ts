import type { AuthMode } from "./auth";

// ---------------------------------------------------------------------------
// ChatErrorCode — all server error codes
// ---------------------------------------------------------------------------

// Note: `not_available` is intentionally excluded — it is an admin/CRUD code,
// not a chat error code. The SDK defines it separately in AtlasErrorCode.
export const CHAT_ERROR_CODES = [
  "auth_error",
  "rate_limited",
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
  configuration_error: false,
  no_datasource: false,
  invalid_request: false,
  provider_model_not_found: false,
  provider_auth_error: false,
  validation_error: false,
  not_found: false,
  forbidden: false,
};

/** Returns `true` if the given error code represents a transient, retryable failure. */
export function isRetryableError(code: ChatErrorCode): boolean {
  return RETRYABLE_MAP[code];
}

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
  retryable?: boolean;
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

/**
 * Parse an AI SDK chat error into a user-friendly `ChatErrorInfo`.
 *
 * Expects `error.message` to contain a JSON string with `{ error, message, retryAfterSeconds? }`.
 * Falls back to a generic title when the body is not valid JSON (e.g. network failures,
 * HTML error pages, or unexpected formats), preserving the original message as `detail`
 * (truncated to 200 characters).
 */
export function parseChatError(error: Error, authMode: AuthMode): ChatErrorInfo {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(error.message);
  } catch {
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

    default: {
      const _exhaustive: never = rawCode;
      return { title: serverMessage ?? `Something went wrong (${_exhaustive}).`, requestId };
    }
  }
}
