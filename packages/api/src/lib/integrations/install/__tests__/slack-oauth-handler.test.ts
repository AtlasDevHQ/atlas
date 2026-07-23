/**
 * Tests for {@link SlackOAuthInstallHandler} — slice 5 of #2649 (issue #2653).
 *
 * The handler implements {@link OAuthPlatformInstallHandler} and is the
 * lift of the previous `/api/v1/slack/{install,callback}` route bodies
 * into a reusable shape. Coverage pins the contract documented on the
 * interface: state-token verify fails → null (no throw); upstream Slack
 * refusal → tagged `PlatformOAuthExchangeError`; partial failure
 * (workspace_plugins INSERT succeeds, chat_cache write throws) →
 * `credentialResult.written: false` while keeping the install record.
 *
 * `mock.module()` is used to stub the module dependencies the handler
 * reaches into: `lib/slack/api` (`slackAPI` — the `oauth.v2.access`
 * exchange), `lib/slack/store` (`saveInstallation` — the per-tenant
 * `chat_cache:slack:installation:<teamId>` write), and
 * `lib/billing/enforcement` (`checkChatIntegrationLimitAndInstall` — the
 * atomic cap-gate that owns the `workspace_plugins` INSERT post-#3001).
 * Each mock exports every named export it shadows so other tests in the
 * suite don't see a partial module.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { mutateLastChar } from "../../../../__test-utils__/base64url";
import {
  mintOAuthStateToken,
  verifyOAuthStateToken,
} from "../oauth-state-token";
import type { WorkspaceId } from "@useatlas/types";
import type { ResourceLimitResult } from "@atlas/api/lib/billing/enforcement";

// ---------------------------------------------------------------------------
// Module mocks (must hoist above the handler import below)
// ---------------------------------------------------------------------------

const mockSlackAPI: Mock<
  (method: string, token: string, body: unknown) =>
    Promise<{ ok: true; team?: { id?: string; name?: string }; access_token?: string; bot_user_id?: string; scope?: string; app_id?: string } | { ok: false; error: string }>
> = mock(() =>
  Promise.resolve({
    ok: true as const,
    team: { id: "T999", name: "TestTeam" },
    access_token: "xoxb-installed-token",
    bot_user_id: "U-BOT",
    scope: "commands,chat:write,app_mentions:read",
    app_id: "A1234",
  }),
);

void mock.module("@atlas/api/lib/slack/api", () => ({
  slackAPI: mockSlackAPI,
  postMessage: mock(() => Promise.resolve({ ok: true })),
  updateMessage: mock(() => Promise.resolve({ ok: true })),
  postEphemeral: mock(() => Promise.resolve({ ok: true })),
  listChannels: mock(() => Promise.resolve({ ok: true as const, channels: [] })),
}));

const mockSaveInstallation: Mock<
  (teamId: string, botToken: string, opts?: { orgId?: string; workspaceName?: string }) => Promise<void>
> = mock(() => Promise.resolve());

void mock.module("@atlas/api/lib/slack/store", () => ({
  saveInstallation: mockSaveInstallation,
  getInstallation: mock(() => Promise.resolve(null)),
  getInstallationByOrg: mock(() => Promise.resolve(null)),
  getBotToken: mock(() => Promise.resolve(null)),
  deleteInstallation: mock(() => Promise.resolve()),
  deleteInstallationByOrg: mock(() => Promise.resolve(false)),
  ENV_TEAM_ID: "env" as const,
  KEY_PREFIX: "slack:installation:" as const,
  FIELD: {
    botToken: "botToken",
    botUserId: "botUserId",
    teamName: "teamName",
    orgId: "orgId",
    workspaceName: "workspaceName",
    installedAt: "installedAt",
  } as const,
}));

void mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mock(() => Promise.resolve([])),
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

// The chat-integration cap + the `workspace_plugins` INSERT now run atomically
// through `checkChatIntegrationLimitAndInstall` (#3001) — the gate owns the
// write. We stub it to "allowed" so these handler tests stay focused on the
// OAuth/credential contract and assert the INSERT shape via the gate's `insert`
// arg; the cap-enforcement decision + transaction sequencing live in
// `billing/__tests__/enforcement.test.ts`. The `at cap` / `check failed` tests
// below override it via `mockImplementationOnce`.
type GateResult =
  | { allowed: true; rows: Array<Record<string, unknown>> }
  | { allowed: false; reason: "cap_reached"; errorMessage: string; limit: number }
  | { allowed: false; reason: "check_failed"; errorMessage: string };
// The persisted `workspace_plugins` id the gate's `RETURNING id` would surface
// on the happy path. The handler now reads `installRecord.id` from this (#3005)
// — the default arm must carry a row so the non-empty guard doesn't trip.
const DEFAULT_PERSISTED_ID = "wp-default-install-id";
const mockCheckChatLimitAndInstall: Mock<
  (
    orgId: string | undefined,
    catalogId: string,
    insert: { sql: string; params: readonly unknown[] },
  ) => Promise<GateResult>
> = mock(() => Promise.resolve({ allowed: true as const, rows: [{ id: DEFAULT_PERSISTED_ID }] }));

// Read-only pre-redirect cap precheck (#2998), called by `startInstall`. The
// `at cap` / `check failed` startInstall tests override it via
// `mockImplementationOnce`; the default is "allowed" so the happy-path
// startInstall + every handleCallback test sails past it.
//
// Anchor the mock's result type to the REAL `ResourceLimitResult` (type-only
// import — no runtime code pulled into the mock graph) so the mock can't drift
// from the production return shape. Mirrors the drift-proof `Extract<>` pattern
// in `billing/__tests__/enforcement.test.ts`.
type PrecheckResult = ResourceLimitResult;
const mockCheckChatLimit: Mock<
  (orgId: string | undefined, catalogId: string) => Promise<PrecheckResult>
> = mock(() => Promise.resolve({ allowed: true as const }));

// Mock every value export — a partial `mock.module()` causes a `SyntaxError`
// in other files importing the missing exports (per CLAUDE.md "Mock all
// exports"). `checkChatIntegrationLimit` (pre-redirect precheck) +
// `checkChatIntegrationLimitAndInstall` (callback gate) are exercised here; the
// rest are inert no-ops.
void mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkChatIntegrationLimit: mockCheckChatLimit,
  checkChatIntegrationLimitAndInstall: mockCheckChatLimitAndInstall,
  CHAT_INTEGRATION_COUNT_SQL: "SELECT 1",
  checkResourceLimit: () => Promise.resolve({ allowed: true }),
  checkPlanLimits: () => Promise.resolve({ allowed: true }),
  getCachedWorkspace: () => Promise.resolve(null),
  invalidatePlanCache: () => {},
  buildMetricStatus: () => ({ metric: "tokens", currentUsage: 0, limit: 0, usagePercent: 0, status: "ok" }),
  severityOf: () => 0,
}));

// ---------------------------------------------------------------------------
// Test scaffolding — env-driven keyset (mintOAuthStateToken needs it)
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

function setKeys(value: string): void {
  process.env.ATLAS_ENCRYPTION_KEYS = value;
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
}

const WSID = "ws-test-1" as WorkspaceId;
const SLACK_CONFIG = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://atlas.example/api/v1/integrations/slack/callback",
};

// Late-import the handler module so the mock.module wiring is in place
// before the SUT touches its dependencies. `import * as` works around
// `mock.module()` returning a fresh module reference each test.
type SlackOAuthInstallHandlerCtor = typeof import("../slack-oauth-handler").SlackOAuthInstallHandler;
let SlackOAuthInstallHandler!: SlackOAuthInstallHandlerCtor;

beforeAll(async () => {
  const mod = await import("../slack-oauth-handler");
  SlackOAuthInstallHandler = mod.SlackOAuthInstallHandler;
});

beforeEach(() => {
  setKeys("v1:test-key-one");
  mockSlackAPI.mockClear();
  mockSaveInstallation.mockClear();
  mockCheckChatLimit.mockClear();
  mockCheckChatLimit.mockImplementation(() => Promise.resolve({ allowed: true as const }));
  mockCheckChatLimitAndInstall.mockClear();
  mockCheckChatLimitAndInstall.mockImplementation(() =>
    Promise.resolve({ allowed: true as const, rows: [{ id: DEFAULT_PERSISTED_ID }] }),
  );
  // Default to the happy-path Slack response — individual tests override
  // via `mockResolvedValueOnce` / `mockImplementationOnce`.
  mockSlackAPI.mockImplementation(() =>
    Promise.resolve({
      ok: true as const,
      team: { id: "T999", name: "TestTeam" },
      access_token: "xoxb-installed-token",
      bot_user_id: "U-BOT",
      scope: "commands,chat:write,app_mentions:read",
      app_id: "A1234",
    }),
  );
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

// ---------------------------------------------------------------------------
// startInstall
// ---------------------------------------------------------------------------

describe("SlackOAuthInstallHandler.startInstall", () => {
  it("returns a Slack authorize URL with the minted state token in the query string", async () => {
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);

    const { redirectUrl, stateToken } = await handler.startInstall(WSID);

    expect(stateToken).toBeTypeOf("string");
    expect(stateToken.length).toBeGreaterThan(0);

    const parsed = new URL(redirectUrl);
    expect(parsed.origin + parsed.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(parsed.searchParams.get("client_id")).toBe(SLACK_CONFIG.clientId);
    expect(parsed.searchParams.get("state")).toBe(stateToken);
    // Legacy slack.ts scopes (preserved by lift) + the conversation-read
    // pair powering the admin channel picker.
    expect(parsed.searchParams.get("scope")).toBe(
      "commands,chat:write,app_mentions:read,channels:read,groups:read",
    );
    expect(parsed.searchParams.get("redirect_uri")).toBe(SLACK_CONFIG.redirectUri);
  });

  it("mints a state token that verifies back to (workspaceId, 'slack')", async () => {
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);

    const { stateToken } = await handler.startInstall(WSID);

    expect(verifyOAuthStateToken(stateToken)).toEqual({
      workspaceId: WSID,
      catalogId: "slack",
    });
  });

  // ── Pre-redirect chat-integration cap gate (#2998) ────────────────

  it("runs the cap precheck for (workspaceId, 'catalog:slack') before minting the redirect", async () => {
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);

    await handler.startInstall(WSID);

    expect(mockCheckChatLimit).toHaveBeenCalledTimes(1);
    const [org, catalog] = mockCheckChatLimit.mock.calls[0];
    expect(org).toBe(WSID);
    expect(catalog).toBe("catalog:slack");
  });

  it("throws ChatIntegrationLimitError (no redirect minted) when the workspace is at its cap", async () => {
    mockCheckChatLimit.mockImplementationOnce(() =>
      Promise.resolve({
        allowed: false as const,
        reason: "cap_reached" as const,
        errorMessage: "Your starter plan allows up to 1 chat integration. Upgrade to add more.",
        limit: 1,
        tier: "starter" as const,
      }),
    );
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);

    await expect(handler.startInstall(WSID)).rejects.toMatchObject({
      _tag: "ChatIntegrationLimitError",
      limit: 1,
    });
  });

  it("throws BillingCheckFailedError (not the cap error) when the precheck fails closed", async () => {
    mockCheckChatLimit.mockImplementationOnce(() =>
      Promise.resolve({
        allowed: false as const,
        reason: "check_failed" as const,
        errorMessage: "Unable to verify plan limits. Please try again.",
      }),
    );
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);

    await expect(handler.startInstall(WSID)).rejects.toMatchObject({
      _tag: "BillingCheckFailedError",
    });
  });
});

// ---------------------------------------------------------------------------
// handleCallback — happy path
// ---------------------------------------------------------------------------

describe("SlackOAuthInstallHandler.handleCallback — happy path", () => {
  it("verifies state, exchanges the code, and writes both stores in order", async () => {
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "slack");

    const result = await handler.handleCallback("auth-code-abc", stateToken);

    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe(WSID);
    expect(result!.catalogId).toBe("slack");
    expect(result!.credentialResult).toEqual({ written: true });
    expect(result!.installRecord.workspaceId).toBe(WSID);
    expect(result!.installRecord.catalogId).toBe("slack");
    // The install record id is the persisted row id from the gate's RETURNING,
    // not the candidate UUID the handler minted (#3005).
    expect(result!.installRecord.id).toBe(DEFAULT_PERSISTED_ID);

    // oauth.v2.access called with the configured client id/secret + code.
    expect(mockSlackAPI).toHaveBeenCalledTimes(1);
    const [method, _token, body] = mockSlackAPI.mock.calls[0];
    expect(method).toBe("oauth.v2.access");
    expect(body).toMatchObject({
      client_id: SLACK_CONFIG.clientId,
      client_secret: SLACK_CONFIG.clientSecret,
      code: "auth-code-abc",
      redirect_uri: SLACK_CONFIG.redirectUri,
    });

    // workspace_plugins INSERT — now run atomically by the cap gate, BEFORE
    // the chat_cache write per ADR-0003. Assert the gate was called once with
    // the workspace id + catalog id and an INSERT carrying the right params.
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    const [gateOrg, gateCatalog, gateInsert] = mockCheckChatLimitAndInstall.mock.calls[0];
    expect(gateOrg).toBe(WSID);
    expect(gateCatalog).toBe("catalog:slack");
    expect(gateInsert.sql).toContain("INSERT INTO workspace_plugins");
    // The params include the workspaceId + catalog_id `catalog:slack`
    // (which matches the seed id pattern from catalog-seeder.ts).
    const paramsList = gateInsert.params as unknown[];
    expect(paramsList).toContain(WSID);
    expect(paramsList).toContain("catalog:slack");

    // chat_cache write via saveInstallation — last, so a Slack-side
    // failure doesn't leave a half-written install row.
    expect(mockSaveInstallation).toHaveBeenCalledTimes(1);
    expect(mockSaveInstallation).toHaveBeenCalledWith(
      "T999",
      "xoxb-installed-token",
      expect.objectContaining({ orgId: WSID, workspaceName: "TestTeam" }),
    );
  });

  it("carries Slack metadata (team_id, team_name, bot_user_id, scopes, app_id) into workspace_plugins.config", async () => {
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "slack");

    await handler.handleCallback("auth-code-abc", stateToken);

    const [, , gateInsert] = mockCheckChatLimitAndInstall.mock.calls[0];
    const paramsList = gateInsert.params as unknown[];
    // Find the JSONB config string — the only param that's a JSON object.
    const configJson = paramsList.find((p) =>
      typeof p === "string" && p.startsWith("{") && p.includes("team_id"),
    );
    expect(configJson).toBeDefined();
    const config = JSON.parse(configJson as string);
    expect(config).toMatchObject({
      team_id: "T999",
      team_name: "TestTeam",
      bot_user_id: "U-BOT",
      scopes: "commands,chat:write,app_mentions:read",
      app_id: "A1234",
    });
  });
});

// ---------------------------------------------------------------------------
// handleCallback — state rejection (must NOT throw, must NOT write)
// ---------------------------------------------------------------------------

describe("SlackOAuthInstallHandler.handleCallback — state rejection", () => {
  it("returns null when the state token is tampered (no throw, no writes)", async () => {
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    const good = mintOAuthStateToken(WSID, "slack");
    const parts = good.split(".");
    const tampered = `${parts[0]}.${mutateLastChar(parts[1])}.${parts[2]}`;

    const result = await handler.handleCallback("auth-code-abc", tampered);

    expect(result).toBeNull();
    expect(mockSlackAPI).not.toHaveBeenCalled();
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it("returns null when the state token has expired", async () => {
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    // Mint with a past `nowSeconds` so the token's `exp` is already in
    // the past — verify rejects.
    const expired = mintOAuthStateToken(WSID, "slack", {
      ttlSeconds: 1,
      nowSeconds: Math.floor(Date.now() / 1000) - 3600,
    });

    const result = await handler.handleCallback("auth-code-abc", expired);

    expect(result).toBeNull();
    expect(mockSlackAPI).not.toHaveBeenCalled();
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it("returns null when the state token is empty", async () => {
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);

    const result = await handler.handleCallback("auth-code-abc", "");

    expect(result).toBeNull();
    expect(mockSlackAPI).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCallback — upstream Slack failure
// ---------------------------------------------------------------------------

describe("SlackOAuthInstallHandler.handleCallback — Slack-side failure", () => {
  it("throws PlatformOAuthExchangeError when oauth.v2.access returns non-OK (no writes)", async () => {
    mockSlackAPI.mockImplementationOnce(() =>
      Promise.resolve({ ok: false as const, error: "invalid_code" }),
    );
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "slack");

    await expect(handler.handleCallback("bad-code", stateToken)).rejects.toMatchObject({
      _tag: "PlatformOAuthExchangeError",
      platform: "slack",
      upstreamError: "invalid_code",
    });

    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it("throws PlatformOAuthExchangeError when Slack response is structurally incomplete (missing team or token)", async () => {
    mockSlackAPI.mockImplementationOnce(() =>
      Promise.resolve({ ok: true as const }), // no team, no access_token
    );
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "slack");

    await expect(handler.handleCallback("auth-code", stateToken)).rejects.toMatchObject({
      _tag: "PlatformOAuthExchangeError",
      platform: "slack",
    });

    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCallback — chat-integration cap (#2953)
// ---------------------------------------------------------------------------

describe("SlackOAuthInstallHandler.handleCallback — chat-integration cap", () => {
  it("throws ChatIntegrationLimitError and writes no credential when at cap", async () => {
    // The gate rolls back the workspace_plugins INSERT internally on a cap
    // denial, so it returns `cap_reached` with no rows written.
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({
        allowed: false as const,
        reason: "cap_reached" as const,
        errorMessage: "Your starter plan allows up to 1 chat integration. Upgrade to add more.",
        limit: 1,
        tier: "starter" as const,
      }),
    );
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "slack");

    await expect(handler.handleCallback("auth-code", stateToken)).rejects.toMatchObject({
      _tag: "ChatIntegrationLimitError",
      limit: 1,
    });

    // The gate enforced the cap (and rolled back its INSERT); the credential
    // store is never reached.
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    const [gateOrg, gateCatalog] = mockCheckChatLimitAndInstall.mock.calls[0];
    expect(gateOrg).toBe(WSID);
    expect(gateCatalog).toBe("catalog:slack");
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it("throws BillingCheckFailedError (not the cap error) when the count check fails closed", async () => {
    // A DB blip means we can't read the count → fail closed, but as a
    // transient 503 "try again", not a 429 "upgrade your plan".
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({
        allowed: false as const,
        reason: "check_failed" as const,
        errorMessage: "Unable to verify plan limits. Please try again.",
      }),
    );
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "slack");

    await expect(handler.handleCallback("auth-code", stateToken)).rejects.toMatchObject({
      _tag: "BillingCheckFailedError",
    });

    // Still fail closed — the credential store is never reached.
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCallback — partial failure (ADR-0003 Reconnect path)
// ---------------------------------------------------------------------------

describe("SlackOAuthInstallHandler.handleCallback — install record id (#3005)", () => {
  it("returns the persisted workspace_plugins id from the gate's RETURNING row, not a fresh UUID", async () => {
    // #3005: on reconnect the UPSERT lands on the existing row, which keeps
    // its ORIGINAL id (ON CONFLICT DO UPDATE never touches `id`). The handler
    // must hand back the persisted id (gate `rows[0].id`), not the freshly
    // minted `crypto.randomUUID()` it passes IN as the candidate. With the gate
    // mocked, this pins the HANDLER contract (reads `rows[0].id`, not the
    // candidate); the end-to-end two-call reconnect semantics against a real
    // `ON CONFLICT DO UPDATE` row live in `billing/__tests__/chat-cap-pg.test.ts`.
    const persistedId = "wp-existing-reconnect-id";
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({ allowed: true as const, rows: [{ id: persistedId }] }),
    );
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "slack");

    const result = await handler.handleCallback("auth-code", stateToken);

    expect(result).not.toBeNull();
    expect(result!.installRecord.id).toBe(persistedId);
    // The candidate id the handler generated is the INSERT's `$1` param — it
    // must NOT be the value returned when the row already existed.
    const [, , gateInsert] = mockCheckChatLimitAndInstall.mock.calls[0];
    const candidateId = (gateInsert.params as unknown[])[0];
    expect(candidateId).not.toBe(persistedId);
  });

  it("throws when the gate returns no id (RETURNING empty — driver regression), and writes no credential", async () => {
    // Postgres ≥9.5 guarantees INSERT … ON CONFLICT … RETURNING populates on
    // both insert and update. An empty row signals a driver/wrapper regression
    // — fail loud rather than ship a stale candidate id back. Mirrors the
    // Discord handler's non-empty guard.
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({ allowed: true as const, rows: [] }),
    );
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "slack");

    await expect(handler.handleCallback("auth-code", stateToken)).rejects.toThrow();
    // The credential store is never reached when the install row id is missing.
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });
});

describe("SlackOAuthInstallHandler.handleCallback — partial failure", () => {
  it("returns credentialResult.written=false when workspace_plugins write succeeds but chat_cache write throws", async () => {
    // workspace_plugins INSERT succeeds, chat_cache write rejects.
    mockSaveInstallation.mockImplementationOnce(() =>
      Promise.reject(new Error("transient connection refusal")),
    );
    const handler = new SlackOAuthInstallHandler(SLACK_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "slack");

    const result = await handler.handleCallback("auth-code", stateToken);

    expect(result).not.toBeNull();
    expect(result!.installRecord.workspaceId).toBe(WSID);
    expect(result!.installRecord.catalogId).toBe("slack");
    expect(result!.credentialResult.written).toBe(false);
    expect(result!.credentialResult.reason).toBeTypeOf("string");
    expect(result!.credentialResult.reason).toContain("Reconnect");

    // The cap gate ran the workspace_plugins INSERT (and committed it);
    // only the subsequent credential write failed.
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    expect(mockSaveInstallation).toHaveBeenCalledTimes(1);
  });
});
