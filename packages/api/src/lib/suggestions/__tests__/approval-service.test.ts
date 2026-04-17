/**
 * Unit tests for the auto-promote decision function.
 *
 * These exercise the load-bearing invariants:
 *   1. Threshold arithmetic — promotion fires on the exact transition
 *      from below-threshold to at-or-above-threshold, not before and
 *      not after.
 *   2. Window boundary — clicks older than the cold window don't count.
 *   3. No duplicate promotion — once promoted, repeated calls are no-ops.
 *   4. Approved/hidden rows cannot be re-promoted (admin review is final).
 */

import { describe, it, expect } from "bun:test";
import {
  checkAutoPromote,
  type AutoPromoteConfig,
  type AutoPromoteInput,
} from "../approval-service";

const DEFAULT_CONFIG: AutoPromoteConfig = {
  autoPromoteClicks: 3,
  coldWindowDays: 90,
};

const NOW = new Date("2026-04-15T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function baseInput(overrides: Partial<AutoPromoteInput> = {}): AutoPromoteInput {
  return {
    approvalStatus: "pending",
    priorDistinctUserClicks: 0,
    nextDistinctUserClicks: 0,
    oldestDistinctClickAt: daysAgo(1),
    ...overrides,
  };
}

describe("checkAutoPromote — threshold arithmetic", () => {
  it("returns promoted=true on the exact transition 2 → 3 at threshold 3", () => {
    const decision = checkAutoPromote(
      baseInput({ priorDistinctUserClicks: 2, nextDistinctUserClicks: 3 }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: true });
  });

  it("returns promoted=false when new count is below threshold (2 < 3)", () => {
    const decision = checkAutoPromote(
      baseInput({ priorDistinctUserClicks: 1, nextDistinctUserClicks: 2 }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: false, reason: "below_threshold" });
  });

  it("treats the threshold as inclusive: clicks == threshold promotes", () => {
    // Edge: prior 0, next exactly 3 (jump via some bulk mechanism).
    const decision = checkAutoPromote(
      baseInput({ priorDistinctUserClicks: 0, nextDistinctUserClicks: 3 }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: true });
  });

  it("honors a custom threshold from config", () => {
    const config: AutoPromoteConfig = { autoPromoteClicks: 10, coldWindowDays: 90 };
    const below = checkAutoPromote(
      baseInput({ priorDistinctUserClicks: 8, nextDistinctUserClicks: 9 }),
      config,
      NOW,
    );
    expect(below).toEqual({ promoted: false, reason: "below_threshold" });

    const exact = checkAutoPromote(
      baseInput({ priorDistinctUserClicks: 9, nextDistinctUserClicks: 10 }),
      config,
      NOW,
    );
    expect(exact).toEqual({ promoted: true });
  });
});

describe("checkAutoPromote — window boundary", () => {
  it("promotes when the oldest click is inside the 90-day window", () => {
    const decision = checkAutoPromote(
      baseInput({
        priorDistinctUserClicks: 2,
        nextDistinctUserClicks: 3,
        oldestDistinctClickAt: daysAgo(89),
      }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: true });
  });

  it("does not promote when the oldest click is beyond the window (90 days + 1s)", () => {
    const justOutside = new Date(
      NOW.getTime() - (90 * 24 * 60 * 60 * 1000 + 1000),
    );
    const decision = checkAutoPromote(
      baseInput({
        priorDistinctUserClicks: 2,
        nextDistinctUserClicks: 3,
        oldestDistinctClickAt: justOutside,
      }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: false, reason: "outside_window" });
  });

  it("promotes on the exact window boundary (oldest click exactly coldWindowDays old)", () => {
    const onBoundary = new Date(
      NOW.getTime() - 90 * 24 * 60 * 60 * 1000,
    );
    const decision = checkAutoPromote(
      baseInput({
        priorDistinctUserClicks: 2,
        nextDistinctUserClicks: 3,
        oldestDistinctClickAt: onBoundary,
      }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: true });
  });

  it("respects a custom window length", () => {
    const config: AutoPromoteConfig = { autoPromoteClicks: 3, coldWindowDays: 7 };
    const outside = checkAutoPromote(
      baseInput({
        priorDistinctUserClicks: 2,
        nextDistinctUserClicks: 3,
        oldestDistinctClickAt: daysAgo(8),
      }),
      config,
      NOW,
    );
    expect(outside).toEqual({ promoted: false, reason: "outside_window" });

    const inside = checkAutoPromote(
      baseInput({
        priorDistinctUserClicks: 2,
        nextDistinctUserClicks: 3,
        oldestDistinctClickAt: daysAgo(6),
      }),
      config,
      NOW,
    );
    expect(inside).toEqual({ promoted: true });
  });

  it("skips window check when oldestDistinctClickAt is null", () => {
    const decision = checkAutoPromote(
      baseInput({
        priorDistinctUserClicks: 2,
        nextDistinctUserClicks: 3,
        oldestDistinctClickAt: null,
      }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: true });
  });
});

describe("checkAutoPromote — no duplicate promotion", () => {
  it("returns already_promoted when prior count is already at threshold", () => {
    const decision = checkAutoPromote(
      baseInput({ priorDistinctUserClicks: 3, nextDistinctUserClicks: 4 }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: false, reason: "already_promoted" });
  });

  it("returns already_promoted when prior count is above threshold", () => {
    const decision = checkAutoPromote(
      baseInput({ priorDistinctUserClicks: 50, nextDistinctUserClicks: 51 }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: false, reason: "already_promoted" });
  });
});

describe("checkAutoPromote — approval status gating", () => {
  it("does not re-promote an approved suggestion back to pending", () => {
    const decision = checkAutoPromote(
      baseInput({
        approvalStatus: "approved",
        priorDistinctUserClicks: 2,
        nextDistinctUserClicks: 3,
      }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: false, reason: "already_reviewed" });
  });

  it("does not re-promote a hidden suggestion back to pending", () => {
    const decision = checkAutoPromote(
      baseInput({
        approvalStatus: "hidden",
        priorDistinctUserClicks: 2,
        nextDistinctUserClicks: 3,
      }),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(decision).toEqual({ promoted: false, reason: "already_reviewed" });
  });
});
