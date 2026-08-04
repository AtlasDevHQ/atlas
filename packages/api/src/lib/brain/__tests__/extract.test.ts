/**
 * The extraction fiber's DB-free surface (#4771, ADR-0036 §Ingestion).
 *
 * The `-pg` sibling drives whole cycles against a live schema. What lives here
 * is everything that needs no database and would otherwise be tested nowhere:
 *
 *   1. **`resolveExtractionModel`** — the BYO-key seam. It is the control that
 *      keeps Atlas from silently billing its own key for a workspace that chose
 *      its own provider, and every fiber test injects PAST it, so without this
 *      file it executes in no test at all.
 *   2. **`llmFactExtractor`** — the caps and the prompt contract. `MAX_CANDIDATES`
 *      is a spend bound on a model that will not stop; the truncation marker is
 *      what keeps a cut-off transcript from being extracted as if complete.
 *   3. **The decoupling itself** (acceptance criterion 1). It holds structurally
 *      today — nothing under `lib/brain/ingest/` imports this module — and the
 *      only thing that would notice someone adding the synchronous
 *      ingest→extract fast-path the header rejects is a source scan.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect, Layer } from "effect";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { RawWorkspaceModelConfig } from "@atlas/api/lib/auth/credentials";
import type { ModelRouterShape } from "@atlas/api/lib/effect/services";

// Set before the first `runEnterprise` call, because `getEnterpriseRuntime()`
// memoizes `ConditionalEELayer` for the process lifetime and that layer decides
// ONCE — at first build — whether to import `@atlas/ee/layers` at all. Without
// it the no-op default wins forever, every test sees `available: false`, and the
// EE-unavailable assertion below would pass for the wrong reason.
// (`enterprise-config.ts::isEnterpriseEnabled`, which gates the probe under
// test, reads the same var per call.) `??=` per the test-discipline rule.
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";

// ---------------------------------------------------------------------------
// A controllable ModelRouter, reached the way production reaches it
// ---------------------------------------------------------------------------

/** What the stub router should do for the next call. */
let routerAvailable = true;
let routerConfig: RawWorkspaceModelConfig | null = null;
let routerFailure: Error | null = null;

void mock.module("@atlas/ee/layers", () => ({
  EELayer: Layer.unwrapEffect(
    Effect.sync(() => {
      // oxlint-disable-next-line @typescript-eslint/no-require-imports -- the Layer is built lazily inside the mock factory, which must stay synchronous (bun:test deadlocks on an async factory).
      const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
      return Layer.succeed(services.ModelRouter, {
        // A GETTER, not a captured value: `runEnterprise` memoizes this Layer
        // into a process-lifetime runtime, so the object is built once on the
        // first call and a later `routerAvailable = false` would never be seen.
        get available() {
          return routerAvailable;
        },
        getWorkspaceModelConfig: () => Effect.die("not stubbed"),
        getWorkspaceModelConfigRaw: () =>
          routerFailure ? Effect.fail(routerFailure) : Effect.succeed(routerConfig),
        setWorkspaceModelConfig: () => Effect.die("not stubbed"),
        deleteWorkspaceModelConfig: () => Effect.die("not stubbed"),
        testModelConfig: () => Effect.die("not stubbed"),
        reconcileModelDeprecation: () =>
          Effect.succeed({ status: "healthy" as const, suggestion: null }),
        parseBedrockCredentialBundle: () => null,
      } satisfies ModelRouterShape);
    }),
  ),
}));

const { resolveExtractionModel, llmFactExtractor, isBrainExtractionEnabled } = await import(
  "@atlas/api/lib/brain/extract"
);

const WORKSPACE = "ws-brain-extract";

function anthropicConfig(overrides: Partial<RawWorkspaceModelConfig> = {}): RawWorkspaceModelConfig {
  return {
    provider: "anthropic",
    model: "claude-test-model",
    baseUrl: null,
    bedrockRegion: null,
    credentials: { provider: "anthropic", apiKey: "sk-ant-test" },
    ...overrides,
  };
}

beforeEach(() => {
  routerAvailable = true;
  routerConfig = null;
  routerFailure = null;
});

// ---------------------------------------------------------------------------
// The BYO-key seam
// ---------------------------------------------------------------------------

describe("resolveExtractionModel", () => {
  test("uses the workspace's own configuration when it has one", async () => {
    routerConfig = anthropicConfig();
    const resolved = await resolveExtractionModel(WORKSPACE);

    expect(resolved).not.toBeNull();
    // The model id is what lands in provenance — a reviewer has to be able to
    // tell which model asserted a claim.
    expect(resolved?.modelId).toBe("claude-test-model");
  });

  test("refuses when model routing is unavailable on an enterprise deployment", async () => {
    // The defect this pins: the no-op router returns `null` for every
    // workspace, which is INDISTINGUISHABLE from "this workspace has no BYO
    // config". An EE module that failed to load would therefore have moved
    // every BYO workspace's entire backlog onto Atlas's own key, unattended.
    routerAvailable = false;
    expect(await resolveExtractionModel(WORKSPACE)).toBeNull();

    // The control, in the same test so the two branches are shown to DIFFER:
    // identical inputs but an available router falls through to the platform
    // default. Without it, `toBeNull()` alone could be satisfied by any of the
    // function's other three null paths.
    routerAvailable = true;
    expect(await resolveExtractionModel(WORKSPACE)).not.toBeNull();
  });

  test("a self-hosted install still gets the platform default", async () => {
    // The complementary arm, and the reason the probe is gated rather than
    // unconditional: on self-hosted there IS no EE layer, so `available: false`
    // is correct and expected. Refusing there would stall every self-hosted
    // drain forever, under an ERROR line claiming it was an enterprise
    // deployment.
    const prior = process.env.ATLAS_ENTERPRISE_ENABLED;
    delete process.env.ATLAS_ENTERPRISE_ENABLED;
    try {
      routerAvailable = false;
      routerConfig = null;
      expect(await resolveExtractionModel(WORKSPACE)).not.toBeNull();
    } finally {
      if (prior === undefined) delete process.env.ATLAS_ENTERPRISE_ENABLED;
      else process.env.ATLAS_ENTERPRISE_ENABLED = prior;
    }
  });

  test("refuses when the configuration cannot be read", async () => {
    routerFailure = new Error("workspace key could not be decrypted");
    expect(await resolveExtractionModel(WORKSPACE)).toBeNull();
  });

  test("refuses a configuration that reads but cannot be built into a model", async () => {
    // `custom` with no base URL throws inside `getModelFromWorkspaceConfig`.
    // Left outside the guard this escaped as a per-episode throw, was counted
    // as a TRANSIENT failure, and was retried every five minutes forever — the
    // wrong verdict for a fault only an admin can clear.
    routerConfig = anthropicConfig({
      provider: "custom",
      baseUrl: null,
      credentials: { provider: "custom", apiKey: "key" },
    });
    expect(await resolveExtractionModel(WORKSPACE)).toBeNull();
  });

  test("refuses a bedrock configuration whose credential bundle is malformed", async () => {
    // `bundle: null` is the union's post-decrypt malformed signal — precisely
    // the "key that no longer decrypts" case, and it arrives as DATA rather
    // than as a thrown error, so it bypasses the read guard entirely.
    routerConfig = anthropicConfig({
      provider: "bedrock",
      bedrockRegion: "us-east-1",
      credentials: { provider: "bedrock", bundle: null },
    });
    expect(await resolveExtractionModel(WORKSPACE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The extractor's caps and prompt contract
// ---------------------------------------------------------------------------

describe("llmFactExtractor", () => {
  const episode = {
    id: "ep-1",
    workspaceId: WORKSPACE,
    source: "slack",
    sourceId: "C01:1",
    sourceActor: "U1",
    occurredAt: new Date("2026-06-21T09:00:00.000Z"),
    visibleTo: ["org"],
  };

  /** A model that answers with `facts` and records the call it was given. */
  function modelReturning(facts: unknown[]): {
    model: LanguageModel;
    calls: { prompt: string; temperature: number | undefined }[];
  } {
    const calls: { prompt: string; temperature: number | undefined }[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options): Promise<LanguageModelV3GenerateResult> => {
        const text = options.prompt
          .flatMap((m) =>
            Array.isArray(m.content)
              ? m.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
              : [],
          )
          .join("\n");
        calls.push({ prompt: text, temperature: options.temperature });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ facts }) }],
          finishReason: { unified: "stop" as const, raw: "end_turn" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 10, text: 10, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    return { model: model as unknown as LanguageModel, calls };
  }

  const oneFact = [
    { subject: "deploy window", predicate: "is", object: "Thursdays", cardinality: "multi" },
  ];

  test("pins temperature to 0 — the dedupe it feeds is lexical, not semantic", async () => {
    // Not a quality preference: the reconcile stage collapses a re-extraction
    // only when the model reproduces its own output closely enough to land in
    // the same SLOT, and re-extraction after a crash is the whole idempotence
    // story. Since #5020 that slot is `alias(lexicalNorm(surface))`, so a
    // re-phrasing that differs only in case or separators now collapses too —
    // the same determinism argument at a coarser grain. It is still nowhere
    // near enough to cover "is" vs "is on", which is why the temperature is
    // pinned rather than relied upon to matter less.
    const { model, calls } = modelReturning(oneFact);
    await llmFactExtractor({ episode, body: "hello", model, modelId: "m" });
    expect(calls[0]?.temperature).toBe(0);
  });

  test("caps how many claims one episode may produce", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      subject: `s${i}`,
      predicate: "is",
      object: `o${i}`,
      cardinality: "multi",
    }));
    const { model } = modelReturning(many);
    const candidates = await llmFactExtractor({ episode, body: "hello", model, modelId: "m" });

    expect(candidates).toHaveLength(10);
  });

  test("marks a truncated body so the model is not extracting from a severed clause", async () => {
    const { model, calls } = modelReturning(oneFact);
    await llmFactExtractor({
      episode,
      body: "x".repeat(9_000),
      model,
      modelId: "m",
    });

    expect(calls[0]?.prompt).toContain("[truncated at 8000 characters]");
    // The marker alone would pass if the `slice` were dropped — then the model
    // would receive the whole 9,000 characters AND a claim that it did not.
    expect(calls[0]?.prompt.length).toBeLessThan(9_000);
  });

  test("leaves a body under the cap unmarked", async () => {
    const { model, calls } = modelReturning(oneFact);
    await llmFactExtractor({ episode, body: "the deploy window is Thursdays", model, modelId: "m" });

    expect(calls[0]?.prompt).not.toContain("truncated");
    expect(calls[0]?.prompt).toContain("the deploy window is Thursdays");
  });

  test("records the model id in provenance detail", async () => {
    const { model } = modelReturning(oneFact);
    const candidates = await llmFactExtractor({
      episode,
      body: "hello",
      model,
      modelId: "claude-test-model",
    });

    expect(candidates[0]?.detail).toMatchObject({ model: "claude-test-model" });
    expect(candidates[0]?.predicateCardinality).toBe("multi");
  });

  test("an episode with no durable claim yields no candidates", async () => {
    // The modal production case by a wide margin — most chat is not a fact.
    const { model } = modelReturning([]);
    expect(await llmFactExtractor({ episode, body: "morning all", model, modelId: "m" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The enablement gate
// ---------------------------------------------------------------------------

describe("isBrainExtractionEnabled", () => {
  const prior = process.env.ATLAS_BRAIN_EXTRACTION_ENABLED;
  afterEach(() => {
    if (prior === undefined) delete process.env.ATLAS_BRAIN_EXTRACTION_ENABLED;
    else process.env.ATLAS_BRAIN_EXTRACTION_ENABLED = prior;
  });

  test("is OFF unless explicitly switched on", () => {
    // Default-OFF is load-bearing while the milestone is in flight: the review
    // surface (#4772) is what makes an extracted fact usable, so a `default:
    // "true"` slip would spend every workspace's model budget filling a queue
    // no UI can read.
    delete process.env.ATLAS_BRAIN_EXTRACTION_ENABLED;
    expect(isBrainExtractionEnabled()).toBe(false);
  });

  test("only the exact string `true` enables it", () => {
    process.env.ATLAS_BRAIN_EXTRACTION_ENABLED = "yes";
    expect(isBrainExtractionEnabled()).toBe(false);
    process.env.ATLAS_BRAIN_EXTRACTION_ENABLED = "true";
    expect(isBrainExtractionEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 1, structurally
// ---------------------------------------------------------------------------

describe("fetch and extraction stay decoupled", () => {
  test("nothing in the ingest path imports the extraction fiber", async () => {
    // The criterion is "episode freshness never blocks on LLM latency/429s".
    // Today that holds because the ONLY consumer of this module is the
    // scheduler registration — but the synchronous ingest→extract fast-path the
    // header rejects would be a three-line change that no behavioural test
    // notices, because it would still produce correct facts. It would just
    // couple the connector's cycle time to a model's.
    const { Glob } = await import("bun");
    const root = new URL("../ingest/", import.meta.url).pathname;
    const offenders: string[] = [];
    let scanned = 0;
    // All three import forms. A `from "…"` -only pattern would miss
    // `await import(...)` and `require(...)` — which is how the PRODUCTION
    // consumer imports this module (`layers.ts`), and therefore the idiom
    // whoever added the fast-path would reach for first.
    const importsExtract = /(from\s+|import\(\s*|require\(\s*)["'][^"']*brain\/extract["']/;
    for await (const file of new Glob("**/*.ts").scan({ cwd: root, absolute: true })) {
      if (file.includes("__tests__")) continue;
      scanned++;
      const source = await Bun.file(file).text();
      if (importsExtract.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    // A moved or renamed directory would otherwise make this pass having read
    // nothing at all.
    expect(scanned).toBeGreaterThan(0);
  });
});

afterAll(() => {
  mock.restore();
});
