/**
 * Admin MFA-reset route tests (#2092).
 *
 * Sibling to `admin-revoke.test.ts`: same MockClient transactional capture,
 * same workspace-vs-platform authz split, same scrub-the-pg-userinfo audit
 * contract. The narrower deletion scope (passkeys + twoFactor only) is the
 * load-bearing distinction — a regression that started deleting sessions
 * or OAuth tokens here would erase the boundary between #2093 and #2092
 * and is exactly what these tests pin.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const mockGetInternalDB = mock(() => ({
  connect: async () => makeMockClient(),
}));

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
  internal: {
    getInternalDB: mockGetInternalDB,
  },
});

// Mutable detectAuthMode override — the factory captures a frozen mode
// at construction; we need a runtime knob so the simple-key guard test
// can flip without rebuilding the whole mock graph. Later mock.module
// wins, so this overrides the factory's detect stub.
let currentAuthMode = "managed";
mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => currentAuthMode,
  resetAuthModeCache: () => {},
}));

interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// ---------------------------------------------------------------------------
// Transactional client mock
// ---------------------------------------------------------------------------

interface ClientQuery {
  sql: string;
  params?: unknown[];
}

interface MockClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: (err?: unknown) => void;
}

let clientQueries: ClientQuery[] = [];
let clientReleased = false;
let clientReleaseArg: unknown = undefined;
let queryHandler: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> = async () => ({ rows: [] });

function makeMockClient(): MockClient {
  return {
    query: async (sql: string, params?: unknown[]) => {
      clientQueries.push({ sql, params });
      return queryHandler(sql, params);
    },
    release: (err?: unknown) => {
      clientReleased = true;
      clientReleaseArg = err;
    },
  };
}

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

function adminRequest(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
      ...extraHeaders,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

function resetTxClient(): void {
  clientQueries = [];
  clientReleased = false;
  clientReleaseArg = undefined;
  queryHandler = async () => ({ rows: [] });
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  currentAuthMode = "managed";
  mocks.setOrgAdmin("org-alpha");
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes(`FROM member`) && sql.includes(`"organizationId"`)) {
      return [{ userId: params?.[0] ?? "unknown" }];
    }
    if (sql.includes(`FROM "user"`) && sql.includes(`WHERE id = $1`)) {
      return [{ id: params?.[0] ?? "user-target", email: "target@test.com" }];
    }
    return [];
  });
  mockLogAdminAction.mockClear();
  resetTxClient();
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/users/:id/reset-mfa
// ---------------------------------------------------------------------------

describe("admin reset-mfa — POST /users/:id/reset-mfa", () => {
  it("atomically clears passkeys + TOTP and emits success audit with per-artifact counts", async () => {
    queryHandler = async (sql) => {
      if (sql.includes("DELETE FROM passkey")) {
        return { rows: [{ id: "pk1" }, { id: "pk2" }] };
      }
      if (sql.includes(`DELETE FROM "twoFactor"`)) {
        // Two rows returned: one carries backup-code material, the other doesn't.
        // The route emits both `totpSecretsRevoked` and `backupCodeBatchesRevoked`
        // so triage can tell "this user had 1 batch of codes" from "no codes were
        // ever issued".
        return {
          rows: [
            { id: "tf1", had_backup_codes: true },
            { id: "tf2", had_backup_codes: false },
          ],
        };
      }
      if (/UPDATE\s+"user"/i.test(sql)) {
        return { rows: [{ id: "user-target" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest(
        "POST",
        "/api/v1/admin/users/user-target/reset-mfa",
        { reason: "Lost all devices 2026-05-05" },
        { "x-forwarded-for": "203.0.113.42" },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      targetUserId: string;
      passkeysRevoked: number;
      totpSecretsRevoked: number;
      backupCodeBatchesRevoked: number;
    };
    expect(body.success).toBe(true);
    expect(body.targetUserId).toBe("user-target");
    expect(body.passkeysRevoked).toBe(2);
    expect(body.totpSecretsRevoked).toBe(2);
    expect(body.backupCodeBatchesRevoked).toBe(1);

    // Transaction lifecycle: BEGIN first, COMMIT must be the LAST query
    // (a stray DELETE after COMMIT would land outside the transaction
    // and leak across-user state), ROLLBACK must not run.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeUndefined();

    // Positive whitelist: this route MUST mutate exactly { passkey,
    // twoFactor, user } and nothing else. A copy-paste regression from
    // admin-revoke.ts that added a DELETE on session/trust-device/OAuth
    // would surface as an extra entry. Stronger than a negative
    // blacklist — it catches additions to a fourth table we haven't
    // thought to forbid.
    const tablesTouched = clientQueries
      .filter((q) => /^\s*(DELETE|UPDATE)\b/i.test(q.sql))
      .map((q) => {
        const m = q.sql.match(/(?:DELETE\s+FROM|UPDATE)\s+"?(\w+)"?/i);
        return m ? m[1] : null;
      });
    expect([...new Set(tablesTouched)].sort()).toEqual([
      "passkey",
      "twoFactor",
      "user",
    ]);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.mfa_reset");
    expect(entry.targetType).toBe("user");
    expect(entry.targetId).toBe("user-target");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({
      targetUserId: "user-target",
      targetUserEmail: "target@test.com",
      passkeysRevoked: 2,
      totpSecretsRevoked: 2,
      backupCodeBatchesRevoked: 1,
      reason: "Lost all devices 2026-05-05",
    });
    expect(entry.ipAddress).toBe("203.0.113.42");
  });

  it("succeeds with zero counts when the user has no enrolled MFA artifacts", async () => {
    queryHandler = async () => ({ rows: [] });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/reset-mfa", {}),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; passkeysRevoked: number };
    expect(body.success).toBe(true);
    expect(body.passkeysRevoked).toBe(0);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.mfa_reset");
    expect(entry.metadata).toMatchObject({
      targetUserId: "user-target",
      passkeysRevoked: 0,
      totpSecretsRevoked: 0,
      backupCodeBatchesRevoked: 0,
    });
  });

  it("scopes by userId on every transactional DELETE / UPDATE", async () => {
    queryHandler = async () => ({ rows: [] });

    await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/reset-mfa", {}),
    );

    // Every mutating query inside the transaction must carry $1 = userId.
    // A regression that scopes a DELETE on something other than the
    // target user is exactly the cross-user reset this surface forbids.
    const muts = clientQueries.filter((q) => /^\s*(DELETE\s+FROM|UPDATE)\b/i.test(q.sql));
    expect(muts.length).toBeGreaterThanOrEqual(3);
    for (const m of muts) {
      expect(m.params?.[0]).toBe("user-target");
    }
  });

  it("clears user.twoFactorEnabled so the mfaRequired middleware re-blocks on next sign-in", async () => {
    queryHandler = async () => ({ rows: [] });

    await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/reset-mfa", {}),
    );

    // The "force re-enrollment" contract: clearing both DELETE targets
    // AND `user.twoFactorEnabled` is what trips the mfaRequired 403 on
    // the next admin-router request. Dropping the UPDATE would leave a
    // stale-true `twoFactorEnabled` for an admin who has no actual
    // backing twoFactor row — the gate would admit them silently.
    const userUpdate = clientQueries.find(
      (q) => /UPDATE\s+"user"/i.test(q.sql) && /twoFactorEnabled/i.test(q.sql),
    );
    expect(userUpdate).toBeDefined();
    expect(userUpdate?.params?.[0]).toBe("user-target");
  });

  it("workspace admin cannot reset a foreign-org user — 404 + audit attempt", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes(`FROM member`)) return [];
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/foreign-user/reset-mfa", {}),
    );

    expect(res.status).toBe(404);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.mfa_reset");
    expect(entry.metadata).toMatchObject({
      targetUserId: "foreign-user",
      found: false,
    });
  });

  it("platform admin can reset across orgs", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "platform-admin-1",
          mode: "managed",
          label: "platform@test.com",
          role: "platform_admin",
          activeOrganizationId: "org-alpha",
          claims: { twoFactorEnabled: true },
        },
      }),
    );
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes(`FROM member`)) return []; // platform admin doesn't need this
      if (sql.includes(`FROM "user"`)) {
        return [{ id: params?.[0], email: "in-other-org@test.com" }];
      }
      return [];
    });
    queryHandler = async (sql) => {
      if (sql.includes("DELETE FROM passkey")) return { rows: [{ id: "pk1" }] };
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/cross-org-user/reset-mfa", {}),
    );

    expect(res.status).toBe(200);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({
      targetUserId: "cross-org-user",
      targetUserEmail: "in-other-org@test.com",
      passkeysRevoked: 1,
    });
  });

  it("rolls back and emits failure audit with phase + scrubbed error when a DELETE throws mid-sequence", async () => {
    queryHandler = async (sql) => {
      if (sql.includes("DELETE FROM passkey")) {
        return { rows: [{ id: "pk1" }] };
      }
      if (sql.includes(`DELETE FROM "twoFactor"`)) {
        throw new Error(
          "connection refused: postgres://atlas_user:supersecret@db.internal:5432/atlas",
        );
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/reset-mfa", {}),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.mfa_reset");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      targetUserId: "user-target",
      phase: "two_factor",
    });
    const err = String(entry.metadata?.error ?? "");
    expect(err).toContain("postgres://***@db.internal");
    expect(err).not.toContain("atlas_user");
    expect(err).not.toContain("supersecret");
  });

  it("destroys the client when ROLLBACK itself fails — pool-poison defence", async () => {
    queryHandler = async (sql) => {
      if (sql.includes("DELETE FROM passkey")) {
        throw new Error("primary delete failed");
      }
      if (sql.trim().toUpperCase() === "ROLLBACK") {
        throw new Error("rollback also failed: TCP reset");
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/reset-mfa", {}),
    );

    expect(res.status).toBe(500);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);

    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeInstanceOf(Error);
    expect(String((clientReleaseArg as Error).message)).toContain("rollback also failed");

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      targetUserId: "user-target",
      phase: "passkey",
    });
    expect(String(entry.metadata?.error ?? "")).toContain("primary delete failed");
  });

  it("returns 404 when the target user does not exist before any DELETE runs", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes(`FROM member`)) return [{ userId: params?.[0] }];
      if (sql.includes(`FROM "user"`)) return [];
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/missing-user/reset-mfa", {}),
    );

    expect(res.status).toBe(404);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    expect(lastAuditCall().metadata).toMatchObject({
      targetUserId: "missing-user",
      found: false,
    });
  });

  it("returns 403 for non-admin members", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "user@test.com",
          role: "member",
          activeOrganizationId: "org-alpha",
        },
      }),
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/reset-mfa", {}),
    );
    expect(res.status).toBe(403);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("returns 404 when no internal DB is configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/reset-mfa", {}),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 in simple-key mode even with an internal DB attached", async () => {
    // The right arm of `!hasInternalDB() || detectAuthMode() !== "managed"`.
    // A regression that flipped the OR to AND, or dropped the auth-mode
    // check, would let a self-hosted simple-key admin clear another
    // user's MFA against the managed Better Auth schema.
    mocks.hasInternalDB = true;
    currentAuthMode = "simple-key";
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/reset-mfa", {}),
    );
    expect(res.status).toBe(404);
    // Fast-path guard — no transaction should have been opened.
    expect(clientQueries.map((q) => q.sql.trim().toUpperCase()).includes("BEGIN")).toBe(false);
  });

  it("rejects an oversized reason rather than landing it in audit metadata", async () => {
    const huge = "x".repeat(501);
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/reset-mfa", {
        reason: huge,
      }),
    );
    expect(res.status).toBe(422);
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/me/mfa-factors
// ---------------------------------------------------------------------------

describe("admin mfa-factors — GET /me/mfa-factors", () => {
  it("returns the per-user factor snapshot for the BackupMethodBanner predicate", async () => {
    mocks.mockInternalQuery.mockImplementation(async () => [
      { has_password: false, has_totp: false, passkey_count: 1 },
    ]);

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/me/mfa-factors"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hasPassword: boolean;
      hasTotp: boolean;
      passkeyCount: number;
    };
    // The lockout-risk predicate the banner pins on: one passkey, no
    // password, no TOTP. A regression that swapped boolean polarity in
    // the SQL → JSON map would surface here.
    expect(body).toEqual({ hasPassword: false, hasTotp: false, passkeyCount: 1 });
  });

  it("normalizes a non-managed session to a no-risk snapshot (banner stays silent)", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "admin-1",
          mode: "simple-key",
          label: "Admin",
          role: "admin",
        },
      }),
    );

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/me/mfa-factors"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hasPassword: boolean;
      hasTotp: boolean;
      passkeyCount: number;
    };
    // simple-key mode has no Better Auth user record. Returning all-zero
    // keeps the banner inert for self-hosted simple-key admins instead
    // of 500-ing on a pointless SQL lookup.
    expect(body).toEqual({ hasPassword: false, hasTotp: false, passkeyCount: 0 });
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        mode: "managed",
        status: 401,
        error: "No session found",
      }),
    );

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/me/mfa-factors"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 500 on DB error rather than silently leaking a false 'no-risk' snapshot", async () => {
    mocks.mockInternalQuery.mockImplementation(async () => {
      throw new Error("connection refused");
    });

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/me/mfa-factors"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toBeDefined();
  });
});

