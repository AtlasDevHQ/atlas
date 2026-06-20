/**
 * Agent-loop seam test for approval-park control inversion (#3748, ADR-0020
 * phase 3).
 *
 * Mirrors `agent-durable-session.test.ts`: drives `runAgent` with a mock model
 * and spies the fire-and-forget `internalExecute` to pin the `agent_runs` write.
 * The gated tool is a stub `executeSQL` that returns the SAME needs-approval
 * shape the real gate returns (`{ approval_required: true, approval_request_id }`)
 * — the real gate→needs-approval path is pinned by `sql-approval.test.ts`; here
 * we pin the LOOP's reaction to that result:
 *   - the turn writes ONE `parked` checkpoint carrying the approval-queue ref and
 *     makes NO further model call (the headline acceptance);
 *   - resuming from the rewritten (approved) transcript executes the gated action
 *     EXACTLY ONCE and finishes `done`;
 *   - resuming from a denied transcript surfaces the rejection and never executes.
 */

import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { tool, type ModelMessage, type UIMessage } from "ai";
import { z } from "zod";
import { createConnectionMock } from "@atlas/api/testing/connection";
import * as realInternal from "@atlas/api/lib/db/internal";
import { applyApprovalDecision, findApprovalParkSignal } from "@atlas/api/lib/approvals/evaluate";

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
  getOrgWhitelistedTables: () => new Set(["companies"]),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["companies"]),
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
const { ToolRegistry } = await import("@atlas/api/lib/tools/registry");

const STOP_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const PARK_REQ_ID = "req-park-1";

// --- A controllable executeSQL stub modelling the approval gate ---
// `approved=false` ⇒ return the needs-approval result WITHOUT running the query
// (the real gate returns before execution). `approved=true` ⇒ run the query
// (increment `dbQueryCount`) and return rows — modelling `hasApprovedRequest`
// flipping true after the admin approves.
let approved = false;
let dbQueryCount = 0;
function buildStubRegistry() {
  const stub = tool({
    description: "Run a read-only SQL query (test stub with an approval gate).",
    inputSchema: z.object({ sql: z.string(), explanation: z.string() }),
    execute: async () => {
      if (!approved) {
        return {
          success: false,
          approval_required: true,
          approval_request_id: PARK_REQ_ID,
          matched_rules: ["PII tables"],
          message: "This query requires approval before execution.",
          executionMs: 0,
        };
      }
      dbQueryCount++;
      return { success: true, columns: ["id"], rows: [{ id: 1 }], rowCount: 1, executionMs: 1 };
    },
  });
  const registry = new ToolRegistry();
  registry.register({ name: "executeSQL", description: "Run a read-only SQL query.", tool: stub });
  return registry.freeze();
}

function userMessages(content: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text: content }] }];
}

const SQL_STEP: LanguageModelV3StreamPart[] = [
  {
    type: "tool-call",
    toolCallId: "call-park",
    toolName: "executeSQL",
    input: JSON.stringify({ sql: "SELECT id FROM companies", explanation: "list" }),
  },
  { type: "finish", usage: STOP_USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } },
];
const FINAL_TEXT_STEP: LanguageModelV3StreamPart[] = [
  { type: "text-delta", id: "text-0", delta: "Here are your results." },
  { type: "finish", usage: STOP_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
];

let doStreamCalls = 0;
/** A model that emits a tool-call step first, then a final text step. */
function sqlThenTextModel(): InstanceType<typeof MockLanguageModelV3> {
  const steps: LanguageModelV3StreamPart[][] = [SQL_STEP, FINAL_TEXT_STEP];
  let idx = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      doStreamCalls++;
      const chunks = idx >= steps.length ? steps[steps.length - 1]! : steps[idx++]!;
      return { stream: convertArrayToReadableStream(chunks) };
    },
  });
}
/** A model that emits a single final text step (the denied-resume case). */
function textOnlyModel(): InstanceType<typeof MockLanguageModelV3> {
  return new MockLanguageModelV3({
    doStream: async () => {
      doStreamCalls++;
      return { stream: convertArrayToReadableStream(FINAL_TEXT_STEP) };
    },
  });
}

async function drive(
  model: InstanceType<typeof MockLanguageModelV3>,
  opts: { resume?: { runId: string; transcript: ModelMessage[]; priorStepIndex: number } } = {},
): Promise<{ runId: string; steps: unknown[] }> {
  mockModel = model;
  const result = await runAgent({
    messages: userMessages("show companies"),
    conversationId: "conv-1",
    tools: buildStubRegistry(),
    ...(opts.resume ? { resume: opts.resume } : {}),
  });
  await result.steps;
  await result.consumeStream?.();
  return { runId: result.runId, steps: await result.steps };
}

function agentRunWrites() {
  return internalCalls.filter((c) => c.sql.includes("INSERT INTO agent_runs"));
}
function statusOf(c: { params?: unknown[] }): string {
  return (c.params as unknown[])[3] as string;
}
function parkedWrites() {
  return agentRunWrites().filter((c) => statusOf(c) === "parked");
}
function terminalWrites() {
  return agentRunWrites().filter((c) => statusOf(c) === "done" || statusOf(c) === "failed");
}
function transcriptOf(c: { params?: unknown[] }): ModelMessage[] {
  return JSON.parse((c.params as unknown[])[5] as string) as ModelMessage[];
}

const origFlag = process.env.ATLAS_DURABILITY_ENABLED;

describe("approval-park control inversion at the runAgent seam (#3748)", () => {
  beforeEach(() => {
    internalCalls.length = 0;
    hasInternalDB = true;
    approved = false;
    dbQueryCount = 0;
    doStreamCalls = 0;
    process.env.ATLAS_DURABILITY_ENABLED = "true";
  });

  afterAll(() => {
    if (origFlag === undefined) delete process.env.ATLAS_DURABILITY_ENABLED;
    else process.env.ATLAS_DURABILITY_ENABLED = origFlag;
  });

  it("parks the turn on a needs-approval result: one `parked` checkpoint, no further model calls", async () => {
    await drive(sqlThenTextModel());

    // Headline: exactly ONE model call. The loop stopped after the gated step
    // instead of feeding the needs-approval result back to the model.
    expect(doStreamCalls).toBe(1);
    // The gated query never ran (the gate returned before execution).
    expect(dbQueryCount).toBe(0);

    // Exactly one `parked` checkpoint carrying the approval-queue ref in
    // parked_reason ($7); no clean `done`/`failed` terminal write.
    const parked = parkedWrites();
    expect(parked).toHaveLength(1);
    expect(parked[0]!.sql).toContain("parked_reason");
    expect((parked[0]!.params as unknown[])[6]).toBe(PARK_REQ_ID);
    expect(terminalWrites()).toHaveLength(0);

    // The parked transcript carries the SAME needs-approval marker the resolver
    // later keys on — self-contained against a future transcript-shape change.
    const transcript = transcriptOf(parked[0]!);
    expect(findApprovalParkSignal(transcript)?.approvalRequestId).toBe(PARK_REQ_ID);
  });

  it("does not write a parked row when durability is off (default)", async () => {
    process.env.ATLAS_DURABILITY_ENABLED = "false";
    await drive(sqlThenTextModel());
    expect(agentRunWrites()).toHaveLength(0);
    // The loop still parks (no further model call) — durability only governs persistence.
    expect(doStreamCalls).toBe(1);
  });

  it("approving resumes to a continued result and executes the gated action exactly once", async () => {
    // 1) Fresh turn parks. Capture the run id + the parked transcript (carrying
    //    the needs-approval result the resolver rewrites).
    const { runId } = await drive(sqlThenTextModel());
    const parked = parkedWrites();
    expect(parked).toHaveLength(1);
    const parkedStepIndex = (parked[0]!.params as unknown[])[4] as number;
    const parkedTranscript = transcriptOf(parked[0]!);
    expect(dbQueryCount).toBe(0); // never executed at park

    // 2) Admin approves → the resolver rewrites the transcript and `hasApproved-
    //    Request` flips true (modelled by `approved = true`).
    const { transcript: approvedTranscript } = applyApprovalDecision(parkedTranscript, PARK_REQ_ID, "approve", {
      reviewerLabel: "admin@x.com",
    });
    // The reviewer-side rewrite is pure — it executes NOTHING (the gated query
    // never runs in the reviewer's context; execution is deferred to resume in the
    // requester's context). dbQueryCount stays 0 until the requester reattaches.
    expect(dbQueryCount).toBe(0);
    approved = true;
    internalCalls.length = 0;
    doStreamCalls = 0;

    // 3) Requester reattaches — resume from the approved transcript (same run id).
    await drive(sqlThenTextModel(), {
      resume: { runId, transcript: approvedTranscript, priorStepIndex: parkedStepIndex },
    });

    // The gated action executed EXACTLY ONCE (at resume, never at park).
    expect(dbQueryCount).toBe(1);
    // The resumed turn re-called the tool then produced a final answer → done.
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    expect(statusOf(terminals[0]!)).toBe("done");
    expect(parkedWrites()).toHaveLength(0);
  });

  it("rejecting ends the turn cleanly with the rejection surfaced and never executes", async () => {
    const { runId } = await drive(sqlThenTextModel());
    const parked = parkedWrites();
    expect(parked).toHaveLength(1);
    const parkedStepIndex = (parked[0]!.params as unknown[])[4] as number;
    const parkedTranscript = transcriptOf(parked[0]!);

    // Admin denies → the resolver rewrites the result to a denial. `approved`
    // stays false: a denied query must never execute even if the model retries.
    const { transcript: deniedTranscript } = applyApprovalDecision(parkedTranscript, PARK_REQ_ID, "deny", {
      comment: "prod is frozen",
    });
    internalCalls.length = 0;
    doStreamCalls = 0;

    // Resume with a text-only model: the agent reads the denial and informs the user.
    await drive(textOnlyModel(), {
      resume: { runId, transcript: deniedTranscript, priorStepIndex: parkedStepIndex },
    });

    expect(dbQueryCount).toBe(0);
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    expect(statusOf(terminals[0]!)).toBe("done");
  });
});
