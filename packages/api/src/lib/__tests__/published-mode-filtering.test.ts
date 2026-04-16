/**
 * Tests for published mode query filtering (#1426) and COALESCE index (#1444).
 *
 * Covers:
 * - listEntities statusFilter parameter
 * - loadOrgWhitelist mode-aware caching
 * - getOrgWhitelistedTables mode-aware lookup
 * - Published mode returns only published entities
 * - Developer mode returns all entities (published + draft + draft_delete)
 * - Mode-specific cache isolation
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Mock the DB layer
// ---------------------------------------------------------------------------

import type { SemanticEntityRow, SemanticEntityStatus } from "../semantic/entities";

let storedEntities: SemanticEntityRow[] = [];

const mockListEntities = mock(
  (_orgId: string, _entityType?: string, statusFilter?: SemanticEntityStatus) => {
    if (statusFilter) {
      return Promise.resolve(storedEntities.filter((e) => e.status === statusFilter));
    }
    return Promise.resolve(storedEntities);
  },
);
// Developer-mode overlay: returns published + draft rows, excludes draft_delete/archived.
// Close enough to the real CTE behavior for whitelist tests — drafts supersede drops
// are handled at SQL level but this mock doesn't need to model tombstones for whitelisting.
const mockListEntitiesWithOverlay = mock((_orgId: string, _entityType?: string) =>
  Promise.resolve(storedEntities.filter((e) => e.status === "published" || e.status === "draft")),
);
const mockGetEntity = mock((): Promise<SemanticEntityRow | null> => Promise.resolve(null));
const mockUpsertEntity = mock((): Promise<void> => Promise.resolve());
const mockDeleteEntity = mock((): Promise<boolean> => Promise.resolve(false));
const mockCountEntities = mock((): Promise<number> => Promise.resolve(0));
const mockBulkUpsertEntities = mock((): Promise<number> => Promise.resolve(0));
const mockCreateVersion = mock((): Promise<string> => Promise.resolve("v1"));
const mockListVersions = mock(() => Promise.resolve({ versions: [], total: 0 }));
const mockGetVersion = mock((): Promise<null> => Promise.resolve(null));
const mockGenerateChangeSummary = mock((): Promise<string | null> => Promise.resolve(null));
const SEMANTIC_ENTITY_STATUSES = ["published", "draft", "draft_delete", "archived"] as const;

mock.module("@atlas/api/lib/semantic/entities", () => ({
  listEntities: mockListEntities,
  listEntitiesWithOverlay: mockListEntitiesWithOverlay,
  getEntity: mockGetEntity,
  upsertEntity: mockUpsertEntity,
  deleteEntity: mockDeleteEntity,
  countEntities: mockCountEntities,
  bulkUpsertEntities: mockBulkUpsertEntities,
  createVersion: mockCreateVersion,
  listVersions: mockListVersions,
  getVersion: mockGetVersion,
  generateChangeSummary: mockGenerateChangeSummary,
  SEMANTIC_ENTITY_STATUSES,
}));

// Cache-busting import
const modPath = resolve(__dirname, "../semantic/whitelist.ts");
const mod = await import(`${modPath}?t=${Date.now()}`);
const loadOrgWhitelist = mod.loadOrgWhitelist as typeof import("../semantic/whitelist").loadOrgWhitelist;
const getOrgWhitelistedTables = mod.getOrgWhitelistedTables as typeof import("../semantic/whitelist").getOrgWhitelistedTables;
const invalidateOrgWhitelist = mod.invalidateOrgWhitelist as typeof import("../semantic/whitelist").invalidateOrgWhitelist;
const _resetOrgWhitelists = mod._resetOrgWhitelists as typeof import("../semantic/whitelist")._resetOrgWhitelists;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntityRow(
  name: string,
  table: string,
  status: SemanticEntityStatus = "published",
  connectionId?: string,
): SemanticEntityRow {
  return {
    id: `id-${name}-${status}`,
    org_id: "org-1",
    entity_type: "entity" as const,
    name,
    yaml_content: `table: ${table}\n${connectionId ? `connection: ${connectionId}\n` : ""}`,
    connection_id: connectionId ?? null,
    status,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("published mode filtering", () => {
  beforeEach(() => {
    _resetOrgWhitelists();
    mockListEntities.mockReset();
    mockListEntitiesWithOverlay.mockReset();
    storedEntities = [];
    // Re-wire mocks to filter by status
    mockListEntities.mockImplementation(
      (_orgId: string, _entityType?: string, statusFilter?: SemanticEntityStatus) => {
        if (statusFilter) {
          return Promise.resolve(storedEntities.filter((e) => e.status === statusFilter));
        }
        return Promise.resolve(storedEntities);
      },
    );
    mockListEntitiesWithOverlay.mockImplementation(
      (_orgId: string, _entityType?: string) =>
        Promise.resolve(storedEntities.filter((e) => e.status === "published" || e.status === "draft")),
    );
  });

  describe("entity loader dispatch by mode", () => {
    it("published mode calls listEntities with 'published' status filter", async () => {
      storedEntities = [
        makeEntityRow("users", "users", "published"),
        makeEntityRow("users", "users", "draft"),
        makeEntityRow("orders", "orders", "published"),
      ];

      await loadOrgWhitelist("org-1", "published");
      expect(mockListEntities).toHaveBeenCalledWith("org-1", "entity", "published");
      expect(mockListEntitiesWithOverlay).not.toHaveBeenCalled();
    });

    it("developer mode calls listEntitiesWithOverlay (not listEntities)", async () => {
      storedEntities = [
        makeEntityRow("users", "users", "published"),
        makeEntityRow("users", "users", "draft"),
      ];

      await loadOrgWhitelist("org-1", "developer");
      expect(mockListEntitiesWithOverlay).toHaveBeenCalledWith("org-1", "entity");
      expect(mockListEntities).not.toHaveBeenCalled();
    });

    it("omitted mode falls back to listEntities with no status filter", async () => {
      storedEntities = [makeEntityRow("users", "users", "published")];

      await loadOrgWhitelist("org-1");
      expect(mockListEntities).toHaveBeenCalledWith("org-1", "entity", undefined);
      expect(mockListEntitiesWithOverlay).not.toHaveBeenCalled();
    });
  });

  describe("published mode returns only published entities", () => {
    it("published mode whitelist contains only published entity tables", async () => {
      storedEntities = [
        makeEntityRow("users", "users", "published"),
        makeEntityRow("orders", "orders", "draft"),
        makeEntityRow("events", "events", "draft_delete"),
      ];

      const result = await loadOrgWhitelist("org-1", "published");
      const tables = result.get("default") ?? new Set();
      expect(tables.has("users")).toBe(true);
      expect(tables.has("orders")).toBe(false);
      expect(tables.has("events")).toBe(false);
    });

    it("getOrgWhitelistedTables in published mode returns only published tables", async () => {
      storedEntities = [
        makeEntityRow("users", "users", "published"),
        makeEntityRow("orders", "orders", "draft"),
      ];

      await loadOrgWhitelist("org-1", "published");
      const tables = getOrgWhitelistedTables("org-1", "default", "published");
      expect(tables.has("users")).toBe(true);
      expect(tables.has("orders")).toBe(false);
    });
  });

  describe("developer mode returns overlay (published + draft, no tombstones)", () => {
    it("developer mode whitelist contains published + draft entity tables, excludes tombstones", async () => {
      storedEntities = [
        makeEntityRow("users", "users", "published"),
        makeEntityRow("orders", "orders", "draft"),
        makeEntityRow("events", "events", "draft_delete"),
      ];

      const result = await loadOrgWhitelist("org-1", "developer");
      const tables = result.get("default") ?? new Set();
      expect(tables.has("users")).toBe(true);
      expect(tables.has("orders")).toBe(true);
      // draft_delete targets are hidden by the overlay CTE
      expect(tables.has("events")).toBe(false);
    });

    it("getOrgWhitelistedTables in developer mode includes drafts alongside published", async () => {
      storedEntities = [
        makeEntityRow("users", "users", "published"),
        makeEntityRow("orders", "orders", "draft"),
      ];

      await loadOrgWhitelist("org-1", "developer");
      const tables = getOrgWhitelistedTables("org-1", "default", "developer");
      expect(tables.has("users")).toBe(true);
      expect(tables.has("orders")).toBe(true);
    });
  });

  describe("mode-specific cache isolation", () => {
    it("caches published and developer modes separately", async () => {
      storedEntities = [
        makeEntityRow("users", "users", "published"),
        makeEntityRow("orders", "orders", "draft"),
      ];

      // Load published mode first
      await loadOrgWhitelist("org-1", "published");
      const publishedTables = getOrgWhitelistedTables("org-1", "default", "published");
      expect(publishedTables.has("users")).toBe(true);
      expect(publishedTables.has("orders")).toBe(false);

      // Load developer mode — dispatches to the overlay loader (separate cache)
      await loadOrgWhitelist("org-1", "developer");
      const devTables = getOrgWhitelistedTables("org-1", "default", "developer");
      expect(devTables.has("users")).toBe(true);
      expect(devTables.has("orders")).toBe(true);

      // Both caches should coexist — published hit listEntities, developer hit the overlay
      expect(mockListEntities).toHaveBeenCalledTimes(1);
      expect(mockListEntitiesWithOverlay).toHaveBeenCalledTimes(1);
    });

    it("published cache hit does not return developer results", async () => {
      storedEntities = [
        makeEntityRow("users", "users", "published"),
        makeEntityRow("orders", "orders", "draft"),
      ];

      await loadOrgWhitelist("org-1", "published");
      await loadOrgWhitelist("org-1", "published"); // cache hit

      const tables = getOrgWhitelistedTables("org-1", "default", "published");
      expect(tables.has("orders")).toBe(false);
      expect(mockListEntities).toHaveBeenCalledTimes(1); // only one call due to cache
    });
  });

  describe("cache invalidation clears both modes", () => {
    it("invalidateOrgWhitelist clears both developer and published caches", async () => {
      storedEntities = [
        makeEntityRow("users", "users", "published"),
        makeEntityRow("orders", "orders", "draft"),
      ];

      // Load both caches
      await loadOrgWhitelist("org-1", "published");
      await loadOrgWhitelist("org-1", "developer");
      expect(mockListEntities).toHaveBeenCalledTimes(1);
      expect(mockListEntitiesWithOverlay).toHaveBeenCalledTimes(1);

      // Invalidate — should clear both
      invalidateOrgWhitelist("org-1");

      // Reload both — should hit the DB again (cache miss)
      await loadOrgWhitelist("org-1", "published");
      await loadOrgWhitelist("org-1", "developer");
      expect(mockListEntities).toHaveBeenCalledTimes(2);
      expect(mockListEntitiesWithOverlay).toHaveBeenCalledTimes(2);
    });

    it("invalidateOrgWhitelist clears published cache even when developer cache was not loaded", async () => {
      storedEntities = [makeEntityRow("users", "users", "published")];

      // Load only published cache
      await loadOrgWhitelist("org-1", "published");
      expect(mockListEntities).toHaveBeenCalledTimes(1);

      // Invalidate
      invalidateOrgWhitelist("org-1");

      // Reload published — should call listEntities again
      await loadOrgWhitelist("org-1", "published");
      expect(mockListEntities).toHaveBeenCalledTimes(2);
    });
  });
});
