import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { ConnectionMetadata } from "../db/connection";
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Mutable state for tests ---
const mockEntries: ConnectionMetadata[] = [];

function resetMockEntries() {
  mockEntries.length = 0;
  mockEntries.push({ id: "default", dbType: "postgres" });
}

resetMockEntries();

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      list: () => mockEntries.map((e) => e.id),
      describe: () =>
        mockEntries.map((e) => ({
          id: e.id,
          dbType: e.dbType,
          description: e.description,
        })),
      _reset: () => { mockEntries.length = 0; },
    },
  }),
);

void mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["companies"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

void mock.module("@atlas/api/lib/plugins/tools", () => ({
  getContextFragments: () => [],
  getDialectHints: () => [],
  pluginDialectModules: () => [],
  setContextFragments: () => {},
  setDialectHints: () => {},
  setPluginTools: () => {},
  getPluginTools: () => undefined,
}));

void mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => "",
  getRelevantPatterns: async () => [],
  buildRetrievalQuery: () => "",
  getRetrievalTurns: () => 3,
  invalidatePatternCache: () => {},
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
}));

void mock.module("@atlas/api/lib/learn/org-knowledge-section", () => ({
  resolveOrgKnowledgeSection: async () => "",
}));

const { buildSystemParam } = await import("@atlas/api/lib/agent");

function assemble(dialectSpecialists?: string): string {
  const result = buildSystemParam("openai", { dialectSpecialists });
  return typeof result === "string" ? result : result.content;
}

// #4515 — the dialect-specialist section is composed by runAgent and threaded
// into buildSystemParam as the `dialectSpecialists` string (the sibling of the
// answer-style / persona seams). buildSystemParam no longer resolves dialect
// from the connection registry or plugin hints itself — it appends exactly what
// it is handed. The composition + registry logic is exercised in
// dialect-specialist.test.ts.
describe("buildSystemParam — dialectSpecialists seam", () => {
  beforeEach(() => {
    resetMockEntries();
  });

  test("omitted: no dialect section is appended", () => {
    const content = assemble(undefined);
    expect(content).not.toContain("## SQL Dialect:");
  });

  test("empty string: no dialect section is appended", () => {
    const content = assemble("");
    expect(content).not.toContain("## SQL Dialect:");
  });

  test("provided: the composed section is appended verbatim", () => {
    const section = "## SQL Dialect: ClickHouse\nUse toStartOfMonth().";
    const content = assemble(section);
    expect(content).toContain(section);
  });

  test("provided under a MySQL workspace: the passed section drives the dialect text", () => {
    mockEntries.length = 0;
    mockEntries.push({ id: "default", dbType: "mysql" });
    const section = "## SQL Dialect: MySQL\nUse DATE_FORMAT(...).";
    const content = assemble(section);
    expect(content).toContain("## SQL Dialect: MySQL");
    expect(content).toContain("Use DATE_FORMAT(...).");
  });

  test("multi-connection: section appended after the Available Data Sources listing", () => {
    mockEntries.length = 0;
    mockEntries.push(
      { id: "default", dbType: "postgres" },
      { id: "legacy", dbType: "mysql", description: "Legacy MySQL" },
    );
    const section = "## SQL Dialect: MySQL — group `legacy`\nUse DATE_FORMAT(...).";
    const content = assemble(section);
    expect(content).toContain("## Available Data Sources");
    const sourcesIdx = content.indexOf("## Available Data Sources");
    const dialectIdx = content.indexOf("## SQL Dialect: MySQL");
    expect(dialectIdx).toBeGreaterThan(sourcesIdx);
  });
});
