/**
 * #1858 meta-guardrail — MCP analogue of `agent-surface-registry.test.ts`.
 *
 * The class of bug F-54 / F-55 / #1858 closed was "agent runs without a
 * user bound — approval gate silently disabled." The unit tests in
 * `tools.test.ts` pin the *current* two tools (`explore`, `executeSQL`),
 * but a third tool added later — or a refactor that drops the
 * `withRequestContext` wrap on one of the existing two — would silently
 * regress with no behavioral test catching it for the new tool.
 *
 * This file is the structural answer: parse `tools.ts` and assert every
 * `server.registerTool(...)` block contains a `withRequestContext(` call
 * inside it. Mirrors the `agent-surface-registry.test.ts` shape on the
 * api side.
 *
 * Adding a new tool means wrapping it in `withRequestContext` like the
 * other two. Forgetting fails the suite with a pointer to this file.
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const TOOLS_FILE = resolve(import.meta.dir, "..", "tools.ts");

describe("MCP tool binding registry", () => {
  it("every server.registerTool block wraps its dispatch in withRequestContext", async () => {
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
      const block = registrations[i];
      // Look only at the body up to the next `server.registerTool(` (or
      // end of file). Each block extends until the next registration or
      // the closing of `registerTools`.
      const closingIdx = block.search(/^\s*\}\s*$/m); // first top-level `}`
      const body = closingIdx >= 0 ? block.slice(0, closingIdx) : block;

      expect(
        body.includes("withRequestContext("),
        `MCP tool registration #${i + 1} is missing a withRequestContext({ user, requestId }) wrap. ` +
          `Adding a tool? Mirror the explore / executeSQL handlers in tools.ts. ` +
          `See #1858 / F-54 / F-55: an unwrapped dispatch silently bypasses approval rules.`,
      ).toBe(true);
    }
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
