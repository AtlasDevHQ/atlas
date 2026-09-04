/**
 * A capturing stand-in for `@atlas/api/lib/logger`, registered once per file.
 *
 * "The base file must not mock the logger, the logging sibling must" is not a
 * file boundary (#5645): a stub that covers every value export of
 * `lib/logger.ts` is indistinguishable from the real module to a test that
 * never looks at the log, so a suite that reads results and a suite that reads
 * the log can share one registration — one reads `calls`, the other ignores
 * them.
 *
 * Every value export is stubbed, and the factory is typed against the REAL
 * module's export set (`keyof typeof RealLogger`, a type-only import that costs
 * nothing at runtime). Add an export to `lib/logger.ts` and this file stops
 * compiling until the stub grows to match — the "mock all exports" rule in
 * `.claude/rules/testing.md`, enforced by the type-checker instead of by a
 * link-time `Export named 'X' not found` in some unrelated suite.
 *
 * Install it BEFORE the module under test is imported, and import that module
 * dynamically — a static import is hoisted above this call and captures the
 * real `createLogger` at module-evaluation time:
 *
 *   const logger = installLoggerMock();
 *   const { subject } = await import("../subject");
 *   beforeEach(() => logger.reset());
 *
 * @module
 */

import { mock } from "bun:test";
import type * as RealLogger from "@atlas/api/lib/logger";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/** One captured log call. `payload` is the pino merge object, `message` the msg. */
export interface LogCall {
  readonly level: LogLevel;
  readonly payload: unknown;
  readonly message: string;
}

export interface LoggerMock {
  /** Every call since the last `reset()`, in order, from every `createLogger()` instance. */
  readonly calls: readonly LogCall[];
  /** Warn-level calls, optionally narrowed to messages containing `needle` — the level logging suites pin. */
  readonly warns: (needle?: string) => LogCall[];
  /** Empty the capture. Call from `beforeEach`. */
  readonly reset: () => void;
}

const LEVELS: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace"];

/**
 * Register the logger stub and return the capture handle. Idempotent per file
 * only in the sense that the LAST registration wins — call it once, at the top.
 */
export function installLoggerMock(): LoggerMock {
  const calls: LogCall[] = [];

  // pino accepts `(obj, msg)`, `(msg)` and `(obj)`; normalise so a suite can
  // always read `.payload` and `.message` without caring which the caller used.
  const record = (level: LogLevel, first: unknown, second?: unknown): void => {
    if (typeof first === "string") {
      calls.push({ level, payload: undefined, message: first });
    } else {
      calls.push({ level, payload: first, message: typeof second === "string" ? second : "" });
    }
  };

  // One sink for every logger — `createLogger()`, `getLogger()` and `child()`
  // alike — so a suite has one list to read, not one per component.
  const makeLogger = (): Record<string, unknown> => {
    const logger: Record<string, unknown> = { level: "info", silent: (): void => {} };
    for (const level of LEVELS) {
      logger[level] = (first: unknown, second?: unknown): void => record(level, first, second);
    }
    logger.child = (): Record<string, unknown> => makeLogger();
    return logger;
  };
  const root = makeLogger();

  const factory = (): Record<keyof typeof RealLogger, unknown> => ({
    ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
    withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
    getRequestContext: (): undefined => undefined,
    redactPaths: [] as string[],
    scrubErrSerializer: (value: unknown): unknown => value,
    scrubLogFormatter: (obj: unknown): unknown => obj,
    getLogger: () => root,
    createLogger: () => makeLogger(),
    hashShareToken: (token: string): string => token,
    setLogLevel: (): boolean => true,
  });

  void mock.module("@atlas/api/lib/logger", factory);

  return {
    calls,
    warns: (needle?: string) =>
      calls.filter((c) => c.level === "warn" && (needle === undefined || c.message.includes(needle))),
    reset: () => {
      calls.length = 0;
    },
  };
}
