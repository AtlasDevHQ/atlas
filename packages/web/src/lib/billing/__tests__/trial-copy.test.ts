/**
 * Tests for the billing-page trial-state helpers (#3434).
 */

import { describe, expect, test } from "bun:test";
import { effectiveTrialEnd, isTrialEndPast } from "../trial-copy";

const NOW = Date.parse("2026-06-12T12:00:00Z");
const DAY = 86_400_000;

describe("effectiveTrialEnd", () => {
  test("returns null for non-trial tiers even when dates are present", () => {
    expect(
      effectiveTrialEnd({
        tier: "pro",
        trialEndsAt: "2026-06-20T00:00:00Z",
        trialEndsAtEffective: "2026-06-20T00:00:00Z",
      }),
    ).toBeNull();
  });

  test("prefers the server-computed effective end", () => {
    expect(
      effectiveTrialEnd({
        tier: "trial",
        trialEndsAt: "2026-06-30T00:00:00Z",
        trialEndsAtEffective: "2026-06-15T00:00:00Z",
      }),
    ).toBe("2026-06-15T00:00:00Z");
  });

  test("falls back to trialEndsAt when the effective field is absent (older API)", () => {
    expect(
      effectiveTrialEnd({ tier: "trial", trialEndsAt: "2026-06-30T00:00:00Z" }),
    ).toBe("2026-06-30T00:00:00Z");
  });

  test("returns the effective fallback for a NULL trial_ends_at workspace", () => {
    // The #3434 blind spot: trialEndsAt is null but the server computed the
    // createdAt + TRIAL_DAYS fallback.
    expect(
      effectiveTrialEnd({
        tier: "trial",
        trialEndsAt: null,
        trialEndsAtEffective: "2026-06-15T00:00:00Z",
      }),
    ).toBe("2026-06-15T00:00:00Z");
  });

  test("returns null when no clock is available at all", () => {
    expect(
      effectiveTrialEnd({ tier: "trial", trialEndsAt: null, trialEndsAtEffective: null }),
    ).toBeNull();
  });
});

describe("isTrialEndPast", () => {
  test("false for a future end", () => {
    expect(isTrialEndPast(new Date(NOW + DAY).toISOString(), NOW)).toBe(false);
  });

  test("true for a past end", () => {
    expect(isTrialEndPast(new Date(NOW - DAY).toISOString(), NOW)).toBe(true);
  });

  test("null clock is not expired", () => {
    expect(isTrialEndPast(null, NOW)).toBe(false);
  });

  test("unparseable date fails closed into expired (matches the banner)", () => {
    expect(isTrialEndPast("not-a-date", NOW)).toBe(true);
  });
});
