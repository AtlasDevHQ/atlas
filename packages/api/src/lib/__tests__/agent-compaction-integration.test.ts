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
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- minimal startActiveSpan shim across the API overloads
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
// #3761 — the separate cheaper summary model. When set, the providers mock's
// `getSummaryModel` returns it so the compaction summarization call resolves to
// THIS model instead of the turn model. `null` ⇒ the seam summarizes on the turn
// model (the unset-knob default). Reset per test.
let summaryMockModel: InstanceType<typeof MockLanguageModelV3> | null = null;
// #3761 — when true, the providers mock's `getSummaryModel` THROWS, so a test
// can exercise the fail-soft fallback (a bad summary-model id must degrade to
// the turn model, never error the turn). Reset per test.
let summaryModelResolutionThrows = false;

void mock.module("@atlas/api/lib/providers", () => ({
  getModel: () => mockModel,
  getProviderType: () => "anthropic" as const,
  getModelFromWorkspaceConfig: () => mockModel,
  getWorkspaceProviderType: () => "anthropic" as const,
  getDefaultProvider: () => "anthropic" as const,
  isGatewayAnthropicModel: (modelId: string) => modelId.includes("anthropic") || modelId.includes("claude"),
  // #3761 — resolve the summary model. Returns the configured cheaper model when
  // a test set one, else the turn model (mirrors the real fallback contract);
  // throws when a test opts into the resolution-failure path.
  getSummaryModel: () => {
    if (summaryModelResolutionThrows) {
      throw new Error("unknown summary model id (test)");
    }
    return summaryMockModel ?? mockModel;
  },
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

void mock.module("just-bash", () => ({
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

void mock.module("@atlas/api/lib/cache/index", () => ({
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
const { COMPACTION_SUMMARY_PREFIX, COMPACTION_STREAM_PART_TYPE } = await import("@atlas/api/lib/agent-compaction");
const { _resetSettingsCache } = await import("@atlas/api/lib/settings");
const { withRequestContext } = await import("@atlas/api/lib/logger");
const { setStreamWriter, clearStreamWriter } = await import("@atlas/api/lib/tools/python-stream");

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
/** How many times the summarizer ran ON THE TURN MODEL (`doGenerate`). */
let summarizerCalls = 0;
/** Captured `prompt` from each turn-model summarizer (`doGenerate`) call. */
let summarizerPrompts: unknown[] = [];
/** #3761 — how many times the summarizer ran on the SEPARATE summary model. */
let summaryModelDoGenerateCalls = 0;

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
 * each turn-loop prompt and counting summarizer calls. `modelId` lets a test
 * select the per-model context window the compaction trigger resolves (#3760):
 * `claude-*` → 200k, `gpt-4o` → 128k.
 */
function buildModel(modelId = "mock-model-id"): InstanceType<typeof MockLanguageModelV3> {
  const steps: LanguageModelV3StreamPart[][] = [
    sqlStep("marker0"),
    sqlStep("marker1"),
    sqlStep("marker2"),
    sqlStep("marker3"),
    TEXT_STEP,
  ];
  let idx = 0;
  return new MockLanguageModelV3({
    modelId,
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

/**
 * #3761 — a standalone summary model. Only `doGenerate` is wired (it is never
 * the turn-loop model, so `doStream` is never reached); each call increments a
 * counter distinct from the turn model's so a test can assert WHICH model the
 * summarization call resolved to.
 */
function buildSummaryModel(modelId = "summary-model-id"): InstanceType<typeof MockLanguageModelV3> {
  return new MockLanguageModelV3({
    modelId,
    doGenerate: async (options) => {
      summaryModelDoGenerateCalls++;
      summarizerPrompts.push(options.prompt);
      return {
        content: [{ type: "text", text: "CHEAP SUMMARY MODEL OUTPUT" }],
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
  "ATLAS_COMPACTION_SUMMARY_MODEL",
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

// ---------------------------------------------------------------------------
// Per-model context window at the runAgent seam (#3760)
// ---------------------------------------------------------------------------

describe("agent compaction — per-model context window at the runAgent seam (#3760)", () => {
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
  });

  afterEach(() => {
    for (const k of COMPACTION_ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
    _resetSettingsCache();
  });

  /**
   * Enable compaction with a fill fraction tuned to land BETWEEN a 128k window
   * (gpt-4o) and a 200k window (claude) for the inflated context this test
   * builds — but leave the window override UNSET so the per-model catalog drives
   * resolution. With ~50k tokens of context and fraction 0.3: gpt-4o trips at
   * 0.3×128k = 38.4k (< 50k ⇒ compacts), claude trips at 0.3×200k = 60k
   * (> 50k ⇒ does NOT compact). Same fraction, same context, opposite outcome —
   * driven solely by the resolved per-model window.
   */
  function enablePerModelCompaction(): void {
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.3";
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "2";
    // No ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS ⇒ catalog-resolved per model.
    delete process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS;
    _resetSettingsCache();
  }

  // ~50k-token user message (≈200k chars / 4) so the assembled context sits
  // comfortably between the two models' 0.3 thresholds (38.4k vs 60k).
  const BIG_QUESTION = `Analyze companies. ${"x".repeat(200_000)}`;

  it("a 128k-window model (gpt-4o) compacts where a 200k-window model (claude) does not, for the SAME fraction", async () => {
    enablePerModelCompaction();

    // Small window — trips the threshold, summarizer runs.
    mockModel = buildModel("gpt-4o");
    const small = await runAgent({ messages: userMessages(BIG_QUESTION) });
    await small.steps;
    const smallSummarizerCalls = summarizerCalls;

    // Reset capture between the two runs.
    summarizerCalls = 0;
    capturedPrompts = [];
    recordedSpans.length = 0;
    callId = 0;
    invalidateExploreBackend();
    _resetSettingsCache();

    // Large window — same fraction + same context, but 60k threshold not crossed.
    mockModel = buildModel("claude-opus-4-8");
    const large = await runAgent({ messages: userMessages(BIG_QUESTION) });
    await large.steps;
    const largeSummarizerCalls = summarizerCalls;

    // The per-model window is the ONLY difference: the 128k model compacted,
    // the 200k model did not — different absolute trigger sizes, same fraction.
    expect(smallSummarizerCalls).toBeGreaterThanOrEqual(1);
    expect(largeSummarizerCalls).toBe(0);
  });

  it("a model absent from the catalog falls back to the safe default window without erroring the turn", async () => {
    enablePerModelCompaction();

    // Unknown model id ⇒ catalog miss ⇒ safe 200k default (same as claude here).
    mockModel = buildModel("some-bespoke-local-model");
    const result = await runAgent({ messages: userMessages(BIG_QUESTION) });
    const steps = await result.steps;

    // Turn completed (did not error) on the default window; 0.3×200k = 60k not
    // crossed by ~50k context, so no compaction — and crucially, no throw.
    expect(steps.length).toBe(5);
    expect(summarizerCalls).toBe(0);
  });

  it("the override knob pins the window and takes precedence over the catalog", async () => {
    enablePerModelCompaction();
    // Pin a tiny window so even claude (catalog 200k) trips immediately.
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "1000";
    _resetSettingsCache();

    mockModel = buildModel("claude-opus-4-8");
    const result = await runAgent({ messages: userMessages("Analyze companies") });
    await result.steps;

    // With the catalog's 200k window, 0.3 would NOT trip on a tiny context; the
    // 1000-token override pins the budget low enough that it does.
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(capturedPrompts)).toContain(COMPACTION_SUMMARY_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// Cheaper dedicated summary model at the runAgent seam (#3761)
// ---------------------------------------------------------------------------

describe("agent compaction — cheaper summary model (#3761)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    callId = 0;
    capturedPrompts = [];
    summarizerCalls = 0;
    summarizerPrompts = [];
    summaryModelDoGenerateCalls = 0;
    summaryMockModel = null;
    summaryModelResolutionThrows = false;
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
    summaryMockModel = null;
    summaryModelResolutionThrows = false;
    _resetSettingsCache();
  });

  /** Enable compaction with a tiny window so the system prompt alone trips it. */
  function enable(): void {
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.1";
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "2";
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "1000";
    _resetSettingsCache();
  }

  it("summarizes on the configured separate model, not the turn model", async () => {
    enable();
    process.env.ATLAS_COMPACTION_SUMMARY_MODEL = "summary-model-id";
    _resetSettingsCache();
    summaryMockModel = buildSummaryModel("summary-model-id");

    const result = await runAgent({ messages: userMessages("Analyze companies") });
    await result.steps;

    // The summarization call resolved to the SEPARATE summary model…
    expect(summaryModelDoGenerateCalls).toBeGreaterThanOrEqual(1);
    // …and NOT the turn model (its summarizer counter stays 0).
    expect(summarizerCalls).toBe(0);
    // The summary it produced still lands in the turn-loop context verbatim.
    const prompts = JSON.stringify(capturedPrompts);
    expect(prompts).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(prompts).toContain("CHEAP SUMMARY MODEL OUTPUT");
  });

  it("summarizes on the turn model when the knob is unset (Compaction 1 default)", async () => {
    enable();
    // No ATLAS_COMPACTION_SUMMARY_MODEL set.
    const result = await runAgent({ messages: userMessages("Analyze companies") });
    await result.steps;

    // The turn model did the summarizing; the separate model was never invoked.
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
    expect(summaryModelDoGenerateCalls).toBe(0);
  });

  it("treats a summary model equal to the turn model as 'use the turn model'", async () => {
    enable();
    mockModel = buildModel("same-model-id");
    process.env.ATLAS_COMPACTION_SUMMARY_MODEL = "same-model-id";
    _resetSettingsCache();
    // Even with a separate mock available, an equal id must not resolve it.
    summaryMockModel = buildSummaryModel("should-not-be-used");

    const result = await runAgent({ messages: userMessages("Analyze companies") });
    await result.steps;

    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
    expect(summaryModelDoGenerateCalls).toBe(0);
  });

  it("is independent of #3760 — the cheaper-model path works on a catalog-resolved window", async () => {
    // No explicit window override: the per-model catalog resolves the window
    // (claude → 200k). A tiny fraction still trips it on the inflated context,
    // and the separate summary model is used regardless of how the window was
    // resolved — proving the two knobs compose.
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.1";
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "2";
    delete process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS; // catalog-resolved
    process.env.ATLAS_COMPACTION_SUMMARY_MODEL = "summary-model-id";
    _resetSettingsCache();

    mockModel = buildModel("claude-opus-4-8");
    summaryMockModel = buildSummaryModel("summary-model-id");

    const result = await runAgent({
      messages: userMessages(`Analyze companies. ${"x".repeat(200_000)}`),
    });
    await result.steps;

    expect(summaryModelDoGenerateCalls).toBeGreaterThanOrEqual(1);
    expect(summarizerCalls).toBe(0);
  });

  it("falls back to the turn model (never errors the turn) when summary-model resolution throws", async () => {
    enable();
    process.env.ATLAS_COMPACTION_SUMMARY_MODEL = "broken-model-id";
    _resetSettingsCache();
    // The configured id can't be resolved → getSummaryModel throws. The seam's
    // fail-soft catch must degrade to the turn model rather than killing the turn.
    summaryModelResolutionThrows = true;
    summaryMockModel = buildSummaryModel("never-built");

    const result = await runAgent({ messages: userMessages("Analyze companies") });
    const steps = await result.steps;

    // The turn completed normally (4 SQL steps + 1 text step), not an error.
    expect(steps.length).toBe(5);
    // The summary ran on the TURN model (the fallback), and the separate model
    // was never invoked.
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
    expect(summaryModelDoGenerateCalls).toBe(0);
    // The injected summary still lands in context — compaction still happened.
    expect(JSON.stringify(capturedPrompts)).toContain(COMPACTION_SUMMARY_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// Client-facing stream marker at the runAgent seam (#3761)
// ---------------------------------------------------------------------------

describe("agent compaction — client stream marker (#3761)", () => {
  const saved: Record<string, string | undefined> = {};
  const REQ_ID = "compaction-marker-test-req";

  beforeEach(() => {
    callId = 0;
    capturedPrompts = [];
    summarizerCalls = 0;
    summarizerPrompts = [];
    summaryModelDoGenerateCalls = 0;
    summaryMockModel = null;
    summaryModelResolutionThrows = false;
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
    clearStreamWriter(REQ_ID);
    summaryModelResolutionThrows = false;
    _resetSettingsCache();
  });

  /**
   * Drive a turn inside a request context with a registered stream writer — the
   * same seam the chat route uses (`setStreamWriter` + `withRequestContext`) — and
   * capture every part the agent writes to the stream via `getStreamWriter()`.
   */
  async function runCapturingMarkers(
    content: string,
  ): Promise<Array<{ type: string; data?: unknown; transient?: boolean }>> {
    const parts: Array<{ type: string; data?: unknown; transient?: boolean }> = [];
    const fakeWriter = {
      write: (p: { type: string; data?: unknown; transient?: boolean }) => {
        parts.push(p);
      },
      merge: () => {},
      onError: () => {},
    } as unknown as Parameters<typeof setStreamWriter>[1];
    await withRequestContext({ requestId: REQ_ID }, async () => {
      setStreamWriter(REQ_ID, fakeWriter);
      const result = await runAgent({ messages: userMessages(content) });
      await result.steps;
    });
    return parts;
  }

  it("a compacting turn writes a data-compaction marker the client can observe", async () => {
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.1";
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "2";
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "1000";
    _resetSettingsCache();

    const parts = await runCapturingMarkers("Analyze companies");

    const markers = parts.filter((p) => p.type === COMPACTION_STREAM_PART_TYPE);
    expect(markers.length).toBeGreaterThanOrEqual(1);

    const data = markers[0].data as {
      ran: boolean;
      summarizedMessages: number;
      pinnedMessages: number;
      beforeTokens: number;
      afterTokens: number;
    };
    expect(data.ran).toBe(true);
    expect(data.summarizedMessages).toBeGreaterThan(0);
    expect(data.pinnedMessages).toBeGreaterThan(0);
    expect(data.beforeTokens).toBeGreaterThan(0);
    // It is a transient notification, not persisted answer content.
    expect(markers[0].transient).toBe(true);
  });

  it("a non-compacting turn (flag off, default) writes NO marker", async () => {
    // Do not enable compaction — the seam is skipped entirely.
    const parts = await runCapturingMarkers("Analyze companies");
    expect(parts.some((p) => p.type === COMPACTION_STREAM_PART_TYPE)).toBe(false);
  });

  it("a throwing writer (closed stream) never disrupts the compacting turn", async () => {
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.1";
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "2";
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "1000";
    _resetSettingsCache();

    // A writer whose write() throws (e.g. the client aborted) must be absorbed
    // by the marker's fail-soft catch — the turn still completes.
    const throwingWriter = {
      write: () => {
        throw new Error("stream closed (test)");
      },
      merge: () => {},
      onError: () => {},
    } as unknown as Parameters<typeof setStreamWriter>[1];

    const steps = await withRequestContext({ requestId: REQ_ID }, async () => {
      setStreamWriter(REQ_ID, throwingWriter);
      const result = await runAgent({ messages: userMessages("Analyze companies") });
      return result.steps;
    });

    // Compaction ran (summarizer fired) and the turn finished its 5 steps despite
    // the writer throwing on every marker write.
    expect(steps.length).toBe(5);
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
  });

  it("an enabled turn that never crosses the threshold writes NO marker", async () => {
    // Enabled but a huge window so the small context never trips the trigger.
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.85";
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "2";
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "10000000";
    _resetSettingsCache();

    const parts = await runCapturingMarkers("Analyze companies");
    expect(parts.some((p) => p.type === COMPACTION_STREAM_PART_TYPE)).toBe(false);
    expect(summarizerCalls).toBe(0);
  });
});
