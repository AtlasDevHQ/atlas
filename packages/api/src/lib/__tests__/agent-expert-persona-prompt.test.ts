/**
 * #4508 — mock-LLM prompt-shape test for the expert persona ("expert is a
 * mode", PRD #4502).
 *
 * The persona unit test (semantic/expert/__tests__/persona.test.ts) pins the
 * role-section string; this file pins the SEAM ABOVE it: a `runAgent` turn with
 * a `persona` builds a system prompt whose ROLE section is the expert persona
 * (in the role position, ahead of the tool guidance) and NOT the analyst
 * prefix — and, crucially, the persona is never smuggled under `## Warnings`.
 * A turn with no persona still gets the analyst prefix, so every other surface
 * is unchanged. Asserted against the prompt the mock LLM actually receives,
 * mirroring agent-answer-style-prompt-shape.test.ts.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { createConnectionMock } from "@atlas/api/testing/connection";
import { EXPERT_PERSONA_PROMPT } from "@atlas/api/lib/semantic/expert/persona";

// ---------------------------------------------------------------------------
// Module mocks — deterministic single-connection workspace, no internal DB.
// runAgent runs with NO request context here, so every org-scoped loader
// (REST datasources, routing context, learned patterns) short-circuits.
// ---------------------------------------------------------------------------

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      describe: () => [{ id: "default", dbType: "postgres" as const }],
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
    { type: "text-delta", id: "text-0", delta: "Profiled orders; proposing a measure." },
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

async function runTurn(persona?: string, briefing?: string): Promise<string> {
  lastSystemPrompt = undefined;
  const result = await runAgent({
    messages: userMessages("Improve the orders entity."),
    aiModel: {
      model: makeSpyingModel(),
      providerType: "openai",
      modelId: "mock-expert-persona-model",
    },
    ...(persona ? { persona } : {}),
    ...(briefing ? { briefing } : {}),
  });
  await result.text; // drain the stream so doStream ran
  expect(lastSystemPrompt).toBeDefined();
  return lastSystemPrompt ?? "";
}

/** The system prompt's `## Warnings` section, or "" when there is none. */
function warningsSection(prompt: string): string {
  const idx = prompt.indexOf("## Warnings");
  return idx === -1 ? "" : prompt.slice(idx);
}

describe("runAgent — expert persona threading (#4508)", () => {
  it("a turn with a persona renders it as the ROLE section (ahead of the tool guidance)", async () => {
    const prompt = await runTurn(EXPERT_PERSONA_PROMPT);

    // The expert identity is the role section: at the very start of the prompt,
    // before the tool-guidance steps (`### 2. Explore …`).
    expect(prompt.startsWith("You are the Atlas Semantic Expert Agent.")).toBe(true);
    const personaIdx = prompt.indexOf("You are the Atlas Semantic Expert Agent.");
    const exploreIdx = prompt.indexOf("### 2. Explore");
    expect(personaIdx).toBeGreaterThanOrEqual(0);
    expect(exploreIdx).toBeGreaterThan(personaIdx);

    // The analyst role section is REPLACED, not co-present — one identity.
    expect(prompt).not.toContain("You are Atlas, an expert data analyst");
  });

  it("the persona is the role, never a `## Warnings` bullet", async () => {
    const prompt = await runTurn(EXPERT_PERSONA_PROMPT);

    // The pre-#4508 bug was the persona smuggled in under `## Warnings` after
    // the analyst role. Assert nothing expert-shaped lives in that section — if
    // a `## Warnings` section exists at all here, it carries no persona text.
    const warnings = warningsSection(prompt);
    expect(warnings).not.toContain("You are the Atlas Semantic Expert Agent.");
    expect(warnings).not.toContain("Your work product is a well-evidenced");
  });

  it("a turn with no persona keeps the analyst role section (every other surface unchanged)", async () => {
    const prompt = await runTurn();
    expect(prompt).toContain("You are Atlas, an expert data analyst");
    expect(prompt).not.toContain("You are the Atlas Semantic Expert Agent.");
  });

  it("front-loads the Briefing block into the system prompt when supplied (#4514)", async () => {
    const briefing = "## Semantic layer briefing\n\n### Health: 82/100\n### Pending review queue (1)";
    const prompt = await runTurn(EXPERT_PERSONA_PROMPT, briefing);
    // The briefing rides the `briefing` seam into the actual model system prompt,
    // so the expert agent learns the health/queue without a tool call (#4514 AC5).
    expect(prompt).toContain("## Semantic layer briefing");
    expect(prompt).toContain("### Health: 82/100");
    // A turn with no briefing carries no briefing header — no change elsewhere.
    const plain = await runTurn(EXPERT_PERSONA_PROMPT);
    expect(plain).not.toContain("## Semantic layer briefing");
  });
});
