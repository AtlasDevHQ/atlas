/**
 * Tests for {@link GitHubOAuthInstallHandler} (#2751, Phase D
 * multi-tenant App OAuth mode).
 *
 * Pins distinct from the Jira / Linear OAuth handler tests:
 *
 *   - `startInstall` redirects to `https://github.com/apps/<slug>/installations/new`
 *     (the GitHub App install URL shape — NOT the standard OAuth 2.0
 *     authorize endpoint).
 *   - `handleCallback` takes the user OAuth `code` as its positional
 *     first arg and the GitHub App `installation_id` via `extras` — both
 *     are required. The handler exchanges the code for a user access
 *     token and verifies the installation_id is in the user's
 *     `/user/installations` list before persisting (cross-tenant
 *     binding defense — see handler JSDoc for the threat model).
 *   - Per ADR-0007 the credential persists inline in
 *     `workspace_plugins.config` JSONB via selective-field encryption,
 *     NOT in the legacy `integration_credentials` table.
 *   - `installation_id` IS the `secret: true` field in the schema; the
 *     round-trip must produce ciphertext (`enc:` prefix) at rest.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret } from "@atlas/api/lib/db/secret-encryption";
import { mintOAuthStateToken, verifyOAuthStateToken } from "../oauth-state-token";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks (must precede the SUT import)
// ---------------------------------------------------------------------------

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    if (sql.includes("RETURNING id")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    return [];
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

const ORIGINAL_FETCH = globalThis.fetch;
const mockFetch: Mock<(input: unknown, init?: unknown) => Promise<Response>> = mock(() =>
  Promise.resolve(new Response("{}", { status: 200 })),
);

const WSID = "ws-github-app-1" as WorkspaceId;
const APP_CONFIG = {
  appId: "987654",
  appSlug: "atlas-test",
  clientId: "Iv1.test_client_id",
  clientSecret: "github-test-client-secret",
  redirectUri: "https://atlas.example/api/v1/integrations/github/callback",
};

const INSTALLATION_ID = "123456789";
const USER_ACCESS_TOKEN = "ghu_user_access_token";

type HandlerCtor = typeof import("../github-oauth-handler").GitHubOAuthInstallHandler;
let GitHubOAuthInstallHandler!: HandlerCtor;

beforeAll(async () => {
  const mod = await import("../github-oauth-handler");
  GitHubOAuthInstallHandler = mod.GitHubOAuthInstallHandler;
});

const ORIGINAL_ENV = { ...process.env };

function setKeys(value: string): void {
  process.env.ATLAS_ENCRYPTION_KEYS = value;
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
}

/**
 * Default happy-path fetch sequence:
 *   1st call → POST /login/oauth/access_token → user access token
 *   2nd call → GET /user/installations → list containing INSTALLATION_ID
 */
function happyFetchSequence(installations: ReadonlyArray<{ id: number; account?: { login?: string; type?: string } }>): void {
  mockFetch.mockImplementation((input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/login/oauth/access_token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: USER_ACCESS_TOKEN,
            token_type: "bearer",
            scope: "",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.includes("/user/installations")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ total_count: installations.length, installations }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

beforeEach(() => {
  setKeys("v1:test-key-for-github-app-oauth-handler-unit-tests-must-be-long-enough");
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("RETURNING id")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    return [];
  });
  mockFetch.mockClear();
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = mockFetch as any;
  happyFetchSequence([
    { id: 123456789, account: { login: "acme-corp", type: "Organization" } },
  ]);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// startInstall
// ---------------------------------------------------------------------------

describe("GitHubOAuthInstallHandler.startInstall", () => {
  it("returns a GitHub App install URL with state bound to (workspace, 'github')", async () => {
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const { redirectUrl, stateToken } = await handler.startInstall(WSID);

    expect(stateToken).toBeTypeOf("string");
    expect(stateToken.length).toBeGreaterThan(0);

    const parsed = new URL(redirectUrl);
    expect(parsed.origin + parsed.pathname).toBe(
      `https://github.com/apps/${APP_CONFIG.appSlug}/installations/new`,
    );
    expect(parsed.searchParams.get("state")).toBe(stateToken);

    expect(verifyOAuthStateToken(stateToken)).toEqual({
      workspaceId: WSID,
      catalogId: "github",
    });
  });
});

// ---------------------------------------------------------------------------
// handleCallback — happy path
// ---------------------------------------------------------------------------

describe("GitHubOAuthInstallHandler.handleCallback — happy path", () => {
  it("verifies ownership, encrypts installation_id, and persists pillar='action' install row", async () => {
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");

    const result = await handler.handleCallback("user-oauth-code-abc", stateToken, {
      installationId: INSTALLATION_ID,
    });

    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe(WSID);
    expect(result!.catalogId).toBe("github");
    expect(result!.credentialResult).toEqual({ written: true });

    // Two fetch calls — token exchange then user/installations.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(tokenInit.method).toBe("POST");
    const tokenBody = String(tokenInit.body);
    expect(tokenBody).toContain("client_id=Iv1.test_client_id");
    expect(tokenBody).toContain("code=user-oauth-code-abc");
    expect(tokenBody).toContain("client_secret=github-test-client-secret");

    const [instUrl, instInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(instUrl).toMatch(/https:\/\/api\.github\.com\/user\/installations/);
    expect((instInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${USER_ACCESS_TOKEN}`);

    // workspace_plugins INSERT shape pins.
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO workspace_plugins/);
    expect(sql).toMatch(/'action'/);
    expect(sql).toMatch(/RETURNING id/);
    expect(params).toContain("catalog:github");

    const configJson = (params as unknown[]).find(
      (p) => typeof p === "string" && p.startsWith("{"),
    ) as string;
    const persisted = JSON.parse(configJson) as Record<string, unknown>;
    expect(persisted.installation_id as string).toMatch(/^enc:/);
    expect(decryptSecret(persisted.installation_id as string)).toBe(INSTALLATION_ID);
    expect(persisted.status).toBe("ok");
    // Account info enriched from /user/installations and persisted in
    // plaintext for admin-UI display.
    expect(persisted.account_login).toBe("acme-corp");
    expect(persisted.account_type).toBe("Organization");
  });
});

// ---------------------------------------------------------------------------
// Ownership verification — the cross-tenant binding defense
// ---------------------------------------------------------------------------

describe("GitHubOAuthInstallHandler.handleCallback — ownership verification", () => {
  it("rejects callbacks where installation_id is NOT in the user's accessible installations", async () => {
    // The cross-tenant binding attack: attacker has a valid state
    // token for their own workspace, tampers the redirect URL to
    // substitute a victim org's installation_id. The user OAuth token
    // resolved from `code` belongs to the attacker — so when we list
    // their installations, the victim's installation_id is absent.
    // Handler must REJECT, not persist.
    const { PlatformOAuthExchangeError } = await import("@atlas/api/lib/effect/errors");
    happyFetchSequence([
      // Attacker's own installations — does NOT include 123456789.
      { id: 222, account: { login: "attacker-org", type: "Organization" } },
    ]);

    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");

    let caught: unknown;
    try {
      await handler.handleCallback("user-oauth-code-abc", stateToken, {
        installationId: INSTALLATION_ID, // <-- tampered to victim's id
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlatformOAuthExchangeError);
    expect((caught as { upstreamError: string }).upstreamError).toBe("installation_not_owned");
    // NO persistence — the security gate stops the install before any DB write.
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("paginates /user/installations and accepts the install when target is on a later page", async () => {
    mockFetch.mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/login/oauth/access_token")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: USER_ACCESS_TOKEN, token_type: "bearer" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.includes("/user/installations") && !url.includes("page=2")) {
        // Page 1: no match, Link points to page 2.
        return Promise.resolve(
          new Response(
            JSON.stringify({
              total_count: 2,
              installations: [{ id: 999, account: { login: "other", type: "Organization" } }],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                link: `<https://api.github.com/user/installations?page=2>; rel="next"`,
              },
            },
          ),
        );
      }
      // Page 2: contains the target.
      return Promise.resolve(
        new Response(
          JSON.stringify({
            total_count: 2,
            installations: [{ id: 123456789, account: { login: "acme-corp", type: "Organization" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });

    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");
    const result = await handler.handleCallback("user-oauth-code-abc", stateToken, {
      installationId: INSTALLATION_ID,
    });

    expect(result).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3); // token + page 1 + page 2
  });

  it("throws PlatformOAuthExchangeError when GitHub rejects the OAuth code", async () => {
    const { PlatformOAuthExchangeError } = await import("@atlas/api/lib/effect/errors");
    mockFetch.mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/login/oauth/access_token")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: "bad_verification_code", error_description: "expired" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");
    await expect(
      handler.handleCallback("bad-code", stateToken, { installationId: INSTALLATION_ID }),
    ).rejects.toBeInstanceOf(PlatformOAuthExchangeError);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// State / shape failures (no upstream calls)
// ---------------------------------------------------------------------------

describe("GitHubOAuthInstallHandler.handleCallback — state + shape rejection", () => {
  it("returns null when state token is forged / catalog-mismatched (no upstream calls)", async () => {
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const mismatchedState = mintOAuthStateToken(WSID, "jira");
    const result = await handler.handleCallback("user-oauth-code", mismatchedState, {
      installationId: INSTALLATION_ID,
    });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns null when state token is garbage", async () => {
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const result = await handler.handleCallback("user-oauth-code", "garbage.not.a.token", {
      installationId: INSTALLATION_ID,
    });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects missing installation_id with missing_installation_id PlatformOAuthExchangeError", async () => {
    const { PlatformOAuthExchangeError } = await import("@atlas/api/lib/effect/errors");
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");
    let caught: unknown;
    try {
      await handler.handleCallback("user-oauth-code", stateToken, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlatformOAuthExchangeError);
    expect((caught as { upstreamError: string }).upstreamError).toBe("missing_installation_id");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects missing code (operator hasn't enabled user-OAuth-during-install)", async () => {
    const { PlatformOAuthExchangeError } = await import("@atlas/api/lib/effect/errors");
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");
    let caught: unknown;
    try {
      await handler.handleCallback("", stateToken, { installationId: INSTALLATION_ID });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlatformOAuthExchangeError);
    expect((caught as { upstreamError: string }).upstreamError).toBe("missing_code");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects non-numeric installation_id before any upstream call", async () => {
    const { PlatformOAuthExchangeError } = await import("@atlas/api/lib/effect/errors");
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");
    let caught: unknown;
    try {
      await handler.handleCallback("user-oauth-code", stateToken, {
        installationId: "not-a-number",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlatformOAuthExchangeError);
    expect((caught as { upstreamError: string }).upstreamError).toBe("invalid_installation_id");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects negative / zero / leading-zero installation_id", async () => {
    const { PlatformOAuthExchangeError } = await import("@atlas/api/lib/effect/errors");
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);

    for (const bad of ["0", "0123", "-1", "1.5"]) {
      const stateToken = mintOAuthStateToken(WSID, "github");
      let caught: unknown;
      try {
        await handler.handleCallback("user-oauth-code", stateToken, { installationId: bad });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PlatformOAuthExchangeError);
    }
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RETURNING-id invariant
// ---------------------------------------------------------------------------

describe("GitHubOAuthInstallHandler.handleCallback — RETURNING invariant", () => {
  it("throws when the upsert returns no row", async () => {
    mockInternalQuery.mockImplementation(async () => []);
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");
    await expect(
      handler.handleCallback("user-oauth-code", stateToken, { installationId: INSTALLATION_ID }),
    ).rejects.toThrow(/upsert returned no id/);
  });
});
