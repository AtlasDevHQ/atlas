/**
 * Truth-table tests for `decideInterjection`, plus the #2299 acceptance
 * suite for the sensitivity presets (formerly `sensitivity-presets.test.ts`,
 * merged here — both files drove the same module, `../policy`, and their
 * threshold-ordering, boundary and channel-override cases were the same
 * assertions written twice).
 *
 * The PRD calls this out specifically: regressions in proactive chat
 * land here, so the matrix covers (isQuestion × confidence ×
 * sensitivity × workspace enabled × channel allowed × channel denied ×
 * recent activity). We assert on the `reason` tag so a regression
 * points at the exact branch that flipped.
 *
 * Per PRD #2291 §Stability bar, the threshold values themselves are MVP
 * placeholders. If a tuning PR changes them, `DOCUMENTED_THRESHOLDS` below
 * must change in the same PR — that is the point of pinning them here.
 */

import { describe, expect, it } from "bun:test";
import {
  decideInterjection,
  RECENT_INTERJECTION_COOLDOWN_MS,
  SENSITIVITY_THRESHOLDS,
} from "../policy";
import type {
  ChannelProactiveConfig,
  ClassificationResult,
  SensitivityPreset,
  WorkspaceProactiveConfig,
} from "../types";

// ---------------------------------------------------------------------------
// Documented values (kept in sync with policy.ts)
// ---------------------------------------------------------------------------

/**
 * Mirror of the MVP threshold table. Co-locating it in the test makes
 * the contract obvious to a reviewer reading the spec; an unannounced
 * tweak to `SENSITIVITY_THRESHOLDS` fails the first assertion below.
 */
const DOCUMENTED_THRESHOLDS: Record<SensitivityPreset, number> = {
  cautious: 0.85,
  balanced: 0.7,
  eager: 0.55,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workspace(overrides: Partial<WorkspaceProactiveConfig> = {}): WorkspaceProactiveConfig {
  return {
    enabled: true,
    sensitivity: "balanced",
    classifierMode: "regex-prefilter",
    ...overrides,
  };
}

function classification(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    isQuestion: true,
    confidence: 0.9,
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Short-circuit gates (highest precedence first)
// ---------------------------------------------------------------------------

describe("decideInterjection — short-circuit gates", () => {
  it("skips when workspace.enabled is false even with high confidence", () => {
    const decision = decideInterjection({
      classification: classification({ confidence: 0.99 }),
      workspace: workspace({ enabled: false }),
      channelAllowed: true,
    });
    expect(decision).toEqual({ action: "skip", reason: "workspace-disabled" });
  });

  it("skips when channel is not on the allowlist", () => {
    const decision = decideInterjection({
      classification: classification(),
      workspace: workspace(),
      channelAllowed: false,
    });
    expect(decision).toEqual({ action: "skip", reason: "channel-not-allowed" });
  });

  it("skips when channel has an explicit deny override", () => {
    const channel: ChannelProactiveConfig = { channelId: "C1", allow: false };
    const decision = decideInterjection({
      classification: classification(),
      workspace: workspace(),
      channel,
      channelAllowed: true,
    });
    expect(decision).toEqual({ action: "skip", reason: "channel-denied" });
  });

  it("skips when the classifier says not a question", () => {
    const decision = decideInterjection({
      classification: classification({ isQuestion: false, confidence: 0.99 }),
      workspace: workspace(),
      channelAllowed: true,
    });
    expect(decision).toEqual({ action: "skip", reason: "not-a-question" });
  });
});

// ---------------------------------------------------------------------------
// Confidence × sensitivity truth table
// ---------------------------------------------------------------------------

describe("decideInterjection — confidence × sensitivity", () => {
  const cases: Array<{
    sensitivity: SensitivityPreset;
    confidence: number;
    expected: "react" | "skip";
  }> = [
    // Cautious threshold (0.85)
    { sensitivity: "cautious", confidence: 0.84, expected: "skip" },
    { sensitivity: "cautious", confidence: 0.85, expected: "react" },
    { sensitivity: "cautious", confidence: 0.99, expected: "react" },

    // Balanced threshold (0.70)
    { sensitivity: "balanced", confidence: 0.69, expected: "skip" },
    { sensitivity: "balanced", confidence: 0.70, expected: "react" },
    { sensitivity: "balanced", confidence: 0.84, expected: "react" },

    // Eager threshold (0.55)
    { sensitivity: "eager", confidence: 0.54, expected: "skip" },
    { sensitivity: "eager", confidence: 0.55, expected: "react" },
    { sensitivity: "eager", confidence: 0.71, expected: "react" },
  ];

  for (const { sensitivity, confidence, expected } of cases) {
    it(`sensitivity=${sensitivity} confidence=${confidence} → ${expected}`, () => {
      const decision = decideInterjection({
        classification: classification({ confidence }),
        workspace: workspace({ sensitivity }),
        channelAllowed: true,
      });
      expect(decision.action).toBe(expected);
      if (expected === "skip") {
        expect(decision.reason).toBe("below-confidence-threshold");
      } else {
        expect(decision.reason).toBe("passes-threshold");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Per-channel sensitivity override
// ---------------------------------------------------------------------------

describe("decideInterjection — channel sensitivity override", () => {
  it("falls back to workspace sensitivity when channel does not override", () => {
    const decision = decideInterjection({
      classification: classification({ confidence: 0.6 }),
      workspace: workspace({ sensitivity: "cautious" }),
      channel: { channelId: "C1", allow: true }, // no sensitivity override
      channelAllowed: true,
    });
    expect(decision).toEqual({ action: "skip", reason: "below-confidence-threshold" });
  });
});

// ---------------------------------------------------------------------------
// Recent-activity rate limit
// ---------------------------------------------------------------------------

describe("decideInterjection — recent activity rate limit", () => {
  it("skips when a recent interjection is within the cooldown window", () => {
    const decision = decideInterjection({
      classification: classification(),
      workspace: workspace(),
      channelAllowed: true,
      recentActivity: { lastInterjectionAt: NOW - 1000 },
      now: () => NOW,
    });
    expect(decision).toEqual({ action: "skip", reason: "rate-limited" });
  });

  it("reacts again once the cooldown has elapsed", () => {
    const decision = decideInterjection({
      classification: classification(),
      workspace: workspace(),
      channelAllowed: true,
      recentActivity: {
        lastInterjectionAt: NOW - RECENT_INTERJECTION_COOLDOWN_MS - 1,
      },
      now: () => NOW,
    });
    expect(decision).toEqual({ action: "react", reason: "passes-threshold" });
  });

  it("treats missing recent activity as no rate-limit", () => {
    const decision = decideInterjection({
      classification: classification(),
      workspace: workspace(),
      channelAllowed: true,
      recentActivity: undefined,
    });
    expect(decision.action).toBe("react");
  });
});

// ---------------------------------------------------------------------------
// Threshold sanity
// ---------------------------------------------------------------------------

describe("SENSITIVITY_THRESHOLDS (acceptance #2299)", () => {
  it("matches the documented MVP values for every preset", () => {
    expect(SENSITIVITY_THRESHOLDS).toEqual(DOCUMENTED_THRESHOLDS);
  });

  it("defines exactly the three documented presets — no more, no fewer", () => {
    expect(Object.keys(SENSITIVITY_THRESHOLDS).sort()).toEqual([
      "balanced",
      "cautious",
      "eager",
    ]);
  });

  it("orders cautious > balanced > eager", () => {
    expect(SENSITIVITY_THRESHOLDS.cautious).toBeGreaterThan(SENSITIVITY_THRESHOLDS.balanced);
    expect(SENSITIVITY_THRESHOLDS.balanced).toBeGreaterThan(SENSITIVITY_THRESHOLDS.eager);
  });

  it("keeps every threshold inside the [0.5, 0.95] tuning window from the PRD", () => {
    // The stability-bar comment in policy.ts caps the per-preset tuning
    // range. If a tuning PR moves outside the window, that's a product
    // decision that should be visible at code-review time — this guard
    // forces the conversation. (Subsumes the older [0, 1] clamp check.)
    for (const v of Object.values(SENSITIVITY_THRESHOLDS)) {
      expect(v).toBeGreaterThanOrEqual(0.5);
      expect(v).toBeLessThanOrEqual(0.95);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-channel sensitivity override — end-to-end (acceptance #2299)
// ---------------------------------------------------------------------------

describe("decideInterjection — per-channel sensitivity override (acceptance #2299)", () => {
  // The classifier returns a confidence of 0.6. That confidence
  // straddles the three presets:
  //   cautious  (0.85)  ⇒ below threshold ⇒ skip
  //   balanced  (0.70)  ⇒ below threshold ⇒ skip
  //   eager     (0.55)  ⇒ above threshold ⇒ react
  const STRADDLE_CONFIDENCE = 0.6;

  it("channel sensitivity=eager flips a workspace=cautious skip into a react", () => {
    // Demoable from the issue: "switch a channel from Balanced to Eager
    // and observe more interjections". This is that exact path.
    const workspaceDecision = decideInterjection({
      classification: classification({ confidence: STRADDLE_CONFIDENCE }),
      workspace: workspace({ sensitivity: "cautious" }),
      channelAllowed: true,
    });
    expect(workspaceDecision).toEqual({
      action: "skip",
      reason: "below-confidence-threshold",
    });

    const channelDecision = decideInterjection({
      classification: classification({ confidence: STRADDLE_CONFIDENCE }),
      workspace: workspace({ sensitivity: "cautious" }),
      channel: { channelId: "C1", allow: true, sensitivity: "eager" },
      channelAllowed: true,
    });
    expect(channelDecision).toEqual({
      action: "react",
      reason: "passes-threshold",
    });
  });

  it("channel sensitivity=cautious tightens a workspace=eager react into a skip", () => {
    // The inverse path — a globally-eager workspace can still pin a
    // single channel back to cautious for executive-level rooms.
    const workspaceDecision = decideInterjection({
      classification: classification({ confidence: STRADDLE_CONFIDENCE }),
      workspace: workspace({ sensitivity: "eager" }),
      channelAllowed: true,
    });
    expect(workspaceDecision).toEqual({
      action: "react",
      reason: "passes-threshold",
    });

    const channelDecision = decideInterjection({
      classification: classification({ confidence: STRADDLE_CONFIDENCE }),
      workspace: workspace({ sensitivity: "eager" }),
      channel: { channelId: "C1", allow: true, sensitivity: "cautious" },
      channelAllowed: true,
    });
    expect(channelDecision).toEqual({
      action: "skip",
      reason: "below-confidence-threshold",
    });
  });

  it("channel deny override beats channel sensitivity (kill-switch precedence)", () => {
    // Even with a permissive sensitivity, an explicit channel deny
    // wins. Documents the precedence order so a future refactor can't
    // silently swap them.
    const decision = decideInterjection({
      classification: classification({ confidence: 0.99 }),
      workspace: workspace({ sensitivity: "cautious" }),
      channel: { channelId: "C1", allow: false, sensitivity: "eager" },
      channelAllowed: true,
    });
    expect(decision).toEqual({ action: "skip", reason: "channel-denied" });
  });
});
