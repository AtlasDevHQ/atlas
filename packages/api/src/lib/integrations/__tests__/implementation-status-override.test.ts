/**
 * Tests for `applyImplementationStatusOverride` (1.5.3 slice 9 #2747).
 *
 * Two surfaces under test:
 *
 *   - `planImplementationStatusOverride` (pure) — input/output, no mocks.
 *   - `applyImplementationStatusOverride` (DB driver) — drives a
 *     hand-rolled mock, asserts UPDATE params and slug matching.
 *
 * The override is the LAST writer on `plugin_catalog.implementation_status`
 * for the boot — anything that runs after this point would clobber it.
 * The Effect Layer (`ImplementationStatusOverrideLive` in
 * `effect/layers.ts`) enforces this by depending on both `CatalogSeed`
 * and `BuiltinDatasourceCatalogSeed`.
 */

import { describe, it, expect } from "bun:test";
import {
  planImplementationStatusOverride,
  applyImplementationStatusOverride,
  type CurrentCatalogRow,
  type ImplementationStatusOverrideDb,
} from "../implementation-status-override";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

interface Captured {
  sql: string;
  params: unknown[];
}

function makeMockDb(catalog: CurrentCatalogRow[]): {
  db: ImplementationStatusOverrideDb;
  captured: Captured[];
  rows: CurrentCatalogRow[];
} {
  const rows = [...catalog];
  const captured: Captured[] = [];

  const db: ImplementationStatusOverrideDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const ps = params ?? [];
      captured.push({ sql, params: ps });

      if (sql.includes("SELECT slug, implementation_status")) {
        return {
          rows: rows.map((r) => ({
            slug: r.slug,
            implementation_status: r.implementationStatus,
          })) as T[],
        };
      }
      if (sql.includes("UPDATE plugin_catalog")) {
        const [to, slug] = ps as [string, string];
        const idx = rows.findIndex((r) => r.slug === slug);
        if (idx !== -1) {
          rows[idx] = {
            slug,
            implementationStatus: to as CurrentCatalogRow["implementationStatus"],
          };
        }
        return { rows: [] as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  return { db, captured, rows };
}

// ---------------------------------------------------------------------------
// planImplementationStatusOverride (pure)
// ---------------------------------------------------------------------------

describe("planImplementationStatusOverride", () => {
  it("emits an UPDATE action for every slug whose current status differs", () => {
    const plan = planImplementationStatusOverride(
      { discord: "available", teams: "coming_soon" },
      [
        { slug: "discord", implementationStatus: "coming_soon" },
        { slug: "teams", implementationStatus: "available" },
      ],
    );
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions).toContainEqual({
      slug: "discord",
      from: "coming_soon",
      to: "available",
    });
    expect(plan.actions).toContainEqual({
      slug: "teams",
      from: "available",
      to: "coming_soon",
    });
    expect(plan.unmatchedSlugs).toEqual([]);
    expect(plan.noopSlugs).toEqual([]);
  });

  it("skips slugs already at the declared status", () => {
    const plan = planImplementationStatusOverride(
      { discord: "coming_soon" },
      [{ slug: "discord", implementationStatus: "coming_soon" }],
    );
    expect(plan.actions).toEqual([]);
    expect(plan.noopSlugs).toEqual(["discord"]);
  });

  it("surfaces unmatched slugs without emitting an action", () => {
    const plan = planImplementationStatusOverride(
      { typo_slack: "available", discord: "available" },
      [{ slug: "discord", implementationStatus: "coming_soon" }],
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.slug).toBe("discord");
    expect(plan.unmatchedSlugs).toEqual(["typo_slack"]);
  });

  it("empty override → empty plan", () => {
    const plan = planImplementationStatusOverride({}, [
      { slug: "discord", implementationStatus: "coming_soon" },
    ]);
    expect(plan.actions).toEqual([]);
    expect(plan.unmatchedSlugs).toEqual([]);
    expect(plan.noopSlugs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyImplementationStatusOverride (DB driver)
// ---------------------------------------------------------------------------

describe("applyImplementationStatusOverride", () => {
  it("issues an UPDATE per actionable slug and reports counts", async () => {
    const { db, captured, rows } = makeMockDb([
      { slug: "discord", implementationStatus: "coming_soon" },
      { slug: "slack", implementationStatus: "available" },
    ]);
    const result = await applyImplementationStatusOverride(db, {
      discord: "available",
    });
    expect(result.updatedCount).toBe(1);
    expect(result.unmatchedSlugs).toEqual([]);
    expect(rows.find((r) => r.slug === "discord")?.implementationStatus).toBe(
      "available",
    );

    const updates = captured.filter((c) =>
      c.sql.includes("UPDATE plugin_catalog"),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.params).toEqual(["available", "discord"]);
  });

  it("empty override map is a fast no-op (no SELECT, no UPDATE)", async () => {
    const { db, captured } = makeMockDb([
      { slug: "discord", implementationStatus: "coming_soon" },
    ]);
    const result = await applyImplementationStatusOverride(db, {});
    expect(result.updatedCount).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it("operator typo (unmatched slug) is surfaced, not silently ignored", async () => {
    const { db } = makeMockDb([
      { slug: "discord", implementationStatus: "coming_soon" },
    ]);
    const result = await applyImplementationStatusOverride(db, {
      diskord: "available",
    });
    expect(result.updatedCount).toBe(0);
    expect(result.unmatchedSlugs).toEqual(["diskord"]);
  });

  it("override already-at-target is a noop (no UPDATE issued)", async () => {
    const { db, captured } = makeMockDb([
      { slug: "discord", implementationStatus: "coming_soon" },
    ]);
    const result = await applyImplementationStatusOverride(db, {
      discord: "coming_soon",
    });
    expect(result.updatedCount).toBe(0);
    expect(result.noopSlugs).toEqual(["discord"]);
    const updates = captured.filter((c) => c.sql.includes("UPDATE plugin_catalog"));
    expect(updates).toHaveLength(0);
  });

  it("drops DB rows with unknown implementation_status from the planner input (fail-safe)", async () => {
    // Mirror's the catalog-seeder's "drop unknown enum rows" posture.
    // A corrupt-seed row with `implementation_status='legacy'` shouldn't
    // poison the planner — the row simply won't match the override slug
    // and the override gets `unmatchedSlugs` for that key, signalling
    // operator drift in the log line.
    const db: ImplementationStatusOverrideDb = {
      query: async <T = unknown>(sql: string) => {
        if (sql.includes("SELECT slug, implementation_status")) {
          return {
            rows: [
              { slug: "legacy", implementation_status: "bogus-value" },
              { slug: "discord", implementation_status: "coming_soon" },
            ] as T[],
          };
        }
        return { rows: [] as T[] };
      },
    };
    const result = await applyImplementationStatusOverride(db, {
      legacy: "available",
      discord: "available",
    });
    expect(result.updatedCount).toBe(1); // discord only
    expect(result.unmatchedSlugs).toEqual(["legacy"]);
  });
});
