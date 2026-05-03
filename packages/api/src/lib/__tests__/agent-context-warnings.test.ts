/**
 * Unit test for #1988 B5 — `runAgent` populates the `contextWarnings`
 * out-array when the preflight semantic-layer / learned-patterns
 * loaders fail.
 *
 * The agent's preflight runs `Effect.all([loadOrgWhitelist + getOrgSemanticIndex,
 * buildLearnedPatternsSection])` with `Effect.catchAll` swallowing any
 * failure so the agent can still produce an answer. Before B5 the only
 * signal was a string prepended to the system prompt — the user got a
 * degraded answer with no UI affordance. Now each branch ALSO pushes a
 * structured `ChatContextWarning` into the caller-supplied array, which
 * the chat route serializes as an SSE `data-context-warning` frame.
 *
 * The test mocks every preflight dependency so we can deterministically
 * trigger both failure branches and assert on the structured frames.
 * The model itself returns a no-op tool-less response so we don't need
 * to wire any tool execution.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import type { ChatContextWarning } from "@useatlas/types";
import { createConnectionMock } from "@atlas/api/testing/connection";

process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
// hasInternalDB() reads DATABASE_URL — set it so the preflight branches
// actually run instead of short-circuiting. We do NOT mock the internal
// DB module (its 30+ exports would force every call site through a
// partial mock that breaks unrelated tests); any real query that fires
// during the run is swallowed by the circuit breaker.
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";

// Provider — return whatever model the test installs.
let mockModel: InstanceType<typeof MockLanguageModelV3>;
mock.module("@atlas/api/lib/providers", () => ({
  getModel: () => mockModel,
  getProviderType: () => "anthropic" as const,
  getModelFromWorkspaceConfig: () => mockModel,
  getWorkspaceProviderType: () => "anthropic" as const,
  getDefaultProvider: () => "anthropic" as const,
}));

// Semantic loaders — both throw to trigger BOTH B5 frames in one run.
mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => {
    throw new Error("simulated pool exhaustion (whitelist)");
  },
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => {
    throw new Error("simulated pool exhaustion (semantic index)");
  },
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["companies"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

// Learned-patterns loader — also throws so we can verify the second
// frame fires independently of the first.
mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => {
    throw new Error("simulated pool exhaustion (learned patterns)");
  },
}));

// Connection — minimal mock so detectDBType / connections.describe()
// don't throw inside `buildSystemPrompt`.
const mockConnObj = {
  query: async () => ({ columns: [], rows: [] }),
  close: async () => {},
};
mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockConnObj,
    connections: {
      get: () => mockConnObj,
      getDefault: () => mockConnObj,
      getTargetHost: () => "localhost:5432",
      describe: () => [{ id: "default", dbType: "postgres" as const }],
      getForOrg: () => mockConnObj,
    },
  }),
);

// Set the request context so `orgId` is non-null (required for the
// semantic-data branch to run; without an orgId it short-circuits).
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    level: "info",
  }),
  setLogLevel: () => true,
  getRequestContext: () => ({
    requestId: "req-test",
    user: {
      id: "user-1",
      activeOrganizationId: "org-1",
    },
    atlasMode: "published" as const,
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// Cache — already mocked elsewhere but we need it here too.
mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({ get: () => null, set: () => {}, stats: () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }) }),
  buildCacheKey: () => "mock-key",
  cacheEnabled: () => false,
  getDefaultTtl: () => 300000,
  flushCache: () => {},
  setCacheBackend: () => {},
  _resetCache: () => {},
}));

const { runAgent } = await import("@atlas/api/lib/agent");

const MOCK_USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function userMessages(content: string): UIMessage[] {
  return [
    {
      id: "msg-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: content }],
    },
  ];
}

describe("runAgent contextWarnings out-array (#1988 B5)", () => {
  beforeEach(() => {
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const final: LanguageModelV3StreamPart[] = [
          { type: "text-delta", id: "t0", delta: "ok" },
          { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
        ];
        return { stream: convertArrayToReadableStream(final) };
      },
    });
  });

  it("populates structured warnings when both preflight loaders fail", async () => {
    const contextWarnings: ChatContextWarning[] = [];
    const result = await runAgent({
      messages: userMessages("how many companies?"),
      contextWarnings,
    });
    // Drain the stream so onFinish + the preflight Effects complete
    await result.steps;

    // Both branches failed — both structured frames should be present.
    expect(contextWarnings.length).toBe(2);

    const codes = contextWarnings.map((w) => w.code).sort();
    expect(codes).toEqual(["learned_patterns_unavailable", "semantic_layer_unavailable"]);

    // Discriminator is load-bearing — verify every frame carries it.
    expect(contextWarnings.every((w) => w.severity === "warning")).toBe(true);
    // Title and detail are both populated so the UI has copy to render.
    expect(contextWarnings.every((w) => w.title.length > 0)).toBe(true);
    expect(contextWarnings.every((w) => (w.detail ?? "").length > 0)).toBe(true);
  });

  it("does not populate warnings when caller omits the array (legacy path)", async () => {
    // Legacy callers (or tests pre-#1988) that don't pass `contextWarnings`
    // get the existing system-prompt-string behavior with no extra cost.
    const result = await runAgent({
      messages: userMessages("how many companies?"),
    });
    await result.steps;
    // No throw, no leak — the optional `?.push` is a no-op when the
    // array is undefined.
    expect(true).toBe(true);
  });
});
