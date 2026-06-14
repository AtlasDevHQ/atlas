/**
 * #1858 meta-guardrail — MCP analogue of `agent-surface-registry.test.ts`.
 *
 * The class of bug F-54 / F-55 / #1858 closed was "agent runs without a
 * user bound — approval gate silently disabled." The unit tests in
 * `tools.test.ts` pin the *current* two tools (`explore`, `executeSQL`),
 * but a third tool added later — or a refactor that drops actor binding on
 * one of the existing two — would silently regress with no behavioral test
 * catching it for the new tool.
 *
 * #3602 — the actor-binding wrap (`withRequestContext`) was centralized into
 * the SHARED dispatch wrapper (`mcp-dispatch.ts`), so the invariant is now
 * stronger AND structural: every `server.registerTool(...)` block routes
 * through `dispatch(...)`, and the shared wrapper itself does the bind. A tool
 * can no longer forget the wrap per-site — it would have to bypass `dispatch`
 * entirely, which this test catches. We pin BOTH halves: every registration
 * routes through `dispatch(`, and `mcp-dispatch.ts` binds via
 * `withRequestContext`.
 *
 * Adding a new tool means routing it through `dispatch(...)` like the other
 * two. Forgetting fails the suite with a pointer to this file.
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const TOOLS_FILE = resolve(import.meta.dir, "..", "tools.ts");
const DISPATCH_FILE = resolve(import.meta.dir, "..", "mcp-dispatch.ts");

describe("MCP tool binding registry", () => {
  it("every server.registerTool block routes its handler through the shared dispatch wrapper", async () => {
    const source = await readFile(TOOLS_FILE, "utf8");

    // Split on `server.registerTool(` to isolate each registration block.
    // The first split element is the file preamble — discard it.
    const blocks = source.split(/server\.registerTool\s*\(/);
    const registrations = blocks.slice(1);

    expect(
      registrations.length,
      "tools.ts must register at least one tool — if zero, `registerTools` is dead code",
    ).toBeGreaterThan(0);

    for (let i = 0; i < registrations.length; i++) {
      // Each registration's body extends from `server.registerTool(` until
      // the next registration (or EOF for the last one). Searching the full
      // block is safe because `blocks[0]` (the file preamble) is dropped and
      // only the next `server.registerTool(` bounds the block, so a missing
      // route can't borrow the next registration's `dispatch(` to pass.
      const body = registrations[i];

      expect(
        body.includes("dispatch("),
        `MCP tool registration #${i + 1} does not route through the shared dispatch(...) wrapper. ` +
          `Adding a tool? Mirror the explore / executeSQL handlers in tools.ts: ` +
          `return dispatch(toolName, reqs, async (requestId) => { ... }). ` +
          `See #1858 / #3602: an un-dispatched handler silently bypasses actor binding + the ADR-0016 gate order.`,
      ).toBe(true);
    }
  });

  it("the shared dispatch wrapper binds the actor via withRequestContext (#1858/#3602)", async () => {
    // The bind every tool relies on lives ONCE here. A refactor that lifted it
    // out of the shared wrapper (restoring the pre-#1858 unbound-dispatch shape
    // for every tool at once) would land on this assertion.
    const source = await readFile(DISPATCH_FILE, "utf8");
    expect(
      source,
      "mcp-dispatch.ts must bind the `mcp` actor via withRequestContext({ user: actor, actor, agentOrigin: 'mcp' })",
    ).toMatch(
      /withRequestContext\(\s*\{[\s\S]*?user:\s*actor[\s\S]*?actor:\s*mcpActor\(toolName\)[\s\S]*?agentOrigin:\s*"mcp"/,
    );
  });

  it("registerTools requires an `actor` option (no default that drops the binding)", async () => {
    const source = await readFile(TOOLS_FILE, "utf8");
    // Signature: `export function registerTools(server: McpServer, opts: RegisterToolsOptions)`.
    // A future refactor that makes `opts` optional with a default would silently
    // restore the pre-#1858 unbound-dispatch shape on any caller that omits the
    // option. Pin the required-param shape.
    expect(source).toMatch(/registerTools\s*\(\s*server:[^,]+,\s*opts:\s*RegisterToolsOptions\s*\)/);
    expect(source).toMatch(/RegisterToolsOptions\s*\{[\s\S]*?actor:\s*AtlasUser/);
  });
});
