/**
 * Agent-loop seam test for durable per-session working memory (#3754, ADR-0020,
 * slice 1).
 *
 * Mirrors `agent-durable-session.test.ts`: drives `runAgent` to completion with
 * a mock model + a custom tool that reads/writes a `DurableState` handle, with
 * the `internalExecute`/`internalQuery` seam backed by an in-memory row store so
 * a write in one turn is genuinely readable in the next (and on resume). Asserts
 * the slice's contract at the `runAgent` seam:
 *   - a slot written in turn 1 is read back in turn 2 (per-session scope)
 *   - a slot written before an interruption is readable after a resume
 *   - no internal DB → handle reads empty + writes dropped (identical to today)
 *   - durability flag off → no memory writes
 *   - a memory write failure never disrupts the turn (fail-soft)
 */

import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { tool } from "ai";
import { z } from "zod";
import type { ModelMessage, UIMessage } from "ai";
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

// --- The seam under test: internalExecute / internalQuery backed by a real map ---
let hasInternalDB = true;
let failMemoryWrite = false;
const internalCalls: Array<{ sql: string; params?: unknown[] }> = [];
const memoryRows: Array<{ conv: string; namespace: string; value: unknown }> = [];

function upsertMemoryRow(conv: string, namespace: string, value: unknown): void {
  const existing = memoryRows.find((r) => r.conv === conv && r.namespace === namespace);
  if (existing) existing.value = value;
  else memoryRows.push({ conv, namespace, value });
}

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: (sql: string, params?: unknown[]) => {
    internalCalls.push({ sql, params });
    if (sql.includes("INSERT INTO agent_session_memory")) {
      if (failMemoryWrite) throw new Error("memory write boom");
      const p = params as unknown[];
      upsertMemoryRow(p[0] as string, p[2] as string, JSON.parse(p[3] as string));
    }
  },
  internalQuery: async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM agent_session_memory")) {
      const conv = (params as unknown[])[0] as string;
      return memoryRows
        .filter((r) => r.conv === conv)
        .map((r) => ({ namespace: r.namespace, value: r.value }));
    }
    return [];
  },
}));

const { runAgent } = await import("@atlas/api/lib/agent");
const { defineDurableState } = await import("@atlas/api/lib/durable-state");
const { ToolRegistry } = await import("@atlas/api/lib/tools/registry");

// Declared ONCE at module scope (the registry rejects duplicate declarations).
const noteSlot = defineDurableState<string>("note");
const capturedReads: Array<unknown> = [];

// A tool that records what it reads from the `note` slot, then optionally writes
// it — the surface the seam asserts memory round-trips through.
const memToolRegistry = new ToolRegistry();
memToolRegistry.register({
  name: "memTool",
  description: "Test tool: reads then optionally writes the durable `note` slot.",
  tool: tool({
    description: "Test tool",
    inputSchema: z.object({ write: z.string().optional() }),
    execute: async ({ write }: { write?: string }) => {
      capturedReads.push(noteSlot.get());
      if (write !== undefined) noteSlot.set(write);
      return { ok: true };
    },
  }),
});
memToolRegistry.freeze();

const STOP_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function userMessages(content: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text: content }] }];
}

const FINAL_TEXT_STEP: LanguageModelV3StreamPart[] = [
  { type: "text-delta", id: "text-0", delta: "Done." },
  { type: "finish", usage: STOP_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
];

/** A model that calls memTool with the given input, then finishes with text. */
function memToolModel(input: { write?: string }): InstanceType<typeof MockLanguageModelV3> {
  const steps: LanguageModelV3StreamPart[][] = [
    [
      {
        type: "tool-call",
        toolCallId: "call-mem",
        toolName: "memTool",
        input: JSON.stringify(input),
      },
      { type: "finish", usage: STOP_USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } },
    ],
    FINAL_TEXT_STEP,
  ];
  let idx = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = idx >= steps.length ? steps[steps.length - 1]! : steps[idx++]!;
      return { stream: convertArrayToReadableStream(chunks) };
    },
  });
}

async function driveTurn(
  model: InstanceType<typeof MockLanguageModelV3>,
  opts?: { resume?: { runId: string; transcript: ModelMessage[]; priorStepIndex: number } },
): Promise<void> {
  mockModel = model;
  const result = await runAgent({
    messages: userMessages("hi"),
    conversationId: "conv-1",
    tools: memToolRegistry,
    ...(opts?.resume ? { resume: opts.resume } : {}),
  });
  try {
    await result.consumeStream?.();
  } catch {
    // Fail-soft paths surface the error on consume; the durable writes still run.
  }
}

function memoryWrites() {
  return internalCalls.filter((c) => c.sql.includes("INSERT INTO agent_session_memory"));
}
function terminalWrites() {
  return internalCalls.filter(
    (c) =>
      c.sql.includes("INSERT INTO agent_runs") &&
      (((c.params as unknown[])?.[3] === "done") || ((c.params as unknown[])?.[3] === "failed")),
  );
}

const origFlag = process.env.ATLAS_DURABILITY_ENABLED;

describe("durable working memory at the runAgent seam (#3754)", () => {
  beforeEach(() => {
    internalCalls.length = 0;
    memoryRows.length = 0;
    capturedReads.length = 0;
    hasInternalDB = true;
    failMemoryWrite = false;
    process.env.ATLAS_DURABILITY_ENABLED = "true";
  });

  afterAll(() => {
    if (origFlag === undefined) delete process.env.ATLAS_DURABILITY_ENABLED;
    else process.env.ATLAS_DURABILITY_ENABLED = origFlag;
  });

  it("reads back in turn 2 a slot written in turn 1 (per-session scope)", async () => {
    await driveTurn(memToolModel({ write: "hello" }));
    // Turn 1 persisted the slot (one upsert with the value).
    const writes = memoryWrites();
    expect(writes.length).toBeGreaterThanOrEqual(1);
    const last = writes[writes.length - 1]!;
    expect((last.params as unknown[])[1]).toBe(null); // org_id (no request ctx)
    expect((last.params as unknown[])[2]).toBe("note"); // namespace
    expect(JSON.parse((last.params as unknown[])[3] as string)).toBe("hello"); // value

    // Turn 2 (fresh run, same conversation) reads the persisted value back.
    capturedReads.length = 0;
    await driveTurn(memToolModel({}));
    expect(capturedReads).toContain("hello");
  });

  it("reads a slot written before an interruption after a resume of the same run", async () => {
    await driveTurn(memToolModel({ write: "resumed-value" }));
    expect(memoryRows.find((r) => r.namespace === "note")?.value).toBe("resumed-value");

    capturedReads.length = 0;
    await driveTurn(memToolModel({}), {
      resume: {
        runId: "run-resumed",
        transcript: [{ role: "user", content: "hi" }],
        priorStepIndex: 1,
      },
    });
    expect(capturedReads).toContain("resumed-value");
  });

  it("with no internal DB, reads empty and drops writes (behavior identical to today)", async () => {
    hasInternalDB = false;
    await driveTurn(memToolModel({ write: "x" }));
    // No memory persistence at all.
    expect(memoryWrites()).toHaveLength(0);
    // The handle read returned empty (undefined) — no throw, no seeded value.
    expect(capturedReads).toEqual([undefined]);
  });

  it("with the durability flag off, writes nothing (default off)", async () => {
    process.env.ATLAS_DURABILITY_ENABLED = "false";
    await driveTurn(memToolModel({ write: "x" }));
    expect(memoryWrites()).toHaveLength(0);
    expect(capturedReads).toEqual([undefined]);
  });

  it("never disrupts the turn when a memory write fails (fail-soft)", async () => {
    failMemoryWrite = true;
    // The turn must still complete cleanly and record its terminal checkpoint,
    // even though every agent_session_memory upsert throws.
    await driveTurn(memToolModel({ write: "x" }));
    const terminals = terminalWrites();
    expect(terminals).toHaveLength(1);
    expect((terminals[0]!.params as unknown[])[3]).toBe("done");
  });
});
