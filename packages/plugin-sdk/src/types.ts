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
    list(): string[];
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

/** Context passed to beforeToolCall / afterToolCall hooks. */
export interface ToolCallHookContext {
  toolName: string;
  args: Record<string, unknown>;
  context: {
    userId?: string;
    conversationId?: string;
    stepCount: number;
  };
}

export interface AfterToolCallHookContext extends ToolCallHookContext {
  result: unknown;
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
  /** Fires after each tool call. Return `{ result }` to rewrite the result. */
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
   * Agent lifecycle and HTTP hooks using the matcher + handler pattern.
   * Matchers are optional — omit to always fire.
   */
  hooks?: PluginHooks;

  /**
   * Declarative table definitions for the internal database.
   * Tables are auto-migrated at boot (see packages/api/src/lib/plugins/migrate.ts).
   */
  schema?: Record<string, PluginTableDefinition>;
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
    /** Factory: create a DBConnection for the registry. */
    create(): Promise<PluginDBConnection> | PluginDBConnection;
    /** Database type identifier (used for SQL dialect selection). */
    dbType: PluginDBType;
    /**
     * Custom query validator for non-SQL datasources (e.g. SOQL, GraphQL, MQL).
     * Completely replaces the standard SQL validation pipeline for this connection.
     *
     * Return `{ valid: true }` to allow execution, or `{ valid: false, reason: "..." }`
     * to reject. The `reason` is user-facing — it appears in error responses and audit logs.
     *
     * Queries rewritten by hooks are re-validated through this function before execution.
     */
    validate?(query: string): QueryValidationResult;
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
 * // CH["Config"] → { url: string; database?: string }
 * // CH["Types"]  → readonly ["datasource"]
 * // CH["Id"]     → string
 * ```
 */
export type $InferServerPlugin<T> = _InferFrom<_ExtractPlugin<T>, _ExtractConfig<T>>;
