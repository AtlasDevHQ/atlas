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

// --- Scheduled task types (from @atlas/api/lib/scheduled-task-types) ---

export type DeliveryChannel = "email" | "slack" | "webhook";
export type DeliveryStatus = "pending" | "sent" | "failed";
export type ApprovalMode = "auto" | "manual" | "admin-only";

export interface ScheduledTask {
  id: string;
  ownerId: string;
  name: string;
  question: string;
  cronExpression: string;
  deliveryChannel: DeliveryChannel;
  recipients: ScheduledTaskRecipient[];
  connectionId: string | null;
  approvalMode: ApprovalMode;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskRecipient {
  type: string;
  [key: string]: unknown;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "success" | "failed" | "skipped";
  conversationId: string | null;
  actionId: string | null;
  error: string | null;
  tokensUsed: number | null;
  deliveryStatus: DeliveryStatus | null;
  deliveryError: string | null;
  createdAt: string;
}

export interface ScheduledTaskWithRuns extends ScheduledTask {
  recentRuns: ScheduledTaskRun[];
}

export interface ScheduledTaskRunWithTaskName extends ScheduledTaskRun {
  taskName: string;
}

// --- Connection types (from @atlas/api/lib/connection-types) ---

export const DB_TYPES = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "snowflake", label: "Snowflake" },
  { value: "duckdb", label: "DuckDB" },
  { value: "salesforce", label: "Salesforce" },
] as const;

export type DBType = (typeof DB_TYPES)[number]["value"];

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface ConnectionHealth {
  status: HealthStatus;
  latencyMs: number;
  message?: string;
  checkedAt: string;
}

export interface ConnectionInfo {
  id: string;
  dbType: DBType;
  description?: string | null;
  health?: ConnectionHealth;
}

export interface ConnectionDetail {
  id: string;
  dbType: string;
  description: string | null;
  health: ConnectionHealth | null;
  maskedUrl: string | null;
  schema: string | null;
  managed: boolean;
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

// --- Entity sub-types (shared between admin entity-detail and schema explorer) ---

export interface Dimension {
  name: string;
  type: string;
  description?: string;
  sample_values?: string[];
  primary_key?: boolean;
  foreign_key?: boolean;
}

export interface Join {
  to: string;
  description?: string;
  relationship?: string;
  on?: string;
}

export interface Measure {
  name: string;
  sql: string;
  type?: string;
  description?: string;
}

export interface QueryPattern {
  name: string;
  description: string;
  sql: string;
}

// --- Schema explorer types (from public semantic API) ---

export interface SemanticEntitySummary {
  table: string;
  description: string;
  columnCount: number;
  joinCount: number;
  type: "table" | "view" | null;
}

export interface SemanticEntityDetail {
  table: string;
  description: string;
  type?: "table" | "view";
  dimensions: Record<string, Dimension> | Dimension[];
  joins?: Join[] | Record<string, Join>;
  measures?: Record<string, Measure> | Measure[];
  query_patterns?: Record<string, QueryPattern> | QueryPattern[];
}

// --- Admin entity detail type ---

export interface EntityData {
  name: string;
  table: string;
  description: string;
  type?: "table" | "view";
  dimensions: Record<string, Dimension> | Dimension[];
  joins?: Join[] | Record<string, Join>;
  measures?: Record<string, Measure> | Measure[];
  query_patterns?: Record<string, QueryPattern> | QueryPattern[];
}
