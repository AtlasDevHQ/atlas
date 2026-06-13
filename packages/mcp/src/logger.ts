/**
 * Structured logging for the standalone MCP process (#3494).
 *
 * The shared `@atlas/api` logger (`createLogger`) writes to **stdout**,
 * which on the MCP stdio transport carries the JSON-RPC stream — a stray log
 * line there corrupts the protocol. This module reuses that logger's
 * redaction paths, error scrubber, and URL-credential formatter but pins the
 * destination to **fd 2 (stderr)**, the transport-safe diagnostic channel
 * for both the stdio and SSE transports. Output is structured JSON (no
 * pino-pretty worker) so an operator's log aggregator can parse it and a
 * pretty transport can never accidentally reclaim stdout.
 *
 * `requestId` / actor correlation is automatic: every MCP tool dispatch
 * wraps its handler in `withRequestContext({ requestId, actor, ... })` (see
 * `tools.ts` / `semantic-tools.ts`), so a log line emitted inside a dispatch
 * carries that dispatch's `requestId`, `toolName`, and (hosted) OAuth
 * `clientId` via the mixin below — the caller never threads them by hand.
 *
 * We deliberately keep pino/OTel rather than adopting the MCP `logging`
 * capability (deprecated in the 2026-07-28 draft). See PRD #3483.
 */

import pino from "pino";
import {
  redactPaths,
  scrubErrSerializer,
  scrubLogFormatter,
  getRequestContext,
} from "@atlas/api/lib/logger";

/**
 * Pino options shared by the production stderr logger and test loggers.
 *
 * Exported so a test can pipe an identical logger to an in-memory capture
 * stream and assert the wire shape (mixin fields + redaction) without
 * intercepting fd 2 — the fd binding itself is a one-liner below and not
 * worth a fixture.
 */
export const mcpLoggerOptions: pino.LoggerOptions = {
  level: process.env.ATLAS_LOG_LEVEL ?? "info",
  redact: redactPaths,
  serializers: { err: scrubErrSerializer },
  formatters: { log: scrubLogFormatter },
  mixin() {
    const ctx = getRequestContext();
    if (!ctx) return {};
    const base: Record<string, unknown> = { requestId: ctx.requestId };
    // The MCP dispatch actor carries the tool name (and, hosted, the OAuth
    // client id). Threading them onto every line is what makes a tool
    // failure traceable to a specific client + tool in a log aggregator.
    const actor = ctx.actor;
    if (actor?.kind === "mcp") {
      base.toolName = actor.toolName;
      if (actor.clientId) base.clientId = actor.clientId;
    }
    return base;
  },
};

// `sync: true` — diagnostics are low-volume and a short-lived stdio process
// may exit (or crash) before an async buffer flushes; synchronous writes
// guarantee the line reaches the operator's terminal / aggregator, matching
// the reliability the raw stderr writes / `console.error` calls had.
const rootLogger = pino(
  mcpLoggerOptions,
  pino.destination({ dest: 2, sync: true }),
);

/**
 * Create a named child logger for an MCP component. `requestId` / actor
 * context is injected at log-emission time via the mixin — safe to call at
 * module scope.
 */
export function createMcpLogger(component: string): pino.Logger {
  return rootLogger.child({ component });
}
