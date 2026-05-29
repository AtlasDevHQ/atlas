/**
 * Backoff math — pure, deterministic. The values asserted here are the
 * contract that the SQL CASE in `backoff.ts:CLAIM_DELAY_SQL` mirrors;
 * if either changes, the other must change too. (Same tier schedule as
 * lead-outbox — a sustained-outage backstop wants the same widening
 * gaps so a down provider isn't hammered.)
 */

import { describe, expect, test } from "bun:test";
import { CLAIM_DELAY_SQL, DEAD_AFTER_ATTEMPTS, nextDelayMs } from "../backoff";

describe("nextDelayMs", () => {
  test("attempts=0 is immediate (first try)", () => {
    expect(nextDelayMs(0)).toBe(0);
  });

  test("matches the published tiers (30s, 2m, 8m, 30m, 2h)", () => {
    expect(nextDelayMs(1)).toBe(30_000);
    expect(nextDelayMs(2)).toBe(120_000);
    expect(nextDelayMs(3)).toBe(480_000);
    expect(nextDelayMs(4)).toBe(1_800_000);
    expect(nextDelayMs(5)).toBe(7_200_000);
  });

  test("caps at the last tier rather than throwing past DEAD_AFTER_ATTEMPTS", () => {
    expect(nextDelayMs(DEAD_AFTER_ATTEMPTS)).toBe(7_200_000);
    expect(nextDelayMs(99)).toBe(7_200_000);
  });

  test("normalizes negative / NaN / fractional inputs to 0", () => {
    expect(nextDelayMs(-1)).toBe(0);
    expect(nextDelayMs(NaN)).toBe(0);
    expect(nextDelayMs(0.5)).toBe(0);
  });

  test("DEAD_AFTER_ATTEMPTS is 6 — covered tiers 1..5, dead at 6th failure", () => {
    expect(DEAD_AFTER_ATTEMPTS).toBe(6);
  });
});

describe("CLAIM_DELAY_SQL", () => {
  test("references every tier covered by nextDelayMs", () => {
    // The SQL CASE and the TS array must stay in lockstep — a divergence
    // means rows retry too eagerly (hammer a down provider) or never
    // retry at all (stuck pending). This regression-spotter fails the
    // diff long before a stuck row tells anyone.
    expect(CLAIM_DELAY_SQL).toMatch(/WHEN 0/);
    expect(CLAIM_DELAY_SQL).toMatch(/WHEN 1.+'30 seconds'/s);
    expect(CLAIM_DELAY_SQL).toMatch(/WHEN 2.+'2 minutes'/s);
    expect(CLAIM_DELAY_SQL).toMatch(/WHEN 3.+'8 minutes'/s);
    expect(CLAIM_DELAY_SQL).toMatch(/WHEN 4.+'30 minutes'/s);
    expect(CLAIM_DELAY_SQL).toMatch(/WHEN 5.+'2 hours'/s);
  });
});
