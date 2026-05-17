/**
 * Truth-table tests for `decideInterjection`.
 *
 * The PRD calls this out specifically: regressions in proactive chat
 * land here, so the matrix covers (isQuestion × confidence ×
 * sensitivity × workspace enabled × channel allowed × channel denied ×
 * recent activity). We assert on the `reason` tag so a regression
 * points at the exact branch that flipped.
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
  it("uses channel sensitivity when present", () => {
    // Workspace is cautious (0.85), channel is eager (0.55).
    // A 0.6 confidence should react under channel, not under workspace.
    const decision = decideInterjection({
      classification: classification({ confidence: 0.6 }),
      workspace: workspace({ sensitivity: "cautious" }),
      channel: { channelId: "C1", allow: true, sensitivity: "eager" },
      channelAllowed: true,
    });
    expect(decision).toEqual({ action: "react", reason: "passes-threshold" });
  });

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

describe("SENSITIVITY_THRESHOLDS", () => {
  it("orders cautious > balanced > eager", () => {
    expect(SENSITIVITY_THRESHOLDS.cautious).toBeGreaterThan(SENSITIVITY_THRESHOLDS.balanced);
    expect(SENSITIVITY_THRESHOLDS.balanced).toBeGreaterThan(SENSITIVITY_THRESHOLDS.eager);
  });

  it("clamps all thresholds inside [0, 1]", () => {
    for (const v of Object.values(SENSITIVITY_THRESHOLDS)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
