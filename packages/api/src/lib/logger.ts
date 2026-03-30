/**
 * Structured logger with request context propagation.
 *
 * - JSON output in production, pino-pretty in development
 * - Pino mixin + AsyncLocalStorage binds requestId to all log lines within a request
 * - Redaction paths prevent secrets from leaking into logs
 * - ATLAS_LOG_LEVEL env var controls verbosity (default: "info")
 */

import pino from "pino";
import { AsyncLocalStorage } from "async_hooks";
import type { AtlasUser } from "@atlas/api/lib/auth/types";

// --- Request context ---

interface RequestContext {
  requestId: string;
  user?: AtlasUser;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(
  ctx: RequestContext,
  fn: () => T,
): T {
  return requestStore.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestStore.getStore();
}

// --- Logger ---

const isDev = process.env.NODE_ENV !== "production";

// Redaction covers top-level fields, one-level nested (*.field), array
// element access ([*].field), and known deep structures. fast-redact does
// not support ** glob wildcards, so deep paths must be listed explicitly.
export const redactPaths = [
  "connectionString",
  "databaseUrl",
  "apiKey",
  "password",
  "secret",
  "authorization",
  "url",
  "*.connectionString",
  "*.databaseUrl",
  "*.apiKey",
  "*.password",
  "*.secret",
  "*.authorization",
  "*.url",
  "[*].connectionString",
  "[*].databaseUrl",
  "[*].apiKey",
  "[*].password",
  "[*].secret",
  "[*].authorization",
  "[*].url",
  // Deep structures: datasource config, connection registry, plugin config
  "datasources.*.url",
  "datasources.*.connectionString",
  "datasources.*.password",
  "config.datasources.*.url",
  "config.datasources.*.connectionString",
  "connection.url",
  "connection.connectionString",
  "connection.password",
  "connections.*.url",
  "connections.*.connectionString",
  "connections.*.password",
];

const rootLogger = pino({
  level: process.env.ATLAS_LOG_LEVEL ?? "info",
  redact: redactPaths,
  mixin() {
    const ctx = requestStore.getStore();
    if (!ctx) return {};
    const base: Record<string, unknown> = { requestId: ctx.requestId };
    if (ctx.user) {
      base.userId = ctx.user.id;
      base.authMode = ctx.user.mode;
    }
    return base;
  },
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  }),
});

/**
 * Get the root logger. Request context (requestId) is injected
 * automatically at log-emission time via pino mixin.
 */
export function getLogger(): pino.Logger {
  return rootLogger;
}

/**
 * Create a named child logger for a specific component.
 * Request context (requestId) is injected automatically at
 * log-emission time via pino mixin — safe to call at module scope.
 */
export function createLogger(component: string): pino.Logger {
  return rootLogger.child({ component });
}

const VALID_LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

/**
 * Update the root logger level at runtime.
 *
 * Used by the settings hot-reload system to apply ATLAS_LOG_LEVEL changes
 * in SaaS mode without a server restart. Pino propagates the level change
 * to all child loggers automatically.
 *
 * @returns true if the level was applied, false if the level is invalid.
 */
export function setLogLevel(level: string): boolean {
  if (!VALID_LOG_LEVELS.has(level)) return false;
  rootLogger.level = level;
  return true;
}
