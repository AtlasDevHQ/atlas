/**
 * Agent Auth gate — path matcher, fail-closed resolution, and the
 * plugin↔gate prefix CONTRACT (#4409).
 *
 * The contract test is the one the gate's own docstring promises: the gate's
 * `isAgentAuthPath` prefix list is a hand copy of the plugin's internal
 * (non-exported) prefixes, so a `@better-auth/agent-auth` bump that adds a route
 * under a NEW prefix would silently escape the gate and be reachable while the
 * feature is off. This enumerates every path the real plugin advertises and
 * asserts the gate matches each — turning that drift into a RED test.
 *
 * Self-contained: the enable flag is set on `process.env` per-test and restored;
 * the settings module is spread-mocked so the fail-closed error path can be
 * driven without an internal DB.
 */

import { describe, it, expect, afterEach, mock } from "bun:test";

// Spread the real settings module and override only getSettingLive with a
// controllable stub. Driving the raw string return directly (rather than env +
// the real resolver) isolates the gate's OWN logic — its `isTrue` coercion and
// its fail-closed catch — from the settings live-cache TTL, which would
// otherwise hold a stale value across rapid flips within one test run.
import * as settingsReal from "@atlas/api/lib/settings";
// `settingValue` is the PLATFORM-tier value (what resolves when no workspace
// override applies). `workspaceOverrides` models per-org overrides, consulted
// ONLY when an `orgId` is supplied — mirroring the real `getSettingLive`
// precedence (workspace override > platform), which the raw HTTP surface never
// reaches because it omits `orgId`.
let settingValue: string | undefined;
let workspaceOverrides: Record<string, string | undefined> = {};
let throwOnRead = false;
mock.module("@atlas/api/lib/settings", () => ({
  ...settingsReal,
  getSettingLive: async (_key: string, orgId?: string) => {
    if (throwOnRead) throw new Error("settings backend unavailable");
    if (orgId !== undefined && orgId in workspaceOverrides) {
      return workspaceOverrides[orgId];
    }
    return settingValue;
  },
}));

import {
  isAgentAuthPath,
  isAgentAuthEnabled,
  AGENT_AUTH_MOUNT,
  AGENT_AUTH_CONFIGURATION_PATH,
} from "@atlas/api/lib/auth/agent-auth-gate";
import { buildAgentAuthPlugin } from "@atlas/api/lib/auth/agent-auth-plugin";

describe("isAgentAuthPath", () => {
  it("matches every functional group + the discovery path", () => {
    expect(isAgentAuthPath("/api/auth/agent/register")).toBe(true);
    expect(isAgentAuthPath("/api/auth/agent/device/code")).toBe(true);
    expect(isAgentAuthPath("/api/auth/host/enroll")).toBe(true);
    expect(isAgentAuthPath("/api/auth/capability/execute")).toBe(true);
    expect(isAgentAuthPath(AGENT_AUTH_CONFIGURATION_PATH)).toBe(true);
  });

  it("does NOT match non-agent-auth auth paths (gate is scoped)", () => {
    expect(isAgentAuthPath("/api/auth/sign-in/email")).toBe(false);
    expect(isAgentAuthPath("/api/auth/token")).toBe(false);
    expect(isAgentAuthPath("/api/auth/device/code")).toBe(false); // the OTHER device flow (RFC 8628), not agent-auth
    expect(isAgentAuthPath("/api/v1/chat")).toBe(false);
  });
});

// THE CONTRACT: the gate must match every path the plugin actually mounts.
describe("plugin↔gate prefix contract (#4409)", () => {
  it("every path the agent-auth plugin advertises is gated by isAgentAuthPath", () => {
    const plugin = buildAgentAuthPlugin();
    const paths = Object.values(plugin.endpoints ?? {})
      .map((e) => (e as { path?: string }).path)
      .filter((p): p is string => typeof p === "string");

    expect(paths.length).toBeGreaterThan(0);
    const escaped = paths.filter((p) => !isAgentAuthPath(`${AGENT_AUTH_MOUNT}${p}`));
    expect(
      escaped,
      `these plugin routes are NOT covered by the gate and would be reachable while the ` +
        `feature is off — extend AGENT_AUTH_PREFIXES in agent-auth-gate.ts: ${escaped.join(", ")}`,
    ).toEqual([]);
  });
});

describe("isAgentAuthEnabled (fail-closed)", () => {
  afterEach(() => {
    throwOnRead = false;
    settingValue = undefined;
    workspaceOverrides = {};
  });

  it("off when the setting resolves to undefined (default)", async () => {
    settingValue = undefined;
    expect(await isAgentAuthEnabled()).toBe(false);
  });

  it("on when the setting is exactly 'true' (trimmed / case-insensitive)", async () => {
    for (const v of ["true", "TRUE", " true "]) {
      settingValue = v;
      expect({ v, on: await isAgentAuthEnabled() }).toEqual({ v, on: true });
    }
  });

  it("off for any non-'true' value (a malformed override cannot open the surface)", async () => {
    for (const v of ["false", "0", "1", "yes", "on", "enabled", ""]) {
      settingValue = v;
      expect({ v, on: await isAgentAuthEnabled() }).toEqual({ v, on: false });
    }
  });

  it("fail-closed: a settings-resolution error resolves to off (never opens)", async () => {
    settingValue = "true"; // would be ON if it read cleanly
    throwOnRead = true;
    expect(await isAgentAuthEnabled()).toBe(false);
  });
});

// The two-tier enablement matrix (#4419). `isAgentAuthEnabled()` (no orgId) is
// the HTTP-surface / platform tier; `isAgentAuthEnabled(workspaceId)` is the
// execution / workspace tier. Together they encode: operator = master on/off
// for everyone; workspace = opt-OUT of execution only (can tighten, never
// re-open). These assert every cell of the four-state matrix the issue enumerates.
describe("enablement precedence matrix (#4419): platform tier vs workspace tier", () => {
  afterEach(() => {
    throwOnRead = false;
    settingValue = undefined;
    workspaceOverrides = {};
  });

  it("platform OFF + workspace unset ⇒ off at both tiers (the default kill-switch)", async () => {
    settingValue = undefined; // platform default
    expect(await isAgentAuthEnabled()).toBe(false); // HTTP surface
    expect(await isAgentAuthEnabled("wsA")).toBe(false); // execution
  });

  it("platform ON + workspace unset ⇒ on at both tiers (full access)", async () => {
    settingValue = "true";
    expect(await isAgentAuthEnabled()).toBe(true); // HTTP surface reachable
    expect(await isAgentAuthEnabled("wsA")).toBe(true); // execution allowed
  });

  it("platform ON + workspace OFF ⇒ tightens THAT workspace's execution only; the surface + other workspaces stay on", async () => {
    settingValue = "true";
    workspaceOverrides = { wsA: "false" };
    expect(await isAgentAuthEnabled()).toBe(true); // HTTP surface unaffected (platform tier)
    expect(await isAgentAuthEnabled("wsA")).toBe(false); // wsA sealed at execution
    expect(await isAgentAuthEnabled("wsB")).toBe(true); // per-org override — others unaffected
  });

  it("platform OFF + workspace ON ⇒ HTTP surface still off (a workspace cannot re-open an operator-disabled feature)", async () => {
    settingValue = undefined; // platform off
    workspaceOverrides = { wsA: "true" };
    // The raw HTTP gate omits orgId, so the workspace override is invisible: the
    // surface is 404 for EVERYONE, including wsA. This is the kill-switch direction.
    expect(await isAgentAuthEnabled()).toBe(false);
    // Another workspace with no override also stays off (platform tier).
    expect(await isAgentAuthEnabled("wsB")).toBe(false);
    // The workspace tier read for wsA WOULD resolve the override to on — but that
    // state is unreachable in practice: execution is only entered after the HTTP
    // surface (above) admits the request, and it never does while platform is off.
    // Asserted so the "can only tighten, never loosen" invariant is explicit.
    expect(await isAgentAuthEnabled("wsA")).toBe(true);
  });
});
