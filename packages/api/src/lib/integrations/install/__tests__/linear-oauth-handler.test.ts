/**
 * Tests for {@link LinearOAuthInstallHandler} (#2750).
 *
 * Coverage mirrors `jira-oauth-handler.test.ts`; Linear-specific
 * additions:
 *
 *   - Token endpoint is `application/x-www-form-urlencoded` (Salesforce-
 *     shaped, not JSON-shaped like Atlassian).
 *   - `actor=user` param on the authorize URL — pinned so a refactor
 *     that drops the attribution semantic surfaces immediately.
 *   - Viewer GraphQL second-hop populates `organization_id` /
 *     `organization_name` / `organization_url_key` in `workspace_plugins.config`.
 *   - GraphQL `errors[]` array on the viewer call surfaces as
 *     `PlatformOAuthExchangeError` (not silently passed through).
 *   - INSERT uses the post-0092 explicit `pillar` + `install_id` shape
 *     with the partial unique index conflict target.
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
const mockFetch: Mock<(input: unknown, init?: unknown) => Promise<Response>> = mock(() =>
  Promise.resolve(new Response("{}", { status: 200 })),
);

const ORIGINAL_ENV = { ...process.env };

function setKeys(value: string): void {
  process.env.ATLAS_ENCRYPTION_KEYS = value;
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
}

const WSID = "ws-linear-test-1" as WorkspaceId;
const LINEAR_CONFIG = {
  clientId: "test-linear-client-id",
  clientSecret: "test-linear-client-secret",
  redirectUri: "https://atlas.example/api/v1/integrations/linear/callback",
};

const ORGANIZATION_ID = "11223344-aaaa-bbbb-cccc-ddddeeee0000";

function happyFetchSequence(): void {
  mockFetch.mockImplementation((input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/graphql")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              viewer: {
                id: "user-id-abc",
                name: "Alice",
                email: "alice@example.com",
                organization: {
                  id: ORGANIZATION_ID,
                  urlKey: "acme",
                  name: "Acme",
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.includes("/oauth/token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "linear-access-token",
            refresh_token: "linear-refresh-token-initial",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "read write issues:create",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

type HandlerCtor = typeof import("../linear-oauth-handler").LinearOAuthInstallHandler;
let LinearOAuthInstallHandler!: HandlerCtor;
let PlatformOAuthExchangeError!: typeof import("@atlas/api/lib/effect/errors").PlatformOAuthExchangeError;

beforeAll(async () => {
  const mod = await import("../linear-oauth-handler");
  LinearOAuthInstallHandler = mod.LinearOAuthInstallHandler;
  const errs = await import("@atlas/api/lib/effect/errors");
  PlatformOAuthExchangeError = errs.PlatformOAuthExchangeError;
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

describe("LinearOAuthInstallHandler.startInstall", () => {
  it("returns a Linear authorize URL with the minted state token + actor=user", async () => {
    const handler = new LinearOAuthInstallHandler(LINEAR_CONFIG);

    const { redirectUrl, stateToken } = await handler.startInstall(WSID);

    expect(stateToken).toBeTypeOf("string");
    expect(stateToken.length).toBeGreaterThan(0);

    const parsed = new URL(redirectUrl);
    expect(parsed.origin + parsed.pathname).toBe("https://linear.app/oauth/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe(LINEAR_CONFIG.clientId);
    expect(parsed.searchParams.get("redirect_uri")).toBe(LINEAR_CONFIG.redirectUri);
    expect(parsed.searchParams.get("state")).toBe(stateToken);
    // `actor=user` ensures issues attribute to the granting user, not
    // a separate "Atlas Bot" identity. Pin so a refactor that drops the
    // attribution semantic surfaces immediately.
    expect(parsed.searchParams.get("actor")).toBe("user");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
  });

  it("requests the read + write + issues:create scopes as a comma-separated list", async () => {
    // Linear's authorize endpoint is Linear-specific: scopes are
    // **comma-separated**, not space-separated like Slack/Atlassian. A
    // space-delimited value here returns `invalid_scope` and blocks
    // every install. Pin the exact format so a refactor can't regress it.
    const handler = new LinearOAuthInstallHandler(LINEAR_CONFIG);
    const { redirectUrl } = await handler.startInstall(WSID);

    const scope = new URL(redirectUrl).searchParams.get("scope") ?? "";
    expect(scope).toBe("read,write,issues:create");
  });

  it("mints a state token that verifies back to (workspaceId, 'linear')", async () => {
    const handler = new LinearOAuthInstallHandler(LINEAR_CONFIG);
    const { stateToken } = await handler.startInstall(WSID);
    expect(verifyOAuthStateToken(stateToken)).toEqual({
      workspaceId: WSID,
      catalogId: "linear",
    });
  });
});

// ---------------------------------------------------------------------------
// handleCallback — happy path
// ---------------------------------------------------------------------------

describe("LinearOAuthInstallHandler.handleCallback — happy path", () => {
  it("verifies state, exchanges the code form-encoded, fetches viewer, and writes both stores in order", async () => {
    const handler = new LinearOAuthInstallHandler(LINEAR_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "linear");

    const result = await handler.handleCallback("auth-code-xyz", stateToken);

    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe(WSID);
    expect(result!.catalogId).toBe("linear");
    expect(result!.credentialResult).toEqual({ written: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://api.linear.app/oauth/token");
    expect(tokenInit.method).toBe("POST");
    // Linear's token endpoint is form-encoded (matching Salesforce, not
    // Atlassian's JSON-shaped one). Pin both the content type and the
    // body shape.
    expect((tokenInit.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const formBody = new URLSearchParams(tokenInit.body as string);
    expect(formBody.get("grant_type")).toBe("authorization_code");
    expect(formBody.get("client_id")).toBe("test-linear-client-id");
    expect(formBody.get("code")).toBe("auth-code-xyz");

    const [graphqlUrl, graphqlInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(graphqlUrl).toBe("https://api.linear.app/graphql");
    expect((graphqlInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer linear-access-token",
    );

    // ADR-0003/0005 ordering invariant.
    expect(callOrder).toEqual(["workspace_plugins.insert", "integration_credentials.save"]);

    // The INSERT uses the post-0092 explicit `pillar` + `install_id`
    // shape with the partial unique index conflict target. Pin both so
    // a refactor that drops back to the pre-0092 trigger-derived shape
    // surfaces immediately.
    const [sql] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/install_id/);
    expect(sql).toMatch(/pillar/);
    expect(sql).toMatch(/'action'/);
    expect(sql).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);

    // workspace_plugins INSERT carries the organization fields in config.
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p) => typeof p === "string" && p.startsWith("{") && p.includes("organization_id"),
    );
    expect(configJson).toBeDefined();
    const config = JSON.parse(configJson as string);
    expect(config).toMatchObject({
      organization_id: ORGANIZATION_ID,
      organization_name: "Acme",
      organization_url_key: "acme",
      user_id: "user-id-abc",
      user_email: "alice@example.com",
      scopes: "read write issues:create",
      status: "ok",
    });

    expect(mockSaveCredentialBundle).toHaveBeenCalledTimes(1);
    expect(mockSaveCredentialBundle).toHaveBeenCalledWith(
      WSID,
      "catalog:linear",
      expect.objectContaining({
        accessToken: "linear-access-token",
        refreshToken: "linear-refresh-token-initial",
        instanceUrl: "https://api.linear.app/graphql",
        scope: "read write issues:create",
        tokenType: "Bearer",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleCallback — state token failures
// ---------------------------------------------------------------------------

describe("LinearOAuthInstallHandler.handleCallback — state failures", () => {
  it("returns null when the state token is tampered with", async () => {
    const handler = new LinearOAuthInstallHandler(LINEAR_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "linear");
    const tampered = mutateLastChar(stateToken);

    const result = await handler.handleCallback("auth-code", tampered);
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when the state token was minted for a different catalog", async () => {
    // A state token bound to (workspace, 'jira') should never authorize
    // a Linear callback — cross-catalog reuse would break the dispatch
    // invariant.
    const handler = new LinearOAuthInstallHandler(LINEAR_CONFIG);
    const wrongCatalogState = mintOAuthStateToken(WSID, "jira");

    const result = await handler.handleCallback("auth-code", wrongCatalogState);
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCallback — upstream failures
// ---------------------------------------------------------------------------

describe("LinearOAuthInstallHandler.handleCallback — upstream failures", () => {
  it("throws PlatformOAuthExchangeError when Linear rejects the code", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      ),
    );

    const handler = new LinearOAuthInstallHandler(LINEAR_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "linear");

    await expect(handler.handleCallback("bad-code", stateToken)).rejects.toThrow(
      PlatformOAuthExchangeError,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
  });

  it("throws PlatformOAuthExchangeError when the viewer GraphQL returns errors[]", async () => {
    // A GraphQL response with `errors[]` populated should NEVER pass
    // silently — the install would persist a credential bundle but the
    // workspace's `viewer` view of the install is broken.
    mockFetch.mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/graphql")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: null,
              errors: [{ message: "Field 'viewer' is restricted" }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "linear-access-token",
            refresh_token: "linear-refresh-token",
            expires_in: 3600,
          }),
          { status: 200 },
          ),
      );
    });

    const handler = new LinearOAuthInstallHandler(LINEAR_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "linear");

    await expect(handler.handleCallback("auth-code", stateToken)).rejects.toThrow(
      PlatformOAuthExchangeError,
    );
    // No install row written — we throw before the workspace_plugins INSERT.
    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockSaveCredentialBundle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCallback — partial failure (install row written, credential failed)
// ---------------------------------------------------------------------------

describe("LinearOAuthInstallHandler.handleCallback — partial failure", () => {
  it("flips status to reconnect_needed when credential persist fails after install row write", async () => {
    // Force the integration_credentials write to fail; the install row
    // should still land, status flips to reconnect_needed, and the
    // returned credentialResult.written is false.
    mockSaveCredentialBundle.mockImplementation(async () => {
      throw new Error("credentials_encrypted column write rejected");
    });

    const handler = new LinearOAuthInstallHandler(LINEAR_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "linear");

    const result = await handler.handleCallback("auth-code", stateToken);

    expect(result).not.toBeNull();
    expect(result!.credentialResult.written).toBe(false);
    expect(result!.credentialResult.reason).toMatch(/Reconnect/);

    // Two writes: the install row insert, then the status UPDATE.
    const insertCall = mockInternalQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO workspace_plugins"),
    );
    expect(insertCall).toBeDefined();
    const statusUpdateCall = mockInternalQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("UPDATE workspace_plugins") &&
        (c[0] as string).includes("reconnect_needed"),
    );
    expect(statusUpdateCall).toBeDefined();
  });
});
