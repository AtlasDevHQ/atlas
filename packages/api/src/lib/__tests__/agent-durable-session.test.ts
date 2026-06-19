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

/**
 * A model that emits N tool-call steps then a final text step, so the agent loop
 * runs N+1 steps and `onStepFinish` fires once per step. Each tool-call step
 * grows the transcript (assistant tool-call + tool result), so the per-step
 * `running` checkpoints (#3746) show the transcript advancing.
 */
function sqlStep(marker: string): LanguageModelV3StreamPart[] {
  return [
    {
      type: "tool-call",
      toolCallId: `call-${marker}`,
      toolName: "executeSQL",
      input: JSON.stringify({ sql: `SELECT id AS ${marker} FROM companies`, explanation: marker }),
    },
    { type: "finish", usage: STOP_USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } },
  ];
}

const FINAL_TEXT_STEP: LanguageModelV3StreamPart[] = [
  { type: "text-delta", id: "text-0", delta: "Done." },
  { type: "finish", usage: STOP_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
];

/** Two tool-call steps + a text step → a 3-step turn. */
function multiStepModel(): InstanceType<typeof MockLanguageModelV3> {
  const steps: LanguageModelV3StreamPart[][] = [sqlStep("s0"), sqlStep("s1"), FINAL_TEXT_STEP];
  let idx = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = idx >= steps.length ? steps[steps.length - 1]! : steps[idx++]!;
      return { stream: convertArrayToReadableStream(chunks) };
    },
  });
}

/**
 * A model that completes ONE tool-call step then blocks indefinitely on the next
 * step until `gate` resolves — simulating a turn interrupted mid-flight after
 * step 1 (no terminal write can run while blocked). The test asserts the
 * recoverable `running` checkpoint, then releases the gate so the run winds down.
 */
function interruptAfterFirstStepModel(
  gate: Promise<void>,
): InstanceType<typeof MockLanguageModelV3> {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      call++;
      if (call === 1) {
        return { stream: convertArrayToReadableStream(sqlStep("s0")) };
      }
      await gate;
      return { stream: convertArrayToReadableStream(FINAL_TEXT_STEP) };
    },
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

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --- agent_runs write accessors (params: [runId, conv, org, status, step, transcript]) ---
function agentRunWrites() {
  return internalCalls.filter((c) => c.sql.includes("INSERT INTO agent_runs"));
}
function runIdOf(c: { params?: unknown[] }): string {
  return (c.params as unknown[])[0] as string;
}
function statusOf(c: { params?: unknown[] }): string {
  return (c.params as unknown[])[3] as string;
}
function stepIndexOf(c: { params?: unknown[] }): number {
  return (c.params as unknown[])[4] as number;
}
function transcriptOf(c: { params?: unknown[] }): unknown[] {
  return JSON.parse((c.params as unknown[])[5] as string) as unknown[];
}
function runningWrites() {
  return agentRunWrites().filter((c) => statusOf(c) === "running");
}
function terminalWrites() {
  return agentRunWrites().filter((c) => statusOf(c) === "done" || statusOf(c) === "failed");
}

const origFlag = process.env.ATLAS_DURABILITY_ENABLED;

describe("agent_runs checkpoint write path (#3745 terminal, #3746 per-step)", () => {
  beforeEach(() => {
    internalCalls.length = 0;
    hasInternalDB = true;
    process.env.ATLAS_DURABILITY_ENABLED = "true";
  });

  afterAll(() => {
    if (origFlag === undefined) delete process.env.ATLAS_DURABILITY_ENABLED;
    else process.env.ATLAS_DURABILITY_ENABLED = origFlag;
  });

  it("writes exactly one terminal row with status 'done' and the transcript on a clean finish", async () => {
    await drive(textOnlyModel());

    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);

    const t = terminals[0]!;
    // In-place upsert keyed on the run id (one logical row per turn).
    expect(t.sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(t.sql).toContain("$6::jsonb");
    expect((t.params as unknown[])[1]).toBe("conv-1"); // conversation_id
    expect(statusOf(t)).toBe("done");
    expect(stepIndexOf(t)).toBe(1); // one completed step (steps.length)
    // Transcript is valid JSON carrying the turn's messages (input + response).
    const transcript = transcriptOf(t);
    expect(Array.isArray(transcript)).toBe(true);
    expect(transcript.length).toBeGreaterThan(0);
    // Every write of the turn (per-step + terminal) shares ONE run id → one row.
    expect(new Set(agentRunWrites().map(runIdOf)).size).toBe(1);
  });

  it("advances the step index 1 → N and grows the transcript across a multi-step turn", async () => {
    await drive(multiStepModel());

    const running = runningWrites();
    // onStepFinish fires once per step (2 tool-call steps + 1 text step).
    expect(running.map(stepIndexOf)).toEqual([1, 2, 3]);

    // Transcript grows monotonically as each step's messages accumulate.
    const lengths = running.map((c) => transcriptOf(c).length);
    expect(lengths[0]!).toBeLessThan(lengths[1]!);
    expect(lengths[1]!).toBeLessThan(lengths[2]!);

    // One logical row: every per-step + terminal write shares the run id.
    expect(new Set(agentRunWrites().map(runIdOf)).size).toBe(1);

    // Terminal flips that same row to done at the final step index.
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    expect(statusOf(terminals[0]!)).toBe("done");
    expect(stepIndexOf(terminals[0]!)).toBe(3);

    // Token accounting unchanged vs pre-1b: exactly one token_usage row, no
    // double counting from the per-step checkpoints.
    const tokenWrites = internalCalls.filter((c) => c.sql.includes("INSERT INTO token_usage"));
    expect(tokenWrites).toHaveLength(1);
  });

  it("leaves a recoverable 'running' checkpoint at step N when interrupted mid-flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = () => r();
    });
    mockModel = interruptAfterFirstStepModel(gate);
    const result = await runAgent({ messages: userMessages("hi"), conversationId: "conv-1" });
    // Consume in the background; the model blocks on the second step.
    const consumed = Promise.resolve(result.consumeStream?.()).catch(() => {});

    // While step 2 is blocked, the only persisted state is the mid-flight
    // checkpoint from the completed first step.
    await waitFor(() => runningWrites().length >= 1);
    const running = runningWrites();
    const last = running[running.length - 1]!;
    expect(statusOf(last)).toBe("running");
    expect(stepIndexOf(last)).toBe(1); // one step completed → step index 1
    // No terminal write while the turn is still mid-flight (the interruption).
    expect(terminalWrites()).toHaveLength(0);

    // Release the blocked step so the run winds down (no leaked promise).
    release();
    await consumed;
  });

  it("writes a 'failed' terminal row when the turn throws before any step", async () => {
    await drive(throwingModel());

    // The model throws on the first doStream call — no step completes, so there
    // is no per-step checkpoint, just the terminal failure.
    expect(runningWrites()).toHaveLength(0);
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    expect(statusOf(terminals[0]!)).toBe("failed");
  });

  it("records 'failed' (not 'done') when the turn finishes in-band with finishReason error", async () => {
    await drive(inBandErrorModel());

    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    expect(statusOf(terminals[0]!)).toBe("failed");
  });

  it("writes exactly one terminal row when both onError and onFinish fire (idempotency guard)", async () => {
    await drive(errorThenFinishModel());

    // Both terminal seams fire on this turn; the guard keeps it to one terminal
    // write and the first status (onError → 'failed') wins.
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    expect(statusOf(terminals[0]!)).toBe("failed");
  });

  it("does not write any agent_runs row when no internal DB is configured", async () => {
    hasInternalDB = false;
    await drive(multiStepModel());
    expect(agentRunWrites()).toHaveLength(0);
  });

  it("does not write any agent_runs row when the durability flag is off (default)", async () => {
    process.env.ATLAS_DURABILITY_ENABLED = "false";
    await drive(multiStepModel());
    expect(agentRunWrites()).toHaveLength(0);
  });
});
