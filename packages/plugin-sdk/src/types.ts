/**
 * Plugin SDK type definitions for Atlas.
 *
 * Types use structural typing — no runtime dependencies on `@atlas/api`.
 * Peer dependencies: `ai` and `hono` for proper tool and route types.
 */

import type { ToolSet } from "ai";
import type { Hono } from "hono";

/**
 * Inlined from `@atlas/api/lib/action-types` to avoid a runtime dependency
 * on the API package. Keep in sync with `ACTION_APPROVAL_MODES` in
 * `packages/api/src/lib/action-types.ts`.
 */
export type ActionApprovalMode = "auto" | "manual" | "admin-only";

// ---------------------------------------------------------------------------
// Database abstractions (structural mirrors of @atlas/api DBConnection)
// ---------------------------------------------------------------------------

export interface PluginQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface PluginDBConnection {
  query(sql: string, timeoutMs?: number): Promise<PluginQueryResult>;
  close(): Promise<void>;
  /**
   * Introspection as a capability OF the live connection (#3667, ADR-0017
   * universalization). `listObjects`/`profile` are bound to the creds that built
   * the connection (`create` / `createFromConfig`), so the host's unified
   * profiler seam (`resolveLiveConnection`) consumes them WITHOUT re-resolving
   * auth from a `url`/`config` — there is no URL-shape gate to fail closed.
   *
   * Optional and additive: a query-only datasource omits them and the host
   * degrades to its explicit `unsupported` outcome. Both must run **read-only**.
   * See {@link PluginConnectionListObjectsOptions} / {@link PluginConnectionProfileOptions}
   * for the option shapes (note: NO `url`/`config` — the connection is already
   * authenticated and bound). `profile` MUST NOT echo credentials in errors.
   */
  listObjects?(
    options?: PluginConnectionListObjectsOptions,
  ): Promise<PluginDatabaseObject[]> | PluginDatabaseObject[];
  profile?(options: PluginConnectionProfileOptions): Promise<PluginProfilingResult>;
}

/**
 * Result returned by a custom query validator.
 *
 * Used by datasource plugins that speak a non-SQL query language
 * (e.g. SOQL, GraphQL, MQL) to replace the standard `validateSQL` pipeline.
 */
export interface QueryValidationResult {
  valid: boolean;
  /** User-facing rejection reason (appears in error responses and audit logs). */
  reason?: string;
}

/** Known database types, plus an escape hatch for custom drivers. */
export type PluginDBType =
  | "postgres"
  | "mysql"
  | "clickhouse"
  | "snowflake"
  | "duckdb"
  | "bigquery"
  | (string & {});

/**
 * Known node-sql-parser dialect strings, plus an escape hatch for future dialects.
 * Values are case-sensitive — use exactly as listed (e.g. "PostgresQL", not "postgresql").
 */
export type ParserDialect =
  | "Athena"
  | "BigQuery"
  | "Db2"
  | "FlinkSQL"
  | "Hive"
  | "MariaDb"
  | "MySQL"
  | "NoQL"
  | "PostgresQL"
  | "Redshift"
  | "Snowflake"
  | "SQLite"
  | "TransactSQL"
  | "Trino"
  | (string & {});

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

export type PluginType = "datasource" | "context" | "interaction" | "action" | "sandbox";

export type PluginStatus =
  | "registered"
  | "initializing"
  | "healthy"
  | "unhealthy"
  | "teardown";

export interface PluginHealthResult {
  healthy: boolean;
  message?: string;
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Plugin context — passed to initialize() and hook handlers
// ---------------------------------------------------------------------------

/**
 * Structural logger interface (pino-compatible subset). Plugin authors get
 * a child logger scoped to their plugin id.
 */
export interface PluginLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  debug(msg: string): void;
}

/**
 * Context object passed to plugin lifecycle methods (initialize, hooks).
 * Mirrors Better Auth's `ctx.context` pattern — plugins receive typed
 * access to Atlas internals without importing `@atlas/api`.
 */
export interface AtlasPluginContext {
  /** Internal Postgres (auth/audit DB). Null when DATABASE_URL is not set. */
  db: {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    execute(sql: string, params?: unknown[]): Promise<void>;
  } | null;
  /** Connection registry for analytics datasources. */
  connections: {
    get(id: string): PluginDBConnection;
    /** Registered connection IDs — NOT semantic-layer object names. */
    list(): string[];
    /**
     * Semantic-layer entity/table (for ES: index) names registered for a
     * connection — the per-object membership whitelist a plugin query tool must
     * enforce. In self-host / static-datasource mode this mirrors the
     * filesystem whitelist `executeSQL` validates against, so a plugin's bespoke
     * query tool (SOQL / Query DSL) honors the same boundary as the SQL path.
     * (Org-scoped SaaS validates `executeSQL` against the DB-backed whitelist;
     * the static-config tools this serves are a self-host surface.)
     *
     * `id` must be a registered connection id (typically the plugin's own `id`);
     * an unrecognized id returns `[]`. Returns `[]` when the connection has no
     * semantic layer configured — a tool fed an empty set falls back to
     * structural-only validation (the intended behavior for an unconfigured
     * layer). See #3307.
     *
     * THROWS when the whitelist is empty because a semantic-layer directory scan
     * FAILED (#3243), rather than returning `[]`. This lets a bespoke query tool
     * FAIL CLOSED (refuse the query) on a scan failure instead of silently
     * dropping to structural-only — which would widen access to any
     * explicitly-named, non-system object the credential can read. A tool should
     * call this inside a try/catch and surface a clean refusal on throw (#3313).
     */
    tables(id: string): readonly string[];
  };
  /** Tool registry — plugins can register additional tools. */
  tools: {
    register(tool: { name: string; description: string; tool: ToolSet[string] }): void;
  };
  /** Pino-compatible child logger scoped to the plugin. */
  logger: PluginLogger;
  /** Resolved Atlas configuration (opaque record — cast if you know the shape). */
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Hook types — Better Auth-inspired matcher + handler pattern
// ---------------------------------------------------------------------------

/**
 * A hook entry with an optional matcher. When `matcher` is omitted the hook
 * always fires. Matches Better Auth's `{ matcher, handler }` pattern but
 * with agent-lifecycle-specific contexts instead of generic HTTP matchers.
 *
 * TReturn is the optional mutation return type. Handlers that return `void`
 * pass through without mutating. Handlers that return TReturn apply a
 * mutation (e.g. rewriting SQL). Throwing rejects the operation entirely.
 */
export interface PluginHookEntry<TContext = unknown, TReturn = void> {
  /** Return true to run the handler. Omit to always run. */
  matcher?: (ctx: TContext) => boolean;
  handler: (ctx: TContext) => Promise<TReturn | void> | TReturn | void;
}

/** Context passed to beforeQuery / afterQuery hooks. */
export interface QueryHookContext {
  sql: string;
  connectionId?: string;
  /**
   * Mutable metadata bag. Hooks can attach arbitrary key-value pairs
   * (e.g. `{ estimatedCostUsd, bytesScanned }`) that the caller
   * merges into the tool result so the agent can reference them.
   */
  metadata?: Record<string, unknown>;
}

export interface AfterQueryHookContext extends QueryHookContext {
  result: PluginQueryResult;
  durationMs: number;
}

/** Mutation return type for beforeQuery hooks. Return to rewrite the SQL. */
export interface QueryHookMutation {
  sql: string;
}

/** Mutation return type for beforeExplore hooks. Return to rewrite the command. */
export interface ExploreHookMutation {
  command: string;
}

/** Context passed to beforeExplore / afterExplore hooks. */
export interface ExploreHookContext {
  command: string;
}

export interface AfterExploreHookContext extends ExploreHookContext {
  output: string;
}

/** Session context available to tool call hooks. */
export interface ToolCallSessionContext {
  userId?: string;
  conversationId?: string;
  /** 1-based count of tool invocations in the current agent run (across all tools). */
  toolCallCount: number;
}

/** Context passed to beforeToolCall / afterToolCall hooks. */
export interface ToolCallHookContext {
  toolName: string;
  args: Record<string, unknown>;
  context: ToolCallSessionContext;
}

export interface AfterToolCallHookContext extends ToolCallHookContext {
  /**
   * The tool's return value. Typed as `unknown` because different tools
   * return different shapes. Narrow based on `toolName`:
   *
   * ```ts
   * if (ctx.toolName === "executeSQL") {
   *   const qr = ctx.result as { columns: string[]; rows: Record<string, unknown>[] };
   * }
   * ```
   */
  result: unknown;
  /** Wall-clock duration of the tool execution in milliseconds. */
  durationMs: number;
}

/** Mutation return type for beforeToolCall hooks. Return to rewrite the args. */
export interface ToolCallArgsMutation {
  args: Record<string, unknown>;
}

/** Mutation return type for afterToolCall hooks. Return to rewrite the result. */
export interface ToolCallResultMutation {
  result: unknown;
}

/** Context passed to onRequest / onResponse HTTP hooks. */
export interface RequestHookContext {
  path: string;
  method: string;
  headers: Record<string, string>;
}

export interface ResponseHookContext {
  path: string;
  method: string;
  status: number;
}

/**
 * Named hook arrays. Agent lifecycle hooks (beforeQuery, afterQuery, etc.)
 * plus HTTP-level cross-cutting hooks (onRequest, onResponse).
 *
 * `beforeQuery`, `beforeExplore`, `beforeToolCall`, and `afterToolCall` are
 * mutable — handlers can return a mutation object to rewrite the
 * SQL/command/args/result, or throw to reject the operation. All other hooks
 * are observation-only (void return).
 */
export interface PluginHooks {
  /** Fires before each SQL query. Return `{ sql }` to rewrite, throw to reject. */
  beforeQuery?: PluginHookEntry<QueryHookContext, QueryHookMutation>[];
  /** Fires after each SQL query with results. */
  afterQuery?: PluginHookEntry<AfterQueryHookContext>[];
  /** Fires before each explore command. Return `{ command }` to rewrite, throw to reject. */
  beforeExplore?: PluginHookEntry<ExploreHookContext, ExploreHookMutation>[];
  /** Fires after each explore command with output. */
  afterExplore?: PluginHookEntry<AfterExploreHookContext>[];
  /** Fires before each tool call. Return `{ args }` to rewrite args, throw to reject. */
  beforeToolCall?: PluginHookEntry<ToolCallHookContext, ToolCallArgsMutation>[];
  /** Fires after each tool call. Return `{ result }` to rewrite the result, throw to reject. */
  afterToolCall?: PluginHookEntry<AfterToolCallHookContext, ToolCallResultMutation>[];
  /** HTTP-level: fires before routing a request. */
  onRequest?: PluginHookEntry<RequestHookContext>[];
  /** HTTP-level: fires after sending a response. */
  onResponse?: PluginHookEntry<ResponseHookContext>[];
}

// ---------------------------------------------------------------------------
// Schema type — declarative table definitions (see packages/api/src/lib/plugins/migrate.ts)
// ---------------------------------------------------------------------------

export interface PluginFieldDefinition {
  type: "string" | "number" | "boolean" | "date";
  required?: boolean;
  references?: { model: string; field: string };
  unique?: boolean;
  defaultValue?: unknown;
}

export interface PluginTableDefinition {
  fields: Record<string, PluginFieldDefinition>;
}

// ---------------------------------------------------------------------------
// Config schema — serializable field descriptions for admin UI
// ---------------------------------------------------------------------------

/**
 * Describes a single config field for admin UI form generation.
 * Plugins return an array of these from `getConfigSchema()`.
 */
export interface ConfigSchemaField {
  /** Field key in the config object. */
  key: string;
  /** Field type for form generation. */
  type: "string" | "number" | "boolean" | "select";
  /** Human-readable label. Falls back to `key` in the UI. */
  label?: string;
  /** Help text shown below the input. */
  description?: string;
  /** Whether the field is required. */
  required?: boolean;
  /** When true, the value is masked in the UI (e.g. API keys, secrets). */
  secret?: boolean;
  /** Valid options for "select" type fields. */
  options?: string[];
  /** Default value. */
  default?: unknown;
}

// ---------------------------------------------------------------------------
// Cache backend interface — plugins can provide external cache (Redis, etc)
// ---------------------------------------------------------------------------

/** A single cached query result entry. */
export interface PluginCacheEntry {
  columns: string[];
  rows: Record<string, unknown>[];
  cachedAt: number;
  ttl: number;
}

/** Cache backend interface for query result caching. */
export interface PluginCacheBackend {
  get(key: string): PluginCacheEntry | null;
  set(key: string, entry: PluginCacheEntry): void;
  delete(key: string): boolean;
  /** Flush all entries. */
  flush(): void;
  stats(): { hits: number; misses: number; entryCount: number; maxSize: number; ttl: number };
}

// ---------------------------------------------------------------------------
// Base plugin interface
// ---------------------------------------------------------------------------

export interface AtlasPluginBase<TConfig = undefined> {
  /** Unique plugin identifier (e.g. "salesforce-datasource", "slack-interaction"). */
  readonly id: string;
  /** Plugin type(s). A plugin can implement multiple types (e.g. ["interaction", "action"]). */
  readonly types: readonly PluginType[];
  /** SemVer version string. */
  readonly version: string;
  /** Human-readable name. Falls back to `id` in UIs. */
  readonly name?: string;

  /** Plugin-specific configuration. When using createPlugin(), validated at factory call time via the provided configSchema. */
  readonly config?: TConfig;

  /**
   * Return a serializable description of the plugin's config schema.
   * Used by the admin UI to generate dynamic config forms. Optional —
   * plugins without this method show config as read-only JSON.
   */
  getConfigSchema?(): ConfigSchemaField[];

  /**
   * Called once during server boot with the full Atlas context.
   * Throw to signal initialization failure.
   *
   * The `ctx` parameter follows Better Auth's context pattern — plugins
   * receive typed access to db, connections, tools, logger, and config.
   * Plugins that don't need context can omit the parameter (backward compat).
   */
  initialize?(ctx: AtlasPluginContext): Promise<void>;

  /** Periodic health probe. Return `{ healthy: false }` to signal degradation. */
  healthCheck?(): Promise<PluginHealthResult>;

  /** Graceful shutdown hook. Called in reverse registration order (LIFO). */
  teardown?(): Promise<void>;

  /**
   * Per-workspace uninstall hook (#3188). Invoked when a workspace
   * uninstalls this plugin — on both uninstall paths (the marketplace
   * `DELETE /api/v1/admin/marketplace/:id` route and
   * `WorkspaceInstaller.uninstall`) — BEFORE Atlas removes the install
   * row and credential stores. At call time the plugin can therefore
   * still authenticate against the external platform to revoke webhook
   * subscriptions, OAuth grants, or any other external state it
   * registered for that workspace.
   *
   * Contrast with {@link teardown}, which runs once at process shutdown:
   * `onUninstall` is per-workspace and fires at uninstall time. A plugin
   * that registers an external webhook subscription (Slack, GitHub,
   * Stripe, …) MUST revoke it here — an un-revoked webhook keeps
   * delivering events to a workspace that no longer has the plugin
   * installed, and Atlas cannot revoke it for you.
   *
   * Attribution rule: NEVER revoke an external subscription you cannot
   * positively attribute to the uninstalling workspace (a recorded id,
   * a metadata workspace tag, or a workspace marker in the callback
   * URL). The hook may fire against a credential shared with other
   * workspaces or out-of-band tooling — bulk-deleting everything the
   * credential can see destroys state that isn't yours.
   *
   * Best-effort contract: a thrown error is logged by the host (with
   * plugin id + workspaceId) and does NOT abort the uninstall — the
   * install-row removal proceeds; each invocation also runs against a
   * host-side deadline (15s), so don't rely on this hook for
   * load-bearing cleanup.
   *
   * Coverage carve-outs: the hook does NOT fire on datasource
   * disconnects (datasource installs are removed via the
   * datasource-specific delete paths) or on a workspace purge — only
   * the two plugin-uninstall paths above invoke it.
   *
   * Resolution: the host invokes the hook on the per-workspace plugin
   * instance built by its lazy loader (SaaS / marketplace installs), and
   * on any globally-registered plugin whose `id` equals the uninstalled
   * catalog entry's slug, catalog id, or `<slug>-<type>` (the naming
   * convention used by the bundled plugins, e.g. `jira-action` for
   * catalog slug `jira`).
   */
  onUninstall?(workspaceId: string): Promise<void> | void;

  /**
   * Agent lifecycle and HTTP hooks using the matcher + handler pattern.
   * Matchers are optional — omit to always fire.
   */
  hooks?: PluginHooks;

  /**
   * Declarative table definitions for the internal database.
   * Tables are auto-migrated at boot (see packages/api/src/lib/plugins/migrate.ts).
   */
  schema?: Record<string, PluginTableDefinition>;

  /**
   * Optional external cache backend (e.g. Redis) for query result caching.
   * When provided, replaces the default in-memory LRU cache.
   */
  cacheBackend?: PluginCacheBackend;

  /**
   * Register MCP tools the plugin contributes. Called once at boot after
   * `initialize()` resolves. The host namespaces each returned tool's
   * `name` as `<plugin-id>.<name>` and registers it on the MCP server so
   * it appears in `tools/list` alongside Atlas's own (`executeSQL`,
   * `explore`, the typed semantic tools).
   *
   * Plugin tool descriptions go through the same `withErrorContract` +
   * word-count rubric as native tools — drift fails CI. Inputs are
   * zod-validated before the handler runs; handler errors get wrapped in
   * the standard `AtlasMcpToolError` envelope so a misbehaving plugin
   * cannot return arbitrary error shapes. Audit + OTel coverage matches
   * native tools with no special-case path.
   */
  mcpTools?(): readonly AtlasMcpTool[];
}

// ---------------------------------------------------------------------------
// MCP tool extension point — plugins contribute first-class agent tools
// ---------------------------------------------------------------------------

/**
 * Structural Zod-shaped schema accepted by `AtlasMcpTool.inputSchema`.
 *
 * Defined structurally so the plugin SDK does not take a hard runtime
 * dependency on a specific Zod version (plugins ship their own zod). Any
 * object exposing `parse()`, `safeParse()`, and `_def` (the marker the AI
 * SDK / MCP SDK use to detect Zod schemas) satisfies the contract.
 */
export interface PluginZodSchema<TOut = unknown> {
  parse(input: unknown): TOut;
  safeParse(input: unknown):
    | { success: true; data: TOut }
    | {
        success: false;
        error: {
          issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
          message: string;
        };
      };
  /**
   * Zod's internal definition object — the MCP SDK and the AI SDK both
   * introspect this to derive a JSON Schema for the tool's input.
   * Required (not optional) so a structural impostor with only
   * `parse` / `safeParse` cannot typecheck through `register()` and
   * later fail at MCP `tools/list` generation far from the authoring
   * site. Type is `unknown` because the shape is opaque across Zod
   * versions; the contract is "this field exists and the host's
   * schema-introspection layer will probe it."
   */
  readonly _def: unknown;
}

/**
 * Per-dispatch context passed to a plugin MCP tool's `handler`.
 *
 * The host populates this from the same RequestContext that backs the
 * audit log and OTel attribution. `clientId` is set for hosted MCP (per
 * #2067) and undefined for stdio. `audit` is a fire-and-forget structured
 * event emitter — it never throws back to the handler.
 */
export interface McpToolContext {
  /** Resolved workspace id (`actor.activeOrganizationId` or `actor.id`). */
  readonly workspaceId: string;
  /** Bound MCP actor user id. */
  readonly userId: string;
  /** Hosted-MCP OAuth `client_id`. Undefined for stdio dispatches. */
  readonly clientId?: string;
  /** Per-dispatch request id — surfaces in `audit_log.request_id` / OTel spans. */
  readonly requestId: string;
  /** Owning plugin id (matches the `<plugin-id>.<name>` namespace). */
  readonly pluginId: string;
  /**
   * #2345 — group-aware routing surfaced additively to plugin tools.
   *
   * `connectionId` is the conversation's *execution target* (or the
   * per-turn override) — pass through to `executeSQL` or any other
   * connection-keyed tool the plugin invokes. Absent when the
   * dispatch is not chat-routed (legacy single-connection deploy,
   * scheduler context, ad-hoc MCP call with no env picker).
   *
   * `connectionGroupId` is the *content scope* — the connection group
   * whose entities, dashboards, and approvals resolve for this turn.
   * Decoupled from `connectionId` (a multi-member "prod" group may
   * resolve content while `connectionId` targets a single replica),
   * so a plugin that overlays group-scoped content should read this
   * field rather than reaching for `connectionId`.
   */
  readonly connectionId?: string;
  readonly connectionGroupId?: string;
  /** Pino-compatible child logger scoped to the plugin + tool. */
  readonly logger: PluginLogger;
  /**
   * Fire-and-forget structured event emitter. Plugins log domain-specific
   * audit signals here; the host binds the `mcp` actor on the request
   * context so any nested `executeSQL` (or any other code path that
   * writes its own `audit_log` row) is stamped with the plugin tool's
   * `qualifiedName`, `clientId`, and request id consistently. The host
   * does NOT itself write a row to `audit_log` for the dispatch — pure
   * plugin tools that don't invoke `executeSQL` produce zero rows in
   * `audit_log`, just structured pino events via this `audit()` call.
   * Failures inside `audit` are swallowed and logged — they never
   * propagate.
   */
  audit(entry: McpToolAuditEntry): void;
}

/** Structured audit event a plugin handler can emit via `McpToolContext.audit`. */
export interface McpToolAuditEntry {
  /** Short event name, e.g. `"runbooks.search"`, `"runbook.fetched"`. */
  readonly event: string;
  /** Whether the operation the event describes succeeded. */
  readonly success: boolean;
  /** Optional duration in ms for timing-shaped events. */
  readonly durationMs?: number;
  /** Optional structured payload. Avoid sensitive data — values land in pino logs. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A single MCP tool contributed by a plugin via `AtlasPluginBase.mcpTools()`.
 *
 * The `name` is the local (un-namespaced) tool identifier. The host
 * registers it as `<plugin-id>.<name>` to avoid collisions with Atlas's
 * own tools (`executeSQL`, `explore`, `listEntities`, `describeEntity`,
 * `searchGlossary`, `runMetric`). Local names must match
 * `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$` — no dots, slashes, or whitespace.
 *
 * `inputSchema` is enforced before `handler` runs: a parse failure short-
 * circuits with a `validation_failed` error envelope and the handler is
 * never invoked. Handler throws are wrapped in an `internal_error`
 * envelope carrying the dispatch's `request_id` so an LLM agent can
 * correlate the failure with server logs.
 */
/**
 * MCP tool annotations (spec 2025-11-25 `ToolAnnotations`). Declare a tool's
 * read/write nature so the host can gate it and clients can render the right
 * confirmation affordance.
 *
 * The read/write hints are load-bearing for governance: a tool that mutates
 * data MUST set `readOnlyHint: false` (or `destructiveHint: true`) so the host
 * enforces the `mcp:write` scope on hosted dispatches (#3520). A tool with no
 * annotations is treated as read-only and is NOT write-gated — annotate any
 * mutating tool explicitly.
 */
export interface McpToolAnnotations {
  /** Human-readable tool title for display. */
  readonly title?: string;
  /** `true` ⇒ the tool does not mutate its environment (read-only). */
  readonly readOnlyHint?: boolean;
  /** `true` ⇒ the tool may perform destructive (mutating) updates. */
  readonly destructiveHint?: boolean;
  /** `true` ⇒ repeated calls with the same args have no additional effect. */
  readonly idempotentHint?: boolean;
  /** `true` ⇒ the tool interacts with an open/external world (e.g. the web). */
  readonly openWorldHint?: boolean;
}

export interface AtlasMcpTool<
  TInput = unknown,
  TOutput = unknown,
> {
  /** Local tool name. Host namespaces as `<plugin-id>.<name>`. */
  readonly name: string;
  /**
   * LLM-facing description. Goes through the same rubric as native tools
   * (80–150 words, `Use this when …`, `Don't use this …`/`Avoid …`, at
   * least one inline JSON example) and gets the same `Error contract:`
   * appendage at registration time. Drift fails CI.
   */
  readonly description: string;
  /** Per-tool error catalog appended to the description via `withErrorContract`. */
  readonly errorCodes?: ReadonlyArray<string>;
  /** Zod schema for validating the LLM-supplied arguments. */
  readonly inputSchema: PluginZodSchema<TInput>;
  /** Optional Zod schema describing the structured response shape. */
  readonly outputSchema?: PluginZodSchema<TOutput>;
  /**
   * MCP annotations. A mutating tool MUST declare `readOnlyHint: false` (or
   * `destructiveHint: true`) so the host enforces `mcp:write` on hosted
   * dispatches (#3520). Omit (or set `readOnlyHint: true`) for read-only tools.
   */
  readonly annotations?: McpToolAnnotations;
  /**
   * ADR-0016 governance declarations (#3571). Optional and backward-compatible —
   * unmarked tools receive safe defaults (actionCategory: 'integration',
   * minRole: 'member', destructive: false).
   *
   * - `actionCategory` — the per-workspace MCP action-policy kill-switch category
   *   (gate 1). A workspace admin can disable an entire category via the action
   *   policy dashboard, blocking all tools in that category. Defaults to
   *   `'integration'` if omitted (most plugin tools interact with third-party APIs).
   *   Use `'datasource'` for tools that provision or manage data connections,
   *   `'policy'` for tools that change governance settings.
   *
   * - `minRole` — minimum RBAC role required on the actor (gate 3). Defaults to
   *   `'member'` so existing plugin tools remain accessible. Set to `'admin'` for
   *   tools that mutate shared workspace resources.
   *
   * - `destructive` — if `true`, the tool is routed through the approval gate
   *   (gate 4) with `origin=mcp` so a matching approval rule queues the action
   *   for review before execution. Defaults to `false`. A tool with
   *   `destructiveHint: true` in annotations but `destructive: false` here will
   *   enforce `mcp:write` (gate 2) but NOT queue for approval — set `destructive:
   *   true` explicitly for irreversible mutations.
   */
  readonly actionCategory?: "datasource" | "integration" | "policy";
  readonly minRole?: "member" | "admin" | "owner";
  readonly destructive?: boolean;
  /** Tool handler. Receives the parsed args and a per-dispatch context. */
  handler(args: TInput, context: McpToolContext): Promise<TOutput>;
}

// ---------------------------------------------------------------------------
// Datasource introspection (profiling)
// ---------------------------------------------------------------------------

/**
 * Structural mirrors of the profiler contracts in `@useatlas/types`
 * (`DatabaseObject`, `TableProfile`, `ProfilingResult`, …). Inlined here — like
 * {@link PluginDBConnection} mirrors the core `DBConnection` — so the plugin SDK
 * stays free of a runtime dependency on `@useatlas/types`/`@atlas/api`. The
 * shapes are field-for-field identical to the canonical types, so a plugin's
 * `profile`/`listObjects` output flows into the host's registry-resolved profiler
 * seam (`SemanticGenerator`'s `DatasourceProfiler`) by structural typing, with no
 * import crossing the core↔plugin boundary (ADR-0013, ADR-0017).
 */

/** Database object kind returned by {@link AtlasDatasourcePlugin.connection.listObjects}. */
export type PluginObjectType = "table" | "view" | "materialized_view";

/** Semantic type inferred for a column (mirror of `@useatlas/types` `SemanticType`). */
export type PluginSemanticType =
  | "currency"
  | "percentage"
  | "email"
  | "url"
  | "phone"
  | "timestamp";

/** Source of a foreign-key relationship (mirror of `@useatlas/types` `ForeignKeySource`). */
export type PluginForeignKeySource = "constraint" | "inferred";

/** A foreign-key relationship discovered (or inferred) during profiling. */
export interface PluginForeignKey {
  from_column: string;
  to_table: string;
  to_column: string;
  source: PluginForeignKeySource;
}

/** Heuristic table-level flags set by the host's analysis pass. */
export interface PluginTableFlags {
  possibly_abandoned: boolean;
  possibly_denormalized: boolean;
}

/** Partition strategy for a partitioned table (mirror of `@useatlas/types`). */
export type PluginPartitionStrategy = "range" | "list" | "hash";

/** Partition metadata for a partitioned table. */
export interface PluginPartitionInfo {
  strategy: PluginPartitionStrategy;
  key: string;
  children: string[];
}

/**
 * A single column profile (mirror of `@useatlas/types` `ColumnProfile`).
 *
 * Invariant: when `is_foreign_key` is true, `fk_target_table`/`fk_target_column`
 * are non-null; when false, both are null.
 */
export interface PluginColumnProfile {
  name: string;
  type: string;
  nullable: boolean;
  unique_count: number | null;
  null_count: number | null;
  sample_values: string[];
  is_primary_key: boolean;
  is_foreign_key: boolean;
  fk_target_table: string | null;
  fk_target_column: string | null;
  is_enum_like: boolean;
  semantic_type?: PluginSemanticType;
  profiler_notes: string[];
}

/** A single table/view profile (mirror of `@useatlas/types` `TableProfile`). */
export interface PluginTableProfile {
  table_name: string;
  object_type: PluginObjectType;
  row_count: number;
  columns: PluginColumnProfile[];
  primary_key_columns: string[];
  foreign_keys: PluginForeignKey[];
  inferred_foreign_keys: PluginForeignKey[];
  profiler_notes: string[];
  table_flags: PluginTableFlags;
  matview_populated?: boolean;
  partition_info?: PluginPartitionInfo;
}

/** A discovered database object (mirror of `@useatlas/types` `DatabaseObject`). */
export interface PluginDatabaseObject {
  name: string;
  type: PluginObjectType;
}

/** A per-table profiling failure below the host's abort threshold. */
export interface PluginProfileError {
  table: string;
  error: string;
}

/** Outcome of {@link AtlasDatasourcePlugin.connection.profile} (mirror of `ProfilingResult`). */
export interface PluginProfilingResult {
  profiles: PluginTableProfile[];
  errors: PluginProfileError[];
}

/** Minimal structured logger a profiler may use (pino's `(obj, msg)` shape). */
export interface PluginProfileLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Progress callbacks the host passes so a long profile can report incrementally. */
export interface PluginProfileProgress {
  onStart(total: number): void;
  onTableStart(name: string, index: number, total: number): void;
  onTableDone(name: string, index: number, total: number): void;
  onTableError(name: string, error: string, index: number, total: number): void;
  onComplete(count: number, elapsedMs: number): void;
}

/** Inputs for {@link AtlasDatasourcePlugin.connection.listObjects}. */
export interface PluginListObjectsOptions {
  /** Connection string / URL for the datasource (same value `createFromConfig` resolves). */
  url: string;
  /** Schema / database to enumerate. Dialect-specific (Postgres schema, ClickHouse database). */
  schema?: string;
  /**
   * The datasource's resolved, DECRYPTED connection config — the same record
   * `createFromConfig` receives. Carried by the host's in-product wizard so
   * plugins that hold credentials in SEPARATE config fields (not embedded in the
   * `url`) ENUMERATE with the TENANT's own credentials rather than falling back
   * to operator env vars (#3621, the wizard equivalent of the ADR-0017 amendment
   * that added `config` to {@link PluginProfileOptions}). Elasticsearch is the
   * motivating case: its `apiKey` / `username` / `password` / SigV4 fields live
   * alongside the endpoint `url`, so without this the table picker would read
   * `ATLAS_ES_*` operator env — a violation of the "per-tenant plugin creds never
   * fall back to operator env" rule.
   *
   * The MCP profiling surface never calls `listObjects` (it profiles a fixed set),
   * so this field is exercised by the wizard's table-picker step. Plugins whose
   * credentials are fully url-embedded (ClickHouse, Snowflake) ignore it. Omitted
   * by the CLI/static-config path, which legitimately resolves auth from env in
   * the operator's own shell.
   *
   * SECURITY: this carries DECRYPTED secret material. It must NEVER be logged,
   * echoed in an error, or surfaced to the agent/LLM — same discipline as the
   * decrypted `url`.
   */
  config?: Readonly<Record<string, unknown>>;
}

/**
 * Inputs for {@link AtlasDatasourcePlugin.connection.profile}. Field-for-field
 * aligned with the host's `DatasourceProfiler` injection point so the
 * registry-resolved seam can adapt a plugin's `profile` with no impedance
 * mismatch (ADR-0017).
 */
export interface PluginProfileOptions extends PluginListObjectsOptions {
  /** Restrict profiling to these tables/views. Omit to profile every object. */
  selectedTables?: string[];
  /** Pre-listed objects (from a prior {@link listObjects}) — avoids a second catalog round-trip. */
  prefetchedObjects?: PluginDatabaseObject[];
  /** Progress callbacks (e.g. a CLI progress bar or the MCP progress bridge). */
  progress?: PluginProfileProgress;
  /** Structured logger for profiler diagnostics. */
  logger?: PluginProfileLogger;
  /**
   * The datasource's resolved, DECRYPTED connection config — the same record
   * `createFromConfig` receives. Carried by the host's profiler seam (ADR-0017)
   * so plugins that hold credentials in SEPARATE config fields (not embedded in
   * the `url`) profile with the TENANT's own credentials rather than falling back
   * to operator env vars. Elasticsearch is the motivating case: its `apiKey` /
   * `username` / `password` / SigV4 fields live alongside the endpoint `url`, so
   * without this the profiler would read `ATLAS_ES_*` operator env — a violation
   * of the "per-tenant plugin creds never fall back to operator env" rule.
   *
   * Plugins whose credentials are fully embedded in the `url` (ClickHouse,
   * Snowflake) ignore this field. Omitted by the CLI/static-config path, which
   * legitimately resolves auth from env in the operator's own shell.
   *
   * SECURITY: this carries DECRYPTED secret material. It must NEVER be logged,
   * echoed in an error, or surfaced to the agent/LLM — same discipline as the
   * decrypted `url`.
   */
  config?: Readonly<Record<string, unknown>>;
}

/**
 * Inputs for the BUILT connection's bound {@link PluginDBConnection.listObjects}
 * (#3667). No `url`/`config`: the connection is already authenticated and bound
 * to the creds that built it, so introspection is a capability OF the connection
 * rather than a static function that re-resolves auth.
 */
export interface PluginConnectionListObjectsOptions {
  /** Schema / database to enumerate. Dialect-specific; omit for the connection's default. */
  schema?: string;
}

/**
 * Inputs for the BUILT connection's bound {@link PluginDBConnection.profile}
 * (#3667). No `url`/`config` — see {@link PluginConnectionListObjectsOptions}.
 */
export interface PluginConnectionProfileOptions {
  /** Schema / database / dataset to profile. Dialect-specific; omit for the default. */
  schema?: string;
  /** Restrict profiling to these tables/views. Omit to profile every object. */
  selectedTables?: string[];
  /** Pre-listed objects (from a prior {@link PluginDBConnection.listObjects}) — avoids a second catalog round-trip. */
  prefetchedObjects?: PluginDatabaseObject[];
  /** Progress callbacks (e.g. the host's MCP progress bridge). */
  progress?: PluginProfileProgress;
  /** Structured logger for profiler diagnostics. */
  logger?: PluginProfileLogger;
}

// ---------------------------------------------------------------------------
// Datasource plugin
// ---------------------------------------------------------------------------
/**
 * A single entity definition shipped by a datasource plugin.
 * Uses the same YAML format as `semantic/entities/*.yml`.
 */
export interface PluginEntity {
  /** Entity name (typically the table name, used for identification). */
  readonly name: string;
  /** YAML content defining the entity (same format as semantic/entities/*.yml). */
  readonly yaml: string;
}

/**
 * Static array of entities or an async factory that produces them.
 * Factories are called once during plugin wiring at server boot.
 */
export type EntityProvider =
  | readonly PluginEntity[]
  | (() => Promise<PluginEntity[]> | PluginEntity[]);

export interface AtlasDatasourcePlugin<TConfig = undefined> extends AtlasPluginBase<TConfig> {
  readonly connection: {
    /**
     * Factory: create a DBConnection for the registry from the plugin's
     * config-time config (the object passed to the plugin factory in
     * `atlas.config.ts`). Used by the boot-time static wiring path
     * (`wireDatasourcePlugins`) to register a single config-defined
     * connection.
     *
     * Optional: a plugin registered as an ADAPTER ONLY — the SaaS
     * per-workspace model where every datasource is DB-stored
     * (admin-UI-registered, encrypted), not baked into operator config —
     * omits `create` and implements only {@link createFromConfig}.
     * `wireDatasourcePlugins` skips adapter-only plugins for static wiring;
     * the datasource bridge still finds them via the registry's `getAll()`
     * to build per-(workspace, install) connections on demand. At least one
     * of `create` / `createFromConfig` must be present — enforced by
     * `validatePluginShape`.
     */
    create?(): Promise<PluginDBConnection> | PluginDBConnection;
    /**
     * Factory: create a DBConnection from a runtime config resolved from a
     * DB-stored datasource install (admin-UI-registered, persisted in
     * `workspace_plugins`). Unlike {@link create}, which closes over the
     * config-time config, this accepts the per-(workspace, install) config
     * decrypted from the database — enabling multi-tenant, DB-driven
     * datasources of this plugin's `dbType` rather than a single static
     * connection.
     *
     * The `config` is the raw decrypted config record; the plugin validates
     * it with its own schema (typically the same `configSchema`) and builds
     * the connection. Throw a clear error when required fields are missing.
     *
     * Plugins that only support static config-defined connections may omit
     * this; DB-stored installs of their `dbType` then remain unsupported.
     */
    createFromConfig?(
      config: Readonly<Record<string, unknown>>,
    ): Promise<PluginDBConnection> | PluginDBConnection;
    /** Database type identifier (used for SQL dialect selection). */
    dbType: PluginDBType;
    /**
     * Custom query validator for non-SQL datasources (e.g. SOQL, GraphQL, MQL).
     * Completely replaces the standard SQL validation pipeline for this connection.
     *
     * Return `{ valid: true }` to allow execution, or `{ valid: false, reason: "..." }`
     * to reject. The `reason` is user-facing — it appears in error responses and audit logs.
     *
     * Can be synchronous or asynchronous — async validators are useful when validation
     * requires an external call (e.g. schema service, permission check).
     *
     * Queries rewritten by hooks are re-validated through this function before execution.
     */
    validate?(query: string): QueryValidationResult | Promise<QueryValidationResult>;
    /**
     * node-sql-parser dialect string for SQL validation. When not provided,
     * the core pipeline auto-detects from `dbType`. Override this when `dbType`
     * uses the `string & {}` escape hatch or when the auto-detected dialect is
     * wrong for your database.
     *
     * Values are case-sensitive (e.g. `"PostgresQL"`, not `"postgresql"`).
     * Use patterns with the `/i` flag for case-insensitive matching.
     *
     * Ignored when a custom `validate` function is provided (which replaces
     * the entire SQL validation pipeline).
     */
    parserDialect?: ParserDialect;
    /**
     * Additional regex patterns to block beyond the base DML/DDL guard.
     * Each pattern is tested against the trimmed SQL string. Use `\b` word
     * boundaries and the `/i` flag for case-insensitive matching, consistent
     * with core forbidden patterns (see `FORBIDDEN_PATTERNS` in sql.ts).
     *
     * Ignored when a custom `validate` function is provided (which replaces
     * the entire SQL validation pipeline).
     */
    forbiddenPatterns?: RegExp[];
    /**
     * Introspect: enumerate the datasource's queryable objects (tables, views,
     * materialized views). The discovery half of the profiler seam (ADR-0017):
     * the host calls this to populate a "which tables to onboard" picker and to
     * feed `prefetchedObjects` into {@link profile}, avoiding a second catalog
     * round-trip.
     *
     * Optional and additive — a query-only datasource (one that cannot, or does
     * not wish to, be auto-onboarded) omits both `listObjects` and `profile` and
     * the host degrades to its explicit `unsupported_db_type` outcome rather than
     * a silent empty result. Must run **read-only**.
     */
    listObjects?(
      options: PluginListObjectsOptions,
    ): Promise<PluginDatabaseObject[]> | PluginDatabaseObject[];
    /**
     * Introspect: profile the datasource's objects into a {@link PluginProfilingResult}
     * — column types, sample values, key metadata, and per-table errors — the raw
     * material the host's shared generate/enrich engine turns into a semantic
     * layer. The profiling half of the profiler seam (ADR-0017).
     *
     * The host resolves this off the plugin registry by the SAME predicate that
     * resolves {@link createFromConfig} (provisioning and profiling stay in
     * lockstep — see `resolveProfileCapability`) and feeds it into
     * `SemanticGenerator`'s `DatasourceProfiler` injection point. Core never
     * imports the plugin package; resolution is structural.
     *
     * Optional and additive (see {@link listObjects}). Must run **read-only** and
     * MUST NOT surface credentials in thrown errors — the host scrubs DSN
     * userinfo from messages, but the profiler should not echo secrets either.
     */
    profile?(
      options: PluginProfileOptions,
    ): Promise<PluginProfilingResult>;
  };
  /**
   * Optional entity definitions — plugin-provided semantic layer fragments.
   * Merged into the table whitelist at boot (in-memory only, no disk writes).
   * Static array or async factory.
   */
  readonly entities?: EntityProvider;
  /**
   * Optional SQL dialect guidance injected into the agent system prompt.
   * Use for dialect-specific tips (e.g. "Use SAFE_DIVIDE instead of / for BigQuery").
   */
  readonly dialect?: string;
}

// ---------------------------------------------------------------------------
// Context plugin
// ---------------------------------------------------------------------------

export interface AtlasContextPlugin<TConfig = undefined> extends AtlasPluginBase<TConfig> {
  readonly contextProvider: {
    /** Load context (e.g. additional system prompt fragments, entity YAMLs). */
    load(): Promise<string>;
    /** Optional refresh hook for cache invalidation. */
    refresh?(): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Interaction plugin
// ---------------------------------------------------------------------------

export interface AtlasInteractionPlugin<TConfig = undefined> extends AtlasPluginBase<TConfig> {
  /**
   * Mount routes on the Hono app. Optional — not all interaction plugins
   * need HTTP routes (e.g., stdio-based transports like MCP).
   */
  readonly routes?: (app: Hono) => void;
}

// ---------------------------------------------------------------------------
// Action plugin
// ---------------------------------------------------------------------------

export interface PluginAction {
  readonly name: string;
  readonly description: string;
  /** The AI SDK tool definition. */
  readonly tool: ToolSet[string];
  readonly actionType: string;
  readonly reversible: boolean;
  readonly defaultApproval: ActionApprovalMode;
  readonly requiredCredentials: string[];
}

export interface AtlasActionPlugin<TConfig = undefined> extends AtlasPluginBase<TConfig> {
  readonly actions: PluginAction[];
}

// ---------------------------------------------------------------------------
// Sandbox plugin (explore backend isolation)
// ---------------------------------------------------------------------------

/** Result of a shell command execution inside a sandbox. */
export interface PluginExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Explore backend interface for sandbox plugins.
 *
 * Structural mirror of ExploreBackend from @atlas/api — plugins implement
 * this without importing the API package.
 */
export interface PluginExploreBackend {
  exec(command: string): Promise<PluginExecResult>;
  close?(): Promise<void>;
}

/**
 * Sandbox plugin — pluggable explore backend for custom isolation strategies.
 *
 * **Security:** Sandbox plugins have shell execution access to the semantic
 * layer directory. The host trusts the plugin to enforce read-only access
 * and isolation. Operators should only install sandbox plugins from trusted
 * sources. The `security` metadata is informational — it is the plugin's
 * self-declaration, not enforced by the host.
 *
 * Built-in backends (nsjail, Vercel) have verified isolation; plugin
 * backends are trust-the-author.
 */
export interface AtlasSandboxPlugin<TConfig = undefined> extends AtlasPluginBase<TConfig> {
  readonly sandbox: {
    /**
     * Create an ExploreBackend instance.
     * Called once during backend initialization (cached).
     * The semanticRoot path is provided for backends that need filesystem access.
     */
    create(semanticRoot: string): Promise<PluginExploreBackend> | PluginExploreBackend;
    /**
     * Priority relative to built-in backends.
     * Higher priority backends are tried first.
     * Built-in priorities: vercel=100, nsjail=75, sidecar=50, just-bash=0
     * Plugin backends default to 60 (between nsjail and sidecar).
     */
    priority?: number;
  };
  /**
   * Optional security metadata. Informational — the host logs these
   * during initialization so operators know what isolation guarantees
   * the backend provides.
   */
  readonly security?: {
    /** Does this backend provide network isolation? */
    networkIsolation?: boolean;
    /** Does this backend provide filesystem isolation? */
    filesystemIsolation?: boolean;
    /** Does this backend run commands as an unprivileged user? */
    unprivilegedExecution?: boolean;
    /** Human-readable description of isolation guarantees. */
    description?: string;
  };
}

/** Default priority for sandbox plugins (between nsjail=75 and sidecar=50). */
export const SANDBOX_DEFAULT_PRIORITY = 60;

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type AtlasPlugin =
  | AtlasDatasourcePlugin<unknown>
  | AtlasContextPlugin<unknown>
  | AtlasInteractionPlugin<unknown>
  | AtlasActionPlugin<unknown>
  | AtlasSandboxPlugin<unknown>;

// ---------------------------------------------------------------------------
// $InferServerPlugin — client-side type inference (Better Auth pattern)
// ---------------------------------------------------------------------------

/**
 * Extract the plugin object type from either:
 * - A factory function (`createPlugin()` result, or a `buildXPlugin()` function) — extracts the return type
 * - A direct plugin object (`definePlugin()` result, or the return value of a `buildXPlugin()` call) — returns T itself
 */
type _ExtractPlugin<T> =
  // Factory function: (config: C) => Plugin
  T extends (config: infer _C) => infer P ? P :
  // Direct plugin object
  T extends AtlasPluginBase<infer _C2> ? T :
  never;

/**
 * Extract the config type from either a factory function parameter or a direct plugin's TConfig generic.
 */
type _ExtractConfig<T> =
  // Factory function: (config: C) => Plugin
  T extends (config: infer C) => infer _P ? C :
  // Direct plugin object
  T extends AtlasPluginBase<infer C> ? C :
  never;

/** Map extracted plugin + config into the public inference surface. */
type _InferFrom<P, C> = {
  /** The plugin's configuration type (parameter type for factories, TConfig for direct objects). */
  Config: C;
  /** The plugin type(s). */
  Types: P extends { types: infer U } ? U : never;
  /** The plugin ID. */
  Id: P extends { id: infer U } ? U : never;
  /** The plugin display name. */
  Name: P extends { name: infer U } ? U : never;
  /** The plugin SemVer version. */
  Version: P extends { version: infer U } ? U : never;
  /** For datasource plugins: the database type string. Never for non-datasource plugins. */
  DbType: P extends AtlasDatasourcePlugin<infer _C3> ? P["connection"]["dbType"] : never;
  /** For action plugins: the actions array type. Never for non-action plugins. */
  Actions: P extends AtlasActionPlugin<infer _C4> ? P["actions"] : never;
  /** For sandbox plugins: the security metadata. Never for non-sandbox plugins. */
  Security: P extends AtlasSandboxPlugin<infer _C5> ? P["security"] : never;
};

/**
 * Infer the public type surface of a server-defined plugin.
 * Enables client code to extract plugin types without importing server modules.
 *
 * Works with both `createPlugin()` factory functions and `definePlugin()` /
 * `buildXPlugin()` direct objects, following Better Auth's `$Infer` pattern.
 *
 * @example
 * ```typescript
 * import type { $InferServerPlugin } from "@useatlas/plugin-sdk";
 * import type { clickhousePlugin } from "@useatlas/clickhouse";
 *
 * type CH = $InferServerPlugin<typeof clickhousePlugin>;
 * // CH["Config"] → { url?: string; database?: string }
 * // CH["Types"]  → readonly ["datasource"]
 * // CH["Id"]     → string
 * ```
 */
export type $InferServerPlugin<T> = _InferFrom<_ExtractPlugin<T>, _ExtractConfig<T>>;
