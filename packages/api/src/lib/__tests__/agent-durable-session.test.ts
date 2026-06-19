/**
 * Agent-loop seam test for durable-session terminal checkpoints (#3745,
 * ADR-0020, phase 1a).
 *
 * Mirrors `agent-token-usage.test.ts`: drives `runAgent` to completion with a
 * mock model, spies the fire-and-forget `internalExecute`, and pins the
 * `INSERT INTO agent_runs` write. Asserts the four contract behaviors at the
 * `runAgent` seam:
 *   - durability on + internal DB → exactly one row, status `done`, transcript
 *   - a throwing turn → one row, status `failed`
 *   - no internal DB → no agent_runs write (behavior identical to today)
 *   - durability flag off → no agent_runs write (default off)
 */

import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { createConnectionMock } from "@atlas/api/testing/connection";
import * as realInternal from "@atlas/api/lib/db/internal";

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

const STOP_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function userMessages(content: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text: content }] }];
}

/** Single text-only step → the agent loop ends immediately and onFinish fires. */
function textOnlyModel(): InstanceType<typeof MockLanguageModelV3> {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-delta", id: "text-0", delta: "Done." },
    { type: "finish", usage: STOP_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
  });
}

/** A model whose stream rejects, exercising the onError failure path. */
function throwingModel(): InstanceType<typeof MockLanguageModelV3> {
  return new MockLanguageModelV3({
    doStream: async () => {
      throw new Error("boom");
    },
  });
}

/**
 * A model that finishes cleanly *in-band* with `finishReason: error` — the
 * AI-SDK's in-stream error signal. This drives `onFinish` (NOT `onError`) with
 * `finishReason === "error"`, exercising the distinct ternary in the agent loop
 * that maps that reason to a `failed` checkpoint (rather than `done`).
 */
function inBandErrorModel(): InstanceType<typeof MockLanguageModelV3> {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-delta", id: "text-0", delta: "partial" },
    { type: "finish", usage: STOP_USAGE, finishReason: { unified: "error", raw: "error" } },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
  });
}

/**
 * A model whose stream emits an `error` part (firing `onError`) and then still
 * reaches a `finish` part (firing `onFinish`). Both terminal seams fire on the
 * same turn — the case the `terminalWritten` idempotency guard exists for. The
 * first write (onError → `failed`) must win and the second must be suppressed,
 * leaving exactly one row.
 */
function errorThenFinishModel(): InstanceType<typeof MockLanguageModelV3> {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-delta", id: "text-0", delta: "partial" },
    { type: "error", error: new Error("mid-stream") },
    { type: "finish", usage: STOP_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
  });
}

/** Drain the data stream so the streamText onFinish/onError callback runs. */
async function drive(model: InstanceType<typeof MockLanguageModelV3>): Promise<void> {
  mockModel = model;
  const result = await runAgent({ messages: userMessages("hi"), conversationId: "conv-1" });
  try {
    await result.steps;
    await result.consumeStream?.();
  } catch {
    // The throwing-model path surfaces the error on consume; the durable
    // `failed` checkpoint is written from onError regardless. Swallow here.
  }
}

function agentRunInsert() {
  return internalCalls.find((c) => c.sql.includes("INSERT INTO agent_runs"));
}

const origFlag = process.env.ATLAS_DURABILITY_ENABLED;

describe("agent_runs terminal checkpoint write path (#3745)", () => {
  beforeEach(() => {
    internalCalls.length = 0;
    hasInternalDB = true;
    process.env.ATLAS_DURABILITY_ENABLED = "true";
  });

  afterAll(() => {
    if (origFlag === undefined) delete process.env.ATLAS_DURABILITY_ENABLED;
    else process.env.ATLAS_DURABILITY_ENABLED = origFlag;
  });

  it("writes exactly one row with status 'done' and the transcript on a clean finish", async () => {
    await drive(textOnlyModel());

    const inserts = internalCalls.filter((c) => c.sql.includes("INSERT INTO agent_runs"));
    expect(inserts).toHaveLength(1);

    const insert = inserts[0]!;
    // Columns: conversation_id, org_id, status, step_index, transcript
    expect(insert.sql).toContain("$5::jsonb");
    const params = insert.params as unknown[];
    expect(params[0]).toBe("conv-1"); // conversation_id
    expect(params[2]).toBe("done"); // status
    expect(params[3]).toBe(1); // step_index — one completed step (steps.length)
    expect(typeof params[4]).toBe("string"); // transcript is JSON text
    // Transcript is valid JSON carrying the turn's messages (input + response).
    const transcript = JSON.parse(params[4] as string) as unknown[];
    expect(Array.isArray(transcript)).toBe(true);
    expect(transcript.length).toBeGreaterThan(0);
  });

  it("writes a row with status 'failed' when the turn throws", async () => {
    await drive(throwingModel());

    const inserts = internalCalls.filter((c) => c.sql.includes("INSERT INTO agent_runs"));
    expect(inserts).toHaveLength(1);
    expect((inserts[0]!.params as unknown[])[2]).toBe("failed");
  });

  it("records 'failed' (not 'done') when the turn finishes in-band with finishReason error", async () => {
    await drive(inBandErrorModel());

    const inserts = internalCalls.filter((c) => c.sql.includes("INSERT INTO agent_runs"));
    expect(inserts).toHaveLength(1);
    expect((inserts[0]!.params as unknown[])[2]).toBe("failed");
  });

  it("writes exactly one row when both onError and onFinish fire (idempotency guard)", async () => {
    await drive(errorThenFinishModel());

    // Both terminal seams fire on this turn; the guard keeps it to one row and
    // the first status (onError → 'failed') wins.
    const inserts = internalCalls.filter((c) => c.sql.includes("INSERT INTO agent_runs"));
    expect(inserts).toHaveLength(1);
    expect((inserts[0]!.params as unknown[])[2]).toBe("failed");
  });

  it("does not write an agent_runs row when no internal DB is configured", async () => {
    hasInternalDB = false;
    await drive(textOnlyModel());
    expect(agentRunInsert()).toBeUndefined();
  });

  it("does not write an agent_runs row when the durability flag is off (default)", async () => {
    process.env.ATLAS_DURABILITY_ENABLED = "false";
    await drive(textOnlyModel());
    expect(agentRunInsert()).toBeUndefined();
  });
});
