/**
 * Regression coverage for the org-creation region stamp ({@link stampOrgRegion}).
 *
 * Under regional identity (ADR-0024) the process *is* the region: an org
 * created on a regional API is in that region by definition, so the region is
 * stamped from the ambient `ATLAS_API_REGION` (via `getApiRegion`, which falls
 * back to `residency.defaultRegion`) at creation — not recorded by a separate
 * post-hoc assign step. The helper's contract:
 *
 *   - Region identity present → idempotent one-way `setWorkspaceRegion`
 *     (`UPDATE organization SET region = … WHERE id = … AND region IS NULL`).
 *   - `ATLAS_API_REGION` unset → fall back to `residency.defaultRegion`.
 *   - No region identity (self-hosted / residency unconfigured) → no-op.
 *   - No internal DB → no-op, no throw.
 *   - UPDATE throws → log + swallow (never block org creation).
 *
 * Caveat: this exercises the function in isolation. The
 * `databaseHooks-wiring.test.ts` wiring test covers that the
 * `afterCreateOrganization` composition actually calls it.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { _setConfigForTest, type ResolvedConfig } from "@atlas/api/lib/config";
import { stampOrgRegion } from "../server";

const ORG = { id: "org_region_456" };

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_API_REGION = process.env.ATLAS_API_REGION;

interface MockPool {
  pool: InternalPool;
  queries: Array<{ sql: string; params?: unknown[] }>;
}

function makeMockPool(opts: { updateThrows?: boolean; alreadyAssigned?: boolean } = {}): MockPool {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (/UPDATE\s+organization\s+SET\s+region/i.test(sql)) {
        if (opts.updateThrows) throw new Error("UPDATE failed");
        // One-way: the WHERE `region IS NULL` guard means an already-assigned
        // org's UPDATE returns no row.
        return opts.alreadyAssigned ? { rows: [], rowCount: 0 } : { rows: [{ id: params?.[1] }], rowCount: 1 };
      }
      if (/SELECT\s+region\s+FROM\s+organization/i.test(sql)) {
        // setWorkspaceRegion's follow-up read when the UPDATE wrote no row.
        return { rows: [{ region: opts.alreadyAssigned ? "us" : null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as InternalPool;
  return { pool, queries };
}

function configWithDefaultRegion(defaultRegion?: string): ResolvedConfig {
  return {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "managed",
    semanticLayer: "./semantic",
    maxTotalConnections: 100,
    source: "file",
    deployMode: "saas",
    ...(defaultRegion ? { residency: { regions: {}, defaultRegion, strictRouting: false } } : {}),
  };
}

describe("stampOrgRegion — body", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test/test";
    delete process.env.ATLAS_API_REGION;
    _setConfigForTest(configWithDefaultRegion());
  });

  afterEach(() => {
    _resetPool(null);
    _setConfigForTest(null);
  });

  afterAll(() => {
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (ORIGINAL_API_REGION === undefined) delete process.env.ATLAS_API_REGION;
    else process.env.ATLAS_API_REGION = ORIGINAL_API_REGION;
  });

  it("stamps the ambient ATLAS_API_REGION on the new org (idempotent, region IS NULL guard)", async () => {
    process.env.ATLAS_API_REGION = "us";
    const { pool, queries } = makeMockPool();
    _resetPool(pool);

    await stampOrgRegion({ organization: ORG });

    const update = queries.find((q) => /UPDATE\s+organization\s+SET\s+region/i.test(q.sql));
    expect(update, "expected the region UPDATE to fire").toBeDefined();
    // One-way guard: only writes when the region is still NULL.
    expect(update?.sql).toMatch(/WHERE\s+id\s*=\s*\$2\s+AND\s+region\s+IS\s+NULL/i);
    expect(update?.params).toEqual(["us", ORG.id]);
  });

  it("falls back to residency.defaultRegion when ATLAS_API_REGION is unset", async () => {
    _setConfigForTest(configWithDefaultRegion("eu"));
    const { pool, queries } = makeMockPool();
    _resetPool(pool);

    await stampOrgRegion({ organization: ORG });

    const update = queries.find((q) => /UPDATE\s+organization\s+SET\s+region/i.test(q.sql));
    expect(update?.params).toEqual(["eu", ORG.id]);
  });

  it("is a no-op when this instance has no region identity (self-hosted / residency unconfigured)", async () => {
    // No ATLAS_API_REGION and no residency.defaultRegion → getApiRegion() is null.
    const { pool, queries } = makeMockPool();
    _resetPool(pool);

    await stampOrgRegion({ organization: ORG });

    expect(queries).toHaveLength(0);
  });

  it("skips when the internal DB is unavailable", async () => {
    delete process.env.DATABASE_URL;
    process.env.ATLAS_API_REGION = "us";
    const { pool, queries } = makeMockPool();
    _resetPool(pool);

    await stampOrgRegion({ organization: ORG });

    expect(queries).toHaveLength(0);
  });

  it("does not throw when the region UPDATE fails — signup continues (failure is swallowed + logged)", async () => {
    process.env.ATLAS_API_REGION = "us";
    const { pool } = makeMockPool({ updateThrows: true });
    _resetPool(pool);

    await expect(stampOrgRegion({ organization: ORG })).resolves.toBeUndefined();
  });

  it("is a no-op write when the org already has a region (one-way migration is the only changer)", async () => {
    process.env.ATLAS_API_REGION = "us";
    const { pool, queries } = makeMockPool({ alreadyAssigned: true });
    _resetPool(pool);

    await stampOrgRegion({ organization: ORG });

    // The UPDATE still runs (its WHERE guard is what makes it a no-op), but no
    // second region is stamped — re-invocation never clobbers an existing one.
    expect(queries.some((q) => /UPDATE\s+organization\s+SET\s+region/i.test(q.sql))).toBe(true);
  });
});
