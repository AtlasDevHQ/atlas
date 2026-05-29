import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
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
  // Capture log calls by level so the staging-arm tests can pin observability.
  // `error` distinguishes the intentional staging short-circuit from the
  // "region no longer configured / contract may be violated" misconfiguration
  // path (which also returns null, but logs error). `warn` / `debug` pin the
  // deploy-aware level: staging-keying is debug-quiet only on the staging
  // deploy, and a loud warn everywhere else (impossible-by-policy state) or
  // whenever a dead `staging` entry sits in residency.regions.
  logger: {
    createLogger: () => ({
      info: () => {},
      warn: (...args: unknown[]) => { loggerWarns.push(args); },
      error: (...args: unknown[]) => { loggerErrors.push(args); },
      debug: (...args: unknown[]) => { loggerDebugs.push(args); },
    }),
  },
});

// Extra state for the custom overrides above
const mockRows: Record<string, unknown>[][] = [];
let queryCallCount = 0;
const loggerErrors: unknown[][] = [];
const loggerWarns: unknown[][] = [];
const loggerDebugs: unknown[][] = [];

mock.module("../index", () => ee.enterpriseMock);
const hasDB = () => (ee.internalDBMock.hasInternalDB as () => boolean)();
mock.module("../lib/db-guard", () => ({
  requireInternalDB: (label: string, factory?: () => Error) => {
    if (!hasDB()) {
      if (factory) throw factory();
      throw new Error(`Internal database required for ${label}.`);
    }
  },
  requireInternalDBEffect: (label: string, factory?: () => Error) => {
    return hasDB()
      ? Effect.void
      : Effect.fail(factory?.() ?? new Error(`Internal database required for ${label}.`));
  },
}));
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

/** Run an Effect, converting failures to rejected promises for test assertions. */
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

/**
 * Run `fn` with `ATLAS_DEPLOY_ENV` pinned to `value` (or unset), restoring the
 * prior value afterward. `resolveDeployEnv()` reads `process.env` at call time
 * (not cached at module scope), so this deterministically drives the staging
 * arm's deploy-aware log level without depending on the parent env. Kept in a
 * try/finally so a failing assertion can't leak the override into sibling tests.
 */
async function withDeployEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ATLAS_DEPLOY_ENV;
  if (value === undefined) delete process.env.ATLAS_DEPLOY_ENV;
  else process.env.ATLAS_DEPLOY_ENV = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ATLAS_DEPLOY_ENV;
    else process.env.ATLAS_DEPLOY_ENV = prev;
  }
}

function resetMocks() {
  ee.reset();
  mockRows.length = 0;
  queryCallCount = 0;
  loggerErrors.length = 0;
  loggerWarns.length = 0;
  loggerDebugs.length = 0;
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
      ee.queueMockRows([
        { region: "us-east", cnt: "3" },
        { region: "eu-west", cnt: "1" },
      ]);

      const regions = await run(listRegions());
      expect(regions).toHaveLength(2);
      expect(regions[0].region).toBe("us-east");
      expect(regions[0].workspaceCount).toBe(3);
      expect(regions[1].region).toBe("eu-west");
      expect(regions[1].workspaceCount).toBe(1);
    });

    it("returns zero counts for regions with no workspaces", async () => {
      ee.queueMockRows([]); // no workspace counts
      const regions = await run(listRegions());
      expect(regions[0].workspaceCount).toBe(0);
    });
  });

  describe("assignWorkspaceRegion", () => {
    it("assigns a valid region to a workspace", async () => {
      // setWorkspaceRegion returns assigned: true by default
      mockRows.push([]);
      const result = await run(assignWorkspaceRegion("org-1", "eu-west"));
      expect(result.workspaceId).toBe("org-1");
      expect(result.region).toBe("eu-west");
      expect(result.assignedAt).toBeDefined();
    });

    it("rejects invalid region", async () => {
      await expect(run(assignWorkspaceRegion("org-1", "ap-south"))).rejects.toThrow("Invalid region");
    });

    it("rejects reassignment (immutability)", async () => {
      mockRows.push([{ assigned: false, existing: "us-east" }]);
      await expect(run(assignWorkspaceRegion("org-1", "eu-west"))).rejects.toThrow("already assigned");
    });

    it("throws not found for nonexistent workspace", async () => {
      mockRows.push([{ assigned: false }]); // no existing field
      await expect(run(assignWorkspaceRegion("org-999", "us-east"))).rejects.toThrow("not found");
    });
  });

  describe("getWorkspaceRegionAssignment", () => {
    it("returns assignment for workspace with region", async () => {
      ee.queueMockRows([{ region: "eu-west", region_assigned_at: "2026-03-23T00:00:00Z" }]);
      const result = await run(getWorkspaceRegionAssignment("org-1"));
      expect(result).not.toBeNull();
      expect(result!.region).toBe("eu-west");
      expect(result!.workspaceId).toBe("org-1");
    });

    it("returns null for workspace without region", async () => {
      ee.queueMockRows([{ region: null, region_assigned_at: null }]);
      const result = await run(getWorkspaceRegionAssignment("org-1"));
      expect(result).toBeNull();
    });

    it("returns null for nonexistent workspace", async () => {
      ee.queueMockRows([]);
      const result = await run(getWorkspaceRegionAssignment("org-999"));
      expect(result).toBeNull();
    });
  });

  describe("resolveRegionDatabaseUrl", () => {
    it("resolves database URLs for workspace with region", async () => {
      mockRows.push([{ region: "eu-west" }]);
      const result = await run(resolveRegionDatabaseUrl("org-1"));
      expect(result).not.toBeNull();
      expect(result!.databaseUrl).toBe("postgresql://eu-west/atlas");
      expect(result!.datasourceUrl).toBe("postgresql://eu-west/data");
      expect(result!.region).toBe("eu-west");
    });

    it("returns null when residency is not configured", async () => {
      mockConfig = {};
      const result = await run(resolveRegionDatabaseUrl("org-1"));
      expect(result).toBeNull();
    });

    it("returns null when workspace has no region", async () => {
      mockRows.push([{ region: null }]);
      const result = await run(resolveRegionDatabaseUrl("org-1"));
      expect(result).toBeNull();
    });

    // ── Staging arm (#2908) ───────────────────────────────────────────
    // Staging is a DeployRegion but never a residency target — a
    // staging-keyed workspace always falls through to the local DB connection
    // (result is null, never an error). What varies is the *observability*
    // level, which is deploy-aware. These four tests are the full 2×2 truth
    // table of (on staging deploy?) × (staging present in residency.regions?):
    //   • the loud "contract may be violated" error path NEVER fires (the
    //     log assertion is what distinguishes the staging arm from the
    //     misconfiguration path — both return null), and
    //   • the arm is debug-quiet ONLY when staging-keying is routine, i.e. on
    //     the staging deploy with no dead `staging` config; otherwise it warns
    //     with a structured `event` so prod mis-keying / dead config is
    //     alertable rather than a silent fall-through to the default pool.
    // `STAGING_REGION` is anchored via `satisfies DeployRegion`, so a mis-cased
    // literal can't reach the equality check — no case-variant test needed.

    it("off the staging deploy: returns null and warns (no contract-violation error)", async () => {
      // "staging" is absent from residency.regions (us-east / eu-west) and we
      // are NOT on the staging deploy — an impossible-by-policy state, so the
      // arm short-circuits to null (before the regionConfig lookup, so no loud
      // "contract may be violated" error) but surfaces a structured warn.
      mockRows.push([{ region: "staging" }]);
      const result = await withDeployEnv("production", () => run(resolveRegionDatabaseUrl("org-1")));
      expect(result).toBeNull();
      expect(loggerErrors).toHaveLength(0);
      expect(loggerDebugs).toHaveLength(0);
      expect(loggerWarns).toHaveLength(1);
      expect(loggerWarns[0][0]).toMatchObject({
        region: "staging",
        event: "residency.staging_excluded",
        stagingInResidencyConfig: false,
      });
    });

    it("off the staging deploy: warns and flags dead config when staging is present in residency.regions", async () => {
      // Defensive: even if an operator adds a `staging` entry to the regions
      // map, the staging arm wins and routing stays null (without it, this
      // would resolve a non-null staging datasource). The dead entry is
      // surfaced via `stagingInResidencyConfig: true` so the operator learns
      // it is silently ignored.
      mockConfig = {
        residency: {
          regions: {
            "us-east": { label: "US East", databaseUrl: "postgresql://us-east/atlas" },
            staging: { label: "Staging", databaseUrl: "postgresql://staging/atlas", datasourceUrl: "postgresql://staging/data" },
          },
          defaultRegion: "us-east",
        },
      };
      mockRows.push([{ region: "staging" }]);
      const result = await withDeployEnv("production", () => run(resolveRegionDatabaseUrl("org-1")));
      expect(result).toBeNull();
      expect(loggerErrors).toHaveLength(0);
      expect(loggerWarns).toHaveLength(1);
      expect(loggerWarns[0][0]).toMatchObject({
        event: "residency.staging_excluded",
        stagingInResidencyConfig: true,
      });
    });

    it("on the staging deploy: stays debug-quiet (staging-keying is routine)", async () => {
      // On the staging deploy every residency-configured request is staging-
      // keyed, so the exclusion is routine — debug-level, no warn, no error.
      mockRows.push([{ region: "staging" }]);
      const result = await withDeployEnv("staging", () => run(resolveRegionDatabaseUrl("org-1")));
      expect(result).toBeNull();
      expect(loggerErrors).toHaveLength(0);
      expect(loggerWarns).toHaveLength(0);
      expect(loggerDebugs).toHaveLength(1);
      expect(loggerDebugs[0][0]).toMatchObject({
        event: "residency.staging_excluded",
        stagingInResidencyConfig: false,
      });
    });

    it("on the staging deploy: still warns when staging is dead config in residency.regions", async () => {
      // Dead config is loud regardless of deploy env — a `staging` entry in
      // residency.regions is never routed, so the operator should hear about it
      // even on the staging deploy where staging-keying is otherwise routine.
      mockConfig = {
        residency: {
          regions: {
            "us-east": { label: "US East", databaseUrl: "postgresql://us-east/atlas" },
            staging: { label: "Staging", databaseUrl: "postgresql://staging/atlas", datasourceUrl: "postgresql://staging/data" },
          },
          defaultRegion: "us-east",
        },
      };
      mockRows.push([{ region: "staging" }]);
      const result = await withDeployEnv("staging", () => run(resolveRegionDatabaseUrl("org-1")));
      expect(result).toBeNull();
      expect(loggerErrors).toHaveLength(0);
      expect(loggerDebugs).toHaveLength(0);
      expect(loggerWarns).toHaveLength(1);
      expect(loggerWarns[0][0]).toMatchObject({ stagingInResidencyConfig: true });
    });
  });

  describe("listWorkspaceRegions", () => {
    it("returns all assignments", async () => {
      ee.queueMockRows([
        { id: "org-1", region: "us-east", region_assigned_at: "2026-03-23T00:00:00Z" },
        { id: "org-2", region: "eu-west", region_assigned_at: "2026-03-23T01:00:00Z" },
      ]);
      const result = await run(listWorkspaceRegions());
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
      const err = new ResidencyError({ message: "test", code: "invalid_region" });
      expect(err.name).toBe("ResidencyError");
      expect(err._tag).toBe("ResidencyError");
      expect(err.code).toBe("invalid_region");
      expect(err.message).toBe("test");
    });
  });
});
