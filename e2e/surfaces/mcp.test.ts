/**
 * E2E: MCP server tests.
 *
 * Tests the Atlas MCP server over stdio transport using the MCP SDK client.
 * Spawns `packages/mcp/bin/serve.ts` as a subprocess, connects via
 * StdioClientTransport, and validates tools, resources, and SQL execution
 * against a real Postgres database (E2E docker-compose on port 5433).
 *
 * Requires: `docker compose -f e2e/docker-compose.yml up -d --wait`
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
const SERVE_SCRIPT = path.join(PROJECT_ROOT, "packages/mcp/bin/serve.ts");
const SEMANTIC_ROOT = path.join(PROJECT_ROOT, "semantic");
const PG_URL = "postgresql://atlas:atlas@localhost:5433/atlas_e2e";

// Timeout for MCP operations (server startup + tool calls)
const MCP_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Shared client
// ---------------------------------------------------------------------------

let client: Client;
let transport: StdioClientTransport;

/** Assert the MCP client initialized successfully. Throws a clear error if beforeAll failed. */
function requireClient(): Client {
  if (!client) {
    throw new Error(
      "MCP client is not initialized — beforeAll likely failed. " +
      "Check that docker compose is running (port 5433) and bun is available.",
    );
  }
  return client;
}

/** Extract text from an MCP tool result, failing loudly if the response shape is unexpected. */
function extractToolText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(
      `Expected non-empty content array, got: ${JSON.stringify(content)}`,
    );
  }
  const first = content[0];
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error(
      `Expected text content block, got: ${JSON.stringify(first)}`,
    );
  }
  return first.text;
}

/** Parse JSON from tool text, including the raw response in any error message. */
function parseToolJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Expected JSON response from executeSQL but got: ${text.slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", SERVE_SCRIPT],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env as Record<string, string>,
      ATLAS_DATASOURCE_URL: PG_URL,
      ATLAS_AUTH_MODE: "none",
      // Disable table whitelist — E2E DB has test_orders, not the full semantic layer
      ATLAS_TABLE_WHITELIST: "false",
      // Suppress pino logs from stdout — MCP stdio transport uses stdout for JSON-RPC
      ATLAS_LOG_LEVEL: "fatal",
    },
    stderr: "pipe",
  });

  client = new Client(
    { name: "atlas-e2e-test", version: "1.0.0" },
  );

  await client.connect(transport);
}, MCP_TIMEOUT);

afterAll(async () => {
  try {
    await client?.close();
  } catch (err) {
    console.warn("[mcp.test.ts] Failed to close MCP client:", err);
  }
  try {
    await transport?.close();
  } catch (err) {
    console.warn("[mcp.test.ts] Failed to close transport:", err);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: MCP server — tool listing", () => {
  it("lists at least explore and executeSQL tools", async () => {
    const c = requireClient();
    const result = await c.listTools();
    const toolNames = result.tools.map((t) => t.name);

    expect(toolNames).toContain("explore");
    expect(toolNames).toContain("executeSQL");
    expect(result.tools.length).toBeGreaterThanOrEqual(2);
  });

  it("explore tool has correct input schema", async () => {
    const c = requireClient();
    const result = await c.listTools();
    const exploreTool = result.tools.find((t) => t.name === "explore");

    expect(exploreTool).toBeDefined();
    expect(exploreTool!.inputSchema.type).toBe("object");
    expect(exploreTool!.inputSchema.properties).toHaveProperty("command");
  });

  it("executeSQL tool has correct input schema", async () => {
    const c = requireClient();
    const result = await c.listTools();
    const sqlTool = result.tools.find((t) => t.name === "executeSQL");

    expect(sqlTool).toBeDefined();
    expect(sqlTool!.inputSchema.type).toBe("object");
    expect(sqlTool!.inputSchema.properties).toHaveProperty("sql");
    expect(sqlTool!.inputSchema.properties).toHaveProperty("explanation");
  });
});

describe("E2E: MCP server — explore tool", () => {
  it("lists semantic layer files via explore", async () => {
    const c = requireClient();
    const result = await c.callTool({
      name: "explore",
      arguments: { command: "ls" },
    });

    expect(result.isError).not.toBe(true);
    const text = extractToolText(result);
    expect(text).toContain("catalog.yml");
    expect(text).toContain("entities");
  });

  it("reads catalog.yml via explore", async () => {
    const c = requireClient();
    const result = await c.callTool({
      name: "explore",
      arguments: { command: "cat catalog.yml" },
    });

    expect(result.isError).not.toBe(true);
    const text = extractToolText(result);
    // Verify non-empty content was returned
    expect(text.length).toBeGreaterThan(0);
  });

  it("rejects path traversal attempts", async () => {
    const c = requireClient();
    const result = await c.callTool({
      name: "explore",
      arguments: { command: "cat ../../etc/passwd" },
    });

    // Path traversal MUST be treated as an error
    expect(result.isError).toBe(true);

    // Ensure the response does not contain /etc/passwd content
    const text = extractToolText(result);
    expect(text).not.toContain("root:");
    expect(text).not.toContain("/bin/bash");
  });
});

describe("E2E: MCP server — executeSQL", () => {
  it("executes SELECT count(*) against real database", async () => {
    const c = requireClient();
    const result = await c.callTool({
      name: "executeSQL",
      arguments: {
        sql: "SELECT count(*) FROM test_orders",
        explanation: "Count all test orders",
      },
    });

    expect(result.isError).not.toBe(true);
    const text = extractToolText(result);
    const parsed = parseToolJson(text);

    expect(parsed.columns).toBeDefined();
    expect(parsed.rows).toBeDefined();
    expect(parsed.row_count).toBeGreaterThanOrEqual(1);
    // The seed has 5 rows
    expect((parsed.rows as Record<string, unknown>[])[0]).toHaveProperty("count");
    expect(Number((parsed.rows as Record<string, unknown>[])[0].count)).toBe(5);
  });

  it("executes SELECT with WHERE clause", async () => {
    const c = requireClient();
    const result = await c.callTool({
      name: "executeSQL",
      arguments: {
        sql: "SELECT customer_name, amount FROM test_orders WHERE status = 'completed' ORDER BY amount DESC",
        explanation: "Get completed orders sorted by amount",
      },
    });

    expect(result.isError).not.toBe(true);
    const text = extractToolText(result);
    const parsed = parseToolJson(text);

    expect(parsed.columns).toContain("customer_name");
    expect(parsed.columns).toContain("amount");
    expect((parsed.rows as unknown[]).length).toBe(3); // Alice, Bob, Diana are completed
  });

  it("rejects DROP TABLE (SQL validation)", async () => {
    const c = requireClient();
    const result = await c.callTool({
      name: "executeSQL",
      arguments: {
        sql: "DROP TABLE test_orders",
        explanation: "Attempting destructive operation",
      },
    });

    expect(result.isError).toBe(true);
    const text = extractToolText(result);
    // Verify this was blocked by SQL validation, not a random failure
    expect(text).toMatch(/forbidden|only select|not allowed/i);
  });

  it("rejects INSERT statement", async () => {
    const c = requireClient();
    const result = await c.callTool({
      name: "executeSQL",
      arguments: {
        sql: "INSERT INTO test_orders (customer_name, amount, status) VALUES ('Hacker', 0, 'evil')",
        explanation: "Attempting write operation",
      },
    });

    expect(result.isError).toBe(true);
    const text = extractToolText(result);
    expect(text).toMatch(/forbidden|only select|not allowed/i);
  });

  it("rejects UPDATE statement", async () => {
    const c = requireClient();
    const result = await c.callTool({
      name: "executeSQL",
      arguments: {
        sql: "UPDATE test_orders SET status = 'hacked' WHERE id = 1",
        explanation: "Attempting update operation",
      },
    });

    expect(result.isError).toBe(true);
    const text = extractToolText(result);
    expect(text).toMatch(/forbidden|only select|not allowed/i);
  });

  it("rejects DELETE statement", async () => {
    const c = requireClient();
    const result = await c.callTool({
      name: "executeSQL",
      arguments: {
        sql: "DELETE FROM test_orders",
        explanation: "Attempting delete operation",
      },
    });

    expect(result.isError).toBe(true);
    const text = extractToolText(result);
    expect(text).toMatch(/forbidden|only select|not allowed/i);
  });

  it("rejects multi-statement queries", async () => {
    const c = requireClient();
    const result = await c.callTool({
      name: "executeSQL",
      arguments: {
        sql: "SELECT 1; DROP TABLE test_orders",
        explanation: "Attempting statement chaining",
      },
    });

    expect(result.isError).toBe(true);
    const text = extractToolText(result);
    expect(text).toMatch(/multiple statements|forbidden|not allowed/i);
  });
});

describe("E2E: MCP server — resource listing", () => {
  it("lists resources including catalog and glossary", async () => {
    const c = requireClient();
    const result = await c.listResources();
    const uris = result.resources.map((r) => r.uri);

    expect(uris).toContain("atlas://semantic/catalog");
    expect(uris).toContain("atlas://semantic/glossary");
  });

  it("lists entity resources matching semantic/entities/ directory", async () => {
    const c = requireClient();
    const result = await c.listResources();
    const entityUris = result.resources
      .map((r) => r.uri)
      .filter((u) => u.startsWith("atlas://semantic/entities/"));

    // Should have at least the demo entities
    expect(entityUris.length).toBeGreaterThanOrEqual(1);

    // Verify entity names match files on disk
    const entityFiles = fs.readdirSync(path.join(SEMANTIC_ROOT, "entities"))
      .filter((f) => f.endsWith(".yml"))
      .map((f) => `atlas://semantic/entities/${f.replace(/\.yml$/, "")}`);

    for (const uri of entityUris) {
      expect(entityFiles).toContain(uri);
    }
  });

  it("lists resource templates for entities and metrics", async () => {
    const c = requireClient();
    const result = await c.listResourceTemplates();
    const templateUris = result.resourceTemplates.map((t) => t.uriTemplate);

    expect(templateUris).toContain("atlas://semantic/entities/{name}");
    expect(templateUris).toContain("atlas://semantic/metrics/{name}");
  });
});

describe("E2E: MCP server — resource reading", () => {
  it("reads catalog.yml and matches disk content", async () => {
    const c = requireClient();
    const result = await c.readResource({
      uri: "atlas://semantic/catalog",
    });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.mimeType).toBe("text/yaml");
    expect("text" in content).toBe(true);

    // Compare with actual file on disk
    const diskContent = fs.readFileSync(
      path.join(SEMANTIC_ROOT, "catalog.yml"),
      "utf-8",
    );
    expect((content as { text: string }).text).toBe(diskContent);
  });

  it("reads glossary.yml and matches disk content", async () => {
    const c = requireClient();
    const result = await c.readResource({
      uri: "atlas://semantic/glossary",
    });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect("text" in content).toBe(true);

    const diskContent = fs.readFileSync(
      path.join(SEMANTIC_ROOT, "glossary.yml"),
      "utf-8",
    );
    expect((content as { text: string }).text).toBe(diskContent);
  });

  it("reads entity YAML and matches disk content", async () => {
    const c = requireClient();
    // Pick the first available entity
    const entityFiles = fs.readdirSync(path.join(SEMANTIC_ROOT, "entities"))
      .filter((f) => f.endsWith(".yml"));
    expect(entityFiles.length).toBeGreaterThanOrEqual(1);

    const entityName = entityFiles[0].replace(/\.yml$/, "");
    const result = await c.readResource({
      uri: `atlas://semantic/entities/${entityName}`,
    });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.mimeType).toBe("text/yaml");
    expect("text" in content).toBe(true);

    const diskContent = fs.readFileSync(
      path.join(SEMANTIC_ROOT, "entities", `${entityName}.yml`),
      "utf-8",
    );
    expect((content as { text: string }).text).toBe(diskContent);
  });

  it("reads metric YAML and matches disk content", async () => {
    const c = requireClient();
    const metricsDir = path.join(SEMANTIC_ROOT, "metrics");
    if (!fs.existsSync(metricsDir)) return; // skip if no metrics directory
    const metricFiles = fs.readdirSync(metricsDir).filter((f) => f.endsWith(".yml"));
    if (metricFiles.length === 0) return; // skip if no metric files

    const metricName = metricFiles[0].replace(/\.yml$/, "");
    const result = await c.readResource({
      uri: `atlas://semantic/metrics/${metricName}`,
    });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.mimeType).toBe("text/yaml");
    expect("text" in content).toBe(true);

    const diskContent = fs.readFileSync(
      path.join(metricsDir, `${metricName}.yml`),
      "utf-8",
    );
    expect((content as { text: string }).text).toBe(diskContent);
  });

  it("returns not-found message for nonexistent entity", async () => {
    const c = requireClient();
    const result = await c.readResource({
      uri: "atlas://semantic/entities/nonexistent_table_xyz",
    });

    expect(result.contents).toHaveLength(1);
    const text = (result.contents[0] as { text: string }).text;
    expect(text).toContain("not found");
  });
});
