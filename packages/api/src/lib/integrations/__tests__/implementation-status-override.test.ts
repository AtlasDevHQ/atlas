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

import { describe, it, expect, mock, afterEach } from "bun:test";
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

/**
 * Mock pool that emulates pg's BEGIN/COMMIT/ROLLBACK transactions.
 * UPDATEs inside a BEGIN write to `pending` instead of `rows`; on
 * COMMIT they merge in, on ROLLBACK they drop. This is enough fidelity
 * to assert the override consumer's atomicity guarantee.
 *
 * `failOnUpdateFor` (optional) — slug for which the mock throws on
 * UPDATE. Used to exercise the rollback path.
 */
function makeMockDb(
  catalog: CurrentCatalogRow[],
  opts: { failOnUpdateFor?: string } = {},
): {
  db: ImplementationStatusOverrideDb;
  captured: Captured[];
  rows: CurrentCatalogRow[];
} {
  const rows = [...catalog];
  const captured: Captured[] = [];
  let pending: CurrentCatalogRow[] | null = null;

  const db: ImplementationStatusOverrideDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const ps = params ?? [];
      captured.push({ sql, params: ps });

      if (sql === "BEGIN") {
        pending = [...rows];
        return { rows: [] as T[] };
      }
      if (sql === "COMMIT") {
        if (pending !== null) {
          rows.splice(0, rows.length, ...pending);
          pending = null;
        }
        return { rows: [] as T[] };
      }
      if (sql === "ROLLBACK") {
        pending = null;
        return { rows: [] as T[] };
      }

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
        if (opts.failOnUpdateFor === slug) {
          throw new Error(`Mock: simulated UPDATE failure for slug=${slug}`);
        }
        const target = pending ?? rows;
        const idx = target.findIndex((r) => r.slug === slug);
        if (idx !== -1) {
          target[idx] = {
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

  it("flips a slug back and forth across two passes", async () => {
    // Boot-cycle regression guard: the UPDATE must drive the row to
    // whatever the override declares, not just toward `coming_soon`
    // or just toward `available`. A copy-paste regression that pinned
    // one direction would silently break override-flips on subsequent
    // deploys.
    const { db, rows } = makeMockDb([
      { slug: "discord", implementationStatus: "coming_soon" },
    ]);

    await applyImplementationStatusOverride(db, { discord: "available" });
    expect(rows.find((r) => r.slug === "discord")?.implementationStatus).toBe(
      "available",
    );

    await applyImplementationStatusOverride(db, { discord: "coming_soon" });
    expect(rows.find((r) => r.slug === "discord")?.implementationStatus).toBe(
      "coming_soon",
    );
  });

  it("operates on built-in datasource rows (the Layer's BuiltinDatasourceCatalogSeed dep invites this)", async () => {
    // The override consumer does NOT filter by pillar — `SELECT slug,
    // implementation_status FROM plugin_catalog` is pillar-agnostic.
    // A self-host operator who's deliberately marking the demo
    // dataset `coming_soon` (e.g. it's wedged) should be able to.
    // Pinning the contract: any catalog slug is a valid override
    // target, including the built-in Datasource set.
    const { db, captured, rows } = makeMockDb([
      { slug: "demo-postgres", implementationStatus: "available" },
    ]);
    const result = await applyImplementationStatusOverride(db, {
      "demo-postgres": "coming_soon",
    });
    expect(result.updatedCount).toBe(1);
    expect(rows[0]!.implementationStatus).toBe("coming_soon");
    const updates = captured.filter((c) =>
      c.sql.includes("UPDATE plugin_catalog"),
    );
    expect(updates[0]!.params).toEqual(["coming_soon", "demo-postgres"]);
  });

  it("wraps multi-slug UPDATEs in a single transaction (BEGIN/COMMIT)", async () => {
    // Codex P2 on #2782: a mid-loop failure must not leave a partial
    // override applied. Assert the boundary commands fire so the
    // atomic semantic is pinned by a structural test.
    const { db, captured } = makeMockDb([
      { slug: "discord", implementationStatus: "coming_soon" },
      { slug: "teams", implementationStatus: "coming_soon" },
    ]);
    await applyImplementationStatusOverride(db, {
      discord: "available",
      teams: "available",
    });
    const sqls = captured.map((c) => c.sql);
    const beginIdx = sqls.indexOf("BEGIN");
    const commitIdx = sqls.indexOf("COMMIT");
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);
    // Both UPDATEs land between BEGIN and COMMIT.
    const updateIdxs = sqls
      .map((s, i) => (s.includes("UPDATE plugin_catalog") ? i : -1))
      .filter((i) => i !== -1);
    expect(updateIdxs).toHaveLength(2);
    for (const idx of updateIdxs) {
      expect(idx).toBeGreaterThan(beginIdx);
      expect(idx).toBeLessThan(commitIdx);
    }
  });

  it("rolls back partial updates on mid-loop failure (atomicity guarantee)", async () => {
    // Critical regression guard for the codex P2 atomicity contract.
    // First UPDATE succeeds, second fails — the mock would otherwise
    // leave `discord` flipped. Wrapping in BEGIN/ROLLBACK ensures the
    // catalog is restored to its pre-boot state.
    const { db, rows, captured } = makeMockDb(
      [
        { slug: "discord", implementationStatus: "coming_soon" },
        { slug: "teams", implementationStatus: "coming_soon" },
      ],
      { failOnUpdateFor: "teams" },
    );

    await expect(
      applyImplementationStatusOverride(db, {
        discord: "available",
        teams: "available",
      }),
    ).rejects.toThrow(/simulated UPDATE failure/);

    // Neither row should be flipped — discord's pending UPDATE was
    // rolled back, teams's throw never landed.
    expect(rows.find((r) => r.slug === "discord")?.implementationStatus).toBe(
      "coming_soon",
    );
    expect(rows.find((r) => r.slug === "teams")?.implementationStatus).toBe(
      "coming_soon",
    );
    expect(captured.map((c) => c.sql)).toContain("ROLLBACK");
    expect(captured.map((c) => c.sql)).not.toContain("COMMIT");
  });

  it("skips BEGIN/COMMIT entirely when there are no actions (no transaction overhead)", async () => {
    const { db, captured } = makeMockDb([
      { slug: "discord", implementationStatus: "coming_soon" },
    ]);
    await applyImplementationStatusOverride(db, {
      discord: "coming_soon", // noop — already at target
    });
    const sqls = captured.map((c) => c.sql);
    expect(sqls).not.toContain("BEGIN");
    expect(sqls).not.toContain("COMMIT");
  });

  it("operator typo'd casing surfaces in unmatchedSlugs (case-sensitive slug compare)", async () => {
    // The planner docstring claims case-sensitive — pin it so a future
    // refactor that lowercases the override map silently doesn't widen
    // the match surface.
    const { db } = makeMockDb([
      { slug: "discord", implementationStatus: "coming_soon" },
    ]);
    const result = await applyImplementationStatusOverride(db, {
      Discord: "available",
    });
    expect(result.updatedCount).toBe(0);
    expect(result.unmatchedSlugs).toEqual(["Discord"]);
  });
});

// ---------------------------------------------------------------------------
// runImplementationStatusOverrideBoot (discriminated outcomes)
// ---------------------------------------------------------------------------

describe("runImplementationStatusOverrideBoot (discriminated outcomes)", () => {
  // Mirrors the `runBuiltinDatasourceCatalogSeedBoot` test block in
  // `db/__tests__/seed-builtin-datasource-catalog.test.ts`. The wrapper
  // sits between the Effect Layer and the pure `applyImplementationStatusOverride`
  // function; each of its four outcomes (`skipped:no-internal-db`,
  // `skipped:no-config`, `skipped:empty-override`, `applied`, `error`)
  // is the source of truth the Layer maps to its `outcome` field. A
  // regression that mismaps one of these would silently break the
  // health surface.

  const mockQuery = mock<
    (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  >(() => Promise.resolve({ rows: [] }));

  let hasInternalDBReturns = true;
  let configReturns: { overrideImplementationStatus?: Record<string, "available" | "coming_soon"> } | null = {};

  void mock.module("@atlas/api/lib/db/internal", () => ({
    hasInternalDB: () => hasInternalDBReturns,
    getInternalDB: () => ({ query: mockQuery }),
  }));

  void mock.module("@atlas/api/lib/config", () => ({
    getConfig: () => configReturns,
  }));

  afterEach(() => {
    mockQuery.mockClear();
    hasInternalDBReturns = true;
    configReturns = {};
  });

  it("returns `{ kind: 'skipped', reason: 'no-internal-db' }` when no internal DB is configured", async () => {
    hasInternalDBReturns = false;
    const { runImplementationStatusOverrideBoot } = await import(
      "@atlas/api/lib/integrations/implementation-status-override"
    );
    const result = await runImplementationStatusOverrideBoot();
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("no-internal-db");
    // Pool must NOT be queried in the skip path — guarding against a
    // regression that drops the gate and tries to acquire a connection
    // on a self-host without internal DB.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns `{ kind: 'skipped', reason: 'no-config' }` when getConfig() returns null", async () => {
    configReturns = null;
    const { runImplementationStatusOverrideBoot } = await import(
      "@atlas/api/lib/integrations/implementation-status-override"
    );
    const result = await runImplementationStatusOverrideBoot();
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("no-config");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns `{ kind: 'skipped', reason: 'empty-override' }` when override map is empty", async () => {
    configReturns = { overrideImplementationStatus: {} };
    const { runImplementationStatusOverrideBoot } = await import(
      "@atlas/api/lib/integrations/implementation-status-override"
    );
    const result = await runImplementationStatusOverrideBoot();
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("empty-override");
    // Empty-override should NOT issue the SELECT — fast path so SaaS
    // boots stay cheap (the override field is always empty on SaaS).
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns `{ kind: 'applied' }` on a successful override", async () => {
    configReturns = { overrideImplementationStatus: { discord: "available" } };
    mockQuery.mockImplementation((sql) => {
      if (sql.includes("SELECT slug, implementation_status")) {
        return Promise.resolve({
          rows: [{ slug: "discord", implementation_status: "coming_soon" }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const { runImplementationStatusOverrideBoot } = await import(
      "@atlas/api/lib/integrations/implementation-status-override"
    );
    const result = await runImplementationStatusOverrideBoot();
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.updatedCount).toBe(1);
      expect(result.unmatchedSlugs).toEqual([]);
    }
  });

  it("returns `{ kind: 'error' }` when the pool query throws", async () => {
    configReturns = { overrideImplementationStatus: { discord: "available" } };
    mockQuery.mockImplementation(() =>
      Promise.reject(new Error("simulated pg failure")),
    );
    const { runImplementationStatusOverrideBoot } = await import(
      "@atlas/api/lib/integrations/implementation-status-override"
    );
    const result = await runImplementationStatusOverrideBoot();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("simulated pg failure");
    }
  });

  it("normalizes a non-Error throw to a string message", async () => {
    configReturns = { overrideImplementationStatus: { discord: "available" } };
    mockQuery.mockImplementation(() => Promise.reject("just a string"));
    const { runImplementationStatusOverrideBoot } = await import(
      "@atlas/api/lib/integrations/implementation-status-override"
    );
    const result = await runImplementationStatusOverrideBoot();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("just a string");
    }
  });
});
