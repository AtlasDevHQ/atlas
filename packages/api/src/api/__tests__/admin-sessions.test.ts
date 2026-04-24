/**
 * Admin session revocation audit emission across three write routes:
 *   - DELETE /api/v1/admin/sessions/:id          → user.session_revoke
 *   - DELETE /api/v1/admin/sessions/user/:uid    → user.session_revoke_all
 *   - POST   /api/v1/admin/users/:id/revoke      → user.session_revoke_all
 *
 * Security-relevant assertion technique: token-leak checks use **key
 * absence** (plus a recursive walk — any depth), not substring match on
 * the serialized payload. A `token: ""` or a truncated prefix would slip
 * past a naïve `.not.toContain` assertion.
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

// ---------------------------------------------------------------------------
// Unified mocks (authUser = workspace admin in org-alpha, mode = managed).
// ---------------------------------------------------------------------------

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

// ---------------------------------------------------------------------------
// Better Auth admin API mock — the admin.ts `revokeUserSessionsRoute` calls
// `getAdminApi()` which reads from `getAuthInstance().api`. The default
// mock in api-test-mocks returns `null`, which would cause the route to
// 404 before emitting any audit. Replace it here with a real mock surface.
// ---------------------------------------------------------------------------

const mockRevokeSessions: Mock<(opts: unknown) => Promise<unknown>> = mock(
  () => Promise.resolve({}),
);

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => ({
    api: {
      listUsers: mock(() => Promise.resolve({ users: [], total: 0 })),
      setRole: mock(() => Promise.resolve({})),
      banUser: mock(() => Promise.resolve({})),
      unbanUser: mock(() => Promise.resolve({})),
      removeUser: mock(() => Promise.resolve({})),
      revokeSessions: mockRevokeSessions,
    },
  }),
  listAllUsers: mock(() => Promise.resolve([])),
  setUserRole: mock(async () => {}),
  setBanStatus: mock(async () => {}),
  setPasswordChangeRequired: mock(async () => {}),
  deleteUser: mock(async () => {}),
}));

// ---------------------------------------------------------------------------
// Audit mock — capture `logAdminAction` calls but pass through the real
// ADMIN_ACTIONS catalog so assertions pin to canonical string values.
// ---------------------------------------------------------------------------

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

// Import the app AFTER all mocks.
const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Sentinel value placed in the request Authorization header so an accidental
// token leak into audit metadata is easy to spot in both key-scan and
// full-payload string assertions.
const SESSION_TOKEN_SENTINEL = "session-token-SHOULD-NOT-APPEAR-IN-AUDIT";

function adminRequest(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SESSION_TOKEN_SENTINEL}`,
      Cookie: `better-auth.session_token=${SESSION_TOKEN_SENTINEL}`,
      ...extraHeaders,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

// Recursively collect every key name in the audit entry + any nested
// object under it. Depth-1 walks would miss a regression that nests
// sensitive data like `metadata.raw.cookie`, so every level is in scope.
function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (value === null || typeof value !== "object") return acc;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    acc.push(k);
    collectKeys(v, acc);
  }
  return acc;
}

// Assert that no key anywhere in the entry matches a token-ish name. Paired
// with a sentinel-bytes substring check downstream for belt-and-braces.
function expectNoTokenKeys(entry: AuditEntry): void {
  const keys = collectKeys(entry);
  for (const k of keys) {
    expect(k).not.toMatch(/token|cookie|authorization|bearer|secret/i);
  }
}

// `mockMembershipFor` matches the `verifyOrgMembership` query in admin.ts —
// returns a row when the target user is the allowed member, empty otherwise.
function mockMembershipFor(allowedUserId: string): void {
  mocks.mockInternalQuery.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      if (
        sql.includes("member") &&
        sql.includes("userId") &&
        sql.includes("organizationId") &&
        !sql.includes("session")
      ) {
        return params?.[0] === allowedUserId
          ? [{ userId: allowedUserId }]
          : [];
      }
      return [];
    },
  );
}

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setOrgAdmin("org-alpha");
  mockLogAdminAction.mockClear();
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockResolvedValue([]);
  mockRevokeSessions.mockReset();
  mockRevokeSessions.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/sessions/:id
// ---------------------------------------------------------------------------

describe("admin sessions — DELETE /sessions/:id", () => {
  it("emits user.session_revoke with targetUserId captured from the pre-fetch", async () => {
    // The whole point of pre-fetching is that the DELETE strips the row
    // before the audit hook fires. Arrange the pre-fetch to return a row
    // owned by a different user than the acting admin so we can observe
    // both `targetUserId` and `wasCurrentUser: false`.
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT") && sql.includes("session") && sql.includes("id = $1")) {
          expect(params?.[0]).toBe("sess_target_123");
          expect(params?.[1]).toBe("org-alpha");
          return [{ id: "sess_target_123", userId: "user_other" }];
        }
        if (sql.includes("DELETE FROM session")) {
          return [{ id: "sess_target_123" }];
        }
        return [];
      },
    );

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/sess_target_123"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.session_revoke");
    expect(entry.targetType).toBe("user");
    expect(entry.targetId).toBe("sess_target_123");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toEqual({
      sessionId: "sess_target_123",
      targetUserId: "user_other",
      wasCurrentUser: false,
    });
  });

  it("sets wasCurrentUser: true when the revoked session belongs to the acting admin", async () => {
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string) => {
        if (sql.includes("SELECT") && sql.includes("session")) {
          return [{ id: "sess_own_1", userId: "admin-1" }];
        }
        if (sql.includes("DELETE FROM session")) {
          return [{ id: "sess_own_1" }];
        }
        return [];
      },
    );

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/sess_own_1"),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.metadata).toEqual({
      sessionId: "sess_own_1",
      targetUserId: "admin-1",
      wasCurrentUser: true,
    });
  });

  it("emits audit with found: false when the session does not exist", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/sess_missing"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.session_revoke");
    expect(entry.targetId).toBe("sess_missing");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toEqual({
      sessionId: "sess_missing",
      found: false,
    });
  });

  it("carries forward targetUserId when the row vanishes between pre-fetch and DELETE", async () => {
    // Exercises the race branch at admin-sessions.ts where the pre-fetch
    // sees a row but DELETE returns empty (concurrent revoke / user logout
    // in-window). `targetUserId` was already captured, so dropping it would
    // discard forensic context we paid for. `race: true` distinguishes this
    // from a plain pre-fetch miss in the audit trail.
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("session")) {
        return [{ id: "sess_racy", userId: "user_victim" }];
      }
      if (sql.includes("DELETE FROM session")) {
        return [];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/sess_racy"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.session_revoke");
    expect(entry.targetId).toBe("sess_racy");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toEqual({
      sessionId: "sess_racy",
      targetUserId: "user_victim",
      found: false,
      race: true,
    });
  });

  it("emits status: failure when the DELETE query throws", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("session")) {
        return [{ id: "sess_target_123", userId: "user_other" }];
      }
      if (sql.includes("DELETE FROM session")) {
        throw new Error("pool timeout");
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/sess_target_123"),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.session_revoke");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      sessionId: "sess_target_123",
      error: "pool timeout",
    });
  });

  it("scrubs pg connection-string userinfo from the error message", async () => {
    // Simulate a pg error that echoes the connection string back — the raw
    // message must never land in admin_action_log.metadata since it contains
    // the DB password.
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("session")) {
        throw new Error(
          "connection refused: postgres://atlas_user:supersecret@db.internal:5432/atlas",
        );
      }
      return [];
    });

    await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/sess_target_123"),
    );

    const entry = lastAuditCall();
    expect(entry.status).toBe("failure");
    const err = String(entry.metadata?.error ?? "");
    // Scheme survives, userinfo replaced.
    expect(err).toContain("postgres://***@db.internal");
    expect(err).not.toContain("atlas_user");
    expect(err).not.toContain("supersecret");
  });

  it("does not include session token bytes or token-ish keys in audit metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("session")) {
        return [{ id: "sess_token_probe", userId: "user_other" }];
      }
      if (sql.includes("DELETE FROM session")) {
        return [{ id: "sess_token_probe" }];
      }
      return [];
    });

    await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/sess_token_probe"),
    );

    const entry = lastAuditCall();
    expectNoTokenKeys(entry);
    expect(JSON.stringify(entry)).not.toContain(SESSION_TOKEN_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/sessions/user/:userId
// ---------------------------------------------------------------------------

describe("admin sessions — DELETE /sessions/user/:userId", () => {
  it("emits user.session_revoke_all with count matching the actual revoked rows", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("DELETE FROM session")) {
        // Three revoked sessions — the handler derives count from the
        // RETURNING clause so the audit row must reflect that exact number.
        return [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/user/user_target"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; count: number };
    expect(body.count).toBe(3);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.session_revoke_all");
    expect(entry.targetType).toBe("user");
    expect(entry.targetId).toBe("user_target");
    expect(entry.metadata).toEqual({
      targetUserId: "user_target",
      count: 3,
    });
    expect(entry.status ?? "success").toBe("success");
  });

  it("emits audit with count: 0 when the user has no sessions", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/user/user_no_sessions"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.session_revoke_all");
    expect(entry.metadata).toEqual({
      targetUserId: "user_no_sessions",
      count: 0,
    });
    expect(entry.status ?? "success").toBe("success");
  });

  it("emits status: failure when the bulk DELETE throws", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("DELETE FROM session")) {
        throw new Error("relation \"session\" does not exist");
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/user/user_target"),
    );

    expect(res.status).toBe(500);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.session_revoke_all");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      targetUserId: "user_target",
      error: "relation \"session\" does not exist",
    });
  });

  it("does not include session token bytes or token-ish keys in audit metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("DELETE FROM session")) {
        return [{ id: "s1" }];
      }
      return [];
    });

    await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/sessions/user/user_target"),
    );

    const entry = lastAuditCall();
    expectNoTokenKeys(entry);
    expect(JSON.stringify(entry)).not.toContain(SESSION_TOKEN_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/users/:id/revoke (admin.ts revokeUserSessionsRoute)
// ---------------------------------------------------------------------------

describe("admin users — POST /users/:id/revoke", () => {
  it("emits user.session_revoke_all with pre-counted session count on success", async () => {
    // The route doesn't learn the count from better-auth's revokeSessions,
    // so it pre-queries session COUNT(*). The pre-count hits the internal DB
    // *after* membership verification and before the revoke.
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (
          sql.includes("member") &&
          sql.includes("userId") &&
          sql.includes("organizationId")
        ) {
          return params?.[0] === "user_target"
            ? [{ userId: "user_target" }]
            : [];
        }
        if (sql.includes("COUNT(*)") && sql.includes("session")) {
          return [{ count: "2" }];
        }
        return [];
      },
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user_target/revoke"),
    );

    expect(res.status).toBe(200);
    expect(mockRevokeSessions).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.session_revoke_all");
    expect(entry.targetType).toBe("user");
    expect(entry.targetId).toBe("user_target");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toEqual({
      targetUserId: "user_target",
      count: 2,
    });
  });

  it("omits count and stamps countLookupFailed when the pre-count query fails", async () => {
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (
          sql.includes("member") &&
          sql.includes("userId") &&
          sql.includes("organizationId")
        ) {
          return params?.[0] === "user_target"
            ? [{ userId: "user_target" }]
            : [];
        }
        if (sql.includes("COUNT(*)") && sql.includes("session")) {
          throw new Error("pre-count failed");
        }
        return [];
      },
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user_target/revoke"),
    );

    // The revoke itself must still succeed — a count lookup failure cannot
    // block the forced logout, only degrade the audit row.
    expect(res.status).toBe(200);
    expect(mockRevokeSessions).toHaveBeenCalledTimes(1);

    const entry = lastAuditCall();
    expect(entry.status ?? "success").toBe("success");
    // Tight assertion: metadata is EXACTLY {targetUserId, countLookupFailed}.
    // `toEqual` catches a regression that silently adds `count: 0` or
    // `count: null`, which `toMatchObject` would let slip.
    expect(entry.metadata).toEqual({
      targetUserId: "user_target",
      countLookupFailed: true,
    });
  });

  it("stamps countLookupFailed when the internal DB is unavailable", async () => {
    mocks.hasInternalDB = false;
    mockMembershipFor("user_target");

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user_target/revoke"),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.metadata).toEqual({
      targetUserId: "user_target",
      countLookupFailed: true,
    });
  });

  it("emits status: failure when adminApi.revokeSessions throws", async () => {
    mockMembershipFor("user_target");
    mockRevokeSessions.mockImplementation(() =>
      Promise.reject(new Error("better-auth revoke failed")),
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user_target/revoke"),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = lastAuditCall();
    expect(entry.actionType).toBe("user.session_revoke_all");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      targetUserId: "user_target",
      error: "better-auth revoke failed",
    });
  });

  it("does not include session token bytes or token-ish keys in audit metadata", async () => {
    mockMembershipFor("user_target");

    await app.fetch(
      adminRequest("POST", "/api/v1/admin/users/user_target/revoke"),
    );

    const entry = lastAuditCall();
    expectNoTokenKeys(entry);
    expect(JSON.stringify(entry)).not.toContain(SESSION_TOKEN_SENTINEL);
  });

  it("threads the client IP into the audit row (x-forwarded-for)", async () => {
    mockMembershipFor("user_target");
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (
          sql.includes("member") &&
          sql.includes("userId") &&
          sql.includes("organizationId")
        ) {
          return params?.[0] === "user_target"
            ? [{ userId: "user_target" }]
            : [];
        }
        if (sql.includes("COUNT(*)") && sql.includes("session")) {
          return [{ count: "1" }];
        }
        return [];
      },
    );

    await app.fetch(
      adminRequest(
        "POST",
        "/api/v1/admin/users/user_target/revoke",
        undefined,
        { "X-Forwarded-For": "203.0.113.9" },
      ),
    );

    const entry = lastAuditCall();
    expect(entry.ipAddress).toBe("203.0.113.9");
  });
});
