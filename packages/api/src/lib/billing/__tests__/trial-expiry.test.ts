/**
 * Tests for the effective trial expiry helper (#3434).
 *
 * The helper mirrors enforcement.ts's isTrialExpired fallback exactly:
 * `trial_ends_at` when set, else `createdAt + TRIAL_DAYS`. Pinning that
 * parity here means a workspace with a NULL trial_ends_at sees the same
 * date in the banner/billing page that enforcement uses to cut it off.
 */

import { describe, it, expect } from "bun:test";
import { TRIAL_DAYS } from "../plans";
import { effectiveTrialEndsAt, isTrialExpiredAt } from "../trial-expiry";

const DAY = 86_400_000;
const NOW = new Date("2026-06-12T12:00:00.000Z");

describe("effectiveTrialEndsAt", () => {
  it("returns trial_ends_at verbatim when set", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: "2026-06-20T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(end?.toISOString()).toBe("2026-06-20T00:00:00.000Z");
  });

  it("falls back to createdAt + TRIAL_DAYS when trial_ends_at is null", () => {
    const createdAt = "2026-06-01T00:00:00.000Z";
    const end = effectiveTrialEndsAt({ trial_ends_at: null, createdAt });
    expect(end?.getTime()).toBe(Date.parse(createdAt) + TRIAL_DAYS * DAY);
  });

  it("accepts Date inputs (pg returns Date for timestamptz)", () => {
    const createdAt = new Date("2026-06-01T00:00:00.000Z");
    const end = effectiveTrialEndsAt({ trial_ends_at: null, createdAt });
    expect(end?.getTime()).toBe(createdAt.getTime() + TRIAL_DAYS * DAY);
  });

  it("returns null when both inputs are unparseable", () => {
    expect(
      effectiveTrialEndsAt({ trial_ends_at: "not-a-date", createdAt: "garbage" }),
    ).toBeNull();
  });

  it("falls back to createdAt when trial_ends_at is unparseable", () => {
    const createdAt = "2026-06-01T00:00:00.000Z";
    const end = effectiveTrialEndsAt({ trial_ends_at: "not-a-date", createdAt });
    expect(end?.getTime()).toBe(Date.parse(createdAt) + TRIAL_DAYS * DAY);
  });
});

describe("isTrialExpiredAt", () => {
  it("matches enforcement: trial_ends_at in the past → expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: new Date(NOW.getTime() - 1).toISOString(),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(true);
  });

  it("matches enforcement: trial_ends_at in the future → not expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: new Date(NOW.getTime() + DAY).toISOString(),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(false);
  });

  it("matches enforcement fallback: created more than TRIAL_DAYS ago → expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: null,
      createdAt: new Date(NOW.getTime() - (TRIAL_DAYS * DAY + 1)).toISOString(),
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(true);
  });

  it("matches enforcement fallback: created less than TRIAL_DAYS ago → not expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: null,
      createdAt: new Date(NOW.getTime() - (TRIAL_DAYS - 1) * DAY).toISOString(),
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(false);
  });

  it("null effective end (unparseable inputs) → not expired, matching enforcement's NaN comparison", () => {
    // enforcement's `new Date("garbage") < cutoff` is `NaN < x` → false.
    expect(isTrialExpiredAt(null, NOW)).toBe(false);
  });
});
