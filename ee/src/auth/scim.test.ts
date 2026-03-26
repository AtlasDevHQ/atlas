import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ───────────────────────────────────────────────────────────

const ee = createEEMock();

mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);
mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

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
  ee.reset();
  _resetTableEnsured();
}

const ORG_ID = "org-test-123";

// ── Tests ───────────────────────────────────────────────────────────

describe("SCIM enterprise gate", () => {
  beforeEach(resetMocks);

  it("listConnections throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(listConnections(ORG_ID)).rejects.toThrow("Enterprise features (scim) are not enabled.");
  });

  it("listGroupMappings throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(listGroupMappings(ORG_ID)).rejects.toThrow("Enterprise features (scim) are not enabled.");
  });

  it("deleteConnection throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(deleteConnection(ORG_ID, "conn-1")).rejects.toThrow("Enterprise features (scim) are not enabled.");
  });

  it("getSyncStatus throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(getSyncStatus(ORG_ID)).rejects.toThrow("Enterprise features (scim) are not enabled.");
  });

  it("createGroupMapping throws when no license key", async () => {
    ee.setEnterpriseLicenseKey(undefined);
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

  it("accepts exactly 255 characters", () => {
    expect(isValidScimGroupName("A" + "b".repeat(254))).toBe(true);
  });

  it("rejects invalid group names", () => {
    expect(isValidScimGroupName("")).toBe(false);
    expect(isValidScimGroupName(" leading-space")).toBe(false);
    expect(isValidScimGroupName("a".repeat(256))).toBe(false);
    expect(isValidScimGroupName("_underscore-start")).toBe(false);
    expect(isValidScimGroupName(".dot-start")).toBe(false);
    expect(isValidScimGroupName("-hyphen-start")).toBe(false);
  });

  it("rejects special characters outside allowed set", () => {
    expect(isValidScimGroupName("Engineers/Team-1")).toBe(false);
    expect(isValidScimGroupName("Team@Corp")).toBe(false);
    expect(isValidScimGroupName("Group#1")).toBe(false);
    expect(isValidScimGroupName("Name!")).toBe(false);
  });
});

describe("listConnections", () => {
  beforeEach(resetMocks);

  it("returns empty array when no connections", async () => {
    ee.queueMockRows([]); // empty result
    const result = await listConnections(ORG_ID);
    expect(result).toEqual([]);
  });

  it("returns connections for org", async () => {
    ee.queueMockRows([
      {
        id: "conn-1",
        providerId: "okta-prod",
        organizationId: ORG_ID,
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
    ee.queueMockRows([{ id: "conn-1" }]); // pool.query RETURNING
    const result = await deleteConnection(ORG_ID, "conn-1");
    expect(result).toBe(true);
  });

  it("returns false when connection not found", async () => {
    ee.queueMockRows([]); // no match
    const result = await deleteConnection(ORG_ID, "nonexistent");
    expect(result).toBe(false);
  });
});

describe("getSyncStatus", () => {
  beforeEach(resetMocks);

  it("returns zero counts when no data", async () => {
    ee.queueMockRows([{ count: "0" }]); // connections count
    ee.queueMockRows([{ count: "0" }]); // user count
    ee.queueMockRows([{ last_sync: null }]); // last sync
    const status = await getSyncStatus(ORG_ID);
    expect(status.connections).toBe(0);
    expect(status.provisionedUsers).toBe(0);
    expect(status.lastSyncAt).toBeNull();
  });

  it("returns correct counts", async () => {
    ee.queueMockRows([{ count: "2" }]);
    ee.queueMockRows([{ count: "15" }]);
    ee.queueMockRows([{ last_sync: "2026-03-22T10:00:00Z" }]);
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
      ee.queueMockRows([]); // ensureGroupMappingsTable CREATE TABLE
      ee.queueMockRows([]); // query result
      const result = await listGroupMappings(ORG_ID);
      expect(result).toEqual([]);
    });

    it("returns mappings for org", async () => {
      ee.queueMockRows([]); // ensureGroupMappingsTable
      ee.queueMockRows([
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
      ee.queueMockRows([]); // ensureGroupMappingsTable
      ee.queueMockRows([{ id: "role-1" }]); // role exists check
      ee.queueMockRows([]); // duplicate check
      ee.queueMockRows([
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
      ee.queueMockRows([]); // ensureGroupMappingsTable
      await expect(createGroupMapping(ORG_ID, "", "analyst")).rejects.toThrow(SCIMError);
    });

    it("throws when role does not exist", async () => {
      ee.queueMockRows([]); // ensureGroupMappingsTable
      ee.queueMockRows([]); // role not found
      await expect(createGroupMapping(ORG_ID, "Engineers", "nonexistent")).rejects.toThrow(
        'Role "nonexistent" does not exist',
      );
    });

    it("throws on duplicate mapping", async () => {
      ee.queueMockRows([]); // ensureGroupMappingsTable
      ee.queueMockRows([{ id: "role-1" }]); // role exists
      ee.queueMockRows([{ id: "existing-map" }]); // duplicate found
      await expect(createGroupMapping(ORG_ID, "Engineers", "analyst")).rejects.toThrow("already exists");
    });
  });

  describe("deleteGroupMapping", () => {
    it("returns true on success", async () => {
      ee.queueMockRows([]); // ensureGroupMappingsTable
      ee.queueMockRows([{ id: "map-1" }]); // pool.query RETURNING
      const result = await deleteGroupMapping(ORG_ID, "map-1");
      expect(result).toBe(true);
    });

    it("returns false when not found", async () => {
      ee.queueMockRows([]); // ensureGroupMappingsTable
      ee.queueMockRows([]); // no match
      const result = await deleteGroupMapping(ORG_ID, "nonexistent");
      expect(result).toBe(false);
    });
  });
});

describe("resolveGroupToRole", () => {
  beforeEach(resetMocks);

  it("returns role name when mapping exists", async () => {
    ee.queueMockRows([]); // ensureGroupMappingsTable
    ee.queueMockRows([{ role_name: "analyst" }]);
    const result = await resolveGroupToRole(ORG_ID, "Engineers");
    expect(result).toBe("analyst");
  });

  it("returns null when no mapping", async () => {
    ee.queueMockRows([]); // ensureGroupMappingsTable
    ee.queueMockRows([]); // no match
    const result = await resolveGroupToRole(ORG_ID, "Unknown Group");
    expect(result).toBeNull();
  });

  it("does not require enterprise gate (skips requireEnterprise)", async () => {
    ee.setEnterpriseEnabled(false); // would throw if requireEnterprise were called
    ee.queueMockRows([]); // ensureGroupMappingsTable
    ee.queueMockRows([{ role_name: "analyst" }]);
    const result = await resolveGroupToRole(ORG_ID, "Engineers");
    expect(result).toBe("analyst");
  });
});

describe("SCIMError codes", () => {
  beforeEach(resetMocks);

  it("throws validation code for invalid group name", async () => {
    ee.queueMockRows([]); // ensureGroupMappingsTable
    try {
      await createGroupMapping(ORG_ID, "", "analyst");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(SCIMError);
      expect((err as InstanceType<typeof SCIMError>).code).toBe("validation");
    }
  });

  it("throws not_found code for missing role", async () => {
    ee.queueMockRows([]); // ensureGroupMappingsTable
    ee.queueMockRows([]); // role not found
    try {
      await createGroupMapping(ORG_ID, "Engineers", "nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SCIMError);
      expect((err as InstanceType<typeof SCIMError>).code).toBe("not_found");
    }
  });

  it("throws conflict code for duplicate mapping", async () => {
    ee.queueMockRows([]); // ensureGroupMappingsTable
    ee.queueMockRows([{ id: "role-1" }]); // role exists
    ee.queueMockRows([{ id: "existing-map" }]); // duplicate found
    try {
      await createGroupMapping(ORG_ID, "Engineers", "analyst");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SCIMError);
      expect((err as InstanceType<typeof SCIMError>).code).toBe("conflict");
    }
  });
});
