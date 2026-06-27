/**
 * Unit tests for the abuse-prevention RESPONSE POLICY seam (#4000 — WS5).
 *
 * This is the one new production mechanism the split introduced that the
 * engine test (which imports `ee/.../engine` directly) and the route test
 * (which mocks the Tag) both bypass: the sync `AbuseResponsePolicy` holder in
 * core, plus the thin shim (`lib/security/abuse.ts`) that delegates to it.
 *
 * The whole "core is inert until EE registers, then behaves exactly as before"
 * guarantee rides on these delegating functions, so they get direct coverage:
 *
 *   1. The default holder is `NOOP_ABUSE_RESPONSE_POLICY` — every method inert
 *      EXCEPT `getAbuseConfig`, which returns the real baseline config.
 *   2. The shim delegates to whatever policy is registered (no-op by default).
 *   3. `setAbuseResponsePolicy` swaps the live impl in; the shim follows.
 *   4. `_resetAbuseResponsePolicy` restores the no-op.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  NOOP_ABUSE_RESPONSE_POLICY,
  getAbuseResponsePolicy,
  setAbuseResponsePolicy,
  _resetAbuseResponsePolicy,
  type AbuseResponsePolicy,
} from "@atlas/api/lib/security/abuse-response-policy";
import * as shim from "@atlas/api/lib/security/abuse";
import { getAbuseConfig as baselineGetAbuseConfig } from "@atlas/api/lib/security/abuse-baseline";

afterEach(() => {
  // Keep per-test isolation honest — a registration in one test must not leak.
  _resetAbuseResponsePolicy();
});

describe("AbuseResponsePolicy holder", () => {
  it("defaults to the inert no-op policy", () => {
    expect(getAbuseResponsePolicy()).toBe(NOOP_ABUSE_RESPONSE_POLICY);
  });

  it("no-op policy is fully inert except getAbuseConfig", async () => {
    const p = getAbuseResponsePolicy();
    expect(p.checkAbuseStatus("ws-1")).toEqual({ level: "none" });
    expect(p.listFlaggedWorkspaces()).toEqual([]);
    expect(p.reinstateWorkspace("ws-1", "actor-1")).toBeNull();
    expect(await p.getAbuseDetail("ws-1")).toBeNull();
    expect(await p.getAbuseEvents("ws-1")).toEqual({ events: [], status: "db_unavailable" });
    expect(p.getAbuseRestoreStatus()).toBe("db_unavailable");
    // recordQueryEvent / restoreAbuseState / abuseCleanupTick must not throw.
    expect(() => p.recordQueryEvent("ws-1", { success: true })).not.toThrow();
    expect(() => p.abuseCleanupTick()).not.toThrow();
    await expect(p.restoreAbuseState()).resolves.toBeUndefined();
  });

  it("no-op getAbuseConfig returns the real baseline config (the one live method)", () => {
    // The config surface is core-resident — the detector reads it regardless
    // of EE — so the no-op delegates to baseline rather than returning a stub.
    expect(getAbuseResponsePolicy().getAbuseConfig()).toEqual(baselineGetAbuseConfig());
  });

  it("setAbuseResponsePolicy installs a live impl; _reset restores the no-op", () => {
    const live: AbuseResponsePolicy = {
      ...NOOP_ABUSE_RESPONSE_POLICY,
      checkAbuseStatus: () => ({ level: "suspended" }),
      listFlaggedWorkspaces: () => [
        {
          workspaceId: "ws-evil",
          workspaceName: null,
          level: "suspended",
          trigger: "query_rate",
          message: "too fast",
          updatedAt: new Date().toISOString(),
          events: [],
        },
      ],
    };
    setAbuseResponsePolicy(live);
    expect(getAbuseResponsePolicy()).toBe(live);
    expect(getAbuseResponsePolicy().checkAbuseStatus("ws-evil")).toEqual({ level: "suspended" });

    _resetAbuseResponsePolicy();
    expect(getAbuseResponsePolicy()).toBe(NOOP_ABUSE_RESPONSE_POLICY);
    expect(getAbuseResponsePolicy().checkAbuseStatus("ws-evil")).toEqual({ level: "none" });
  });
});

describe("abuse shim delegation", () => {
  it("delegates to the no-op policy by default (core stays inert)", async () => {
    // This is the pre-split self-hosted behavior the no-op preserves: the
    // shim's runtime functions return the disengaged shape.
    expect(shim.checkAbuseStatus("ws-1")).toEqual({ level: "none" });
    expect(shim.listFlaggedWorkspaces()).toEqual([]);
    expect(shim.reinstateWorkspace("ws-1", "actor-1")).toBeNull();
    expect(await shim.getAbuseDetail("ws-1")).toBeNull();
    expect(shim.getAbuseRestoreStatus()).toBe("db_unavailable");
    expect(() => shim.recordQueryEvent("ws-1", { success: true })).not.toThrow();
  });

  it("follows a registered live policy", () => {
    const live: AbuseResponsePolicy = {
      ...NOOP_ABUSE_RESPONSE_POLICY,
      checkAbuseStatus: () => ({ level: "throttled", throttleDelayMs: 2000 }),
      reinstateWorkspace: () => "throttled",
    };
    setAbuseResponsePolicy(live);
    // The shim re-reads `getAbuseResponsePolicy()` per call, so the swap is live.
    expect(shim.checkAbuseStatus("ws-1")).toEqual({ level: "throttled", throttleDelayMs: 2000 });
    expect(shim.reinstateWorkspace("ws-1", "actor-1")).toBe("throttled");
  });

  it("re-exports the real baseline getAbuseConfig directly (not via the holder)", () => {
    // The shim re-exports `getAbuseConfig` straight from baseline, so it is the
    // real config even with the no-op holder — and is unaffected by a live
    // policy swap (it never routes through the holder).
    expect(shim.getAbuseConfig()).toEqual(baselineGetAbuseConfig());
  });
});
