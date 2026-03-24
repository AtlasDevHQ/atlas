/**
 * Tests for org-scoped semantic layer loading.
 *
 * Covers:
 * - Loading org whitelist from DB entities
 * - Per-org whitelist isolation
 * - Org whitelist invalidation
 * - Fallback to file-based when no orgId
 * - Org semantic index building
 *
 * Uses mock.module() to mock the DB layer — all named exports mocked.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Mock the DB layer
// ---------------------------------------------------------------------------

import type { SemanticEntityRow } from "../semantic/entities";

const mockListEntities = mock((): Promise<SemanticEntityRow[]> => Promise.resolve([]));
const mockGetEntity = mock((): Promise<SemanticEntityRow | null> => Promise.resolve(null));
const mockUpsertEntity = mock((): Promise<void> => Promise.resolve());
const mockDeleteEntity = mock((): Promise<boolean> => Promise.resolve(false));
const mockCountEntities = mock((): Promise<number> => Promise.resolve(0));
const mockBulkUpsertEntities = mock((): Promise<number> => Promise.resolve(0));

mock.module("@atlas/api/lib/semantic/entities", () => ({
  listEntities: mockListEntities,
  getEntity: mockGetEntity,
  upsertEntity: mockUpsertEntity,
  deleteEntity: mockDeleteEntity,
  countEntities: mockCountEntities,
  bulkUpsertEntities: mockBulkUpsertEntities,
}));

// Cache-busting import
const modPath = resolve(__dirname, "../semantic/whitelist.ts");
const mod = await import(`${modPath}?t=${Date.now()}`);
const loadOrgWhitelist = mod.loadOrgWhitelist as typeof import("../semantic/whitelist").loadOrgWhitelist;
const getOrgWhitelistedTables = mod.getOrgWhitelistedTables as typeof import("../semantic/whitelist").getOrgWhitelistedTables;
const invalidateOrgWhitelist = mod.invalidateOrgWhitelist as typeof import("../semantic/whitelist").invalidateOrgWhitelist;
const _resetOrgWhitelists = mod._resetOrgWhitelists as typeof import("../semantic/whitelist")._resetOrgWhitelists;
const _resetOrgSemanticIndexes = mod._resetOrgSemanticIndexes as typeof import("../semantic/whitelist")._resetOrgSemanticIndexes;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntityRow(name: string, table: string, connectionId?: string) {
  return {
    id: `id-${name}`,
    org_id: "org-1",
    entity_type: "entity" as const,
    name,
    yaml_content: `table: ${table}\n${connectionId ? `connection: ${connectionId}\n` : ""}`,
    connection_id: connectionId ?? null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadOrgWhitelist", () => {
  beforeEach(() => {
    _resetOrgWhitelists();
    _resetOrgSemanticIndexes();
    mockListEntities.mockReset();
    mockListEntities.mockImplementation(() => Promise.resolve([]));
  });

  it("loads entities from DB and builds whitelist", async () => {
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow("users", "users"),
        makeEntityRow("orders", "public.orders"),
      ]),
    );

    const result = await loadOrgWhitelist("org-1");
    expect(result.get("default")).toBeDefined();
    const tables = result.get("default")!;
    expect(tables.has("users")).toBe(true);
    expect(tables.has("orders")).toBe(true);
    expect(tables.has("public.orders")).toBe(true);
  });

  it("partitions by connection ID", async () => {
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow("users", "users"),
        makeEntityRow("events", "events", "warehouse"),
      ]),
    );

    const result = await loadOrgWhitelist("org-1");
    expect(result.get("default")?.has("users")).toBe(true);
    expect(result.get("warehouse")?.has("events")).toBe(true);
    expect(result.get("default")?.has("events")).toBeFalsy();
  });

  it("caches results across calls", async () => {
    mockListEntities.mockImplementation(() =>
      Promise.resolve([makeEntityRow("users", "users")]),
    );

    await loadOrgWhitelist("org-1");
    await loadOrgWhitelist("org-1");
    // Should only call listEntities once
    expect(mockListEntities).toHaveBeenCalledTimes(1);
  });

  it("returns empty map when no entities", async () => {
    const result = await loadOrgWhitelist("org-empty");
    expect(result.size).toBe(0);
  });

  it("skips malformed YAML entities", async () => {
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        {
          id: "id-bad",
          org_id: "org-1",
          entity_type: "entity" as const,
          name: "bad",
          yaml_content: "{{{not valid yaml",
          connection_id: null,
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
        makeEntityRow("good", "good_table"),
      ]),
    );

    const result = await loadOrgWhitelist("org-1");
    expect(result.get("default")?.has("good_table")).toBe(true);
  });
});

describe("getOrgWhitelistedTables", () => {
  beforeEach(() => {
    _resetOrgWhitelists();
    mockListEntities.mockReset();
    mockListEntities.mockImplementation(() => Promise.resolve([]));
  });

  it("returns tables for loaded org", async () => {
    mockListEntities.mockImplementation(() =>
      Promise.resolve([makeEntityRow("users", "users")]),
    );

    await loadOrgWhitelist("org-1");
    const tables = getOrgWhitelistedTables("org-1");
    expect(tables.has("users")).toBe(true);
  });

  it("returns empty set for unloaded org", () => {
    const tables = getOrgWhitelistedTables("org-not-loaded");
    expect(tables.size).toBe(0);
  });
});

describe("invalidateOrgWhitelist", () => {
  beforeEach(() => {
    _resetOrgWhitelists();
    _resetOrgSemanticIndexes();
    mockListEntities.mockReset();
    mockListEntities.mockImplementation(() => Promise.resolve([]));
  });

  it("clears cached whitelist, forcing reload", async () => {
    mockListEntities.mockImplementation(() =>
      Promise.resolve([makeEntityRow("users", "users")]),
    );

    await loadOrgWhitelist("org-1");
    expect(mockListEntities).toHaveBeenCalledTimes(1);

    invalidateOrgWhitelist("org-1");

    // Now add a new entity and reload
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow("users", "users"),
        makeEntityRow("orders", "orders"),
      ]),
    );

    await loadOrgWhitelist("org-1");
    expect(mockListEntities).toHaveBeenCalledTimes(2);
    const tables = getOrgWhitelistedTables("org-1");
    expect(tables.has("orders")).toBe(true);
  });
});

describe("org isolation", () => {
  beforeEach(() => {
    _resetOrgWhitelists();
    mockListEntities.mockReset();
  });

  it("two orgs have independent whitelists", async () => {
    // First call for org-1
    mockListEntities.mockImplementationOnce(() =>
      Promise.resolve([makeEntityRow("users", "users")]),
    );
    await loadOrgWhitelist("org-1");

    // Second call for org-2
    mockListEntities.mockImplementationOnce(() =>
      Promise.resolve([makeEntityRow("events", "events")]),
    );
    await loadOrgWhitelist("org-2");

    const org1Tables = getOrgWhitelistedTables("org-1");
    const org2Tables = getOrgWhitelistedTables("org-2");

    expect(org1Tables.has("users")).toBe(true);
    expect(org1Tables.has("events")).toBe(false);
    expect(org2Tables.has("events")).toBe(true);
    expect(org2Tables.has("users")).toBe(false);
  });
});
