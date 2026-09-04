/**
 * #4515 — mock-LLM seam test for dialect-specialist prompt placement.
 *
 * The registry + composition logic is unit-tested in dialect-specialist.test.ts;
 * this file pins the SEAM ABOVE it: a full `runAgent` turn composes the dialect
 * specialist(s) for the connections in scope and lands them in the system prompt
 * the LLM actually receives — one module per engine, attributed per group under a
 * cross-group sweep, plugin modules winning over core. Mirrors the mock-LLM shape
 * of agent-expert-persona-prompt.test.ts.
 *
 * runAgent runs with NO request context here, so `orgId` is undefined and the
 * resolver takes its connection-based fallback: each agent-visible connection
 * stands as its own group-of-one (group id = connection id). That exercises the
 * single-source, multi-source-attribution, and plugin-precedence paths without a
 * DB.
 *
 * ---------------------------------------------------------------------------
 * Also hosts the two `buildSystemParam`-level siblings that share this exact
 * mock floor (formerly agent-dialect.test.ts and agent-sargability.test.ts):
 * the `dialectSpecialists` string seam below runAgent, and the shared
 * Sargability guidance suffix (spec #3629).
 */

import { describe, expect, it, test, beforeEach, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { createConnectionMock } from "@atlas/api/testing/connection";
import type { PluginDialectModule } from "@atlas/api/lib/dialect-specialist";

// --- Mutable fixtures the mocks read ---
let mockEntries: { id: string; dbType: string; description?: string }[] = [
  { id: "default", dbType: "postgres" },
];
let mockPluginModules: PluginDialectModule[] = [];

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      list: () => mockEntries.map((e) => e.id),
      describe: () => mockEntries.map((e) => ({ ...e })),
      _reset: () => { mockEntries = []; },
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
  getWhitelistedTables: () => new Set(["orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

void mock.module("@atlas/api/lib/plugins/tools", () => ({
  getContextFragments: () => [],
  getDialectHints: () => [],
  pluginDialectModules: () => mockPluginModules,
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

let lastSystemPrompt: string | undefined;

function extractSystemPrompt(opts: unknown): string | undefined {
  const prompt = (opts as { prompt?: ReadonlyArray<{ role: string; content: unknown }> })?.prompt;
  const systemMsg = Array.isArray(prompt) ? prompt.find((p) => p.role === "system") : undefined;
  if (!systemMsg) return undefined;
  const content = systemMsg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c as { text?: string })?.text ?? "").join("");
  }
  return "";
}

function makeSpyingModel(): InstanceType<typeof MockLanguageModelV3> {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "text-delta", id: "text-0", delta: "ok" },
    {
      type: "finish",
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      finishReason: { unified: "stop", raw: "end_turn" },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async (opts: unknown) => {
      const content = extractSystemPrompt(opts);
      if (content) lastSystemPrompt = content;
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

const { runAgent, buildSystemParam } = await import("@atlas/api/lib/agent");
// #4943 — runAgent's `tools` is now required; this is its own fail-closed
// default, so these turns are unchanged. See agent.ts's `@param tools`.
const { nonDashboardRegistry } = await import("@atlas/api/lib/tools/registry");

function userMessages(text: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text }] }];
}

async function runTurn(): Promise<string> {
  lastSystemPrompt = undefined;
  const result = await runAgent({
    tools: nonDashboardRegistry,
    messages: userMessages("How many orders last month?"),
    aiModel: {
      model: makeSpyingModel(),
      providerType: "openai",
      modelId: "mock-dialect-seam-model",
    },
  });
  await result.text;
  expect(lastSystemPrompt).toBeDefined();
  return lastSystemPrompt ?? "";
}

describe("runAgent — dialect-specialist prompt placement (#4515)", () => {
  beforeEach(() => {
    mockEntries = [{ id: "default", dbType: "postgres" }];
    mockPluginModules = [];
  });

  it("single Postgres connection: composes the Postgres module (no group attribution)", async () => {
    const prompt = await runTurn();
    expect(prompt).toContain("## SQL Dialect: PostgreSQL");
    expect(prompt).not.toContain("— group");
  });

  it("single MySQL connection: composes the MySQL module", async () => {
    mockEntries = [{ id: "default", dbType: "mysql" }];
    const prompt = await runTurn();
    expect(prompt).toContain("## SQL Dialect: MySQL");
    // The MySQL module's sargability-aware content rides through the seam.
    expect(prompt).toContain("col >= '2024-01-01' AND col < '2025-01-01'");
  });

  it("unknown engine composes cleanly — no dialect section", async () => {
    mockEntries = [{ id: "default", dbType: "sparksql" }];
    const prompt = await runTurn();
    expect(prompt).not.toContain("## SQL Dialect:");
  });

  it("cross-source: composes several modules, each attributed to its group", async () => {
    mockEntries = [
      { id: "default", dbType: "postgres" },
      { id: "legacy", dbType: "mysql", description: "Legacy MySQL" },
    ];
    const prompt = await runTurn();
    expect(prompt).toContain("## SQL Dialect: PostgreSQL — group `default`");
    expect(prompt).toContain("## SQL Dialect: MySQL — group `legacy`");
    // The specialist section sits after the Available Data Sources listing.
    expect(prompt.indexOf("## SQL Dialect:")).toBeGreaterThan(
      prompt.indexOf("## Available Data Sources"),
    );
  });

  it("a plugin module composes for its engine and wins over the core module", async () => {
    mockEntries = [{ id: "ch", dbType: "clickhouse" }];
    mockPluginModules = [
      { dbType: "clickhouse", module: "PLUGIN clickhouse guidance — arrayFlatten()." },
    ];
    const prompt = await runTurn();
    expect(prompt).toContain("## SQL Dialect: ClickHouse");
    expect(prompt).toContain("PLUGIN clickhouse guidance — arrayFlatten().");
    // The core ClickHouse module's signature line is superseded by the plugin's.
    expect(prompt).not.toContain("toStartOfMonth");
  });
});

// ---------------------------------------------------------------------------
// buildSystemParam — the string seam below runAgent (formerly agent-dialect.test.ts)
// ---------------------------------------------------------------------------

function assemble(dialectSpecialists?: string): string {
  const result = buildSystemParam("openai", { ...(dialectSpecialists !== undefined ? { dialectSpecialists } : {})});
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
    mockEntries = [{ id: "default", dbType: "postgres" }];
    mockPluginModules = [];
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

// ---------------------------------------------------------------------------
// Sargability guidance — shared prompt suffix (formerly agent-sargability.test.ts)
// ---------------------------------------------------------------------------

function assembledPrompt(): string {
  const result = buildSystemParam("openai");
  return typeof result === "string" ? result : result.content;
}

describe("sargability guidance (shared suffix — covers PostgreSQL)", () => {
  beforeEach(() => {
    mockEntries = [{ id: "default", dbType: "postgres" }];
    mockPluginModules = [];
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
    // default mock entry is postgres; buildSystemParam no longer auto-appends a
    // dialect guide (#4515 — the composed dialect-specialist section is threaded
    // in by runAgent). The MySQL module's sargability-aware content is asserted
    // in dialect-specialist.test.ts.
    const content = assembledPrompt();
    expect(content).not.toContain("SQL Dialect: MySQL");
    expect(content).toContain("Sargability");
  });
});
