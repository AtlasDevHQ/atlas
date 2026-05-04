/**
 * Route-layer tests for the admin MCP-tokens CRUD surface (#2024).
 *
 * Covers:
 *   - GET    /api/v1/admin/mcp-tokens              — list + workspace filter
 *   - POST   /api/v1/admin/mcp-tokens              — create + audit emission
 *   - POST   /api/v1/admin/mcp-tokens/:id/revoke   — revoke + audit emission +
 *                                                    immediate-revocation invariant
 *
 * Auth gating (admin role) is exercised once at the surface level — the
 * deep auth-gate scenarios live in admin-roles.test.ts and don't need
 * to be re-tested per route.
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
import { ADMIN_ACTIONS as REAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";

// ── Unified mocks ──────────────────────────────────────────────────

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
});

// ── Audit mock ─────────────────────────────────────────────────────

const mockLogAdminActionAwait: Mock<(entry: Record<string, unknown>) => Promise<void>> =
  mock(async () => {});

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mock(() => {}),
  logAdminActionAwait: mockLogAdminActionAwait,
  ADMIN_ACTIONS: REAL_ADMIN_ACTIONS,
}));

// ── Import app AFTER mocks ─────────────────────────────────────────

const { app } = await import("../index");

// ── Helpers ────────────────────────────────────────────────────────

function req(method: string, urlPath: string, body?: unknown) {
  const url = `http://localhost/api/v1/admin/mcp-tokens${urlPath}`;
  const init: RequestInit = {
    method,
    headers: { Authorization: "Bearer test" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}

// Minimal SQL-fragment matcher. `internalQuery` receives the raw
// statement, so we route by substring rather than exact-match (which
// would couple the test to whitespace formatting in the source).
function routeSql(
  resolver: (sql: string, params: unknown[]) => unknown[],
): void {
  mocks.mockInternalQuery.mockImplementation(
    async (sql: string, params?: unknown[]) =>
      resolver(sql, params ?? []),
  );
}

afterAll(() => {
  mocks.cleanup();
});

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setOrgAdmin("org-alpha");
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mockLogAdminActionAwait.mockReset();
  mockLogAdminActionAwait.mockImplementation(async () => {});
});

// ── GET / — list ──────────────────────────────────────────────────

describe("GET /api/v1/admin/mcp-tokens", () => {
  it("returns the list filtered by the caller's active org, with derived status", async () => {
    const now = new Date("2026-05-01T00:00:00Z");
    routeSql((sql, params) => {
      expect(sql).toContain("FROM mcp_tokens");
      expect(sql).toContain("WHERE org_id = $1");
      expect(params[0]).toBe("org-alpha");
      return [
        {
          id: "mcp_111",
          org_id: "org-alpha",
          user_id: "admin-1",
          name: "Claude Desktop",
          token_prefix: "atl_mcp_aaaaaaaa",
          token_hash_encrypted: "ignored",
          token_hash_key_version: 1,
          scopes: [],
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
          created_at: now,
          created_by_user_id: "admin-1",
        },
      ];
    });

    const res = await req("GET", "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokens: Array<Record<string, unknown>>;
    };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toMatchObject({
      id: "mcp_111",
      name: "Claude Desktop",
      prefix: "atl_mcp_aaaaaaaa",
      status: "active",
      revokedAt: null,
    });
    // Encrypted column never appears in the wire shape.
    expect(body.tokens[0]).not.toHaveProperty("token_hash_encrypted");
    expect(body.tokens[0]).not.toHaveProperty("tokenHashEncrypted");
  });

  it("surfaces status: 'revoked' for tombstoned rows", async () => {
    routeSql(() => [
      {
        id: "mcp_999",
        org_id: "org-alpha",
        user_id: "admin-1",
        name: null,
        token_prefix: "atl_mcp_zzzzzzzz",
        token_hash_encrypted: "ignored",
        token_hash_key_version: 1,
        scopes: [],
        last_used_at: null,
        expires_at: null,
        revoked_at: new Date("2026-04-30T00:00:00Z"),
        created_at: new Date("2026-04-01T00:00:00Z"),
        created_by_user_id: "admin-1",
      },
    ]);
    const res = await req("GET", "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<{ status: string }> };
    expect(body.tokens[0].status).toBe("revoked");
  });

  it("rejects non-admin callers with 403", async () => {
    mocks.setMember("org-alpha");
    const res = await req("GET", "/");
    expect(res.status).toBe(403);
  });
});

// ── POST / — create ───────────────────────────────────────────────

describe("POST /api/v1/admin/mcp-tokens", () => {
  it("mints a token, returns plaintext + status:active once, and emits a create audit row", async () => {
    routeSql((sql) => {
      expect(sql).toContain("INSERT INTO mcp_tokens");
      return [];
    });

    const res = await req("POST", "/", { name: "Claude Desktop" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      summary: {
        id: string;
        prefix: string;
        name: string | null;
        status: string;
      };
    };
    expect(body.token.startsWith("atl_mcp_")).toBe(true);
    expect(body.token.length).toBe(40);
    expect(body.summary.prefix.length).toBe(16);
    expect(body.summary.name).toBe("Claude Desktop");
    expect(body.summary.status).toBe("active");

    expect(mockLogAdminActionAwait).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminActionAwait.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "mcp_token.create",
      targetType: "mcp_token",
      targetId: body.summary.id,
    });
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.name).toBe("Claude Desktop");
    expect(meta.prefix).toBe(body.summary.prefix);
    expect(meta.hasExpiry).toBe(false);
  });

  it("validates body — rejects expiresInDays > 365 with 422 (OpenAPI validation hook)", async () => {
    const res = await req("POST", "/", { expiresInDays: 1000 });
    expect(res.status).toBe(422);
    expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
  });

  it("propagates 500 AND deletes the orphan row when audit emission fails", async () => {
    // The fix for the audit-failure-leaves-an-orphan-bearer issue:
    // when the mint succeeds but the audit row can't be written, the
    // route must DELETE the freshly-inserted token row before
    // propagating 500. Otherwise the hash is live in the DB with no
    // forensic record and no client copy of the plaintext — the
    // exact silent-mint scenario this test guards against.
    mockLogAdminActionAwait.mockImplementation(async () => {
      throw new Error("audit DB down");
    });
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params: params ?? [] });
        return [];
      },
    );

    const res = await req("POST", "/", {});
    expect(res.status).toBe(500);

    const insert = captured.find((c) =>
      c.sql.includes("INSERT INTO mcp_tokens"),
    );
    expect(insert).toBeDefined();
    const cleanup = captured.find((c) =>
      c.sql.includes("DELETE FROM mcp_tokens"),
    );
    expect(cleanup).toBeDefined();
    // Cleanup must scope on org so a misbehaving handler can't blow
    // away an arbitrary id.
    expect(cleanup?.params[1]).toBe("org-alpha");
  });
});

// ── POST /{id}/revoke — revoke ────────────────────────────────────

describe("POST /api/v1/admin/mcp-tokens/{id}/revoke", () => {
  it("revokes an active token and emits a revoke audit row carrying prefix + name", async () => {
    routeSql((sql) => {
      if (sql.startsWith("UPDATE mcp_tokens")) {
        return [{ token_prefix: "atl_mcp_abcdef12", name: "Claude Desktop" }];
      }
      return [];
    });

    const res = await req("POST", "/mcp_111/revoke");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      alreadyRevoked: boolean;
      revokedAt: string;
    };
    expect(body.id).toBe("mcp_111");
    expect(body.alreadyRevoked).toBe(false);

    expect(mockLogAdminActionAwait).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminActionAwait.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "mcp_token.revoke",
      targetType: "mcp_token",
      targetId: "mcp_111",
    });
    // The audit metadata MUST carry prefix + name. Forensic queries
    // pivot on prefix; without it, a retention-purged source row
    // turns the audit log into a dead-end.
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.prefix).toBe("atl_mcp_abcdef12");
    expect(meta.name).toBe("Claude Desktop");
  });

  it("returns alreadyRevoked: true on idempotent re-revoke and does NOT emit a second audit row", async () => {
    const priorRevoked = new Date("2026-05-01T11:00:00Z");
    routeSql((sql) => {
      if (sql.startsWith("UPDATE mcp_tokens")) return []; // UPDATE matched 0 rows
      if (sql.includes("SELECT revoked_at, token_prefix, name")) {
        return [
          {
            revoked_at: priorRevoked,
            token_prefix: "atl_mcp_abcdef12",
            name: "Claude Desktop",
          },
        ];
      }
      return [];
    });

    const res = await req("POST", "/mcp_111/revoke");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyRevoked: boolean };
    expect(body.alreadyRevoked).toBe(true);
    // The audit trail must reflect *when the token was actually
    // revoked* — re-clicking the button doesn't emit a duplicate
    // row.
    expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
  });

  it("returns 404 when the token doesn't exist in this workspace (cross-org isolation)", async () => {
    routeSql((sql) => {
      if (sql.startsWith("UPDATE mcp_tokens")) return [];
      if (sql.includes("SELECT revoked_at, token_prefix, name")) return [];
      return [];
    });

    const res = await req("POST", "/mcp_999/revoke");
    expect(res.status).toBe(404);
    expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers with 403", async () => {
    mocks.setMember("org-alpha");
    const res = await req("POST", "/mcp_111/revoke");
    expect(res.status).toBe(403);
  });
});
