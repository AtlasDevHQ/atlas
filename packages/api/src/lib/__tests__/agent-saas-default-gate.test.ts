/**
 * #2505 — The agent's tool context must not list the runtime-registered
 * `default` connection on SaaS, where `default` sources from the shared
 * `ATLAS_DATASOURCE_URL` demo (NovaMart). Self-hosted single-tenant
 * deployments keep `default` because it IS their operator connection.
 *
 * The resolver-layer pair (`isConnectionVisibleInMode("default", …)`)
 * is covered in `db-isconnectionvisible-default-saas.test.ts` — split out
 * because that test cannot share this file's `connection.ts` module mock.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { ConnectionMetadata } from "../db/connection";
import { createConnectionMock } from "@atlas/api/testing/connection";

let mockConfigOverride: { deployMode?: "saas" | "self-hosted" } | null = null;
const mockEntries: ConnectionMetadata[] = [];

function resetEntries() {
  mockEntries.length = 0;
  mockEntries.push({ id: "default", dbType: "postgres", description: "Shared demo" });
  mockEntries.push({ id: "warehouse", dbType: "postgres", description: "User warehouse" });
  mockEntries.push({ id: "sales", dbType: "mysql", description: "Sales DB" });
}
resetEntries();

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfigOverride,
  defineConfig: (c: unknown) => c,
}));

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      list: () => mockEntries.map((e) => e.id),
      describe: () =>
        mockEntries.map((e) => ({
          id: e.id,
          dbType: e.dbType,
          description: e.description,
        })),
    },
  }),
);

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

mock.module("@atlas/api/lib/plugins/tools", () => ({
  getContextFragments: () => [],
  getDialectHints: () => [],
  setContextFragments: () => {},
  setDialectHints: () => {},
  setPluginTools: () => {},
  getPluginTools: () => undefined,
}));

mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => "",
  getRelevantPatterns: async () => [],
  invalidatePatternCache: () => {},
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
}));

const { buildSystemParam } = await import("@atlas/api/lib/agent");

describe("#2505 agent system prompt — default connection visibility by deployMode", () => {
  beforeEach(() => {
    mockConfigOverride = null;
    resetEntries();
  });

  test("SaaS multi-source: 'default' is filtered, the rest of the list remains", () => {
    mockConfigOverride = { deployMode: "saas" };
    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    // `default` line was the leak — must not appear in the multi-source section
    expect(content).not.toContain("- **default**");
    expect(content).toContain("- **warehouse**");
    expect(content).toContain("- **sales**");
  });

  test("SaaS with only 'default' registered: prompt drops the multi-source section entirely", () => {
    mockConfigOverride = { deployMode: "saas" };
    mockEntries.length = 0;
    mockEntries.push({ id: "default", dbType: "postgres", description: "Shared demo" });
    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    // Filtering reduces to zero sources — the multi-source heading must not appear
    expect(content).not.toContain("## Available Data Sources");
    expect(content).not.toContain("- **default**");
  });

  test("self-hosted (explicit): 'default' remains visible to the agent", () => {
    mockConfigOverride = { deployMode: "self-hosted" };
    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("- **default**");
    expect(content).toContain("- **warehouse**");
    expect(content).toContain("- **sales**");
  });

  test("self-hosted (null config — test default): 'default' remains visible", () => {
    mockConfigOverride = null;
    const result = buildSystemParam("openai");
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("- **default**");
  });
});
