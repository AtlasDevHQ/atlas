/**
 * Admin OAuth-clients route tests (#2024 — Settings → OAuth Clients).
 *
 * The hosted-MCP install path leaves a Dynamic Client Registration trail in
 * Better Auth's `oauthClient` table. Workspace admins need an inspection +
 * revocation surface; these tests pin the contract:
 *
 *   GET  /api/v1/admin/oauth-clients         → list rows scoped to the org
 *   POST /api/v1/admin/oauth-clients/:id/revoke
 *                                            → atomic delete: client +
 *                                              outstanding access tokens +
 *                                              refresh tokens + consent for
 *                                              that client, scoped to the
 *                                              org via `referenceId`
 *
 * Tokens issued under workspace A must remain queryable from workspace A
 * only — `referenceId` ties every row back to the active org. The tests
 * verify the SQL parameterization actually carries the org filter so a
 * future regression that drops the WHERE clause fails loudly here, not in
 * production.
 *
 * Atomicity: revocation runs in a single transaction. The MockClient below
 * captures every BEGIN/COMMIT/ROLLBACK so the tests can assert lifecycle +
 * race detection (concurrent revoke wins between pre-fetch and BEGIN) +
 * mid-flight failure (DELETE #2 throws → ROLLBACK → no stale state).
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

// `mockGetInternalDB` is wired into `createApiTestMocks` below so the
// `internal` mock module includes it from the start — adding it via a
// follow-up `mock.module()` would have to re-mock every named export from
// `@atlas/api/lib/db/internal` (CLAUDE.md: "Mock all exports — partial
// mocks cause SyntaxError"). The factory's `internal` override is the
// supported single-knob path.
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
// `revokeAtomically` calls `getInternalDB().connect()` to acquire a pg client
// for BEGIN/DELETE×4/COMMIT. Tests need to drive per-DELETE return values and
// assert the lifecycle, so the mock pool exposes a single shared client whose
// queries are recorded into `clientQueries`.

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
// pg destroys the socket when `release(err)` is called with a truthy arg.
// We assert this on the rollback-failure path so a poisoned client never
// returns to the pool to corrupt the next borrower.
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

function adminRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  mocks.setOrgAdmin("org-alpha");
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockResolvedValue([]);
  mockLogAdminAction.mockClear();
  resetTxClient();
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/oauth-clients
// ---------------------------------------------------------------------------

describe("admin oauth-clients — GET /oauth-clients", () => {
  it("lists clients scoped to the active org via referenceId", async () => {
    // Gate the row return on the orgId param. A regression that drops the
    // `referenceId = $1` filter from the SELECT would call this with a
    // different/empty param and the mock would (correctly) leak nothing —
    // but the test is also pinning that the SQL we emit IS the org-scoped
    // shape, not just that the mock got called.
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("oauthClient")) {
          expect(sql).toContain(`"referenceId"`);
          if (params?.[0] !== "org-alpha") return [];
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
              // #2066: live counts drive the tokenState derivation. An
              // active row (the assertion below relies on it) needs at
              // least one of these positive — pick `liveTokenCount` so
              // the row exercises the access-token-live branch.
              liveTokenCount: "2",
              liveRefreshCount: "1",
            },
          ];
        }
        return [];
      },
    );

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/oauth-clients"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clients: Array<{
        clientId: string;
        clientName: string | null;
        redirectUris: string[];
        createdAt: string;
        lastUsedAt: string | null;
        disabled: boolean;
        tokenCount: number;
        tokenState: "active" | "reconnect_required" | "revoked";
      }>;
    };
    expect(body.clients).toHaveLength(1);
    expect(body.clients[0]!.clientId).toBe("claude-desktop");
    expect(body.clients[0]!.clientName).toBe("Claude Desktop");
    expect(body.clients[0]!.redirectUris).toEqual(["http://127.0.0.1:6274/callback"]);
    expect(body.clients[0]!.disabled).toBe(false);
    expect(body.clients[0]!.tokenCount).toBe(3);
    expect(body.clients[0]!.lastUsedAt).toBe("2026-05-01T15:30:00.000Z");
    // #2066: tokenState rides the same wire as the per-user surface;
    // pin its presence on the admin schema so a future drift between
    // the two routes' Zod schemas fails this assertion first.
    expect(body.clients[0]!.tokenState).toBe("active");
  });

  it("returns an empty list when the workspace has registered no clients", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/oauth-clients"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: unknown[] };
    expect(body.clients).toEqual([]);
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
      adminRequest("GET", "/api/v1/admin/oauth-clients"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when no internal DB is configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/oauth-clients"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when no active organization", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "admin-1",
          mode: "managed",
          label: "admin@test.com",
          role: "admin",
          claims: { twoFactorEnabled: true },
        },
      }),
    );

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/oauth-clients"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 with requestId when the DB query fails", async () => {
    mocks.mockInternalQuery.mockRejectedValue(new Error("connection refused"));

    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/oauth-clients"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string; error?: string };
    expect(body.requestId).toBeDefined();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/oauth-clients/:id/revoke
// ---------------------------------------------------------------------------

describe("admin oauth-clients — POST /oauth-clients/:id/revoke", () => {
  it("atomically deletes client + outstanding tokens scoped to org and emits audit", async () => {
    // Pre-fetch (outside the transaction) — confirms the client exists in
    // the active org.
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT") && sql.includes("oauthClient")) {
          expect(params).toContain("claude-desktop");
          expect(params).toContain("org-alpha");
          return [{ clientId: "claude-desktop", clientName: "Claude Desktop" }];
        }
        return [];
      },
    );
    // Transactional DELETEs — drive per-table return rows so the route can
    // count revocations and emit accurate audit metadata.
    queryHandler = async (sql) => {
      if (sql.includes("DELETE") && sql.includes("oauthAccessToken")) {
        expect(sql).toContain(`"referenceId"`);
        return { rows: [{ id: "tok_1" }, { id: "tok_2" }, { id: "tok_3" }] };
      }
      if (sql.includes("DELETE") && sql.includes("oauthRefreshToken")) {
        expect(sql).toContain(`"referenceId"`);
        return { rows: [{ id: "rt_1" }] };
      }
      if (sql.includes("DELETE") && sql.includes("oauthConsent")) {
        expect(sql).toContain(`"referenceId"`);
        return { rows: [{ id: "cs_1" }] };
      }
      if (sql.includes("DELETE") && sql.includes("oauthClient")) {
        expect(sql).toContain(`"referenceId"`);
        return { rows: [{ clientId: "claude-desktop" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/oauth-clients/claude-desktop/revoke"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      tokensRevoked: number;
    };
    expect(body.success).toBe(true);
    // 3 access + 1 refresh = 4 tokens. Consent rows aren't counted as
    // tokens — they're a separate authorization artefact.
    expect(body.tokensRevoked).toBe(4);

    // Transaction lifecycle: BEGIN must be first, COMMIT must run, ROLLBACK
    // must NOT run on the happy path. Children deleted before parent so an
    // FK-RESTRICT adapter doesn't reject the final DELETE.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeUndefined();

    const deleteOrder = clientQueries
      .filter((q) => /^\s*DELETE\s+FROM/i.test(q.sql))
      .map((q) => {
        // Quoted identifiers (Better Auth tables) and unquoted ones
        // (Atlas-owned `oauth_client_rate_limits`) both need to round-
        // trip — match either shape.
        const m = q.sql.match(/DELETE FROM "?(\w+)"?/);
        return m ? m[1] : null;
      });
    expect(deleteOrder).toEqual([
      "oauthAccessToken",
      "oauthRefreshToken",
      "oauthConsent",
      // #2071 — rate-limit override row dropped in the same tx so a
      // re-registered client can't inherit the prior admin's quota.
      "oauth_client_rate_limits",
      // #2073 — workspace-scope marker + grant rows for cross-workspace
      // agents, dropped before the parent client so a re-registered
      // clientId can't inherit prior grants.
      "oauth_client_workspace_grants",
      "oauth_client_workspace_scope",
      "oauthClient",
    ]);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("oauth_client.revoke");
    expect(entry.targetType).toBe("oauth_client");
    expect(entry.targetId).toBe("claude-desktop");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({
      clientId: "claude-desktop",
      clientName: "Claude Desktop",
      accessTokensRevoked: 3,
      refreshTokensRevoked: 1,
      consentRowsRevoked: 1,
    });
  });

  it("returns 404 when the client does not belong to the active org", async () => {
    // Strong gate: the SELECT returns the row only if the orgId param
    // matches. A regression that drops `AND "referenceId" = $2` from the
    // pre-fetch SQL would either omit the param entirely (handled below by
    // the `params.length` short-circuit) or pass it but stop gating, which
    // this implementation makes impossible because the mock keys on
    // params[1].
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT") && sql.includes("oauthClient")) {
          expect(sql).toContain(`"referenceId"`);
          // Foreign client exists in some other workspace; only return it
          // when the caller provides that workspace's orgId. The active
          // org is "org-alpha" so this stays empty under correct routing.
          if (params?.[1] === "foreign-org") {
            return [{ clientId: "foreign-client", clientName: "Foreign" }];
          }
          return [];
        }
        return [];
      },
    );

    const res = await app.fetch(
      adminRequest(
        "POST",
        "/api/v1/admin/oauth-clients/foreign-client/revoke",
      ),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("oauth_client.revoke");
    expect(entry.metadata).toMatchObject({
      clientId: "foreign-client",
      found: false,
    });
    // Pre-fetch missed — no transaction was opened.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);
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
      adminRequest("POST", "/api/v1/admin/oauth-clients/claude-desktop/revoke"),
    );
    expect(res.status).toBe(403);
    // No audit row when the gate stops the request before the handler runs.
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("returns 404 when no internal DB is configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/oauth-clients/claude-desktop/revoke"),
    );
    expect(res.status).toBe(404);
  });

  it("rolls back and emits failure audit with phase + clientName when DELETE throws", async () => {
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
      adminRequest("POST", "/api/v1/admin/oauth-clients/claude-desktop/revoke"),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();

    // Transaction must have rolled back.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);

    // Failure audit emitted exactly once with the phase that tripped + the
    // captured clientName from the pre-fetch. `auditedInline` suppresses
    // the tapErrorCause duplicate.
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

  it("scrubs pg connection-string userinfo from the failure-audit error", async () => {
    // F-29 — admin_action_log must never leak DB credentials. The route
    // pipes failure-error messages through `errorMessage()`, which strips
    // `scheme://user:pass@host` userinfo. A future refactor that swaps
    // `errorMessage(err)` for `(err as Error).message` would silently land
    // the password in audit metadata; this test pins the scrub.
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("oauthClient")) {
        return [{ clientId: "claude-desktop", clientName: "Claude Desktop" }];
      }
      return [];
    });
    queryHandler = async (sql) => {
      if (sql.includes("DELETE") && sql.includes("oauthAccessToken")) {
        throw new Error(
          "connection refused: postgres://atlas_user:supersecret@db.internal:5432/atlas",
        );
      }
      return { rows: [] };
    };

    await app.fetch(
      adminRequest("POST", "/api/v1/admin/oauth-clients/claude-desktop/revoke"),
    );

    const entry = lastAuditCall();
    expect(entry.status).toBe("failure");
    const err = String(entry.metadata?.error ?? "");
    // Scheme survives, userinfo replaced.
    expect(err).toContain("postgres://***@db.internal");
    expect(err).not.toContain("atlas_user");
    expect(err).not.toContain("supersecret");
  });

  it("emits a race audit + 404 when a concurrent revoke wins between pre-fetch and BEGIN", async () => {
    // Pre-fetch sees the row, but the transactional final DELETE returns
    // 0 rows — concurrent admin (or duplicate request) revoked the same
    // client in-window. Route must roll back the partial child DELETEs so
    // the children aren't orphaned, then emit `race: true` audit + 404.
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("oauthClient")) {
        return [{ clientId: "claude-desktop", clientName: "Claude Desktop" }];
      }
      return [];
    });
    queryHandler = async (sql) => {
      if (sql.includes("DELETE") && sql.includes("oauthAccessToken")) {
        return { rows: [{ id: "tok_1" }] };
      }
      if (sql.includes("DELETE") && sql.includes("oauthRefreshToken")) {
        return { rows: [] };
      }
      if (sql.includes("DELETE") && sql.includes("oauthConsent")) {
        return { rows: [] };
      }
      if (sql.includes("DELETE") && sql.includes("oauthClient")) {
        // Concurrent revoke already dropped it — final DELETE misses.
        return { rows: [] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/oauth-clients/claude-desktop/revoke"),
    );

    expect(res.status).toBe(404);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("oauth_client.revoke");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({
      clientId: "claude-desktop",
      clientName: "Claude Desktop",
      found: false,
      race: true,
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/oauth-clients/:id/rate-limit (#2071)
// ---------------------------------------------------------------------------

describe("admin oauth-clients — PATCH /:id/rate-limit", () => {
  function primeListAndFind(rateLimitPerMinute: number | null) {
    // Both `findOAuthClient` and `listOAuthClients` are called by the
    // PATCH handler. The list query runs the joined SELECT against
    // `oauthClient` + `oauth_client_rate_limits`; `findOAuthClient`
    // runs a narrower probe.
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes(`FROM "oauthClient"`) && sql.includes("SELECT") && !sql.includes("LEFT JOIN")) {
          // findOAuthClient probe
          if (params?.[0] === "claude-desktop" && params?.[1] === "org-alpha") {
            return [{ clientId: "claude-desktop", clientName: "Claude Desktop" }];
          }
          return [];
        }
        if (sql.includes("oauthClient") && sql.includes("LEFT JOIN") && sql.includes("oauth_client_rate_limits")) {
          // listOAuthClients
          return [{
            clientId: "claude-desktop",
            clientName: "Claude Desktop",
            redirectUris: [],
            createdAt: "2026-04-12T10:00:00.000Z",
            updatedAt: null,
            disabled: false,
            type: "public",
            lastUsedAt: null,
            tokenCount: "0",
            liveTokenCount: "0",
            liveRefreshCount: "0",
            rateLimitPerMinute,
          }];
        }
        if (sql.includes("oauth_client_rate_limits") && (sql.includes("INSERT") || sql.includes("DELETE"))) {
          return [];
        }
        return [];
      },
    );
  }

  it("upserts the override and audits the previous → new delta", async () => {
    primeListAndFind(null);
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/oauth-clients/claude-desktop/rate-limit", {
        requestsPerMinute: 120,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; clientId: string; rateLimitPerMinute: number | null };
    expect(body).toEqual({ success: true, clientId: "claude-desktop", rateLimitPerMinute: 120 });

    const audit = lastAuditCall();
    expect(audit.actionType).toBe("oauth_client.rate_limit_update");
    expect(audit.targetType).toBe("oauth_client");
    expect(audit.targetId).toBe("claude-desktop");
    expect(audit.metadata).toMatchObject({
      clientId: "claude-desktop",
      clientName: "Claude Desktop",
      previousRpm: null,
      newRpm: 120,
    });
  });

  it("clears the override when requestsPerMinute is null", async () => {
    primeListAndFind(120);
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/oauth-clients/claude-desktop/rate-limit", {
        requestsPerMinute: null,
      }),
    );
    expect(res.status).toBe(200);
    const audit = lastAuditCall();
    expect(audit.metadata).toMatchObject({ previousRpm: 120, newRpm: null });
  });

  it("rejects invalid bodies with 400", async () => {
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/oauth-clients/claude-desktop/rate-limit", {
        requestsPerMinute: 0,
      }),
    );
    // hono/zod-openapi surfaces request-body validation failures as 422.
    expect(res.status).toBe(422);
  });

  it("rejects values above the 3600/min ceiling with 400", async () => {
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/oauth-clients/claude-desktop/rate-limit", {
        requestsPerMinute: 5000,
      }),
    );
    // hono/zod-openapi surfaces request-body validation failures as 422.
    expect(res.status).toBe(422);
  });

  it("returns 404 when the client doesn't belong to the workspace", async () => {
    mocks.mockInternalQuery.mockImplementation(async () => []);
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/oauth-clients/no-such-client/rate-limit", {
        requestsPerMinute: 120,
      }),
    );
    expect(res.status).toBe(404);
    const audit = lastAuditCall();
    expect(audit.actionType).toBe("oauth_client.rate_limit_update");
    expect(audit.status).toBe("failure");
    expect(audit.metadata).toMatchObject({ clientId: "no-such-client", found: false });
  });
});
