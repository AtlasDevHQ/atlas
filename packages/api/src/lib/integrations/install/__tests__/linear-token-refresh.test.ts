/**
 * Tests for the Linear refresh-token rotation flow (#2750).
 *
 * Coverage mirrors `jira-token-refresh.test.ts`; the Linear-specific
 * pins are:
 *
 *   - Token endpoint is form-encoded (matches Salesforce, not Atlassian).
 *   - Refresh tokens rotate on every refresh — the new value MUST land
 *     in `integration_credentials`. If a refactor drops the rotated
 *     value, the install dies on the second refresh.
 *   - `invalid_grant` / `unauthorized_client` / `access_denied` flip
 *     `reconnect_needed`; `invalid_client` (operator env misconfig)
 *     stays transient.
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

type RefreshModule = typeof import("../linear-token-refresh");
let refreshMod!: RefreshModule;

beforeAll(async () => {
  refreshMod = await import("../linear-token-refresh");
});

const ORIGINAL_ENV = { ...process.env };
const WSID = "ws-linear-refresh-test-1";

const STORED_BUNDLE = {
  accessToken: "old-access-token",
  refreshToken: "stored-refresh-token",
  expiresAt: 1_700_000_000_000,
  tokenType: "Bearer",
  scope: "read write issues:create",
  instanceUrl: "https://api.linear.app/graphql",
};

const LINEAR_ARGS = {
  workspaceId: WSID,
  clientId: "linear-client-id",
  clientSecret: "linear-client-secret",
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
// Happy path — token rotation
// ---------------------------------------------------------------------------

describe("refreshLinearToken — happy path", () => {
  it("rotates the refresh_token and writes the new bundle back", async () => {
    mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_BUNDLE));
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access-token",
            // CRITICAL: the new refresh token MUST land in storage. Linear
            // rotates refresh tokens on every refresh — keeping the old
            // one would brick the install on the second refresh.
            refresh_token: "rotated-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "read write issues:create",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await refreshMod.refreshLinearToken(LINEAR_ARGS);

    expect(result.accessToken).toBe("new-access-token");
    expect(result.refreshToken).toBe("rotated-refresh-token");
    expect(result.instanceUrl).toBe("https://api.linear.app/graphql");
    expect(mockSaveCredentialBundle).toHaveBeenCalledWith(
      WSID,
      "catalog:linear",
      expect.objectContaining({
        accessToken: "new-access-token",
        refreshToken: "rotated-refresh-token",
      }),
    );

    // Token endpoint is form-encoded.
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("stored-refresh-token");
  });

  it("clears reconnect_needed on success", async () => {
    mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_BUNDLE));
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "rotated-refresh-token",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    );

    await refreshMod.refreshLinearToken(LINEAR_ARGS);

    const clearCall = mockInternalQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("'ok'"),
    );
    expect(clearCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Permanent failures — reconnect_needed
// ---------------------------------------------------------------------------

describe("refreshLinearToken — permanent failures", () => {
  it("flips reconnect_needed and throws LinearReconnectRequiredError on invalid_grant", async () => {
    mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_BUNDLE));
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      ),
    );

    await expect(refreshMod.refreshLinearToken(LINEAR_ARGS)).rejects.toBeInstanceOf(
      refreshMod.LinearReconnectRequiredError,
    );

    const flipCall = mockInternalQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("reconnect_needed"),
    );
    expect(flipCall).toBeDefined();
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
  });

  it.each(["unauthorized_client", "access_denied"])(
    "flips reconnect_needed for permanent code %s",
    async (code) => {
      mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_BUNDLE));
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: code }), { status: 400 }),
        ),
      );
      await expect(refreshMod.refreshLinearToken(LINEAR_ARGS)).rejects.toBeInstanceOf(
        refreshMod.LinearReconnectRequiredError,
      );
    },
  );

  it("flips reconnect_needed when the stored bundle has no refresh_token", async () => {
    mockReadCredentialBundle.mockImplementation(() =>
      Promise.resolve({ ...STORED_BUNDLE, refreshToken: null }),
    );

    await expect(refreshMod.refreshLinearToken(LINEAR_ARGS)).rejects.toBeInstanceOf(
      refreshMod.LinearReconnectRequiredError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Transient failures — do NOT flip reconnect_needed
// ---------------------------------------------------------------------------

describe("refreshLinearToken — transient failures", () => {
  it("does NOT flip reconnect_needed on invalid_client (operator env typo)", async () => {
    mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_BUNDLE));
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
      ),
    );

    let caught: unknown;
    try {
      await refreshMod.refreshLinearToken(LINEAR_ARGS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // Critically NOT a reconnect error — operator-side env typo should
    // not force every tenant admin to re-OAuth.
    expect(caught).not.toBeInstanceOf(refreshMod.LinearReconnectRequiredError);

    const flipCall = mockInternalQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("reconnect_needed"),
    );
    expect(flipCall).toBeUndefined();
  });

  it("does NOT flip reconnect_needed on 5xx", async () => {
    mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_BUNDLE));
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response("oops", { status: 500 })),
    );

    await expect(refreshMod.refreshLinearToken(LINEAR_ARGS)).rejects.toThrow();
    const flipCall = mockInternalQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("reconnect_needed"),
    );
    expect(flipCall).toBeUndefined();
  });

  it("does NOT flip reconnect_needed on network failure", async () => {
    mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_BUNDLE));
    mockFetch.mockImplementation(() => Promise.reject(new Error("ECONNRESET")));

    await expect(refreshMod.refreshLinearToken(LINEAR_ARGS)).rejects.toThrow();
    const flipCall = mockInternalQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("reconnect_needed"),
    );
    expect(flipCall).toBeUndefined();
  });
});
