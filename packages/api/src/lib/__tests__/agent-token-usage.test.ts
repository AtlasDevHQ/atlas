/**
 * Write-path test for the token_usage prompt-cache split (#3099).
 *
 * The cache markers are what make the gateway → Anthropic path cache at all,
 * but the *accounting* side has its own silent-failure mode: if the INSERT
 * reads the wrong `usage.inputTokenDetails` field, or the positional params
 * drift out of column order, the new `cache_read_tokens` / `cache_write_tokens`
 * columns would persist 0 forever and nobody would notice until the usage
 * surface (#3098) shipped wrong numbers.
 *
 * This drives `runAgent` to a single text-only finish carrying non-zero
 * cache-read/cache-write usage (in the raw V3 stream shape the AI SDK
 * normalizes into `totalUsage.inputTokenDetails.{cacheReadTokens,
 * cacheWriteTokens}`), spies the fire-and-forget `internalExecute`, and pins
 * BOTH the field path and the `INSERT INTO token_usage` column ordering.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { createConnectionMock } from "@atlas/api/testing/connection";
// Resolved BEFORE the mock.module below registers, so this is the real module.
// Spreading it keeps every export intact (mock-all-exports) while we override
// only the two seams the write path touches.
import * as realInternal from "@atlas/api/lib/db/internal";

// Module-top env — read at import time by the modules below.
process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

let mockModel: InstanceType<typeof MockLanguageModelV3>;

mock.module("@atlas/api/lib/providers", () => ({
  getModel: () => mockModel,
  getProviderType: () => "anthropic" as const,
  getModelFromWorkspaceConfig: () => mockModel,
  getWorkspaceProviderType: () => "anthropic" as const,
  getDefaultProvider: () => "anthropic" as const,
  isGatewayAnthropicModel: (modelId: string) => modelId.includes("anthropic") || modelId.includes("claude"),
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["companies", "people"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

const mockDBConnectionObj = {
  query: async () => ({ columns: ["id"], rows: [{ id: 1 }] }),
  close: async () => {},
};
mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBConnectionObj,
    connections: {
      get: () => mockDBConnectionObj,
      getDefault: () => mockDBConnectionObj,
      getTargetHost: () => "localhost:5432",
      describe: () => [{ id: "default", dbType: "postgres" as const }],
      getForOrg: () => mockDBConnectionObj,
    },
  }),
);

// --- The seam under test: internalExecute / hasInternalDB ---
let hasInternalDB = true;
const internalCalls: Array<{ sql: string; params?: unknown[] }> = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: (sql: string, params?: unknown[]) => {
    internalCalls.push({ sql, params });
  },
}));

const { runAgent } = await import("@atlas/api/lib/agent");

/**
 * Raw V3 finish-chunk usage carrying a cache split. The AI SDK normalizes
 * `inputTokens.{cacheRead,cacheWrite}` into the aggregated
 * `totalUsage.inputTokenDetails.{cacheReadTokens,cacheWriteTokens}` that the
 * production INSERT reads — so non-zero values here prove the field path.
 */
const CACHE_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 100, noCache: 90, cacheRead: 7, cacheWrite: 3 },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function userMessages(content: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text: content }] }];
}

/** Single text-only step → the agent loop ends immediately and onFinish fires. */
function textOnlyModel(usage: LanguageModelV3Usage): InstanceType<typeof MockLanguageModelV3> {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-delta", id: "text-0", delta: "Done." },
    { type: "finish", usage, finishReason: { unified: "stop", raw: "end_turn" } },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
  });
}

/** Drain the data stream so the streamText onFinish callback runs. */
async function drive(model: InstanceType<typeof MockLanguageModelV3>): Promise<void> {
  mockModel = model;
  // userId/orgId derive from the request context (null here), which is fine —
  // the token_usage INSERT still fires on `hasInternalDB() && totalUsage`.
  const result = await runAgent({ messages: userMessages("hi"), conversationId: "conv-1" });
  await result.steps;
  await result.consumeStream?.();
}

function tokenUsageInsert() {
  return internalCalls.find((c) => c.sql.includes("INSERT INTO token_usage"));
}

describe("token_usage cache split write path (#3099)", () => {
  beforeEach(() => {
    internalCalls.length = 0;
    hasInternalDB = true;
  });

  it("persists cacheReadTokens/cacheWriteTokens at the right INSERT positions", async () => {
    await drive(textOnlyModel(CACHE_USAGE));

    const insert = tokenUsageInsert();
    expect(insert).toBeDefined();

    // Columns: user_id, conversation_id, prompt_tokens, completion_tokens,
    //          cache_read_tokens, cache_write_tokens, model, provider, org_id
    expect(insert!.sql).toContain("cache_read_tokens, cache_write_tokens");
    const params = insert!.params as unknown[];
    expect(params).toHaveLength(9);
    expect(params[4]).toBe(7); // cache_read_tokens  ← inputTokenDetails.cacheReadTokens
    expect(params[5]).toBe(3); // cache_write_tokens ← inputTokenDetails.cacheWriteTokens
  });

  it("writes 0 for the cache split when the provider reports no cache usage", async () => {
    await drive(textOnlyModel({
      inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    }));

    const params = tokenUsageInsert()!.params as unknown[];
    expect(params[4]).toBe(0);
    expect(params[5]).toBe(0);
  });

  it("does not write token usage when no internal DB is configured", async () => {
    hasInternalDB = false;
    await drive(textOnlyModel(CACHE_USAGE));
    expect(tokenUsageInsert()).toBeUndefined();
  });
});
