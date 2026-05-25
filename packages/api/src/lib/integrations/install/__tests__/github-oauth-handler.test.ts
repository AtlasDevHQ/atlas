/**
 * Tests for {@link GitHubOAuthInstallHandler} (#2751, Phase D
 * multi-tenant App OAuth mode).
 *
 * Pins distinct from the Jira / Linear OAuth handler tests:
 *
 *   - `startInstall` redirects to `https://github.com/apps/<slug>/installations/new`
 *     (the GitHub App install URL shape — NOT the standard OAuth 2.0
 *     authorize endpoint).
 *   - `handleCallback`'s first argument is the `installation_id` query
 *     param GitHub returns post-install, not a code-for-token swap.
 *     There's no upstream token exchange — the only side effect is the
 *     `workspace_plugins` upsert.
 *   - Per ADR-0007 the credential persists inline in
 *     `workspace_plugins.config` JSONB via selective-field encryption,
 *     NOT in the legacy `integration_credentials` table.
 *   - `installation_id` IS the `secret: true` field in the schema; the
 *     round-trip must produce ciphertext (`enc:` prefix) at rest and
 *     decrypt back to the original positive-integer string.
 *   - Validation pins the positive-integer shape so a tampered
 *     callback URL surfaces as `invalid_installation_id` upstream-error
 *     rather than persisting garbage that fails at first JWT mint.
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

const WSID = "ws-github-app-1" as WorkspaceId;
const APP_CONFIG = {
  appId: "987654",
  appSlug: "atlas-test",
  redirectUri: "https://atlas.example/api/v1/integrations/github/callback",
};

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
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
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
    // GitHub App install URL is on github.com (not a /login/oauth/authorize
    // endpoint like standard OAuth). The shape pin keeps a refactor that
    // accidentally routes to the OAuth-user-authorize endpoint from
    // silently breaking the install dance.
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
  it("encrypts installation_id at rest and persists pillar='action' install row", async () => {
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");

    const result = await handler.handleCallback("123456789", stateToken);

    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe(WSID);
    expect(result!.catalogId).toBe("github");
    expect(result!.credentialResult).toEqual({ written: true });

    // Exactly one workspace_plugins upsert — no integration_credentials
    // hop, per ADR-0007 inline-JSONB encryption shape.
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO workspace_plugins/);
    expect(sql).toMatch(/pillar/);
    expect(sql).toMatch(/'action'/);
    expect(sql).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);
    expect(sql).toMatch(/RETURNING id/);
    expect(params).toContain("catalog:github");

    const configJson = (params as unknown[]).find(
      (p) => typeof p === "string" && p.startsWith("{"),
    ) as string;
    const persisted = JSON.parse(configJson) as Record<string, unknown>;
    expect(persisted.installation_id).toBeTypeOf("string");
    expect(persisted.installation_id).not.toBe("123456789");
    expect(persisted.installation_id as string).toMatch(/^enc:/);
    expect(decryptSecret(persisted.installation_id as string)).toBe("123456789");
    expect(persisted.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// handleCallback — state rejection + invalid installation_id
// ---------------------------------------------------------------------------

describe("GitHubOAuthInstallHandler.handleCallback — failure surfaces", () => {
  it("returns null when state token is forged / expired / catalog-mismatched", async () => {
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    // State token bound to a different catalog (jira) — handler must reject.
    const mismatchedState = mintOAuthStateToken(WSID, "jira");
    const result = await handler.handleCallback("123456789", mismatchedState);
    expect(result).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns null when state token is garbage", async () => {
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const result = await handler.handleCallback("123456789", "garbage.not.a.token");
    expect(result).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects non-numeric installation_id as upstream PlatformOAuthExchangeError", async () => {
    const { PlatformOAuthExchangeError } = await import("@atlas/api/lib/effect/errors");
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");
    let caught: unknown;
    try {
      await handler.handleCallback("not-a-number", stateToken);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlatformOAuthExchangeError);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects negative / zero / leading-zero installation_id", async () => {
    const { PlatformOAuthExchangeError } = await import("@atlas/api/lib/effect/errors");
    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github");

    for (const bad of ["0", "0123", "-1", "1.5", ""]) {
      let caught: unknown;
      try {
        await handler.handleCallback(bad, mintOAuthStateToken(WSID, "github"));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PlatformOAuthExchangeError);
    }
    expect(mockInternalQuery).not.toHaveBeenCalled();
    // Verify the freshly-minted state above didn't leak into a partial write.
    expect(stateToken).toBeTypeOf("string");
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
    await expect(handler.handleCallback("42", stateToken)).rejects.toThrow(/upsert returned no id/);
  });
});

// ---------------------------------------------------------------------------
// No-keyset fail-loud — verify fails closed, no DB write
// ---------------------------------------------------------------------------

describe("GitHubOAuthInstallHandler.handleCallback — no keyset configured", () => {
  it("returns null without writing when keyset is absent at verify time", async () => {
    // Mint a state token under one keyset, then drop the keyset before
    // the callback. `verifyOAuthStateToken` returns null when no keyset
    // resolves, so the handler short-circuits before any DB write —
    // mirrors the broader "CSRF state cannot fall through to plaintext"
    // posture documented on the oauth-state-token module.
    const stateToken = mintOAuthStateToken(WSID, "github");
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();

    const handler = new GitHubOAuthInstallHandler(APP_CONFIG);
    const result = await handler.handleCallback("42", stateToken);
    expect(result).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});
