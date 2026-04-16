/**
 * Tests for `ensureOrgModeSemanticRoot` + `invalidateOrgModeRoots`.
 *
 * Covers the partial-build / invalidation-stamp / waiter-reenter scenarios
 * that guarantee published-mode explores never serve stale or partial YAML.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

import type { SemanticEntityRow } from "../entities";

let publishedRows: SemanticEntityRow[] = [];
let overlayRows: SemanticEntityRow[] = [];

const mockListEntities = mock(async (_orgId: string, _type?: string, status?: string) => {
  if (status === "published") return publishedRows;
  return [...publishedRows, ...overlayRows];
});

const mockListEntitiesWithOverlay = mock(async () => [...publishedRows, ...overlayRows]);

mock.module("@atlas/api/lib/semantic/entities", () => ({
  listEntities: mockListEntities,
  listEntitiesWithOverlay: mockListEntitiesWithOverlay,
  getEntity: async () => null,
  upsertEntity: async () => {},
  deleteEntity: async () => false,
  countEntities: async () => 0,
  bulkUpsertEntities: async () => 0,
  createVersion: async () => "v1",
  listVersions: async () => ({ versions: [], total: 0 }),
  getVersion: async () => null,
  generateChangeSummary: async () => null,
  SEMANTIC_ENTITY_STATUSES: ["published", "draft", "draft_delete", "archived"] as const,
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

const mod = await import("../sync");
const {
  ensureOrgModeSemanticRoot,
  invalidateOrgModeRoots,
  _resetModeBuildCache,
} = mod;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(name: string, status: SemanticEntityRow["status"] = "published"): SemanticEntityRow {
  return {
    id: `id-${name}-${status}`,
    org_id: "org-1",
    entity_type: "entity",
    name,
    yaml_content: `table: ${name}\n`,
    connection_id: null,
    status,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

let tmpRoot: string;
const ORIGINAL_SEMANTIC_ROOT = process.env.ATLAS_SEMANTIC_ROOT;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mode-root-"));
  process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;
  _resetModeBuildCache();
  publishedRows = [];
  overlayRows = [];
  mockListEntities.mockClear();
  mockListEntitiesWithOverlay.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_SEMANTIC_ROOT === undefined) delete process.env.ATLAS_SEMANTIC_ROOT;
  else process.env.ATLAS_SEMANTIC_ROOT = ORIGINAL_SEMANTIC_ROOT;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureOrgModeSemanticRoot", () => {
  it("builds the published mode directory from listEntities('published')", async () => {
    publishedRows = [row("users"), row("orders")];

    const root = await ensureOrgModeSemanticRoot("org-1", "published");

    expect(mockListEntities).toHaveBeenCalledWith("org-1", undefined, "published");
    expect(mockListEntitiesWithOverlay).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "entities", "users.yml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "entities", "orders.yml"))).toBe(true);
  });

  it("builds the developer mode directory from listEntitiesWithOverlay", async () => {
    publishedRows = [row("users", "published")];
    overlayRows = [row("staging", "draft")];

    const root = await ensureOrgModeSemanticRoot("org-1", "developer");

    expect(mockListEntitiesWithOverlay).toHaveBeenCalledWith("org-1");
    expect(fs.existsSync(path.join(root, "entities", "users.yml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "entities", "staging.yml"))).toBe(true);
  });

  it("is idempotent — second call does not rebuild from DB", async () => {
    publishedRows = [row("users")];
    await ensureOrgModeSemanticRoot("org-1", "published");
    await ensureOrgModeSemanticRoot("org-1", "published");
    expect(mockListEntities).toHaveBeenCalledTimes(1);
  });

  it("rebuilds after invalidateOrgModeRoots", async () => {
    publishedRows = [row("users")];
    await ensureOrgModeSemanticRoot("org-1", "published");
    expect(mockListEntities).toHaveBeenCalledTimes(1);

    // Entity CRUD invalidates
    invalidateOrgModeRoots("org-1");

    publishedRows = [row("users"), row("orders")];
    const root = await ensureOrgModeSemanticRoot("org-1", "published");
    expect(mockListEntities).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(root, "entities", "orders.yml"))).toBe(true);
  });

  it("invalidation that fires DURING a build prevents the stale result from being cached", async () => {
    // Setup: first build returns rows whose write resolves on a deferred promise.
    // We trigger invalidateOrgModeRoots() between "list returned" and "writes
    // completed" so the invalidation stamp advances mid-build.
    publishedRows = [row("users"), row("orders")];

    // Custom list implementation that delays resolution so we can inject the
    // invalidation precisely between list-return and write-completion.
    let resolveList: (rows: SemanticEntityRow[]) => void;
    const delayedList = new Promise<SemanticEntityRow[]>((r) => { resolveList = r; });
    mockListEntities.mockImplementationOnce(async () => delayedList);

    const firstBuild = ensureOrgModeSemanticRoot("org-1", "published");

    // Let the microtask queue run so the build is awaiting the list
    await new Promise((r) => setTimeout(r, 0));

    // Fire invalidation before the list resolves — stamp now advances
    invalidateOrgModeRoots("org-1");

    // Now let the build proceed
    resolveList!(publishedRows);
    await firstBuild;

    // The next call must re-list, not trust the stale build
    publishedRows = [row("users")]; // simulate the CRUD that invalidated
    await ensureOrgModeSemanticRoot("org-1", "published");
    expect(mockListEntities).toHaveBeenCalledTimes(2);
  });

  it("published and developer roots don't interfere — building one does not mark the other as built", async () => {
    publishedRows = [row("pub")];
    overlayRows = [row("draft", "draft")];

    await ensureOrgModeSemanticRoot("org-1", "published");
    await ensureOrgModeSemanticRoot("org-1", "developer");

    expect(mockListEntities).toHaveBeenCalledTimes(1);
    expect(mockListEntitiesWithOverlay).toHaveBeenCalledTimes(1);
  });

  it("concurrent callers for the same (org, mode) share a single build", async () => {
    publishedRows = [row("users")];
    const [a, b, c] = await Promise.all([
      ensureOrgModeSemanticRoot("org-1", "published"),
      ensureOrgModeSemanticRoot("org-1", "published"),
      ensureOrgModeSemanticRoot("org-1", "published"),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(mockListEntities).toHaveBeenCalledTimes(1);
  });
});
