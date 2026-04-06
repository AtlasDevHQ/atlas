/**
 * Tests for region migration executor.
 *
 * Covers: successful migration with 4 phases (export, transfer, cutover, cleanup),
 * failure handling, retry, cancel, stale detection, cleanup detection, and edge cases.
 */

import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

let mockHasInternalDB = true;
let mockQueryResults: Record<string, unknown[]> = {};
let mockQueryError: Error | null = null;
let mockPoolQueryResult = { rows: [{ id: "org-1" }] };
let mockPoolQueryError: Error | null = null;
const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: (sql: string, params: unknown[]) => {
      capturedQueries.push({ sql, params });
      if (mockPoolQueryError) return Promise.reject(mockPoolQueryError);
      // For export queries, return empty results by default
      if (sql.includes("FROM conversations") || sql.includes("FROM messages") ||
          sql.includes("FROM semantic_entities") || sql.includes("FROM learned_patterns") ||
          sql.includes("FROM settings")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve(mockPoolQueryResult);
    },
    end: async () => {},
    on: () => {},
  }),
  internalQuery: (sql: string, params: unknown[]) => {
    capturedQueries.push({ sql, params });
    if (mockQueryError) return Promise.reject(mockQueryError);
    // Match query to result based on SQL pattern
    for (const [key, value] of Object.entries(mockQueryResults)) {
      if (sql.includes(key)) return Promise.resolve(value);
    }
    return Promise.resolve([]);
  },
  internalExecute: () => {},
  getWorkspaceRegion: () => Promise.resolve(null),
  setWorkspaceRegion: () => Promise.resolve({ assigned: true }),
  insertSemanticAmendment: async () => "mock-amendment-id",
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

mock.module("@atlas/api/lib/cache/index", () => ({
  flushCache: () => {},
  getCache: () => null,
  cacheEnabled: () => false,
  buildCacheKey: () => "",
}));

// Mock config with target region apiUrl
const DEFAULT_MOCK_CONFIG = {
  residency: {
    regions: {
      "us-east": { label: "US East", databaseUrl: "postgres://us", apiUrl: "https://api-us.example.com" },
      "eu-west": { label: "EU West", databaseUrl: "postgres://eu", apiUrl: "https://api-eu.example.com" },
    },
    defaultRegion: "us-east",
  },
};

let mockConfig: Record<string, unknown> | null = { ...DEFAULT_MOCK_CONFIG };

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
}));

// Mock fetch for transfer phase
let mockFetchResponse: { ok: boolean; status: number; body?: unknown } = { ok: true, status: 200, body: {} };
let mockFetchError: Error | null = null;
let capturedFetchCalls: Array<{ url: string; options: RequestInit }> = [];

const _originalFetch = globalThis.fetch;
globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  capturedFetchCalls.push({ url: urlStr, options: options ?? {} });
  if (mockFetchError) return Promise.reject(mockFetchError);
  return Promise.resolve({
    ok: mockFetchResponse.ok,
    status: mockFetchResponse.status,
    statusText: mockFetchResponse.ok ? "OK" : "Error",
    json: () => Promise.resolve(mockFetchResponse.body ?? {}),
  } as Response);
}) as typeof fetch;

// ── Import after mocks ──────────────────────────────────────────────

const {
  executeRegionMigration,
  failStaleMigrations,
  getCleanupDueMigrations,
  resetMigrationForRetry,
  cancelMigration,
} = await import("../migrate");

// ── Helpers ─────────────────────────────────────────────────────────

function resetMocks() {
  mockHasInternalDB = true;
  mockQueryResults = {};
  mockQueryError = null;
  mockPoolQueryResult = { rows: [{ id: "org-1" }] };
  mockPoolQueryError = null;
  capturedQueries.length = 0;
  mockFetchResponse = { ok: true, status: 200, body: {} };
  mockFetchError = null;
  capturedFetchCalls = [];
  mockConfig = { ...DEFAULT_MOCK_CONFIG };
  process.env.ATLAS_INTERNAL_SECRET = "test-secret";
}

// ── Tests ───────────────────────────────────────────────────────────

describe("executeRegionMigration", () => {
  beforeEach(resetMocks);
  afterEach(() => {
    delete process.env.ATLAS_INTERNAL_SECRET;
  });

  it("returns error when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("Internal database");
  });

  it("returns error when migration is not found", async () => {
    const result = await executeRegionMigration("mig-nonexistent");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("not found");
  });

  it("returns error when migration is not in pending status", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "completed" },
    ];
    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("completed");
      expect(result.error).toContain("expected \"pending\"");
    }
  });

  it("executes migration successfully through all 4 phases", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(true);
    expect(result.migrationId).toBe("mig-1");

    // Verify status transitions: in_progress → completed
    const statusUpdates = capturedQueries.filter((q) => q.sql.includes("UPDATE region_migrations"));
    expect(statusUpdates.length).toBeGreaterThanOrEqual(2);
    expect(statusUpdates[0].params[0]).toBe("in_progress");
    expect(statusUpdates[statusUpdates.length - 1].params[0]).toBe("completed");

    // Verify region update (cutover phase)
    const regionUpdate = capturedQueries.find((q) => q.sql.includes("UPDATE organization"));
    expect(regionUpdate).toBeDefined();
    expect(regionUpdate!.params).toContain("eu-west");
    expect(regionUpdate!.params).toContain("org-1");

    // Verify transfer was called to the target region's apiUrl
    expect(capturedFetchCalls.length).toBe(1);
    expect(capturedFetchCalls[0].url).toBe("https://api-eu.example.com/api/v1/internal/migrate/import");
  });

  it("includes internal token in transfer request", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    await executeRegionMigration("mig-1");

    expect(capturedFetchCalls.length).toBe(1);
    const headers = capturedFetchCalls[0].options.headers as Record<string, string>;
    expect(headers["X-Atlas-Internal-Token"]).toBe("test-secret");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("includes orgId in transfer request body", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    await executeRegionMigration("mig-1");

    const body = JSON.parse(capturedFetchCalls[0].options.body as string);
    expect(body.orgId).toBe("org-1");
    expect(body.manifest).toBeDefined();
    expect(body.conversations).toBeDefined();
  });

  it("fails when ATLAS_INTERNAL_SECRET is not set", async () => {
    delete process.env.ATLAS_INTERNAL_SECRET;
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("ATLAS_INTERNAL_SECRET");
  });

  it("fails when target region has no apiUrl configured", async () => {
    mockConfig = {
      residency: {
        regions: {
          "us-east": { label: "US East", databaseUrl: "postgres://us" },
          "eu-west": { label: "EU West", databaseUrl: "postgres://eu" },
        },
        defaultRegion: "us-east",
      },
    };
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("apiUrl");
    // mockConfig is auto-restored by resetMocks in beforeEach
  });

  it("fails when transfer HTTP call returns error", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    mockFetchResponse = { ok: false, status: 500, body: { message: "Import failed — DB error" } };

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("Import failed");

    // Verify status set to failed
    const failedUpdate = capturedQueries.filter(
      (q) => q.sql.includes("UPDATE region_migrations") && q.params.includes("failed"),
    );
    expect(failedUpdate.length).toBeGreaterThanOrEqual(1);
  });

  it("fails when transfer throws network error", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    mockFetchError = new Error("ECONNREFUSED");

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("Network error");
  });

  it("marks migration as failed when workspace not found during cutover", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-999", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    // Organization update returns no rows
    mockPoolQueryResult = { rows: [] };

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("not found");
  });

  it("marks migration as failed when export throws", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    mockPoolQueryError = new Error("connection refused");

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("connection refused");
  });
});

describe("failStaleMigrations", () => {
  beforeEach(resetMocks);

  it("returns 0 when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const count = await failStaleMigrations();
    expect(count).toBe(0);
  });

  it("returns 0 when no stale migrations exist", async () => {
    const count = await failStaleMigrations();
    expect(count).toBe(0);
  });

  it("fails stale migrations", async () => {
    mockQueryResults["status = 'in_progress'"] = [
      { id: "mig-stale", workspace_id: "org-1" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    const count = await failStaleMigrations();
    expect(count).toBe(1);

    const failedUpdate = capturedQueries.find(
      (q) => q.sql.includes("UPDATE region_migrations") && q.params.includes("failed"),
    );
    expect(failedUpdate).toBeDefined();
  });
});

describe("getCleanupDueMigrations", () => {
  beforeEach(resetMocks);

  it("returns empty when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await getCleanupDueMigrations();
    expect(result).toHaveLength(0);
  });

  it("returns empty when no completed migrations past grace period", async () => {
    const result = await getCleanupDueMigrations();
    expect(result).toHaveLength(0);
  });

  it("returns migrations eligible for cleanup", async () => {
    mockQueryResults["status = 'completed'"] = [
      { id: "mig-old", workspace_id: "org-1", source_region: "us-east", completed_at: "2026-03-01T00:00:00Z" },
    ];

    const result = await getCleanupDueMigrations();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("mig-old");
    expect(result[0].workspaceId).toBe("org-1");
    expect(result[0].sourceRegion).toBe("us-east");
  });
});

describe("resetMigrationForRetry", () => {
  beforeEach(resetMocks);

  it("returns error when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await resetMigrationForRetry("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_db");
      expect(result.error).toContain("Internal database");
    }
  });

  it("returns error when migration not found", async () => {
    const result = await resetMigrationForRetry("mig-nonexistent", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns not_found when workspace does not match", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "failed", workspace_id: "org-other" }];
    const result = await resetMigrationForRetry("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns error when migration is not failed", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "pending", workspace_id: "org-1" }];
    const result = await resetMigrationForRetry("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_status");
      expect(result.error).toContain("pending");
    }
  });

  it("resets a failed migration to pending", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "failed", workspace_id: "org-1" }];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await resetMigrationForRetry("mig-1", "org-1");
    expect(result.ok).toBe(true);

    const resetQuery = capturedQueries.find(
      (q) => q.sql.includes("status = 'pending'"),
    );
    expect(resetQuery).toBeDefined();
  });
});

describe("cancelMigration", () => {
  beforeEach(resetMocks);

  it("returns error when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await cancelMigration("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_db");
      expect(result.error).toContain("Internal database");
    }
  });

  it("returns error when migration not found", async () => {
    const result = await cancelMigration("mig-nonexistent", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns not_found when workspace does not match", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "pending", workspace_id: "org-other" }];
    const result = await cancelMigration("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns error when migration is not pending", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "in_progress", workspace_id: "org-1" }];
    const result = await cancelMigration("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_status");
      expect(result.error).toContain("in_progress");
    }
  });

  it("cancels a pending migration", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "pending", workspace_id: "org-1" }];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await cancelMigration("mig-1", "org-1");
    expect(result.ok).toBe(true);

    const cancelQuery = capturedQueries.find(
      (q) => q.sql.includes("status = 'cancelled'") && q.sql.includes("Cancelled by admin"),
    );
    expect(cancelQuery).toBeDefined();
  });
});
