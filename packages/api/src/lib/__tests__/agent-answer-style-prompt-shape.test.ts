/**
 * #4299 — mock-LLM prompt-shape test for the answer-style default (PRD #4292).
 *
 * The registry tests in agent-answer-style.test.ts pin `buildSystemParam`
 * directly; this file pins the seam ABOVE it: a `runAgent` turn with no
 * `answerStyle` builds a system prompt carrying the analyst addendum (the
 * web default — the chat route passes nothing), and an explicit
 * `"conversational"` turn carries the chat-platform addendum instead (the
 * no-Slack-regression half). Asserted against the prompt the mock LLM
 * actually receives, on the acceptance criterion's simple-question case.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { createConnectionMock } from "@atlas/api/testing/connection";

// ---------------------------------------------------------------------------
// Module mocks — deterministic single-connection workspace, no internal DB.
// runAgent runs with NO request context here, so every org-scoped loader
// (REST datasources, routing context, learned patterns) short-circuits.
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      describe: () => [{ id: "default", dbType: "postgres" as const }],
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
  getWhitelistedTables: () => new Set(["orders"]),
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
  buildRetrievalQuery: () => "",
  getRetrievalTurns: () => 3,
  invalidatePatternCache: () => {},
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
}));

// #3633 — agent.ts assembles the org-knowledge block via this module.
mock.module("@atlas/api/lib/learn/org-knowledge-section", () => ({
  resolveOrgKnowledgeSection: async () => "",
}));

// ---------------------------------------------------------------------------
// Spying mock model — captures the system prompt each turn renders.
// ---------------------------------------------------------------------------

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
    { type: "text-delta", id: "text-0", delta: "The EU region grew the most, up 14%." },
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
  return [
    {
      id: "msg-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text }],
    },
  ];
}

async function runTurn(answerStyle?: "conversational"): Promise<string> {
  lastSystemPrompt = undefined;
  const result = await runAgent({
    // The acceptance criterion's simple-question case (#4299).
    messages: userMessages("Which region grew the most last quarter?"),
    aiModel: {
      model: makeSpyingModel(),
      providerType: "openai",
      modelId: "mock-answer-style-model",
    },
    ...(answerStyle ? { answerStyle } : {}),
  });
  await result.text; // drain the stream so doStream ran
  expect(lastSystemPrompt).toBeDefined();
  return lastSystemPrompt ?? "";
}

describe("runAgent — answer-style default threading (#4299)", () => {
  it("a turn with no answerStyle renders the analyst addendum (web default)", async () => {
    const prompt = await runTurn();
    expect(prompt).toContain("## Answer style — analyst");
    expect(prompt).toContain("Lead with the result");
    expect(prompt).toContain("Never use emoji");
    expect(prompt).not.toContain("## Presentation mode — conversational");
  });

  it("an explicit conversational turn renders the #2705 addendum instead (chat-platform default)", async () => {
    const prompt = await runTurn("conversational");
    expect(prompt).toContain("## Presentation mode — conversational");
    expect(prompt).toContain("Do NOT include SQL");
    expect(prompt).not.toContain("## Answer style — analyst");
  });

  it("the <suggestions> contract reaches the model in both styles", async () => {
    const analystPrompt = await runTurn();
    const conversationalPrompt = await runTurn("conversational");
    expect(analystPrompt).toContain("<suggestions>");
    expect(conversationalPrompt).toContain("<suggestions>");
  });
});
