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
  it("returns the list filtered by the caller's active org", async () => {
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
      revokedAt: null,
    });
    // Encrypted column never appears in the wire shape.
    expect(body.tokens[0]).not.toHaveProperty("token_hash_encrypted");
    expect(body.tokens[0]).not.toHaveProperty("tokenHashEncrypted");
  });

  it("rejects non-admin callers with 403", async () => {
    mocks.setMember("org-alpha");
    const res = await req("GET", "/");
    expect(res.status).toBe(403);
  });
});

// ── POST / — create ───────────────────────────────────────────────

describe("POST /api/v1/admin/mcp-tokens", () => {
  it("mints a token, returns plaintext once, and emits a create audit row", async () => {
    routeSql((sql) => {
      // Only the INSERT is expected on this path.
      expect(sql).toContain("INSERT INTO mcp_tokens");
      return [];
    });

    const res = await req("POST", "/", { name: "Claude Desktop" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      summary: { id: string; prefix: string; name: string | null };
    };
    expect(body.token.startsWith("atl_mcp_")).toBe(true);
    expect(body.token.length).toBe(40);
    expect(body.summary.prefix.length).toBe(16);
    expect(body.summary.name).toBe("Claude Desktop");

    // Audit emission — exactly one row, mcp_token.create
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

  it("propagates 500 when audit emission fails (no silent token mint)", async () => {
    mockLogAdminActionAwait.mockImplementation(async () => {
      throw new Error("audit DB down");
    });
    routeSql(() => []);
    const res = await req("POST", "/", {});
    expect(res.status).toBe(500);
  });
});

// ── POST /{id}/revoke — revoke ────────────────────────────────────

describe("POST /api/v1/admin/mcp-tokens/{id}/revoke", () => {
  it("revokes an active token and emits a revoke audit row", async () => {
    const revokedAt = new Date("2026-05-01T12:00:00Z");
    routeSql((sql) => {
      if (sql.startsWith("WITH prior")) {
        return [{ revoked_at: revokedAt, prior_revoked_at: null }];
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
    expect(mockLogAdminActionAwait.mock.calls[0][0]).toMatchObject({
      actionType: "mcp_token.revoke",
      targetType: "mcp_token",
      targetId: "mcp_111",
    });
  });

  it("returns alreadyRevoked: true on idempotent re-revoke and does NOT emit a second audit row", async () => {
    const priorRevoked = new Date("2026-05-01T11:00:00Z");
    routeSql((sql) => {
      if (sql.startsWith("WITH prior")) return []; // UPDATE matched 0 rows
      if (sql.startsWith("SELECT revoked_at FROM mcp_tokens")) {
        return [{ revoked_at: priorRevoked }];
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
      if (sql.startsWith("WITH prior")) return [];
      if (sql.startsWith("SELECT revoked_at FROM mcp_tokens")) return [];
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
