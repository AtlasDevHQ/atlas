/**
 * #4303 (PRD #4292) — workspace default answer style ("house voice").
 *
 * A workspace admin can set a default answer style in the settings registry
 * (`ATLAS_DEFAULT_ANSWER_STYLE`, workspace-scoped, hot-reloadable). Precedence:
 *
 *   explicit `answerStyle` (per-conversation pick #4302, or a chat-platform
 *   surface's explicit "conversational") > workspace default > surface
 *   default (`DEFAULT_ANSWER_STYLE`, analyst).
 *
 * Two seams are pinned here:
 *
 *   1. `resolveWorkspaceDefaultAnswerStyle` — the settings-tier resolution
 *      (workspace override > platform override > env var > unset, each tier
 *      exercised below), the empty/invalid-value fail-soft, and the
 *      request-context orgId fallback (same shape as `getAgentMaxSteps`,
 *      #3406).
 *   2. `runAgent` — the real agent loop, spying-mock-model harness (borrowed
 *      from agent-answer-style-prompt-shape.test.ts): a turn with no explicit
 *      style renders the workspace default's addendum; an explicit style
 *      still wins (including the Slack path's explicit "conversational", so
 *      chat-platform surfaces are structurally unaffected); clearing the
 *      default falls back to the analyst surface default without a restart.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { createConnectionMock } from "@atlas/api/testing/connection";

// ---------------------------------------------------------------------------
// Module mocks — deterministic single-connection workspace. runAgent runs with
// NO request context here, so every org-scoped loader short-circuits; the
// workspace-default reads below exercise the PLATFORM settings tier (the same
// getSetting chain, without waking the org-gated context loaders).
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

// #3633 — agent.ts assembles the org-knowledge block via this module.
void mock.module("@atlas/api/lib/learn/org-knowledge-section", () => ({
  resolveOrgKnowledgeSection: async () => "",
}));

const { runAgent, resolveWorkspaceDefaultAnswerStyle } = await import(
  "@atlas/api/lib/agent"
);
const { withRequestContext } = await import("@atlas/api/lib/logger");
const { _resetPool } = await import("@atlas/api/lib/db/internal");
type InternalPool = import("@atlas/api/lib/db/internal").InternalPool;
const { setSetting, deleteSetting, _resetSettingsCache } = await import(
  "@atlas/api/lib/settings"
);

const ORG = "org-answer-style-default-test";
const KEY = "ATLAS_DEFAULT_ANSWER_STYLE";

// Same in-memory internal-DB stand-in as agent-max-steps.test.ts (#3406):
// setSetting/deleteSetting persist through this no-op pool and maintain the
// in-process cache the resolver reads.
const mockPool: InternalPool = {
  query: async () => ({ rows: [] }),
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

const origDbUrl = process.env.DATABASE_URL;
const origEnvDefault = process.env[KEY];

beforeEach(() => {
  delete process.env[KEY];
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
  _resetSettingsCache();
});

afterEach(() => {
  if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
  else delete process.env.DATABASE_URL;
  if (origEnvDefault !== undefined) process.env[KEY] = origEnvDefault;
  else delete process.env[KEY];
  _resetPool(null);
  _resetSettingsCache();
});

// ---------------------------------------------------------------------------
// 1) The settings-tier resolver
// ---------------------------------------------------------------------------

describe("resolveWorkspaceDefaultAnswerStyle (#4303)", () => {
  it("returns undefined when nothing is configured (surface default applies)", () => {
    expect(resolveWorkspaceDefaultAnswerStyle()).toBeUndefined();
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBeUndefined();
  });

  it("returns the workspace override for that org — and does not leak to others", async () => {
    await setSetting(KEY, "plain-english", "test", ORG);
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBe("plain-english");
    expect(resolveWorkspaceDefaultAnswerStyle("org-other")).toBeUndefined();
  });

  it("falls back to the platform override when the org has none", async () => {
    await setSetting(KEY, "executive", "test");
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBe("executive");
    expect(resolveWorkspaceDefaultAnswerStyle()).toBe("executive");
  });

  it("falls back to the env tier when no DB override exists — and a DB override beats it", async () => {
    // The env tier exists mechanically for every registry entry (this key is
    // registry-managed, not env-first: nothing requires the var to be set),
    // and this pins the registry entry's `envVar` spelling for self-hosted
    // deployments that do use it.
    process.env[KEY] = "plain-english";
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBe("plain-english");
    await setSetting(KEY, "executive", "test", ORG);
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBe("executive");
  });

  it("resolves the active org from the request context when no orgId is passed (#3406 shape)", async () => {
    await setSetting(KEY, "executive", "test", ORG);
    const inRequest = withRequestContext(
      {
        requestId: "req-4303",
        user: {
          id: "u1",
          mode: "managed",
          label: "u1@example.com",
          activeOrganizationId: ORG,
        },
      },
      () => resolveWorkspaceDefaultAnswerStyle(),
    );
    expect(inRequest).toBe("executive");
    // Out-of-request callers see no workspace tier.
    expect(resolveWorkspaceDefaultAnswerStyle()).toBeUndefined();
  });

  it("a cleared override resolves to undefined again (set → delete)", async () => {
    await setSetting(KEY, "executive", "test", ORG);
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBe("executive");
    await deleteSetting(KEY, "test", ORG);
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBeUndefined();
  });

  it("treats an empty-string override as unset (the select route stores \"\" as a legal value)", async () => {
    await setSetting(KEY, "", "test", ORG);
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBeUndefined();
  });

  it("trims surrounding whitespace before validating", async () => {
    await setSetting(KEY, "  analyst  ", "test", ORG);
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBe("analyst");
  });

  it("ignores an out-of-vocabulary value (fail-soft to the surface default, never a crashed turn)", async () => {
    await setSetting(KEY, "sarcastic", "test", ORG);
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBeUndefined();
  });

  it("accepts every OFFERED house voice and rejects conversational — curation is enforced at resolution, not only the admin options seam", async () => {
    const { WORKSPACE_DEFAULT_STYLE_OPTIONS } = await import(
      "@atlas/api/lib/answer-styles"
    );
    for (const style of WORKSPACE_DEFAULT_STYLE_OPTIONS) {
      await setSetting(KEY, style, "test", ORG);
      expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBe(style);
    }
    // The env-var ingress bypasses the admin select's write validation, so a
    // registered-but-non-offered style must take the same warn-and-fall-back
    // path as an unknown token: `conversational`'s addendum instructs the
    // agent to reference Slack affordances ("Show SQL" buttons) that don't
    // exist on the analyst-grade surfaces this default applies to.
    process.env[KEY] = "conversational";
    _resetSettingsCache();
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBeUndefined();
    // A DB-stored value gets the same treatment (defense in depth — today's
    // admin route can't store it, but the resolver must not trust that).
    delete process.env[KEY];
    await setSetting(KEY, "conversational", "test", ORG);
    expect(resolveWorkspaceDefaultAnswerStyle(ORG)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2) runAgent precedence — real agent loop, spying mock model
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

async function runTurn(
  answerStyle?: import("@atlas/api/lib/answer-styles").AnswerStyle,
): Promise<string> {
  lastSystemPrompt = undefined;
  const result = await runAgent({
    messages: [
      {
        id: "msg-1",
        role: "user" as const,
        parts: [
          { type: "text" as const, text: "Which region grew the most last quarter?" },
        ],
      },
    ] satisfies UIMessage[],
    aiModel: {
      model: makeSpyingModel(),
      providerType: "openai",
      modelId: "mock-workspace-default-model",
    },
    ...(answerStyle ? { answerStyle } : {}),
  });
  await result.text; // drain the stream so doStream ran
  expect(lastSystemPrompt).toBeDefined();
  return lastSystemPrompt ?? "";
}

describe("runAgent — workspace default answer style precedence (#4303)", () => {
  it("a turn with no explicit style renders the workspace default's addendum", async () => {
    await setSetting(KEY, "executive", "test");
    const prompt = await runTurn();
    expect(prompt).toContain("## Answer style — executive");
    expect(prompt).not.toContain("## Answer style — analyst");
  });

  it("an explicit per-conversation style beats the workspace default", async () => {
    await setSetting(KEY, "executive", "test");
    const prompt = await runTurn("plain-english");
    expect(prompt).toContain("## Answer style — plain English");
    expect(prompt).not.toContain("## Answer style — executive");
  });

  it("the chat-platform surface's explicit conversational voice is unaffected by the workspace default", async () => {
    // Both chat-platform entrypoints map presentationMode → an explicit
    // answerStyle every turn (executeQuery.ts in core, the proactive answer
    // adapter in /ee), so the workspace default can never reach a
    // chat-platform turn — the no-Slack-regression half of #4303.
    await setSetting(KEY, "executive", "test");
    const prompt = await runTurn("conversational");
    expect(prompt).toContain("## Presentation mode — conversational");
    expect(prompt).not.toContain("## Answer style — executive");
  });

  it("no workspace default ⇒ the analyst surface default still applies", async () => {
    const prompt = await runTurn();
    expect(prompt).toContain("## Answer style — analyst");
  });

  it("clearing the workspace default falls back to the surface default without a restart (hot reload)", async () => {
    await setSetting(KEY, "executive", "test");
    expect(await runTurn()).toContain("## Answer style — executive");
    await deleteSetting(KEY, "test");
    const prompt = await runTurn();
    expect(prompt).toContain("## Answer style — analyst");
    expect(prompt).not.toContain("## Answer style — executive");
  });

  it("an invalid stored value fails soft to the surface default (never a crashed turn)", async () => {
    await setSetting(KEY, "sarcastic", "test");
    const prompt = await runTurn();
    expect(prompt).toContain("## Answer style — analyst");
  });
});
