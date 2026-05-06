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
 *   - C2 regression: aggregate trust-device counters use a `value IN (...)`
 *     subquery against `verification`, NOT a member×verification join,
 *     so a user admin in N workspaces with one cookie counts once.
 *   - I1 regression: missing aggregate row returns 500 (symmetric with
 *     the workspace endpoint), not silent zeros.
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

const ZERO_ROW = {
  admin_count: 0, mfa_enrolled: 0, two_factor_only: 0, passkey_only: 0,
  both_factors: 0, no_factors: 0, active_trust_devices: 0, active_trust_device_users: 0,
};

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
      active_trust_device_users: 4,
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
        active_trust_device_users: 2,
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
        active_trust_device_users: 2,
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
    expect(body.aggregate.activeTrustDeviceUsers).toBe(4);

    expect(body.workspaces).toHaveLength(2);
    expect(body.workspaces[0].workspaceId).toBe("org-1");
    expect(body.workspaces[0].workspaceName).toBe("Acme");
    expect(body.workspaces[0].workspaceSlug).toBe("acme");
    expect(body.workspaces[0].adminCount).toBe(6);
    expect(body.workspaces[1].workspaceSlug).toBeNull();
  });

  it("returns zeros when the platform has no admins", async () => {
    aggregateRows = [{ ...ZERO_ROW }];
    workspaceRows = [];

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as { aggregate: Record<string, number>; workspaces: unknown[] };
    expect(body.aggregate.adminCount).toBe(0);
    expect(body.workspaces).toEqual([]);
  });

  it("returns 500 with requestId when the aggregate row is missing (I1 regression)", async () => {
    // Aggregates always return a row in production. A missing row means
    // shape drift; the route MUST 500 rather than silently render zeros
    // — the workspace endpoint does the same, and the dashboard would
    // otherwise show "the entire SaaS has zero admins".
    aggregateRows = [];
    workspaceRows = [];

    const res = await get();
    expect(res.status).toBe(500);
    const body = await res.json() as { requestId: string; error: string };
    expect(body.requestId).toBeDefined();
    expect(body.error).toBe("internal_error");
  });

  it("issues read-only single-statement SELECTs only", async () => {
    aggregateRows = [{ ...ZERO_ROW }];
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
      expect(stripped.split(";").filter((s) => s.trim().length > 0)).toHaveLength(1);
    }
  });

  it("filters out suspended and soft-deleted workspaces in the aggregate query", async () => {
    aggregateRows = [{ ...ZERO_ROW }];
    workspaceRows = [];

    await get();

    const aggregateQuery = queries.find((q) => q.sql.includes("platform_admins"));
    expect(aggregateQuery).toBeDefined();
    expect(aggregateQuery!.sql).toContain("o.deleted_at IS NULL");
    expect(aggregateQuery!.sql).toContain("o.suspended_at IS NULL");
  });

  it("scopes both CTEs to admin/owner role", async () => {
    aggregateRows = [{ ...ZERO_ROW }];
    workspaceRows = [];

    await get();

    for (const q of queries) {
      expect(q.sql).toContain("m.role IN ('admin', 'owner')");
    }
  });

  it("counts aggregate trust grants WITHOUT joining member (C2 regression)", async () => {
    // The bug: previous query JOINed verification × member, so a single
    // trust cookie for a user who's admin in N workspaces was counted N
    // times. The fix uses `value IN (SELECT user_id FROM platform_admins)`
    // against the verification table directly.
    aggregateRows = [{ ...ZERO_ROW }];
    workspaceRows = [];

    await get();

    const aggregateQuery = queries.find((q) => q.sql.includes("platform_admins"));
    expect(aggregateQuery).toBeDefined();

    const trustGrantsCte = aggregateQuery!.sql.match(/trust_grants AS \(([\s\S]*?)\)\s*SELECT/)?.[1] ?? "";
    // Subquery against platform_admins, not a JOIN through member.
    expect(trustGrantsCte).toContain("v.value IN (SELECT user_id FROM platform_admins)");
    expect(trustGrantsCte).not.toMatch(/JOIN\s+member\s+m\s+ON\s+m\."userId"\s*=\s*v\.value/i);
  });

  it("dedupes platform_admins so a multi-org admin counts once in aggregate buckets", async () => {
    // Belt-and-braces for the same C2 class of bug — without DISTINCT on
    // the platform_admins CTE, a user admin in 3 workspaces shows up
    // three times in the bucket counts.
    aggregateRows = [{ ...ZERO_ROW }];
    workspaceRows = [];

    await get();

    const aggregateQuery = queries.find((q) => q.sql.includes("platform_admins"));
    expect(aggregateQuery).toBeDefined();
    expect(aggregateQuery!.sql).toContain("SELECT DISTINCT");
  });

  it("caps the per-workspace breakdown to bound payload size", async () => {
    aggregateRows = [{ ...ZERO_ROW }];
    workspaceRows = [];

    await get();

    const wsQuery = queries.find((q) => q.sql.includes("org_buckets"));
    expect(wsQuery).toBeDefined();
    expect(wsQuery!.sql).toContain("LIMIT");
    // One LIMIT param at the end.
    expect(wsQuery!.params[wsQuery!.params.length - 1]).toBe(1000);
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
