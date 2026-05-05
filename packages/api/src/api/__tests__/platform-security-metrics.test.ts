/**
 * Tests for /api/v1/platform/admin/security/metrics — cross-tenant MFA + trust-device.
 *
 * Covers:
 *   - Authz — workspace admin gets 403, platform_admin passes.
 *   - Aggregate shape — bucket counts produced by the platform query
 *     surface in the response body.
 *   - Per-workspace breakdown — workspace rows include identifying
 *     fields and bucket counts.
 *   - Read-only single-statement SELECTs.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// ── Auth mock ─────────────────────────────────────────────────────────────

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "platform-admin-1",
        mode: "managed",
        label: "platform@test.com",
        role: "platform_admin",
        activeOrganizationId: "org-test",
        claims: { twoFactorEnabled: true },
      },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "managed",
  resetAuthModeCache: () => {},
}));

// ── Internal DB mock ──────────────────────────────────────────────────────

let mockHasInternalDB = true;
const queries: Array<{ sql: string; params: unknown[] }> = [];
let aggregateRows: unknown[] = [];
let workspaceRows: unknown[] = [];
let nextErr: Error | null = null;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({ query: () => Promise.resolve({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (nextErr) throw nextErr;
    if (sql.includes("workspace_admins") || sql.includes("org_buckets")) {
      return workspaceRows;
    }
    return aggregateRows;
  },
  internalExecute: () => {},
  setWorkspaceRegion: mock(async () => {}),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

// ── Import sub-router directly ────────────────────────────────────────────

const { platformSecurityMetrics } = await import("../routes/platform-security-metrics");

// ── Helpers ───────────────────────────────────────────────────────────────

function reset() {
  mockHasInternalDB = true;
  queries.length = 0;
  aggregateRows = [];
  workspaceRows = [];
  nextErr = null;
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "platform-admin-1",
        mode: "managed",
        label: "platform@test.com",
        role: "platform_admin",
        activeOrganizationId: "org-test",
        claims: { twoFactorEnabled: true },
      },
    }),
  );
}

function get() {
  return platformSecurityMetrics.request("http://localhost/metrics", { method: "GET" });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("GET /api/v1/platform/admin/security/metrics", () => {
  beforeEach(reset);

  it("returns aggregate + per-workspace breakdown", async () => {
    aggregateRows = [{
      admin_count: 10,
      mfa_enrolled: 7,
      two_factor_only: 3,
      passkey_only: 1,
      both_factors: 3,
      no_factors: 3,
      active_trust_devices: 5,
      trust_device_users: 4,
    }];
    workspaceRows = [
      {
        workspace_id: "org-1",
        workspace_name: "Acme",
        workspace_slug: "acme",
        admin_count: 6,
        mfa_enrolled: 5,
        two_factor_only: 2,
        passkey_only: 1,
        both_factors: 2,
        no_factors: 1,
        active_trust_devices: 3,
        trust_device_users: 2,
      },
      {
        workspace_id: "org-2",
        workspace_name: "Beta",
        workspace_slug: null,
        admin_count: 4,
        mfa_enrolled: 2,
        two_factor_only: 1,
        passkey_only: 0,
        both_factors: 1,
        no_factors: 2,
        active_trust_devices: 2,
        trust_device_users: 2,
      },
    ];

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as {
      aggregate: Record<string, number>;
      workspaces: Array<Record<string, unknown>>;
    };

    expect(body.aggregate.adminCount).toBe(10);
    expect(body.aggregate.mfaEnrolled).toBe(7);
    expect(body.aggregate.activeTrustDevices).toBe(5);
    expect(body.aggregate.trustDeviceUsersInLast30Days).toBe(4);

    expect(body.workspaces).toHaveLength(2);
    expect(body.workspaces[0].workspaceId).toBe("org-1");
    expect(body.workspaces[0].workspaceName).toBe("Acme");
    expect(body.workspaces[0].workspaceSlug).toBe("acme");
    expect(body.workspaces[0].adminCount).toBe(6);
    expect(body.workspaces[1].workspaceSlug).toBeNull();
  });

  it("returns zeros when the platform has no admins", async () => {
    aggregateRows = [{
      admin_count: 0,
      mfa_enrolled: 0,
      two_factor_only: 0,
      passkey_only: 0,
      both_factors: 0,
      no_factors: 0,
      active_trust_devices: 0,
      trust_device_users: 0,
    }];
    workspaceRows = [];

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as { aggregate: Record<string, number>; workspaces: unknown[] };
    expect(body.aggregate.adminCount).toBe(0);
    expect(body.workspaces).toEqual([]);
  });

  it("returns 200 with zero aggregate when the row is missing", async () => {
    // Aggregates SHOULD always return a row; the route logs a warning
    // and degrades to zeros rather than 500ing.
    aggregateRows = [];
    workspaceRows = [];

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as { aggregate: Record<string, number> };
    expect(body.aggregate.adminCount).toBe(0);
  });

  it("issues read-only single-statement SELECTs only", async () => {
    aggregateRows = [{
      admin_count: 0, mfa_enrolled: 0, two_factor_only: 0, passkey_only: 0,
      both_factors: 0, no_factors: 0, active_trust_devices: 0, trust_device_users: 0,
    }];
    workspaceRows = [];

    await get();

    expect(queries.length).toBeGreaterThanOrEqual(1);
    for (const q of queries) {
      const stripped = q.sql.replace(/\s+/g, " ").toUpperCase();
      expect(stripped).toContain("SELECT");
      expect(stripped).not.toContain("INSERT ");
      expect(stripped).not.toContain("UPDATE ");
      expect(stripped).not.toContain("DELETE ");
      expect(stripped).not.toContain("DROP ");
      // No statement chaining.
      expect(stripped.split(";").filter((s) => s.trim().length > 0)).toHaveLength(1);
    }
  });

  it("filters out suspended and soft-deleted workspaces in the aggregate query", async () => {
    aggregateRows = [{
      admin_count: 0, mfa_enrolled: 0, two_factor_only: 0, passkey_only: 0,
      both_factors: 0, no_factors: 0, active_trust_devices: 0, trust_device_users: 0,
    }];
    workspaceRows = [];

    await get();

    const aggregateQuery = queries.find((q) => q.sql.includes("platform_admins"));
    expect(aggregateQuery).toBeDefined();
    expect(aggregateQuery!.sql).toContain("o.deleted_at IS NULL");
    expect(aggregateQuery!.sql).toContain("o.suspended_at IS NULL");
  });

  it("returns 403 for workspace-admin (non-platform) role", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "admin-1",
          mode: "managed",
          label: "admin@test.com",
          role: "admin",
          activeOrganizationId: "org-1",
          claims: { twoFactorEnabled: true },
        },
      }),
    );
    const res = await get();
    expect(res.status).toBe(403);
  });

  it("returns 403 for member role", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "user@test.com",
          role: "member",
          activeOrganizationId: "org-1",
          claims: { twoFactorEnabled: true },
        },
      }),
    );
    const res = await get();
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, status: 401, error: "Not signed in" }),
    );
    const res = await get();
    expect(res.status).toBe(401);
  });

  it("returns 404 when internal DB is unavailable", async () => {
    mockHasInternalDB = false;
    const res = await get();
    expect(res.status).toBe(404);
  });

  it("returns 500 with requestId when SQL throws", async () => {
    nextErr = new Error("network failure");
    const res = await get();
    expect(res.status).toBe(500);
    const body = await res.json() as { requestId: string };
    expect(body.requestId).toBeDefined();
  });
});
