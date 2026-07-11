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
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
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
      describe: () => mockEntries.map((e) => ({ ...e })),
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

const { runAgent } = await import("@atlas/api/lib/agent");

function userMessages(text: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text }] }];
}

async function runTurn(): Promise<string> {
  lastSystemPrompt = undefined;
  const result = await runAgent({
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
