/**
 * Wire-shape tests for the MCP structured logger (#3494).
 *
 * Asserts the external behavior an operator's log aggregator sees: a line
 * emitted inside an MCP dispatch is structured JSON carrying the dispatch's
 * `requestId`, `toolName`, and (hosted) `clientId`, credential-bearing
 * fields are redacted, and lines emitted outside any request context omit
 * the correlation keys. We pipe a logger built from the *same*
 * `mcpLoggerOptions` to an in-memory stream rather than intercepting fd 2 —
 * the fd binding is a trivial one-liner; the mixin + redaction are the
 * contract worth testing.
 */

import { describe, test, expect } from "bun:test";
import pino from "pino";
import { withRequestContext } from "@atlas/api/lib/logger";
import { mcpLoggerOptions } from "../logger";

/** Build a logger over an in-memory stream that collects parsed JSON records. */
function captureLogger() {
  const records: Record<string, unknown>[] = [];
  const stream = {
    write(chunk: string) {
      records.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  };
  const logger = pino(mcpLoggerOptions, stream).child({ component: "mcp:test" });
  return { logger, records };
}

describe("mcp logger", () => {
  test("emits structured JSON with the component tag", () => {
    const { logger, records } = captureLogger();
    logger.warn("boom");
    expect(records).toHaveLength(1);
    expect(records[0].component).toBe("mcp:test");
    expect(records[0].msg).toBe("boom");
    // Structured, not a raw `[atlas-mcp] ...` string line.
    expect(typeof records[0].level).toBe("number");
  });

  test("carries requestId + toolName + clientId from an MCP dispatch context", () => {
    const { logger, records } = captureLogger();
    withRequestContext(
      {
        requestId: "mcp-executeSQL-123",
        actor: { kind: "mcp", toolName: "executeSQL", clientId: "claude-desktop" },
      },
      () => {
        logger.error("executeSQL tool threw");
      },
    );
    expect(records).toHaveLength(1);
    expect(records[0].requestId).toBe("mcp-executeSQL-123");
    expect(records[0].toolName).toBe("executeSQL");
    expect(records[0].clientId).toBe("claude-desktop");
  });

  test("omits clientId for a stdio (unbound) MCP dispatch", () => {
    const { logger, records } = captureLogger();
    withRequestContext(
      { requestId: "mcp-explore-9", actor: { kind: "mcp", toolName: "explore" } },
      () => {
        logger.info("explore done");
      },
    );
    expect(records[0].requestId).toBe("mcp-explore-9");
    expect(records[0].toolName).toBe("explore");
    expect(records[0]).not.toHaveProperty("clientId");
  });

  test("omits correlation keys when emitted outside a request context", () => {
    const { logger, records } = captureLogger();
    logger.info("boot");
    expect(records[0]).not.toHaveProperty("requestId");
    expect(records[0]).not.toHaveProperty("toolName");
  });

  test("redacts credential-bearing fields so secrets never reach the log sink", () => {
    const { logger, records } = captureLogger();
    logger.warn({ password: "hunter2", token: "sk-secret", safe: "ok" }, "blocked");
    expect(records[0].password).toBe("[Redacted]");
    expect(records[0].token).toBe("[Redacted]");
    expect(records[0].safe).toBe("ok");
  });

  test("scrubs a connection-string URI echoed through the err serializer", () => {
    const { logger, records } = captureLogger();
    logger.error(
      { err: new Error("connect failed: postgres://user:s3cret@db.internal/app") },
      "dispatch failed",
    );
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("s3cret");
  });
});
