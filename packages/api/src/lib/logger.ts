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

// Redaction covers top-level fields and one-level nested (*.field) plus
// array element access ([*].field). fast-redact does not support ** glob
// wildcards, so deeper nesting would require additional explicit paths.
export const redactPaths = [
  "connectionString",
  "databaseUrl",
  "apiKey",
  "password",
  "secret",
  "authorization",
  "*.connectionString",
  "*.databaseUrl",
  "*.apiKey",
  "*.password",
  "*.secret",
  "*.authorization",
  "[*].connectionString",
  "[*].databaseUrl",
  "[*].apiKey",
  "[*].password",
  "[*].secret",
  "[*].authorization",
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
