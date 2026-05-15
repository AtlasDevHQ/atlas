/**
 * Tests for group-scoped `getEntity` + `deleteEntity` (#2412).
 *
 * After the 0063 partial-index shift, `connection_group_id` is part of the
 * natural key. Helpers that don't include the column in their predicate
 * silently operate on whichever row Postgres returned first when the same
 * `(org, type, name)` triple exists in multiple groups.
 *
 * - `getEntity` must accept an optional `connectionGroupId` and throw
 *   `AmbiguousEntityError` when the result would otherwise be ambiguous.
 * - `deleteEntity` must require the group so it can never cross-group
 *   cascade — it's a dormant export today but the foot-gun exists.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Capture internalQuery calls so we can assert SQL + params + return shape.
// ---------------------------------------------------------------------------

interface CapturedCall {
  sql: string;
  params: unknown[] | undefined;
}

const capturedCalls: CapturedCall[] = [];
let mockRows: Record<string, unknown>[] = [];

// Per-call queue lets tests stage multiple result sets (e.g. ambiguity probe
// followed by the actual fetch) without juggling implementation overrides.
const queuedRows: Record<string, unknown>[][] = [];

function resetCapture(): void {
  capturedCalls.length = 0;
  mockRows = [];
  queuedRows.length = 0;
}

const mockInternalQuery = mock(async (sql: string, params?: unknown[]) => {
  capturedCalls.push({ sql, params });
  if (queuedRows.length > 0) {
    return queuedRows.shift() ?? [];
  }
  return mockRows;
});

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  internalExecute: mock(async () => 0),
  getInternalDB: mock(() => {
    throw new Error("not configured");
  }),
  _resetPool: mock(() => {}),
  encryptSecret: mock((u: string) => u),
  decryptSecret: mock((u: string) => u),
}));

// Cache-busting import so the mocked module is picked up.
const entitiesPath = resolve(__dirname, "../entities.ts");
const entitiesMod = await import(`${entitiesPath}?t=${Date.now()}`);
const getEntity = entitiesMod.getEntity as typeof import("../entities").getEntity;
const deleteEntity = entitiesMod.deleteEntity as typeof import("../entities").deleteEntity;
const AmbiguousEntityError =
  entitiesMod.AmbiguousEntityError as typeof import("../entities").AmbiguousEntityError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MakeRowOpts {
  name?: string;
  connectionGroupId?: string | null;
  status?: "published" | "draft" | "draft_delete" | "archived";
}

function makeRow(opts: MakeRowOpts = {}): Record<string, unknown> {
  return {
    id: `id-${opts.name ?? "users"}-${opts.connectionGroupId ?? "null"}`,
    org_id: "org-1",
    entity_type: "entity",
    name: opts.name ?? "users",
    yaml_content: `table: ${opts.name ?? "users"}\n`,
    connection_group_id: opts.connectionGroupId ?? null,
    status: opts.status ?? "published",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

// ---------------------------------------------------------------------------
// getEntity ambiguity behaviour
// ---------------------------------------------------------------------------

describe("getEntity — backward compatible without group", () => {
  beforeEach(() => {
    resetCapture();
  });

  it("returns the single matching row when only one group has the entity", async () => {
    queuedRows.push([makeRow({ connectionGroupId: "g_prod" })]);

    const row = await getEntity("org-1", "entity", "users");

    expect(row).not.toBeNull();
    expect(row?.connection_group_id).toBe("g_prod");
    expect(capturedCalls.length).toBeGreaterThan(0);
  });

  it("returns null when no row matches", async () => {
    queuedRows.push([]);

    const row = await getEntity("org-1", "entity", "absent");

    expect(row).toBeNull();
  });

  it("throws AmbiguousEntityError when the (org, type, name) maps to >1 group", async () => {
    queuedRows.push([
      makeRow({ connectionGroupId: "g_prod_us" }),
      makeRow({ connectionGroupId: "g_prod_eu" }),
    ]);

    let caught: unknown;
    try {
      await getEntity("org-1", "entity", "users");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AmbiguousEntityError);
    if (caught instanceof AmbiguousEntityError) {
      expect(caught._tag).toBe("AmbiguousEntityError");
      expect(caught.entityName).toBe("users");
      expect(caught.entityType).toBe("entity");
      // Groups should be sorted for deterministic error messages.
      expect([...caught.groups].toSorted()).toEqual(["g_prod_eu", "g_prod_us"]);
    }
  });

  it("does NOT throw when single group has BOTH published and draft (overlay state)", async () => {
    // Regression for #2412 follow-up: the original unique-or-409 probe
    // pulled all rows matching (org, type, name) without status filtering,
    // so a single-group org with a published row + a draft row (the
    // normal post-edit state) tripped a false-positive 409. The fixed
    // SQL deduplicates by connection_group_id before counting; a single
    // group is single-group, period — overlay rows must collapse here.
    queuedRows.push([
      // What the DB-side DISTINCT ON returns: one row per group, draft wins.
      makeRow({ connectionGroupId: "g_prod_us", status: "draft" }),
    ]);

    const row = await getEntity("org-1", "entity", "users");

    expect(row).not.toBeNull();
    expect(row?.connection_group_id).toBe("g_prod_us");
    expect(row?.status).toBe("draft");
  });

  it("emits a DISTINCT ON SQL form so single-group overlay is collapsed at the DB", async () => {
    queuedRows.push([makeRow({ connectionGroupId: "g_prod_us" })]);

    await getEntity("org-1", "entity", "users");

    const lastCall = capturedCalls[capturedCalls.length - 1];
    expect(lastCall.sql.toUpperCase()).toContain("DISTINCT ON");
    expect(lastCall.sql.toUpperCase()).toContain("CONNECTION_GROUP_ID");
    // Filter to overlay-effective statuses (draft_delete in the inner
    // CTE, then excluded by the outer WHERE).
    expect(lastCall.sql).toMatch(/STATUS IN \('PUBLISHED', 'DRAFT', 'DRAFT_DELETE'\)/i);
    // Multi-tenant safety: every probe must include org_id predicate.
    expect(lastCall.sql).toMatch(/org_id\s*=\s*\$1/);
  });

  it("returns null when the only group's effective row is a draft_delete tombstone", async () => {
    // The outer WHERE excludes tombstones; an org with a single-group
    // draft_delete returns zero rows, which getEntity reports as null
    // to match overlay semantics.
    queuedRows.push([]);

    const row = await getEntity("org-1", "entity", "users");

    expect(row).toBeNull();
  });
});

describe("getEntity — group-scoped lookup", () => {
  beforeEach(() => {
    resetCapture();
  });

  it("filters by connection_group_id when caller passes a group", async () => {
    queuedRows.push([makeRow({ connectionGroupId: "g_prod_us" })]);

    const row = await getEntity("org-1", "entity", "users", "g_prod_us");

    expect(row).not.toBeNull();
    expect(row?.connection_group_id).toBe("g_prod_us");

    // Verify the SQL carries a group-id predicate. The shape can be
    // either `IS NOT DISTINCT FROM $N` (null-safe) or an explicit `=`
    // when the group is non-null — both satisfy the requirement.
    const lastCall = capturedCalls[capturedCalls.length - 1];
    expect(lastCall.sql).toContain("connection_group_id");
    expect(lastCall.params).toContain("g_prod_us");
    // Multi-tenant safety predicate.
    expect(lastCall.sql).toMatch(/org_id\s*=\s*\$1/);
  });

  it("filters to NULL group when caller passes null explicitly (legacy scope)", async () => {
    queuedRows.push([makeRow({ connectionGroupId: null })]);

    const row = await getEntity("org-1", "entity", "users", null);

    expect(row).not.toBeNull();
    expect(row?.connection_group_id).toBeNull();
    const lastCall = capturedCalls[capturedCalls.length - 1];
    expect(lastCall.sql).toContain("connection_group_id");
    // null-safe predicate via IS NOT DISTINCT FROM keeps the null match working
    expect(lastCall.sql.toUpperCase()).toContain("IS NOT DISTINCT FROM");
  });

  it("does NOT throw on multiple shadow rows when the caller scoped to one group", async () => {
    // Even if the DB held two rows across groups, an explicit scope means
    // the caller already disambiguated — return the matching row.
    queuedRows.push([makeRow({ connectionGroupId: "g_prod_us" })]);

    const row = await getEntity("org-1", "entity", "users", "g_prod_us");

    expect(row).not.toBeNull();
    expect(row?.connection_group_id).toBe("g_prod_us");
  });

  it("prefers draft over published when both exist for the same scoped group", async () => {
    // The DB-side ORDER BY draft=1 / published=2 + LIMIT 1 means a group
    // carrying both rows surfaces the draft. The mock returns whatever
    // we put first; we assert the SQL shape carries the priority order.
    queuedRows.push([makeRow({ connectionGroupId: "g_prod_us", status: "draft" })]);

    const row = await getEntity("org-1", "entity", "users", "g_prod_us");

    expect(row?.status).toBe("draft");
    const lastCall = capturedCalls[capturedCalls.length - 1];
    expect(lastCall.sql.toUpperCase()).toContain("CASE STATUS");
    expect(lastCall.sql).toMatch(/'draft'\s+THEN\s+1/);
    expect(lastCall.sql).toMatch(/LIMIT 1/i);
  });

  it("returns null when the scoped group's effective row is a tombstone", async () => {
    // Scoped query returns the draft_delete row at top of overlay order;
    // getEntity reports null to match overlay-hides-published semantics.
    queuedRows.push([
      makeRow({ connectionGroupId: "g_prod_us", status: "draft_delete" }),
    ]);

    const row = await getEntity("org-1", "entity", "users", "g_prod_us");

    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteEntity — must require + filter on connectionGroupId
// ---------------------------------------------------------------------------

describe("deleteEntity — group-scoped", () => {
  beforeEach(() => {
    resetCapture();
  });

  it("includes connection_group_id in the DELETE predicate when scoped to a group", async () => {
    queuedRows.push([{ id: "deleted-1" }]);

    const ok = await deleteEntity("org-1", "entity", "users", "g_prod_us");

    expect(ok).toBe(true);
    const lastCall = capturedCalls[capturedCalls.length - 1];
    expect(lastCall.sql).toContain("DELETE FROM semantic_entities");
    expect(lastCall.sql).toContain("connection_group_id");
    expect(lastCall.params).toContain("g_prod_us");
  });

  it("uses IS NOT DISTINCT FROM for null-scope deletes (legacy global rows)", async () => {
    queuedRows.push([{ id: "deleted-null" }]);

    const ok = await deleteEntity("org-1", "entity", "users", null);

    expect(ok).toBe(true);
    const lastCall = capturedCalls[capturedCalls.length - 1];
    expect(lastCall.sql).toContain("connection_group_id");
    expect(lastCall.sql.toUpperCase()).toContain("IS NOT DISTINCT FROM");
  });

  it("does not delete rows in other groups (predicate-only assertion)", async () => {
    queuedRows.push([]);

    const ok = await deleteEntity("org-1", "entity", "users", "g_prod_eu");

    // The mocked query returns no rows — function returns false. The
    // real-PG smoke test in migrate-pg.test.ts is what proves the
    // cross-group isolation; here we only check the SQL carries the
    // predicate so it can't degenerate back to cross-group DELETE.
    expect(ok).toBe(false);
    const lastCall = capturedCalls[capturedCalls.length - 1];
    expect(lastCall.sql).toContain("connection_group_id");
    expect(lastCall.params).toContain("g_prod_eu");
  });
});
