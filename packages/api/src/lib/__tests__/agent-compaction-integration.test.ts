/**
 * Integration tests for context compaction at the `runAgent` seam (#3759).
 *
 * Drives a real `runAgent` turn through the AI SDK `streamText` loop with a
 * MockLanguageModelV3 (tool-call steps for the turn loop, `doGenerate` for the
 * summarizer) and asserts the compaction pass:
 *   - fires when an enabled turn crosses the fill-fraction threshold and the
 *     turn completes instead of erroring,
 *   - pins the system prompt + the most-recent N steps and replaces older
 *     history with ONE generated summary,
 *   - records the `atlas.compaction.ran` attribute on the `atlas.agent` span,
 *   - does NONE of this when the flag is off (default).
 *
 * Mocks mirror agent-integration.test.ts (provider / semantic / connection /
 * just-bash / cache). A recording global TracerProvider captures the
 * `atlas.agent` span — the API's proxy tracer delegates to it lazily, so
 * registering before the turn runs is enough to observe the live span.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { trace, type Span, type Tracer, type TracerProvider } from "@opentelemetry/api";
import { createConnectionMock } from "@atlas/api/testing/connection";

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

// ---------------------------------------------------------------------------
// Recording tracer — capture atlas.agent span attributes
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
}
const recordedSpans: RecordedSpan[] = [];

function makeRecordingSpan(name: string): Span {
  const attributes: Record<string, unknown> = {};
  const span = {
    setAttribute(k: string, v: unknown) {
      attributes[k] = v;
      return span;
    },
    setAttributes(a: Record<string, unknown>) {
      Object.assign(attributes, a);
      return span;
    },
    addEvent() {
      return span;
    },
    addLink() {
      return span;
    },
    addLinks() {
      return span;
    },
    setStatus() {
      return span;
    },
    updateName() {
      return span;
    },
    end() {},
    isRecording() {
      return true;
    },
    recordException() {},
    spanContext() {
      return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 };
    },
  } as unknown as Span;
  recordedSpans.push({ name, attributes });
  return span;
}

const recordingTracer = {
  startSpan: (name: string) => makeRecordingSpan(name),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal startActiveSpan shim across the API overloads
  startActiveSpan: (name: string, ...args: any[]) => {
    const fn = args[args.length - 1];
    return fn(makeRecordingSpan(name));
  },
} as unknown as Tracer;

const recordingProvider: TracerProvider = {
  getTracer: () => recordingTracer,
};

// Register BEFORE importing the agent graph so this provider wins: the API's
// proxy tracer (captured at agent.ts module load) delegates to whatever global
// provider is registered, and a registration here pre-empts any provider the
// agent graph might register at import time.
trace.disable();
trace.setGlobalTracerProvider(recordingProvider);

function agentSpan(): RecordedSpan | undefined {
  return recordedSpans.find((s) => s.name === "atlas.agent");
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

mock.module("just-bash", () => ({
  Bash: class MockBash {
    constructor(_: unknown) {}
    async exec() {
      return { stdout: "catalog.yml\n", stderr: "", exitCode: 0 };
    }
  },
  OverlayFs: class MockOverlayFs {
    constructor(_: unknown) {}
  },
}));

mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({ get: () => null, set: () => {}, stats: () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }) }),
  buildCacheKey: () => "mock-key",
  cacheEnabled: () => false,
  getDefaultTtl: () => 300000,
  flushCache: () => {},
  setCacheBackend: () => {},
  _resetCache: () => {},
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

const { runAgent } = await import("@atlas/api/lib/agent");
const { invalidateExploreBackend } = await import("@atlas/api/lib/tools/explore");
const { COMPACTION_SUMMARY_PREFIX } = await import("@atlas/api/lib/agent-compaction");
const { _resetSettingsCache } = await import("@atlas/api/lib/settings");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let callId = 0;
const MOCK_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

/** Captured `prompt` (provider-format messages) from each turn-loop model call. */
let capturedPrompts: unknown[] = [];
/** How many times the summarizer (`doGenerate`) ran. */
let summarizerCalls = 0;
/** Captured `prompt` from each summarizer (`doGenerate`) call. */
let summarizerPrompts: unknown[] = [];

function sqlStep(marker: string): LanguageModelV3StreamPart[] {
  return [
    {
      type: "tool-call",
      toolCallId: `call-${++callId}`,
      toolName: "executeSQL",
      input: JSON.stringify({ sql: `SELECT id AS ${marker} FROM companies`, explanation: marker }),
    },
    { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } },
  ];
}

const TEXT_STEP: LanguageModelV3StreamPart[] = [
  { type: "text-delta", id: "text-0", delta: "Done." },
  { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
];

/**
 * Build a model that emits 4 distinct SQL steps then a text step, capturing
 * each turn-loop prompt and counting summarizer calls.
 */
function buildModel(): InstanceType<typeof MockLanguageModelV3> {
  const steps: LanguageModelV3StreamPart[][] = [
    sqlStep("marker0"),
    sqlStep("marker1"),
    sqlStep("marker2"),
    sqlStep("marker3"),
    TEXT_STEP,
  ];
  let idx = 0;
  return new MockLanguageModelV3({
    doStream: async (options) => {
      capturedPrompts.push(options.prompt);
      const chunks = idx >= steps.length ? steps[steps.length - 1] : steps[idx++];
      return { stream: convertArrayToReadableStream(chunks) };
    },
    // Summarizer path (generateText → doGenerate).
    doGenerate: async (options) => {
      summarizerCalls++;
      summarizerPrompts.push(options.prompt);
      return {
        content: [{ type: "text", text: "GENERATED CONTEXT SUMMARY" }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: MOCK_USAGE,
        warnings: [],
      };
    },
  });
}

function userMessages(content: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text: content }] }];
}

const COMPACTION_ENV_KEYS = [
  "ATLAS_COMPACTION_ENABLED",
  "ATLAS_COMPACTION_FILL_FRACTION",
  "ATLAS_COMPACTION_PINNED_RECENT_STEPS",
  "ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS",
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent compaction — runAgent seam (#3759)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    callId = 0;
    capturedPrompts = [];
    summarizerCalls = 0;
    summarizerPrompts = [];
    recordedSpans.length = 0;
    invalidateExploreBackend();
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.ATLAS_TABLE_WHITELIST;
    delete process.env.ATLAS_SANDBOX_URL;
    for (const k of COMPACTION_ENV_KEYS) saved[k] = process.env[k];
    _resetSettingsCache();
    mockModel = buildModel();
  });

  afterEach(() => {
    for (const k of COMPACTION_ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
    _resetSettingsCache();
  });

  function enableCompaction(): void {
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.1"; // trip easily — system prompt alone crosses
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "2";
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "1000";
    _resetSettingsCache();
  }

  it("enabled + past threshold → compaction fires and the turn completes", async () => {
    enableCompaction();

    const result = await runAgent({ messages: userMessages("Analyze companies") });
    const steps = await result.steps;

    // Turn ran to natural completion (4 SQL steps + 1 text step), not an error.
    expect(steps.length).toBe(5);

    // The summarizer ran on the turn model at least once.
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);

    // A model call received the injected summary (older history was compacted in).
    const allPrompts = JSON.stringify(capturedPrompts);
    expect(allPrompts).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(allPrompts).toContain("GENERATED CONTEXT SUMMARY");

    // The atlas.agent span recorded the compaction attribute.
    const span = agentSpan();
    expect(span).toBeDefined();
    expect(span!.attributes["atlas.compaction.ran"]).toBe(true);
    expect(span!.attributes["atlas.compaction.before_tokens"]).toBeGreaterThan(0);
  });

  it("pins the system prompt + most-recent N steps and drops older steps verbatim", async () => {
    enableCompaction();

    const result = await runAgent({ messages: userMessages("Analyze companies") });
    await result.steps;

    // The final turn-loop model call is the text step. By then the loop has 4
    // assistant steps; with N=2 the two most-recent steps (marker2, marker3) are
    // pinned and the older ones (marker0, marker1) are folded into the summary.
    const lastPrompt = JSON.stringify(capturedPrompts[capturedPrompts.length - 1]);

    // System prompt is pinned (sent as a system message, never summarized).
    expect(lastPrompt).toContain("expert data analyst");
    // Summary stands in for older history.
    expect(lastPrompt).toContain(COMPACTION_SUMMARY_PREFIX);
    // Most-recent N steps survive verbatim.
    expect(lastPrompt).toContain("marker3");
    expect(lastPrompt).toContain("marker2");
    // Older steps are gone from the verbatim context (folded into the summary).
    expect(lastPrompt).not.toContain("marker0");
    expect(lastPrompt).not.toContain("marker1");
  });

  it("rolls the summary forward incrementally rather than re-reading the whole older slice each step", async () => {
    enableCompaction();

    const result = await runAgent({ messages: userMessages("Analyze companies") });
    await result.steps;

    // The threshold trips on multiple steps, so the summarizer runs more than
    // once. The FIRST pass summarizes the full older slice; every later pass
    // takes the rolling path — folding only the newly-aged-out steps into the
    // prior running summary (prompt carries the "Existing running summary"
    // frame), keeping per-step summarization input bounded.
    expect(summarizerCalls).toBeGreaterThanOrEqual(2);
    const laterPrompts = JSON.stringify(summarizerPrompts.slice(1));
    expect(laterPrompts).toContain("Existing running summary");
  });

  it("flag off (default) → no compaction regardless of context size", async () => {
    // Default off: do not set ATLAS_COMPACTION_ENABLED.
    const result = await runAgent({ messages: userMessages("Analyze companies") });
    const steps = await result.steps;

    expect(steps.length).toBe(5); // identical loop behaviour
    expect(summarizerCalls).toBe(0); // summarizer never ran
    expect(JSON.stringify(capturedPrompts)).not.toContain(COMPACTION_SUMMARY_PREFIX);

    const span = agentSpan();
    expect(span).toBeDefined();
    expect(span!.attributes["atlas.compaction.ran"]).toBeUndefined();
  });
});
