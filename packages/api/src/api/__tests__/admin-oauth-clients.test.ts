/**
 * Admin OAuth-clients route tests (#2024 — Settings → OAuth Clients).
 *
 * The hosted-MCP install path leaves a Dynamic Client Registration trail in
 * Better Auth's `oauthClient` table. Workspace admins need an inspection +
 * revocation surface; these tests pin the contract:
 *
 *   GET  /api/v1/admin/oauth-clients         → list rows scoped to the org
 *   POST /api/v1/admin/oauth-clients/:id/revoke
 *                                            → delete client + every
 *                                              outstanding access/refresh
 *                                              token + consent for that
 *                                              client, scoped to the org
 *
 * Tokens issued under workspace A must remain queryable from workspace A
 * only — `referenceId` ties every row back to the active org. The tests
 * verify the SQL parameterization actually carries the org filter so a
 * future regression that drops the WHERE clause fails loudly here, not in
 * production.
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

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

function adminRequest(method: string, path: string): Request {
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

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setOrgAdmin("org-alpha");
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockResolvedValue([]);
  mockLogAdminAction.mockClear();
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/oauth-clients
// ---------------------------------------------------------------------------

describe("admin oauth-clients — GET /oauth-clients", () => {
  it("lists clients scoped to the active org via referenceId", async () => {
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("oauthClient")) {
          // Pin the WHERE clause carries the org binding — a future regression
          // that drops it would silently leak every workspace's clients.
          expect(sql).toContain(`"referenceId"`);
          expect(params?.[0]).toBe("org-alpha");
          return [
            {
              clientId: "claude-desktop",
              clientName: "Claude Desktop",
              redirectUris: ["http://localhost:6274/callback"],
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
      }>;
    };
    expect(body.clients).toHaveLength(1);
    expect(body.clients[0]!.clientId).toBe("claude-desktop");
    expect(body.clients[0]!.clientName).toBe("Claude Desktop");
    expect(body.clients[0]!.redirectUris).toEqual(["http://localhost:6274/callback"]);
    expect(body.clients[0]!.disabled).toBe(false);
    expect(body.clients[0]!.tokenCount).toBe(3);
    expect(body.clients[0]!.lastUsedAt).toBe("2026-05-01T15:30:00.000Z");
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
  it("deletes client + outstanding tokens scoped to org and emits audit", async () => {
    const deletedTables: string[] = [];

    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        // Pre-fetch confirms the client exists in the active org. Without it
        // a missing client + a successful no-op DELETE would silently 200.
        if (sql.includes("SELECT") && sql.includes("oauthClient")) {
          expect(params).toContain("claude-desktop");
          expect(params).toContain("org-alpha");
          return [{ clientId: "claude-desktop", clientName: "Claude Desktop" }];
        }
        if (sql.includes("DELETE") && sql.includes("oauthAccessToken")) {
          deletedTables.push("oauthAccessToken");
          // Org filter must apply to tokens too — a missed referenceId here
          // would let an admin in workspace A revoke workspace B's tokens
          // for a client whose id collided.
          expect(sql).toContain(`"referenceId"`);
          expect(params).toContain("claude-desktop");
          expect(params).toContain("org-alpha");
          return [{ id: "tok_1" }, { id: "tok_2" }, { id: "tok_3" }];
        }
        if (sql.includes("DELETE") && sql.includes("oauthRefreshToken")) {
          deletedTables.push("oauthRefreshToken");
          expect(sql).toContain(`"referenceId"`);
          return [{ id: "rt_1" }];
        }
        if (sql.includes("DELETE") && sql.includes("oauthConsent")) {
          deletedTables.push("oauthConsent");
          expect(sql).toContain(`"referenceId"`);
          return [{ id: "cs_1" }];
        }
        if (sql.includes("DELETE") && sql.includes("oauthClient")) {
          deletedTables.push("oauthClient");
          expect(sql).toContain(`"referenceId"`);
          return [{ clientId: "claude-desktop" }];
        }
        return [];
      },
    );

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

    // Tokens must be deleted before the client to avoid FK contention.
    expect(deletedTables).toEqual([
      "oauthAccessToken",
      "oauthRefreshToken",
      "oauthConsent",
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
    // Pre-fetch must scope by referenceId. A bare `WHERE clientId = $1`
    // would let an admin probe / revoke clients in foreign workspaces.
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT") && sql.includes("oauthClient")) {
          expect(params).toContain("org-alpha");
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

  it("returns 500 with requestId on DB failure and emits failure audit", async () => {
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string) => {
        if (sql.includes("SELECT") && sql.includes("oauthClient")) {
          return [{ clientId: "claude-desktop", clientName: "Claude Desktop" }];
        }
        if (sql.includes("DELETE") && sql.includes("oauthAccessToken")) {
          throw new Error("pool timeout");
        }
        return [];
      },
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/oauth-clients/claude-desktop/revoke"),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();

    // Failure audit emits via tapErrorCause. Status is "failure" so forensic
    // queries can pivot on outcome without joining on response code.
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("oauth_client.revoke");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      clientId: "claude-desktop",
      error: "pool timeout",
    });
  });
});
