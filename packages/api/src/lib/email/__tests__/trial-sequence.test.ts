/**
 * Tests for the trial-expiry email sequence (#3434).
 *
 * `nextDueTrialStep` is the pure scheduling decision: given the effective
 * trial end, "now", and the steps already sent to a recipient, which (if
 * any) trial email is due. Policy pins:
 *
 *  - Only the MOST URGENT due step is returned — a workspace that crosses
 *    several thresholds between scheduler ticks (or that onboards onto
 *    this feature mid-trial) gets one email, not a backlog flush.
 *  - Earlier steps are never back-filled once a later one is due/sent.
 *  - Expiry emails stop after TRIAL_EXPIRED_EMAIL_MAX_AGE_MS so the
 *    feature's first deploy doesn't email every long-churned workspace.
 */

import { describe, it, expect } from "bun:test";
import {
  TRIAL_EMAIL_SEQUENCE,
  TRIAL_EXPIRED_EMAIL_MAX_AGE_MS,
  nextDueTrialStep,
} from "../trial-sequence";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-12T12:00:00.000Z");

describe("TRIAL_EMAIL_SEQUENCE", () => {
  it("defines T-3d, T-1d, and expiry steps in urgency order", () => {
    expect(TRIAL_EMAIL_SEQUENCE.map((s) => s.step)).toEqual([
      "trial_ending_3d",
      "trial_ending_1d",
      "trial_expired",
    ]);
    expect(TRIAL_EMAIL_SEQUENCE.map((s) => s.daysBeforeExpiry)).toEqual([3, 1, 0]);
  });

  it("has unique step names that cannot collide with onboarding steps", () => {
    for (const s of TRIAL_EMAIL_SEQUENCE) {
      // Trial sends share the onboarding_emails table; the trial_ prefix
      // keeps the two step namespaces disjoint.
      expect(s.step.startsWith("trial_")).toBe(true);
    }
  });
});

describe("nextDueTrialStep", () => {
  it("returns null when more than 3 days remain", () => {
    expect(nextDueTrialStep(NOW + 4 * DAY, NOW, [])).toBeNull();
  });

  it("returns trial_ending_3d at exactly 3 days out", () => {
    expect(nextDueTrialStep(NOW + 3 * DAY, NOW, [])).toBe("trial_ending_3d");
  });

  it("returns trial_ending_1d inside the final day", () => {
    expect(nextDueTrialStep(NOW + 12 * 60 * 60 * 1000, NOW, [])).toBe("trial_ending_1d");
  });

  it("returns trial_expired once the trial has ended", () => {
    expect(nextDueTrialStep(NOW - 1, NOW, [])).toBe("trial_expired");
  });

  it("skips straight to the most urgent due step (no backlog flush)", () => {
    // Nothing sent, trial expired yesterday → only the expiry email, never
    // the 3d/1d warnings.
    expect(nextDueTrialStep(NOW - DAY, NOW, [])).toBe("trial_expired");
  });

  it("returns null when the most urgent due step was already sent", () => {
    expect(nextDueTrialStep(NOW - DAY, NOW, ["trial_expired"])).toBeNull();
    expect(nextDueTrialStep(NOW + 2 * DAY, NOW, ["trial_ending_1d"])).toBeNull();
  });

  it("does not re-send an earlier step after a later one went out", () => {
    // 1d warning sent, clock still in the 1d window → nothing due. The 3d
    // step is in the past and must not be back-filled.
    expect(nextDueTrialStep(NOW + 12 * 60 * 60 * 1000, NOW, ["trial_ending_1d"])).toBeNull();
  });

  it("progresses from a sent 3d warning to the 1d warning", () => {
    expect(nextDueTrialStep(NOW + 12 * 60 * 60 * 1000, NOW, ["trial_ending_3d"])).toBe(
      "trial_ending_1d",
    );
  });

  it("progresses from sent warnings to the expiry notice", () => {
    expect(
      nextDueTrialStep(NOW - 1, NOW, ["trial_ending_3d", "trial_ending_1d"]),
    ).toBe("trial_expired");
  });

  it("suppresses the expiry email for trials expired longer than the max age", () => {
    expect(
      nextDueTrialStep(NOW - TRIAL_EXPIRED_EMAIL_MAX_AGE_MS - 1, NOW, []),
    ).toBeNull();
  });

  it("still sends the expiry email just inside the max age window", () => {
    expect(
      nextDueTrialStep(NOW - TRIAL_EXPIRED_EMAIL_MAX_AGE_MS + 1, NOW, []),
    ).toBe("trial_expired");
  });

  it("returns null for an unparseable effective end (NaN)", () => {
    expect(nextDueTrialStep(Number.NaN, NOW, [])).toBeNull();
  });
});
