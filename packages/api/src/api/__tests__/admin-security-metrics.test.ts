/**
 * Tests for /api/v1/admin/security/metrics — workspace MFA + trust-device telemetry.
 *
 * Three concerns:
 *   1. Aggregate bucketing — given seeded admins (none / TOTP-only / passkey-only
 *      / both / mixed), verify the SQL produces the expected counts.
 *   2. Authorization — non-admin role rejected, no active org rejected,
 *      missing internal DB returns 404.
 *   3. SQL hygiene — the query is workspace-scoped via `m."organizationId" = $1`.
 *
 * The aggregate tests don't run real SQL; they assert that the route maps the
 * seeded `MetricsRow` fields to the expected response shape so a column rename
 * regression surfaces here rather than at runtime.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// ── Auth mock ─────────────────────────────────────────────────────────────

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
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
let mockQueryHandler: (sql: string, params?: unknown[]) => Promise<unknown[]> = () =>
  Promise.resolve([]);
let lastSql = "";
let lastParams: unknown[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({ query: () => Promise.resolve({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: (sql: string, params: unknown[] = []) => {
    lastSql = sql;
    lastParams = params;
    return mockQueryHandler(sql, params);
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

const { adminSecurityMetrics } = await import("../routes/admin-security-metrics");

// ── Helpers ───────────────────────────────────────────────────────────────

function reset() {
  mockHasInternalDB = true;
  lastSql = "";
  lastParams = [];
  mockQueryHandler = () => Promise.resolve([]);
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
}

function get() {
  return adminSecurityMetrics.request("http://localhost/metrics", { method: "GET" });
}

interface MetricsRow {
  admin_count: number;
  mfa_enrolled: number;
  two_factor_only: number;
  passkey_only: number;
  both_factors: number;
  no_factors: number;
  active_trust_devices: number;
  trust_device_users: number;
}

function row(over: Partial<MetricsRow> = {}): MetricsRow {
  return {
    admin_count: 0,
    mfa_enrolled: 0,
    two_factor_only: 0,
    passkey_only: 0,
    both_factors: 0,
    no_factors: 0,
    active_trust_devices: 0,
    trust_device_users: 0,
    ...over,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("GET /api/v1/admin/security/metrics", () => {
  beforeEach(reset);

  it("returns zeros when workspace has no admins", async () => {
    mockQueryHandler = async () => [row()];

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, number>;
    expect(body.adminCount).toBe(0);
    expect(body.mfaEnrolled).toBe(0);
    expect(body.twoFactorOnly).toBe(0);
    expect(body.passkeyOnly).toBe(0);
    expect(body.bothFactors).toBe(0);
    expect(body.noFactors).toBe(0);
    expect(body.activeTrustDevices).toBe(0);
    expect(body.trustDeviceUsersInLast30Days).toBe(0);
  });

  it("maps the four enrollment buckets and trust-device counts", async () => {
    // Seeded shape: 7 admins — 1 with neither, 2 TOTP-only, 1 passkey-only,
    // 2 with both, 1 with neither (already counted). 5/7 enrolled. 4 active
    // trust grants spanning 3 distinct admins.
    mockQueryHandler = async () => [row({
      admin_count: 7,
      mfa_enrolled: 5,
      two_factor_only: 2,
      passkey_only: 1,
      both_factors: 2,
      no_factors: 2,
      active_trust_devices: 4,
      trust_device_users: 3,
    })];

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, number>;
    expect(body.adminCount).toBe(7);
    expect(body.mfaEnrolled).toBe(5);
    expect(body.twoFactorOnly).toBe(2);
    expect(body.passkeyOnly).toBe(1);
    expect(body.bothFactors).toBe(2);
    expect(body.noFactors).toBe(2);
    expect(body.activeTrustDevices).toBe(4);
    expect(body.trustDeviceUsersInLast30Days).toBe(3);
    // Bucket invariant — none + twoFactorOnly + passkeyOnly + bothFactors === adminCount.
    expect(body.noFactors + body.twoFactorOnly + body.passkeyOnly + body.bothFactors)
      .toBe(body.adminCount);
  });

  it("issues a single SELECT scoped to the active organization", async () => {
    mockQueryHandler = async () => [row()];

    await get();

    // Single SELECT, no DML, no statement chaining.
    const stripped = lastSql.replace(/\s+/g, " ").toUpperCase();
    expect(stripped).toContain("SELECT");
    expect(stripped).not.toContain("INSERT");
    expect(stripped).not.toContain("UPDATE");
    expect(stripped).not.toContain("DELETE");
    expect(stripped).not.toContain("DROP");
    expect(stripped.split(";").filter((s) => s.trim().length > 0)).toHaveLength(1);

    // Workspace scoping — both CTEs filter by $1 (the active org).
    expect(lastSql).toContain('m."organizationId" = $1');
    expect(lastParams).toEqual(["org-1"]);
  });

  it("filters trust-device rows to the trust-device cookie identifier prefix", async () => {
    mockQueryHandler = async () => [row()];
    await get();
    expect(lastSql).toContain("'trust-device-%'");
    expect(lastSql).toContain('"expiresAt" > NOW()');
  });

  it("scopes admin lookup to admin and owner roles", async () => {
    mockQueryHandler = async () => [row()];
    await get();
    expect(lastSql).toContain("m.role IN ('admin', 'owner')");
  });

  it("returns 404 when internal DB is not configured", async () => {
    mockHasInternalDB = false;
    const res = await get();
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_available");
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, status: 401, error: "Not signed in" }),
    );
    const res = await get();
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin (member) role", async () => {
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

  it("returns 400 when admin has no active organization", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "admin-1",
          mode: "managed",
          label: "admin@test.com",
          role: "admin",
          activeOrganizationId: undefined,
          claims: { twoFactorEnabled: true },
        },
      }),
    );
    const res = await get();
    expect(res.status).toBe(400);
  });

  it("returns 500 with requestId when the aggregate returns no row", async () => {
    mockQueryHandler = async () => [];
    const res = await get();
    expect(res.status).toBe(500);
    const body = await res.json() as { requestId: string; error: string };
    expect(body.requestId).toBeDefined();
    expect(body.error).toBe("internal_error");
  });

  it("returns 500 with requestId when the SQL query throws", async () => {
    mockQueryHandler = async () => { throw new Error("connection lost"); };
    const res = await get();
    expect(res.status).toBe(500);
    const body = await res.json() as { requestId: string };
    expect(body.requestId).toBeDefined();
  });
});
