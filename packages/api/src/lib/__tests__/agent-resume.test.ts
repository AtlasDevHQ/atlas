/**
 * Agent-loop seam test for crash-resume (#3747, ADR-0020 phase 2).
 *
 * Mirrors `agent-durable-session.test.ts`: drives `runAgent` with a mock model
 * and spies the fire-and-forget `internalExecute`, but exercises the RESUME
 * path — `runAgent({ resume: { runId, transcript, priorStepIndex } })`. Asserts
 * the resume contract at the `runAgent` seam:
 *   - a resumed turn continues from step N+1 (durable step_index keeps climbing)
 *   - completed tool calls in the stored transcript do NOT re-execute (the SQL
 *     connection is never hit when the resumed model emits only the final text)
 *   - resumed checkpoints reuse the interrupted run's id (one row per turn)
 *   - total step accounting across interruption+resume equals the uninterrupted
 *     run (same final step_index, same token_usage row count)
 */

import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import type { ModelMessage, UIMessage } from "ai";
import { createConnectionMock } from "@atlas/api/testing/connection";
import * as realInternal from "@atlas/api/lib/db/internal";

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

let mockModel: InstanceType<typeof MockLanguageModelV3>;

mock.module("@atlas/api/lib/providers", () => ({
  getModel: () => mockModel,
  getProviderType: () => "anthropic" as const,
  getModelFromWorkspaceConfig: () => mockModel,
  // #3761 — compaction summary-model resolver (added so the named import in agent.ts links).
  getSummaryModel: () => mockModel,
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

// SQL connection spy — the load-bearing assertion is that a resumed turn whose
// completed steps are in the transcript NEVER re-runs those tools. If the model
// emits only the final text step on resume, this query fn must not be called.
let sqlQueryCount = 0;
const mockDBConnectionObj = {
  query: async () => {
    sqlQueryCount++;
    return { columns: ["id"], rows: [{ id: 1 }] };
  },
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

/** Two tool-call steps + a text step → a 3-step turn (the uninterrupted shape). */
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

/** A model that emits ONLY the final text step — the resumed continuation. */
function finalTextOnlyModel(): InstanceType<typeof MockLanguageModelV3> {
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(FINAL_TEXT_STEP) }),
  });
}

async function drive(
  model: InstanceType<typeof MockLanguageModelV3>,
  opts: Parameters<typeof runAgent>[0],
): Promise<void> {
  mockModel = model;
  const result = await runAgent(opts);
  try {
    await result.steps;
    await result.consumeStream?.();
  } catch {
    // Swallow — terminal checkpoints are written from the seam regardless.
  }
}

function agentRunWrites() {
  return internalCalls.filter((c) => c.sql.includes("INSERT INTO agent_runs"));
}
function tokenWrites() {
  return internalCalls.filter((c) => c.sql.includes("INSERT INTO token_usage"));
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
function terminalWrites() {
  return agentRunWrites().filter((c) => statusOf(c) === "done" || statusOf(c) === "failed");
}

const origFlag = process.env.ATLAS_DURABILITY_ENABLED;

describe("agent crash-resume seam (#3747)", () => {
  beforeEach(() => {
    internalCalls.length = 0;
    sqlQueryCount = 0;
    hasInternalDB = true;
    process.env.ATLAS_DURABILITY_ENABLED = "true";
  });

  afterAll(() => {
    if (origFlag === undefined) delete process.env.ATLAS_DURABILITY_ENABLED;
    else process.env.ATLAS_DURABILITY_ENABLED = origFlag;
  });

  it("continues from step N+1 and does NOT re-invoke tools of steps ≤ N", async () => {
    // Stored transcript as of step 2 of a 3-step turn: the user message plus two
    // completed executeSQL steps (assistant tool-call + tool result each). The
    // resumed model emits ONLY the final text step.
    const RESUMED_RUN_ID = "99999999-9999-9999-9999-999999999999";
    const storedTranscript: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-s0", toolName: "executeSQL", input: { sql: "SELECT 1" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-s0", toolName: "executeSQL", output: { type: "json", value: { rows: [] } } }],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-s1", toolName: "executeSQL", input: { sql: "SELECT 2" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-s1", toolName: "executeSQL", output: { type: "json", value: { rows: [] } } }],
      },
    ];

    await drive(finalTextOnlyModel(), {
      messages: userMessages("hi"),
      conversationId: "conv-1",
      resume: { runId: RESUMED_RUN_ID, transcript: storedTranscript, priorStepIndex: 2 },
    });

    // The two completed executeSQL tool calls were in the transcript — the
    // resumed model emitted only text — so NO SQL ran on resume.
    expect(sqlQueryCount).toBe(0);

    // The terminal checkpoint reuses the interrupted run id (one row per turn),
    // is `done`, and lands at the TOTAL step count (2 prior + 1 resumed = 3) —
    // continued from N+1, not restarted at 1.
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    expect(runIdOf(terminals[0]!)).toBe(RESUMED_RUN_ID);
    expect(statusOf(terminals[0]!)).toBe("done");
    expect(stepIndexOf(terminals[0]!)).toBe(3);

    // Every durable write of the resumed turn shares the resumed run id.
    expect(new Set(agentRunWrites().map(runIdOf))).toEqual(new Set([RESUMED_RUN_ID]));
  });

  it("resumed step accounting equals the uninterrupted run (same final index + transcript, one token row)", async () => {
    // Baseline: an uninterrupted 3-step turn. Capture its final step index AND
    // its terminal transcript — the resume must converge on both.
    await drive(multiStepModel(), { messages: userMessages("hi"), conversationId: "conv-1" });
    const baselineTerminal = terminalWrites();
    expect(baselineTerminal).toHaveLength(1);
    const baselineFinalIndex = stepIndexOf(baselineTerminal[0]!);
    const baselineTranscript = transcriptOf(baselineTerminal[0]!);
    expect(baselineFinalIndex).toBe(3);
    expect(tokenWrites()).toHaveLength(1);

    // Reset and run the SAME turn as interrupt-after-step-2 + resume. The stored
    // transcript is the baseline's state through its first two (tool-call) steps.
    internalCalls.length = 0;
    sqlQueryCount = 0;

    const RESUMED_RUN_ID = "88888888-8888-8888-8888-888888888888";
    const storedTranscript: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c0", toolName: "executeSQL", input: { sql: "SELECT 1" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c0", toolName: "executeSQL", output: { type: "json", value: { rows: [] } } }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "executeSQL", input: { sql: "SELECT 2" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "executeSQL", output: { type: "json", value: { rows: [] } } }] },
    ];
    await drive(finalTextOnlyModel(), {
      messages: userMessages("hi"),
      conversationId: "conv-1",
      resume: { runId: RESUMED_RUN_ID, transcript: storedTranscript, priorStepIndex: 2 },
    });

    // The resumed turn reaches the SAME final step index as the uninterrupted run.
    const resumedTerminal = terminalWrites();
    expect(resumedTerminal).toHaveLength(1);
    expect(stepIndexOf(resumedTerminal[0]!)).toBe(baselineFinalIndex);

    // …and the SAME final transcript length — the resume converges on the exact
    // turn state, neither short (lost steps) nor duplicated (replayed steps).
    expect(transcriptOf(resumedTerminal[0]!).length).toBe(baselineTranscript.length);

    // Token accounting: the resumed continuation writes exactly one token_usage
    // row (no double counting from the resume re-entry).
    expect(tokenWrites()).toHaveLength(1);
  });

  it("a fresh turn (no resume) is unchanged — new (minted) run id, lands at the full step count", async () => {
    await drive(multiStepModel(), { messages: userMessages("hi"), conversationId: "conv-fresh" });
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    // A fresh turn mints a UUID run id (not one we supplied via `resume`).
    expect(runIdOf(terminals[0]!)).toMatch(/^[0-9a-f-]{36}$/);
    // And counts its steps from 0 → the full 3-step turn.
    expect(stepIndexOf(terminals[0]!)).toBe(3);
  });
});
