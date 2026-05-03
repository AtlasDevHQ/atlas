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

mock.module("@atlas/api/lib/config", () => ({
  initializeConfig: async () => ({ deployMode: "self-hosted" }),
  getConfig: () => ({ deployMode: "self-hosted" }),
}));

const { registerTools } = await import("../tools.js");
const { _resetMcpTelemetryForTest } = await import("../telemetry.js");

async function createTestClient(transport: "stdio" | "sse" = "stdio") {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerTools(server, { actor: TEST_ACTOR, transport });

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

  it("records tool.success=true on success result, =false on tool error", async () => {
    const { client } = await createTestClient();
    await client.callTool({ name: "explore", arguments: { command: "ls" } });

    mockExploreExecute.mockResolvedValueOnce("Error (exit 1):\nbroken");
    await client.callTool({ name: "explore", arguments: { command: "boom" } });

    const successSpan = spanCalls[0]!;
    expect(successSpan.resultAttrs?.["tool.success"]).toBe(true);
    const errorSpan = spanCalls[1]!;
    expect(errorSpan.resultAttrs?.["tool.success"]).toBe(false);
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
    for (const obs of observations) {
      expect(obs.value).toBeGreaterThanOrEqual(0);
      expect(obs.attributes["tool.name"]).toMatch(/explore|executeSQL/);
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
