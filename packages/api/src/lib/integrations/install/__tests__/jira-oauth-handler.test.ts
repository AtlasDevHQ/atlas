/**
 * Tests for {@link JiraOAuthInstallHandler} (#2659).
 *
 * Coverage mirrors `salesforce-oauth-handler.test.ts`; Jira-specific
 * additions:
 *
 *   - `startInstall` URL includes Atlassian's required
 *     `audience=api.atlassian.com` query param.
 *   - `handleCallback` fetches `accessible-resources` after the token
 *     exchange and persists the first cloud's `id` as `cloudid` in
 *     `workspace_plugins.config` (the one-Atlas-Workspace = one-
 *     Atlassian-Cloud semantic per the issue body).
 *   - Empty accessible-resources response throws
 *     `PlatformOAuthExchangeError` — the install would otherwise orphan
 *     a credential with no Cloud to call.
 *   - The credential bundle's `instanceUrl` is the per-cloud API host
 *     (`https://api.atlassian.com/ex/jira/<cloudid>`).
 *
 * Test seam: `fetch` is mocked module-global so both the
 * `auth.atlassian.com/oauth/token` POST AND the
 * `api.atlassian.com/oauth/token/accessible-resources` GET are
 * intercepted in sequence.
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

// ADR-0003/0005 ordering — install row FIRST, credential bundle SECOND.
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

const ORIGINAL_FETCH = globalThis.fetch;
// Loose typing — fetch from bun-types carries a `preconnect` method that
// a vanilla mock function doesn't, but the call shape is identical.
const mockFetch: Mock<(input: unknown, init?: unknown) => Promise<Response>> = mock(() =>
  Promise.resolve(new Response("{}", { status: 200 })),
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

const WSID = "ws-jira-test-1" as WorkspaceId;
const JIRA_CONFIG = {
  clientId: "test-jira-client-id",
  clientSecret: "test-jira-client-secret",
  redirectUri: "https://atlas.example/api/v1/integrations/jira/callback",
};

const CLOUDID = "11223344-aaaa-bbbb-cccc-ddddeeee0000";

/**
 * Default happy-path fetch sequence:
 *   1st call → POST oauth/token → token success
 *   2nd call → GET accessible-resources → one cloud
 */
function happyFetchSequence(): Mock<(input: unknown, init?: unknown) => Promise<Response>>["mock"]["calls"] {
  mockFetch.mockImplementation((input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    // accessible-resources first — its URL also contains `/oauth/token`,
    // so the broader `/oauth/token` check below would mis-match.
    if (url.includes("accessible-resources")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: CLOUDID,
              url: "https://acme.atlassian.net",
              name: "Acme",
              scopes: ["read:jira-work", "read:jira-user", "offline_access"],
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.includes("/oauth/token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "jira-access-token",
            refresh_token: "jira-refresh-token-initial",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "read:jira-work read:jira-user offline_access",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  return mockFetch.mock.calls;
}

type HandlerCtor = typeof import("../jira-oauth-handler").JiraOAuthInstallHandler;
let JiraOAuthInstallHandler!: HandlerCtor;

beforeAll(async () => {
  const mod = await import("../jira-oauth-handler");
  JiraOAuthInstallHandler = mod.JiraOAuthInstallHandler;
});

beforeEach(() => {
  setKeys("v1:test-key-one");
  callOrder.length = 0;
  mockInternalQuery.mockClear();
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = mockFetch as any;
  happyFetchSequence();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// startInstall
// ---------------------------------------------------------------------------

describe("JiraOAuthInstallHandler.startInstall", () => {
  it("returns an Atlassian authorize URL with the minted state token + required audience param", async () => {
    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);

    const { redirectUrl, stateToken } = await handler.startInstall(WSID);

    expect(stateToken).toBeTypeOf("string");
    expect(stateToken.length).toBeGreaterThan(0);

    const parsed = new URL(redirectUrl);
    expect(parsed.origin + parsed.pathname).toBe("https://auth.atlassian.com/authorize");
    // The `audience` param is REQUIRED by Atlassian 3LO; without it the
    // authorize endpoint redirects back with `invalid_request`. Pin it
    // so a refactor that drops the param surfaces immediately.
    expect(parsed.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe(JIRA_CONFIG.clientId);
    expect(parsed.searchParams.get("redirect_uri")).toBe(JIRA_CONFIG.redirectUri);
    expect(parsed.searchParams.get("state")).toBe(stateToken);
  });

  it("requests the offline_access scope so Atlassian issues a refresh_token", async () => {
    // Without offline_access, Atlassian doesn't return a refresh_token
    // and the install dies on the first access-token expiry. Pin the
    // scope set explicitly so a refactor that "tightens" scopes notices.
    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);
    const { redirectUrl } = await handler.startInstall(WSID);

    const scope = new URL(redirectUrl).searchParams.get("scope") ?? "";
    expect(scope).toContain("read:jira-work");
    expect(scope).toContain("read:jira-user");
    expect(scope).toContain("offline_access");
  });

  it("mints a state token that verifies back to (workspaceId, 'jira')", async () => {
    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);

    const { stateToken } = await handler.startInstall(WSID);

    expect(verifyOAuthStateToken(stateToken)).toEqual({
      workspaceId: WSID,
      catalogId: "jira",
    });
  });
});

// ---------------------------------------------------------------------------
// handleCallback — happy path
// ---------------------------------------------------------------------------

describe("JiraOAuthInstallHandler.handleCallback — happy path", () => {
  it("verifies state, exchanges the code, fetches cloudid, and writes both stores in order", async () => {
    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "jira");

    const result = await handler.handleCallback("auth-code-xyz", stateToken);

    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe(WSID);
    expect(result!.catalogId).toBe("jira");
    expect(result!.credentialResult).toEqual({ written: true });
    expect(result!.installRecord.catalogId).toBe("jira");

    // Two fetch calls — token exchange then accessible-resources.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://auth.atlassian.com/oauth/token");
    expect(tokenInit.method).toBe("POST");
    expect((tokenInit.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const tokenBody = JSON.parse(tokenInit.body as string);
    expect(tokenBody).toMatchObject({
      grant_type: "authorization_code",
      client_id: "test-jira-client-id",
      code: "auth-code-xyz",
    });

    const [resourcesUrl, resourcesInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(resourcesUrl).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
    expect((resourcesInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer jira-access-token",
    );

    // ADR-0003/0005 ordering invariant.
    expect(callOrder).toEqual(["workspace_plugins.insert", "integration_credentials.save"]);

    // workspace_plugins INSERT carries the cloudid in config (the
    // critical one-Atlas-Workspace = one-Atlassian-Cloud assertion).
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p) => typeof p === "string" && p.startsWith("{") && p.includes("cloudid"),
    );
    expect(configJson).toBeDefined();
    const config = JSON.parse(configJson as string);
    expect(config).toMatchObject({
      cloudid: CLOUDID,
      scopes: "read:jira-work read:jira-user offline_access",
      status: "ok",
      site_url: "https://acme.atlassian.net",
      site_name: "Acme",
    });

    // Credential bundle: instanceUrl is the per-cloud API host so the
    // lazy-builder can call Jira without re-reading the install config.
    expect(mockSaveCredentialBundle).toHaveBeenCalledTimes(1);
    expect(mockSaveCredentialBundle).toHaveBeenCalledWith(
      WSID,
      "catalog:jira",
      expect.objectContaining({
        accessToken: "jira-access-token",
        refreshToken: "jira-refresh-token-initial",
        instanceUrl: `https://api.atlassian.com/ex/jira/${CLOUDID}`,
        scope: "read:jira-work read:jira-user offline_access",
        tokenType: "Bearer",
      }),
    );
  });

  it("picks accessible-resources[0] when Atlassian returns multiple Clouds", async () => {
    // Per the #2659 one-Atlas-Workspace = one-Atlassian-Cloud rule:
    // when the OAuth grant covers multiple Clouds, we take the first.
    // A future "multi-cloud picker" would change this; today the
    // simplification is intentional.
    mockFetch.mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("accessible-resources")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { id: "FIRST-CLOUD", url: "https://first.atlassian.net", name: "First" },
              { id: "SECOND-CLOUD", url: "https://second.atlassian.net", name: "Second" },
            ]),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "jira-access-token",
            refresh_token: "jira-refresh",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "read:jira-work offline_access",
          }),
          { status: 200 },
        ),
      );
    });

    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "jira");
    await handler.handleCallback("code", stateToken);

    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p) => typeof p === "string" && p.includes("cloudid"),
    );
    const config = JSON.parse(configJson as string);
    expect(config.cloudid).toBe("FIRST-CLOUD");
  });
});

// ---------------------------------------------------------------------------
// handleCallback — state rejection
// ---------------------------------------------------------------------------

describe("JiraOAuthInstallHandler.handleCallback — state rejection", () => {
  it("returns null when the state token is tampered (no fetch, no writes)", async () => {
    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);
    const good = mintOAuthStateToken(WSID, "jira");
    const parts = good.split(".");
    const tampered = `${parts[0]}.${mutateLastChar(parts[1])}.${parts[2]}`;

    const result = await handler.handleCallback("auth-code", tampered);

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
  });

  it("returns null when the state token binds to a different catalog", async () => {
    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);
    const wrongBinding = mintOAuthStateToken(WSID, "salesforce");

    const result = await handler.handleCallback("auth-code", wrongBinding);

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCallback — Atlassian-side failure
// ---------------------------------------------------------------------------

describe("JiraOAuthInstallHandler.handleCallback — Atlassian-side failure", () => {
  it("throws PlatformOAuthExchangeError on non-2xx token exchange (no writes)", async () => {
    mockFetch.mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("accessible-resources")) {
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "expired code" }),
          { status: 400 },
        ),
      );
    });

    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "jira");

    await expect(handler.handleCallback("bad-code", stateToken)).rejects.toMatchObject({
      _tag: "PlatformOAuthExchangeError",
      platform: "jira",
      upstreamError: "invalid_grant",
    });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
  });

  it("throws PlatformOAuthExchangeError when accessible-resources is empty (no writes)", async () => {
    // Token exchange succeeded but the user has no Atlassian Clouds the
    // App can reach — installing this credential would orphan it.
    mockFetch.mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("accessible-resources")) {
        // Empty array — no clouds accessible.
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "token",
            refresh_token: "refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    });

    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "jira");

    await expect(handler.handleCallback("auth-code", stateToken)).rejects.toMatchObject({
      _tag: "PlatformOAuthExchangeError",
      platform: "jira",
      upstreamError: "no_accessible_resources",
    });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
  });

  it("throws PlatformOAuthExchangeError on network failure", async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.reject(new Error("ENOTFOUND auth.atlassian.com")),
    );
    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "jira");

    await expect(handler.handleCallback("auth-code", stateToken)).rejects.toMatchObject({
      _tag: "PlatformOAuthExchangeError",
      platform: "jira",
    });
  });
});

// ---------------------------------------------------------------------------
// handleCallback — partial failure (ADR-0003 Reconnect path)
// ---------------------------------------------------------------------------

describe("JiraOAuthInstallHandler.handleCallback — partial failure", () => {
  it("returns credentialResult.written=false AND flips status to reconnect_needed when integration_credentials write throws", async () => {
    mockSaveCredentialBundle.mockImplementationOnce(() =>
      Promise.reject(new Error("transient db error")),
    );
    const handler = new JiraOAuthInstallHandler(JIRA_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "jira");

    const result = await handler.handleCallback("auth-code", stateToken);

    expect(result).not.toBeNull();
    expect(result!.installRecord.workspaceId).toBe(WSID);
    expect(result!.installRecord.catalogId).toBe("jira");
    expect(result!.credentialResult.written).toBe(false);
    expect(result!.credentialResult.reason).toContain("Reconnect");

    // Flipping status: reconnect_needed is what makes the admin card
    // surface a persistent Reconnect CTA. Without this UPDATE the user
    // sees `?reconnect=jira` once then a normal "Installed" card on the
    // next page load.
    const reconnectUpdate = mockInternalQuery.mock.calls.find(
      (call) =>
        (call[0] as string).includes("UPDATE workspace_plugins") &&
        (call[0] as string).includes("'reconnect_needed'"),
    );
    expect(reconnectUpdate).toBeDefined();
    expect(mockSaveCredentialBundle).toHaveBeenCalledTimes(1);
  });
});
