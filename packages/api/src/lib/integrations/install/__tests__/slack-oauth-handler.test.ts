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
 * `mock.module()` is used to stub the three module dependencies the
 * handler reaches into: `lib/slack/api` (`slackAPI` — the
 * `oauth.v2.access` exchange), `lib/slack/store` (`saveInstallation` —
 * the per-tenant `chat_cache:slack:installation:<teamId>` write), and
 * `lib/db/internal` (`internalQuery` — the `workspace_plugins` INSERT).
 * Each mock exports every named export it shadows so other tests in
 * the suite don't see a partial module.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import {
  mintOAuthStateToken,
  verifyOAuthStateToken,
} from "../oauth-state-token";
import type { WorkspaceId } from "@useatlas/types";

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

mock.module("@atlas/api/lib/slack/api", () => ({
  slackAPI: mockSlackAPI,
  postMessage: mock(() => Promise.resolve({ ok: true })),
  updateMessage: mock(() => Promise.resolve({ ok: true })),
  postEphemeral: mock(() => Promise.resolve({ ok: true })),
}));

const mockSaveInstallation: Mock<
  (teamId: string, botToken: string, opts?: { orgId?: string; workspaceName?: string }) => Promise<void>
> = mock(() => Promise.resolve());

mock.module("@atlas/api/lib/slack/store", () => ({
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

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(() =>
  Promise.resolve([]),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

// ---------------------------------------------------------------------------
// Test scaffolding — env-driven keyset (mintOAuthStateToken needs it)
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

function setKeys(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
  } else {
    process.env.ATLAS_ENCRYPTION_KEYS = value;
  }
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
  mockInternalQuery.mockClear();
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
    // Scopes match the legacy slack.ts install route (preserved by lift).
    expect(parsed.searchParams.get("scope")).toBe("commands,chat:write,app_mentions:read");
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

    // workspace_plugins INSERT — happens BEFORE the chat_cache write per ADR-0003.
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO workspace_plugins");
    // The params include the workspaceId + catalog_id `catalog:slack`
    // (which matches the seed id pattern from catalog-seeder.ts).
    expect(params).toBeDefined();
    const paramsList = params as unknown[];
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

    const [_sql, params] = mockInternalQuery.mock.calls[0];
    const paramsList = params as unknown[];
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
    const tampered = `${parts[0]}.${parts[1].slice(0, -1)}X.${parts[2]}`;

    const result = await handler.handleCallback("auth-code-abc", tampered);

    expect(result).toBeNull();
    expect(mockSlackAPI).not.toHaveBeenCalled();
    expect(mockInternalQuery).not.toHaveBeenCalled();
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
    expect(mockInternalQuery).not.toHaveBeenCalled();
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

    expect(mockInternalQuery).not.toHaveBeenCalled();
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

    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCallback — partial failure (ADR-0003 Reconnect path)
// ---------------------------------------------------------------------------

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

    // workspace_plugins INSERT happened.
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    expect(mockSaveInstallation).toHaveBeenCalledTimes(1);
  });
});
