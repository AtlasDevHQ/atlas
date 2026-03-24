import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ───────────────────────────────────────────────────────────

const ee = createEEMock({
  internalDB: {
    getWorkspaceRegion: async (orgId: string) => {
      ee.capturedQueries.push({ sql: "getWorkspaceRegion", params: [orgId] });
      const rows = mockRows[queryCallCount] ?? [];
      queryCallCount++;
      return (rows[0] as Record<string, unknown> | undefined)?.region ?? null;
    },
    setWorkspaceRegion: async (orgId: string, region: string) => {
      ee.capturedQueries.push({ sql: "setWorkspaceRegion", params: [orgId, region] });
      const rows = mockRows[queryCallCount] ?? [];
      queryCallCount++;
      if (rows.length > 0) {
        const row = rows[0] as Record<string, unknown>;
        if (row.assigned === false) {
          return { assigned: false, existing: row.existing as string | undefined };
        }
      }
      return { assigned: true };
    },
  },
});

// Extra state for the custom overrides above
const mockRows: Record<string, unknown>[][] = [];
let queryCallCount = 0;

mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);

let mockConfig: Record<string, unknown> | null = null;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
  defineConfig: (c: unknown) => c,
}));

mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

// Import after mocks
const {
  listRegions,
  getDefaultRegion,
  getConfiguredRegions,
  assignWorkspaceRegion,
  getWorkspaceRegionAssignment,
  resolveRegionDatabaseUrl,
  listWorkspaceRegions,
  isConfiguredRegion,
  ResidencyError,
} = await import("./residency");

// ── Helpers ─────────────────────────────────────────────────────────

function resetMocks() {
  ee.reset();
  mockRows.length = 0;
  queryCallCount = 0;
  mockConfig = {
    residency: {
      regions: {
        "us-east": { label: "US East", databaseUrl: "postgresql://us-east/atlas" },
        "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", datasourceUrl: "postgresql://eu-west/data" },
      },
      defaultRegion: "us-east",
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("residency", () => {
  beforeEach(resetMocks);

  describe("enterprise gating", () => {
    it("listRegions throws when enterprise is disabled", async () => {
      ee.setEnterpriseEnabled(false);
      await expect(listRegions()).rejects.toThrow("Enterprise features");
    });

    it("getDefaultRegion throws when enterprise is disabled", () => {
      ee.setEnterpriseEnabled(false);
      expect(() => getDefaultRegion()).toThrow("Enterprise features");
    });

    it("assignWorkspaceRegion throws when enterprise is disabled", async () => {
      ee.setEnterpriseEnabled(false);
      await expect(assignWorkspaceRegion("org-1", "us-east")).rejects.toThrow("Enterprise features");
    });
  });

  describe("configuration", () => {
    it("getDefaultRegion returns configured default", () => {
      expect(getDefaultRegion()).toBe("us-east");
    });

    it("getConfiguredRegions returns region map", () => {
      const regions = getConfiguredRegions();
      expect(Object.keys(regions)).toEqual(["us-east", "eu-west"]);
      expect(regions["eu-west"].label).toBe("EU West");
    });

    it("throws when residency is not configured", () => {
      mockConfig = {};
      expect(() => getDefaultRegion()).toThrow("not configured");
    });
  });

  describe("listRegions", () => {
    it("returns regions with workspace counts", async () => {
      ee.setMockRows([
        { region: "us-east", cnt: "3" },
        { region: "eu-west", cnt: "1" },
      ]);

      const regions = await listRegions();
      expect(regions).toHaveLength(2);
      expect(regions[0].region).toBe("us-east");
      expect(regions[0].workspaceCount).toBe(3);
      expect(regions[1].region).toBe("eu-west");
      expect(regions[1].workspaceCount).toBe(1);
    });

    it("returns zero counts for regions with no workspaces", async () => {
      ee.setMockRows([]); // no workspace counts
      const regions = await listRegions();
      expect(regions[0].workspaceCount).toBe(0);
    });
  });

  describe("assignWorkspaceRegion", () => {
    it("assigns a valid region to a workspace", async () => {
      // setWorkspaceRegion returns assigned: true by default
      mockRows.push([]);
      const result = await assignWorkspaceRegion("org-1", "eu-west");
      expect(result.workspaceId).toBe("org-1");
      expect(result.region).toBe("eu-west");
      expect(result.assignedAt).toBeDefined();
    });

    it("rejects invalid region", async () => {
      await expect(assignWorkspaceRegion("org-1", "ap-south")).rejects.toThrow("Invalid region");
    });

    it("rejects reassignment (immutability)", async () => {
      mockRows.push([{ assigned: false, existing: "us-east" }]);
      await expect(assignWorkspaceRegion("org-1", "eu-west")).rejects.toThrow("already assigned");
    });

    it("throws not found for nonexistent workspace", async () => {
      mockRows.push([{ assigned: false }]); // no existing field
      await expect(assignWorkspaceRegion("org-999", "us-east")).rejects.toThrow("not found");
    });
  });

  describe("getWorkspaceRegionAssignment", () => {
    it("returns assignment for workspace with region", async () => {
      ee.setMockRows([{ region: "eu-west", region_assigned_at: "2026-03-23T00:00:00Z" }]);
      const result = await getWorkspaceRegionAssignment("org-1");
      expect(result).not.toBeNull();
      expect(result!.region).toBe("eu-west");
      expect(result!.workspaceId).toBe("org-1");
    });

    it("returns null for workspace without region", async () => {
      ee.setMockRows([{ region: null, region_assigned_at: null }]);
      const result = await getWorkspaceRegionAssignment("org-1");
      expect(result).toBeNull();
    });

    it("returns null for nonexistent workspace", async () => {
      ee.setMockRows([]);
      const result = await getWorkspaceRegionAssignment("org-999");
      expect(result).toBeNull();
    });
  });

  describe("resolveRegionDatabaseUrl", () => {
    it("resolves database URLs for workspace with region", async () => {
      mockRows.push([{ region: "eu-west" }]);
      const result = await resolveRegionDatabaseUrl("org-1");
      expect(result).not.toBeNull();
      expect(result!.databaseUrl).toBe("postgresql://eu-west/atlas");
      expect(result!.datasourceUrl).toBe("postgresql://eu-west/data");
      expect(result!.region).toBe("eu-west");
    });

    it("returns null when residency is not configured", async () => {
      mockConfig = {};
      const result = await resolveRegionDatabaseUrl("org-1");
      expect(result).toBeNull();
    });

    it("returns null when workspace has no region", async () => {
      mockRows.push([{ region: null }]);
      const result = await resolveRegionDatabaseUrl("org-1");
      expect(result).toBeNull();
    });
  });

  describe("listWorkspaceRegions", () => {
    it("returns all assignments", async () => {
      ee.setMockRows([
        { id: "org-1", region: "us-east", region_assigned_at: "2026-03-23T00:00:00Z" },
        { id: "org-2", region: "eu-west", region_assigned_at: "2026-03-23T01:00:00Z" },
      ]);
      const result = await listWorkspaceRegions();
      expect(result).toHaveLength(2);
      expect(result[0].workspaceId).toBe("org-1");
      expect(result[1].workspaceId).toBe("org-2");
    });
  });

  describe("isConfiguredRegion", () => {
    it("returns true for configured region", () => {
      expect(isConfiguredRegion("eu-west")).toBe(true);
    });

    it("returns false for unconfigured region", () => {
      expect(isConfiguredRegion("ap-south")).toBe(false);
    });

    it("returns false when residency is not configured", () => {
      mockConfig = {};
      expect(isConfiguredRegion("us-east")).toBe(false);
    });
  });

  describe("ResidencyError", () => {
    it("has correct name and code", () => {
      const err = new ResidencyError("test", "invalid_region");
      expect(err.name).toBe("ResidencyError");
      expect(err.code).toBe("invalid_region");
      expect(err.message).toBe("test");
    });
  });
});
