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
    expect(s.contextWindowTokens).toBe(200_000);
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

    expect(resolveCompactionSettings(ORG).pinnedRecentSteps).toBe(20); // workspace wins
    expect(resolveCompactionSettings().pinnedRecentSteps).toBe(10); // platform wins over env
  });

  it("hot-reloads — a new override is visible without restart", async () => {
    expect(resolveCompactionSettings(ORG).enabled).toBe(false);
    await setSetting("ATLAS_COMPACTION_ENABLED", "true", "tester", ORG);
    expect(resolveCompactionSettings(ORG).enabled).toBe(true);
  });

  it("falls back to defaults for out-of-range / unparseable values", () => {
    process.env.ATLAS_COMPACTION_FILL_FRACTION = "2"; // > 1
    process.env.ATLAS_COMPACTION_PINNED_RECENT_STEPS = "0"; // < min
    const s = resolveCompactionSettings();
    expect(s.fillFraction).toBe(0.85);
    expect(s.pinnedRecentSteps).toBe(6);
  });
});
