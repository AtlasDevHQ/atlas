/**
 * Client-side error parsing for Atlas chat errors.
 *
 * The server returns JSON error bodies with { error, message, retryAfterSeconds? }.
 * This module parses those into user-friendly `ChatErrorInfo` objects.
 */

import type { AuthMode } from "@atlas/api/lib/auth/types";

/* ------------------------------------------------------------------ */
/*  ChatErrorCode — all server error codes                             */
/* ------------------------------------------------------------------ */

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
] as const;

/** Union of all error codes the server can return in the `error` field. */
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

/* ------------------------------------------------------------------ */
/*  ChatErrorInfo                                                      */
/* ------------------------------------------------------------------ */

/**
 * Structured error info extracted from a chat error response.
 *
 * - `title`  — Primary user-facing message (always present).
 * - `detail` — Optional secondary message with extra context.
 * - `retryAfterSeconds` — Seconds to wait before retrying (rate_limited only).
 *   Clamped to [0, 300].
 * - `code` — The server error code, if the response was valid JSON with a known code.
 */
export interface ChatErrorInfo {
  title: string;
  detail?: string;
  retryAfterSeconds?: number;
  code?: ChatErrorCode;
}

/* ------------------------------------------------------------------ */
/*  authErrorMessage                                                   */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  parseChatError                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse an AI SDK chat error into a user-friendly `ChatErrorInfo`.
 *
 * Expects `error.message` to contain a JSON string with `{ error, message, retryAfterSeconds? }`.
 * Falls back to a generic message when the body is not valid JSON (e.g. network failures,
 * HTML error pages, or unexpected formats).
 */
export function parseChatError(error: Error, authMode: AuthMode): ChatErrorInfo {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(error.message);
  } catch {
    return { title: "Something went wrong. Please try again." };
  }

  const code = typeof parsed.error === "string" ? parsed.error : undefined;
  const serverMessage = typeof parsed.message === "string" ? parsed.message : undefined;

  switch (code) {
    case "auth_error":
      return { title: authErrorMessage(authMode), code };

    case "rate_limited": {
      const raw = typeof parsed.retryAfterSeconds === "number" ? parsed.retryAfterSeconds : undefined;
      const clamped = raw !== undefined ? Math.max(0, Math.min(raw, 300)) : undefined;
      return {
        title: "Too many requests.",
        detail: clamped !== undefined
          ? `Try again in ${clamped} seconds.`
          : "Please wait before trying again.",
        retryAfterSeconds: clamped,
        code,
      };
    }

    case "configuration_error":
      return { title: "Atlas is not fully configured.", detail: serverMessage, code };

    case "no_datasource":
      return { title: "No data source configured.", detail: serverMessage, code };

    case "invalid_request":
      return { title: "Invalid request.", detail: serverMessage, code };

    case "provider_model_not_found":
      return { title: "The configured AI model was not found.", detail: serverMessage, code };

    case "provider_auth_error":
      return { title: "The AI provider could not authenticate.", detail: serverMessage, code };

    case "provider_rate_limit":
      return { title: "The AI provider is rate limiting requests.", detail: serverMessage, code };

    case "provider_timeout":
      return { title: "The AI provider timed out.", detail: serverMessage, code };

    case "provider_unreachable":
      return { title: "Could not reach the AI provider.", detail: serverMessage, code };

    case "provider_error":
      return { title: "The AI provider returned an error.", detail: serverMessage, code };

    case "internal_error":
      return { title: serverMessage ?? "An unexpected error occurred.", code };

    default:
      return { title: serverMessage ?? "Something went wrong. Please try again." };
  }
}
