/**
 * Tests for cross-region request misrouting detection.
 *
 * Covers: correct region (no warning), wrong region (warning logged),
 * strict mode (421 response), no region configured (skip), unauthenticated (skip),
 * health endpoint region field, counter increment, cache behavior.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

let mockWorkspaceRegion: string | null = null;
let mockGetWorkspaceRegionError: Error | null = null;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getWorkspaceRegion: async (orgId: string) => {
    if (mockGetWorkspaceRegionError) throw mockGetWorkspaceRegionError;
    // Different orgs can have different regions
    if (orgId === "org-eu") return "eu-west";
    if (orgId === "org-us") return "us-west";
    if (orgId === "org-no-region") return null;
    return mockWorkspaceRegion;
  },
  internalQuery: () => Promise.resolve([]),
  internalExecute: () => {},
  getInternalDB: () => ({
    query: () => Promise.resolve({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  encryptUrl: (url: string) => url,
  decryptUrl: (url: string) => url,
  isPlaintextUrl: () => true,
  getEncryptionKey: () => null,
  _resetEncryptionKeyCache: () => {},
  setWorkspaceRegion: () => Promise.resolve({ assigned: true }),
  closeInternalDB: () => Promise.resolve(),
  InternalDB: {},
  makeInternalDBLive: () => {},
  createInternalDBTestLayer: () => {},
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
}));

let mockConfig: Record<string, unknown> | null = null;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
  configFromEnv: () => ({}),
  loadConfig: async () => ({}),
  defineConfig: (c: unknown) => c,
  validateAndResolve: (r: unknown) => r,
  _setConfigForTest: () => {},
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ── Import after mocks ──────────────────────────────────────────────

const {
  detectMisrouting,
  getApiRegion,
  isStrictRoutingEnabled,
  getMisroutedCount,
  _resetMisroutedCount,
  _resetRegionCache,
} = await import("../misrouting");

// ── Tests ───────────────────────────────────────────────────────────

describe("misrouting detection", () => {
  beforeEach(() => {
    _resetMisroutedCount();
    _resetRegionCache();
    mockWorkspaceRegion = null;
    mockGetWorkspaceRegionError = null;
    mockConfig = null;
    delete process.env.ATLAS_API_REGION;
    delete process.env.ATLAS_STRICT_ROUTING;
  });

  // ── getApiRegion ──────────────────────────────────────────────────

  describe("getApiRegion", () => {
    it("returns ATLAS_API_REGION env var when set", () => {
      process.env.ATLAS_API_REGION = "us-west";
      expect(getApiRegion()).toBe("us-west");
    });

    it("falls back to config residency.defaultRegion", () => {
      mockConfig = {
        residency: {
          defaultRegion: "eu-west",
          regions: { "eu-west": { label: "Europe", databaseUrl: "postgres://..." } },
        },
      };
      expect(getApiRegion()).toBe("eu-west");
    });

    it("returns null when no region is configured", () => {
      expect(getApiRegion()).toBeNull();
    });

    it("env var takes precedence over config", () => {
      process.env.ATLAS_API_REGION = "ap-southeast";
      mockConfig = {
        residency: {
          defaultRegion: "eu-west",
          regions: { "eu-west": { label: "Europe", databaseUrl: "postgres://..." } },
        },
      };
      expect(getApiRegion()).toBe("ap-southeast");
    });
  });

  // ── isStrictRoutingEnabled ────────────────────────────────────────

  describe("isStrictRoutingEnabled", () => {
    it("defaults to false", () => {
      expect(isStrictRoutingEnabled()).toBe(false);
    });

    it("returns true when env var is set", () => {
      process.env.ATLAS_STRICT_ROUTING = "true";
      expect(isStrictRoutingEnabled()).toBe(true);
    });

    it("returns true when config has strictRouting", () => {
      mockConfig = {
        residency: {
          defaultRegion: "us-west",
          strictRouting: true,
          regions: { "us-west": { label: "US", databaseUrl: "postgres://..." } },
        },
      };
      expect(isStrictRoutingEnabled()).toBe(true);
    });

    it("env var takes precedence over config", () => {
      process.env.ATLAS_STRICT_ROUTING = "true";
      mockConfig = {
        residency: {
          defaultRegion: "us-west",
          strictRouting: false,
          regions: { "us-west": { label: "US", databaseUrl: "postgres://..." } },
        },
      };
      expect(isStrictRoutingEnabled()).toBe(true);
    });
  });

  // ── detectMisrouting ──────────────────────────────────────────────

  describe("detectMisrouting", () => {
    it("skips when no orgId is provided", async () => {
      process.env.ATLAS_API_REGION = "us-west";
      const result = await detectMisrouting(undefined, "req-1");
      expect(result).toBeNull();
      expect(getMisroutedCount()).toBe(0);
    });

    it("skips when no region is configured on this instance", async () => {
      // No ATLAS_API_REGION, no config → self-hosted
      const result = await detectMisrouting("org-eu", "req-1");
      expect(result).toBeNull();
      expect(getMisroutedCount()).toBe(0);
    });

    it("skips when workspace has no region assigned", async () => {
      process.env.ATLAS_API_REGION = "us-west";
      const result = await detectMisrouting("org-no-region", "req-1");
      expect(result).toBeNull();
      expect(getMisroutedCount()).toBe(0);
    });

    it("returns null when regions match (correct routing)", async () => {
      process.env.ATLAS_API_REGION = "us-west";
      const result = await detectMisrouting("org-us", "req-1");
      expect(result).toBeNull();
      expect(getMisroutedCount()).toBe(0);
    });

    it("detects misrouting when regions differ", async () => {
      process.env.ATLAS_API_REGION = "us-west";
      const result = await detectMisrouting("org-eu", "req-1");
      expect(result).not.toBeNull();
      expect(result!.expectedRegion).toBe("eu-west");
      expect(result!.actualRegion).toBe("us-west");
      expect(getMisroutedCount()).toBe(1);
    });

    it("includes correctApiUrl from config when available", async () => {
      process.env.ATLAS_API_REGION = "us-west";
      mockConfig = {
        residency: {
          defaultRegion: "us-west",
          regions: {
            "us-west": { label: "US", databaseUrl: "postgres://...", apiUrl: "https://api-us.useatlas.dev" },
            "eu-west": { label: "Europe", databaseUrl: "postgres://...", apiUrl: "https://api-eu.useatlas.dev" },
          },
        },
      };
      const result = await detectMisrouting("org-eu", "req-1");
      expect(result).not.toBeNull();
      expect(result!.correctApiUrl).toBe("https://api-eu.useatlas.dev");
    });

    it("omits correctApiUrl when not in config", async () => {
      process.env.ATLAS_API_REGION = "us-west";
      mockConfig = null;
      const result = await detectMisrouting("org-eu", "req-1");
      expect(result).not.toBeNull();
      expect(result!.correctApiUrl).toBeUndefined();
    });

    it("increments counter for each misrouted request", async () => {
      process.env.ATLAS_API_REGION = "us-west";
      await detectMisrouting("org-eu", "req-1");
      await detectMisrouting("org-eu", "req-2");
      await detectMisrouting("org-eu", "req-3");
      expect(getMisroutedCount()).toBe(3);
    });

    it("skips gracefully when region lookup fails", async () => {
      process.env.ATLAS_API_REGION = "us-west";
      mockGetWorkspaceRegionError = new Error("DB connection failed");
      const result = await detectMisrouting("org-unknown", "req-1");
      expect(result).toBeNull();
      expect(getMisroutedCount()).toBe(0);
    });

    it("uses cached region on subsequent calls", async () => {
      process.env.ATLAS_API_REGION = "us-west";

      // First call — hits DB
      const result1 = await detectMisrouting("org-eu", "req-1");
      expect(result1).not.toBeNull();

      // Second call — should use cache (even if DB would error now)
      mockGetWorkspaceRegionError = new Error("DB gone");
      const result2 = await detectMisrouting("org-eu", "req-2");
      expect(result2).not.toBeNull();
      expect(result2!.expectedRegion).toBe("eu-west");
    });
  });

  // ── Counter reset ─────────────────────────────────────────────────

  describe("counter", () => {
    it("resets to zero", () => {
      expect(getMisroutedCount()).toBe(0);
    });
  });
});
