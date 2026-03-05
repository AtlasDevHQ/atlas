/**
 * Shared types for Atlas UI.
 *
 * These are duplicated from @atlas/api to keep the frontend package independent
 * of the API package. The API is the source of truth — keep these in sync.
 */

// --- Auth types (from @atlas/api/lib/auth/types) ---

export const AUTH_MODES = ["none", "simple-key", "managed", "byot"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

// --- Conversation types (from @atlas/api/lib/conversation-types) ---

export type MessageRole = "user" | "assistant" | "system" | "tool";
export type Surface = "web" | "api" | "mcp" | "slack";

export interface Conversation {
  id: string;
  userId: string | null;
  title: string | null;
  surface: Surface;
  connectionId: string | null;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: unknown;
  createdAt: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

// --- Error types (from @atlas/api/lib/errors) ---

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

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

export interface ChatErrorInfo {
  title: string;
  detail?: string;
  retryAfterSeconds?: number;
  code?: ChatErrorCode;
}

function authErrorMessage(authMode: AuthMode): string {
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
