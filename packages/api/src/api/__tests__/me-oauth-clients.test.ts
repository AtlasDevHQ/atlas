/**
 * Per-user OAuth-clients route tests (#2065 — Settings → AI Agents).
 *
 * The hosted-MCP install path leaves a Dynamic Client Registration trail in
 * Better Auth's `oauthClient` table. Workspace users (non-admin) need a
 * surface to see and revoke clients they personally registered. The admin
 * variant of this route (`/api/v1/admin/oauth-clients`) tests live in
 * `admin-oauth-clients.test.ts` and pin the workspace-wide scope; this
 * file pins the per-user scope:
 *
 *   GET  /api/v1/me/oauth-clients         → list rows where
 *                                            `userId = caller AND
 *                                             referenceId = activeOrgId`
 *   POST /api/v1/me/oauth-clients/:id/revoke
 *                                          → atomic delete: client +
 *                                            outstanding access / refresh
 *                                            tokens + consent for that
 *                                            (client, user) pair
 *
 * Cross-user isolation: User A cannot see or revoke User B's clients —
 * even ones in the same workspace. The IDOR guard is the `userId` filter
 * on every SELECT and DELETE; tests gate the mock SQL response on the
 * userId param so a regression that drops the filter fails loudly here.
 *
 * Atomicity / race detection / rollback semantics are inherited from the
 * shared `lib/auth/oauth-clients.ts` helper and pinned by the admin test;
 * this file focuses on the per-user shape (filter, audit actor=user,
 * deployMode in the GET response).
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
    id: "user-1",
    mode: "managed",
    label: "user@test.com",
    role: "member",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
  internal: {
    getInternalDB: mockGetInternalDB,
  },
});

// `getConfig` is `null` by default in the test factory. We override here so
// the route can read `deployMode` for the `GET` response. A `null` config
// surfaces as `deployMode: "self-hosted"` — the route's safe default.
let mockConfigOverride: { deployMode?: "saas" | "self-hosted" } | null = {
  deployMode: "saas",
};

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfigOverride,
  defineConfig: (c: unknown) => c,
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
// `revokeOAuthClient` calls `getInternalDB().connect()` to acquire a pg client
// for BEGIN/DELETE×4/COMMIT. Tests need to drive per-DELETE return values and
// assert the lifecycle, so the mock pool exposes a single shared client
// whose queries are recorded into `clientQueries`.

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

function meRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
  });
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
  mocks.setMember("org-alpha");
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockResolvedValue([]);
  mockLogAdminAction.mockClear();
  resetTxClient();
  mockConfigOverride = { deployMode: "saas" };
});

// ---------------------------------------------------------------------------
// GET /api/v1/me/oauth-clients
// ---------------------------------------------------------------------------

describe("me oauth-clients — GET /me/oauth-clients", () => {
  it("lists clients filtered by userId AND referenceId", async () => {
    // The mock keys both filters: a regression that drops the userId filter
    // would still match params[0] = orgId and would receive an empty array
    // here — but because the SQL would no longer match the assertion below,
    // the test would fail on the SQL shape check first.
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("oauthClient")) {
          expect(sql).toContain(`"referenceId"`);
          expect(sql).toContain(`"userId"`);
          if (params?.[0] !== "org-alpha") return [];
          if (params?.[1] !== "user-1") return [];
          return [
            {
              clientId: "claude-desktop",
              clientName: "Claude Desktop",
              redirectUris: ["http://127.0.0.1:6274/callback"],
              createdAt: "2026-04-12T10:00:00.000Z",
              updatedAt: "2026-04-12T10:00:00.000Z",
              disabled: false,
              type: "public",
              lastUsedAt: "2026-05-01T15:30:00.000Z",
              tokenCount: "3",
            },
          ];
        }
        return [];
      },
    );

    const res = await app.fetch(
      meRequest("GET", "/api/v1/me/oauth-clients"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clients: Array<{ clientId: string; clientName: string | null; tokenCount: number }>;
      deployMode: "saas" | "self-hosted";
    };
    expect(body.clients).toHaveLength(1);
    expect(body.clients[0]!.clientId).toBe("claude-desktop");
    expect(body.clients[0]!.tokenCount).toBe(3);
    expect(body.deployMode).toBe("saas");
  });

  it("returns an empty list + deployMode when the user has registered no clients", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);

    const res = await app.fetch(
      meRequest("GET", "/api/v1/me/oauth-clients"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clients: unknown[];
      deployMode: string;
    };
    expect(body.clients).toEqual([]);
    expect(body.deployMode).toBe("saas");
  });

  it("falls back to deployMode='self-hosted' when getConfig returns null", async () => {
    mockConfigOverride = null;
    mocks.mockInternalQuery.mockResolvedValue([]);

    const res = await app.fetch(
      meRequest("GET", "/api/v1/me/oauth-clients"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deployMode: string };
    expect(body.deployMode).toBe("self-hosted");
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        status: 401,
        error: "Authentication required",
      }),
    );

    const res = await app.fetch(
      meRequest("GET", "/api/v1/me/oauth-clients"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when no internal DB is configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      meRequest("GET", "/api/v1/me/oauth-clients"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 500 with requestId when the DB query fails", async () => {
    mocks.mockInternalQuery.mockRejectedValue(new Error("connection refused"));

    const res = await app.fetch(
      meRequest("GET", "/api/v1/me/oauth-clients"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/me/oauth-clients/:id/revoke
// ---------------------------------------------------------------------------

describe("me oauth-clients — POST /me/oauth-clients/:id/revoke", () => {
  it("atomically revokes (client, user) tuple and emits audit (actor=user)", async () => {
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT") && sql.includes("oauthClient")) {
          expect(sql).toContain(`"referenceId"`);
          expect(sql).toContain(`"userId"`);
          expect(params).toContain("claude-desktop");
          expect(params).toContain("org-alpha");
          expect(params).toContain("user-1");
          return [{ clientId: "claude-desktop", clientName: "Claude Desktop" }];
        }
        return [];
      },
    );
    queryHandler = async (sql) => {
      if (sql.includes("DELETE") && sql.includes("oauthAccessToken")) {
        // Every DELETE must scope by both referenceId AND userId.
        expect(sql).toContain(`"referenceId"`);
        expect(sql).toContain(`"userId"`);
        return { rows: [{ id: "tok_1" }, { id: "tok_2" }] };
      }
      if (sql.includes("DELETE") && sql.includes("oauthRefreshToken")) {
        expect(sql).toContain(`"userId"`);
        return { rows: [{ id: "rt_1" }] };
      }
      if (sql.includes("DELETE") && sql.includes("oauthConsent")) {
        expect(sql).toContain(`"userId"`);
        return { rows: [{ id: "cs_1" }] };
      }
      if (sql.includes("DELETE") && sql.includes("oauthClient")) {
        expect(sql).toContain(`"userId"`);
        return { rows: [{ clientId: "claude-desktop" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      meRequest("POST", "/api/v1/me/oauth-clients/claude-desktop/revoke"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      tokensRevoked: number;
    };
    expect(body.success).toBe(true);
    expect(body.tokensRevoked).toBe(3); // 2 access + 1 refresh

    // Transaction lifecycle.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeUndefined();

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("oauth_client.revoke");
    expect(entry.targetType).toBe("oauth_client");
    expect(entry.targetId).toBe("claude-desktop");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({
      clientId: "claude-desktop",
      clientName: "Claude Desktop",
      accessTokensRevoked: 2,
      refreshTokensRevoked: 1,
    });
  });

  it("returns 404 when the client belongs to a different user (cross-user isolation)", async () => {
    // Mock returns the row only when params[2] === a different userId — the
    // active caller is "user-1". A regression that dropped the userId filter
    // would request without params[2] and the row would surface, leaking
    // another user's client to the caller. With the filter intact the
    // pre-fetch returns empty and the route 404s.
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT") && sql.includes("oauthClient")) {
          if (params?.[2] === "user-2") {
            return [{ clientId: "user-2-client", clientName: "User 2's Client" }];
          }
          return [];
        }
        return [];
      },
    );

    const res = await app.fetch(
      meRequest("POST", "/api/v1/me/oauth-clients/user-2-client/revoke"),
    );

    expect(res.status).toBe(404);
    // Pre-fetch missed — no transaction was opened.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);
    // Forensic audit row still emitted so probes are visible.
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({
      clientId: "user-2-client",
      found: false,
    });
  });

  it("returns 404 when no internal DB is configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      meRequest("POST", "/api/v1/me/oauth-clients/claude-desktop/revoke"),
    );
    expect(res.status).toBe(404);
  });

  it("rolls back and returns 500 with requestId when a DELETE throws", async () => {
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string) => {
        if (sql.includes("SELECT") && sql.includes("oauthClient")) {
          return [{ clientId: "claude-desktop", clientName: "Claude Desktop" }];
        }
        return [];
      },
    );
    queryHandler = async (sql) => {
      if (sql.includes("DELETE") && sql.includes("oauthAccessToken")) {
        throw new Error("pool timeout");
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      meRequest("POST", "/api/v1/me/oauth-clients/claude-desktop/revoke"),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);

    // Failure audit emitted with phase + clientName.
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("oauth_client.revoke");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      clientId: "claude-desktop",
      clientName: "Claude Desktop",
      phase: "access_tokens",
      error: "pool timeout",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        status: 401,
        error: "Authentication required",
      }),
    );
    const res = await app.fetch(
      meRequest("POST", "/api/v1/me/oauth-clients/claude-desktop/revoke"),
    );
    expect(res.status).toBe(401);
  });
});
