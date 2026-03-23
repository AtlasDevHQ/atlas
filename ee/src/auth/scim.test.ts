import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mocks ───────────────────────────────────────────────────────────

let mockEnterpriseEnabled = false;
let mockEnterpriseLicenseKey: string | undefined = "test-key";

mock.module("../index", () => ({
  isEnterpriseEnabled: () => mockEnterpriseEnabled,
  getEnterpriseLicenseKey: () => mockEnterpriseLicenseKey,
  requireEnterprise: (feature?: string) => {
    const label = feature ? ` (${feature})` : "";
    if (!mockEnterpriseEnabled) {
      throw new Error(`Enterprise features${label} are not enabled.`);
    }
    if (!mockEnterpriseLicenseKey) {
      throw new Error(`Enterprise features${label} are enabled but no license key is configured.`);
    }
  },
}));

// Mock internal DB
const mockRows: Record<string, unknown>[][] = [];
let queryCallCount = 0;
const capturedQueries: { sql: string; params: unknown[] }[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({
    query: async (sql: string, params?: unknown[]) => {
      capturedQueries.push({ sql, params: params ?? [] });
      const rows = mockRows[queryCallCount] ?? [];
      queryCallCount++;
      return { rows };
    },
    end: async () => {},
    on: () => {},
  }),
  internalQuery: async (sql: string, params?: unknown[]) => {
    capturedQueries.push({ sql, params: params ?? [] });
    const rows = mockRows[queryCallCount] ?? [];
    queryCallCount++;
    return rows;
  },
  internalExecute: () => {},
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import after mocks
const {
  listConnections,
  deleteConnection,
  getSyncStatus,
  listGroupMappings,
  createGroupMapping,
  deleteGroupMapping,
  resolveGroupToRole,
  isValidScimGroupName,
  SCIMError,
  _resetTableEnsured,
} = await import("./scim");

// ── Helpers ─────────────────────────────────────────────────────────

function resetMocks() {
  mockRows.length = 0;
  queryCallCount = 0;
  capturedQueries.length = 0;
  mockEnterpriseEnabled = true;
  mockEnterpriseLicenseKey = "test-key";
  _resetTableEnsured();
}

const ORG_ID = "org-test-123";

// ── Tests ───────────────────────────────────────────────────────────

describe("SCIM enterprise gate", () => {
  beforeEach(resetMocks);

  it("listConnections throws when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
    await expect(listConnections(ORG_ID)).rejects.toThrow("Enterprise features (scim) are not enabled.");
  });

  it("listGroupMappings throws when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
    await expect(listGroupMappings(ORG_ID)).rejects.toThrow("Enterprise features (scim) are not enabled.");
  });

  it("deleteConnection throws when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
    await expect(deleteConnection(ORG_ID, "conn-1")).rejects.toThrow("Enterprise features (scim) are not enabled.");
  });

  it("getSyncStatus throws when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
    await expect(getSyncStatus(ORG_ID)).rejects.toThrow("Enterprise features (scim) are not enabled.");
  });

  it("createGroupMapping throws when no license key", async () => {
    mockEnterpriseLicenseKey = undefined;
    await expect(createGroupMapping(ORG_ID, "Engineers", "analyst")).rejects.toThrow(
      "Enterprise features (scim) are enabled but no license key is configured.",
    );
  });
});

describe("isValidScimGroupName", () => {
  it("accepts valid group names", () => {
    expect(isValidScimGroupName("Engineers")).toBe(true);
    expect(isValidScimGroupName("Data Science Team")).toBe(true);
    expect(isValidScimGroupName("dev-ops_team.v2")).toBe(true);
    expect(isValidScimGroupName("A")).toBe(true);
  });

  it("rejects invalid group names", () => {
    expect(isValidScimGroupName("")).toBe(false);
    expect(isValidScimGroupName(" leading-space")).toBe(false);
    expect(isValidScimGroupName("a".repeat(256))).toBe(false);
  });
});

describe("listConnections", () => {
  beforeEach(resetMocks);

  it("returns empty array when no connections", async () => {
    mockRows.push([]); // empty result
    const result = await listConnections(ORG_ID);
    expect(result).toEqual([]);
  });

  it("returns connections for org", async () => {
    mockRows.push([
      {
        id: "conn-1",
        providerId: "okta-prod",
        organizationId: ORG_ID,
        createdAt: "2026-03-22T00:00:00Z",
      },
    ]);
    const result = await listConnections(ORG_ID);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("conn-1");
    expect(result[0].providerId).toBe("okta-prod");
  });
});

describe("deleteConnection", () => {
  beforeEach(resetMocks);

  it("returns true when connection deleted", async () => {
    mockRows.push([{ id: "conn-1" }]); // pool.query RETURNING
    const result = await deleteConnection(ORG_ID, "conn-1");
    expect(result).toBe(true);
  });

  it("returns false when connection not found", async () => {
    mockRows.push([]); // no match
    const result = await deleteConnection(ORG_ID, "nonexistent");
    expect(result).toBe(false);
  });
});

describe("getSyncStatus", () => {
  beforeEach(resetMocks);

  it("returns zero counts when no data", async () => {
    mockRows.push([{ count: "0" }]); // connections count
    mockRows.push([{ count: "0" }]); // user count
    mockRows.push([{ last_sync: null }]); // last sync
    const status = await getSyncStatus(ORG_ID);
    expect(status.connections).toBe(0);
    expect(status.provisionedUsers).toBe(0);
    expect(status.lastSyncAt).toBeNull();
  });

  it("returns correct counts", async () => {
    mockRows.push([{ count: "2" }]);
    mockRows.push([{ count: "15" }]);
    mockRows.push([{ last_sync: "2026-03-22T10:00:00Z" }]);
    const status = await getSyncStatus(ORG_ID);
    expect(status.connections).toBe(2);
    expect(status.provisionedUsers).toBe(15);
    expect(status.lastSyncAt).toBe("2026-03-22T10:00:00Z");
  });
});

describe("group mappings", () => {
  beforeEach(resetMocks);

  describe("listGroupMappings", () => {
    it("returns empty when no mappings", async () => {
      mockRows.push([]); // ensureGroupMappingsTable CREATE TABLE
      mockRows.push([]); // query result
      const result = await listGroupMappings(ORG_ID);
      expect(result).toEqual([]);
    });

    it("returns mappings for org", async () => {
      mockRows.push([]); // ensureGroupMappingsTable
      mockRows.push([
        {
          id: "map-1",
          org_id: ORG_ID,
          scim_group_name: "Engineers",
          role_name: "analyst",
          created_at: "2026-03-22T00:00:00Z",
        },
      ]);
      const result = await listGroupMappings(ORG_ID);
      expect(result).toHaveLength(1);
      expect(result[0].scimGroupName).toBe("Engineers");
      expect(result[0].roleName).toBe("analyst");
    });
  });

  describe("createGroupMapping", () => {
    it("creates a mapping successfully", async () => {
      mockRows.push([]); // ensureGroupMappingsTable
      mockRows.push([{ id: "role-1" }]); // role exists check
      mockRows.push([]); // duplicate check
      mockRows.push([
        {
          id: "map-new",
          org_id: ORG_ID,
          scim_group_name: "Engineers",
          role_name: "analyst",
          created_at: "2026-03-22T00:00:00Z",
        },
      ]); // INSERT RETURNING
      const result = await createGroupMapping(ORG_ID, "Engineers", "analyst");
      expect(result.id).toBe("map-new");
      expect(result.scimGroupName).toBe("Engineers");
      expect(result.roleName).toBe("analyst");
    });

    it("throws on invalid group name", async () => {
      mockRows.push([]); // ensureGroupMappingsTable
      await expect(createGroupMapping(ORG_ID, "", "analyst")).rejects.toThrow(SCIMError);
    });

    it("throws when role does not exist", async () => {
      mockRows.push([]); // ensureGroupMappingsTable
      mockRows.push([]); // role not found
      await expect(createGroupMapping(ORG_ID, "Engineers", "nonexistent")).rejects.toThrow(
        'Role "nonexistent" does not exist',
      );
    });

    it("throws on duplicate mapping", async () => {
      mockRows.push([]); // ensureGroupMappingsTable
      mockRows.push([{ id: "role-1" }]); // role exists
      mockRows.push([{ id: "existing-map" }]); // duplicate found
      await expect(createGroupMapping(ORG_ID, "Engineers", "analyst")).rejects.toThrow("already exists");
    });
  });

  describe("deleteGroupMapping", () => {
    it("returns true on success", async () => {
      mockRows.push([]); // ensureGroupMappingsTable
      mockRows.push([{ id: "map-1" }]); // pool.query RETURNING
      const result = await deleteGroupMapping(ORG_ID, "map-1");
      expect(result).toBe(true);
    });

    it("returns false when not found", async () => {
      mockRows.push([]); // ensureGroupMappingsTable
      mockRows.push([]); // no match
      const result = await deleteGroupMapping(ORG_ID, "nonexistent");
      expect(result).toBe(false);
    });
  });
});

describe("resolveGroupToRole", () => {
  beforeEach(resetMocks);

  it("returns role name when mapping exists", async () => {
    mockRows.push([]); // ensureGroupMappingsTable
    mockRows.push([{ role_name: "analyst" }]);
    const result = await resolveGroupToRole(ORG_ID, "Engineers");
    expect(result).toBe("analyst");
  });

  it("returns null when no mapping", async () => {
    mockRows.push([]); // ensureGroupMappingsTable
    mockRows.push([]); // no match
    const result = await resolveGroupToRole(ORG_ID, "Unknown Group");
    expect(result).toBeNull();
  });
});
