/**
 * Testing utilities for Atlas plugin authors.
 *
 * Provides mock factories for AtlasPluginContext, PluginDBConnection, and
 * PluginExploreBackend so plugin tests can avoid duplicating boilerplate.
 *
 * @example
 * ```typescript
 * import { createMockContext, createMockConnection } from "@useatlas/plugin-sdk/testing";
 *
 * const { ctx, logs, registeredTools } = createMockContext();
 * await plugin.initialize(ctx);
 * expect(logs.some(l => l.msg.includes("initialized"))).toBe(true);
 * ```
 */

import type {
  AtlasPluginContext,
  PluginDBConnection,
  PluginExploreBackend,
  PluginExecResult,
  PluginLogger,
  PluginQueryResult,
} from "./types";

// ---------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------

export interface CapturedLog {
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  obj?: Record<string, unknown>;
}

/**
 * Create a PluginLogger that captures all log calls to an array.
 * Useful for asserting that a plugin logs expected messages.
 */
export function createMockLogger(logs?: CapturedLog[]): {
  logger: PluginLogger;
  logs: CapturedLog[];
} {
  const captured: CapturedLog[] = logs ?? [];

  function makeHandler(level: CapturedLog["level"]) {
    return (...args: unknown[]) => {
      if (typeof args[0] === "string") {
        captured.push({ level, msg: args[0] });
      } else if (typeof args[0] === "object" && args[0] !== null) {
        captured.push({
          level,
          obj: args[0] as Record<string, unknown>,
          msg: typeof args[1] === "string" ? args[1] : "",
        });
      }
    };
  }

  const logger: PluginLogger = {
    info: makeHandler("info") as PluginLogger["info"],
    warn: makeHandler("warn") as PluginLogger["warn"],
    error: makeHandler("error") as PluginLogger["error"],
    debug: makeHandler("debug") as PluginLogger["debug"],
  };

  return { logger, logs: captured };
}

// ---------------------------------------------------------------------------
// Mock connection
// ---------------------------------------------------------------------------

export interface MockConnectionOptions {
  /** The result to return from query(). Can be overridden per-call via mockQuery(). */
  queryResult?: PluginQueryResult;
  /** If set, query() rejects with this error. */
  queryError?: Error;
}

export interface MockConnection extends PluginDBConnection {
  /** All calls made to query(), in order. */
  queryCalls: Array<{ sql: string; timeoutMs?: number }>;
  /** Whether close() has been called. */
  closed: boolean;
  /** Override the next query result. */
  mockQueryResult(result: PluginQueryResult): void;
  /** Override the next query to reject. */
  mockQueryError(error: Error): void;
}

/**
 * Create a mock PluginDBConnection with configurable query results
 * and call tracking.
 */
export function createMockConnection(
  opts: MockConnectionOptions = {},
): MockConnection {
  let nextResult: PluginQueryResult = opts.queryResult ?? {
    columns: [],
    rows: [],
  };
  let nextError: Error | undefined = opts.queryError;

  const conn: MockConnection = {
    queryCalls: [],
    closed: false,

    async query(sql: string, timeoutMs?: number): Promise<PluginQueryResult> {
      conn.queryCalls.push({ sql, timeoutMs });
      if (nextError) {
        const err = nextError;
        // Reset so subsequent calls don't re-throw unless explicitly set
        nextError = undefined;
        throw err;
      }
      return nextResult;
    },

    async close(): Promise<void> {
      conn.closed = true;
    },

    mockQueryResult(result: PluginQueryResult) {
      nextResult = result;
      nextError = undefined;
    },

    mockQueryError(error: Error) {
      nextError = error;
    },
  };

  return conn;
}

// ---------------------------------------------------------------------------
// Mock explore backend
// ---------------------------------------------------------------------------

export interface MockExploreBackendOptions {
  /** The result to return from exec(). */
  execResult?: PluginExecResult;
  /** If set, exec() rejects with this error. */
  execError?: Error;
}

export interface MockExploreBackend extends PluginExploreBackend {
  /** All commands passed to exec(), in order. */
  execCalls: string[];
  /** Whether close() has been called. */
  closed: boolean;
  /** Override the next exec result. */
  mockExecResult(result: PluginExecResult): void;
  /** Override the next exec to reject. */
  mockExecError(error: Error): void;
}

/**
 * Create a mock PluginExploreBackend with configurable exec results
 * and call tracking.
 */
export function createMockExploreBackend(
  opts: MockExploreBackendOptions = {},
): MockExploreBackend {
  let nextResult: PluginExecResult = opts.execResult ?? {
    stdout: "",
    stderr: "",
    exitCode: 0,
  };
  let nextError: Error | undefined = opts.execError;

  const backend: MockExploreBackend = {
    execCalls: [],
    closed: false,

    async exec(command: string): Promise<PluginExecResult> {
      backend.execCalls.push(command);
      if (nextError) {
        const err = nextError;
        nextError = undefined;
        throw err;
      }
      return nextResult;
    },

    async close(): Promise<void> {
      backend.closed = true;
    },

    mockExecResult(result: PluginExecResult) {
      nextResult = result;
      nextError = undefined;
    },

    mockExecError(error: Error) {
      nextError = error;
    },
  };

  return backend;
}

// ---------------------------------------------------------------------------
// Mock context
// ---------------------------------------------------------------------------

export interface MockContextOverrides {
  /** Override internal db. Pass `null` to simulate no DATABASE_URL. */
  db?: AtlasPluginContext["db"] | null;
  /** Override the connections registry. */
  connections?: Partial<AtlasPluginContext["connections"]>;
  /** Override the tools registry. */
  tools?: Partial<AtlasPluginContext["tools"]>;
  /** Override the logger. */
  logger?: PluginLogger;
  /** Override the config record. */
  config?: Record<string, unknown>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  tool: unknown;
}

export interface MockContextResult {
  ctx: AtlasPluginContext;
  /** All log entries captured by the mock logger. */
  logs: CapturedLog[];
  /** All tools registered via ctx.tools.register(). */
  registeredTools: RegisteredTool[];
}

/**
 * Create a mock AtlasPluginContext with sensible defaults.
 * All fields can be overridden.
 *
 * Returns the context along with captured log entries and registered tools
 * for easy assertions.
 */
export function createMockContext(
  overrides: MockContextOverrides = {},
): MockContextResult {
  const logs: CapturedLog[] = [];
  const registeredTools: RegisteredTool[] = [];
  const { logger } = createMockLogger(logs);

  const ctx: AtlasPluginContext = {
    db:
      overrides.db === undefined
        ? null
        : overrides.db === null
          ? null
          : overrides.db,
    connections: {
      get:
        overrides.connections?.get ??
        (() => {
          throw new Error("No connections registered in mock context");
        }),
      list: overrides.connections?.list ?? (() => []),
    },
    tools: {
      register:
        overrides.tools?.register ??
        ((tool: { name: string; description: string; tool: unknown }) => {
          registeredTools.push(tool as RegisteredTool);
        }),
    },
    logger: overrides.logger ?? logger,
    config: overrides.config ?? {},
  };

  return { ctx, logs, registeredTools };
}
