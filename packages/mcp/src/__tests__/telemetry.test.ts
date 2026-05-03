/**
 * OTel coverage for MCP tool dispatch (#2029).
 *
 * Mirrors the #1979 / PR #2011 capture pattern: mock `@atlas/api/lib/tracing`
 * to record span name + attributes, mock `@atlas/api/lib/metrics` to record
 * counter / histogram observations. No in-memory exporter — keeps the test
 * boundary at the helper module, not the OTel SDK.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";

const TEST_ACTOR = createAtlasUser("u_telem", "managed", "telem@test", {
  role: "admin",
  activeOrganizationId: "org_telem",
});

// --- Span / metric capture buffers ----------------------------------------
const spanCalls: { name: string; attributes: Record<string, unknown>; resultAttrs?: Record<string, unknown>; error?: string }[] = [];
const counterCalls: { metric: string; value: number; attributes: Record<string, unknown> }[] = [];
const histogramCalls: { metric: string; value: number; attributes: Record<string, unknown> }[] = [];

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (
    name: string,
    attributes: Record<string, unknown>,
    fn: () => Promise<unknown>,
    setResultAttributes?: (result: unknown) => Record<string, unknown>,
  ) => {
    const entry: (typeof spanCalls)[number] = { name, attributes };
    spanCalls.push(entry);
    try {
      const result = await fn();
      if (setResultAttributes) {
        try {
          entry.resultAttrs = setResultAttributes(result);
        } catch {
          // intentionally ignored: mirror real withSpan — callback errors don't
          // fail the wrapped fn.
        }
      }
      return result;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  },
  withEffectSpan: <A>(_name: string, _attributes: Record<string, unknown>, e: A): A => e,
}));

mock.module("@atlas/api/lib/metrics", () => ({
  abuseEscalations: { add: () => {} },
  mcpToolCalls: {
    add: (value: number, attributes: Record<string, unknown>) => {
      counterCalls.push({ metric: "atlas.mcp.tool.calls", value, attributes });
    },
  },
  mcpToolLatency: {
    record: (value: number, attributes: Record<string, unknown>) => {
      histogramCalls.push({ metric: "atlas.mcp.tool.latency", value, attributes });
    },
  },
  mcpActivations: {
    add: (value: number, attributes: Record<string, unknown>) => {
      counterCalls.push({ metric: "atlas.mcp.activations", value, attributes });
    },
  },
}));

// --- Mocks for AI SDK tool execute functions ------------------------------
const mockExploreExecute = mock<(...args: unknown[]) => Promise<unknown>>(
  async () => "catalog.yml",
);
const mockExecuteSQLExecute = mock<(...args: unknown[]) => Promise<unknown>>(
  async () => ({
    success: true,
    explanation: "noop",
    row_count: 0,
    columns: [],
    rows: [],
    truncated: false,
  }),
);

mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: { description: "explore", execute: mockExploreExecute },
}));
mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: { description: "executeSQL", execute: mockExecuteSQLExecute },
}));

// `runMetric` resolves the metric definition through these helpers.
mock.module("@atlas/api/lib/semantic/lookups", () => ({
  listEntities: () => [],
  getEntityByName: () => null,
  searchGlossary: () => [],
  findMetricById: (id: string) =>
    id === "orders_count"
      ? {
          id: "orders_count",
          label: "Total orders",
          description: "Distinct order count.",
          sql: "SELECT 1",
          type: "atomic",
          aggregation: "count_distinct",
          unit: null,
          source: "default",
          binding: null,
        }
      : null,
  loadGlossaryTerms: () => [],
  loadMetricDefinitions: () => [],
}));

// Don't mock @atlas/api/lib/config — its 31 exports would require a full
// pass-through to avoid partial-mock leakage (CLAUDE.md "Mock all exports").
// The unmocked module's `getConfig()` returns null when `initializeConfig`
// hasn't run; `tools.ts` null-coalesces to `"self-hosted"`, which is the
// value we want in tests anyway.

const { registerTools } = await import("../tools.js");
const { _resetMcpTelemetryForTest } = await import("../telemetry.js");

async function createTestClient(
  transport: "stdio" | "sse" = "stdio",
  actor = TEST_ACTOR,
) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerTools(server, { actor, transport });

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

describe("MCP OTel coverage (#2029)", () => {
  beforeEach(() => {
    spanCalls.length = 0;
    counterCalls.length = 0;
    histogramCalls.length = 0;
    mockExploreExecute.mockClear();
    mockExecuteSQLExecute.mockClear();
    _resetMcpTelemetryForTest();
  });

  it("emits atlas.mcp.tool.run span on every tool dispatch", async () => {
    const { client } = await createTestClient();
    await client.callTool({ name: "explore", arguments: { command: "ls" } });
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "probe" },
    });

    const runs = spanCalls.filter((s) => s.name === "atlas.mcp.tool.run");
    expect(runs.length).toBe(2);
    const tools = runs.map((r) => r.attributes["tool.name"]).sort();
    expect(tools).toEqual(["executeSQL", "explore"]);
  });

  it("tags spans with workspace.id, transport, and deploy.mode", async () => {
    const { client } = await createTestClient("sse");
    await client.callTool({ name: "explore", arguments: { command: "ls" } });

    const span = spanCalls.find((s) => s.name === "atlas.mcp.tool.run");
    expect(span).toBeDefined();
    expect(span!.attributes["workspace.id"]).toBe("org_telem");
    expect(span!.attributes["transport"]).toBe("sse");
    expect(span!.attributes["deploy.mode"]).toBe("self-hosted");
  });

  it("records tool.success=true on success result, =false + tool.error_code on tool error", async () => {
    const { client } = await createTestClient();
    await client.callTool({ name: "explore", arguments: { command: "ls" } });

    mockExploreExecute.mockResolvedValueOnce("Error (exit 1):\nbroken");
    await client.callTool({ name: "explore", arguments: { command: "boom" } });

    const successSpan = spanCalls[0]!;
    expect(successSpan.resultAttrs?.["tool.success"]).toBe(true);
    expect(successSpan.resultAttrs?.["tool.error_code"]).toBeUndefined();
    const errorSpan = spanCalls[1]!;
    expect(errorSpan.resultAttrs?.["tool.success"]).toBe(false);
    expect(errorSpan.resultAttrs?.["tool.error_code"]).toBe("tool_error");
  });

  it("records executeSQL { success: false } as outcome=error with tool.error_code", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "RLS denied",
    });

    const { client } = await createTestClient();
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT * FROM forbidden", explanation: "probe" },
    });

    const span = spanCalls.find(
      (s) => s.attributes["tool.name"] === "executeSQL",
    );
    expect(span?.resultAttrs?.["tool.success"]).toBe(false);
    expect(span?.resultAttrs?.["tool.error_code"]).toBe("tool_error");

    const counter = counterCalls.find(
      (c) =>
        c.metric === "atlas.mcp.tool.calls" &&
        c.attributes["tool.name"] === "executeSQL",
    );
    expect(counter?.attributes.outcome).toBe("error");
  });

  it("increments atlas.mcp.tool.calls counter with tool.name + outcome", async () => {
    const { client } = await createTestClient();
    await client.callTool({ name: "explore", arguments: { command: "ls" } });

    mockExploreExecute.mockResolvedValueOnce("Error (exit 1):\nbroken");
    await client.callTool({ name: "explore", arguments: { command: "boom" } });

    const counterAdds = counterCalls.filter(
      (c) => c.metric === "atlas.mcp.tool.calls",
    );
    expect(counterAdds.length).toBe(2);
    const successCount = counterAdds.find(
      (c) => c.attributes.outcome === "success",
    );
    const errorCount = counterAdds.find(
      (c) => c.attributes.outcome === "error",
    );
    expect(successCount?.attributes["tool.name"]).toBe("explore");
    expect(errorCount?.attributes["tool.name"]).toBe("explore");
    expect(successCount?.value).toBe(1);
    expect(errorCount?.value).toBe(1);
  });

  it("records atlas.mcp.tool.latency histogram per dispatch", async () => {
    const { client } = await createTestClient();
    await client.callTool({ name: "explore", arguments: { command: "ls" } });
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "probe" },
    });

    const observations = histogramCalls.filter(
      (h) => h.metric === "atlas.mcp.tool.latency",
    );
    expect(observations.length).toBe(2);

    // Pin the cross-series joinability the metrics.ts comment promises:
    // every histogram observation has a matching counter increment with
    // the same tool.name + outcome. A regression that records latency
    // but skips the counter (or vice versa) would split the dashboards.
    const counterAdds = counterCalls.filter(
      (c) => c.metric === "atlas.mcp.tool.calls",
    );
    expect(counterAdds.length).toBe(2);
    for (const obs of observations) {
      expect(Number.isFinite(obs.value)).toBe(true);
      expect(obs.value).toBeGreaterThan(0);
      expect(obs.attributes["tool.name"]).toMatch(/explore|executeSQL/);
      const matching = counterAdds.find(
        (c) =>
          c.attributes["tool.name"] === obs.attributes["tool.name"] &&
          c.attributes.outcome === obs.attributes.outcome,
      );
      expect(matching).toBeDefined();
    }
  });

  it("emits atlas.mcp.activations exactly once per workspace per process", async () => {
    const { client } = await createTestClient();
    await client.callTool({ name: "explore", arguments: { command: "ls" } });
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "probe" },
    });
    await client.callTool({ name: "explore", arguments: { command: "ls" } });

    const activations = counterCalls.filter(
      (c) => c.metric === "atlas.mcp.activations",
    );
    expect(activations.length).toBe(1);
    expect(activations[0]!.value).toBe(1);
    expect(activations[0]!.attributes["workspace.id"]).toBe("org_telem");
    expect(activations[0]!.attributes["transport"]).toBe("stdio");
  });

  it("emits a separate activation for each distinct workspace", async () => {
    // Pins the Set-keyed dedup contract: a regression that hard-codes a
    // single boolean (`hasFiredActivation`) would pass the single-workspace
    // test but fail this one.
    const actorA = createAtlasUser("u_a", "managed", "a@test", {
      role: "admin",
      activeOrganizationId: "org_a",
    });
    const actorB = createAtlasUser("u_b", "managed", "b@test", {
      role: "admin",
      activeOrganizationId: "org_b",
    });

    const { client: clientA } = await createTestClient("stdio", actorA);
    await clientA.callTool({ name: "explore", arguments: { command: "ls" } });

    const { client: clientB } = await createTestClient("stdio", actorB);
    await clientB.callTool({ name: "explore", arguments: { command: "ls" } });

    const activations = counterCalls.filter(
      (c) => c.metric === "atlas.mcp.activations",
    );
    const ids = activations
      .map((a) => a.attributes["workspace.id"])
      .sort();
    expect(ids).toEqual(["org_a", "org_b"]);
  });

  it("runMetric span carries metric.id attribute", async () => {
    const { client } = await createTestClient();
    await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    const span = spanCalls.find((s) => s.attributes["tool.name"] === "runMetric");
    expect(span).toBeDefined();
    expect(span!.attributes["metric.id"]).toBe("orders_count");
  });

  it("runMetric records outcome=error when the metric id is not found", async () => {
    // The "metric not found" branch short-circuits before invoking
    // executeSQL, so the entire instrumentation path runs through the
    // runMetric-specific span attribute rather than the executeSQL one.
    const { client } = await createTestClient();
    await client.callTool({
      name: "runMetric",
      arguments: { id: "ghost" },
    });

    const span = spanCalls.find(
      (s) => s.attributes["tool.name"] === "runMetric",
    );
    expect(span).toBeDefined();
    expect(span!.attributes["metric.id"]).toBe("ghost");
    expect(span!.resultAttrs?.["tool.success"]).toBe(false);

    const counter = counterCalls.find(
      (c) =>
        c.metric === "atlas.mcp.tool.calls" &&
        c.attributes["tool.name"] === "runMetric",
    );
    expect(counter?.attributes.outcome).toBe("error");
  });

  it("re-throws underlying tool error after recording outcome=error", async () => {
    mockExploreExecute.mockRejectedValueOnce(new Error("sandbox crashed"));

    const { client } = await createTestClient();
    // The MCP tool handler catches errors internally and returns isError —
    // so from the client's perspective this returns a CallToolResult.
    const result = await client.callTool({
      name: "explore",
      arguments: { command: "boom" },
    });
    expect(result.isError).toBe(true);

    const counterAdds = counterCalls.filter(
      (c) => c.metric === "atlas.mcp.tool.calls",
    );
    expect(counterAdds.length).toBe(1);
    expect(counterAdds[0]!.attributes.outcome).toBe("error");
  });

  it("covers all six tools (explore + executeSQL + 4 typed semantic tools)", async () => {
    const { client } = await createTestClient();
    await client.callTool({ name: "explore", arguments: { command: "ls" } });
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "probe" },
    });
    await client.callTool({ name: "listEntities", arguments: {} });
    await client.callTool({
      name: "describeEntity",
      arguments: { name: "users" },
    });
    await client.callTool({
      name: "searchGlossary",
      arguments: { term: "revenue" },
    });
    await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    const toolNames = spanCalls
      .filter((s) => s.name === "atlas.mcp.tool.run")
      .map((s) => s.attributes["tool.name"])
      .sort();
    expect(toolNames).toEqual([
      "describeEntity",
      "executeSQL",
      "explore",
      "listEntities",
      "runMetric",
      "searchGlossary",
    ]);
  });
});
