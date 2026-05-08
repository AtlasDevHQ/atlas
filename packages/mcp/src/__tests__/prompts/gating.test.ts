/**
 * Workspace gating for canonical-questions prompts (#2076).
 *
 * The toggle is tri-state (`auto` / `always` / `never`):
 *   - `auto`   — expose iff the workspace looks like a demo workspace
 *                (active `__demo__` connection OR `ATLAS_DEMO_INDUSTRY`
 *                set). This is the default.
 *   - `always` — always expose (admin opted in for a real-data
 *                workspace).
 *   - `never`  — never expose (admin opted out of a demo workspace's
 *                NovaMart prompts).
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";

let mockSettings: Record<string, string | undefined> = {};
let mockHasInternalDB = false;
let mockInternalQueryRows: Array<{ active: boolean }> = [];
let mockInternalQueryError: Error | null = null;

mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string, _orgId?: string) => mockSettings[key],
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => {
    if (mockInternalQueryError) throw mockInternalQueryError;
    return mockInternalQueryRows;
  },
  // Other modules under test mock-load this same module path with a
  // wider surface (registry.test.ts also needs `internalExecute`).
  // Keep the export shape uniform across files so a cross-file run
  // (`bun test src/__tests__/prompts/`) doesn't error with
  // "Export named 'internalExecute' not found".
  internalExecute: () => undefined,
}));

const { shouldExposeCanonicalPrompts } = await import(
  "../../prompts/gating.js"
);

beforeEach(() => {
  mockSettings = {};
  mockHasInternalDB = false;
  mockInternalQueryRows = [];
  mockInternalQueryError = null;
});

describe("shouldExposeCanonicalPrompts", () => {
  it("`always` setting exposes for any workspace (real-data opt-in)", async () => {
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "always";
    const result = await shouldExposeCanonicalPrompts({
      workspaceId: "org_real_data",
    });
    expect(result).toBe(true);
  });

  it("`never` setting hides for any workspace (demo opt-out)", async () => {
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "never";
    mockSettings["ATLAS_DEMO_INDUSTRY"] = "ecommerce";
    const result = await shouldExposeCanonicalPrompts({
      workspaceId: "org_demo",
    });
    expect(result).toBe(false);
  });

  it("`auto` exposes when ATLAS_DEMO_INDUSTRY is set", async () => {
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "auto";
    mockSettings["ATLAS_DEMO_INDUSTRY"] = "ecommerce";
    const result = await shouldExposeCanonicalPrompts({
      workspaceId: "org_with_industry",
    });
    expect(result).toBe(true);
  });

  it("`auto` exposes when org has a published __demo__ connection", async () => {
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "auto";
    mockHasInternalDB = true;
    mockInternalQueryRows = [{ active: true }];
    const result = await shouldExposeCanonicalPrompts({
      workspaceId: "org_with_demo",
    });
    expect(result).toBe(true);
  });

  it("`auto` hides for a real-data workspace (no demo signal)", async () => {
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "auto";
    mockHasInternalDB = true;
    mockInternalQueryRows = [{ active: false }];
    const result = await shouldExposeCanonicalPrompts({
      workspaceId: "org_real_data",
    });
    expect(result).toBe(false);
  });

  it("treats unset toggle the same as `auto`", async () => {
    mockSettings["ATLAS_DEMO_INDUSTRY"] = "ecommerce";
    const result = await shouldExposeCanonicalPrompts({
      workspaceId: "org_demo",
    });
    expect(result).toBe(true);
  });

  it("`auto` with no internal DB and no industry hides prompts", async () => {
    // Stdio MCP boot path with no DATABASE_URL — the only signal we have
    // is `ATLAS_DEMO_INDUSTRY`. Without it we default to off so a fresh
    // self-hosted user doesn't see NovaMart prompts against their own data.
    mockHasInternalDB = false;
    const result = await shouldExposeCanonicalPrompts({
      workspaceId: undefined,
    });
    expect(result).toBe(false);
  });

  it("survives a connections query failure by falling through to industry signal", async () => {
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "auto";
    mockSettings["ATLAS_DEMO_INDUSTRY"] = "ecommerce";
    mockHasInternalDB = true;
    mockInternalQueryError = new Error("connection refused");
    const result = await shouldExposeCanonicalPrompts({
      workspaceId: "org_demo",
    });
    expect(result).toBe(true);
  });

  it("connections query failure with no industry → off (fail closed)", async () => {
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "auto";
    mockHasInternalDB = true;
    mockInternalQueryError = new Error("connection refused");
    const result = await shouldExposeCanonicalPrompts({
      workspaceId: "org_unknown",
    });
    expect(result).toBe(false);
  });
});
