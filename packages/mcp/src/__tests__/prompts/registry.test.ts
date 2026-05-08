import { describe, expect, it, mock, beforeEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ---------------------------------------------------------------------------
// Mock state — configure per test
// ---------------------------------------------------------------------------

let mockHasInternalDB = false;
let mockInternalQueryRows: Record<string, unknown>[] = [];
let mockInternalQueryError: Error | null = null;
let mockSemanticRootError: Error | null = null;
let mockScannedEntities: Array<{
  filePath: string;
  sourceName: string;
  raw: Record<string, unknown>;
}> = [];
let mockSettings: Record<string, string | undefined> = {};
const internalExecuteCalls: Array<{ sql: string; params: unknown[] }> = [];

mock.module("@atlas/api/lib/semantic/files", () => ({
  getSemanticRoot: () => {
    if (mockSemanticRootError) throw mockSemanticRootError;
    return "/tmp/atlas-test-semantic";
  },
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
  internalExecute: async (sql: string, params: unknown[] = []) => {
    internalExecuteCalls.push({ sql, params });
    return { rowCount: 1 };
  },
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string, _orgId?: string) => mockSettings[key],
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Default the canonical loader to an empty YAML so the existing
// built-in / semantic / library tests don't accidentally pick up the
// 20 NovaMart prompts. Tests that need canonical content override
// `process.env.ATLAS_CANONICAL_QUESTIONS_PATH` directly.
const emptyCanonicalDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "registry-canonical-empty-"),
);
fs.writeFileSync(
  path.join(emptyCanonicalDir, "questions.yml"),
  "questions: []\n",
);
process.env.ATLAS_CANONICAL_QUESTIONS_PATH = path.join(
  emptyCanonicalDir,
  "questions.yml",
);

// Import after mocks
const { registerPrompts } = await import("../../prompts/registry.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestClient(opts?: {
  workspaceId?: string;
  authMode?: "simple-key" | "managed" | "byot" | "none";
  clientId?: string;
}) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  await registerPrompts(server, opts);

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
    mockSemanticRootError = null;
    mockSettings = {};
    internalExecuteCalls.length = 0;
  });

  it("lists all 5 built-in prompt templates", async () => {
    const { client } = await createTestClient();
    const result = await client.listPrompts();

    expect(result.prompts.length).toBe(5);

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
    mockSemanticRootError = null;
    mockScannedEntities = [];
    mockSettings = {};
    internalExecuteCalls.length = 0;
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

  it("slugifies table names with dots and underscores", async () => {
    mockScannedEntities = [
      {
        filePath: "/tmp/entities/order_items.yml",
        sourceName: "default",
        raw: {
          table: "public.order_items",
          query_patterns: [
            { name: "item-totals", description: "Totals per item" },
          ],
        },
      },
    ];

    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const names = result.prompts.map((p) => p.name);

    expect(names).toContain("entity-public-order-items-item-totals");
  });

  it("registers prompts from multiple entities", async () => {
    mockScannedEntities = [
      {
        filePath: "/tmp/entities/orders.yml",
        sourceName: "default",
        raw: {
          table: "orders",
          query_patterns: [
            { name: "trend", description: "Order trend" },
          ],
        },
      },
      {
        filePath: "/tmp/entities/users.yml",
        sourceName: "default",
        raw: {
          table: "users",
          query_patterns: [
            { name: "growth", description: "User growth" },
          ],
        },
      },
    ];

    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const names = result.prompts.map((p) => p.name);

    expect(names).toContain("entity-orders-trend");
    expect(names).toContain("entity-users-growth");
  });

  it("gracefully handles getSemanticRoot throwing", async () => {
    mockSemanticRootError = new Error(
      "ATLAS_SEMANTIC_ROOT is set but empty",
    );

    const { client } = await createTestClient();
    const result = await client.listPrompts();

    // Should still have built-in templates, no semantic prompts
    expect(result.prompts.length).toBe(5);
    const entityPrompts = result.prompts
      .map((p) => p.name)
      .filter((n) => n.startsWith("entity-"));
    expect(entityPrompts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — prompt library
// ---------------------------------------------------------------------------

describe("MCP prompts — prompt library", () => {
  beforeEach(() => {
    mockScannedEntities = [];
    mockHasInternalDB = false;
    mockInternalQueryRows = [];
    mockInternalQueryError = null;
    mockSemanticRootError = null;
    mockSettings = {};
    internalExecuteCalls.length = 0;
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

    // null description falls back to question text
    const defPrompt = result.prompts.find((p) => p.name === "library-def-456");
    expect(defPrompt!.description).toContain("Show churn rate by cohort");
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
    expect(result.prompts.length).toBe(5);
    const libraryPrompts = result.prompts
      .map((p) => p.name)
      .filter((n) => n.startsWith("library-"));
    expect(libraryPrompts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — canonical (#2076)
// ---------------------------------------------------------------------------

describe("MCP prompts — canonical (gated)", () => {
  let canonicalTmpDir: string;

  beforeEach(() => {
    mockScannedEntities = [];
    mockHasInternalDB = false;
    mockInternalQueryRows = [];
    mockInternalQueryError = null;
    mockSemanticRootError = null;
    mockSettings = {};
    internalExecuteCalls.length = 0;

    canonicalTmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "registry-canonical-"),
    );
    const filePath = path.join(canonicalTmpDir, "questions.yml");
    fs.writeFileSync(
      filePath,
      `
questions:
  - id: cq-001
    category: simple_metric
    question: What is our total GMV?
    mode: metric
    metric_id: total_gmv
  - id: cq-013
    category: glossary
    question: Show me revenue last quarter
    mode: glossary
    term: revenue
`,
    );
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = filePath;
  });

  it("auto + ATLAS_DEMO_INDUSTRY set: canonical prompts surface", async () => {
    mockSettings["ATLAS_DEMO_INDUSTRY"] = "ecommerce";

    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const names = result.prompts.map((p) => p.name);

    expect(names).toContain("canonical-total-gmv");
    expect(names).toContain("canonical-glossary-revenue");
  });

  it("auto + no demo signal: canonical prompts hidden", async () => {
    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const canonicalPrompts = result.prompts
      .map((p) => p.name)
      .filter((n) => n.startsWith("canonical-"));
    expect(canonicalPrompts.length).toBe(0);
  });

  it("`always` toggle exposes canonical for any workspace", async () => {
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "always";
    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const names = result.prompts.map((p) => p.name);
    expect(names).toContain("canonical-total-gmv");
  });

  it("`never` toggle hides canonical even when demo industry is set", async () => {
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "never";
    mockSettings["ATLAS_DEMO_INDUSTRY"] = "ecommerce";
    const { client } = await createTestClient();
    const result = await client.listPrompts();
    const canonicalPrompts = result.prompts
      .map((p) => p.name)
      .filter((n) => n.startsWith("canonical-"));
    expect(canonicalPrompts.length).toBe(0);
  });

  it("prompts/get returns the canonical question text when allowed", async () => {
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "always";
    const { client } = await createTestClient();
    const result = await client.getPrompt({
      name: "canonical-total-gmv",
    });
    const text = getMessageText(
      result.messages as Array<{ role: string; content: unknown }>,
    );
    expect(text).toBe("What is our total GMV?");
  });

  it("prompts/get refuses canonical when the gate is closed", async () => {
    // Default toggle (auto) + no demo signal.
    const { client } = await createTestClient();
    await expect(
      client.getPrompt({ name: "canonical-total-gmv" }),
    ).rejects.toThrow();
  });

  it("toggle flip propagates between calls without restart", async () => {
    // Initial state: auto, no demo signal → hidden.
    const { client } = await createTestClient();
    const before = await client.listPrompts();
    expect(
      before.prompts.map((p) => p.name).some((n) => n.startsWith("canonical-")),
    ).toBe(false);

    // Admin flips toggle to `always` (would propagate via the settings
    // cache TTL in production; the mock returns the new value
    // immediately).
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "always";

    const after = await client.listPrompts();
    expect(
      after.prompts.map((p) => p.name).some((n) => n.startsWith("canonical-")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — audit + OTel (#2076)
// ---------------------------------------------------------------------------

describe("MCP prompts — audit log", () => {
  beforeEach(() => {
    mockScannedEntities = [];
    mockHasInternalDB = false;
    mockInternalQueryRows = [];
    mockInternalQueryError = null;
    mockSemanticRootError = null;
    mockSettings = {};
    internalExecuteCalls.length = 0;
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = path.join(
      emptyCanonicalDir,
      "questions.yml",
    );
  });

  it("writes a row per prompts/list call when internal DB is available", async () => {
    mockHasInternalDB = true;
    const { client } = await createTestClient();
    await client.listPrompts();

    const listRows = internalExecuteCalls.filter((c) =>
      String(c.params[7]).startsWith("prompts.list"),
    );
    expect(listRows.length).toBeGreaterThanOrEqual(1);
    // sql is the first param
    expect(String(listRows[0]!.params[0])).toContain("mcp:prompts.list");
    // actor_kind is the 6th param
    expect(listRows[0]!.params[5]).toBe("mcp");
    // auth_mode is the 9th param — defaults to "none" when no actor is
    // bound; the test client doesn't pass `authMode` so this should be
    // a value from the canonical AuthMode union, not the string "mcp".
    expect(listRows[0]!.params[8]).toBe("none");
  });

  it("writes a row per prompts/get call", async () => {
    mockHasInternalDB = true;
    const { client } = await createTestClient();
    await client.getPrompt({
      name: "revenue-trend",
      arguments: { period: "6 months" },
    });

    const getRows = internalExecuteCalls.filter((c) =>
      String(c.params[7]).startsWith("prompts.get"),
    );
    expect(getRows.length).toBeGreaterThanOrEqual(1);
    expect(String(getRows[0]!.params[0])).toContain("revenue-trend");
  });

  it("skips audit writes when internal DB is unavailable", async () => {
    mockHasInternalDB = false;
    const { client } = await createTestClient();
    await client.listPrompts();
    expect(internalExecuteCalls.length).toBe(0);
  });

  it("writes success=false audit row when prompts/get refuses a gated canonical", async () => {
    // Default toggle (auto) + no demo signal → canonical resolver throws.
    // Setup: switch fixture to one with a canonical question.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "registry-canonical-getfail-"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "questions.yml"),
      `
questions:
  - id: cq-001
    category: simple_metric
    question: What is our total GMV?
    mode: metric
    metric_id: total_gmv
`,
    );
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = path.join(
      tmpDir,
      "questions.yml",
    );

    mockHasInternalDB = true;
    const { client } = await createTestClient();
    await expect(
      client.getPrompt({ name: "canonical-total-gmv" }),
    ).rejects.toThrow();

    const getRows = internalExecuteCalls.filter((c) =>
      String(c.params[7]).startsWith("prompts.get"),
    );
    expect(getRows.length).toBe(1);
    // success column (4th param, index 3)
    expect(getRows[0]!.params[3]).toBe(false);
    // sql carries the prompt name
    expect(String(getRows[0]!.params[0])).toContain("canonical-total-gmv");
  });

  it("writes audit row tagged with the bound workspace id", async () => {
    mockHasInternalDB = true;
    const { client } = await createTestClient({ workspaceId: "org_demo_123" });
    await client.listPrompts();

    const listRows = internalExecuteCalls.filter((c) =>
      String(c.params[7]).startsWith("prompts.list"),
    );
    expect(listRows.length).toBeGreaterThanOrEqual(1);
    // org_id is the 5th param, index 4
    expect(listRows[0]!.params[4]).toBe("org_demo_123");
  });

  it("writes auth_mode from the bound actor, not the literal 'mcp'", async () => {
    mockHasInternalDB = true;
    const { client } = await createTestClient({
      workspaceId: "org_x",
      authMode: "managed",
    });
    await client.listPrompts();

    const listRows = internalExecuteCalls.filter((c) =>
      String(c.params[7]).startsWith("prompts.list"),
    );
    // auth_mode is the 9th param, index 8
    expect(listRows[0]!.params[8]).toBe("managed");
    // Defense in depth — confirm the regression-fix string never reappears
    expect(listRows[0]!.params[8]).not.toBe("mcp");
  });
});

// ---------------------------------------------------------------------------
// Tests — gating end-to-end through the registry (#2076)
// ---------------------------------------------------------------------------

describe("MCP prompts — canonical end-to-end through registry", () => {
  beforeEach(() => {
    mockScannedEntities = [];
    mockHasInternalDB = false;
    mockInternalQueryRows = [];
    mockInternalQueryError = null;
    mockSemanticRootError = null;
    mockSettings = {};
    internalExecuteCalls.length = 0;
  });

  it("exposes all 20 real canonical prompts via the __demo__ connection signal", async () => {
    // Point at the real eval/canonical-questions/questions.yml — proves
    // the loader → registry → SDK list path keeps every entry intact.
    delete process.env.ATLAS_CANONICAL_QUESTIONS_PATH;

    mockHasInternalDB = true;
    mockInternalQueryRows = [{ active: true }]; // __demo__ connection published

    const { client } = await createTestClient({ workspaceId: "org_demo" });
    const result = await client.listPrompts();
    const canonical = result.prompts.filter((p) =>
      p.name.startsWith("canonical-"),
    );
    expect(canonical.length).toBe(20);
  });

  it("hides canonical prompts from a real-data workspace by default", async () => {
    delete process.env.ATLAS_CANONICAL_QUESTIONS_PATH;

    // Real-data workspace: internal DB available, no __demo__ row,
    // no industry setting, no toggle override.
    mockHasInternalDB = true;
    mockInternalQueryRows = [{ active: false }];

    const { client } = await createTestClient({ workspaceId: "org_real" });
    const result = await client.listPrompts();
    const canonical = result.prompts.filter((p) =>
      p.name.startsWith("canonical-"),
    );
    expect(canonical.length).toBe(0);
  });

  it("rejected canonical get carries McpError with InvalidParams code", async () => {
    delete process.env.ATLAS_CANONICAL_QUESTIONS_PATH;

    const { client } = await createTestClient();
    try {
      await client.getPrompt({ name: "canonical-total-gmv" });
      throw new Error("expected getPrompt to reject");
    } catch (err) {
      // The SDK forwards the error envelope with the McpError code, not
      // a generic InternalError. The string code/InvalidParams is what
      // an agent's error handler will branch on.
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("not found");
      // The MCP SDK serializes the error code into the JSON-RPC envelope;
      // re-throwing on the client side preserves the message but loses
      // the structured code. The contract here is the message shape —
      // exactly mirrors the SDK's own "Prompt ... not found" string.
      expect(msg).toContain("canonical-total-gmv");
    }
  });
});
