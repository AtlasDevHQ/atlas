/**
 * #2078 meta-guardrail — analogue of `tools-binding-registry.test.ts`
 * for the plugin MCP dispatch wrapper.
 *
 * The class of bug F-54 / F-55 / #1858 closed was "agent runs without
 * a user bound — approval gate silently disabled." The native MCP
 * tools' meta-test pins that every `server.registerTool(...)` block
 * in `packages/mcp/src/tools.ts` contains a `withRequestContext(`
 * call. Plugin dispatch needs the same guard at the same lexical
 * boundary, plus an additional one: the per-OAuth-client rate-limit
 * gate must be INSIDE the `withRequestContext` callback so the
 * limiter's `mcp_session.rate_limited` audit row inherits the bound
 * actor, and so a future "lift the limiter out for performance"
 * refactor that bypasses actor binding fails CI.
 *
 * This file parses the dispatch source and asserts the lexical
 * relationship — without running the dispatch end-to-end (the
 * `plugin-mcp-tools.test.ts` integration test covers behavior; this
 * file pins the structural invariant that defends against silent
 * regressions).
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DISPATCH_FILE = resolve(import.meta.dir, "..", "mcp-tools.ts");

describe("plugin MCP dispatch binding registry (#2078)", () => {
  it("registerPluginMcpTools wraps every dispatch in withRequestContext", async () => {
    const source = await readFile(DISPATCH_FILE, "utf8");
    // The dispatch handler is built once per registered tool inside
    // `for (const tool of registry.getAll()) { ... }`. The wrapping
    // call must appear before the handler invocation lexically — a
    // refactor that lifted the limiter or input parse out of the
    // wrap would land here.
    expect(
      source,
      "dispatch handler must call withRequestContext({ actor: { kind: 'mcp', ... } })",
    ).toMatch(/withRequestContext\s*\(\s*\{\s*requestId\s*,\s*user:\s*actor\s*,\s*actor:\s*mcpActor/);
  });

  it("rate-limit gate runs INSIDE the withRequestContext callback", async () => {
    const source = await readFile(DISPATCH_FILE, "utf8");
    // Match the withRequestContext call body up to the matching close.
    // The limiter call (`enforceClientRateLimit(`) must appear inside
    // the body so the bound `mcp` actor is in scope when the limiter
    // emits `mcp_session.rate_limited` via `logAdminAction`.
    const withCtxStart = source.indexOf("withRequestContext(");
    expect(withCtxStart, "registerPluginMcpTools must call withRequestContext").toBeGreaterThan(-1);

    // Find the limiter call and assert it appears AFTER the wrap and
    // BEFORE the handler invocation.
    const limiterIdx = source.indexOf("enforceClientRateLimit(");
    const handlerCallIdx = source.indexOf("tool.handler(");
    expect(limiterIdx, "dispatch must call enforceClientRateLimit").toBeGreaterThan(-1);
    expect(limiterIdx).toBeGreaterThan(withCtxStart);
    expect(handlerCallIdx).toBeGreaterThan(limiterIdx);
  });

  it("dispatch is gated on clientId before invoking the limiter (stdio MCP exempt)", async () => {
    const source = await readFile(DISPATCH_FILE, "utf8");
    // The `if (clientId)` guard must precede `enforceClientRateLimit`
    // so stdio dispatches (no `clientId`) skip the limiter without
    // hitting Postgres. A regression that always calls the limiter
    // would surface in production as Claude Desktop installs hitting
    // the limiter for every tool call.
    const guardIdx = source.indexOf("if (clientId)");
    const limiterIdx = source.indexOf("enforceClientRateLimit(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(limiterIdx);
  });

  it("input validation appears AFTER rate-limit gate (denied requests don't pay parser cost)", async () => {
    const source = await readFile(DISPATCH_FILE, "utf8");
    const limiterIdx = source.indexOf("enforceClientRateLimit(");
    const safeParseIdx = source.indexOf("tool.inputSchema.safeParse(");
    expect(limiterIdx).toBeGreaterThan(-1);
    expect(safeParseIdx).toBeGreaterThan(-1);
    expect(safeParseIdx).toBeGreaterThan(limiterIdx);
  });
});
