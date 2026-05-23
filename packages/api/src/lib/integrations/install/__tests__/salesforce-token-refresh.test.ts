/**
 * Tests for the Salesforce refresh-token rotation flow (#2658).
 *
 * Coverage:
 *   - Happy refresh: exchanges grant_type=refresh_token, persists
 *     updated bundle, clears reconnect_needed.
 *   - Permanent failure (invalid_grant): throws
 *     SalesforceReconnectRequiredError + marks
 *     workspace_plugins.config.status = 'reconnect_needed'.
 *   - Transient failure (network / 5xx): throws plain Error without
 *     marking reconnect_needed.
 *   - Bundle missing refresh_token: short-circuits to
 *     SalesforceReconnectRequiredError without an HTTP call.
 *   - Salesforce omitting refresh_token in response: previous token
 *     stays in the persisted bundle.
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
// Loosely typed — `fetch` from bun-types carries a `preconnect` method that
// a vanilla mock function doesn't, but the runtime call shape is identical.
const mockFetch: Mock<(input: unknown, init?: unknown) => Promise<Response>> = mock(() =>
  Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
);

type RefreshModule = typeof import("../salesforce-token-refresh");
let refreshMod!: RefreshModule;

beforeAll(async () => {
  refreshMod = await import("../salesforce-token-refresh");
});

const ORIGINAL_ENV = { ...process.env };
const WSID = "ws-refresh-test-1";

const STORED_BUNDLE = {
  accessToken: "old-access-token",
  refreshToken: "stored-refresh-token",
  expiresAt: 1_700_000_000_000,
  tokenType: "Bearer",
  scope: "api refresh_token offline_access",
  instanceUrl: "https://na139.my.salesforce.com",
};

const SF_ARGS = {
  workspaceId: WSID,
  clientId: "sf-client-id",
  clientSecret: "sf-client-secret",
};

beforeEach(() => {
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-one";
  _resetEncryptionKeyCache();
  mockReadCredentialBundle.mockClear();
  mockSaveCredentialBundle.mockClear();
  mockInternalQuery.mockClear();
  mockFetch.mockClear();
  // Loose cast — see comment near mockFetch declaration.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("refreshSalesforceToken — happy path", () => {
  it("exchanges the refresh token, persists the new bundle, and clears reconnect_needed", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "rolled-refresh-token",
            instance_url: "https://na139.my.salesforce.com",
            token_type: "Bearer",
            issued_at: "1800000000000",
            scope: "api refresh_token offline_access",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await refreshMod.refreshSalesforceToken(SF_ARGS);

    expect(result.accessToken).toBe("new-access-token");
    expect(result.refreshToken).toBe("rolled-refresh-token");
    expect(result.expiresAt).toBe(1800000000000 + 2 * 60 * 60 * 1000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://login.salesforce.com/services/oauth2/token");
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=stored-refresh-token");

    expect(mockSaveCredentialBundle).toHaveBeenCalledWith(
      WSID,
      "catalog:salesforce",
      expect.objectContaining({
        accessToken: "new-access-token",
        refreshToken: "rolled-refresh-token",
      }),
    );

    // clearReconnectNeeded — UPDATE with status='ok'.
    const clearedCall = mockInternalQuery.mock.calls.find(
      (call) => (call[0] as string).includes("UPDATE workspace_plugins") && (call[0] as string).includes("'ok'"),
    );
    expect(clearedCall).toBeDefined();
  });

  it("preserves the stored refresh_token when Salesforce omits it from the response", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access-token",
            // no refresh_token here
            instance_url: "https://na139.my.salesforce.com",
            token_type: "Bearer",
            issued_at: "1800000000000",
            scope: "api refresh_token offline_access",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await refreshMod.refreshSalesforceToken(SF_ARGS);

    expect(result.refreshToken).toBe("stored-refresh-token");
  });
});

// ---------------------------------------------------------------------------
// Permanent failure
// ---------------------------------------------------------------------------

describe("refreshSalesforceToken — permanent failure", () => {
  it("throws SalesforceReconnectRequiredError on invalid_grant and marks reconnect_needed", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "expired access/refresh token" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(refreshMod.refreshSalesforceToken(SF_ARGS)).rejects.toMatchObject({
      _tag: "SalesforceReconnectRequiredError",
      workspaceId: WSID,
      upstreamError: "invalid_grant",
    });

    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
    // markReconnectNeeded — UPDATE with status='reconnect_needed'.
    const markedCall = mockInternalQuery.mock.calls.find(
      (call) =>
        (call[0] as string).includes("UPDATE workspace_plugins") &&
        (call[0] as string).includes("'reconnect_needed'"),
    );
    expect(markedCall).toBeDefined();
  });

  it("treats inactive_user / org_locked / inactive_org as permanent failures", async () => {
    for (const errorCode of ["inactive_user", "org_locked", "inactive_org"]) {
      mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
      mockInternalQuery.mockClear();
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: errorCode }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

      await expect(refreshMod.refreshSalesforceToken(SF_ARGS)).rejects.toMatchObject({
        _tag: "SalesforceReconnectRequiredError",
        upstreamError: errorCode,
      });
      const markedCall = mockInternalQuery.mock.calls.find(
        (call) =>
          (call[0] as string).includes("UPDATE workspace_plugins") &&
          (call[0] as string).includes("'reconnect_needed'"),
      );
      expect(markedCall).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Transient failure
// ---------------------------------------------------------------------------

describe("refreshSalesforceToken — transient failure", () => {
  it("throws plain Error on network failure without marking reconnect_needed", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() => Promise.reject(new Error("ECONNRESET")));

    await expect(refreshMod.refreshSalesforceToken(SF_ARGS)).rejects.toThrow("ECONNRESET");

    const markedCall = mockInternalQuery.mock.calls.find(
      (call) =>
        (call[0] as string).includes("UPDATE workspace_plugins") &&
        (call[0] as string).includes("'reconnect_needed'"),
    );
    expect(markedCall).toBeUndefined();
  });

  it("throws plain Error on 5xx without marking reconnect_needed", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response("internal error", { status: 503 })),
    );

    await expect(refreshMod.refreshSalesforceToken(SF_ARGS)).rejects.toThrow();

    const markedCall = mockInternalQuery.mock.calls.find(
      (call) =>
        (call[0] as string).includes("UPDATE workspace_plugins") &&
        (call[0] as string).includes("'reconnect_needed'"),
    );
    expect(markedCall).toBeUndefined();
  });

  it("treats invalid_client / invalid_client_id as TRANSIENT (operator env-var misconfig, not tenant install break)", async () => {
    // Codex P1 — `invalid_client` and `invalid_client_id` are
    // operator-side failures (wrong SALESFORCE_CLIENT_ID/SECRET in the
    // deploy). Flipping reconnect_needed for these would force every
    // workspace admin to manually re-run OAuth after the operator
    // fixes the env, even though their specific install is fine.
    // Pin this so a future refactor that re-broadens the permanent
    // codes list fails loudly.
    for (const errorCode of ["invalid_client", "invalid_client_id"]) {
      mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
      mockInternalQuery.mockClear();
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: errorCode }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

      await expect(refreshMod.refreshSalesforceToken(SF_ARGS)).rejects.toThrow(errorCode);

      const markedCall = mockInternalQuery.mock.calls.find(
        (call) =>
          (call[0] as string).includes("UPDATE workspace_plugins") &&
          (call[0] as string).includes("'reconnect_needed'"),
      );
      expect(markedCall).toBeUndefined();
    }
  });

  it("treats rate_limit_exceeded as TRANSIENT (recoverable throttle, not reconnect_needed)", async () => {
    // Salesforce's OAuth token endpoint per-org rate limit is a short-
    // window recoverable throttle, not a sign that the install is
    // broken. Flagging reconnect_needed here would force admins to
    // re-run OAuth uselessly while the next refresh would have
    // worked. Pin this so a regression that "tidies up" the
    // permanent-codes list and accidentally re-adds rate_limit_exceeded
    // fails loudly.
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(refreshMod.refreshSalesforceToken(SF_ARGS)).rejects.toThrow(
      "rate_limit_exceeded",
    );

    const markedCall = mockInternalQuery.mock.calls.find(
      (call) =>
        (call[0] as string).includes("UPDATE workspace_plugins") &&
        (call[0] as string).includes("'reconnect_needed'"),
    );
    expect(markedCall).toBeUndefined();
  });

  it("treats an unknown 4xx error code as transient (no reconnect_needed)", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(STORED_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "unexpected_unknown_code" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(refreshMod.refreshSalesforceToken(SF_ARGS)).rejects.toThrow(
      "unexpected_unknown_code",
    );

    const markedCall = mockInternalQuery.mock.calls.find(
      (call) =>
        (call[0] as string).includes("UPDATE workspace_plugins") &&
        (call[0] as string).includes("'reconnect_needed'"),
    );
    expect(markedCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bundle missing refresh_token
// ---------------------------------------------------------------------------

describe("refreshSalesforceToken — no refresh_token in bundle", () => {
  it("short-circuits to SalesforceReconnectRequiredError and marks reconnect_needed (no HTTP call)", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce({
      ...STORED_BUNDLE,
      refreshToken: null,
    });

    await expect(refreshMod.refreshSalesforceToken(SF_ARGS)).rejects.toMatchObject({
      _tag: "SalesforceReconnectRequiredError",
      upstreamError: "no_refresh_token",
    });

    expect(mockFetch).not.toHaveBeenCalled();
    const markedCall = mockInternalQuery.mock.calls.find(
      (call) =>
        (call[0] as string).includes("UPDATE workspace_plugins") &&
        (call[0] as string).includes("'reconnect_needed'"),
    );
    expect(markedCall).toBeDefined();
  });
});

describe("refreshSalesforceToken — credentials missing", () => {
  it("throws when no row exists for the workspace", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(null);

    await expect(refreshMod.refreshSalesforceToken(SF_ARGS)).rejects.toThrow(
      "No Salesforce credentials found",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
