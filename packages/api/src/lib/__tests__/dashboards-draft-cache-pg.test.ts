/**
 * Real-Postgres coverage for the draft cache (#4554, ADR-0034 Decision 1).
 *
 * The seam's SQL — the fork-time seed's INSERT…SELECT JOIN, the upsert's
 * `WHERE EXISTS` guard + conflict target, the composite-FK cascade — is pure
 * SQL a mock pool never executes: a column typo, a bad `::jsonb` cast, or a
 * conflict-target mismatch would pass every substring assertion and surface
 * only in production. This runs the ACTUAL statements against the real schema
 * (migrations included, so migration 0175 is the source of truth here).
 *
 * Skips cleanly when `TEST_DATABASE_URL` is unset. Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import { createDashboard, addCard, getDashboard } from "@atlas/api/lib/dashboards";
import { forkOrLoadDraft, discardDraft } from "@atlas/api/lib/dashboard-versioning";
import {
  loadDraftCardCache,
  saveDraftCardCache,
} from "@atlas/api/lib/dashboard-draft-cache";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TEST_TIMEOUT_MS = 30_000;

const USER = "user-holder";
const ORG = "org-A";

describeIfPg("dashboard draft cache round-trip (real Postgres, #4554)", () => {
  let pool: Pool;
  const schemaName = `draft_cache_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `draft-cache-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      console.error(
        `draft-cache-pg: DROP SCHEMA cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await pool.end();
  });

  beforeEach(async () => {
    // dashboards cascades to cards and drafts; drafts cascade to the cache.
    await pool.query(`DELETE FROM dashboards`);
  });

  /** Create a published dashboard with one cached card + one never-run card;
   *  return ids + the loaded DashboardWithCards for forking. */
  async function seedPublishedDashboard() {
    const dash = await createDashboard({ ownerId: USER, orgId: ORG, title: "Board" });
    if (!dash.ok) throw new Error(`createDashboard failed: ${dash.reason}`);
    const cached = await addCard({
      dashboardId: dash.data.id,
      title: "Cached card",
      sql: "SELECT 1 AS v",
      cachedColumns: ["v"],
      cachedRows: [{ v: 1 }],
    });
    if (!cached.ok) throw new Error(`addCard failed: ${cached.reason}`);
    const neverRun = await addCard({
      dashboardId: dash.data.id,
      title: "Never-run card",
      sql: "SELECT 2 AS w",
    });
    if (!neverRun.ok) throw new Error(`addCard failed: ${neverRun.reason}`);
    const full = await getDashboard(dash.data.id, { orgId: ORG, viewerId: USER });
    if (!full.ok) throw new Error(`getDashboard failed: ${full.reason}`);
    return { dashboardId: dash.data.id, cachedCardId: cached.data.id, neverRunCardId: neverRun.data.id, published: full.data };
  }

  it(
    "fork seeds the draft cache from published cached data (rows + capture instant); never-run cards get no row",
    async () => {
      const { dashboardId, cachedCardId, neverRunCardId, published } = await seedPublishedDashboard();

      const draft = await forkOrLoadDraft(USER, published);
      expect(draft).not.toBeNull();

      const cache = await loadDraftCardCache(USER, dashboardId);
      const entry = cache.get(cachedCardId);
      expect(entry).toBeDefined();
      expect(entry?.cachedColumns).toEqual(["v"]);
      expect(entry?.cachedRows).toEqual([{ v: 1 }]);
      // Capture instant is COPIED from the published card, not re-stamped.
      // Compare against the raw column (the materialized view's `String(Date)`
      // is second-truncated, so it can't serve as the full-precision oracle).
      const raw = await pool.query<{ cached_at: Date }>(
        `SELECT cached_at FROM dashboard_cards WHERE id = $1`,
        [cachedCardId],
      );
      expect(entry?.cachedAt).toBeDefined();
      expect(new Date(entry?.cachedAt ?? 0).toISOString()).toBe(
        raw.rows[0]?.cached_at.toISOString() ?? "missing",
      );
      // "Never run" is the absence of a row.
      expect(cache.has(neverRunCardId)).toBe(false);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "saveDraftCardCache upserts (insert then overwrite) and round-trips through loadDraftCardCache",
    async () => {
      const { dashboardId, neverRunCardId, published } = await seedPublishedDashboard();
      await forkOrLoadDraft(USER, published);

      const first = await saveDraftCardCache(USER, dashboardId, neverRunCardId, {
        columns: ["w"],
        rows: [{ w: 2 }],
      });
      expect(first.ok).toBe(true);

      // Overwrite the same card's entry — the ON CONFLICT target must match
      // the real composite PK.
      const second = await saveDraftCardCache(USER, dashboardId, neverRunCardId, {
        columns: ["w"],
        rows: [{ w: 99 }],
      });
      expect(second.ok).toBe(true);

      const cache = await loadDraftCardCache(USER, dashboardId);
      const entry = cache.get(neverRunCardId);
      expect(entry?.cachedRows).toEqual([{ w: 99 }]);
      if (first.ok && second.ok) {
        expect(entry?.cachedAt).toBe(second.cachedAt);
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "saveDraftCardCache returns no_draft when no draft row exists (WHERE EXISTS under the real FK)",
    async () => {
      const { dashboardId, cachedCardId } = await seedPublishedDashboard();
      // No fork — the caller holds no draft.
      const result = await saveDraftCardCache(USER, dashboardId, cachedCardId, {
        columns: ["v"],
        rows: [{ v: 1 }],
      });
      expect(result).toEqual({ ok: false, reason: "no_draft" });
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "discarding the draft cascades the cache away (composite FK); published cached data is untouched",
    async () => {
      const { dashboardId, cachedCardId, published } = await seedPublishedDashboard();
      await forkOrLoadDraft(USER, published);
      expect((await loadDraftCardCache(USER, dashboardId)).size).toBe(1);

      expect(await discardDraft(USER, dashboardId)).toBe(true);
      expect((await loadDraftCardCache(USER, dashboardId)).size).toBe(0);

      // The published card's own cache survives — the draft cache was a copy.
      const rows = await pool.query<{ cached_rows: unknown }>(
        `SELECT cached_rows FROM dashboard_cards WHERE id = $1`,
        [cachedCardId],
      );
      expect(rows.rows[0]?.cached_rows).toEqual([{ v: 1 }]);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
