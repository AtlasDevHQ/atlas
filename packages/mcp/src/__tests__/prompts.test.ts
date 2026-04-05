import { describe, expect, it, mock, beforeEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ---------------------------------------------------------------------------
// Mock state — configure per test
// ---------------------------------------------------------------------------

let mockHasInternalDB = false;
let mockInternalQueryRows: Record<string, unknown>[] = [];
let mockInternalQueryError: Error | null = null;
let mockScannedEntities: Array<{
  filePath: string;
  sourceName: string;
  raw: Record<string, unknown>;
}> = [];

mock.module("@atlas/api/lib/semantic/files", () => ({
  getSemanticRoot: () => "/tmp/atlas-test-semantic",
}));

mock.module("@atlas/api/lib/semantic/scanner", () => ({
  scanEntities: () => ({ entities: mockScannedEntities, warnings: [] }),
  getEntityDirs: () => ({ dirs: [], rootScanFailed: false }),
  readEntityYaml: () => null,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => {
    if (mockInternalQueryError) throw mockInternalQueryError;
    return mockInternalQueryRows;
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import after mocks
const { registerPrompts } = await import("../prompts.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestClient() {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  await registerPrompts(server);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

function getMessageText(
  messages: Array<{ role: string; content: unknown }>,
): string {
  const first = messages[0];
  if (!first) return "";
  const content = first.content as { type: string; text: string };
  return content.text ?? "";
}

// ---------------------------------------------------------------------------
// Tests — built-in templates
// ---------------------------------------------------------------------------

describe("MCP prompts — built-in templates", () => {
  beforeEach(() => {
    mockScannedEntities = [];
    mockHasInternalDB = false;
    mockInternalQueryRows = [];
    mockInternalQueryError = null;
  });

  it("lists all 5 built-in prompt templates", async () => {
    const { client } = await createTestClient();
    const result = await client.listPrompts();

    expect(result.prompts.length).toBeGreaterThanOrEqual(5);

    const names = result.prompts.map((p) => p.name);
    expect(names).toContain("revenue-trend");
    expect(names).toContain("top-by-metric");
    expect(names).toContain("compare-periods");
    expect(names).toContain("breakdown");
    expect(names).toContain("anomaly-detection");
  });

  it("built-in prompts have descriptions", async () => {
    const { client } = await createTestClient();
    const result = await client.listPrompts();

    for (const prompt of result.prompts) {
      expect(prompt.description).toBeTruthy();
    }
  });

  it("revenue-trend prompt substitutes period argument", async () => {
    const { client } = await createTestClient();
    const result = await client.getPrompt({
      name: "revenue-trend",
      arguments: { period: "6 months" },
    });

    const text = getMessageText(
      result.messages as Array<{ role: string; content: unknown }>,
    );
    expect(text).toContain("6 months");
    expect(text).not.toContain("{period}");
  });

  it("top-by-metric prompt substitutes all three arguments", async () => {
    const { client } = await createTestClient();
    const result = await client.getPrompt({
      name: "top-by-metric",
      arguments: { count: "10", entity: "customers", metric: "revenue" },
    });

    const text = getMessageText(
      result.messages as Array<{ role: string; content: unknown }>,
    );
    expect(text).toContain("10");
    expect(text).toContain("customers");
    expect(text).toContain("revenue");
  });

  it("compare-periods prompt substitutes both periods", async () => {
    const { client } = await createTestClient();
    const result = await client.getPrompt({
      name: "compare-periods",
      arguments: {
        metric: "revenue",
        period1: "Q1 2024",
        period2: "Q2 2024",
      },
    });

    const text = getMessageText(
      result.messages as Array<{ role: string; content: unknown }>,
    );
    expect(text).toContain("Q1 2024");
    expect(text).toContain("Q2 2024");
    expect(text).toContain("revenue");
  });

  it("breakdown prompt returns user role message", async () => {
    const { client } = await createTestClient();
    const result = await client.getPrompt({
      name: "breakdown",
      arguments: { metric: "signups", dimension: "region" },
    });

    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe("user");
    const text = getMessageText(
      result.messages as Array<{ role: string; content: unknown }>,
    );
    expect(text).toContain("signups");
    expect(text).toContain("region");
  });

  it("anomaly-detection prompt substitutes arguments", async () => {
    const { client } = await createTestClient();
    const result = await client.getPrompt({
      name: "anomaly-detection",
      arguments: { metric: "error rate", period: "30 days" },
    });

    const text = getMessageText(
      result.messages as Array<{ role: string; content: unknown }>,
    );
    expect(text).toContain("error rate");
    expect(text).toContain("30 days");
  });
});

// ---------------------------------------------------------------------------
// Tests — semantic layer
// ---------------------------------------------------------------------------

describe("MCP prompts — semantic layer", () => {
  beforeEach(() => {
    mockHasInternalDB = false;
    mockInternalQueryRows = [];
    mockInternalQueryError = null;
    mockScannedEntities = [];
  });

  it("registers prompts from entity query_patterns", async () => {
    mockScannedEntities = [
      {
        filePath: "/tmp/entities/orders.yml",
        sourceName: "default",
        raw: {
          table: "orders",
          description: "Customer orders",
          query_patterns: [
            {
              name: "monthly-revenue",
              description: "Monthly revenue from orders",
              sql: "SELECT date_trunc('month', created_at) AS month, SUM(total) FROM orders GROUP BY 1",
            },
            {
              name: "top-customers",
              description: "Top customers by order count",
            },
          ],
        },
      },
    ];

    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const names = result.prompts.map((p) => p.name);

    expect(names).toContain("entity-orders-monthly-revenue");
    expect(names).toContain("entity-orders-top-customers");
  });

  it("semantic prompt includes SQL pattern in text", async () => {
    mockScannedEntities = [
      {
        filePath: "/tmp/entities/orders.yml",
        sourceName: "default",
        raw: {
          table: "orders",
          query_patterns: [
            {
              name: "daily-count",
              description: "Daily order count",
              sql: "SELECT date_trunc('day', created_at) AS day, COUNT(*) FROM orders GROUP BY 1",
            },
          ],
        },
      },
    ];

    const { client } = await createTestClient();
    const result = await client.getPrompt({
      name: "entity-orders-daily-count",
    });

    const text = getMessageText(
      result.messages as Array<{ role: string; content: unknown }>,
    );
    expect(text).toContain("orders");
    expect(text).toContain("Daily order count");
    expect(text).toContain("SELECT date_trunc");
  });

  it("semantic prompt without SQL still works", async () => {
    mockScannedEntities = [
      {
        filePath: "/tmp/entities/users.yml",
        sourceName: "default",
        raw: {
          table: "users",
          query_patterns: [
            {
              name: "active-users",
              description: "Count active users in a given period",
            },
          ],
        },
      },
    ];

    const { client } = await createTestClient();
    const result = await client.getPrompt({
      name: "entity-users-active-users",
    });

    const text = getMessageText(
      result.messages as Array<{ role: string; content: unknown }>,
    );
    expect(text).toContain("users");
    expect(text).toContain("Count active users");
    expect(text).not.toContain("Reference SQL");
  });

  it("skips entities without query_patterns", async () => {
    mockScannedEntities = [
      {
        filePath: "/tmp/entities/events.yml",
        sourceName: "default",
        raw: {
          table: "events",
          description: "System events",
          dimensions: [{ name: "event_type", type: "string" }],
        },
      },
    ];

    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const entityPrompts = result.prompts
      .map((p) => p.name)
      .filter((n) => n.startsWith("entity-"));
    expect(entityPrompts.length).toBe(0);
  });

  it("skips query_patterns without name or description", async () => {
    mockScannedEntities = [
      {
        filePath: "/tmp/entities/products.yml",
        sourceName: "default",
        raw: {
          table: "products",
          query_patterns: [
            { sql: "SELECT * FROM products LIMIT 10" },
          ],
        },
      },
    ];

    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const entityPrompts = result.prompts
      .map((p) => p.name)
      .filter((n) => n.startsWith("entity-"));
    expect(entityPrompts.length).toBe(0);
  });

  it("semantic prompt description includes table name prefix", async () => {
    mockScannedEntities = [
      {
        filePath: "/tmp/entities/orders.yml",
        sourceName: "default",
        raw: {
          table: "orders",
          query_patterns: [
            { name: "totals", description: "Order totals by month" },
          ],
        },
      },
    ];

    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const orderPrompt = result.prompts.find(
      (p) => p.name === "entity-orders-totals",
    );

    expect(orderPrompt).toBeTruthy();
    expect(orderPrompt!.description).toContain("[orders]");
  });
});

// ---------------------------------------------------------------------------
// Tests — prompt library
// ---------------------------------------------------------------------------

describe("MCP prompts — prompt library", () => {
  beforeEach(() => {
    mockScannedEntities = [];
    mockInternalQueryError = null;
  });

  it("registers prompts from internal DB when available", async () => {
    mockHasInternalDB = true;
    mockInternalQueryRows = [
      {
        id: "abc-123",
        question: "What is our monthly recurring revenue?",
        description: "MRR overview",
        collection_name: "SaaS Metrics",
      },
      {
        id: "def-456",
        question: "Show churn rate by cohort",
        description: null,
        collection_name: "SaaS Metrics",
      },
    ];

    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const names = result.prompts.map((p) => p.name);

    expect(names).toContain("library-abc-123");
    expect(names).toContain("library-def-456");
  });

  it("library prompt returns the question text", async () => {
    mockHasInternalDB = true;
    mockInternalQueryRows = [
      {
        id: "abc-123",
        question: "What is our monthly recurring revenue?",
        description: "MRR overview",
        collection_name: "SaaS Metrics",
      },
    ];

    const { client } = await createTestClient();
    const result = await client.getPrompt({ name: "library-abc-123" });

    const text = getMessageText(
      result.messages as Array<{ role: string; content: unknown }>,
    );
    expect(text).toBe("What is our monthly recurring revenue?");
  });

  it("library prompt description includes collection name", async () => {
    mockHasInternalDB = true;
    mockInternalQueryRows = [
      {
        id: "abc-123",
        question: "What is our MRR?",
        description: "Monthly recurring revenue",
        collection_name: "SaaS Metrics",
      },
    ];

    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const libPrompt = result.prompts.find(
      (p) => p.name === "library-abc-123",
    );

    expect(libPrompt).toBeTruthy();
    expect(libPrompt!.description).toContain("[SaaS Metrics]");
  });

  it("skips library prompts when no internal DB", async () => {
    mockHasInternalDB = false;

    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const libraryPrompts = result.prompts
      .map((p) => p.name)
      .filter((n) => n.startsWith("library-"));
    expect(libraryPrompts.length).toBe(0);
  });

  it("gracefully handles DB query failure", async () => {
    mockHasInternalDB = true;
    mockInternalQueryError = new Error("connection refused");

    const { client } = await createTestClient();
    const result = await client.listPrompts();

    // Should still have built-in templates, just no library prompts
    expect(result.prompts.length).toBeGreaterThanOrEqual(5);
    const libraryPrompts = result.prompts
      .map((p) => p.name)
      .filter((n) => n.startsWith("library-"));
    expect(libraryPrompts.length).toBe(0);
  });
});
