/**
 * Mode-aware agent isolation tests.
 *
 * Verifies that in published mode the agent has zero knowledge of draft
 * connections and entities, while in developer mode it sees the overlay.
 * Covers the visibility predicate and mode-specific semantic root path
 * resolution — the two primitives the agent pipeline depends on.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock internal DB — returns status-filtered rows for connections and entities
// ---------------------------------------------------------------------------

type ConnectionRow = {
  id: string;
  org_id: string;
  status: "published" | "draft" | "archived";
};

let connectionRows: ConnectionRow[] = [];

const mockInternalQuery = mock(async (sql: string, params?: unknown[]) => {
  const [orgIdParam, idParam] = (params ?? []) as string[];

  if (sql.includes("FROM connections")) {
    const published = sql.includes("status = 'published'");
    const overlay = sql.includes("status IN ('published', 'draft')");
    const allowedStatuses = new Set<"published" | "draft">(
      overlay ? ["published", "draft"] : published ? ["published"] : ["published"],
    );
    return connectionRows.filter(
      (r) => r.org_id === orgIdParam
        && r.id === idParam
        && allowedStatuses.has(r.status as "published" | "draft"),
    ).map((r) => ({ id: r.id }));
  }

  return [];
});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: mockInternalQuery,
  internalExecute: async () => {},
  encryptUrl: (u: string) => u,
  decryptUrl: (u: string) => u,
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

const {
  isConnectionVisibleInMode,
} = await import("@atlas/api/lib/db/connection");

const syncMod = await import("@atlas/api/lib/semantic/sync");
const { getSemanticRoot } = syncMod;

// ---------------------------------------------------------------------------
// Connection visibility
// ---------------------------------------------------------------------------

describe("isConnectionVisibleInMode", () => {
  beforeEach(() => {
    connectionRows = [];
    mockInternalQuery.mockClear();
  });

  it("'default' is always visible regardless of mode (config-managed, no DB row)", async () => {
    expect(await isConnectionVisibleInMode("org-1", "default", "published")).toBe(true);
    expect(await isConnectionVisibleInMode("org-1", "default", "developer")).toBe(true);
    // Should not query the DB for 'default'
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("published connection visible in both modes", async () => {
    connectionRows = [{ id: "warehouse", org_id: "org-1", status: "published" }];
    expect(await isConnectionVisibleInMode("org-1", "warehouse", "published")).toBe(true);
    expect(await isConnectionVisibleInMode("org-1", "warehouse", "developer")).toBe(true);
  });

  it("draft connection hidden in published mode, visible in developer mode", async () => {
    connectionRows = [{ id: "staging", org_id: "org-1", status: "draft" }];
    expect(await isConnectionVisibleInMode("org-1", "staging", "published")).toBe(false);
    expect(await isConnectionVisibleInMode("org-1", "staging", "developer")).toBe(true);
  });

  it("archived connection never visible", async () => {
    connectionRows = [{ id: "legacy", org_id: "org-1", status: "archived" }];
    expect(await isConnectionVisibleInMode("org-1", "legacy", "published")).toBe(false);
    expect(await isConnectionVisibleInMode("org-1", "legacy", "developer")).toBe(false);
  });

  it("connection from a different org is never visible", async () => {
    connectionRows = [{ id: "warehouse", org_id: "org-2", status: "published" }];
    expect(await isConnectionVisibleInMode("org-1", "warehouse", "published")).toBe(false);
    expect(await isConnectionVisibleInMode("org-1", "warehouse", "developer")).toBe(false);
  });

  it("unknown connection never visible", async () => {
    connectionRows = [];
    expect(await isConnectionVisibleInMode("org-1", "nowhere", "published")).toBe(false);
    expect(await isConnectionVisibleInMode("org-1", "nowhere", "developer")).toBe(false);
  });

  it("fails closed on internal DB error (returns false)", async () => {
    // Highest-leverage bypass vector: a DB throw that silently allows access.
    // The catch arm must deny, not allow.
    mockInternalQuery.mockImplementationOnce(async () => {
      throw new Error("simulated internal DB outage");
    });
    expect(await isConnectionVisibleInMode("org-1", "warehouse", "published")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Semantic root resolution
// ---------------------------------------------------------------------------

describe("getSemanticRoot — mode-specific directories", () => {
  it("returns legacy path when no mode is supplied", () => {
    const root = getSemanticRoot("org-1");
    expect(root.endsWith("/.orgs/org-1")).toBe(true);
  });

  it("returns mode-specific subdirectory for published mode", () => {
    const root = getSemanticRoot("org-1", "published");
    expect(root.endsWith("/.orgs/org-1/modes/published")).toBe(true);
  });

  it("returns mode-specific subdirectory for developer mode", () => {
    const root = getSemanticRoot("org-1", "developer");
    expect(root.endsWith("/.orgs/org-1/modes/developer")).toBe(true);
  });

  it("rejects path traversal in orgId even with a mode", () => {
    expect(() => getSemanticRoot("../evil", "published")).toThrow();
  });

  it("published and developer roots are distinct — explore isolation depends on separate directories", () => {
    const pub = getSemanticRoot("org-1", "published");
    const dev = getSemanticRoot("org-1", "developer");
    expect(pub).not.toBe(dev);
    // Published and developer must not share a parent — otherwise a filesystem
    // glob from one could see the other's YAML content.
    expect(pub.endsWith("/modes/published")).toBe(true);
    expect(dev.endsWith("/modes/developer")).toBe(true);
  });
});
