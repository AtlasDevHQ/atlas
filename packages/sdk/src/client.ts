/**
 * Atlas TypeScript SDK — typed client for the Atlas API.
 *
 * Thin typed wrapper around fetch. All request/response types match
 * the Hono route definitions in @atlas/api.
 */

// ---------------------------------------------------------------------------
// Re-exports from @useatlas/types (canonical shared types)
// ---------------------------------------------------------------------------

export type {
  AuthMode,
  Conversation,
  Message,
  ConversationWithMessages,
  DBType,
  HealthStatus,
  ConnectionHealth,
  ConnectionInfo,
  ConnectionDetail,
  ActionApprovalMode,
  DeliveryChannel,
  RunStatus,
  Recipient,
  ScheduledTask,
  ScheduledTaskWithRuns,
  ScheduledTaskRun,
} from "@useatlas/types";

import type {
  AuthMode,
  ChatErrorCode,
  Conversation,
  ConversationWithMessages,
  ConnectionHealth,
  ConnectionInfo,
  DeliveryChannel,
  ActionApprovalMode,
  Recipient,
  ScheduledTask,
  ScheduledTaskWithRuns,
  ScheduledTaskRun,
} from "@useatlas/types";

/** @deprecated Use `Recipient` instead. */
export type ScheduledTaskRecipient = Recipient;

// ---------------------------------------------------------------------------
// SDK-specific types
// ---------------------------------------------------------------------------

/**
 * All error codes the Atlas server can return, plus SDK-specific codes.
 *
 * Server codes derived from `ChatErrorCode` in `@useatlas/types/errors`
 * plus admin route codes (`forbidden`, `not_found`, `not_available`).
 * SDK-specific: `network_error`, `invalid_response`, `unknown_error`.
 */
export type AtlasErrorCode =
  | ChatErrorCode
  | "forbidden"
  | "not_found"
  | "not_available"
  | "network_error"
  | "invalid_response"
  | "unknown_error";

export class AtlasError extends Error {
  readonly code: AtlasErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: AtlasErrorCode, message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "AtlasError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type BaseOptions = {
  /** Base URL of the Atlas API (e.g. "https://api.example.com") */
  baseUrl: string;
};

/**
 * Options for creating an Atlas client.
 *
 * Requires at least one of `apiKey` or `bearerToken`. When both are provided,
 * `apiKey` takes precedence for the `Authorization` header.
 */
export type AtlasClientOptions = BaseOptions & (
  | { /** Simple API key auth */ apiKey: string; bearerToken?: undefined }
  | { /** Bearer token auth (BYOT / managed) */ bearerToken: string; apiKey?: undefined }
  | { /** Both provided — apiKey takes precedence */ apiKey: string; bearerToken: string }
);

export interface QueryOptions {
  /** Resume an existing conversation */
  conversationId?: string;
}

export interface QueryResponse {
  answer: string;
  sql: string[];
  data: Array<{
    columns: string[];
    rows: Array<Record<string, unknown>>;
  }>;
  steps: number;
  usage: { totalTokens: number };
  conversationId?: string;
  pendingActions?: Array<{
    id: string;
    type: string;
    target: string;
    summary: string;
    approveUrl: string;
    denyUrl: string;
  }>;
}

export interface ListConversationsResponse {
  conversations: Conversation[];
  total: number;
}

export interface ListConversationsOptions {
  limit?: number;
  offset?: number;
  starred?: boolean;
}

export interface ShareConversationResponse {
  token: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Scheduled Task SDK types
// ---------------------------------------------------------------------------

export interface ListScheduledTasksResponse {
  tasks: ScheduledTask[];
  total: number;
}

export interface ListScheduledTasksOptions {
  limit?: number;
  offset?: number;
  enabled?: boolean;
}

export interface CreateScheduledTaskInput {
  name: string;
  question: string;
  cronExpression: string;
  deliveryChannel?: DeliveryChannel;
  recipients?: Recipient[];
  connectionId?: string | null;
  approvalMode?: ActionApprovalMode;
}

export interface UpdateScheduledTaskInput {
  name?: string;
  question?: string;
  cronExpression?: string;
  deliveryChannel?: DeliveryChannel;
  recipients?: Recipient[];
  connectionId?: string | null;
  approvalMode?: ActionApprovalMode;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Admin types
// ---------------------------------------------------------------------------

export type PluginType = "datasource" | "context" | "interaction" | "action" | "sandbox";
export type PluginStatus = "registered" | "initializing" | "healthy" | "unhealthy" | "teardown";

// ---------------------------------------------------------------------------
// Admin types — response shapes
// ---------------------------------------------------------------------------

export interface AdminOverview {
  connections: number;
  entities: number;
  metrics: number;
  glossaryTerms: number;
  plugins: number;
  pluginHealth: PluginInfo[];
}

export interface EntitySummary {
  table: string;
  description: string;
  columnCount: number;
  joinCount: number;
  measureCount: number;
  connection: string | null;
  type: "view" | null;
  source: string;
}

export interface SemanticStats {
  totalEntities: number;
  totalColumns: number;
  totalJoins: number;
  totalMeasures: number;
  coverageGaps: {
    noDescription: number;
    noColumns: number;
    noJoins: number;
  };
}

/** @deprecated Use `ConnectionHealth` from `@useatlas/types` instead. */
export type ConnectionHealthCheck = ConnectionHealth;

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  userId: string | null;
  userLabel: string | null;
  authMode: AuthMode;
  sql: string;
  durationMs: number;
  rowCount: number | null;
  success: boolean;
  error: string | null;
  sourceId: string | null;
  sourceType: string | null;
  targetHost: string | null;
}

export interface AuditLogResponse {
  rows: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface AuditLogOptions {
  /** Max rows per page. Server clamps to 200, defaults to 50. */
  limit?: number;
  offset?: number;
  user?: string;
  success?: boolean;
  /** ISO 8601 date string (e.g. "2026-01-01"). */
  from?: string;
  /** ISO 8601 date string (e.g. "2026-03-03"). */
  to?: string;
}

export interface AuditStats {
  totalQueries: number;
  totalErrors: number;
  /** Error ratio in [0, 1] — multiply by 100 for percentage. */
  errorRate: number;
  queriesPerDay: Array<{ day: string; count: number }>;
}

export interface PluginInfo {
  id: string;
  types: PluginType[];
  version: string;
  name: string;
  status: PluginStatus;
}

export interface PluginHealthCheckResponse {
  healthy: boolean;
  message?: string;
  latencyMs?: number;
  status?: PluginStatus;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Array<{ type: string; [key: string]: unknown }>;
}

export interface ChatOptions {
  /** Resume an existing conversation */
  conversationId?: string;
}

// ---------------------------------------------------------------------------
// Stream types
// ---------------------------------------------------------------------------

/** Known finish reasons from the AI SDK, plus extensibility for unknown provider values. */
export type StreamFinishReason =
  | "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"
  | (string & {});

/** Discriminated union of events yielded by `streamQuery()`. */
export type StreamEvent =
  | { type: "text"; content: string }
  | { type: "tool-call"; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; name: string; result: Record<string, unknown> }
  | { type: "result"; columns: string[]; rows: Record<string, unknown>[] }
  | { type: "error"; message: string }
  | { type: "parse_error"; raw: string; error: string }
  | { type: "finish"; reason: StreamFinishReason };

export interface StreamQueryOptions {
  /** AbortSignal for cancelling the stream */
  signal?: AbortSignal;
  /** Resume an existing conversation */
  conversationId?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Create a typed Atlas API client.
 *
 * Requires either `apiKey` or `bearerToken` for authentication. When both are
 * provided, `apiKey` takes precedence for the `Authorization` header.
 *
 * ```ts
 * const atlas = createAtlasClient({
 *   baseUrl: "https://api.example.com",
 *   apiKey: "my-key",
 * });
 *
 * const result = await atlas.query("How many users signed up last week?");
 * console.log(result.answer);
 * ```
 */
export function createAtlasClient(options: AtlasClientOptions) {
  const { baseUrl, apiKey, bearerToken } = options;

  if (!apiKey && !bearerToken) {
    throw new Error(
      "createAtlasClient requires either apiKey or bearerToken",
    );
  }

  const authHeader = `Bearer ${apiKey ?? bearerToken}`;
  const base = baseUrl.replace(/\/$/, "");

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Throw `AtlasError` if the response is not ok. */
  async function throwIfNotOk(res: Response): Promise<void> {
    if (!res.ok) {
      let code: AtlasErrorCode = "unknown_error";
      let msg = res.statusText;
      let retryAfterSeconds: number | undefined;
      try {
        const text = await res.text();
        try {
          const body = JSON.parse(text) as Record<string, unknown>;
          if (typeof body.error === "string") code = body.error as AtlasErrorCode;
          if (typeof body.message === "string") msg = body.message;
          else if (typeof body.error === "string" && !body.message) msg = body.error;
          if (typeof body.retryAfterSeconds === "number") retryAfterSeconds = body.retryAfterSeconds;
        } catch {
          if (text) msg = `${res.statusText}: ${text.slice(0, 200)}`;
        }
      } catch {
        // Could not read body at all
      }
      throw new AtlasError(code, msg, res.status, retryAfterSeconds);
    }
  }

  /** Unwrap a fetch Response as JSON, throwing AtlasError on non-2xx or parse failure. */
  async function unwrap<T>(res: Response): Promise<T> {
    await throwIfNotOk(res);
    try {
      return (await res.json()) as T;
    } catch {
      throw new AtlasError(
        "invalid_response",
        `Expected JSON response but received unparseable body (status ${res.status})`,
        res.status,
      );
    }
  }

  /** Send a JSON POST request. */
  async function post(path: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<Response> {
    try {
      return await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(body),
        signal: opts?.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw new AtlasError(
        "network_error",
        err instanceof Error ? err.message : String(err),
        0,
      );
    }
  }

  /** Send a GET request. */
  async function get(path: string): Promise<Response> {
    try {
      return await fetch(`${base}${path}`, {
        method: "GET",
        headers: { Authorization: authHeader },
      });
    } catch (err) {
      throw new AtlasError(
        "network_error",
        err instanceof Error ? err.message : String(err),
        0,
      );
    }
  }

  /** Send a JSON PATCH request. */
  async function patch(path: string, body: unknown): Promise<Response> {
    try {
      return await fetch(`${base}${path}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AtlasError(
        "network_error",
        err instanceof Error ? err.message : String(err),
        0,
      );
    }
  }

  /** Send a JSON PUT request. */
  async function put(path: string, body: unknown): Promise<Response> {
    try {
      return await fetch(`${base}${path}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AtlasError(
        "network_error",
        err instanceof Error ? err.message : String(err),
        0,
      );
    }
  }

  /** Send a DELETE request. */
  async function del(path: string): Promise<Response> {
    try {
      return await fetch(`${base}${path}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      });
    } catch (err) {
      throw new AtlasError(
        "network_error",
        err instanceof Error ? err.message : String(err),
        0,
      );
    }
  }

  // -------------------------------------------------------------------------
  // SSE parser — reads a ReadableStream<Uint8Array> and yields parsed JSON objects
  // -------------------------------------------------------------------------

  async function* parseSSE(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        if (aborted) throw new DOMException("The operation was aborted.", "AbortError");
        const { done, value } = await reader.read();
        if (aborted) throw new DOMException("The operation was aborted.", "AbortError");
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;

        for (const part of parts) {
          for (const line of part.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") return;

            try {
              yield JSON.parse(data) as Record<string, unknown>;
            } catch (e) {
              yield { type: "parse_error", raw: data, error: e instanceof Error ? e.message : String(e) };
            }
          }
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  return {
    /**
     * Run a synchronous query — sends a question, waits for the full agent
     * response, and returns structured JSON.
     */
    async query(
      question: string,
      opts?: QueryOptions,
    ): Promise<QueryResponse> {
      const res = await post("/api/v1/query", {
        question,
        conversationId: opts?.conversationId,
      });
      return unwrap<QueryResponse>(res);
    },

    /**
     * Stream a query — sends a question and yields typed events as the agent
     * responds. Parses the AI SDK UI Message Stream Protocol. Emits a `result`
     * convenience event when `executeSQL` returns `{ columns, rows }`.
     *
     * Supports cancellation via `AbortController`:
     * ```ts
     * const controller = new AbortController();
     * for await (const event of atlas.streamQuery("...", { signal: controller.signal })) {
     *   if (event.type === "text") process.stdout.write(event.content);
     * }
     * ```
     */
    async *streamQuery(
      question: string,
      opts?: StreamQueryOptions,
    ): AsyncGenerator<StreamEvent> {
      const messages = [{
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [{ type: "text", text: question }],
      }];

      const res = await post("/api/chat", {
        messages,
        conversationId: opts?.conversationId,
      }, { signal: opts?.signal });

      await throwIfNotOk(res);

      if (!res.body) {
        throw new AtlasError("invalid_response", "Response body is empty", res.status);
      }

      const toolNames = new Map<string, string>();

      try {
        for await (const event of parseSSE(res.body, opts?.signal)) {
          const t = event.type as string;

          switch (t) {
            case "text-delta": {
              const content = (event.delta ?? event.textDelta) as string | undefined;
              if (content) yield { type: "text", content };
              break;
            }
            case "tool-input-start": {
              const id = event.toolCallId as string;
              const name = event.toolName as string;
              if (id && name) toolNames.set(id, name);
              break;
            }
            case "tool-input-available": {
              const id = event.toolCallId as string;
              const name = toolNames.get(id) ?? "unknown";
              yield {
                type: "tool-call",
                toolCallId: id,
                name,
                args: (event.input ?? {}) as Record<string, unknown>,
              };
              break;
            }
            case "tool-output-available": {
              const id = event.toolCallId as string;
              const name = toolNames.get(id) ?? "unknown";
              const output = event.output as Record<string, unknown> | undefined;
              yield {
                type: "tool-result",
                toolCallId: id,
                name,
                result: (output ?? {}) as Record<string, unknown>,
              };
              if (
                name === "executeSQL" &&
                output != null &&
                Array.isArray(output.columns) &&
                Array.isArray(output.rows)
              ) {
                yield { type: "result", columns: output.columns as string[], rows: output.rows as Record<string, unknown>[] };
              }
              break;
            }
            case "error": {
              yield {
                type: "error",
                message: (event.errorText ?? event.message ?? "Unknown error") as string,
              };
              break;
            }
            case "parse_error": {
              yield {
                type: "parse_error",
                raw: event.raw as string,
                error: event.error as string,
              };
              break;
            }
            case "finish": {
              yield {
                type: "finish",
                reason: ((event.finishReason ?? "stop") as string) as StreamFinishReason,
              };
              break;
            }
            // Only text-delta, tool-input-start, tool-input-available, tool-output-available, error, and finish are mapped to StreamEvents.
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        if (err instanceof AtlasError) throw err;
        throw new AtlasError(
          "network_error",
          `Stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
          0,
        );
      }
    },

    /** Conversation CRUD methods. */
    conversations: {
      /** List conversations (paginated). */
      async list(
        opts?: ListConversationsOptions,
      ): Promise<ListConversationsResponse> {
        const params = new URLSearchParams();
        if (opts?.limit != null) params.set("limit", String(opts.limit));
        if (opts?.offset != null) params.set("offset", String(opts.offset));
        if (opts?.starred != null) params.set("starred", String(opts.starred));
        const qs = params.toString();
        const res = await get(
          `/api/v1/conversations${qs ? `?${qs}` : ""}`,
        );
        return unwrap<ListConversationsResponse>(res);
      },

      /** Get a single conversation with its messages. */
      async get(id: string): Promise<ConversationWithMessages> {
        const res = await get(`/api/v1/conversations/${encodeURIComponent(id)}`);
        return unwrap<ConversationWithMessages>(res);
      },

      /** Delete a conversation. Returns `true` on success. */
      async delete(id: string): Promise<boolean> {
        const res = await del(`/api/v1/conversations/${encodeURIComponent(id)}`);
        await throwIfNotOk(res);
        return true;
      },

      /** Star a conversation. */
      async star(id: string): Promise<void> {
        const res = await patch(`/api/v1/conversations/${encodeURIComponent(id)}/star`, { starred: true });
        await throwIfNotOk(res);
      },

      /** Unstar a conversation. */
      async unstar(id: string): Promise<void> {
        const res = await patch(`/api/v1/conversations/${encodeURIComponent(id)}/star`, { starred: false });
        await throwIfNotOk(res);
      },

      /** Generate a share link for a conversation. */
      async share(id: string): Promise<ShareConversationResponse> {
        const res = await post(`/api/v1/conversations/${encodeURIComponent(id)}/share`, {});
        return unwrap<ShareConversationResponse>(res);
      },

      /** Revoke sharing for a conversation. */
      async unshare(id: string): Promise<void> {
        const res = await del(`/api/v1/conversations/${encodeURIComponent(id)}/share`);
        await throwIfNotOk(res);
      },
    },

    /** Scheduled task CRUD methods. */
    scheduledTasks: {
      /** List scheduled tasks (paginated). */
      async list(
        opts?: ListScheduledTasksOptions,
      ): Promise<ListScheduledTasksResponse> {
        const params = new URLSearchParams();
        if (opts?.limit != null) params.set("limit", String(opts.limit));
        if (opts?.offset != null) params.set("offset", String(opts.offset));
        if (opts?.enabled != null) params.set("enabled", String(opts.enabled));
        const qs = params.toString();
        const res = await get(
          `/api/v1/scheduled-tasks${qs ? `?${qs}` : ""}`,
        );
        return unwrap<ListScheduledTasksResponse>(res);
      },

      /** Get a single scheduled task with recent runs. */
      async get(id: string): Promise<ScheduledTaskWithRuns> {
        const res = await get(`/api/v1/scheduled-tasks/${encodeURIComponent(id)}`);
        return unwrap<ScheduledTaskWithRuns>(res);
      },

      /** Create a new scheduled task. */
      async create(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
        const res = await post("/api/v1/scheduled-tasks", input);
        return unwrap<ScheduledTask>(res);
      },

      /** Update a scheduled task. */
      async update(id: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
        const res = await put(`/api/v1/scheduled-tasks/${encodeURIComponent(id)}`, input);
        return unwrap<ScheduledTask>(res);
      },

      /** Delete (disable) a scheduled task. Returns `true` on success. */
      async delete(id: string): Promise<boolean> {
        const res = await del(`/api/v1/scheduled-tasks/${encodeURIComponent(id)}`);
        await throwIfNotOk(res);
        return true;
      },

      /** Trigger immediate execution of a scheduled task. */
      async trigger(id: string): Promise<void> {
        const res = await post(`/api/v1/scheduled-tasks/${encodeURIComponent(id)}/run`, {});
        await throwIfNotOk(res);
      },

      /** List past runs for a scheduled task. */
      async listRuns(id: string, opts?: { limit?: number }): Promise<{ runs: ScheduledTaskRun[] }> {
        const params = new URLSearchParams();
        if (opts?.limit != null) params.set("limit", String(opts.limit));
        const qs = params.toString();
        const res = await get(
          `/api/v1/scheduled-tasks/${encodeURIComponent(id)}/runs${qs ? `?${qs}` : ""}`,
        );
        return unwrap<{ runs: ScheduledTaskRun[] }>(res);
      },
    },

    /** Admin console methods (require admin role). */
    admin: {
      /** Get overview dashboard data. */
      async overview(): Promise<AdminOverview> {
        const res = await get("/api/v1/admin/overview");
        return unwrap<AdminOverview>(res);
      },

      /** Semantic layer browsing. */
      semantic: {
        /** List all entities with summary info. */
        async entities(): Promise<{ entities: EntitySummary[] }> {
          const res = await get("/api/v1/admin/semantic/entities");
          return unwrap<{ entities: EntitySummary[] }>(res);
        },

        /** Get full entity detail by name. */
        async entity(name: string): Promise<{ entity: unknown }> {
          const res = await get(`/api/v1/admin/semantic/entities/${encodeURIComponent(name)}`);
          return unwrap<{ entity: unknown }>(res);
        },

        /** List all metrics. */
        async metrics(): Promise<{ metrics: Array<{ source: string; data: unknown }> }> {
          const res = await get("/api/v1/admin/semantic/metrics");
          return unwrap<{ metrics: Array<{ source: string; data: unknown }> }>(res);
        },

        /** Get glossary. */
        async glossary(): Promise<{ glossary: unknown[] }> {
          const res = await get("/api/v1/admin/semantic/glossary");
          return unwrap<{ glossary: unknown[] }>(res);
        },

        /** Get catalog. */
        async catalog(): Promise<{ catalog: unknown }> {
          const res = await get("/api/v1/admin/semantic/catalog");
          return unwrap<{ catalog: unknown }>(res);
        },

        /** Get aggregate semantic stats. */
        async stats(): Promise<SemanticStats> {
          const res = await get("/api/v1/admin/semantic/stats");
          return unwrap<SemanticStats>(res);
        },
      },

      /** List registered connections. */
      async connections(): Promise<{ connections: ConnectionInfo[] }> {
        const res = await get("/api/v1/admin/connections");
        return unwrap<{ connections: ConnectionInfo[] }>(res);
      },

      /** Test a specific connection's health. */
      async testConnection(id: string): Promise<ConnectionHealth> {
        const res = await post(`/api/v1/admin/connections/${encodeURIComponent(id)}/test`, {});
        return unwrap<ConnectionHealth>(res);
      },

      /** Query audit log (paginated, filterable). */
      async audit(opts?: AuditLogOptions): Promise<AuditLogResponse> {
        const params = new URLSearchParams();
        if (opts?.limit != null) params.set("limit", String(opts.limit));
        if (opts?.offset != null) params.set("offset", String(opts.offset));
        if (opts?.user != null) params.set("user", opts.user);
        if (opts?.success != null) params.set("success", String(opts.success));
        if (opts?.from != null) params.set("from", opts.from);
        if (opts?.to != null) params.set("to", opts.to);
        const qs = params.toString();
        const res = await get(`/api/v1/admin/audit${qs ? `?${qs}` : ""}`);
        return unwrap<AuditLogResponse>(res);
      },

      /** Get aggregate audit stats. */
      async auditStats(): Promise<AuditStats> {
        const res = await get("/api/v1/admin/audit/stats");
        return unwrap<AuditStats>(res);
      },

      /** List installed plugins. */
      async plugins(): Promise<{ plugins: PluginInfo[] }> {
        const res = await get("/api/v1/admin/plugins");
        return unwrap<{ plugins: PluginInfo[] }>(res);
      },

      /** Trigger health check for a specific plugin. */
      async pluginHealth(id: string): Promise<PluginHealthCheckResponse> {
        const res = await post(`/api/v1/admin/plugins/${encodeURIComponent(id)}/health`, {});
        return unwrap<PluginHealthCheckResponse>(res);
      },
    },

    /**
     * Start a streaming chat session — returns the raw `Response` whose body
     * is an SSE stream (AI SDK UI Message Stream Protocol). Callers can consume it
     * directly with the AI SDK's `useChat` or manual stream parsing.
     */
    async chat(
      messages: ChatMessage[],
      opts?: ChatOptions,
    ): Promise<Response> {
      const res = await post("/api/chat", {
        messages,
        conversationId: opts?.conversationId,
      });
      await throwIfNotOk(res);
      return res;
    },
  };
}

/** The return type of `createAtlasClient`. */
export type AtlasClient = ReturnType<typeof createAtlasClient>;
