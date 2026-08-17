/**
 * The Slack chat-history connector's factory contract (#4770).
 *
 * Small surface, two things on it that fail SILENTLY if they regress:
 *
 *   - `getChatBackfillWindowMs` guards against a non-positive window. A `0`
 *     makes `floorTs === now`, so every never-synced channel walks an empty
 *     window, returns nothing, and reports `status: "success"` with
 *     `coverageIncomplete: false` — a source that ingests nothing forever while
 *     rendering green. The guard is the only thing between a fat-fingered
 *     platform setting and that state.
 *   - `resolveSlackHistoryToken` is shared BY DESIGN between the install
 *     handler's pre-write verification and the per-cycle sync, so the two
 *     cannot disagree about whether Slack is connected. Its two arms say
 *     different things ("connect Slack" vs "reconnect Slack"), and they are
 *     different fixes.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { SlackInstallationWithSecret } from "@atlas/api/lib/slack/store";

let SETTING: string | undefined;
// Mock-all-exports (CLAUDE.md): every VALUE export of `lib/settings.ts`. The
// module is imported for one getter, but a partial factory surfaces as
// "Export named 'X' not found" in whatever unrelated file happens to import
// the missing symbol next.
void mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string) =>
    key === "ATLAS_BRAIN_CHAT_BACKFILL_DAYS" ? SETTING : undefined,
  getSetting: (key: string) =>
    key === "ATLAS_BRAIN_CHAT_BACKFILL_DAYS" ? SETTING : undefined,
  getSettingLive: async (key: string) =>
    key === "ATLAS_BRAIN_CHAT_BACKFILL_DAYS" ? SETTING : undefined,
  getSettingOverride: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  refreshSettingsTick: async () => {},
  isHotReloadedKey: () => false,
  isSaasModeForGuard: () => false,
  // `null`, matching `SecuritySensitiveAudit | null`. A truthy `{}` passes
  // `auditSettingsWrite`'s `!== null` guard and then reads properties off an
  // empty object — unreachable from this suite, and reported by nothing, because
  // `mock.module` factories are untyped.
  securitySensitiveAuditFields: () => null,
  _resetSettingsCache: () => {},
  HOT_RELOADED_KEYS: new Set<string>(),
  SECURITY_SENSITIVE_KEYS: new Set<string>(),
}));

const {
  DEFAULT_CHAT_BACKFILL_DAYS,
  createSlackHistoryConnector,
  getChatBackfillWindowMs,
  registerSlackHistoryConnector,
  resolveSlackHistoryToken,
} = await import("@atlas/api/lib/brain/ingest/slack/connector");
const { _resetBrainSourceConnectors, getBrainSourceConnector } = await import(
  "@atlas/api/lib/brain/ingest/types"
);
const { SLACK_HISTORY_CATALOG_ID } = await import(
  "@atlas/api/lib/brain/ingest/slack/config"
);

const DEFAULT_MS = DEFAULT_CHAT_BACKFILL_DAYS * 86_400_000;

function store(opts: { installation?: boolean; token?: string | null } = {}) {
  return {
    getInstallationByOrg: async () =>
      opts.installation === false
        ? null
        : ({
            team_id: "T1",
            org_id: "ws-1",
            workspace_name: "w",
            installed_at: "now",
          } as SlackInstallationWithSecret),
    getBotToken: async () => (opts.token === undefined ? "xoxb-test" : opts.token),
  };
}

afterEach(() => {
  SETTING = undefined;
  _resetBrainSourceConnectors();
});

describe("getChatBackfillWindowMs", () => {
  it("uses the default when unset or empty", () => {
    SETTING = undefined;
    expect(getChatBackfillWindowMs()).toBe(DEFAULT_MS);
    SETTING = "";
    expect(getChatBackfillWindowMs()).toBe(DEFAULT_MS);
  });

  it("honours a configured window, including a fractional one", () => {
    SETTING = "14";
    expect(getChatBackfillWindowMs()).toBe(14 * 86_400_000);
    SETTING = "0.5";
    expect(getChatBackfillWindowMs()).toBe(0.5 * 86_400_000);
  });

  it("falls back to the default rather than a ZERO window", () => {
    // A zero window is the silent-green failure: floor == now, every channel
    // reads an empty range, and the source reports success forever.
    for (const raw of ["0", "-1", "abc", "NaN"]) {
      SETTING = raw;
      expect({ raw, ms: getChatBackfillWindowMs() }).toEqual({ raw, ms: DEFAULT_MS });
    }
  });
});

describe("resolveSlackHistoryToken", () => {
  it("returns the workspace's bot token", async () => {
    expect(await resolveSlackHistoryToken(store(), "ws-1")).toBe("xoxb-test");
  });

  it("says CONNECT when there is no Slack install", async () => {
    await expect(resolveSlackHistoryToken(store({ installation: false }), "ws-1")).rejects.toThrow(
      /connect Slack/i,
    );
  });

  it("says RECONNECT when the install exists but its token cannot be read", async () => {
    // The decrypt-failure path — `getInstallation` hides a row whose token will
    // not decrypt. Re-running OAuth is the fix; re-inviting the bot is not, so
    // the two arms must not share a message.
    for (const token of [null, ""]) {
      await expect(resolveSlackHistoryToken(store({ token }), "ws-1")).rejects.toThrow(
        /reconnect Slack/i,
      );
    }
  });
});

describe("createClient", () => {
  // #5203: there is no stored config left to refuse. `config` is null on every
  // per-workspace dispatch, and scope comes from the resolver — so the old
  // "refuses a config with no usable channels" test has no subject. What
  // replaced it is the arm below: a membership read that FAILS must reject
  // rather than build a client over a stale or empty channel set.
  it("surfaces the token failure rather than building a client that cannot fetch", async () => {
    const connector = createSlackHistoryConnector({
      store: store({ installation: false }),
      refreshScope: scopeRefresh(),
      resolvePollScope: pollScope(),
    });
    await expect(
      connector.createClient({ workspaceId: "ws-1", installId: "i", config: null }),
    ).rejects.toThrow(/connect Slack/i);
  });

  it("⭐ REJECTS when the membership read fails — never polls a stale scope", async () => {
    // The load-bearing arm (#5203). `episode-sync.ts` turns this throw into a
    // recorded `status: "error"` attempt. If it resolved to an empty or
    // last-known scope instead, a cycle that could not read Slack would poll
    // nothing and report itself green — which is M1's failure shape exactly,
    // rebuilt one layer down.
    const connector = createSlackHistoryConnector({
      store: store(),
      refreshScope: () => Promise.reject(new Error("Could not read this workspace's Slack channel membership (invalid_auth)")),
      resolvePollScope: pollScope(),
    });
    await expect(
      connector.createClient({ workspaceId: "ws-1", installId: "i", config: null }),
    ).rejects.toThrow(/channel membership/i);
  });

  it("builds a client over the RESOLVED scope, with no stored config", async () => {
    const connector = createSlackHistoryConnector({
      store: store(),
      refreshScope: scopeRefresh(),
      resolvePollScope: pollScope(["C01ABCDEF", "C02GHIJKL"]),
    });
    const client = await connector.createClient({
      workspaceId: "ws-1",
      installId: "i",
      config: null,
    });
    expect(typeof client.fetchEpisodes).toBe("function");
  });
});

/** A scope refresh that observed everything and changed nothing. */
function scopeRefresh(warnings: readonly string[] = []) {
  return async () => ({
    mode: "membership" as const,
    observed: 2,
    retired: 0,
    reconciledExclusions: 0,
    membershipIncomplete: false,
    probed: 0,
    unhealthy: 0,
    warnings,
  });
}

function pollScope(channels: readonly string[] = ["C01ABCDEF"]) {
  return async () => ({
    mode: "membership" as const,
    channels,
    excludedInMembership: 0,
  });
}

describe("registerSlackHistoryConnector", () => {
  it("registers once and is idempotent", () => {
    // `registerBuiltinInstallHandlers()` runs repeatedly across suites, and
    // `registerBrainSourceConnector` throws on a duplicate catalog id.
    registerSlackHistoryConnector();
    registerSlackHistoryConnector();
    expect(getBrainSourceConnector(SLACK_HISTORY_CATALOG_ID)?.source).toBe("slack");
  });
});
