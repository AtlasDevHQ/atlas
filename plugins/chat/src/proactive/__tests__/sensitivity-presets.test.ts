/**
 * Acceptance test for slice #2299 — sensitivity presets + classifier mode.
 *
 * Purpose: document the exact threshold mapping inline in test code,
 * so a regression that flips a number in `SENSITIVITY_THRESHOLDS`
 * fails here with a clear assertion (rather than only surfacing as
 * subtle behaviour change in the truth-table tests).
 *
 * The truth-table coverage of `decideInterjection` lives in
 * `policy.test.ts`; this file is the narrower "presets are the
 * documented values, and the per-channel override path actually
 * threads through to a different decision" check that the issue
 * acceptance criteria call out explicitly.
 *
 * Per PRD #2291 §Stability bar, the threshold values themselves are
 * MVP placeholders. If a future tuning PR changes them, the
 * `DOCUMENTED_THRESHOLDS` block below must change in the same PR —
 * that's the point of pinning them here.
 */

import { describe, expect, it } from "bun:test";
import {
  decideInterjection,
  SENSITIVITY_THRESHOLDS,
} from "../policy";
import type {
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

function workspace(
  overrides: Partial<WorkspaceProactiveConfig> = {},
): WorkspaceProactiveConfig {
  return {
    enabled: true,
    sensitivity: "balanced",
    classifierMode: "regex-prefilter",
    ...overrides,
  };
}

function classification(
  overrides: Partial<ClassificationResult> = {},
): ClassificationResult {
  return {
    isQuestion: true,
    confidence: 0.9,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pinned threshold mapping (acceptance)
// ---------------------------------------------------------------------------

describe("SENSITIVITY_THRESHOLDS (acceptance #2299)", () => {
  it("matches the documented MVP values for every preset", () => {
    expect(SENSITIVITY_THRESHOLDS).toEqual(DOCUMENTED_THRESHOLDS);
  });

  it("defines exactly the three documented presets — no more, no fewer", () => {
    expect(Object.keys(SENSITIVITY_THRESHOLDS).sort()).toEqual(
      ["balanced", "cautious", "eager"],
    );
  });

  it("orders cautious > balanced > eager (higher sensitivity ⇒ lower threshold)", () => {
    expect(SENSITIVITY_THRESHOLDS.cautious).toBeGreaterThan(
      SENSITIVITY_THRESHOLDS.balanced,
    );
    expect(SENSITIVITY_THRESHOLDS.balanced).toBeGreaterThan(
      SENSITIVITY_THRESHOLDS.eager,
    );
  });

  it("keeps every threshold inside the [0.5, 0.95] tuning window from the PRD", () => {
    // The stability-bar comment in policy.ts caps the per-preset tuning
    // range. If a tuning PR moves outside the window, that's a product
    // decision that should be visible at code-review time — this guard
    // forces the conversation.
    for (const v of Object.values(SENSITIVITY_THRESHOLDS)) {
      expect(v).toBeGreaterThanOrEqual(0.5);
      expect(v).toBeLessThanOrEqual(0.95);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-preset boundary check via decideInterjection
// ---------------------------------------------------------------------------

describe("decideInterjection — preset boundary behaviour", () => {
  // For each preset, a confidence one tick below the threshold must
  // skip; a confidence at exactly the threshold must react. This is the
  // user-visible contract: "Balanced means we react at 0.70".
  const boundaryCases: Array<{
    preset: SensitivityPreset;
    threshold: number;
  }> = [
    { preset: "cautious", threshold: SENSITIVITY_THRESHOLDS.cautious },
    { preset: "balanced", threshold: SENSITIVITY_THRESHOLDS.balanced },
    { preset: "eager", threshold: SENSITIVITY_THRESHOLDS.eager },
  ];

  for (const { preset, threshold } of boundaryCases) {
    it(`${preset}: confidence just below ${threshold} ⇒ skip`, () => {
      const decision = decideInterjection({
        classification: classification({ confidence: threshold - 0.01 }),
        workspace: workspace({ sensitivity: preset }),
        channelAllowed: true,
      });
      expect(decision).toEqual({
        action: "skip",
        reason: "below-confidence-threshold",
      });
    });

    it(`${preset}: confidence at exactly ${threshold} ⇒ react`, () => {
      const decision = decideInterjection({
        classification: classification({ confidence: threshold }),
        workspace: workspace({ sensitivity: preset }),
        channelAllowed: true,
      });
      expect(decision).toEqual({ action: "react", reason: "passes-threshold" });
    });
  }
});

// ---------------------------------------------------------------------------
// Per-channel sensitivity override — end-to-end through decideInterjection
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

  it("channel override absent ⇒ workspace sensitivity decides", () => {
    // Acceptance criteria: per-channel is optional; absent ⇒ fall back
    // to workspace default. Already covered by `policy.test.ts` but
    // pinned here as part of the #2299 contract.
    const decision = decideInterjection({
      classification: classification({ confidence: STRADDLE_CONFIDENCE }),
      workspace: workspace({ sensitivity: "balanced" }),
      channel: { channelId: "C1", allow: true }, // no sensitivity override
      channelAllowed: true,
    });
    expect(decision).toEqual({
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
