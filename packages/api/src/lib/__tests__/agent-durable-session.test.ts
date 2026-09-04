/**
 * Agent-loop seam test for durable-session terminal checkpoints (#3745,
 * ADR-0020, phase 1a).
 *
 * Drives `runAgent` to completion with a
 * mock model, spies the fire-and-forget `internalExecute`, and pins the
 * `INSERT INTO agent_runs` write. Asserts the four contract behaviors at the
 * `runAgent` seam:
 *   - durability on + internal DB → exactly one row, status `done`, transcript
 *   - a throwing turn → one row, status `failed`
 *   - no internal DB → no agent_runs write (behavior identical to today)
 *   - durability flag off → no agent_runs write (default off)
 *
 * ---------------------------------------------------------------------------
 * Also hosts the crash-resume seam (#3747, formerly agent-resume.test.ts):
 *
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
 *
 * ---------------------------------------------------------------------------
 * And the token_usage write path (#3099, formerly agent-token-usage.test.ts):
 *
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

void mock.module("@atlas/api/lib/providers", () => ({
  getModel: () => mockModel,
  getProviderType: () => "anthropic" as const,
  getModelFromWorkspaceConfig: () => mockModel,
  // #3761 — compaction summary-model resolver (added so the named import in agent.ts links).
  getSummaryModel: () => mockModel,
  getWorkspaceProviderType: () => "anthropic" as const,
  getDefaultProvider: () => "anthropic" as const,
  isGatewayAnthropicModel: (modelId: string) => modelId.includes("anthropic") || modelId.includes("claude"),
}));

void mock.module("@atlas/api/lib/semantic", () => ({
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

// SQL connection spy — the load-bearing assertion (#3747) is that a resumed turn
// whose completed steps are in the transcript NEVER re-runs those tools. If the
// model emits only the final text step on resume, this query fn must not be called.
let sqlQueryCount = 0;
const mockDBConnectionObj = {
  query: async () => {
    sqlQueryCount++;
    return { columns: ["id"], rows: [{ id: 1 }] };
  },
  close: async () => {},
};
void mock.module("@atlas/api/lib/db/connection", () =>
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

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: (sql: string, params?: unknown[]) => {
    internalCalls.push({ sql, ...(params !== undefined ? { params } : {})});
  },
}));

const { runAgent } = await import("@atlas/api/lib/agent");
// #4943 — runAgent's `tools` is now required; this is its own fail-closed
// default, so these turns are unchanged. See agent.ts's `@param tools`.
//
// The resume tests name it at each `driveWith(...)` call rather than defaulting
// inside the helper: `driveWith` forwards a pre-built bag to `runAgent(opts)`, a
// shape neither guard can read (the scanner treats it as `absent`, and it skips
// `__tests__` anyway), so keeping the registry in each test body is the only
// thing that makes the posture visible here.
const { nonDashboardRegistry } = await import("@atlas/api/lib/tools/registry");

const STOP_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function userMessages(content: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text: content }] }];
}

/** Single text-only step → the agent loop ends immediately and onFinish fires. */
function textOnlyModel(usage: LanguageModelV3Usage = STOP_USAGE): InstanceType<typeof MockLanguageModelV3> {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-delta", id: "text-0", delta: "Done." },
    { type: "finish", usage, finishReason: { unified: "stop", raw: "end_turn" } },
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
    doStream: async ({ abortSignal }) => {
      call++;
      if (call === 1) {
        return { stream: convertArrayToReadableStream(sqlStep("s0")) };
      }
      // Honor the abort signal like a real provider fetch does (#4294): a
      // blocked call rejects with AbortError when the caller stops the turn.
      // Callers that pass no signal (the interruption test) block on the gate
      // alone, exactly as before.
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new DOMException("aborted", "AbortError"));
        if (abortSignal?.aborted) return onAbort();
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        void gate.then(() => {
          abortSignal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      return { stream: convertArrayToReadableStream(FINAL_TEXT_STEP) };
    },
  });
}

/** Drain the data stream so the streamText onFinish/onError callback runs. */
async function drive(model: InstanceType<typeof MockLanguageModelV3>): Promise<void> {
  mockModel = model;
  const result = await runAgent({ tools: nonDashboardRegistry, messages: userMessages("hi"), conversationId: "conv-1" });
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
    sqlQueryCount = 0;
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

    // Transcript grows (non-decreasing) as each step's messages accumulate and
    // is strictly larger at the end of the turn than at the first step. (Strict
    // step-over-step growth would be wrong: a final text-only step adds an
    // assistant message but no tool result, so consecutive checkpoints can tie.
    // The strong anti-duplication guard is the running==terminal equality below.)
    const lengths = running.map((c) => transcriptOf(c).length);
    expect(lengths[0]!).toBeLessThanOrEqual(lengths[1]!);
    expect(lengths[1]!).toBeLessThanOrEqual(lengths[2]!);
    expect(lengths[2]!).toBeGreaterThan(lengths[0]!);

    // One logical row: every per-step + terminal write shares the run id.
    expect(new Set(agentRunWrites().map(runIdOf)).size).toBe(1);

    // Terminal flips that same row to done at the final step index.
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    expect(statusOf(terminals[0]!)).toBe("done");
    expect(stepIndexOf(terminals[0]!)).toBe(3);

    // Regression guard for the AI SDK 6 cumulative-`response.messages` bug: that
    // field is the FULL running transcript at each step, not just the step's own
    // messages, so the final `running` checkpoint must equal the terminal
    // transcript EXACTLY — not a quadratically-duplicated superset of it.
    // (Length-growth alone missed this: duplication still grows monotonically.)
    const lastRunning = running[running.length - 1]!;
    expect(transcriptOf(lastRunning)).toEqual(transcriptOf(terminals[0]!));

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
    const result = await runAgent({ tools: nonDashboardRegistry, messages: userMessages("hi"), conversationId: "conv-1" });
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

  it("#4294 — an explicit stop writes a clean 'done' terminal at the last completed step", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = () => r();
    });
    mockModel = interruptAfterFirstStepModel(gate);
    const ac = new AbortController();
    const result = await runAgent({
      tools: nonDashboardRegistry,
      messages: userMessages("hi"),
      conversationId: "conv-1",
      runId: "run-4294",
      abortSignal: ac.signal,
    });
    // Consume in the background — onAbort runs at stream flush, which requires
    // active consumption. An abort may surface as a rejection here; the durable
    // terminal is written from onAbort regardless (that's what this asserts).
    const consumed = Promise.resolve(result.consumeStream?.()).catch(() => {});

    // Step 1 checkpointed while the model blocks on step 2.
    await waitFor(() => runningWrites().length >= 1);
    expect(terminalWrites()).toHaveLength(0);

    // The user clicks Stop.
    ac.abort();
    await waitFor(() => terminalWrites().length >= 1);
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    // A deliberate stop is a CLEAN end: 'done' (never 'failed', never left
    // 'running') so the run-status probe offers no Resume for a killed turn.
    expect(statusOf(terminals[0]!)).toBe("done");
    // Terminal lands at the last COMPLETED step; the in-flight step's partial
    // output was never checkpointed and stays dropped.
    expect(stepIndexOf(terminals[0]!)).toBe(1);
    // The route pre-mints the run id (that's what `x-run-id` advertises and the
    // stop registry keys on) — every durable write must target that row.
    expect(new Set(agentRunWrites().map(runIdOf))).toEqual(new Set(["run-4294"]));

    // Wind the blocked step down; no leaked promise.
    release();
    await consumed;
    // Idempotency: on ai@6.0.208 `onFinish` can still fire after an abort once
    // ≥1 step completed — the `terminalWritten` guard must keep it to ONE row.
    expect(terminalWrites()).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Crash-resume seam (#3747)
// ---------------------------------------------------------------------------

/** A model that emits ONLY the final text step — the resumed continuation. */
function finalTextOnlyModel(): InstanceType<typeof MockLanguageModelV3> {
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(FINAL_TEXT_STEP) }),
  });
}

async function driveWith(
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

function tokenWrites() {
  return internalCalls.filter((c) => c.sql.includes("INSERT INTO token_usage"));
}

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

    await driveWith(finalTextOnlyModel(), {
      tools: nonDashboardRegistry,
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
    await driveWith(multiStepModel(), { tools: nonDashboardRegistry, messages: userMessages("hi"), conversationId: "conv-1" });
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
    await driveWith(finalTextOnlyModel(), {
      tools: nonDashboardRegistry,
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
    await driveWith(multiStepModel(), { tools: nonDashboardRegistry, messages: userMessages("hi"), conversationId: "conv-fresh" });
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    // A fresh turn mints a UUID run id (not one we supplied via `resume`).
    expect(runIdOf(terminals[0]!)).toMatch(/^[0-9a-f-]{36}$/);
    // And counts its steps from 0 → the full 3-step turn.
    expect(stepIndexOf(terminals[0]!)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// token_usage cache-split write path (#3099)
// ---------------------------------------------------------------------------

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

/**
 * Single text-only step whose finish part carries a Vercel-AI-Gateway cost
 * annotation (`providerMetadata.gateway.cost`) — the shape the at-cost capture
 * (#4036) reads off `step.providerMetadata` to record `gateway_cost_usd`.
 */
function gatewayCostModel(
  usage: LanguageModelV3Usage,
  cost: string,
): InstanceType<typeof MockLanguageModelV3> {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-delta", id: "text-0", delta: "Done." },
    {
      type: "finish",
      usage,
      finishReason: { unified: "stop", raw: "end_turn" },
      providerMetadata: { gateway: { cost } },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
  });
}

/** The `token` usage_events INSERT (event_type param === "token"). */
function tokenUsageEvent() {
  return internalCalls.find(
    (c) => c.sql.includes("INSERT INTO usage_events") && (c.params as unknown[])?.[2] === "token",
  );
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
    //          cache_read_tokens, cache_write_tokens, model, provider, org_id,
    //          latency_ms, gateway_cost_usd
    expect(insert!.sql).toContain("cache_read_tokens, cache_write_tokens");
    expect(insert!.sql).toContain("latency_ms");
    expect(insert!.sql).toContain("gateway_cost_usd");
    const params = insert!.params as unknown[];
    expect(params).toHaveLength(11);
    expect(params[4]).toBe(7); // cache_read_tokens  ← inputTokenDetails.cacheReadTokens
    expect(params[5]).toBe(3); // cache_write_tokens ← inputTokenDetails.cacheWriteTokens
    // latency_ms (#3931) — agent-turn wall-clock, non-negative integer ms.
    // Integer is load-bearing: a units/formula regression (fractional, or a
    // swapped non-time param) would trip this without the flakiness of an
    // upper bound on a near-instant mock turn.
    expect(Number.isInteger(params[9])).toBe(true);
    expect(params[9] as number).toBeGreaterThanOrEqual(0);
    // gateway_cost_usd (#4036) — NULL for this non-gateway mock turn: the steps
    // carry no providerMetadata.gateway.cost, so the at-cost capture records NULL
    // ("no gateway cost recorded"), distinct from a recorded 0.
    expect(params[10]).toBeNull();
  });

  it("records the per-turn gateway cost on both writes for a gateway-routed turn (#4036)", async () => {
    // Drives the REAL field path: the agent's summarizeStepGatewayCostUsd reads
    // step.providerMetadata.gateway.cost off the AI-SDK StepResult. A regression
    // that reads the wrong path (e.g. step.response.providerMetadata) would write
    // NULL forever and the non-gateway test below would still pass — this pins it.
    await drive(gatewayCostModel(CACHE_USAGE, "0.0123"));

    // token_usage row: gateway_cost_usd is the last positional param ($11).
    const insertParams = tokenUsageInsert()!.params as unknown[];
    expect(insertParams[10]).toBe(0.0123);

    // …and the `token` usage event carries the same at-cost dollars ($5 of 6 —
    // weighted_quantity was dropped from the insert in the #4869 follow-up).
    const event = tokenUsageEvent();
    expect(event).toBeDefined();
    expect((event!.params as unknown[])[4]).toBe(0.0123);
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
