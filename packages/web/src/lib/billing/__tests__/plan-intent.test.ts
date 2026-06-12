/**
 * Plan-intent storage contract (#3418): saved on /signup?plan=…, consumed
 * once by the billing plan picker. localStorage-backed so it survives the
 * signup flow's hard navigations and OAuth redirects.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { savePlanIntent, consumePlanIntent, isPlanIntent } from "../plan-intent";

const KEY = "atlas.plan-intent";

beforeEach(() => {
  window.localStorage.clear();
});

describe("isPlanIntent", () => {
  it("accepts exactly the three paid tiers", () => {
    expect(isPlanIntent("starter")).toBe(true);
    expect(isPlanIntent("pro")).toBe(true);
    expect(isPlanIntent("business")).toBe(true);
  });

  it("rejects everything else", () => {
    for (const v of ["trial", "free", "STARTER", "", null, undefined]) {
      expect(isPlanIntent(v)).toBe(false);
    }
  });
});

describe("savePlanIntent / consumePlanIntent", () => {
  it("round-trips a valid plan and clears on consumption (one-shot)", () => {
    savePlanIntent("pro");
    expect(consumePlanIntent()).toBe("pro");
    expect(consumePlanIntent()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("ignores invalid plans at save time", () => {
    savePlanIntent("enterprise");
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(consumePlanIntent()).toBeNull();
  });

  it("expires intents older than 7 days", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ plan: "starter", savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
    );
    expect(consumePlanIntent()).toBeNull();
  });

  it("survives malformed storage payloads (clears, returns null)", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(consumePlanIntent()).toBeNull();
    window.localStorage.setItem(KEY, JSON.stringify({ plan: 42 }));
    expect(consumePlanIntent()).toBeNull();
  });
});
