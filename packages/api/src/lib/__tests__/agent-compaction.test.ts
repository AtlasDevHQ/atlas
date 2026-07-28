/**
 * Unit tests for context compaction (#3759 — PRD #3751).
 *
 * Covers the pure pieces of the compaction pass — token estimation, the
 * trigger decision, the older-history → summary rewrite (pinning the most
 * recent N steps), and the `atlas.compaction.*` span-attribute builder — plus
 * the settings-registry resolution (precedence + hot-reload) of the three
 * operator knobs. The end-to-end behaviour at the `runAgent` seam (a turn
 * driven past the threshold compacts and completes) is covered by
 * `agent-compaction-integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import {
  resolveCompactionSettings,
  resolveModelContextWindow,
  estimateContextTokens,
  shouldCompact,
  pinBoundaryIndex,
  compactOlderHistory,
  compactionSpanAttributes,
  buildCompactionMarker,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_STREAM_PART_TYPE,
  type CompactionSettings,
} from "@atlas/api/lib/agent-compaction";
import { __resetGatewayCatalogCacheForTests } from "@atlas/api/lib/gateway-catalog";
import { setSetting, _resetSettingsCache } from "@atlas/api/lib/settings";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENABLED: CompactionSettings = {
  enabled: true,
  fillFraction: 0.85,
  pinnedRecentSteps: 2,
  contextWindowTokens: 1000,
  contextWindowSource: "override",
};

/** Build a flat user→(assistant→tool)* transcript with `steps` agent steps. */
function transcript(steps: number): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: "user", content: "What is the revenue trend?" },
  ];
  for (let i = 1; i <= steps; i++) {
    messages.push({ role: "assistant", content: `assistant step ${i}` });
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${i}`,
          toolName: "executeSQL",
          output: { type: "text", value: `tool result ${i}` },
        },
      ],
    });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Token estimation + trigger
// ---------------------------------------------------------------------------

describe("estimateContextTokens", () => {
  it("counts the system prompt plus every message (coarse chars/4)", () => {
    const system = "x".repeat(400); // ~100 tokens
    const messages: ModelMessage[] = [{ role: "user", content: "y".repeat(400) }];
    const est = estimateContextTokens(system, messages);
    // system 400 chars + JSON.stringify(message) > 400 chars, all / 4
    expect(est).toBeGreaterThanOrEqual(200);
  });

  it("accepts a SystemModelMessage object for the system prompt", () => {
    const est = estimateContextTokens({ content: "z".repeat(400) }, []);
    expect(est).toBe(100);
  });

  it("returns 0 for an empty context", () => {
    expect(estimateContextTokens(undefined, [])).toBe(0);
  });
});

describe("shouldCompact", () => {
  it("fires once tokens cross fillFraction × window", () => {
    // threshold = 0.85 × 1000 = 850
    expect(shouldCompact(849, ENABLED)).toBe(false);
    expect(shouldCompact(850, ENABLED)).toBe(true);
    expect(shouldCompact(2000, ENABLED)).toBe(true);
  });

  it("never fires when disabled, regardless of size", () => {
    const disabled = { ...ENABLED, enabled: false };
    expect(shouldCompact(1_000_000, disabled)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pin boundary
// ---------------------------------------------------------------------------

describe("pinBoundaryIndex", () => {
  it("points at the N-th-from-last assistant message", () => {
    // user, a1, t1, a2, t2, a3, t3  → indices 0..6
    const messages = transcript(3);
    // pin last 2 steps → boundary at a2 (index 3)
    expect(pinBoundaryIndex(messages, 2)).toBe(3);
    expect(messages[3]).toMatchObject({ role: "assistant", content: "assistant step 2" });
  });

  it("returns 0 when there are fewer than N assistant turns (nothing to pin past)", () => {
    expect(pinBoundaryIndex(transcript(1), 2)).toBe(0); // 1 step < N=2 → nothing older
  });

  it("treats the leading user turn as older history once N steps exist", () => {
    // transcript(2) = [user, a1, t1, a2, t2]; pin both steps → only the user
    // question is older (boundary at a1, index 1), so it gets summarized.
    expect(pinBoundaryIndex(transcript(2), 2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Compaction rewrite
// ---------------------------------------------------------------------------

describe("compactOlderHistory", () => {
  it("replaces older history with ONE summary message and pins the recent N steps", async () => {
    const messages = transcript(4); // user + 4×(assistant,tool) = 9 messages
    const result = await compactOlderHistory({
      messages,
      pinnedRecentSteps: 2,
      summarize: async () => "SUMMARY OF EARLIER WORK",
    });

    expect(result).not.toBeNull();
    const out = result!;

    // First message is the single generated summary, framed for the model.
    expect(out.messages[0]).toMatchObject({ role: "user" });
    expect(out.messages[0].content).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(out.messages[0].content).toContain("SUMMARY OF EARLIER WORK");

    // Exactly one summary message + the pinned recent slice (2 steps → 4 msgs).
    expect(out.messages.length).toBe(1 + 4);
    expect(out.pinnedMessageCount).toBe(4);

    // The pinned recent steps survive verbatim…
    expect(out.messages).toContainEqual({ role: "assistant", content: "assistant step 3" });
    expect(out.messages).toContainEqual({ role: "assistant", content: "assistant step 4" });
    // …and the older steps are folded into the summary, not present verbatim.
    const serialized = JSON.stringify(out.messages);
    expect(serialized).not.toContain("assistant step 1");
    expect(serialized).not.toContain("assistant step 2");
    expect(serialized).not.toContain("What is the revenue trend?");

    // Older history was summarized, not dropped: count is reported.
    expect(out.summarizedMessageCount).toBe(messages.length - 4);
  });

  it("pins a recent slice that begins with an assistant message (valid ordering)", async () => {
    const messages = transcript(3);
    const out = await compactOlderHistory({
      messages,
      pinnedRecentSteps: 1,
      summarize: async () => "s",
    });
    // [summary(user), assistant step 3, tool result 3]
    expect(out!.messages[1]).toMatchObject({ role: "assistant" });
  });

  it("returns null when there is nothing older to summarize (fewer than N steps)", async () => {
    const out = await compactOlderHistory({
      messages: transcript(1), // 1 step, pin 2 → nothing older
      pinnedRecentSteps: 2,
      summarize: async () => "should not be called",
    });
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Span attributes
// ---------------------------------------------------------------------------

describe("compactionSpanAttributes", () => {
  it("emits the before/after token + message counts under atlas.compaction.*", () => {
    expect(
      compactionSpanAttributes({
        beforeTokens: 900,
        afterTokens: 300,
        beforeMessages: 9,
        afterMessages: 5,
        summarizedMessages: 4,
      }),
    ).toEqual({
      "atlas.compaction.ran": true,
      "atlas.compaction.before_tokens": 900,
      "atlas.compaction.after_tokens": 300,
      "atlas.compaction.before_messages": 9,
      "atlas.compaction.after_messages": 5,
      "atlas.compaction.summarized_messages": 4,
    });
  });
});

// ---------------------------------------------------------------------------
// Client-facing stream marker (#3761)
// ---------------------------------------------------------------------------

describe("buildCompactionMarker", () => {
  it("builds a marker with the ran discriminator and the pass counts", () => {
    expect(
      buildCompactionMarker({
        beforeTokens: 900,
        afterTokens: 300,
        summarizedMessages: 4,
        pinnedMessages: 5,
      }),
    ).toEqual({
      ran: true,
      summarizedMessages: 4,
      pinnedMessages: 5,
      beforeTokens: 900,
      afterTokens: 300,
    });
  });

  it("pins the wire part type clients match on", () => {
    // The literal is a public contract — clients dispatch on `part.type`, so a
    // rename is a breaking wire change and must be caught here.
    expect(COMPACTION_STREAM_PART_TYPE).toBe("data-compaction");
  });
});

// ---------------------------------------------------------------------------
// Settings resolution — precedence + hot-reload (workspace > platform > env > default)
// ---------------------------------------------------------------------------

const mockPool: InternalPool = {
  query: async () => ({ rows: [] }),
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

const ORG = "org-compaction-test";

describe("resolveCompactionSettings — registry precedence + hot-reload", () => {
  const origEnabled = process.env.ATLAS_COMPACTION_ENABLED;
  const origFraction = process.env.ATLAS_COMPACTION_FILL_FRACTION;
  const origSteps = process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS;
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.ATLAS_COMPACTION_ENABLED;
    delete process.env.ATLAS_COMPACTION_FILL_FRACTION;
    delete process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS;
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
    _resetSettingsCache();
  });

  afterEach(() => {
    if (origEnabled !== undefined) process.env.ATLAS_COMPACTION_ENABLED = origEnabled;
    else delete process.env.ATLAS_COMPACTION_ENABLED;
    if (origFraction !== undefined) process.env.ATLAS_COMPACTION_FILL_FRACTION = origFraction;
    else delete process.env.ATLAS_COMPACTION_FILL_FRACTION;
    if (origSteps !== undefined) process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = origSteps;
    else delete process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS;
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
    _resetSettingsCache();
  });

  it("defaults to OFF with sane defaults when nothing is set", async () => {
    const s = await resolveCompactionSettings();
    expect(s.enabled).toBe(false);
    expect(s.fillFraction).toBe(0.85);
    expect(s.pinnedRecentSteps).toBe(6);
    // No modelId + no override ⇒ safe default window, tagged as such.
    expect(s.contextWindowTokens).toBe(200_000);
    expect(s.contextWindowSource).toBe("default");
  });

  it("reads the env-var tier (Tier 3)", async () => {
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.5";
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "3";
    const s = await resolveCompactionSettings();
    expect(s.enabled).toBe(true);
    expect(s.fillFraction).toBe(0.5);
    expect(s.pinnedRecentSteps).toBe(3);
  });

  it("workspace override beats platform override beats env (precedence)", async () => {
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "3"; // env
    await setSetting("ATLAS_COMPACTION_PINNED_RECENT_STEPS", "10"); // platform
    await setSetting("ATLAS_COMPACTION_PINNED_RECENT_STEPS", "20", "tester", ORG); // workspace

    expect((await resolveCompactionSettings(undefined, ORG)).pinnedRecentSteps).toBe(20); // workspace wins
    expect((await resolveCompactionSettings()).pinnedRecentSteps).toBe(10); // platform wins over env
  });

  it("hot-reloads — a new override is visible without restart", async () => {
    expect((await resolveCompactionSettings(undefined, ORG)).enabled).toBe(false);
    await setSetting("ATLAS_COMPACTION_ENABLED", "true", "tester", ORG);
    expect((await resolveCompactionSettings(undefined, ORG)).enabled).toBe(true);
  });

  it("falls back to defaults for out-of-range / unparseable values", async () => {
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "2"; // > 1
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "0"; // < min
    const s = await resolveCompactionSettings();
    expect(s.fillFraction).toBe(0.85);
    expect(s.pinnedRecentSteps).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Per-model context-window resolution (#3760)
// ---------------------------------------------------------------------------

describe("resolveModelContextWindow — static catalog (#3760)", () => {
  it("resolves Anthropic Claude ids (every id shape) to 200k", () => {
    expect(resolveModelContextWindow("claude-opus-4-8")).toBe(200_000);
    expect(resolveModelContextWindow("anthropic/claude-sonnet-4.6")).toBe(200_000);
    expect(resolveModelContextWindow("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(200_000);
  });

  it("resolves OpenAI gpt-4o to 128k and gpt-4.1 to 1M", () => {
    expect(resolveModelContextWindow("gpt-4o")).toBe(128_000);
    expect(resolveModelContextWindow("openai/gpt-4o-mini")).toBe(128_000);
    expect(resolveModelContextWindow("gpt-4.1")).toBe(1_000_000);
  });

  it("does not let the gpt-4.1 1M rule swallow the gpt-4-1106 Turbo (128k) id (F1 collision)", () => {
    // `gpt-4-1106*` is a 128k GPT-4-Turbo id whose prefix `gpt-4-1` once
    // substring-matched the 1M GPT-4.1 rule — 8× too large, compaction too late.
    expect(resolveModelContextWindow("gpt-4-1106-preview")).toBe(128_000);
    expect(resolveModelContextWindow("gpt-4-1106")).toBe(128_000);
    expect(resolveModelContextWindow("gpt-4-0125-preview")).toBe(128_000);
    // …while the real GPT-4.1 (dot AND dash form) still resolves to 1M.
    expect(resolveModelContextWindow("gpt-4.1")).toBe(1_000_000);
    expect(resolveModelContextWindow("gpt-4.1-mini")).toBe(1_000_000);
    expect(resolveModelContextWindow("openai/gpt-4-1")).toBe(1_000_000);
  });

  it("pins the load-bearing first-match ordering for collision-prone families (F4)", () => {
    // Gemini: the pro/flash pair is the most collision-prone — `gemini-1.5-pro`
    // (2M) must beat the broader `gemini-1.5`/`gemini` (1M) rule that follows it.
    expect(resolveModelContextWindow("gemini-1.5-pro")).toBe(2_000_000);
    expect(resolveModelContextWindow("gemini-1.5-flash")).toBe(1_000_000);
    // OpenAI GPT-4 ladder: bare `gpt-4` (8k) vs the more-specific `gpt-4-32k`.
    expect(resolveModelContextWindow("gpt-4")).toBe(8_192);
    expect(resolveModelContextWindow("gpt-4-32k")).toBe(32_768);
  });

  it("matches case-insensitively", () => {
    expect(resolveModelContextWindow("CLAUDE-OPUS-4-8")).toBe(200_000);
  });

  it("returns null for an unknown / uncatalogued model (caller falls back to default)", () => {
    expect(resolveModelContextWindow("some-bespoke-local-model")).toBeNull();
    expect(resolveModelContextWindow(undefined)).toBeNull();
    expect(resolveModelContextWindow("")).toBeNull();
  });
});

describe("resolveCompactionSettings — static per-family window + override (#3760)", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS;
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
    _resetSettingsCache();
  });

  afterEach(() => {
    delete process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS;
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
    _resetSettingsCache();
  });

  it("resolves the window from the static table per family (200k vs 128k for the SAME fraction)", async () => {
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.9";

    const opus = await resolveCompactionSettings("claude-opus-4-8");
    const gpt = await resolveCompactionSettings("gpt-4o");

    expect(opus.contextWindowTokens).toBe(200_000);
    expect(opus.contextWindowSource).toBe("static");
    expect(gpt.contextWindowTokens).toBe(128_000);
    expect(gpt.contextWindowSource).toBe("static");

    // Same fill fraction ⇒ DIFFERENT absolute trigger point per model. This is
    // the whole point of #3760: 0.9 means 180k tokens on Opus but 115.2k on
    // GPT-4o, so the smaller-window model compacts sooner.
    const opusTrigger = opus.fillFraction * opus.contextWindowTokens;
    const gptTrigger = gpt.fillFraction * gpt.contextWindowTokens;
    expect(opusTrigger).toBe(180_000);
    expect(gptTrigger).toBeCloseTo(115_200);
    expect(opusTrigger).toBeGreaterThan(gptTrigger);

    // And the trigger boundary reflects it: a context that trips GPT-4o does
    // not (yet) trip Opus. (shouldCompact short-circuits when disabled, so
    // assert against enabled copies of the resolved settings.)
    const gptOn = { ...gpt, enabled: true };
    const opusOn = { ...opus, enabled: true };
    expect(shouldCompact(120_000, gptOn)).toBe(true);
    expect(shouldCompact(120_000, opusOn)).toBe(false);

    delete process.env.ATLAS_COMPACTION_FILL_FRACTION;
  });

  it("falls back to the safe default window for a model absent from the static table (no throw)", async () => {
    const s = await resolveCompactionSettings("some-bespoke-local-model");
    expect(s.contextWindowTokens).toBe(200_000);
    expect(s.contextWindowSource).toBe("default");
  });

  it("override knob pins the window and takes precedence over every catalog tier", async () => {
    // The static table would give Opus 200k; the explicit override wins.
    await setSetting("ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS", "50000");
    const s = await resolveCompactionSettings("claude-opus-4-8");
    expect(s.contextWindowTokens).toBe(50_000);
    expect(s.contextWindowSource).toBe("override");
  });

  it("override knob covers a model no catalog tier can resolve", async () => {
    await setSetting("ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS", "64000");
    const s = await resolveCompactionSettings("some-bespoke-local-model");
    expect(s.contextWindowTokens).toBe(64_000);
    expect(s.contextWindowSource).toBe("override");
  });

  it("workspace override beats platform override for the window (precedence + hot-reload)", async () => {
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "32000"; // env
    await setSetting("ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS", "80000"); // platform
    await setSetting("ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS", "90000", "tester", ORG); // workspace

    expect((await resolveCompactionSettings("claude-opus-4-8", ORG)).contextWindowTokens).toBe(90_000);
    expect((await resolveCompactionSettings("claude-opus-4-8")).contextWindowTokens).toBe(80_000);
  });

  it("ignores an invalid override and resolves from the static table instead", async () => {
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "not-a-number";
    const s = await resolveCompactionSettings("gpt-4o");
    expect(s.contextWindowTokens).toBe(128_000);
    expect(s.contextWindowSource).toBe("static");
  });

  it("ignores a numeric-but-too-small override and falls through to the static table (F4)", async () => {
    // A real number below MIN_CONTEXT_WINDOW_TOKENS is distinct from not-a-number:
    // it parses fine but is out of range, so it must fall through to the static table.
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "500";
    const s = await resolveCompactionSettings("gpt-4o");
    expect(s.contextWindowTokens).toBe(128_000);
    expect(s.contextWindowSource).toBe("static");
  });

  it("ignores an absurdly-large override and falls through to the static table (F2 ceiling)", async () => {
    // No upper bound once let an absurd value silently disable compaction (the
    // trigger never crosses). An out-of-range-HIGH override now falls through to
    // the static table like the too-small / not-a-number cases.
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "999999999999";
    const s = await resolveCompactionSettings("gpt-4o");
    expect(s.contextWindowTokens).toBe(128_000);
    expect(s.contextWindowSource).toBe("static");
  });

  it("treats a blank override as 'resolve it for me' (the registry default)", async () => {
    // Default is "" — unset knob ⇒ tier-2/3 resolution, never a pinned 0/empty.
    const s = await resolveCompactionSettings("claude-opus-4-8");
    expect(s.contextWindowSource).toBe("static");
    expect(s.contextWindowTokens).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// Live gateway catalog tier (#4869), awaited once per turn (#4872)
// ---------------------------------------------------------------------------

describe("resolveCompactionSettings — live gateway catalog tier (#4869, #4872)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const realFetch = globalThis.fetch;
  let fetches = 0;

  const origEnabled = process.env.ATLAS_COMPACTION_ENABLED;
  /** Resolves the pending slow fetch, if the test armed one. */
  let releaseSlowFetch: (() => void) | undefined;

  /**
   * Serve `entries` from the gateway WITHOUT pre-warming the cache. Every test
   * below starts cold on purpose: since #4872 the resolver fetches for itself,
   * so "cold cache" is the state under test, not a setup step to get past.
   *
   * `slow: true` holds the response until `releaseSlowFetch` — a deferred gate
   * rather than a wall-clock delay, so the test decides when the fetch is
   * allowed to proceed instead of leaving a real timer pending past its own
   * `afterEach` (#4872 review).
   */
  function serveCatalog(entries: unknown[], opts: { slow?: boolean } = {}): void {
    globalThis.fetch = (async () => {
      fetches += 1;
      if (opts.slow) {
        await new Promise<void>((resolve) => {
          releaseSlowFetch = resolve;
        });
      }
      return new Response(JSON.stringify({ data: entries }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  }

  beforeEach(() => {
    fetches = 0;
    releaseSlowFetch = undefined;
    delete process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS;
    // Tier 2 is gated on compaction being ENABLED (#4872 review) — the window
    // only sizes the trigger, so a disabled turn never pays for the network.
    // Every test in this block is about that tier, so turn it on.
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
    _resetSettingsCache();
    __resetGatewayCatalogCacheForTests();
  });

  afterEach(() => {
    // Unblock any gated fetch so its promise can settle rather than dangling to
    // process exit. This does NOT wait for the load to land — it has several
    // more ticks of JSON parsing and normalizing to go, and will almost
    // certainly finish after the reset below. What actually stops it writing
    // into the next test is `cacheGeneration`, bumped by
    // `__resetGatewayCatalogCacheForTests`.
    releaseSlowFetch?.();
    globalThis.fetch = realFetch;
    delete process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS;
    if (origEnabled !== undefined) process.env.ATLAS_COMPACTION_ENABLED = origEnabled;
    else delete process.env.ATLAS_COMPACTION_ENABLED;
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
    _resetSettingsCache();
    __resetGatewayCatalogCacheForTests();
  });

  it("resolves the live window on the FIRST turn, from a cold cache", async () => {
    // The #4872 acceptance criterion, and the guard against the tier-ordering
    // hazard silently coming back. Before this, tier 2 read a cache some EARLIER
    // turn had to have warmed, so turn 1 always answered from the static table
    // (or the safe default) — and when the warm call drifted below the static
    // tier there was no turn 2 either.
    //
    // GLM is the sharpest case: the static table knows Claude/GPT/Gemini/
    // Mistral/Llama and nothing else, so without the catalog this workspace
    // compacts against the 200k safe default instead of its real 1.04M window.
    serveCatalog([{ id: "zai/glm-5.2", type: "language", context_window: 1_040_000 }]);

    const first = await resolveCompactionSettings("zai/glm-5.2");
    expect(first.contextWindowTokens).toBe(1_040_000);
    expect(first.contextWindowSource).toBe("gateway");
    expect(fetches).toBe(1);
  });

  it("beats the per-family static guess on turn 1 for the SaaS default models", async () => {
    // The bug #4872 retires the mechanism behind (#4869 review): the static
    // table maps EVERY `claude` id to 200k, so the tier-4 warm was unreachable
    // for Anthropic ids and `anthropic/claude-sonnet-5` sized compaction at
    // 200k against a real 1M window, on every turn, indefinitely.
    //
    // Asserted on the returned WINDOW, not on the fetch count: an assertion
    // that only proves "a fetch happened" is what let the previous shape look
    // covered while the value it produced was never used.
    serveCatalog([{ id: "anthropic/claude-sonnet-5", type: "language", context_window: 1_000_000 }]);

    const s = await resolveCompactionSettings("anthropic/claude-sonnet-5");
    expect(s.contextWindowTokens).toBe(1_000_000);
    expect(s.contextWindowSource).toBe("gateway");
  });

  it("still lets an explicit operator override win over the live catalog", async () => {
    serveCatalog([{ id: "zai/glm-5.2", type: "language", context_window: 1_040_000 }]);
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "50000";
    const s = await resolveCompactionSettings("zai/glm-5.2");
    expect(s.contextWindowTokens).toBe(50_000);
    expect(s.contextWindowSource).toBe("override");
    // Tier 1 short-circuits above the catalog, so the pinned turn doesn't even
    // reach the network.
    expect(fetches).toBe(0);
  });

  it("makes NO outbound call for a slashless BYOT/self-hosted id", async () => {
    // Air-gapped self-hosted deploys use hyphen-format ids. They must never
    // trigger an outbound call to the gateway — the id-shape gate is what
    // keeps the awaited tier 2 safe for them.
    serveCatalog([]);
    const s = await resolveCompactionSettings("claude-opus-4-8");
    expect(fetches).toBe(0);
    // ...and they still get a window, from the static table.
    expect(s.contextWindowTokens).toBe(200_000);
    expect(s.contextWindowSource).toBe("static");
  });

  it("falls through to the static table when the live catalog lacks the id", async () => {
    serveCatalog([{ id: "some/other-model", type: "language", context_window: 999 }]);
    const s = await resolveCompactionSettings("openai/gpt-4o");
    expect(s.contextWindowTokens).toBe(128_000);
    expect(s.contextWindowSource).toBe("static");
  });

  it("does not stall the turn on a slow gateway — bounded, then static fallback", async () => {
    // The failure story (#4872 AC). The catalog fetch's OWN ceiling is 10s,
    // which must never be spent in the turn path; the resolver bounds its wait
    // to `HOT_PATH_BUDGET_MS` and degrades to the static table. This gateway
    // would answer with the real 1M window, so a static-table result can only
    // mean the turn stopped waiting.
    serveCatalog(
      [{ id: "anthropic/claude-sonnet-5", type: "language", context_window: 1_000_000 }],
      { slow: true },
    );

    const started = Date.now();
    const s = await resolveCompactionSettings("anthropic/claude-sonnet-5");
    const elapsed = Date.now() - started;

    // Two-sided on purpose. The upper bound alone would also pass with the
    // budget set to 0 or the await deleted — i.e. it can't tell "bounded wait"
    // from "no wait at all", which is half the contract.
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(4_000);
    expect(s.contextWindowTokens).toBe(200_000);
    expect(s.contextWindowSource).toBe("static");
  });

  it("does not fail the turn when the gateway is unreachable", async () => {
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const s = await resolveCompactionSettings("anthropic/claude-sonnet-5");
    // Static table, not an error and not the bundled fallback manifest.
    expect(s.contextWindowTokens).toBe(200_000);
    expect(s.contextWindowSource).toBe("static");
    expect(fetches).toBe(1);
  });

  it("skips the network entirely when compaction is DISABLED (the shipped default)", async () => {
    // The window exists only to size the fill-fraction trigger, and compaction
    // ships off — so a default SaaS deploy must not spend up to
    // `HOT_PATH_BUDGET_MS` on the agent hot path computing a number that
    // `shouldCompact` will short-circuit past anyway (#4872 review).
    process.env.ATLAS_COMPACTION_ENABLED = "false";
    _resetSettingsCache();
    serveCatalog([{ id: "zai/glm-5.2", type: "language", context_window: 1_040_000 }]);

    const s = await resolveCompactionSettings("zai/glm-5.2");
    expect(s.enabled).toBe(false);
    expect(fetches).toBe(0);
    // Falls to the safe default — the static table has no `zai` rule — which is
    // exactly what a disabled turn resolved to before #4872.
    expect(s.contextWindowTokens).toBe(200_000);
    expect(s.contextWindowSource).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Compaction 1 (#3759) regression — per-model resolution must not change it
// ---------------------------------------------------------------------------

/** The flat window #3759 used before per-model resolution (#3760). */
const DEFAULT_WINDOW_3759 = 200_000;

describe("Compaction 1 invariants are unchanged (#3759 regression)", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    for (const k of [
      "ATLAS_COMPACTION_ENABLED",
      "ATLAS_COMPACTION_FILL_FRACTION",
      "ATLAS_COMPACTION_PINNED_RECENT_STEPS",
      "ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS",
    ]) delete process.env[k];
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
    _resetSettingsCache();
  });

  afterEach(() => {
    for (const k of [
      "ATLAS_COMPACTION_ENABLED",
      "ATLAS_COMPACTION_FILL_FRACTION",
      "ATLAS_COMPACTION_PINNED_RECENT_STEPS",
      "ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS",
    ]) delete process.env[k];
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
    _resetSettingsCache();
  });

  it("default-off: resolution is disabled regardless of model (no behavior change)", async () => {
    expect((await resolveCompactionSettings("claude-opus-4-8")).enabled).toBe(false);
    expect((await resolveCompactionSettings("gpt-4o")).enabled).toBe(false);
    expect((await resolveCompactionSettings()).enabled).toBe(false);
  });

  it("the coarse default window (200k) is preserved for a model no tier can resolve", async () => {
    // #3759 used a flat 200k; an uncatalogued model still resolves to exactly
    // that, so the trigger point for unknown models is byte-for-byte unchanged.
    const s = await resolveCompactionSettings("totally-unknown-model");
    expect(s.contextWindowTokens).toBe(DEFAULT_WINDOW_3759);
  });

  it("the trigger remains fillFraction × window (semantics unchanged)", () => {
    // Only the WINDOW value is resolved differently now; the comparison itself
    // (estimatedTokens >= fillFraction × window) is identical to #3759.
    const s: CompactionSettings = {
      enabled: true,
      fillFraction: 0.85,
      pinnedRecentSteps: 6,
      contextWindowTokens: 200_000,
      contextWindowSource: "static",
    };
    const threshold = 0.85 * 200_000; // 170k
    expect(shouldCompact(threshold - 1, s)).toBe(false);
    expect(shouldCompact(threshold, s)).toBe(true);
  });

  it("summarize-not-evict: older history is folded into one summary, recent steps pinned verbatim", async () => {
    // Pinning + summary-not-eviction is the #3759 contract; reassert it survives.
    const messages = transcript(4);
    const out = await compactOlderHistory({
      messages,
      pinnedRecentSteps: 2,
      summarize: async () => "ROLLED-UP SUMMARY",
    });
    expect(out).not.toBeNull();
    // One summary message + the pinned 2 steps (4 msgs); nothing dropped.
    expect(out!.messages[0].content).toContain("ROLLED-UP SUMMARY");
    expect(out!.pinnedMessageCount).toBe(4);
    expect(out!.summarizedMessageCount).toBe(messages.length - 4);
    // Recent steps verbatim; older steps folded into the summary, not evicted.
    expect(out!.messages).toContainEqual({ role: "assistant", content: "assistant step 4" });
    expect(JSON.stringify(out!.messages)).not.toContain("assistant step 1");
  });
});
