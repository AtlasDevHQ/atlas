/**
 * Real-Postgres coverage for the #4325 full-precision publish baseline.
 *
 * The draft stale-baseline guard compares the draft's `published_baseline_at`
 * against the live `dashboards.updated_at`. Before #4325 both sides were
 * serialized via `String(Date)`, which truncates a timestamptz to WHOLE
 * SECONDS — so two publishes in the same wall-clock second read as equal and
 * the second one clobbered the first (a lost update). The fix stamps the
 * baseline by copying `updated_at` in SQL and compares both sides via `::text`
 * (full microsecond precision).
 *
 * This is a serialization/precision property of the real timestamptz column — a
 * mock pool returns whatever string the test hands it, so it would never
 * reproduce the truncation. Runs the ACTUAL SQL against the real schema.
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
import { createDashboard, getDashboard, refreshDashboardCards } from "@atlas/api/lib/dashboards";
import {
  applyEditToDraft,
  loadDraft,
  publishDraft,
  type DashboardWithCards,
} from "@atlas/api/lib/dashboard-versioning";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TEST_TIMEOUT_MS = 30_000;

const CREATOR = "user-creator";
const ORG = "org-A";
// Two microsecond timestamps in the SAME wall-clock second. Under the old
// whole-second serialization these two collided; the fix distinguishes them.
const BASELINE_TS = "2026-07-04 12:00:00.100000+00";
const SAME_SECOND_TS = "2026-07-04 12:00:00.500000+00";

describeIfPg("dashboard publish baseline precision (real Postgres, #4325)", () => {
  let pool: Pool;
  const schemaName = `baseline_precision_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `baseline-precision-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
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
        `baseline-precision-pg: DROP SCHEMA cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM dashboard_user_drafts`);
    await pool.query(`DELETE FROM dashboards`);
  });

  const loadForOrg = async (id: string): Promise<DashboardWithCards | null> => {
    const r = await getDashboard(id, { orgId: ORG, viewerId: CREATOR });
    return r.ok ? r.data : null;
  };

  /**
   * Create a dashboard + one card, pin its `updated_at` to `ts`, then fork the
   * caller's draft off it (baseline copied at full precision) and stage a meta
   * edit so publish has an op to apply. Returns the dashboard id.
   */
  async function seedDashboardWithDraft(ts: string): Promise<string> {
    const created = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Board" });
    if (!created.ok) throw new Error("createDashboard failed");
    const id = created.data.id;
    await pool.query(
      `INSERT INTO dashboard_cards (dashboard_id, position, title, sql) VALUES ($1, 0, 'Card', 'SELECT 1')`,
      [id],
    );
    // Pin the published baseline to a deterministic microsecond instant.
    await pool.query(`UPDATE dashboards SET updated_at = $2 WHERE id = $1`, [id, ts]);

    const published = await loadForOrg(id);
    if (!published) throw new Error("getDashboard failed");
    // Forks the draft (baseline_at copied from updated_at) + persists an edit.
    const edit = await applyEditToDraft(CREATOR, published, {
      kind: "updateMeta",
      title: "Edited in draft",
    });
    if (!edit.ok) throw new Error(`applyEditToDraft failed: ${edit.reason}`);
    return id;
  }

  it("forks the draft baseline at full microsecond precision", async () => {
    const id = await seedDashboardWithDraft(BASELINE_TS);
    const draft = await loadDraft(CREATOR, id);
    expect(draft).not.toBeNull();
    // The baseline retains a sub-second fraction — not truncated to whole seconds.
    expect(draft!.publishedBaselineAt).toContain("12:00:00.1");
  });

  it("REFUSES a same-second second publish (no lost update)", async () => {
    const id = await seedDashboardWithDraft(BASELINE_TS);

    // A concurrent publish lands in the SAME wall-clock second — a NEWER
    // microsecond instant. Under the old whole-second guard this read as equal
    // to the draft baseline and the publish sailed through, clobbering it.
    await pool.query(`UPDATE dashboards SET updated_at = $2 WHERE id = $1`, [id, SAME_SECOND_TS]);

    const result = await publishDraft({
      userId: CREATOR,
      dashboardId: id,
      orgId: ORG,
      loadDashboardForOrg: loadForOrg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stale_baseline");
    if (result.reason !== "stale_baseline") return;
    // The surfaced current baseline is the newer same-second instant.
    expect(result.currentBaselineAt).toContain("12:00:00.5");

    // The draft survived (not lost) — it's still publishable after a rebase.
    const draft = await loadDraft(CREATOR, id);
    expect(draft).not.toBeNull();
  });

  it("PUBLISHES when the baseline has not moved (full-precision match)", async () => {
    const id = await seedDashboardWithDraft(BASELINE_TS);

    const result = await publishDraft({
      userId: CREATOR,
      dashboardId: id,
      orgId: ORG,
      loadDashboardForOrg: loadForOrg,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.opsApplied).toBeGreaterThan(0);
    // The meta-only publish moves no card data, so nothing is enqueued for refresh.
    expect(result.refreshCardIds).toEqual([]);

    // The draft was consumed by the successful publish.
    const draft = await loadDraft(CREATOR, id);
    expect(draft).toBeNull();
  });

  it("enqueues the changed card for refresh when its SQL changed", async () => {
    const created = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Board" });
    if (!created.ok) throw new Error("createDashboard failed");
    const id = created.data.id;
    const cardRow = await pool.query<{ id: string }>(
      `INSERT INTO dashboard_cards (dashboard_id, position, title, sql)
       VALUES ($1, 0, 'Card', 'SELECT 1') RETURNING id`,
      [id],
    );
    const cardId = cardRow.rows[0]!.id;
    await pool.query(`UPDATE dashboards SET updated_at = $2 WHERE id = $1`, [id, BASELINE_TS]);

    const published = await loadForOrg(id);
    if (!published) throw new Error("getDashboard failed");
    const edit = await applyEditToDraft(CREATOR, published, {
      kind: "editSql",
      cardId,
      newSql: "SELECT 2 AS changed",
    });
    if (!edit.ok) throw new Error(`applyEditToDraft failed: ${edit.reason}`);

    const result = await publishDraft({
      userId: CREATOR,
      dashboardId: id,
      orgId: ORG,
      loadDashboardForOrg: loadForOrg,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The card whose SQL changed is enqueued for the async refresh.
    expect(result.refreshCardIds).toEqual([cardId]);
  });

  it("refreshDashboardCards({ onlyCardIds }) scopes the refresh to the given cards", async () => {
    const created = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Board" });
    if (!created.ok) throw new Error("createDashboard failed");
    const id = created.data.id;
    const a = await pool.query<{ id: string }>(
      `INSERT INTO dashboard_cards (dashboard_id, position, title, sql)
       VALUES ($1, 0, 'A', 'SELECT 1') RETURNING id`,
      [id],
    );
    await pool.query(
      `INSERT INTO dashboard_cards (dashboard_id, position, title, sql) VALUES ($1, 1, 'B', 'SELECT 2')`,
      [id],
    );

    // Scope to ONLY card A. `total` reflects the number of cards considered, so
    // a value of 1 (on a 2-card board) proves the filter scoped correctly — even
    // though the actual query exec fails here (no analytics datasource is wired
    // in this internal-DB-only harness, so the card lands in `failed`).
    const scoped = await refreshDashboardCards(id, { onlyCardIds: new Set([a.rows[0]!.id]) });
    expect(scoped.total).toBe(1);

    // Without the filter, both cards are considered.
    const all = await refreshDashboardCards(id);
    expect(all.total).toBe(2);
  });
});
