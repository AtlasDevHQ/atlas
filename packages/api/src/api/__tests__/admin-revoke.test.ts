/**
 * Admin force-revoke route tests.
 *
 * The MockClient below captures every BEGIN / COMMIT / ROLLBACK so the
 * tests can pin both the happy-path (BEGIN + 6 DELETEs + COMMIT) and
 * rollback (BEGIN + 1+ DELETEs + ROLLBACK) lifecycles, the per-class
 * audit counts, the org-scope vs platform-admin authz split, and the
 * pg-userinfo scrub on the failure-audit error message.
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
  mocks.setOrgAdmin("org-alpha");
  mocks.mockInternalQuery.mockReset();
  // Default: target user exists in caller's org, no membership rows beyond
  // what the workspace-admin path needs to pass through.
  mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes(`FROM member`) && sql.includes(`"organizationId"`)) {
      // verifyOrgMembership lookup — return a row when the target user is
      // claimed to be in the active org. Tests that need a foreign user
      // override this branch directly.
      return [{ userId: params?.[0] ?? "unknown" }];
    }
    if (sql.includes(`FROM "user"`) && sql.includes(`WHERE id = $1`)) {
      return [{ id: params?.[0] ?? "user-target", email: "target@test.com" }];
    }
    if (sql.includes(`SELECT COUNT(*)`)) {
      return [{ count: "0" }];
    }
    return [];
  });
  mockLogAdminAction.mockClear();
  resetTxClient();
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users/:id/revoke-auth/preview
// ---------------------------------------------------------------------------

describe("admin revoke-auth — GET /users/:id/revoke-auth/preview", () => {
  it("returns per-class counts for the danger-zone UI", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes(`FROM member`)) return [{ userId: params?.[0] }];
      if (sql.includes(`FROM "user"`)) return [{ id: params?.[0], email: "fired@example.com" }];
      // Per-class counts — different values each so a regression that swaps
      // table references in the SQL is caught.
      if (sql.includes(`FROM session`)) return [{ count: "3" }];
      if (sql.includes(`FROM trusted_device`)) return [{ count: "2" }];
      if (sql.includes(`FROM passkey`)) return [{ count: "1" }];
      if (sql.includes(`FROM "oauthAccessToken"`)) return [{ count: "5" }];
      if (sql.includes(`FROM "oauthRefreshToken"`)) return [{ count: "4" }];
      return [];
    });

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/users/user-target/revoke-auth/preview"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targetUserId: string;
      targetUserEmail: string | null;
      sessions: number;
      trustedDevices: number;
      passkeys: number;
      oauthAccessTokens: number;
      oauthRefreshTokens: number;
    };
    expect(body.targetUserId).toBe("user-target");
    expect(body.targetUserEmail).toBe("fired@example.com");
    expect(body.sessions).toBe(3);
    expect(body.trustedDevices).toBe(2);
    expect(body.passkeys).toBe(1);
    expect(body.oauthAccessTokens).toBe(5);
    expect(body.oauthRefreshTokens).toBe(4);
  });

  it("returns 404 when the target user is not in the caller's workspace", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      // Workspace-admin verifyOrgMembership returns 0 rows — target lives
      // in another org. Preview should refuse rather than leak counts.
      if (sql.includes(`FROM member`)) return [];
      return [];
    });

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/users/foreign-user/revoke-auth/preview"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the target user does not exist at all", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes(`FROM member`)) return [{ userId: params?.[0] }];
      if (sql.includes(`FROM "user"`)) return [];
      return [];
    });

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/users/missing-user/revoke-auth/preview"),
    );
    expect(res.status).toBe(404);
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
      adminRequest("GET", "/api/v1/admin/users/user-target/revoke-auth/preview"),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/users/:id/revoke-auth
// ---------------------------------------------------------------------------

describe("admin revoke-auth — POST /users/:id/revoke-auth", () => {
  it("atomically deletes every auth artefact and emits success audit with counts", async () => {
    queryHandler = async (sql) => {
      if (sql.includes("DELETE FROM verification")) {
        return { rows: [{ identifier: "v1" }, { identifier: "v2" }] };
      }
      if (sql.includes("DELETE FROM trusted_device")) {
        return { rows: [{ identifier: "td1" }, { identifier: "td2" }] };
      }
      if (sql.includes("DELETE FROM session")) {
        return { rows: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] };
      }
      if (sql.includes("DELETE FROM passkey")) {
        return { rows: [{ id: "pk1" }] };
      }
      if (sql.includes(`DELETE FROM "oauthAccessToken"`)) {
        return { rows: [{ id: "at1" }, { id: "at2" }, { id: "at3" }, { id: "at4" }, { id: "at5" }] };
      }
      if (sql.includes(`DELETE FROM "oauthRefreshToken"`)) {
        return { rows: [{ id: "rt1" }, { id: "rt2" }, { id: "rt3" }, { id: "rt4" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest(
        "POST",
        "/api/v1/admin/users/user-target/revoke-auth",
        { reason: "Contractor terminated 2026-05-05" },
        { "x-forwarded-for": "203.0.113.42" },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      targetUserId: string;
      sessionsRevoked: number;
      trustedDevicesRevoked: number;
      passkeysRevoked: number;
      oauthAccessTokensRevoked: number;
      oauthRefreshTokensRevoked: number;
      verificationRowsRevoked: number;
    };
    expect(body.success).toBe(true);
    expect(body.targetUserId).toBe("user-target");
    expect(body.sessionsRevoked).toBe(3);
    expect(body.trustedDevicesRevoked).toBe(2);
    expect(body.passkeysRevoked).toBe(1);
    expect(body.oauthAccessTokensRevoked).toBe(5);
    expect(body.oauthRefreshTokensRevoked).toBe(4);
    expect(body.verificationRowsRevoked).toBe(2);

    // Transaction lifecycle: BEGIN first, COMMIT must be the LAST query
    // (a stray DELETE after COMMIT would land outside the transaction
    // and leak across-user state), ROLLBACK must not run.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeUndefined();

    // verification → trusted_device order is the only ordering with
    // correctness implications (see route header). Other DELETEs are
    // independent — assert membership, not order.
    const deleteOrder = clientQueries
      .filter((q) => /^\s*DELETE\s+FROM/i.test(q.sql))
      .map((q) => {
        const m = q.sql.match(/DELETE\s+FROM\s+"?(\w+)"?/i);
        return m ? m[1] : null;
      });
    expect(deleteOrder[0]).toBe("verification");
    expect(deleteOrder[1]).toBe("trusted_device");
    expect(deleteOrder).toContain("session");
    expect(deleteOrder).toContain("passkey");
    expect(deleteOrder).toContain("oauthAccessToken");
    expect(deleteOrder).toContain("oauthRefreshToken");

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.auth_revoke");
    expect(entry.targetType).toBe("user");
    expect(entry.targetId).toBe("user-target");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({
      targetUserId: "user-target",
      targetUserEmail: "target@test.com",
      sessionsRevoked: 3,
      trustedDevicesRevoked: 2,
      passkeysRevoked: 1,
      oauthAccessTokensRevoked: 5,
      oauthRefreshTokensRevoked: 4,
      verificationRowsRevoked: 2,
      reason: "Contractor terminated 2026-05-05",
    });
    // Audit IP comes from x-forwarded-for header (proxied deploys). A
    // regression that swapped the priority or dropped the header read
    // would land `null` here.
    expect(entry.ipAddress).toBe("203.0.113.42");
  });

  it("succeeds with zero counts when the user has no live credentials (forensic signal)", async () => {
    queryHandler = async () => ({ rows: [] });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/revoke-auth", {}),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; sessionsRevoked: number };
    expect(body.success).toBe(true);
    expect(body.sessionsRevoked).toBe(0);

    // Zero-count revoke still emits an audit row — confirming the action
    // against a user with nothing to revoke is itself the forensic signal.
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.auth_revoke");
    expect(entry.metadata).toMatchObject({
      targetUserId: "user-target",
      sessionsRevoked: 0,
      trustedDevicesRevoked: 0,
      passkeysRevoked: 0,
      oauthAccessTokensRevoked: 0,
      oauthRefreshTokensRevoked: 0,
      verificationRowsRevoked: 0,
    });
  });

  it("scopes by userId on every transactional DELETE", async () => {
    queryHandler = async () => ({ rows: [] });

    await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/revoke-auth", {}),
    );

    // Every DELETE inside the transaction must carry $1 = userId. A
    // regression that scopes the DELETE by something other than the
    // target user is exactly the kind of cross-user revoke this surface
    // exists to prevent.
    const deletes = clientQueries.filter((q) => /^\s*DELETE\s+FROM/i.test(q.sql));
    expect(deletes.length).toBeGreaterThanOrEqual(6);
    for (const del of deletes) {
      expect(del.params?.[0]).toBe("user-target");
    }
  });

  it("workspace admin cannot revoke a foreign-org user — 404 + audit attempt", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes(`FROM member`)) return []; // not in caller's org
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/foreign-user/revoke-auth", {}),
    );

    expect(res.status).toBe(404);

    // No transaction was opened — the org-scope gate ran before any
    // DELETE could touch a foreign-org user's artifacts.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);

    // Probing a foreign-workspace user is a forensic signal — the
    // attempt is recorded with `found: false`.
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.auth_revoke");
    expect(entry.metadata).toMatchObject({
      targetUserId: "foreign-user",
      found: false,
    });
  });

  it("platform admin can revoke across orgs", async () => {
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
    // Even though `member` lookup would fail, platform admin bypasses
    // the verifyOrgMembership gate. Pre-fetch must still find the user.
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes(`FROM member`)) return []; // platform admin doesn't need this
      if (sql.includes(`FROM "user"`)) {
        return [{ id: params?.[0], email: "in-other-org@test.com" }];
      }
      return [];
    });
    queryHandler = async (sql) => {
      if (sql.includes("DELETE FROM session")) return { rows: [{ id: "s1" }] };
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/cross-org-user/revoke-auth", {}),
    );

    expect(res.status).toBe(200);

    // Transaction ran — platform admin reached across orgs.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({
      targetUserId: "cross-org-user",
      targetUserEmail: "in-other-org@test.com",
      sessionsRevoked: 1,
    });
  });

  it("rolls back and emits failure audit with phase + scrubbed error when a DELETE throws mid-sequence", async () => {
    queryHandler = async (sql) => {
      if (sql.includes("DELETE FROM verification")) {
        return { rows: [{ identifier: "v1" }] };
      }
      if (sql.includes("DELETE FROM trusted_device")) {
        return { rows: [{ identifier: "td1" }] };
      }
      if (sql.includes("DELETE FROM session")) {
        // Mid-flight failure after two successful DELETEs. The transaction
        // must roll back so the trust-device DELETE doesn't outlive a
        // failed session revoke (the "off-board the contractor"
        // half-revoke this surface exists to prevent).
        throw new Error(
          "connection refused: postgres://atlas_user:supersecret@db.internal:5432/atlas",
        );
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/revoke-auth", {}),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);

    // Failure audit emitted exactly once with the phase that tripped + a
    // scrubbed error message. Pin the scrub: a regression that pipes
    // `(err as Error).message` straight into metadata would land the
    // password in the audit log.
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.auth_revoke");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      targetUserId: "user-target",
      phase: "session",
    });
    const err = String(entry.metadata?.error ?? "");
    expect(err).toContain("postgres://***@db.internal");
    expect(err).not.toContain("atlas_user");
    expect(err).not.toContain("supersecret");
  });

  it("destroys the client when ROLLBACK itself fails — pool-poison defence", async () => {
    // Both the primary DELETE and the recovery ROLLBACK throw. pg's
    // contract is that `release(err)` with a truthy arg destroys the
    // socket, so a poisoned client can never return to the pool to
    // corrupt the next borrower's transaction. A regression that called
    // `release()` (no arg) on the catch path would silently re-pool a
    // client stuck mid-transaction — manifesting as cross-user state
    // leak in the next request, not as a failure here.
    queryHandler = async (sql) => {
      if (sql.includes("DELETE FROM verification")) {
        throw new Error("primary delete failed");
      }
      if (sql.trim().toUpperCase() === "ROLLBACK") {
        throw new Error("rollback also failed: TCP reset");
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/revoke-auth", {}),
    );

    expect(res.status).toBe(500);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);

    // The load-bearing assertion: client.release() received the
    // rollback error so pg destroys the underlying socket.
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeInstanceOf(Error);
    expect(String((clientReleaseArg as Error).message)).toContain("rollback also failed");

    // The original failure (not the rollback failure) is what the
    // failure audit + 500 surface to the caller.
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      targetUserId: "user-target",
      phase: "verification",
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
      adminRequest("POST", "/api/v1/admin/users/missing-user/revoke-auth", {}),
    );

    expect(res.status).toBe(404);

    // No transaction opened — the user-not-found branch must short-circuit
    // before BEGIN so no auth artefacts get touched on a typo'd id.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);

    // Attempt is still audited.
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
      adminRequest("POST", "/api/v1/admin/users/user-target/revoke-auth", {}),
    );
    expect(res.status).toBe(403);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("returns 404 when no internal DB is configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/revoke-auth", {}),
    );
    expect(res.status).toBe(404);
  });

  it("rejects an oversized reason rather than landing it in audit metadata", async () => {
    // The contract is "reject before BEGIN" — wherever in the validator
    // chain the reject lands (currently OpenAPIHono's defaultHook → 422),
    // the over-length reason must never reach `admin_action_log`.
    const huge = "x".repeat(501);
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user-target/revoke-auth", {
        reason: huge,
      }),
    );
    expect(res.status).toBe(422);
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);
  });
});
