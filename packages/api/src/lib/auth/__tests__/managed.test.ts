import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Module mock for the internal-DB adapter must be installed BEFORE
// `validateManaged` is imported so its transitive `hasInternalDB` /
// `internalQuery` references resolve to these stubs. Tests flip the
// closures (mockHasInternalDB / mockInternalQuery) to cover the
// resolvePasskeyCount branches that aren't reachable via env-only setup.
let mockHasInternalDB = false;
let mockInternalQuery: (sql: string, params: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: (sql: string, params: unknown[]) => mockInternalQuery(sql, params),
}));

import { validateManaged } from "../managed";
import { setSetting, _resetSettingsCache } from "@atlas/api/lib/settings";
import { _setAuthInstance } from "../server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock return type is intentionally untyped to simulate Better Auth session responses
const mockGetSession = mock((): Promise<any> => Promise.resolve(null));

describe("validateManaged()", () => {
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    mockGetSession.mockReset();
    // Inject a fake auth instance whose api.getSession is our mock
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- injecting partial auth mock for testing
    _setAuthInstance({ api: { getSession: mockGetSession } } as any);
    // Internal-DB mock defaults: no DB available, no rows. Individual tests
    // override these closures to exercise the positive / failure paths.
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    _setAuthInstance(null);
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  function makeRequest(headers?: Record<string, string>): Request {
    return new Request("http://localhost/api/v1/chat", {
      method: "POST",
      headers: headers ?? {},
    });
  }

  it("returns authenticated with user when session exists", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "usr_123", email: "alice@example.com", name: "Alice" },
      session: { id: "sess_abc", userId: "usr_123" },
    });

    const result = await validateManaged(makeRequest());

    expect(result).toMatchObject({
      authenticated: true,
      mode: "managed",
      user: {
        id: "usr_123",
        mode: "managed",
        label: "alice@example.com",
      },
    });
    // Verify claims are populated from session user
    if (result.authenticated && result.user) {
      expect(result.user.claims).toBeDefined();
      expect(result.user.claims!.sub).toBe("usr_123");
      expect(result.user.claims!.email).toBe("alice@example.com");
    }
  });

  it("returns 401 when no session", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const result = await validateManaged(makeRequest());

    expect(result).toEqual({
      authenticated: false,
      mode: "managed",
      status: 401,
      error: "Not signed in",
    });
  });

  // #3159 — the Better Auth admin plugin (which enforced ban at session create)
  // was removed. `validateManaged` now enforces ban per-request off the
  // `banned`/`banExpires` fields the `additionalFields` config keeps on the
  // getSession user. Without this, ban would go inert after the plugin removal.
  describe("ban enforcement (#3159)", () => {
    it("rejects a permanently banned user (banExpires null)", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_banned", email: "b@example.com", banned: true, banExpires: null },
        session: { id: "s1", userId: "usr_banned" },
      });

      const result = await validateManaged(makeRequest());

      expect(result).toEqual({
        authenticated: false,
        mode: "managed",
        status: 401,
        error: "Account is banned",
      });
    });

    it("rejects a banned user whose ban has not yet expired", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: {
          id: "usr_temp_ban",
          email: "t@example.com",
          banned: true,
          banExpires: new Date(Date.now() + 60_000).toISOString(),
        },
        session: { id: "s2", userId: "usr_temp_ban" },
      });

      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      expect((result as { status: number }).status).toBe(401);
    });

    it("allows a user whose ban has already expired", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: {
          id: "usr_expired_ban",
          email: "e@example.com",
          banned: true,
          banExpires: new Date(Date.now() - 60_000).toISOString(),
        },
        session: { id: "s3", userId: "usr_expired_ban" },
      });

      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(true);
    });

    it("allows a non-banned user (banned: false)", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_ok", email: "ok@example.com", banned: false, banExpires: null },
        session: { id: "s4", userId: "usr_ok" },
      });

      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(true);
    });
  });

  // #4046 / ADR-0027 §6 — workspace-scoped API-key enrichment. When the request
  // carries an `x-api-key` header, the apiKey() plugin resolves the OWNING member
  // (getSession.user), and validateManaged enriches from the key's metadata:
  // bound org, org-role-only role capped at the mint ceiling, the member's RLS
  // claim, and a distinct api_key marker (origin stays cli).
  describe("workspace API key (#4046)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock return is intentionally untyped to simulate Better Auth verifyApiKey
    const mockVerifyApiKey = mock((): Promise<any> => Promise.resolve(null));

    function installAuth(): void {
      const instance = {
        api: { getSession: mockGetSession, verifyApiKey: mockVerifyApiKey },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial auth mock for testing
      } as any;
      _setAuthInstance(instance);
    }

    function apiKeyRequest(): Request {
      return new Request("http://localhost/api/v1/execute-sql", {
        method: "POST",
        headers: { "x-api-key": "atlas_wk_secretkeyvalue" },
      });
    }

    beforeEach(() => {
      mockVerifyApiKey.mockReset();
      installAuth();
    });

    it("resolves to the owning member + bound org + org-role-only role from metadata", async () => {
      // The apiKey plugin resolves getSession to the real owning user.
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_owner", email: "owner@acme.com" },
        session: { id: "key_abc", userId: "usr_owner" },
      });
      mockVerifyApiKey.mockResolvedValueOnce({
        valid: true,
        key: {
          userId: "usr_owner",
          metadata: { atlasWorkspaceKey: true, orgId: "org_acme", role: "owner" },
        },
      });
      // Live member role lookup (resolveEffectiveRole) returns "admin".
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([{ role: "admin" }]);

      const result = await validateManaged(apiKeyRequest());

      expect(result.authenticated).toBe(true);
      if (!result.authenticated || !result.user) throw new Error("expected authed");
      // AC3 liveness: verifyApiKey is consulted on EVERY request, so a key
      // revoked since the last request is caught (revocation effective next req).
      expect(mockVerifyApiKey).toHaveBeenCalledTimes(1);
      expect(result.user.id).toBe("usr_owner");
      expect(result.user.label).toBe("owner@acme.com");
      expect(result.user.activeOrganizationId).toBe("org_acme");
      // Live role "admin" capped at mint ceiling "owner" -> "admin".
      expect(result.user.role).toBe("admin");
      expect(result.user.claims?.org_id).toBe("org_acme");
      expect(result.user.claims?.sub).toBe("usr_owner");
      // Transport stays cli; the api-key marker is the distinct signal.
      expect(result.user.claims?.origin).toBe("cli");
      expect(result.user.claims?.api_key).toBe(true);
    });

    it("caps the live role at the mint-time ceiling (member key can't widen to admin)", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_2", email: "u2@acme.com" },
        session: { id: "key_2", userId: "usr_2" },
      });
      mockVerifyApiKey.mockResolvedValueOnce({
        valid: true,
        key: { userId: "usr_2", metadata: { atlasWorkspaceKey: true, orgId: "org_acme", role: "member" } },
      });
      // Member was promoted to owner AFTER minting; the key must stay member.
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([{ role: "owner" }]);

      const result = await validateManaged(apiKeyRequest());
      if (!result.authenticated || !result.user) throw new Error("expected authed");
      expect(result.user.role).toBe("member");
    });

    it("fails closed to NO role when the owner is no longer a member of the org (live lookup authoritative)", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_removed", email: "removed@acme.com" },
        session: { id: "key_rm", userId: "usr_removed" },
      });
      mockVerifyApiKey.mockResolvedValueOnce({
        valid: true,
        // The key was minted when the owner was an admin; they've since been
        // removed from the workspace. The stored role must NOT be a floor.
        key: { userId: "usr_removed", metadata: { atlasWorkspaceKey: true, orgId: "org_acme", role: "admin" } },
      });
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([]); // no member row

      const result = await validateManaged(apiKeyRequest());
      expect(result.authenticated).toBe(true);
      if (!result.authenticated || !result.user) throw new Error("expected authed");
      // No elevated role — the removed member's stored "admin" is not re-granted.
      expect(result.user.role).toBeUndefined();
    });

    it("uses the stored metadata role on self-host (no internal DB, no live member table)", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_sh", email: "sh@acme.com" },
        session: { id: "key_sh", userId: "usr_sh" },
      });
      mockVerifyApiKey.mockResolvedValueOnce({
        valid: true,
        key: {
          userId: "usr_sh",
          metadata: { atlasWorkspaceKey: true, orgId: "org_acme", role: "admin" },
        },
      });
      // No internal DB — there is no member table to re-resolve against, so the
      // mint-time stored role is authoritative (the only signal available).
      mockHasInternalDB = false;

      const result = await validateManaged(apiKeyRequest());
      if (!result.authenticated || !result.user) throw new Error("expected authed");
      expect(result.user.role).toBe("admin");
    });

    it("merges the member's RLS claim from metadata into the claims bag", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_3", email: "u3@acme.com" },
        session: { id: "key_3", userId: "usr_3" },
      });
      mockVerifyApiKey.mockResolvedValueOnce({
        valid: true,
        key: {
          userId: "usr_3",
          metadata: {
            atlasWorkspaceKey: true,
            orgId: "org_acme",
            role: "member",
            claims: { tenant_id: "acme-tenant" },
          },
        },
      });
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([{ role: "member" }]);

      const result = await validateManaged(apiKeyRequest());
      if (!result.authenticated || !result.user) throw new Error("expected authed");
      expect(result.user.claims?.tenant_id).toBe("acme-tenant");
    });

    it("does not let a metadata claim shadow the authoritative org_id / origin", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_4", email: "u4@acme.com" },
        session: { id: "key_4", userId: "usr_4" },
      });
      mockVerifyApiKey.mockResolvedValueOnce({
        valid: true,
        key: {
          userId: "usr_4",
          metadata: {
            atlasWorkspaceKey: true,
            orgId: "org_real",
            role: "member",
            // A hostile/buggy mint trying to spoof identity claims.
            claims: { org_id: "org_spoof", origin: "chat", api_key: false, sub: "someone-else" },
          },
        },
      });
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([{ role: "member" }]);

      const result = await validateManaged(apiKeyRequest());
      if (!result.authenticated || !result.user) throw new Error("expected authed");
      expect(result.user.activeOrganizationId).toBe("org_real");
      expect(result.user.claims?.org_id).toBe("org_real");
      expect(result.user.claims?.origin).toBe("cli");
      expect(result.user.claims?.api_key).toBe(true);
      expect(result.user.claims?.sub).toBe("usr_4");
    });

    it("fails closed (401) when the key metadata has no workspace binding", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_5", email: "u5@acme.com" },
        session: { id: "key_5", userId: "usr_5" },
      });
      mockVerifyApiKey.mockResolvedValueOnce({
        valid: true,
        key: { metadata: null },
      });

      const result = await validateManaged(apiKeyRequest());
      expect(result).toMatchObject({ authenticated: false, status: 401 });
    });

    it("fails closed (401) when verifyApiKey reports the key invalid/revoked", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_6", email: "u6@acme.com" },
        session: { id: "key_6", userId: "usr_6" },
      });
      mockVerifyApiKey.mockResolvedValueOnce({ valid: false, key: null });

      const result = await validateManaged(apiKeyRequest());
      expect(result).toMatchObject({ authenticated: false, status: 401 });
    });

    it("fails closed (401) when verifyApiKey throws", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_7", email: "u7@acme.com" },
        session: { id: "key_7", userId: "usr_7" },
      });
      mockVerifyApiKey.mockRejectedValueOnce(new Error("db down"));

      const result = await validateManaged(apiKeyRequest());
      expect(result).toMatchObject({ authenticated: false, status: 401 });
    });

    it("fails closed (401) when verifyApiKey returns null entirely (allow-list, not deny-one)", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_n", email: "un@acme.com" },
        session: { id: "key_n", userId: "usr_n" },
      });
      mockVerifyApiKey.mockResolvedValueOnce(null);

      const result = await validateManaged(apiKeyRequest());
      expect(result).toMatchObject({ authenticated: false, status: 401 });
    });

    it("fails closed (401) when verifyApiKey omits `valid` (must be explicitly true)", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_nv", email: "unv@acme.com" },
        session: { id: "key_nv", userId: "usr_nv" },
      });
      // A soft-failure shape with metadata present but no `valid: true` must NOT
      // be admitted — the allow-list rejects it before the metadata gate.
      mockVerifyApiKey.mockResolvedValueOnce({
        key: { metadata: { atlasWorkspaceKey: true, orgId: "org_acme", role: "member" } },
      });

      const result = await validateManaged(apiKeyRequest());
      expect(result).toMatchObject({ authenticated: false, status: 401 });
    });

    it("fails closed (401) when the verified key owner != the session user (cookie+key mix)", async () => {
      // getSession resolved user A (e.g. a cookie won), but the x-api-key belongs
      // to user B. Binding A's identity to B's key scope would break owner
      // traceability — assert the cross-check fails closed.
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_A", email: "a@acme.com" },
        session: { id: "key_b", userId: "usr_A" },
      });
      mockVerifyApiKey.mockResolvedValueOnce({
        valid: true,
        key: {
          userId: "usr_B",
          metadata: { atlasWorkspaceKey: true, orgId: "org_acme", role: "admin" },
        },
      });
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([{ role: "admin" }]);

      const result = await validateManaged(apiKeyRequest());
      expect(result).toMatchObject({ authenticated: false, status: 401 });
    });

    it("fails closed (401) when the key is valid but resolves no owner (#4110 AC4)", async () => {
      // verifyApiKey reports valid:true but the key carries neither userId nor
      // referenceId — we can't bind the actor to a person, so we must NOT fall
      // through trusting the session userId. Fail closed instead.
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_noowner", email: "no@acme.com" },
        session: { id: "key_noowner", userId: "usr_noowner" },
      });
      mockVerifyApiKey.mockResolvedValueOnce({
        valid: true,
        key: { metadata: { atlasWorkspaceKey: true, orgId: "org_acme", role: "admin" } },
      });
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([{ role: "admin" }]);

      const result = await validateManaged(apiKeyRequest());
      expect(result).toMatchObject({ authenticated: false, status: 401 });
    });

    it("still enforces ban on the owning member before enrichment", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_banned_key", email: "bk@acme.com", banned: true, banExpires: null },
        session: { id: "key_8", userId: "usr_banned_key" },
      });

      const result = await validateManaged(apiKeyRequest());
      expect(result).toMatchObject({ authenticated: false, status: 401, error: "Account is banned" });
      // verifyApiKey must not even be consulted for a banned owner.
      expect(mockVerifyApiKey).not.toHaveBeenCalled();
    });
  });

  it("passes request headers to getSession", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = makeRequest({ Authorization: "Bearer some-token" });
    await validateManaged(req);

    expect(mockGetSession).toHaveBeenCalledTimes(1);
    const calls = mockGetSession.mock.calls as unknown as Array<[{ headers: Headers }]>;
    expect(calls[0][0].headers.get("authorization")).toBe("Bearer some-token");
  });

  it("returns 500 when session exists but user.id is missing", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { email: "ghost@example.com" },
      session: { id: "sess_456" },
    });

    const result = await validateManaged(makeRequest());

    expect(result).toEqual({
      authenticated: false,
      mode: "managed",
      status: 500,
      error: "Session data is incomplete",
    });
  });

  it("returns 500 when session exists but user.id is empty string", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "", email: "empty@example.com" },
      session: { id: "sess_789" },
    });

    const result = await validateManaged(makeRequest());

    expect(result).toEqual({
      authenticated: false,
      mode: "managed",
      status: 500,
      error: "Session data is incomplete",
    });
  });

  it("propagates errors from auth instance", async () => {
    mockGetSession.mockRejectedValueOnce(new Error("DB connection failed"));

    await expect(validateManaged(makeRequest())).rejects.toThrow(
      "DB connection failed",
    );
  });

  describe("role extraction from session", () => {
    it("session with user.role: 'admin' propagates to user", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: "admin" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBe("admin");
      }
    });

    it("session with user.role: 'invalid' falls back — no role on user", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: "invalid" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });

    it("session without role field — no role on user", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });

    it("session with non-string role (number) is ignored", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: 42 },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });
  });

  describe("session timeout enforcement", () => {
    afterEach(() => {
      delete process.env.ATLAS_SESSION_IDLE_TIMEOUT;
      delete process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT;
    });

    function validSession(overrides?: { updatedAt?: string; createdAt?: string }) {
      const now = new Date().toISOString();
      return {
        user: { id: "usr_123", email: "alice@example.com" },
        session: {
          id: "sess_abc",
          userId: "usr_123",
          updatedAt: overrides?.updatedAt ?? now,
          createdAt: overrides?.createdAt ?? now,
        },
      };
    }

    it("authenticates when timeouts are disabled (default)", async () => {
      mockGetSession.mockResolvedValueOnce(validSession());
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(true);
    });

    it("authenticates when session is within idle timeout", async () => {
      process.env.ATLAS_SESSION_IDLE_TIMEOUT = "3600";
      mockGetSession.mockResolvedValueOnce(validSession({
        updatedAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(true);
    });

    it("rejects session that exceeds idle timeout", async () => {
      process.env.ATLAS_SESSION_IDLE_TIMEOUT = "60"; // 60 seconds
      mockGetSession.mockResolvedValueOnce(validSession({
        updatedAt: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.status).toBe(401);
        expect(result.error).toBe("Session expired (idle timeout)");
      }
    });

    it("authenticates when session is within absolute timeout", async () => {
      process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT = "86400";
      mockGetSession.mockResolvedValueOnce(validSession({
        createdAt: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(true);
    });

    it("rejects session that exceeds absolute timeout", async () => {
      process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT = "3600"; // 1 hour
      mockGetSession.mockResolvedValueOnce(validSession({
        createdAt: new Date(Date.now() - 7200_000).toISOString(), // 2 hours ago
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.status).toBe(401);
        expect(result.error).toBe("Session expired");
      }
    });

    it("rejects session with invalid updatedAt date (fail-closed)", async () => {
      process.env.ATLAS_SESSION_IDLE_TIMEOUT = "3600";
      mockGetSession.mockResolvedValueOnce(validSession({
        updatedAt: "not-a-date",
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.status).toBe(401);
        expect(result.error).toBe("Session data is invalid");
      }
    });

    it("rejects session with invalid createdAt date (fail-closed)", async () => {
      process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT = "86400";
      mockGetSession.mockResolvedValueOnce(validSession({
        createdAt: "garbage",
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.status).toBe(401);
        expect(result.error).toBe("Session data is invalid");
      }
    });

    it("idle timeout checked before absolute timeout", async () => {
      process.env.ATLAS_SESSION_IDLE_TIMEOUT = "60";
      process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT = "86400";
      // Session is idle-expired but not absolute-expired
      mockGetSession.mockResolvedValueOnce(validSession({
        updatedAt: new Date(Date.now() - 120_000).toISOString(), // 2 min idle
        createdAt: new Date(Date.now() - 600_000).toISOString(), // 10 min old
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.error).toBe("Session expired (idle timeout)");
      }
    });
  });

  // -------------------------------------------------------------------------
  // #3406 — workspace-tier resolution of the session-timeout keys
  //
  // ATLAS_SESSION_IDLE/ABSOLUTE_TIMEOUT are workspace-scoped: an org-scoped
  // override row must govern sessions whose activeOrganizationId is that
  // org, and must not leak to sessions in other workspaces. setSetting
  // works through this file's db/internal mock (hasInternalDB flipped on)
  // and writes the real in-process settings cache that getSetting reads.
  // -------------------------------------------------------------------------

  describe("session timeout workspace overrides (#3406)", () => {
    beforeEach(() => {
      mockHasInternalDB = true;
      _resetSettingsCache();
    });

    afterEach(() => {
      mockHasInternalDB = false;
      _resetSettingsCache();
      delete process.env.ATLAS_SESSION_IDLE_TIMEOUT;
    });

    function orgSession(orgId: string, updatedAt: string) {
      const now = new Date().toISOString();
      return {
        user: { id: "usr_123", email: "alice@example.com" },
        session: {
          id: "sess_abc",
          userId: "usr_123",
          activeOrganizationId: orgId,
          updatedAt,
          createdAt: now,
        },
      };
    }

    it("rejects a session idle past its workspace's override", async () => {
      await setSetting("ATLAS_SESSION_IDLE_TIMEOUT", "60", "test", "org-a");
      mockGetSession.mockResolvedValueOnce(
        orgSession("org-a", new Date(Date.now() - 120_000).toISOString()),
      );
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.error).toBe("Session expired (idle timeout)");
      }
    });

    it("another workspace's override does not govern this session", async () => {
      await setSetting("ATLAS_SESSION_IDLE_TIMEOUT", "60", "test", "org-other");
      mockGetSession.mockResolvedValueOnce(
        orgSession("org-a", new Date(Date.now() - 120_000).toISOString()),
      );
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(true);
    });

    it("rejects a session past its workspace's absolute timeout override", async () => {
      await setSetting("ATLAS_SESSION_ABSOLUTE_TIMEOUT", "60", "test", "org-a");
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: {
          id: "sess_abc",
          userId: "usr_123",
          activeOrganizationId: "org-a",
          updatedAt: new Date().toISOString(),
          createdAt: new Date(Date.now() - 120_000).toISOString(),
        },
      });
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.error).toBe("Session expired");
      }
    });

    it("workspace override wins over a looser env value", async () => {
      process.env.ATLAS_SESSION_IDLE_TIMEOUT = "3600";
      await setSetting("ATLAS_SESSION_IDLE_TIMEOUT", "60", "test", "org-a");
      mockGetSession.mockResolvedValueOnce(
        orgSession("org-a", new Date(Date.now() - 120_000).toISOString()),
      );
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // activeOrganizationId extraction
  // -------------------------------------------------------------------------

  describe("activeOrganizationId extraction", () => {
    it("extracts activeOrganizationId from session data", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: "admin" },
        session: { id: "sess_abc", userId: "usr_123", activeOrganizationId: "org-456" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.activeOrganizationId).toBe("org-456");
        expect(result.user.claims?.org_id).toBe("org-456");
      }
    });

    it("leaves activeOrganizationId undefined when not in session", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.activeOrganizationId).toBeUndefined();
        expect(result.user.claims?.org_id).toBeUndefined();
      }
    });

    it("treats null activeOrganizationId as no org", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123", activeOrganizationId: null },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.activeOrganizationId).toBeUndefined();
        expect(result.user.claims?.org_id).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // session origin claim (#4044 / ADR-0025 §5) — surfaces `session.origin` onto
  // claims so the admin audit can record `origin=cli` for CLI credentials.
  // -------------------------------------------------------------------------

  describe("session origin claim", () => {
    it("surfaces session.origin='cli' onto claims.origin", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: "admin" },
        session: { id: "sess_cli", userId: "usr_123", activeOrganizationId: "org-1", origin: "cli" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.origin).toBe("cli");
      }
    });

    it("leaves claims.origin undefined for a normal web/login session", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: "admin" },
        session: { id: "sess_web", userId: "usr_123", activeOrganizationId: "org-1" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.origin).toBeUndefined();
      }
    });

    it("a session-user `origin` field cannot shadow the authoritative session origin", async () => {
      // A hostile / stale session-user payload claiming origin must NOT win:
      // the session-row origin (here absent) governs, computed AFTER the spread.
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: "admin", origin: "cli" },
        session: { id: "sess_web", userId: "usr_123", activeOrganizationId: "org-1" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.origin).toBeUndefined();
      }
    });
  });

  // passkeyCount is read by `mfaRequired` to admit passkey-only admins.
  // The claim must always be present and authoritative — a missing field
  // silently locks out passkey users; a spread-overridable field lets a
  // hostile session-user payload inflate the count.
  describe("passkeyCount claim", () => {
    it("populates passkeyCount: 0 in claims when internal DB is unavailable", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.passkeyCount).toBe(0);
        expect(typeof result.user.claims?.passkeyCount).toBe("number");
      }
    });

    it("populates passkeyCount with the value from the passkey table when DB is up", async () => {
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([{ count: 2 }]);
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.passkeyCount).toBe(2);
      }
    });

    it("returns 0 when the count row is missing entirely", async () => {
      // pg returns no rows — should land 0, not NaN/undefined, so the gate's
      // `typeof === "number"` narrow continues to read a valid number.
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([]);
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.passkeyCount).toBe(0);
        expect(Number.isFinite(result.user.claims?.passkeyCount as number)).toBe(true);
      }
    });

    it("falls back to 0 when internalQuery throws (transient infra error)", async () => {
      // Auth must still succeed — failing the whole login because of a
      // passkey-count read would be a much worse outcome than gating the user.
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.reject(new Error("connection refused"));
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.passkeyCount).toBe(0);
      }
    });

    it("attacker-controlled passkeyCount on the session user cannot bypass the gate", async () => {
      // Computed fields land AFTER the spread (managed.ts), so a hostile
      // session-user payload that already carries `passkeyCount: "9999"`
      // gets shadowed by the resolver's authoritative 0.
      mockHasInternalDB = false; // resolver returns 0
      mockGetSession.mockResolvedValueOnce({
        user: {
          id: "usr_123",
          email: "alice@example.com",
          passkeyCount: "9999" as unknown as number,
        },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.passkeyCount).toBe(0);
      }
    });
  });
});
