/**
 * Real-Postgres coverage for the #4320 first-publish visibility gate.
 *
 * A never-published dashboard (`first_published_at IS NULL`) is private to its
 * creator; on its FIRST publish the one-way marker is stamped and it becomes
 * org-visible permanently. These behaviours are pure SQL (the visibility clause
 * in `getDashboard`/`listDashboards`, the `COALESCE` stamp in `publishDraft`,
 * and the abandoned-shell sweep) — a mock pool would never execute them, so
 * this runs the ACTUAL SQL against the real schema.
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
import {
  createDashboard,
  getDashboard,
  listDashboards,
  cleanupAbandonedDashboards,
  updateDashboard,
  deleteDashboard,
  shareDashboard,
  unshareDashboard,
  getShareStatus,
  setRefreshSchedule,
} from "@atlas/api/lib/dashboards";
import {
  bindConversationToDashboard,
  resolveBoundDashboard,
} from "@atlas/api/lib/bound-chat-context";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TEST_TIMEOUT_MS = 30_000;

const CREATOR = "user-creator";
const TEAMMATE = "user-teammate";
const ORG = "org-A";

describeIfPg("dashboard first-publish visibility gate (real Postgres, #4320)", () => {
  let pool: Pool;
  const schemaName = `first_publish_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `first-publish-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
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
        `first-publish-pg: DROP SCHEMA cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM dashboards`);
  });

  async function firstPublishedAt(id: string): Promise<string | null> {
    const rows = await pool.query<{ first_published_at: Date | string | null }>(
      `SELECT first_published_at FROM dashboards WHERE id = $1`,
      [id],
    );
    const raw = rows.rows[0]?.first_published_at ?? null;
    // node-postgres returns timestamptz as a Date — normalise to an ISO string
    // so equality is by value, not object identity.
    return raw == null ? null : new Date(raw).toISOString();
  }

  /**
   * Stamp first_published_at via the SAME one-way SQL `publishDraft` runs
   * (`COALESCE(first_published_at, now())`), so the transition test exercises
   * the exact marker semantics without the draft/timestamp round-trip.
   */
  async function firstPublish(id: string): Promise<void> {
    await pool.query(
      `UPDATE dashboards
          SET updated_at = now(),
              first_published_at = COALESCE(first_published_at, now())
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  }

  it("hides a never-published dashboard from a teammate on direct read", async () => {
    const created = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Draft board" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    // Creator reads their own never-published board.
    const asCreator = await getDashboard(id, { orgId: ORG, viewerId: CREATOR });
    expect(asCreator.ok).toBe(true);

    // Teammate in the same org cannot read it — fail closed as not_found.
    const asTeammate = await getDashboard(id, { orgId: ORG, viewerId: TEAMMATE });
    expect(asTeammate).toEqual({ ok: false, reason: "not_found" });
  });

  it("scopes the list: never-published shows only for its creator", async () => {
    const priv = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Private" });
    const pub = await createDashboard({ ownerId: TEAMMATE, orgId: ORG, title: "Public" });
    expect(priv.ok && pub.ok).toBe(true);
    if (!priv.ok || !pub.ok) return;
    await firstPublish(pub.data.id); // pub has been published at least once

    const creatorList = await listDashboards({ orgId: ORG, viewerId: CREATOR });
    expect(creatorList.ok).toBe(true);
    if (!creatorList.ok) return;
    const creatorIds = creatorList.data.dashboards.map((d) => d.id).sort();
    expect(creatorIds).toEqual([priv.data.id, pub.data.id].sort());
    expect(creatorList.data.total).toBe(2);

    // Teammate sees ONLY the published board — the creator's private draft is invisible.
    const teammateList = await listDashboards({ orgId: ORG, viewerId: TEAMMATE });
    expect(teammateList.ok).toBe(true);
    if (!teammateList.ok) return;
    expect(teammateList.data.dashboards.map((d) => d.id)).toEqual([pub.data.id]);
    expect(teammateList.data.total).toBe(1);
  });

  it("becomes org-visible after first publish and stays so permanently", async () => {
    const created = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Board" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    // Before publish: teammate blocked, no marker.
    expect(await firstPublishedAt(id)).toBeNull();
    const before = await getDashboard(id, { orgId: ORG, viewerId: TEAMMATE });
    expect(before).toEqual({ ok: false, reason: "not_found" });

    // First publish stamps the one-way marker (same SQL publishDraft runs).
    await firstPublish(id);
    const stampedAt = await firstPublishedAt(id);
    expect(stampedAt).not.toBeNull();

    // The teammate can now read AND list it.
    const afterRead = await getDashboard(id, { orgId: ORG, viewerId: TEAMMATE });
    expect(afterRead.ok).toBe(true);
    const afterList = await listDashboards({ orgId: ORG, viewerId: TEAMMATE });
    expect(afterList.ok && afterList.data.dashboards.map((d) => d.id)).toContain(id);

    // One-way: a second publish must NOT move the marker.
    await firstPublish(id);
    expect(await firstPublishedAt(id)).toBe(stampedAt);
  });

  it("self-hosted null-org: creator (anonymous owner) sees their own never-published board", async () => {
    // The route passes viewerId `user?.id ?? "anonymous"`; createDashboard uses
    // the same default, so the self-hosted single-operator path is symmetric.
    const created = await createDashboard({ ownerId: "anonymous", orgId: null, title: "Local" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const asOperator = await getDashboard(created.data.id, { orgId: null, viewerId: "anonymous" });
    expect(asOperator.ok).toBe(true);
    const list = await listDashboards({ orgId: null, viewerId: "anonymous" });
    expect(list.ok && list.data.dashboards.map((d) => d.id)).toContain(created.data.id);
  });

  it("omitting viewerId (system/owner-internal caller) does not apply the gate", async () => {
    // publishDraft's own baseline load, auto-refresh, etc. must still resolve a
    // never-published row — the gate is opt-in via viewerId.
    const created = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Ungated" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ungated = await getDashboard(created.data.id, { orgId: ORG });
    expect(ungated.ok).toBe(true);
  });

  it("gates the bound-chat drawer: a teammate can't bind/resolve a never-published board", async () => {
    // A conversation can carry a caller-supplied boundDashboardId, so the bind
    // (and the follow-up resolve) is a read vector the gate must close — a
    // teammate must not be able to bind a drawer to, and thereby read, a
    // never-published board they didn't create (#4320 AC).
    const created = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Bindable" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    // Seed a conversation the teammate could try to bind.
    const conv = await pool.query<{ id: string }>(
      `INSERT INTO conversations (org_id, title) VALUES ($1, 'c') RETURNING id`,
      [ORG],
    );
    const conversationId = conv.rows[0]!.id;

    // Teammate bind is refused (dashboard_not_found) while the board is private.
    const teammateBind = await bindConversationToDashboard(conversationId, id, {
      orgId: ORG,
      viewerId: TEAMMATE,
    });
    expect(teammateBind).toEqual({ ok: false, reason: "dashboard_not_found" });

    // Creator can bind their own never-published board.
    const creatorBind = await bindConversationToDashboard(conversationId, id, {
      orgId: ORG,
      viewerId: CREATOR,
    });
    expect(creatorBind.ok).toBe(true);

    // Even once bound, a teammate resolving the binding cannot read the board.
    const teammateResolve = await resolveBoundDashboard(conversationId, {
      orgId: ORG,
      viewerId: TEAMMATE,
    });
    expect(teammateResolve).toEqual({ ok: false, reason: "dashboard_not_found" });
    // The creator resolves it fine.
    const creatorResolve = await resolveBoundDashboard(conversationId, {
      orgId: ORG,
      viewerId: CREATOR,
    });
    expect(creatorResolve.ok).toBe(true);

    // After first publish, the teammate can bind + resolve it.
    await firstPublish(id);
    const afterBind = await bindConversationToDashboard(conversationId, id, {
      orgId: ORG,
      viewerId: TEAMMATE,
    });
    expect(afterBind.ok).toBe(true);
  });

  it("migration 0165 backfills pre-existing boards so they stay org-visible", async () => {
    // Pre-existing dashboards predate the marker; the migration backfills
    // first_published_at from created_at so they are NOT retroactively hidden
    // from teammates. Simulate a pre-migration row (marker NULL) then run the
    // exact backfill statement and assert the row is now teammate-visible.
    const created = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Legacy board" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    await pool.query(`UPDATE dashboards SET first_published_at = NULL WHERE id = $1`, [id]);

    // Before backfill: private to creator (teammate blocked).
    expect(
      await getDashboard(id, { orgId: ORG, viewerId: TEAMMATE }),
    ).toEqual({ ok: false, reason: "not_found" });

    // The migration's backfill statement (0165).
    await pool.query(
      `UPDATE dashboards SET first_published_at = created_at WHERE first_published_at IS NULL`,
    );

    // Marker is now set to created_at and the board is org-visible.
    expect(await firstPublishedAt(id)).not.toBeNull();
    expect((await getDashboard(id, { orgId: ORG, viewerId: TEAMMATE })).ok).toBe(true);
  });

  describe("write-side gate (#4537)", () => {
    // The read gate (#4320) made a never-published board invisible to
    // teammates — but every mutation/share/delete path scoped by org only, so
    // a same-org teammate who learned the UUID could still delete it, mint a
    // share link on it, or leak its share token. These tests pin the write
    // paths to the SAME visibility semantics as the reads: not_found for a
    // non-owner while never-published, unchanged once published.

    const nextRun = () => new Date(Date.now() + 60_000);

    async function createPrivateBoard(): Promise<string> {
      const created = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Private board" });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("createDashboard failed in fixture");
      return created.data.id;
    }

    it("a teammate cannot soft-delete another user's never-published dashboard; the owner can", async () => {
      const id = await createPrivateBoard();

      const asTeammate = await deleteDashboard(id, { orgId: ORG, viewerId: TEAMMATE });
      expect(asTeammate).toEqual({ ok: false, reason: "not_found" });
      // The blind delete must not have landed — the creator still reads it.
      expect((await getDashboard(id, { orgId: ORG, viewerId: CREATOR })).ok).toBe(true);

      const asCreator = await deleteDashboard(id, { orgId: ORG, viewerId: CREATOR });
      expect(asCreator).toEqual({ ok: true });
    });

    it("a teammate cannot mint a share link on a never-published dashboard; the owner can", async () => {
      const id = await createPrivateBoard();

      const asTeammate = await shareDashboard(id, { orgId: ORG, viewerId: TEAMMATE });
      expect(asTeammate).toEqual({ ok: false, reason: "not_found" });
      // The org-scoped share path (separate pre-check query) is gated too.
      const asTeammateOrg = await shareDashboard(id, { orgId: ORG, viewerId: TEAMMATE }, { shareMode: "org" });
      expect(asTeammateOrg).toEqual({ ok: false, reason: "not_found" });
      // No token was written by either attempt.
      const rows = await pool.query<{ share_token: string | null }>(
        `SELECT share_token FROM dashboards WHERE id = $1`,
        [id],
      );
      expect(rows.rows[0]?.share_token).toBeNull();

      const asCreator = await shareDashboard(id, { orgId: ORG, viewerId: CREATOR });
      expect(asCreator.ok).toBe(true);
    });

    it("a teammate cannot read or revoke the share status of a never-published dashboard", async () => {
      const id = await createPrivateBoard();
      const shared = await shareDashboard(id, { orgId: ORG, viewerId: CREATOR });
      expect(shared.ok).toBe(true);

      // Status (and thereby the token) must not leak to a teammate.
      const statusAsTeammate = await getShareStatus(id, { orgId: ORG, viewerId: TEAMMATE });
      expect(statusAsTeammate).toEqual({ ok: false, reason: "not_found" });

      // Nor can the teammate blind-revoke the owner's link.
      const unshareAsTeammate = await unshareDashboard(id, { orgId: ORG, viewerId: TEAMMATE });
      expect(unshareAsTeammate).toEqual({ ok: false, reason: "not_found" });
      const statusAsCreator = await getShareStatus(id, { orgId: ORG, viewerId: CREATOR });
      expect(statusAsCreator.ok && statusAsCreator.data.shared).toBe(true);

      const unshareAsCreator = await unshareDashboard(id, { orgId: ORG, viewerId: CREATOR });
      expect(unshareAsCreator).toEqual({ ok: true });
    });

    it("a teammate cannot write parameters or the refresh schedule of a never-published dashboard", async () => {
      const id = await createPrivateBoard();

      const paramsAsTeammate = await updateDashboard(
        id,
        { orgId: ORG, viewerId: TEAMMATE },
        { parameters: [{ key: "region", label: "Region", type: "text", default: "us" }] },
      );
      expect(paramsAsTeammate).toEqual({ ok: false, reason: "not_found" });

      const schedAsTeammate = await setRefreshSchedule(id, { orgId: ORG, viewerId: TEAMMATE }, "0 * * * *", nextRun);
      expect(schedAsTeammate).toEqual({ ok: false, reason: "not_found" });

      const paramsAsCreator = await updateDashboard(
        id,
        { orgId: ORG, viewerId: CREATOR },
        { parameters: [{ key: "region", label: "Region", type: "text", default: "us" }] },
      );
      expect(paramsAsCreator).toEqual({ ok: true });
      const schedAsCreator = await setRefreshSchedule(id, { orgId: ORG, viewerId: CREATOR }, "0 * * * *", nextRun);
      expect(schedAsCreator).toEqual({ ok: true });
    });

    it("published dashboards accept teammate writes unchanged", async () => {
      const id = await createPrivateBoard();
      await firstPublish(id);

      expect((await shareDashboard(id, { orgId: ORG, viewerId: TEAMMATE })).ok).toBe(true);
      expect((await getShareStatus(id, { orgId: ORG, viewerId: TEAMMATE })).ok).toBe(true);
      expect((await unshareDashboard(id, { orgId: ORG, viewerId: TEAMMATE })).ok).toBe(true);
      expect(
        (await updateDashboard(id, { orgId: ORG, viewerId: TEAMMATE }, { parameters: [] })).ok,
      ).toBe(true);
      expect(
        (await setRefreshSchedule(id, { orgId: ORG, viewerId: TEAMMATE }, "0 * * * *", nextRun)).ok,
      ).toBe(true);
      expect((await deleteDashboard(id, { orgId: ORG, viewerId: TEAMMATE })).ok).toBe(true);
    });

    it("omitting viewerId (system/owner-internal caller) still bypasses the write gate", async () => {
      // Mirrors the read-path opt-out: system callers (sweep, publish
      // internals) pass no viewerId and must still resolve never-published rows.
      const id = await createPrivateBoard();
      expect((await setRefreshSchedule(id, { orgId: ORG }, "0 * * * *", nextRun)).ok).toBe(true);
      expect((await deleteDashboard(id, { orgId: ORG })).ok).toBe(true);
    });
  });

  describe("abandoned-shell cleanup", () => {
    async function insertCard(dashboardId: string): Promise<void> {
      await pool.query(
        `INSERT INTO dashboard_cards (dashboard_id, title, sql) VALUES ($1, 'Card', 'SELECT 1')`,
        [dashboardId],
      );
    }
    async function insertDraft(dashboardId: string): Promise<void> {
      await pool.query(
        `INSERT INTO dashboard_user_drafts (user_id, dashboard_id, draft, baseline, published_baseline_at)
         VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, now())`,
        [CREATOR, dashboardId],
      );
    }
    async function isSoftDeleted(id: string): Promise<boolean> {
      const rows = await pool.query<{ deleted_at: string | null }>(
        `SELECT deleted_at FROM dashboards WHERE id = $1`,
        [id],
      );
      return rows.rows[0]?.deleted_at != null;
    }

    it("sweeps a stale never-published empty shell but spares real work", async () => {
      const stale = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Stale shell" });
      const withCard = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Has card" });
      const withDraft = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Has draft" });
      const published = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Published" });
      expect(stale.ok && withCard.ok && withDraft.ok && published.ok).toBe(true);
      if (!stale.ok || !withCard.ok || !withDraft.ok || !published.ok) return;

      await insertCard(withCard.data.id);
      await insertDraft(withDraft.data.id);
      await firstPublish(published.data.id);

      // Run the sweep as if 100h have elapsed (default window is 72h), so every
      // row created "now" is past the cutoff — isolating the content predicate.
      const cleaned = await cleanupAbandonedDashboards(new Date(Date.now() + 100 * 3_600_000));

      // Only the empty never-published shell is swept.
      expect(await isSoftDeleted(stale.data.id)).toBe(true);
      // A shell with a card is real work — spared.
      expect(await isSoftDeleted(withCard.data.id)).toBe(false);
      // A shell with an in-flight draft is real work — spared.
      expect(await isSoftDeleted(withDraft.data.id)).toBe(false);
      // A published (org-visible) board is never swept.
      expect(await isSoftDeleted(published.data.id)).toBe(false);
      expect(cleaned).toBe(1);

      // A soft-deleted shell no longer surfaces to its creator's list either.
      const list = await listDashboards({ orgId: ORG, viewerId: CREATOR });
      expect(list.ok && list.data.dashboards.map((d) => d.id)).not.toContain(stale.data.id);
    });

    it("respects the retention window: a fresh shell is not swept", async () => {
      const shell = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Fresh shell" });
      expect(shell.ok).toBe(true);
      if (!shell.ok) return;
      // Real-time now: the shell's created_at is not older than the 72h window.
      const cleaned = await cleanupAbandonedDashboards(new Date());
      expect(cleaned).toBe(0);
      expect(await isSoftDeleted(shell.data.id)).toBe(false);
    });

    it("a non-positive window disables the sweep entirely", async () => {
      const shell = await createDashboard({ ownerId: CREATOR, orgId: ORG, title: "Old shell" });
      expect(shell.ok).toBe(true);
      if (!shell.ok) return;
      const prev = process.env.ATLAS_DASHBOARD_ABANDON_CLEANUP_HOURS;
      process.env.ATLAS_DASHBOARD_ABANDON_CLEANUP_HOURS = "0";
      try {
        // Even far past any real cutoff, a window of 0 is a full opt-out.
        const cleaned = await cleanupAbandonedDashboards(new Date(Date.now() + 1000 * 3_600_000));
        expect(cleaned).toBe(0);
        expect(await isSoftDeleted(shell.data.id)).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.ATLAS_DASHBOARD_ABANDON_CLEANUP_HOURS;
        else process.env.ATLAS_DASHBOARD_ABANDON_CLEANUP_HOURS = prev;
      }
    });
  });
});
