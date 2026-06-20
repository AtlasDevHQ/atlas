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
  COMPACTION_SUMMARY_PREFIX,
  type CompactionSettings,
} from "@atlas/api/lib/agent-compaction";
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

  it("defaults to OFF with sane defaults when nothing is set", () => {
    const s = resolveCompactionSettings();
    expect(s.enabled).toBe(false);
    expect(s.fillFraction).toBe(0.85);
    expect(s.pinnedRecentSteps).toBe(6);
    // No modelId + no override ⇒ safe default window, tagged as such.
    expect(s.contextWindowTokens).toBe(200_000);
    expect(s.contextWindowSource).toBe("default");
  });

  it("reads the env-var tier (Tier 3)", () => {
    process.env.ATLAS_COMPACTION_ENABLED = "true";
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.5";
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "3";
    const s = resolveCompactionSettings();
    expect(s.enabled).toBe(true);
    expect(s.fillFraction).toBe(0.5);
    expect(s.pinnedRecentSteps).toBe(3);
  });

  it("workspace override beats platform override beats env (precedence)", async () => {
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "3"; // env
    await setSetting("ATLAS_COMPACTION_PINNED_RECENT_STEPS", "10"); // platform
    await setSetting("ATLAS_COMPACTION_PINNED_RECENT_STEPS", "20", "tester", ORG); // workspace

    expect(resolveCompactionSettings(undefined, ORG).pinnedRecentSteps).toBe(20); // workspace wins
    expect(resolveCompactionSettings().pinnedRecentSteps).toBe(10); // platform wins over env
  });

  it("hot-reloads — a new override is visible without restart", async () => {
    expect(resolveCompactionSettings(undefined, ORG).enabled).toBe(false);
    await setSetting("ATLAS_COMPACTION_ENABLED", "true", "tester", ORG);
    expect(resolveCompactionSettings(undefined, ORG).enabled).toBe(true);
  });

  it("falls back to defaults for out-of-range / unparseable values", () => {
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "2"; // > 1
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "0"; // < min
    const s = resolveCompactionSettings();
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

describe("resolveCompactionSettings — per-model window + override (#3760)", () => {
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

  it("resolves the window from the catalog per model (200k vs 128k for the SAME fraction)", () => {
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "0.9";

    const opus = resolveCompactionSettings("claude-opus-4-8");
    const gpt = resolveCompactionSettings("gpt-4o");

    expect(opus.contextWindowTokens).toBe(200_000);
    expect(opus.contextWindowSource).toBe("catalog");
    expect(gpt.contextWindowTokens).toBe(128_000);
    expect(gpt.contextWindowSource).toBe("catalog");

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

  it("falls back to the safe default window for a model absent from the catalog (no throw)", () => {
    const s = resolveCompactionSettings("some-bespoke-local-model");
    expect(s.contextWindowTokens).toBe(200_000);
    expect(s.contextWindowSource).toBe("default");
  });

  it("override knob pins the window and takes precedence over the catalog", async () => {
    // Catalog would give Opus 200k; the explicit override wins.
    await setSetting("ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS", "50000");
    const s = resolveCompactionSettings("claude-opus-4-8");
    expect(s.contextWindowTokens).toBe(50_000);
    expect(s.contextWindowSource).toBe("override");
  });

  it("override knob covers a model the catalog can't resolve", async () => {
    await setSetting("ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS", "64000");
    const s = resolveCompactionSettings("some-bespoke-local-model");
    expect(s.contextWindowTokens).toBe(64_000);
    expect(s.contextWindowSource).toBe("override");
  });

  it("workspace override beats platform override for the window (precedence + hot-reload)", async () => {
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "32000"; // env
    await setSetting("ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS", "80000"); // platform
    await setSetting("ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS", "90000", "tester", ORG); // workspace

    expect(resolveCompactionSettings("claude-opus-4-8", ORG).contextWindowTokens).toBe(90_000);
    expect(resolveCompactionSettings("claude-opus-4-8").contextWindowTokens).toBe(80_000);
  });

  it("ignores an invalid override and resolves from the catalog instead", () => {
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "not-a-number";
    const s = resolveCompactionSettings("gpt-4o");
    expect(s.contextWindowTokens).toBe(128_000);
    expect(s.contextWindowSource).toBe("catalog");
  });

  it("ignores a numeric-but-too-small override and falls through to the catalog (F4)", () => {
    // A real number below MIN_CONTEXT_WINDOW_TOKENS is distinct from not-a-number:
    // it parses fine but is out of range, so it must fall through to the catalog.
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "500";
    const s = resolveCompactionSettings("gpt-4o");
    expect(s.contextWindowTokens).toBe(128_000);
    expect(s.contextWindowSource).toBe("catalog");
  });

  it("ignores an absurdly-large override and falls through to the catalog (F2 ceiling)", () => {
    // No upper bound once let an absurd value silently disable compaction (the
    // trigger never crosses). An out-of-range-HIGH override now falls through to
    // the catalog like the too-small / not-a-number cases.
    process.env.ATLAS_COMPACTION_CONTEXT_WINDOW_TOKENS = "999999999999";
    const s = resolveCompactionSettings("gpt-4o");
    expect(s.contextWindowTokens).toBe(128_000);
    expect(s.contextWindowSource).toBe("catalog");
  });

  it("treats a blank override as 'use the catalog' (the registry default)", () => {
    // Default is "" — unset knob ⇒ catalog resolution, never a pinned 0/empty.
    const s = resolveCompactionSettings("claude-opus-4-8");
    expect(s.contextWindowSource).toBe("catalog");
    expect(s.contextWindowTokens).toBe(200_000);
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

  it("default-off: resolution is disabled regardless of model (no behavior change)", () => {
    expect(resolveCompactionSettings("claude-opus-4-8").enabled).toBe(false);
    expect(resolveCompactionSettings("gpt-4o").enabled).toBe(false);
    expect(resolveCompactionSettings().enabled).toBe(false);
  });

  it("the coarse default window (200k) is preserved for a model the catalog can't resolve", () => {
    // #3759 used a flat 200k; an uncatalogued model still resolves to exactly
    // that, so the trigger point for unknown models is byte-for-byte unchanged.
    const s = resolveCompactionSettings("totally-unknown-model");
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
      contextWindowSource: "catalog",
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
