/**
 * Compact-on-resume integration tests at the `runAgent`/resume seam
 * (#3762 — PRD #3751, Compaction slice 3).
 *
 * The highest-value compaction trigger is the durable RESUME entry point: a turn
 * interrupted for hours/days re-enters `runAgent({ resume })` with a rehydrated
 * transcript that may already exceed the context window. Compaction must run
 * BEFORE the first re-entered model call, so the resumed turn fits the window
 * instead of dying on its first step.
 *
 * This slice adds NO new runtime path: compaction lives at the shared `runAgent`
 * seam via `streamText`'s `prepareStep`, which the AI SDK invokes before EVERY
 * step — including step 0, whose input messages on a resumed turn ARE the
 * rehydrated transcript (`resume.transcript` supersedes `messages`). So the
 * step-0 `prepareStep` call already evaluates the same fill-fraction trigger on
 * the rehydrated transcript and rewrites the messages the model sees. These
 * tests LOCK that behaviour at the resume seam with a mock language model — they
 * are the executable proof of the architecture decision, not a second code path.
 *
 * Mocks mirror agent-compaction-integration.test.ts (provider / semantic /
 * connection / just-bash / cache) plus agent-resume.test.ts's internal-DB spy,
 * since resume drives the durable checkpoint writes too.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import type { ModelMessage, UIMessage } from "ai";
import { trace, type Span, type Tracer, type TracerProvider } from "@opentelemetry/api";
import { createConnectionMock } from "@atlas/api/testing/connection";
import * as realInternal from "@atlas/api/lib/db/internal";

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

// ---------------------------------------------------------------------------
// Recording tracer — capture the atlas.agent span attributes (AC5).
// Mirrors agent-compaction-integration.test.ts: register BEFORE importing the
// agent graph so the API's proxy tracer delegates to this provider.
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

trace.disable();
trace.setGlobalTracerProvider(recordingProvider);

function agentSpan(): RecordedSpan | undefined {
  return recordedSpans.find((s) => s.name === "atlas.agent");
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockModel: InstanceType<typeof MockLanguageModelV3>;

void mock.module("@atlas/api/lib/providers", () => ({
  getModel: () => mockModel,
  getProviderType: () => "anthropic" as const,
  getModelFromWorkspaceConfig: () => mockModel,
  getWorkspaceProviderType: () => "anthropic" as const,
  getDefaultProvider: () => "anthropic" as const,
  isGatewayAnthropicModel: (modelId: string) =>
    modelId.includes("anthropic") || modelId.includes("claude"),
  // The summary model resolves to the turn model (the unset-knob default).
  getSummaryModel: () => mockModel,
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

// SQL connection spy — a resumed turn whose completed steps are already in the
// transcript must NOT re-run those tools. The resumed model emits only the final
// text step, so this must stay at 0.
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
  getCache: () => ({
    get: () => null,
    set: () => {},
    stats: () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }),
  }),
  buildCacheKey: () => "mock-key",
  cacheEnabled: () => false,
  getDefaultTtl: () => 300000,
  flushCache: () => {},
  setCacheBackend: () => {},
  _resetCache: () => {},
}));

// Internal-DB spy — resume drives durable checkpoint writes. `hasInternalDB`
// toggles the no-DB case (AC4); `internalExecute` is a sink we never assert on
// here (agent-resume.test.ts owns the durable-write assertions).
let hasInternalDB = true;
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: () => {},
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

const { runAgent } = await import("@atlas/api/lib/agent");
const { invalidateExploreBackend } = await import("@atlas/api/lib/tools/explore");
const { COMPACTION_SUMMARY_PREFIX, COMPACTION_STREAM_PART_TYPE } = await import(
  "@atlas/api/lib/agent-compaction"
);
const { _resetSettingsCache } = await import("@atlas/api/lib/settings");
const { withRequestContext } = await import("@atlas/api/lib/logger");
const { setStreamWriter, clearStreamWriter } = await import("@atlas/api/lib/tools/python-stream");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

/** Captured `prompt` (provider-format messages) from each turn-loop model call. */
let capturedPrompts: unknown[] = [];
/** Captured `prompt` from each summarizer (`doGenerate`) call. */
let summarizerPrompts: unknown[] = [];
/** How many times the summarizer ran (`doGenerate`). */
let summarizerCalls = 0;

const FINAL_TEXT_STEP: LanguageModelV3StreamPart[] = [
  { type: "text-delta", id: "text-0", delta: "Done." },
  { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
];

function sqlStep(marker: string): LanguageModelV3StreamPart[] {
  return [
    {
      type: "tool-call",
      toolCallId: `call-${marker}`,
      toolName: "executeSQL",
      input: JSON.stringify({ sql: `SELECT id AS ${marker} FROM companies`, explanation: marker }),
    },
    { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } },
  ];
}

/**
 * A model that emits ONLY the final text step — the resumed continuation. Its
 * `doStream` captures each turn-loop prompt; `doGenerate` is the summarizer
 * path. `modelId` selects the per-model context window the trigger resolves
 * (#3760): `claude-*` → 200k.
 */
function finalTextOnlyModel(modelId = "claude-opus-4-8"): InstanceType<typeof MockLanguageModelV3> {
  return new MockLanguageModelV3({
    modelId,
    doStream: async (options) => {
      capturedPrompts.push(options.prompt);
      return { stream: convertArrayToReadableStream(FINAL_TEXT_STEP) };
    },
    doGenerate: async (options) => {
      summarizerCalls++;
      summarizerPrompts.push(options.prompt);
      return {
        content: [{ type: "text", text: "GENERATED RESUME SUMMARY" }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: MOCK_USAGE,
        warnings: [],
      };
    },
  });
}

/**
 * A resumed continuation that emits `steps` SQL steps then a final text step.
 * Lets a test drive ≥2 re-entered steps so `prepareStep` fires on a still-growing
 * older slice — exercising the rolling (incremental) summary path on resume, not
 * just the step-0 compaction of the rehydrated transcript.
 */
function continuationModel(
  sqlMarkers: readonly string[],
  modelId = "claude-opus-4-8",
): InstanceType<typeof MockLanguageModelV3> {
  const steps: LanguageModelV3StreamPart[][] = [
    ...sqlMarkers.map((m) => sqlStep(m)),
    FINAL_TEXT_STEP,
  ];
  let idx = 0;
  return new MockLanguageModelV3({
    modelId,
    doStream: async (options) => {
      capturedPrompts.push(options.prompt);
      const chunks = idx >= steps.length ? steps[steps.length - 1] : steps[idx++];
      return { stream: convertArrayToReadableStream(chunks) };
    },
    doGenerate: async (options) => {
      summarizerCalls++;
      summarizerPrompts.push(options.prompt);
      return {
        content: [{ type: "text", text: "GENERATED RESUME SUMMARY" }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: MOCK_USAGE,
        warnings: [],
      };
    },
  });
}

/**
 * A resumed continuation whose summarizer (`doGenerate`) THROWS on every call.
 * Exercises the fail-soft catch at the compaction seam (`agent.ts` —
 * "continuing with full context"): a days-long resumed turn whose summarizer
 * blips on re-entry must still complete, never die on the compaction pass.
 */
function summarizerThrowsModel(modelId = "claude-opus-4-8"): InstanceType<typeof MockLanguageModelV3> {
  return new MockLanguageModelV3({
    modelId,
    doStream: async (options) => {
      capturedPrompts.push(options.prompt);
      return { stream: convertArrayToReadableStream(FINAL_TEXT_STEP) };
    },
    doGenerate: async () => {
      summarizerCalls++;
      throw new Error("summarizer model unavailable (test)");
    },
  });
}

function userMessages(content: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text: content }] }];
}

/**
 * Build a rehydrated transcript of `steps` completed executeSQL steps. Each step
 * is an assistant tool-call message + its tool result, marked with a unique
 * `marker{i}` so a test can assert which steps were pinned verbatim vs. folded
 * into the summary. The transcript ends on a tool result — exactly the shape a
 * mid-flight checkpoint stores — so the resumed model must make ≥1 more call.
 */
function rehydratedTranscript(steps: number): ModelMessage[] {
  const transcript: ModelMessage[] = [{ role: "user", content: "Analyze companies" }];
  for (let i = 0; i < steps; i++) {
    transcript.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${i}`,
          toolName: "executeSQL",
          input: { sql: `SELECT id AS marker${i} FROM companies`, explanation: `marker${i}` },
        },
      ],
    });
    transcript.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${i}`,
          toolName: "executeSQL",
          output: { type: "json", value: { rows: [{ marker: `marker${i}` }] } },
        },
      ],
    });
  }
  return transcript;
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

describe("agent compaction — compact-on-resume seam (#3762)", () => {
  const saved: Record<string, string | undefined> = {};
  const origDurability = process.env.ATLAS_DURABILITY_ENABLED;

  beforeEach(() => {
    capturedPrompts = [];
    summarizerPrompts = [];
    summarizerCalls = 0;
    sqlQueryCount = 0;
    hasInternalDB = true;
    recordedSpans.length = 0;
    invalidateExploreBackend();
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.ATLAS_TABLE_WHITELIST;
    delete process.env.ATLAS_SANDBOX_URL;
    process.env.ATLAS_DURABILITY_ENABLED = "true";
    for (const k of COMPACTION_ENV_KEYS) saved[k] = process.env[k];
    _resetSettingsCache();
    mockModel = finalTextOnlyModel();
  });

  afterEach(() => {
    for (const k of COMPACTION_ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
    if (origDurability === undefined) delete process.env.ATLAS_DURABILITY_ENABLED;
    else process.env.ATLAS_DURABILITY_ENABLED = origDurability;
    _resetSettingsCache();
  });

  /** Enable compaction with a tiny window so the rehydrated transcript trips it. */
  function enableCompaction(): void {
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.1";
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "2";
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "1000";
    _resetSettingsCache();
  }

  const RESUMED_RUN_ID = "77777777-7777-7777-7777-777777777777";

  // AC1 — a resumed run whose rehydrated transcript exceeds the threshold is
  // compacted before re-entry, and the resumed turn continues to completion.
  it("compacts the rehydrated transcript before re-entry and completes the resumed turn", async () => {
    enableCompaction();
    const transcript = rehydratedTranscript(6);

    const result = await runAgent({
      messages: userMessages("Analyze companies"),
      conversationId: "conv-resume-1",
      resume: { runId: RESUMED_RUN_ID, transcript, priorStepIndex: 6 },
    });
    const steps = await result.steps;

    // The resumed turn ran to completion (the single final text step), not an error.
    expect(steps.length).toBe(1);

    // The completed executeSQL steps were already in the transcript — the resumed
    // model emitted only text — so NO SQL re-ran on resume.
    expect(sqlQueryCount).toBe(0);

    // Compaction ran on the rehydrated transcript: the summarizer fired and the
    // re-entered model call received the injected summary (so the first resumed
    // step saw a compacted context, not the over-window transcript).
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
    const allPrompts = JSON.stringify(capturedPrompts);
    expect(allPrompts).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(allPrompts).toContain("GENERATED RESUME SUMMARY");
  });

  // AC1 (realistic resume-then-keep-working) — a turn resumed over-threshold
  // that emits another step before finishing. The step-0 pass compacts the
  // rehydrated transcript; the step-1 pass rolls the prior summary forward over
  // only the newly-aged-out step (the incremental path), rather than re-reading
  // the whole older slice. Proves compact-on-resume composes with the in-turn
  // rolling summary, not just the one-shot step-0 case.
  it("rolls the summary forward incrementally when the resumed turn keeps working", async () => {
    enableCompaction();
    mockModel = continuationModel(["resume0"]); // one more SQL step, then text → 2 re-entered steps
    const transcript = rehydratedTranscript(6);

    const result = await runAgent({
      messages: userMessages("Analyze companies"),
      conversationId: "conv-resume-roll",
      resume: { runId: RESUMED_RUN_ID, transcript, priorStepIndex: 6 },
    });
    const steps = await result.steps;

    // The continuation ran 2 re-entered steps (one SQL + the final text).
    expect(steps.length).toBe(2);
    // The SQL step the resumed model itself emitted DID run (it is new work, not a
    // replay of a completed step already in the transcript).
    expect(sqlQueryCount).toBe(1);

    // The threshold trips on both re-entered steps, so the summarizer runs more
    // than once. The FIRST pass summarizes the rehydrated older slice; the later
    // pass takes the rolling path — folding only the newly-aged-out step into the
    // prior running summary (its prompt carries the "Existing running summary"
    // frame), keeping per-step summarization input bounded on resume too.
    expect(summarizerCalls).toBeGreaterThanOrEqual(2);
    const laterPrompts = JSON.stringify(summarizerPrompts.slice(1));
    expect(laterPrompts).toContain("Existing running summary");
  });

  // AC1 (fail-soft) — a summarizer failure during compact-on-resume must NOT cost
  // the turn its answer. The fail-soft catch at the compaction seam logs and
  // continues with the full (uncompacted) context, so a days-long resumed turn
  // whose summarizer blips on re-entry still completes.
  it("continues the resumed turn with full context when the summarizer throws (fail-soft)", async () => {
    enableCompaction();
    mockModel = summarizerThrowsModel();
    const transcript = rehydratedTranscript(6);

    const result = await runAgent({
      messages: userMessages("Analyze companies"),
      conversationId: "conv-resume-failsoft",
      resume: { runId: RESUMED_RUN_ID, transcript, priorStepIndex: 6 },
    });
    const steps = await result.steps;

    // The compaction pass was attempted (summarizer fired) and threw…
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
    // …but the turn still completed its single re-entered step rather than dying.
    expect(steps.length).toBe(1);
    expect(sqlQueryCount).toBe(0);
    // No summary was injected — the seam fell back to the full transcript, which
    // therefore still carries the oldest step verbatim.
    const allPrompts = JSON.stringify(capturedPrompts);
    expect(allPrompts).not.toContain(COMPACTION_SUMMARY_PREFIX);
    expect(allPrompts).toContain("marker0");
  });

  // AC2 — pinned content (system prompt + recent N steps) survives; older
  // history is replaced by the summary.
  it("pins the system prompt + most-recent N steps and folds older steps into the summary", async () => {
    enableCompaction();
    const transcript = rehydratedTranscript(6);

    const result = await runAgent({
      messages: userMessages("Analyze companies"),
      conversationId: "conv-resume-2",
      resume: { runId: RESUMED_RUN_ID, transcript, priorStepIndex: 6 },
    });
    await result.steps;

    // The (only) re-entered model call is the resumed continuation. With N=2 the
    // two most-recent steps (marker4, marker5) are pinned and the older ones
    // (marker0..marker3) are folded into the summary.
    const prompt = JSON.stringify(capturedPrompts[capturedPrompts.length - 1]);

    // System prompt is pinned (sent as a system message, never summarized).
    expect(prompt).toContain("expert data analyst");
    // Summary stands in for the older history.
    expect(prompt).toContain(COMPACTION_SUMMARY_PREFIX);
    // Most-recent N steps survive verbatim.
    expect(prompt).toContain("marker5");
    expect(prompt).toContain("marker4");
    // Older steps are gone from the verbatim context (folded into the summary).
    expect(prompt).not.toContain("marker0");
    expect(prompt).not.toContain("marker1");
    expect(prompt).not.toContain("marker2");
    expect(prompt).not.toContain("marker3");
  });

  // AC3 — a resumed run UNDER the threshold re-enters without compaction.
  it("a resumed run under the threshold re-enters without compaction", async () => {
    // Enabled, but a huge window so the small rehydrated transcript never trips it.
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.85";
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "2";
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "10000000";
    _resetSettingsCache();
    const transcript = rehydratedTranscript(3);

    const result = await runAgent({
      messages: userMessages("Analyze companies"),
      conversationId: "conv-resume-3",
      resume: { runId: RESUMED_RUN_ID, transcript, priorStepIndex: 3 },
    });
    const steps = await result.steps;

    expect(steps.length).toBe(1);
    expect(summarizerCalls).toBe(0);
    const allPrompts = JSON.stringify(capturedPrompts);
    expect(allPrompts).not.toContain(COMPACTION_SUMMARY_PREFIX);
    // The older steps are still present verbatim — nothing was folded.
    expect(allPrompts).toContain("marker0");

    const span = agentSpan();
    expect(span).toBeDefined();
    expect(span!.attributes["atlas.compaction.ran"]).toBeUndefined();
  });

  // AC4 (compaction disabled) — resume behaves exactly as without this slice.
  it("with compaction disabled, a resumed run re-enters with the full transcript (no summary)", async () => {
    // Default off: do not enable compaction.
    const transcript = rehydratedTranscript(6);

    const result = await runAgent({
      messages: userMessages("Analyze companies"),
      conversationId: "conv-resume-4",
      resume: { runId: RESUMED_RUN_ID, transcript, priorStepIndex: 6 },
    });
    const steps = await result.steps;

    expect(steps.length).toBe(1);
    expect(summarizerCalls).toBe(0);
    const allPrompts = JSON.stringify(capturedPrompts);
    expect(allPrompts).not.toContain(COMPACTION_SUMMARY_PREFIX);
    // The full transcript re-entered verbatim — even the oldest step survives.
    expect(allPrompts).toContain("marker0");
    expect(allPrompts).toContain("marker5");

    const span = agentSpan();
    expect(span).toBeDefined();
    expect(span!.attributes["atlas.compaction.ran"]).toBeUndefined();
  });

  // AC4 (no internal DB) — resume behaves exactly as without this slice. With no
  // internal DB the durable layer is Noop; the resume seam itself is unchanged,
  // and compaction (which is independent of the DB) still degrades to off here
  // because the flag is off — i.e. identical to today.
  it("with no internal database, a resumed run re-enters unchanged (Noop durable layer)", async () => {
    hasInternalDB = false;
    // Compaction left at its default (off): the no-DB path must match today's.
    const transcript = rehydratedTranscript(6);

    const result = await runAgent({
      messages: userMessages("Analyze companies"),
      conversationId: "conv-resume-5",
      resume: { runId: RESUMED_RUN_ID, transcript, priorStepIndex: 6 },
    });
    const steps = await result.steps;

    expect(steps.length).toBe(1);
    expect(sqlQueryCount).toBe(0);
    expect(summarizerCalls).toBe(0);
    expect(JSON.stringify(capturedPrompts)).not.toContain(COMPACTION_SUMMARY_PREFIX);
  });

  // AC4 (no internal DB, compaction ENABLED) — the durable-checkpoint Noop path
  // (no DB ⇒ checkpoints/resume-state no-op) must NOT be entangled with the
  // compaction seam. #3762's AC4 is "compaction disabled OR no internal DB", so
  // the two degradations are independent: with NO internal DB but compaction
  // turned ON, a resumed over-threshold transcript must STILL compact before
  // re-entry and complete — compaction lives at the prepareStep seam and never
  // reads the internal DB, so the absent durable layer can't disable it.
  it("with compaction enabled but no internal database, the resumed turn still compacts", async () => {
    hasInternalDB = false;
    enableCompaction();
    const transcript = rehydratedTranscript(6);

    const result = await runAgent({
      messages: userMessages("Analyze companies"),
      conversationId: "conv-resume-nodb-enabled",
      resume: { runId: RESUMED_RUN_ID, transcript, priorStepIndex: 6 },
    });
    const steps = await result.steps;

    // Compaction fired and the turn completed — the missing durable layer (Noop)
    // did not disable the compaction seam.
    expect(steps.length).toBe(1);
    expect(sqlQueryCount).toBe(0);
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(capturedPrompts)).toContain(COMPACTION_SUMMARY_PREFIX);
  });

  // AC5 — compact-on-resume emits the same observability signals as live-turn
  // compaction: the OTel span attribute, the operator log line (covered by the
  // shared seam), and the client-facing stream marker.
  it("emits the atlas.compaction.ran span attribute on a compacting resume", async () => {
    enableCompaction();
    const transcript = rehydratedTranscript(6);

    const result = await runAgent({
      messages: userMessages("Analyze companies"),
      conversationId: "conv-resume-6",
      resume: { runId: RESUMED_RUN_ID, transcript, priorStepIndex: 6 },
    });
    await result.steps;

    const span = agentSpan();
    expect(span).toBeDefined();
    expect(span!.attributes["atlas.compaction.ran"]).toBe(true);
    expect(span!.attributes["atlas.compaction.before_tokens"]).toBeGreaterThan(0);
    expect(span!.attributes["atlas.compaction.summarized_messages"]).toBeGreaterThan(0);
  });

  it("writes the client-facing data-compaction stream marker on a compacting resume", async () => {
    enableCompaction();
    const transcript = rehydratedTranscript(6);
    const REQ_ID = "compaction-resume-marker-req";

    const parts: Array<{ type: string; data?: unknown; transient?: boolean }> = [];
    const fakeWriter = {
      write: (p: { type: string; data?: unknown; transient?: boolean }) => {
        parts.push(p);
      },
      merge: () => {},
      onError: () => {},
    } as unknown as Parameters<typeof setStreamWriter>[1];

    try {
      await withRequestContext({ requestId: REQ_ID }, async () => {
        setStreamWriter(REQ_ID, fakeWriter);
        const result = await runAgent({
          messages: userMessages("Analyze companies"),
          conversationId: "conv-resume-7",
          resume: { runId: RESUMED_RUN_ID, transcript, priorStepIndex: 6 },
        });
        await result.steps;
      });

      const markers = parts.filter((p) => p.type === COMPACTION_STREAM_PART_TYPE);
      expect(markers.length).toBeGreaterThanOrEqual(1);
      const data = markers[0].data as { ran: boolean; summarizedMessages: number; pinnedMessages: number };
      expect(data.ran).toBe(true);
      expect(data.summarizedMessages).toBeGreaterThan(0);
      expect(data.pinnedMessages).toBeGreaterThan(0);
      expect(markers[0].transient).toBe(true);
    } finally {
      clearStreamWriter(REQ_ID);
    }
  });
});
