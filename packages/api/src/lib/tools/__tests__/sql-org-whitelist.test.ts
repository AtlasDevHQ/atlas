/**
 * Tests for org-scoped table whitelist enforcement in validateSQL.
 *
 * Verifies that when activeOrganizationId is present in the request context,
 * SQL validation uses getOrgWhitelistedTables instead of getWhitelistedTables.
 * This is the security enforcement point for tenant isolation.
 *
 * Uses mock.module() — all named exports mocked.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// ---------------------------------------------------------------------------
// Mock request context to simulate org-scoped requests
// ---------------------------------------------------------------------------

let mockOrgId: string | undefined;

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () =>
    mockOrgId
      ? {
          requestId: "test-req",
          user: {
            id: "user-1",
            mode: "managed" as const,
            label: "test@test.com",
            activeOrganizationId: mockOrgId,
          },
        }
      : undefined,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// ---------------------------------------------------------------------------
// Mock semantic layer — org whitelist returns different tables than file-based
// ---------------------------------------------------------------------------

const orgTables = new Set(["org_orders", "org_users"]);
const fileTables = new Set(["file_orders", "file_users", "file_companies"]);

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => fileTables,
  getOrgWhitelistedTables: (_orgId: string) => orgTables,
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      list: () => ["default"],
      describe: () => [{ id: "default", dbType: "postgres" as const }],
      _reset: () => {},
    },
  }),
);

mock.module("@atlas/api/lib/auth/audit", () => ({
  logQueryAudit: () => {},
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
}));

mock.module("@atlas/api/lib/security", () => ({
  SENSITIVE_PATTERNS: [],
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  getSettingAuto: () => undefined,
  getSettingLive: async () => undefined,
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

const { validateSQL } = await import("../sql");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("org-scoped SQL whitelist enforcement", () => {
  beforeEach(() => {
    mockOrgId = undefined;
  });

  it("uses org whitelist when activeOrganizationId is present", () => {
    mockOrgId = "org-123";
    // org_orders is in the org whitelist
    const result = validateSQL("SELECT * FROM org_orders");
    expect(result.valid).toBe(true);
  });

  it("rejects tables not in org whitelist even if in file whitelist", () => {
    mockOrgId = "org-123";
    // file_companies is in file whitelist but NOT in org whitelist
    const result = validateSQL("SELECT * FROM file_companies");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("uses file whitelist when no orgId (self-hosted)", () => {
    mockOrgId = undefined;
    // file_companies is in the file whitelist
    const result = validateSQL("SELECT * FROM file_companies");
    expect(result.valid).toBe(true);
  });

  it("rejects tables not in file whitelist when no orgId", () => {
    mockOrgId = undefined;
    // org_orders is only in the org whitelist, not file
    const result = validateSQL("SELECT * FROM org_orders");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("org isolation: different orgs see different whitelists", () => {
    // This validates the code path — the mock returns the same set for any orgId,
    // but the important thing is that it calls getOrgWhitelistedTables, not getWhitelistedTables
    mockOrgId = "org-A";
    const resultA = validateSQL("SELECT * FROM org_users");
    expect(resultA.valid).toBe(true);

    mockOrgId = "org-B";
    const resultB = validateSQL("SELECT * FROM org_users");
    expect(resultB.valid).toBe(true);

    // File-only table rejected for both orgs
    mockOrgId = "org-A";
    const resultFile = validateSQL("SELECT * FROM file_companies");
    expect(resultFile.valid).toBe(false);
  });
});
