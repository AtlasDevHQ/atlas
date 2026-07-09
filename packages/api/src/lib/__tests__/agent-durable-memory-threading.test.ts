/**
 * Agent-loop seam test for deterministic prompt threading of durable working
 * memory (#3755, ADR-0020, slice 2).
 *
 * Where slice 1 (`agent-durable-memory.test.ts`) asserts that memory round-trips
 * THROUGH a tool handle, this slice asserts that the persisted slot values are
 * THREADED INTO THE ASSEMBLED PROMPT — so the agent carries them forward without
 * a tool read-back. Drives `runAgent` with a MockLanguageModelV3 that CAPTURES
 * the provider-format prompt (`doStream` options.prompt) on every step, plus a
 * `doGenerate` summarizer for the compaction path, and asserts the slice's
 * contract at the `runAgent` seam:
 *   - a slot written in turn 1 appears in turn 2's SYSTEM prompt at the dedicated
 *     working-memory block — with NO tool call in turn 2 (no re-derivation),
 *   - the block lives in the system prompt, separate from the transcript, so a
 *     context-compaction pass over the transcript leaves it intact,
 *   - a resumed turn re-threads the restored memory at the same position,
 *   - empty memory / no internal DB / durability-off thread NOTHING (no block).
 *
 * Internal-DB seam is backed by an in-memory row store (mirrors slice 1) so a
 * write in one turn is genuinely readable in the next + on resume.
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

const mockDBConnectionObj = {
  query: async () => ({ columns: ["id"], rows: [{ id: 1 }] }),
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

// --- Internal-DB seam: internalExecute / internalQuery over an in-memory map ---
let hasInternalDB = true;
const memoryRows: Array<{ conv: string; namespace: string; value: unknown }> = [];

function upsertMemoryRow(conv: string, namespace: string, value: unknown): void {
  const existing = memoryRows.find((r) => r.conv === conv && r.namespace === namespace);
  if (existing) existing.value = value;
  else memoryRows.push({ conv, namespace, value });
}

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: (sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO agent_session_memory")) {
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
const { defineDurableState, DURABLE_MEMORY_BLOCK_HEADING } = await import("@atlas/api/lib/durable-state");
const { COMPACTION_SUMMARY_PREFIX } = await import("@atlas/api/lib/agent-compaction");
const { _resetSettingsCache } = await import("@atlas/api/lib/settings");
const { ToolRegistry } = await import("@atlas/api/lib/tools/registry");

// Declared ONCE at module scope (the registry rejects duplicate declarations).
const noteSlot = defineDurableState<string>("note");
const capturedReads: Array<unknown> = [];

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

const FINAL_TEXT_STEP: LanguageModelV3StreamPart[] = [
  { type: "text-delta", id: "text-0", delta: "Done." },
  { type: "finish", usage: STOP_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
];

function memToolCallStep(id: string, input: { write?: string }): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId: id, toolName: "memTool", input: JSON.stringify(input) },
    { type: "finish", usage: STOP_USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } },
  ];
}

/** Captured provider-format `prompt` (system + transcript) from each model step. */
let capturedPrompts: unknown[] = [];

/**
 * Build a capturing model from a scripted list of steps. Every `doStream`
 * records `options.prompt`; `doGenerate` answers the compaction summarizer so a
 * compaction pass can actually run on this mock.
 */
function buildModel(steps: LanguageModelV3StreamPart[][]): InstanceType<typeof MockLanguageModelV3> {
  let idx = 0;
  return new MockLanguageModelV3({
    modelId: "claude-test",
    doStream: async (options) => {
      capturedPrompts.push(options.prompt);
      const chunks = idx >= steps.length ? steps[steps.length - 1]! : steps[idx++]!;
      return { stream: convertArrayToReadableStream(chunks) };
    },
    doGenerate: async () => ({
      content: [{ type: "text", text: "GENERATED CONTEXT SUMMARY" }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: STOP_USAGE,
      warnings: [],
    }),
  });
}

/** A model that writes note=<value> in step 1, then finishes with text. */
function writeModel(value: string): InstanceType<typeof MockLanguageModelV3> {
  return buildModel([memToolCallStep("call-w", { write: value }), FINAL_TEXT_STEP]);
}

/** A model that emits ONLY a text step — makes NO tool call (no read-back). */
function textOnlyModel(): InstanceType<typeof MockLanguageModelV3> {
  return buildModel([FINAL_TEXT_STEP]);
}

/** A model that reads (no write) over `n` tool-call steps, then finishes — grows the transcript. */
function multiStepReadModel(n: number): InstanceType<typeof MockLanguageModelV3> {
  const steps: LanguageModelV3StreamPart[][] = [];
  for (let i = 0; i < n; i++) steps.push(memToolCallStep(`call-r${i}`, {}));
  steps.push(FINAL_TEXT_STEP);
  return buildModel(steps);
}

function userMessages(content: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text: content }] }];
}

/** Provider-format prompt → the system message's text. */
function systemTextOf(prompt: unknown): string {
  const msgs = prompt as Array<{ role: string; content: unknown }>;
  const sys = msgs.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);
}

/** Provider-format prompt → JSON of the NON-system (transcript) messages. */
function transcriptTextOf(prompt: unknown): string {
  const msgs = prompt as Array<{ role: string }>;
  return JSON.stringify(msgs.filter((m) => m.role !== "system"));
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
    // Fail-soft paths surface on consume; the prompt was already captured.
  }
}

const COMPACTION_ENV_KEYS = [
  "ATLAS_COMPACTION_ENABLED",
  "ATLAS_COMPACTION_FILL_FRACTION",
  "ATLAS_COMPACTION_PINNED_RECENT_STEPS",
  "ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS",
] as const;

const origDurability = process.env.ATLAS_DURABILITY_ENABLED;
const savedCompaction: Record<string, string | undefined> = {};

describe("durable working-memory prompt threading at the runAgent seam (#3755)", () => {
  beforeEach(() => {
    memoryRows.length = 0;
    capturedReads.length = 0;
    capturedPrompts = [];
    hasInternalDB = true;
    process.env.ATLAS_DURABILITY_ENABLED = "true";
    for (const k of COMPACTION_ENV_KEYS) {
      savedCompaction[k] = process.env[k];
      delete process.env[k];
    }
    _resetSettingsCache();
  });

  afterAll(() => {
    if (origDurability === undefined) delete process.env.ATLAS_DURABILITY_ENABLED;
    else process.env.ATLAS_DURABILITY_ENABLED = origDurability;
    for (const k of COMPACTION_ENV_KEYS) {
      if (savedCompaction[k] !== undefined) process.env[k] = savedCompaction[k];
      else delete process.env[k];
    }
    _resetSettingsCache();
  });

  function enableCompaction(): void {
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.1"; // trips easily — system prompt alone crosses
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "2";
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "1000";
    _resetSettingsCache();
  }

  it("threads a turn-1 slot value into turn 2's system prompt — model uses it with no tool read-back", async () => {
    // Turn 1: a tool writes note="orders".
    await driveTurn(writeModel("orders"));
    expect(memoryRows.find((r) => r.namespace === "note")?.value).toBe("orders");

    // Turn 2 (fresh run, same conversation): the model emits ONLY text — it makes
    // no tool call, so it never reads the slot back through the handle.
    capturedPrompts = [];
    capturedReads.length = 0;
    await driveTurn(textOnlyModel());

    // No tool ran in turn 2 → the value was NOT re-derived / read back.
    expect(capturedReads).toHaveLength(0);
    // ...yet it is present in the assembled SYSTEM prompt at the memory block.
    const sys = systemTextOf(capturedPrompts[0]);
    expect(sys).toContain(DURABLE_MEMORY_BLOCK_HEADING);
    expect(sys).toContain("orders");
    // The block is OUT of the transcript region (it lives in the system prompt).
    expect(transcriptTextOf(capturedPrompts[0])).not.toContain(DURABLE_MEMORY_BLOCK_HEADING);
  });

  it("keeps the memory block intact through a context-compaction pass over the transcript", async () => {
    await driveTurn(writeModel("orders"));

    enableCompaction();
    capturedPrompts = [];
    // Turn 2: several tool-call steps so the transcript grows and compaction fires.
    await driveTurn(multiStepReadModel(4));

    // Compaction actually ran over the transcript (older steps → one summary).
    expect(JSON.stringify(capturedPrompts)).toContain(COMPACTION_SUMMARY_PREFIX);

    // On the most-compacted (final) step: the transcript carries the summary, but
    // the SYSTEM prompt still holds the full memory block — compaction rewrites
    // only the message array, never the out-of-band system prompt.
    const lastPrompt = capturedPrompts[capturedPrompts.length - 1];
    expect(transcriptTextOf(lastPrompt)).toContain(COMPACTION_SUMMARY_PREFIX);
    const sys = systemTextOf(lastPrompt);
    expect(sys).toContain(DURABLE_MEMORY_BLOCK_HEADING);
    expect(sys).toContain("orders");
  });

  it("re-threads the restored memory at the same position on a resumed turn", async () => {
    await driveTurn(writeModel("resumed-value"));

    capturedPrompts = [];
    capturedReads.length = 0;
    await driveTurn(textOnlyModel(), {
      resume: {
        runId: "run-resumed",
        transcript: [{ role: "user", content: "hi" }],
        priorStepIndex: 1,
      },
    });

    expect(capturedReads).toHaveLength(0); // resumed model made no tool call
    const sys = systemTextOf(capturedPrompts[0]);
    expect(sys).toContain(DURABLE_MEMORY_BLOCK_HEADING);
    expect(sys).toContain("resumed-value");
  });

  it("threads NOTHING when memory is empty (turn 1, nothing written yet)", async () => {
    await driveTurn(textOnlyModel());
    expect(systemTextOf(capturedPrompts[0])).not.toContain(DURABLE_MEMORY_BLOCK_HEADING);
  });

  it("threads NOTHING with no internal DB, even when a row exists (identical to today)", async () => {
    memoryRows.push({ conv: "conv-1", namespace: "note", value: "ignored" });
    hasInternalDB = false;
    await driveTurn(textOnlyModel());
    const sys = systemTextOf(capturedPrompts[0]);
    expect(sys).not.toContain(DURABLE_MEMORY_BLOCK_HEADING);
    expect(sys).not.toContain("ignored");
  });

  it("threads NOTHING with the durability flag off, even when a row exists", async () => {
    memoryRows.push({ conv: "conv-1", namespace: "note", value: "ignored" });
    process.env.ATLAS_DURABILITY_ENABLED = "false";
    _resetSettingsCache();
    await driveTurn(textOnlyModel());
    const sys = systemTextOf(capturedPrompts[0]);
    expect(sys).not.toContain(DURABLE_MEMORY_BLOCK_HEADING);
    expect(sys).not.toContain("ignored");
  });
});
