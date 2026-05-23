/**
 * Tests for the Jira refresh-token rotation flow (#2659).
 *
 * Coverage mirrors `salesforce-token-refresh.test.ts`; the
 * Atlassian-specific pin is the **refresh-token rotation** assertion —
 * Atlassian returns a fresh refresh_token in every success response and
 * the new value MUST land in `integration_credentials`. Salesforce
 * sometimes omits it; Atlassian always returns it. If a refactor drops
 * the rotated value, the install dies on the second refresh.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";

const mockReadCredentialBundle: Mock<(ws: string, cat: string) => Promise<unknown>> = mock(() =>
  Promise.resolve(null),
);
const mockSaveCredentialBundle: Mock<(ws: string, cat: string, bundle: unknown) => Promise<void>> = mock(() =>
  Promise.resolve(),
);

mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
  readCredentialBundle: mockReadCredentialBundle,
  saveCredentialBundle: mockSaveCredentialBundle,
  deleteCredentialBundle: mock(() => Promise.resolve(false)),
}));

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(() =>
  Promise.resolve([]),
);
mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

const ORIGINAL_FETCH = globalThis.fetch;
const mockFetch: Mock<(input: unknown, init?: unknown) => Promise<Response>> = mock(() =>
  Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
);

type RefreshModule = typeof import("../jira-token-refresh");
let refreshMod!: RefreshModule;

beforeAll(async () => {
  refreshMod = await import("../jira-token-refresh");
});

const ORIGINAL_ENV = { ...process.env };
const WSID = "ws-jira-refresh-test-1";
const CLOUDID = "11223344-aaaa-bbbb-cccc-ddddeeee0000";

const STORED_BUNDLE = {
  accessToken: "old-access-token",
  refreshToken: "stored-refresh-token",
  expiresAt: 1_700_000_000_000,
  tokenType: "Bearer",
  scope: "read:jira-work read:jira-user offline_access",
  instanceUrl: `https://api.atlassian.com/ex/jira/${CLOUDID}`,
};

const JIRA_ARGS = {
  workspaceId: WSID,
  clientId: "jira-client-id",
  clientSecret: "jira-client-secret",
};

beforeEach(() => {
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-one";
  _resetEncryptionKeyCache();
  mockReadCredentialBundle.mockClear();
  mockSaveCredentialBundle.mockClear();
  mockInternalQuery.mockClear();
  mockFetch.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// Happy path — refresh-token rotation
// ---------------------------------------------------------------------------

describe("refreshJiraToken — happy path (refresh-token rotation)", () => {
  it("exchanges the refresh token, persists the ROTATED refresh_token, and clears reconnect_needed", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access-token",
            // Atlassian-specific: the refresh_token rotates on every
            // refresh. The new value MUST be persisted; using the old
            // refresh token on the next refresh would fail with
            // invalid_grant and force a Reconnect.
            refresh_token: "ROTATED-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "read:jira-work read:jira-user offline_access",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await refreshMod.refreshJiraToken(JIRA_ARGS);

    expect(result.accessToken).toBe("new-access-token");
    // Critical pin — without this assertion a regression that "preserved
    // the stored refresh token" (mirroring Salesforce's behaviour
    // wrongly) would compile + pass everything except the second
    // refresh.
    expect(result.refreshToken).toBe("ROTATED-refresh-token");
    expect(result.instanceUrl).toBe(`https://api.atlassian.com/ex/jira/${CLOUDID}`);

    // Token-endpoint POST shape — JSON body, not form-encoded.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [tokenUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://auth.atlassian.com/oauth/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      grant_type: "refresh_token",
      client_id: "jira-client-id",
      refresh_token: "stored-refresh-token",
    });

    // Persisted bundle carries the rotated refresh_token.
    expect(mockSaveCredentialBundle).toHaveBeenCalledWith(
      WSID,
      "catalog:jira",
      expect.objectContaining({
        accessToken: "new-access-token",
        refreshToken: "ROTATED-refresh-token",
      }),
    );

    // clear-reconnect UPDATE fires alongside the save (independent
    // statement — see jira-token-refresh.ts JSDoc).
    const clearUpdate = mockInternalQuery.mock.calls.find(
      (c) =>
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("'ok'"),
    );
    expect(clearUpdate).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Permanent failure → reconnect_needed
// ---------------------------------------------------------------------------

describe("refreshJiraToken — permanent failure", () => {
  it("on invalid_grant: throws JiraReconnectRequiredError + marks status reconnect_needed", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "refresh token rejected" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(refreshMod.refreshJiraToken(JIRA_ARGS)).rejects.toMatchObject({
      _tag: "JiraReconnectRequiredError",
      workspaceId: WSID,
      upstreamError: "invalid_grant",
    });

    // No credential persistence on failure.
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();

    // markReconnectNeeded UPDATE fires.
    const markUpdate = mockInternalQuery.mock.calls.find(
      (c) =>
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("'reconnect_needed'"),
    );
    expect(markUpdate).toBeDefined();
  });

  it("on bundle missing refresh_token: short-circuits to JiraReconnectRequiredError without a fetch", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce({
      ...STORED_BUNDLE,
      refreshToken: null,
    });

    await expect(refreshMod.refreshJiraToken(JIRA_ARGS)).rejects.toMatchObject({
      _tag: "JiraReconnectRequiredError",
      upstreamError: "no_refresh_token",
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Transient failure → NO reconnect_needed
// ---------------------------------------------------------------------------

describe("refreshJiraToken — transient failure", () => {
  it("on network failure: throws plain Error, does NOT mark reconnect_needed", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.reject(new Error("ECONNRESET")),
    );

    await expect(refreshMod.refreshJiraToken(JIRA_ARGS)).rejects.toThrow("ECONNRESET");

    // Crucial — a transient flake must not flip every workspace's
    // status to reconnect_needed.
    const markUpdate = mockInternalQuery.mock.calls.find(
      (c) =>
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("'reconnect_needed'"),
    );
    expect(markUpdate).toBeUndefined();
  });

  it("on HTTP 500 with no recognized error code: throws plain Error, does NOT mark reconnect_needed", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "server_error" }), { status: 500 }),
      ),
    );

    await expect(refreshMod.refreshJiraToken(JIRA_ARGS)).rejects.toThrow(/HTTP 500/);

    const markUpdate = mockInternalQuery.mock.calls.find(
      (c) =>
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("'reconnect_needed'"),
    );
    expect(markUpdate).toBeUndefined();
  });

  it("on HTTP 400 with an unknown error code (e.g. invalid_request): throws plain Error, does NOT mark reconnect_needed", async () => {
    // PERMANENT_REFRESH_FAILURE_CODES is intentionally narrow. An
    // unknown 400 shouldn't strand every workspace on the assumption
    // that the upstream contract changed silently.
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "invalid_request", error_description: "bad" }),
          { status: 400 },
        ),
      ),
    );

    await expect(refreshMod.refreshJiraToken(JIRA_ARGS)).rejects.toThrow(/HTTP 400/);

    const markUpdate = mockInternalQuery.mock.calls.find(
      (c) =>
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("'reconnect_needed'"),
    );
    expect(markUpdate).toBeUndefined();
  });
});
