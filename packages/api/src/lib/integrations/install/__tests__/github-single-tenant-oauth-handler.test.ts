/**
 * Tests for {@link GitHubSingleTenantOAuthInstallHandler} (#2751,
 * Phase D single-tenant App OAuth mode).
 *
 * Single-tenant-specific pins:
 *
 *   - `startInstall` self-redirects to its own callback URL (no GitHub
 *     round-trip) with `installation_id` + `state` + `setup_action`
 *     pre-attached. The operator already installed the App into their
 *     one org once at deploy time.
 *   - `handleCallback` ignores whatever installation_id arrives on the
 *     callback if it differs from the operator-baked env value — the
 *     env is the source of truth in single-tenant mode.
 *   - Persistence shape mirrors the multi-tenant handler: encrypted
 *     `installation_id` inline on `workspace_plugins.config`, same
 *     pillar='action' + post-0092 INSERT shape, but catalog row id is
 *     `catalog:github-single-tenant`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret } from "@atlas/api/lib/db/secret-encryption";
import { mintOAuthStateToken, verifyOAuthStateToken } from "../oauth-state-token";
import type { WorkspaceId } from "@useatlas/types";

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

const WSID = "ws-github-st-1" as WorkspaceId;
const BAKED_INSTALLATION_ID = "555000999";
const HANDLER_CONFIG = {
  appId: "987654",
  appSlug: "atlas-self-host",
  installationId: BAKED_INSTALLATION_ID,
  redirectUri: "https://atlas.example/api/v1/integrations/github-single-tenant/callback",
};

type HandlerCtor =
  typeof import("../github-single-tenant-oauth-handler").GitHubSingleTenantOAuthInstallHandler;
let GitHubSingleTenantOAuthInstallHandler!: HandlerCtor;

beforeAll(async () => {
  const mod = await import("../github-single-tenant-oauth-handler");
  GitHubSingleTenantOAuthInstallHandler = mod.GitHubSingleTenantOAuthInstallHandler;
});

const ORIGINAL_ENV = { ...process.env };

function setKeys(value: string): void {
  process.env.ATLAS_ENCRYPTION_KEYS = value;
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
}

beforeEach(() => {
  setKeys("v1:test-key-for-github-single-tenant-oauth-handler-must-be-long-enough");
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
// startInstall — self-redirect to the callback URL
// ---------------------------------------------------------------------------

describe("GitHubSingleTenantOAuthInstallHandler.startInstall", () => {
  it("self-redirects to its own callback URL with the env-baked installation_id", async () => {
    const handler = new GitHubSingleTenantOAuthInstallHandler(HANDLER_CONFIG);
    const { redirectUrl, stateToken } = await handler.startInstall(WSID);

    const parsed = new URL(redirectUrl);
    // Same host + path as the configured callback — there is NO GitHub
    // hop in single-tenant mode. A refactor that routes through
    // `github.com/apps/...` would break the contract.
    expect(parsed.origin + parsed.pathname).toBe(
      "https://atlas.example/api/v1/integrations/github-single-tenant/callback",
    );
    expect(parsed.searchParams.get("installation_id")).toBe(BAKED_INSTALLATION_ID);
    expect(parsed.searchParams.get("state")).toBe(stateToken);
    expect(parsed.searchParams.get("setup_action")).toBe("install");

    expect(verifyOAuthStateToken(stateToken)).toEqual({
      workspaceId: WSID,
      catalogId: "github-single-tenant",
    });
  });
});

// ---------------------------------------------------------------------------
// handleCallback — happy path
// ---------------------------------------------------------------------------

describe("GitHubSingleTenantOAuthInstallHandler.handleCallback", () => {
  it("persists the env-baked installation_id encrypted on workspace_plugins.config", async () => {
    const handler = new GitHubSingleTenantOAuthInstallHandler(HANDLER_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github-single-tenant");

    const result = await handler.handleCallback(BAKED_INSTALLATION_ID, stateToken);

    expect(result).not.toBeNull();
    expect(result!.catalogId).toBe("github-single-tenant");
    expect(result!.credentialResult).toEqual({ written: true });

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toMatch(/'action'/);
    expect(params).toContain("catalog:github-single-tenant");
    const configJson = (params as unknown[]).find(
      (p) => typeof p === "string" && p.startsWith("{"),
    ) as string;
    const persisted = JSON.parse(configJson) as Record<string, unknown>;
    expect(persisted.installation_id as string).toMatch(/^enc:/);
    expect(decryptSecret(persisted.installation_id as string)).toBe(BAKED_INSTALLATION_ID);
  });

  it("falls back to the env-baked installation_id when the callback supplies a different value", async () => {
    // The env is the source of truth in single-tenant mode. A tampered
    // redirect URL carrying a different installation_id must NOT
    // mis-route subsequent installation-token mint calls.
    const handler = new GitHubSingleTenantOAuthInstallHandler(HANDLER_CONFIG);
    const stateToken = mintOAuthStateToken(WSID, "github-single-tenant");

    const result = await handler.handleCallback("999111", stateToken);
    expect(result).not.toBeNull();

    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p) => typeof p === "string" && p.startsWith("{"),
    ) as string;
    const persisted = JSON.parse(configJson) as Record<string, unknown>;
    // What persisted is the env-baked id, NOT the supplied 999111.
    expect(decryptSecret(persisted.installation_id as string)).toBe(BAKED_INSTALLATION_ID);
  });

  it("returns null on state-token / catalog mismatch", async () => {
    const handler = new GitHubSingleTenantOAuthInstallHandler(HANDLER_CONFIG);
    const mismatched = mintOAuthStateToken(WSID, "github"); // wrong catalog
    const result = await handler.handleCallback(BAKED_INSTALLATION_ID, mismatched);
    expect(result).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects malformed env-baked installation_id with PlatformOAuthExchangeError", async () => {
    const { PlatformOAuthExchangeError } = await import("@atlas/api/lib/effect/errors");
    const handler = new GitHubSingleTenantOAuthInstallHandler({
      ...HANDLER_CONFIG,
      installationId: "not-numeric",
    });
    const stateToken = mintOAuthStateToken(WSID, "github-single-tenant");
    let caught: unknown;
    try {
      await handler.handleCallback("not-numeric", stateToken);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlatformOAuthExchangeError);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});
