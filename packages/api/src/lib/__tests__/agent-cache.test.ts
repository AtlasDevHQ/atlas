import { describe, expect, test, beforeEach } from "bun:test";
import type { ModelMessage } from "ai";
import type { ConnectionMetadata } from "../db/connection";

// Mock dependencies that agent.ts imports but we don't need for applyCacheControl
import { mock } from "bun:test";

const mockDBConnection = {
  query: async () => ({ columns: [], rows: [] }),
  close: async () => {},
};

// Stateful mock — tests can push entries to simulate different connection states
const mockEntries: ConnectionMetadata[] = [];

function resetMockEntries() {
  mockEntries.length = 0;
  // Default state: single postgres connection (backward compat for existing tests)
  mockEntries.push({ id: "default", dbType: "postgres" });
}

resetMockEntries();

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockDBConnection,
  connections: {
    get: () => mockDBConnection,
    getDefault: () => mockDBConnection,
    getDBType: (id: string) => {
      const entry = mockEntries.find((e) => e.id === id);
      return entry?.dbType ?? ("postgres" as const);
    },
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => mockEntries.map((e) => e.id),
    describe: () =>
      mockEntries.map((e) => ({
        id: e.id,
        dbType: e.dbType,
        description: e.description,
      })),
    _reset: () => {
      mockEntries.length = 0;
    },
  },
  detectDBType: () => "postgres" as const,
  ConnectionRegistry: class {},
}));

// Mutable reference so individual tests can override cross-source join data
let mockCrossSourceJoins: import("../semantic").CrossSourceJoin[] = [];

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["companies"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => mockCrossSourceJoins,
}));

const { applyCacheControl, buildSystemParam } = await import("@atlas/api/lib/agent");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: "user" as const,
    content: `message ${i}`,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyCacheControl", () => {
  // --- Empty array --------------------------------------------------------

  test("returns empty array unchanged", () => {
    const result = applyCacheControl([], "anthropic");
    expect(result).toEqual([]);
  });

  // --- Anthropic ----------------------------------------------------------

  test("adds anthropic cacheControl to last message for 'anthropic'", () => {
    const msgs = makeMessages(3);
    const result = applyCacheControl(msgs, "anthropic");

    // First two messages unchanged
    expect(result[0]).not.toHaveProperty("providerOptions");
    expect(result[1]).not.toHaveProperty("providerOptions");

    // Last message has anthropic cache marker
    expect(result[2].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  // --- Bedrock-Anthropic --------------------------------------------------

  test("adds anthropic cacheControl to last message for 'bedrock-anthropic'", () => {
    const msgs = makeMessages(2);
    const result = applyCacheControl(msgs, "bedrock-anthropic");

    expect(result[0]).not.toHaveProperty("providerOptions");
    expect(result[1].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  // --- Bedrock (non-Anthropic) --------------------------------------------

  test("adds bedrock cachePoint to last message for 'bedrock'", () => {
    const msgs = makeMessages(2);
    const result = applyCacheControl(msgs, "bedrock");

    expect(result[0]).not.toHaveProperty("providerOptions");
    expect(result[1].providerOptions).toEqual({
      bedrock: { cachePoint: { type: "default" } },
    });
  });

  // --- No-op providers ----------------------------------------------------

  test("returns messages unchanged for 'openai'", () => {
    const msgs = makeMessages(3);
    const result = applyCacheControl(msgs, "openai");
    expect(result).toEqual(msgs);
  });

  test("returns messages unchanged for 'ollama'", () => {
    const msgs = makeMessages(3);
    const result = applyCacheControl(msgs, "ollama");
    expect(result).toEqual(msgs);
  });

  test("returns messages unchanged for 'gateway'", () => {
    const msgs = makeMessages(3);
    const result = applyCacheControl(msgs, "gateway");
    expect(result).toEqual(msgs);
  });

  // --- Single message -----------------------------------------------------

  test("works correctly with a single-message array", () => {
    const msgs = makeMessages(1);
    const result = applyCacheControl(msgs, "anthropic");

    expect(result).toHaveLength(1);
    expect(result[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  // --- Preserves existing providerOptions ---------------------------------

  test("preserves existing providerOptions on the last message", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "user",
        content: "world",
        providerOptions: {
          myProvider: { someOption: true },
        },
      },
    ];

    const result = applyCacheControl(msgs, "anthropic");

    expect(result[1].providerOptions).toEqual({
      myProvider: { someOption: true },
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  test("preserves existing providerOptions for bedrock provider", () => {
    const msgs: ModelMessage[] = [
      {
        role: "user",
        content: "test",
        providerOptions: {
          custom: { flag: "value" },
        },
      },
    ];

    const result = applyCacheControl(msgs, "bedrock");

    expect(result[0].providerOptions).toEqual({
      custom: { flag: "value" },
      bedrock: { cachePoint: { type: "default" } },
    });
  });

  // --- Immutability ---------------------------------------------------------

  test("does not mutate the original messages array", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "user", content: "world" },
    ];
    const original = JSON.parse(JSON.stringify(msgs));

    applyCacheControl(msgs, "anthropic");

    expect(msgs).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// buildSystemParam
// ---------------------------------------------------------------------------

describe("buildSystemParam", () => {
  beforeEach(() => {
    resetMockEntries();
  });

  test("returns SystemModelMessage with anthropic cacheControl for 'anthropic'", () => {
    const result = buildSystemParam("anthropic");
    expect(typeof result).toBe("object");
    const msg = result as { role: string; content: string; providerOptions: Record<string, unknown> };
    expect(msg.role).toBe("system");
    expect(typeof msg.content).toBe("string");
    expect(msg.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  test("returns SystemModelMessage with anthropic cacheControl for 'bedrock-anthropic'", () => {
    const result = buildSystemParam("bedrock-anthropic");
    expect(typeof result).toBe("object");
    const msg = result as { role: string; content: string; providerOptions: Record<string, unknown> };
    expect(msg.role).toBe("system");
    expect(typeof msg.content).toBe("string");
    expect(msg.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  test("returns SystemModelMessage with bedrock cachePoint for 'bedrock'", () => {
    const result = buildSystemParam("bedrock");
    expect(typeof result).toBe("object");
    const msg = result as { role: string; content: string; providerOptions: Record<string, unknown> };
    expect(msg.role).toBe("system");
    expect(typeof msg.content).toBe("string");
    expect(msg.providerOptions).toEqual({
      bedrock: { cachePoint: { type: "default" } },
    });
  });

  test("returns plain string for 'openai'", () => {
    const result = buildSystemParam("openai");
    expect(typeof result).toBe("string");
  });

  test("returns plain string for 'ollama'", () => {
    const result = buildSystemParam("ollama");
    expect(typeof result).toBe("string");
  });

  test("returns plain string for 'gateway'", () => {
    const result = buildSystemParam("gateway");
    expect(typeof result).toBe("string");
  });

  test("buildSystemParam with custom registry uses custom tool descriptions", async () => {
    const { ToolRegistry } = await import("@atlas/api/lib/tools/registry");
    const customRegistry = new ToolRegistry();
    customRegistry.register({
      name: "customTool",
      description: "### Custom Step\nDo custom things.",
      tool: { execute: async () => "ok" } as never,
    });

    const result = buildSystemParam("openai", customRegistry);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Custom Step");
    expect(result as string).not.toContain("Explore the Semantic Layer");
  });
});

// ---------------------------------------------------------------------------
// buildSystemParam — multi-source
// ---------------------------------------------------------------------------

describe("buildSystemParam — multi-source", () => {
  beforeEach(() => {
    mockEntries.length = 0;
    mockCrossSourceJoins = [];
  });

  test("single connection: no 'Available Data Sources' section", () => {
    mockEntries.push({ id: "default", dbType: "postgres" });

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).not.toContain("Available Data Sources");
    expect(content).toContain("Atlas");
  });

  test("no connections registered: no multi-source section", () => {
    // mockEntries is empty — list() returns []
    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).not.toContain("Available Data Sources");
    expect(content).toContain("Atlas");
  });

  test("multiple connections: includes multi-source section with IDs", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres", description: "Main database" },
      { id: "warehouse", dbType: "postgres", description: "Analytics warehouse" },
    );

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("Available Data Sources");
    expect(content).toContain("**default** (PostgreSQL) — Main database");
    expect(content).toContain("**warehouse** (PostgreSQL) — Analytics warehouse");
    expect(content).toContain("2 database connections");
    expect(content).toContain("connectionId");
  });

  test("mixed Postgres+MySQL: includes MySQL dialect guide", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres" },
      { id: "legacy", dbType: "mysql", description: "Legacy MySQL" },
    );

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("Available Data Sources");
    expect(content).toContain("SQL Dialect: MySQL");
    expect(content).toContain("**legacy** (MySQL) — Legacy MySQL");
  });

  test("all-Postgres multi-connection: no MySQL guide, still has multi-source section", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres" },
      { id: "secondary", dbType: "postgres" },
    );

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("Available Data Sources");
    expect(content).not.toContain("SQL Dialect: MySQL");
  });

  test("connection without description omits the dash suffix", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres" },
      { id: "bare", dbType: "postgres" },
    );

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("**bare** (PostgreSQL)");
    expect(content).not.toContain("**bare** (PostgreSQL) —");
  });

  test("single MySQL connection: includes MySQL dialect guide (backward compat)", () => {
    mockEntries.push({ id: "default", dbType: "mysql" });

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).not.toContain("Available Data Sources");
    expect(content).toContain("SQL Dialect: MySQL");
  });

  test("multi-source with cross-source joins: includes Cross-Source Relationships section", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres" },
      { id: "warehouse", dbType: "postgres" },
    );
    mockCrossSourceJoins = [
      {
        fromSource: "default",
        fromTable: "users",
        toSource: "warehouse",
        toTable: "events",
        on: "users.id = events.user_id",
        relationship: "one_to_many",
        description: "User activity events",
      },
    ];

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("Cross-Source Relationships");
    expect(content).toContain("**default.users**");
    expect(content).toContain("**warehouse.events**");
    expect(content).toContain("User activity events");
    expect(content).toContain("one_to_many");
    expect(content).toContain("users.id = events.user_id");
  });

  test("multi-source without cross-source joins: no Cross-Source Relationships section", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres" },
      { id: "warehouse", dbType: "postgres" },
    );
    mockCrossSourceJoins = [];

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("Available Data Sources");
    expect(content).not.toContain("Cross-Source Relationships");
  });

  test("cross-source join without description omits description text", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres" },
      { id: "warehouse", dbType: "postgres" },
    );
    mockCrossSourceJoins = [
      {
        fromSource: "default",
        fromTable: "users",
        toSource: "warehouse",
        toTable: "events",
        on: "users.id = events.user_id",
        relationship: "one_to_many",
        // no description
      },
    ];

    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("Cross-Source Relationships");
    // Without description, the format is: (relationship, on: ...)
    expect(content).toContain("(one_to_many, on: users.id = events.user_id)");
    // Should NOT have description text before the parenthesized section
    expect(content).toContain("**warehouse.events**: (one_to_many");
  });
});
