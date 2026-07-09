import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { ConnectionMetadata } from "../db/connection";
import type { DialectHint } from "../plugins/wiring";
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Mutable state for tests ---
let mockDialectHints: readonly DialectHint[] = [];

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
  getDialectHints: () => mockDialectHints,
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

// #3633 — agent.ts assembles the org-knowledge block via this module.
void mock.module("@atlas/api/lib/learn/org-knowledge-section", () => ({
  resolveOrgKnowledgeSection: async () => "",
}));

const { buildSystemParam } = await import("@atlas/api/lib/agent");

function assembledPrompt(): string {
  const result = buildSystemParam("openai");
  return typeof result === "string" ? result : result.content;
}

describe("sargability guidance (shared suffix — covers PostgreSQL)", () => {
  beforeEach(() => {
    resetMockEntries();
    mockDialectHints = [];
  });

  test("assembled prompt contains an explicit Sargability section", () => {
    const content = assembledPrompt();
    expect(content).toContain("Sargability");
  });

  test("teaches preferring indexed columns and not wrapping them in functions in filters", () => {
    const content = assembledPrompt();
    expect(content).toContain("indexed column");
    // The anti-pattern it warns against
    expect(content).toContain("YEAR(created_at) = 2024");
    // The sargable rewrite it prescribes
    expect(content).toContain("created_at >= '2024-01-01' AND created_at < '2025-01-01'");
  });

  test("warns against the spec's explicitly-named anti-patterns (LOWER on a plain index, date_trunc on an indexed timestamp)", () => {
    const content = assembledPrompt();
    // Spec #3629 body: "avoid `LOWER(col) = …` on a plain index"
    expect(content).toContain("LOWER(email) = 'x@y.com'");
    // Spec #3629 criterion: "prefer date ranges over `YEAR()`/`date_trunc` on indexed timestamps"
    expect(content).toContain("date_trunc");
  });

  test("scopes the concern to filter/join predicates, allowing functions for projection/grouping", () => {
    const content = assembledPrompt();
    expect(content).toMatch(/projection and grouping/i);
  });

  test("sargability guidance ships on a PostgreSQL workspace (no inline dialect guide)", () => {
    // default mock entry is postgres; there is no MySQL guide for it
    const content = assembledPrompt();
    expect(content).not.toContain("SQL Dialect: MySQL");
    expect(content).toContain("Sargability");
  });
});

describe("MySQL dialect guide — date functions no longer 'preferred' for filtering", () => {
  beforeEach(() => {
    mockEntries.length = 0;
    mockEntries.push({ id: "default", dbType: "mysql" });
    mockDialectHints = [];
  });

  test("MySQL guide is present", () => {
    expect(assembledPrompt()).toContain("SQL Dialect: MySQL");
  });

  test("does not label YEAR()/DATE_FORMAT() as '(preferred)'", () => {
    const content = assembledPrompt();
    const mysqlSection = content.slice(content.indexOf("SQL Dialect: MySQL"));
    expect(mysqlSection).not.toContain("(preferred)");
  });

  test("teaches the half-open range rewrite for filtering indexed date columns", () => {
    const content = assembledPrompt();
    const mysqlSection = content.slice(content.indexOf("SQL Dialect: MySQL"));
    expect(mysqlSection).toContain("col >= '2024-01-01' AND col < '2025-01-01'");
  });

  test("retains YEAR()/DATE_FORMAT() for projection/grouping", () => {
    const content = assembledPrompt();
    const mysqlSection = content.slice(content.indexOf("SQL Dialect: MySQL"));
    expect(mysqlSection).toContain("DATE_FORMAT");
    expect(mysqlSection).toMatch(/projecting or grouping/i);
  });
});
