/**
 * Tests for region migration executor.
 *
 * Covers: successful migration, failure handling, retry, cancel,
 * stale detection, and edge cases.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

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

// ── Import after mocks ──────────────────────────────────────────────

const {
  executeRegionMigration,
  failStaleMigrations,
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
}

// ── Tests ───────────────────────────────────────────────────────────

describe("executeRegionMigration", () => {
  beforeEach(resetMocks);

  it("returns error when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Internal database");
  });

  it("returns error when migration is not found", async () => {
    // internalQuery returns empty for SELECT from region_migrations
    const result = await executeRegionMigration("mig-nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error when migration is not in pending status", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "completed" },
    ];
    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("completed");
    expect(result.error).toContain("expected \"pending\"");
  });

  it("executes migration successfully", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    // UPDATE status queries return empty (OK)
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(true);
    expect(result.migrationId).toBe("mig-1");

    // Verify we updated status to in_progress and then completed
    const statusUpdates = capturedQueries.filter((q) => q.sql.includes("UPDATE region_migrations"));
    expect(statusUpdates.length).toBeGreaterThanOrEqual(2);
    expect(statusUpdates[0].params[0]).toBe("in_progress");
    expect(statusUpdates[statusUpdates.length - 1].params[0]).toBe("completed");

    // Verify we updated the organization region
    const regionUpdate = capturedQueries.find((q) => q.sql.includes("UPDATE organization"));
    expect(regionUpdate).toBeDefined();
    expect(regionUpdate!.params).toContain("eu-west");
    expect(regionUpdate!.params).toContain("org-1");
  });

  it("marks migration as failed when workspace not found", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-999", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    // Organization update returns no rows
    mockPoolQueryResult = { rows: [] };

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");

    // Verify status was set to failed
    const failedUpdate = capturedQueries.filter(
      (q) => q.sql.includes("UPDATE region_migrations") && q.params.includes("failed"),
    );
    expect(failedUpdate.length).toBeGreaterThanOrEqual(1);
  });

  it("marks migration as failed when pool query throws", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    mockPoolQueryError = new Error("connection refused");

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("connection refused");
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

describe("resetMigrationForRetry", () => {
  beforeEach(resetMocks);

  it("returns error when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await resetMigrationForRetry("mig-1");
    expect(result.reset).toBe(false);
    expect(result.error).toContain("Internal database");
  });

  it("returns error when migration not found", async () => {
    const result = await resetMigrationForRetry("mig-nonexistent");
    expect(result.reset).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error when migration is not failed", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "pending" }];
    const result = await resetMigrationForRetry("mig-1");
    expect(result.reset).toBe(false);
    expect(result.error).toContain("pending");
  });

  it("resets a failed migration to pending", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "failed" }];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await resetMigrationForRetry("mig-1");
    expect(result.reset).toBe(true);

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
    const result = await cancelMigration("mig-1");
    expect(result.cancelled).toBe(false);
    expect(result.error).toContain("Internal database");
  });

  it("returns error when migration not found", async () => {
    const result = await cancelMigration("mig-nonexistent");
    expect(result.cancelled).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error when migration is not pending", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "in_progress" }];
    const result = await cancelMigration("mig-1");
    expect(result.cancelled).toBe(false);
    expect(result.error).toContain("in_progress");
  });

  it("cancels a pending migration", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "pending" }];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await cancelMigration("mig-1");
    expect(result.cancelled).toBe(true);

    const cancelQuery = capturedQueries.find(
      (q) => q.sql.includes("status = 'failed'") && q.sql.includes("Cancelled by admin"),
    );
    expect(cancelQuery).toBeDefined();
  });
});
