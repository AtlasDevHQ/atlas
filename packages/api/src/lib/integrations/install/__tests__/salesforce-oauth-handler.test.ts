/**
 * Tests for {@link SalesforceOAuthInstallHandler} (#2658).
 *
 * Coverage parallels the Slack OAuth handler tests:
 *   - `startInstall` builds the Salesforce authorize URL with the
 *     minted state token + the operator-supplied client id + scopes.
 *   - `handleCallback` happy path exchanges the auth code, writes the
 *     install row in `workspace_plugins`, and writes the credential
 *     bundle in `integration_credentials` (in order).
 *   - State-token failure modes (tampered / expired / empty / wrong
 *     catalog binding) return null without touching either store.
 *   - Upstream Salesforce failure (`error` field, missing
 *     `instance_url`, missing `access_token`) throws
 *     `PlatformOAuthExchangeError` and writes neither store.
 *   - Partial failure (workspace_plugins write succeeds, credential
 *     store write throws) returns `credentialResult.written: false`
 *     with the install record intact.
 *   - The install config carries `instance_url`, `org_id`,
 *     `org_user_id`, and `scopes` for admin-UI visibility without
 *     decrypting the credential bundle.
 *
 * Test seam: `fetch` is mocked module-global so the Salesforce
 * `oauth2/token` POST is intercepted. `internalQuery` and
 * `saveCredentialBundle` are mocked to validate the writes.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { mutateLastChar } from "../../../../__test-utils__/base64url";
import {
  mintOAuthStateToken,
  verifyOAuthStateToken,
} from "../oauth-state-token";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks (must precede the SUT import)
// ---------------------------------------------------------------------------

// Two-store ADR-0003/0005 ordering invariant — every install must write
// the install row FIRST and the credential bundle SECOND. A `callOrder`
// spool catches a refactor that swaps the order even when both writes
// still succeed.
const callOrder: string[] = [];

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string): Promise<unknown[]> => {
    if (sql.includes("INSERT INTO workspace_plugins")) {
      callOrder.push("workspace_plugins.insert");
    }
    return [];
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

const mockSaveCredentialBundle: Mock<
  (workspaceId: string, catalogId: string, bundle: unknown) => Promise<void>
> = mock(async () => {
  callOrder.push("integration_credentials.save");
});

mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
  saveCredentialBundle: mockSaveCredentialBundle,
  readCredentialBundle: mock(() => Promise.resolve(null)),
  deleteCredentialBundle: mock(() => Promise.resolve(false)),
}));

// Capture original fetch to restore after each test.
const ORIGINAL_FETCH = globalThis.fetch;
// Loosely typed — `fetch` from bun-types carries a `preconnect` method that
// a vanilla mock function doesn't, but the runtime call shape is identical.
const mockFetch: Mock<(input: unknown, init?: unknown) => Promise<Response>> = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        access_token: "00D1x000000abcXYZ!ARQAQM0_access_token",
        refresh_token: "5Aep861YEp_refresh_token_value",
        instance_url: "https://na139.my.salesforce.com",
        id: "https://login.salesforce.com/id/00D1x000000abc/0051x00000abcUser",
        token_type: "Bearer",
        issued_at: "1700000000000",
        scope: "api refresh_token offline_access",
        signature: "ignored",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  ),
);

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

function setKeys(value: string): void {
  process.env.ATLAS_ENCRYPTION_KEYS = value;
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
}

const WSID = "ws-salesforce-test-1" as WorkspaceId;
const SF_CONFIG = {
  clientId: "test-sf-client-id",
  clientSecret: "test-sf-client-secret",
  redirectUri: "https://atlas.example/api/v1/integrations/salesforce/callback",
};

type HandlerCtor = typeof import("../salesforce-oauth-handler").SalesforceOAuthInstallHandler;
let SalesforceOAuthInstallHandler!: HandlerCtor;

beforeAll(async () => {
  const mod = await import("../salesforce-oauth-handler");
  SalesforceOAuthInstallHandler = mod.SalesforceOAuthInstallHandler;
});

beforeEach(() => {
  setKeys("v1:test-key-one");
  callOrder.length = 0;
  mockInternalQuery.mockClear();
  // Restore the default implementation that records call ordering;
  // mockClear() preserves the implementation, but explicit per-test
  // overrides may have replaced it.
  mockInternalQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
    if (sql.includes("INSERT INTO workspace_plugins")) {
      callOrder.push("workspace_plugins.insert");
    }
    return [];
  });
  mockSaveCredentialBundle.mockClear();
  mockSaveCredentialBundle.mockImplementation(async () => {
    callOrder.push("integration_credentials.save");
  });
  mockFetch.mockClear();
  // Loose cast — see comment near mockFetch declaration.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = mockFetch as any;
  // Default to the happy-path token response.
  mockFetch.mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: "00D1x000000abcXYZ!ARQAQM0_access_token",
          refresh_token: "5Aep861YEp_refresh_token_value",
          instance_url: "https://na139.my.salesforce.com",
          id: "https://login.salesforce.com/id/00D1x000000abc/0051x00000abcUser",
          token_type: "Bearer",
          issued_at: "1700000000000",
          scope: "api refresh_token offline_access",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// startInstall
// ---------------------------------------------------------------------------

describe("SalesforceOAuthInstallHandler.startInstall", () => {
  it("returns a Salesforce authorize URL with the minted state token", async () => {
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);

    const { redirectUrl, stateToken } = await handler.startInstall(WSID);

    expect(stateToken).toBeTypeOf("string");
    expect(stateToken.length).toBeGreaterThan(0);

    const parsed = new URL(redirectUrl);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://login.salesforce.com/services/oauth2/authorize",
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe(SF_CONFIG.clientId);
    expect(parsed.searchParams.get("redirect_uri")).toBe(SF_CONFIG.redirectUri);
    expect(parsed.searchParams.get("scope")).toBe("api refresh_token offline_access");
    expect(parsed.searchParams.get("state")).toBe(stateToken);
  });

  it("honors a sandbox loginUrl override", async () => {
    const handler = new SalesforceOAuthInstallHandler({
      ...SF_CONFIG,
      loginUrl: "https://test.salesforce.com",
    });

    const { redirectUrl } = await handler.startInstall(WSID);

    expect(redirectUrl.startsWith("https://test.salesforce.com/services/oauth2/authorize")).toBe(true);
  });

  it("mints a state token that verifies back to (workspaceId, 'salesforce')", async () => {
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);

    const { stateToken } = await handler.startInstall(WSID);

    expect(verifyOAuthStateToken(stateToken)).toEqual({
      workspaceId: WSID,
      catalogId: "salesforce",
    });
  });
});

// ---------------------------------------------------------------------------
// handleCallback — happy path
// ---------------------------------------------------------------------------

describe("SalesforceOAuthInstallHandler.handleCallback — happy path", () => {
  it("verifies state, exchanges the code, and writes both stores in order", async () => {
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "salesforce");

    const result = await handler.handleCallback("auth-code-xyz", stateToken);

    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe(WSID);
    expect(result!.catalogId).toBe("salesforce");
    expect(result!.credentialResult).toEqual({ written: true });
    expect(result!.installRecord.catalogId).toBe("salesforce");

    // Token endpoint POST.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [tokenUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://login.salesforce.com/services/oauth2/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(init.body).toContain("grant_type=authorization_code");
    expect(init.body).toContain("code=auth-code-xyz");
    expect(init.body).toContain("client_id=test-sf-client-id");

    // workspace_plugins INSERT — happens BEFORE the credential store write.
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO workspace_plugins");
    expect((params as unknown[])[1]).toBe(WSID);
    expect((params as unknown[])[2]).toBe("catalog:salesforce");

    // ADR-0003/0005 ordering invariant — install row FIRST, credential
    // bundle SECOND. A refactor that flips the order would still pass
    // the toHaveBeenCalled assertions above but fail this. Critical:
    // a credential-first write means a step-1 failure could orphan a
    // credential row, defeating the dual-store recovery semantics.
    expect(callOrder).toEqual(["workspace_plugins.insert", "integration_credentials.save"]);

    // integration_credentials write via saveCredentialBundle.
    expect(mockSaveCredentialBundle).toHaveBeenCalledTimes(1);
    expect(mockSaveCredentialBundle).toHaveBeenCalledWith(
      WSID,
      "catalog:salesforce",
      expect.objectContaining({
        accessToken: "00D1x000000abcXYZ!ARQAQM0_access_token",
        refreshToken: "5Aep861YEp_refresh_token_value",
        instanceUrl: "https://na139.my.salesforce.com",
        scope: "api refresh_token offline_access",
        tokenType: "Bearer",
      }),
    );
  });

  it("carries instance_url, org_id, org_user_id, scopes, and status into workspace_plugins.config", async () => {
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "salesforce");

    await handler.handleCallback("auth-code-xyz", stateToken);

    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p) => typeof p === "string" && p.startsWith("{") && p.includes("instance_url"),
    );
    expect(configJson).toBeDefined();
    const config = JSON.parse(configJson as string);
    expect(config).toMatchObject({
      instance_url: "https://na139.my.salesforce.com",
      org_id: "00D1x000000abc",
      org_user_id: "0051x00000abcUser",
      scopes: "api refresh_token offline_access",
      status: "ok",
    });
  });
});

// ---------------------------------------------------------------------------
// handleCallback — state rejection
// ---------------------------------------------------------------------------

describe("SalesforceOAuthInstallHandler.handleCallback — state rejection", () => {
  it("returns null when the state token is tampered (no fetch, no writes)", async () => {
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);
    const good = mintOAuthStateToken(WSID, "salesforce");
    const parts = good.split(".");
    const tampered = `${parts[0]}.${mutateLastChar(parts[1])}.${parts[2]}`;

    const result = await handler.handleCallback("auth-code", tampered);

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
  });

  it("returns null when the state token has expired", async () => {
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);
    const expired = mintOAuthStateToken(WSID, "salesforce", {
      ttlSeconds: 1,
      nowSeconds: Math.floor(Date.now() / 1000) - 3600,
    });

    const result = await handler.handleCallback("auth-code", expired);

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when the state token binds to a different catalog", async () => {
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);
    const wrongBinding = mintOAuthStateToken(WSID, "slack");

    const result = await handler.handleCallback("auth-code", wrongBinding);

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when the state token is empty", async () => {
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);

    const result = await handler.handleCallback("auth-code", "");

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCallback — upstream Salesforce failure
// ---------------------------------------------------------------------------

describe("SalesforceOAuthInstallHandler.handleCallback — Salesforce-side failure", () => {
  it("throws PlatformOAuthExchangeError on non-2xx with error field (no writes)", async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "expired authorization code" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "salesforce");

    await expect(handler.handleCallback("bad-code", stateToken)).rejects.toMatchObject({
      _tag: "PlatformOAuthExchangeError",
      platform: "salesforce",
      upstreamError: "invalid_grant",
    });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
  });

  it("throws PlatformOAuthExchangeError when the response is structurally incomplete (missing instance_url)", async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "token", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "salesforce");

    await expect(handler.handleCallback("auth-code", stateToken)).rejects.toMatchObject({
      _tag: "PlatformOAuthExchangeError",
      platform: "salesforce",
    });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
  });

  it("throws PlatformOAuthExchangeError on network failure", async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.reject(new Error("ENOTFOUND login.salesforce.com")),
    );
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "salesforce");

    await expect(handler.handleCallback("auth-code", stateToken)).rejects.toMatchObject({
      _tag: "PlatformOAuthExchangeError",
      platform: "salesforce",
    });
  });
});

// ---------------------------------------------------------------------------
// handleCallback — partial failure (ADR-0003 Reconnect path)
// ---------------------------------------------------------------------------

describe("SalesforceOAuthInstallHandler.handleCallback — partial failure", () => {
  it("returns credentialResult.written=false AND flips status to reconnect_needed when integration_credentials write throws", async () => {
    mockSaveCredentialBundle.mockImplementationOnce(() =>
      Promise.reject(new Error("transient db error")),
    );
    const handler = new SalesforceOAuthInstallHandler(SF_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "salesforce");

    const result = await handler.handleCallback("auth-code", stateToken);

    expect(result).not.toBeNull();
    expect(result!.installRecord.workspaceId).toBe(WSID);
    expect(result!.installRecord.catalogId).toBe("salesforce");
    expect(result!.credentialResult.written).toBe(false);
    expect(result!.credentialResult.reason).toContain("Reconnect");

    // Codex P1 — flipping `status: "reconnect_needed"` is what makes
    // the admin card surface a persistent Reconnect CTA. Without this
    // UPDATE the user lands on `?reconnect=salesforce` once then sees
    // a normal "Installed" card on the next page load.
    const reconnectUpdate = mockInternalQuery.mock.calls.find(
      (call) =>
        (call[0] as string).includes("UPDATE workspace_plugins") &&
        (call[0] as string).includes("'reconnect_needed'"),
    );
    expect(reconnectUpdate).toBeDefined();
    expect(mockSaveCredentialBundle).toHaveBeenCalledTimes(1);
  });
});
