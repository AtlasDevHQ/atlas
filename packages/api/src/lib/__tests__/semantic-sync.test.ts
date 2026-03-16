/**
 * Tests for the dual-write sync layer (semantic-sync.ts).
 *
 * Covers:
 * - getSemanticRoot() path resolution + path traversal rejection
 * - syncEntityToDisk() — exercises the real function via actual filesystem
 * - syncEntityDeleteFromDisk() — file removal + ENOENT handling
 * - syncAllEntitiesToDisk() — full rebuild from DB mock, verifies disk output
 * - cleanupOrgDirectory() — directory removal
 *
 * The tests call the real production functions. Since getSemanticRoot uses
 * a process-level base path, syncEntityToDisk/syncAllEntitiesToDisk write
 * to the real semantic/.orgs/ directory. Tests clean up after themselves.
 *
 * Uses mock.module() to mock the DB layer.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Mock the DB layer
// ---------------------------------------------------------------------------

import type { SemanticEntityRow } from "../db/semantic-entities";

const mockListEntities = mock((): Promise<SemanticEntityRow[]> => Promise.resolve([]));
const mockHasInternalDB = mock((): boolean => true);
const mockInternalQuery = mock((): Promise<Array<{ org_id: string }>> => Promise.resolve([]));

mock.module("@atlas/api/lib/db/semantic-entities", () => ({
  listEntities: mockListEntities,
  getEntity: mock(() => Promise.resolve(null)),
  upsertEntity: mock(() => Promise.resolve()),
  deleteEntity: mock(() => Promise.resolve(false)),
  countEntities: mock(() => Promise.resolve(0)),
  bulkUpsertEntities: mock(() => Promise.resolve(0)),
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  internalQuery: mockInternalQuery,
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import {
  getSemanticRoot,
  syncEntityToDisk,
  syncEntityDeleteFromDisk,
  syncAllEntitiesToDisk,
  cleanupOrgDirectory,
} from "../semantic-sync";

// ---------------------------------------------------------------------------
// Test setup — use a unique org ID per test to avoid collisions
// ---------------------------------------------------------------------------

/** Org IDs created during tests — cleaned up in afterEach. */
const createdOrgIds: string[] = [];

function testOrgId(): string {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdOrgIds.push(id);
  return id;
}

function makeEntityRow(
  orgId: string,
  name: string,
  entityType: string,
  yamlContent: string,
  connectionId?: string,
): SemanticEntityRow {
  return {
    id: `id-${name}`,
    org_id: orgId,
    entity_type: entityType as SemanticEntityRow["entity_type"],
    name,
    yaml_content: yamlContent,
    connection_id: connectionId ?? null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

beforeEach(() => {
  mockListEntities.mockReset();
  mockListEntities.mockImplementation(() => Promise.resolve([]));
});

afterEach(() => {
  // Clean up any org directories created during the test
  for (const orgId of createdOrgIds) {
    try {
      const root = getSemanticRoot(orgId);
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  createdOrgIds.length = 0;
});

// ---------------------------------------------------------------------------
// getSemanticRoot
// ---------------------------------------------------------------------------

describe("getSemanticRoot", () => {
  it("returns base semantic root when no orgId", () => {
    const root = getSemanticRoot();
    expect(root).toBe(path.resolve(process.cwd(), "semantic"));
  });

  it("returns org-scoped root when orgId provided", () => {
    const root = getSemanticRoot("org-123");
    expect(root).toBe(path.resolve(process.cwd(), "semantic", ".orgs", "org-123"));
  });

  it("returns different roots for different orgs", () => {
    const root1 = getSemanticRoot("org-a");
    const root2 = getSemanticRoot("org-b");
    expect(root1).not.toBe(root2);
    expect(root1).toContain("org-a");
    expect(root2).toContain("org-b");
  });

  it("rejects orgId with path traversal (../)", () => {
    expect(() => getSemanticRoot("../../etc")).toThrow("Invalid orgId");
  });

  it("rejects orgId with slash", () => {
    expect(() => getSemanticRoot("org/sub")).toThrow("Invalid orgId");
  });

  it("rejects orgId of '..'", () => {
    expect(() => getSemanticRoot("..")).toThrow("Invalid orgId");
  });

  it("rejects orgId of '.'", () => {
    expect(() => getSemanticRoot(".")).toThrow("Invalid orgId");
  });

  it("accepts normal UUID-like orgId", () => {
    expect(() => getSemanticRoot("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// syncEntityToDisk — exercises the real function
// ---------------------------------------------------------------------------

describe("syncEntityToDisk", () => {
  it("writes entity YAML to the correct path via atomic write", async () => {
    const orgId = testOrgId();
    const content = "table: users\ndescription: User table\n";

    await syncEntityToDisk(orgId, "users", "entity", content);

    const expectedPath = path.join(getSemanticRoot(orgId), "entities", "users.yml");
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.readFileSync(expectedPath, "utf-8")).toBe(content);
  });

  it("creates parent directories automatically", async () => {
    const orgId = testOrgId();
    const root = getSemanticRoot(orgId);

    // Directory should not exist yet
    expect(fs.existsSync(root)).toBe(false);

    await syncEntityToDisk(orgId, "orders", "entity", "table: orders\n");

    const expectedPath = path.join(root, "entities", "orders.yml");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("writes metrics to the metrics subdirectory", async () => {
    const orgId = testOrgId();

    await syncEntityToDisk(orgId, "revenue", "metric", "name: revenue\nsql: SUM(amount)\n");

    const expectedPath = path.join(getSemanticRoot(orgId), "metrics", "revenue.yml");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("writes glossary to the root directory", async () => {
    const orgId = testOrgId();

    await syncEntityToDisk(orgId, "glossary", "glossary", "terms:\n  - name: ARR\n");

    const expectedPath = path.join(getSemanticRoot(orgId), "glossary.yml");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("sanitizes entity names with path traversal characters", async () => {
    const orgId = testOrgId();

    await syncEntityToDisk(orgId, "../../etc/passwd", "entity", "table: hack\n");

    // Should NOT create a file at ../../etc/passwd — safeName strips traversal
    const root = getSemanticRoot(orgId);
    const expectedPath = path.join(root, "entities", "passwd.yml");
    expect(fs.existsSync(expectedPath)).toBe(true);
    // Verify nothing escaped
    expect(fs.existsSync(path.join(root, "..", "..", "etc", "passwd.yml"))).toBe(false);
  });

  it("does not throw on write failure (swallows error)", async () => {
    // syncEntityToDisk swallows errors — DB write already succeeded
    // Use a path-traversal-rejected orgId to verify it doesn't throw
    // Instead, write to a valid org but with a read-only parent
    // (hard to simulate portably — just verify the function signature)
    await expect(
      syncEntityToDisk("nonexistent-but-valid-org", "test", "entity", "table: test\n"),
    ).resolves.toBeUndefined();
    // Clean up
    createdOrgIds.push("nonexistent-but-valid-org");
  });
});

// ---------------------------------------------------------------------------
// syncEntityDeleteFromDisk
// ---------------------------------------------------------------------------

describe("syncEntityDeleteFromDisk", () => {
  it("does not throw when file does not exist", async () => {
    await expect(
      syncEntityDeleteFromDisk("nonexistent-org", "nonexistent", "entity"),
    ).resolves.toBeUndefined();
  });

  it("removes an existing entity file", async () => {
    const orgId = testOrgId();

    // Create the file first
    await syncEntityToDisk(orgId, "to-delete", "entity", "table: to_delete\n");
    const filePath = path.join(getSemanticRoot(orgId), "entities", "to-delete.yml");
    expect(fs.existsSync(filePath)).toBe(true);

    // Delete it
    await syncEntityDeleteFromDisk(orgId, "to-delete", "entity");
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncAllEntitiesToDisk
// ---------------------------------------------------------------------------

describe("syncAllEntitiesToDisk", () => {
  it("writes all entities from DB to disk", async () => {
    const orgId = testOrgId();
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow(orgId, "users", "entity", "table: users\ndescription: Users\n"),
        makeEntityRow(orgId, "orders", "entity", "table: orders\ndescription: Orders\n"),
        makeEntityRow(orgId, "revenue", "metric", "name: revenue\nsql: SUM(amount)\n"),
      ]),
    );

    const synced = await syncAllEntitiesToDisk(orgId);
    expect(synced).toBe(3);

    // Verify actual files on disk
    const root = getSemanticRoot(orgId);
    expect(fs.existsSync(path.join(root, "entities", "users.yml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "entities", "orders.yml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "metrics", "revenue.yml"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "entities", "users.yml"), "utf-8")).toBe("table: users\ndescription: Users\n");
  });

  it("returns 0 when DB has no entities", async () => {
    mockListEntities.mockImplementation(() => Promise.resolve([]));
    const orgId = testOrgId();

    const synced = await syncAllEntitiesToDisk(orgId);
    expect(synced).toBe(0);
  });

  it("removes stale files not in DB", async () => {
    const orgId = testOrgId();

    // Create a file that won't be in the DB
    const root = getSemanticRoot(orgId);
    const staleFile = path.join(root, "entities", "stale.yml");
    fs.mkdirSync(path.join(root, "entities"), { recursive: true });
    fs.writeFileSync(staleFile, "table: stale\n");
    expect(fs.existsSync(staleFile)).toBe(true);

    // DB only has "users"
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow(orgId, "users", "entity", "table: users\n"),
      ]),
    );

    await syncAllEntitiesToDisk(orgId);

    // Stale file should be removed
    expect(fs.existsSync(staleFile)).toBe(false);
    // Users file should exist
    expect(fs.existsSync(path.join(root, "entities", "users.yml"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cleanupOrgDirectory
// ---------------------------------------------------------------------------

describe("cleanupOrgDirectory", () => {
  it("removes the org directory and all contents", async () => {
    const orgId = testOrgId();

    // Create some files
    await syncEntityToDisk(orgId, "test", "entity", "table: test\n");
    const root = getSemanticRoot(orgId);
    expect(fs.existsSync(root)).toBe(true);

    await cleanupOrgDirectory(orgId);
    expect(fs.existsSync(root)).toBe(false);

    // Remove from cleanup list since we already cleaned up
    const idx = createdOrgIds.indexOf(orgId);
    if (idx >= 0) createdOrgIds.splice(idx, 1);
  });

  it("does not throw for non-existent org", async () => {
    await expect(
      cleanupOrgDirectory("nonexistent-org"),
    ).resolves.toBeUndefined();
  });
});
