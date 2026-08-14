/**
 * The BEHAVIOURAL half of #5203's falsification, against real Postgres.
 *
 * `brain-source-scope.test.ts` pins the rule at registration: a chat-class
 * source may not be dispatched per install. This file pins what the rule
 * exists to guarantee, and every claim here needs a live schema:
 *
 *   1. **A Slack chat install cannot exist while its episode source does not.**
 *      The ticket's acceptance criterion, stated as the affirmative it implies:
 *      a `chat_cache` installation row — written through the REAL store, the
 *      same row the chat adapter resolves tokens from — is BY ITSELF enough for
 *      `runKnowledgeSyncCycle` to dispatch a Slack episode sync for that
 *      workspace and land its `knowledge_sync_state` row. No second install, no
 *      other precondition. Stubbing `runPerWorkspaceBrainSources` to return
 *      zeros, or dropping the per-workspace arm from the cycle, goes red here.
 *   2. **The bookkeeping write LANDS without an install row.** Round 1 of
 *      #5209 shipped the per-workspace dispatch with the sync-state upsert
 *      still guarded on `workspace_plugins` — every write, success and error
 *      alike, inserted zero rows forever, which is the four-day M1 outage
 *      rebuilt one layer down. Both anchors are pinned: the workspace anchor
 *      writes with no install row, the install anchor still refuses (that
 *      refusal is bundle-sync's uninstall-race guard, not a bug).
 *   3. **An incomplete membership walk defers the reconcile** (AC-5). The
 *      lazy reconcile computes exclusions as `observed − legacy`, so running
 *      it off a page-bound-truncated walk would let every channel past the
 *      bound into scope unexcluded — silent broadening through the mechanism
 *      that exists to prevent it. Deferral means: `reconciled_at` stays NULL,
 *      no exclusions are stamped, and the report says `legacy-pending`, until
 *      a COMPLETE walk reconciles.
 *   4. **An admin exclusion binds under `legacy-pending`** — both scope
 *      predicates subtract exclusions BEFORE consulting the captured
 *      allowlist, so an exclusion takes effect when the route writes it, not
 *      after the first successful reconcile.
 *
 * Every mutation named above was APPLIED and watched go red before this file
 * merged — see the PR body's falsifier table.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { saveInstallation } from "@atlas/api/lib/slack/store";
import { runKnowledgeSyncCycle } from "@atlas/api/lib/knowledge/sync";
import { upsertConnectorSyncState } from "@atlas/api/lib/knowledge/connector-sync";
import {
  _resetBrainSourceConnectors,
  registerBrainSourceConnector,
} from "@atlas/api/lib/brain/ingest/types";
import { createSlackHistoryConnector } from "@atlas/api/lib/brain/ingest/slack/connector";
import {
  MEMBERSHIP_PAGE_LIMIT,
  SLACK_EPISODE_SYNC_ID,
  excludeSlackChannel,
  isEventChannelInScope,
  refreshSlackIngestScope,
  resolveSlackPollScope,
  type SlackScopeRefreshDeps,
} from "@atlas/api/lib/brain/ingest/slack/scope";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-5203-scope";
const TEAM_ID = "T5203SCOPE";

/** Probe deps that answer every health probe green — probing is not under test. */
const HEALTHY_PROBES: Pick<
  SlackScopeRefreshDeps,
  "getConversationInfo" | "fetchConversationHistoryPage"
> = {
  getConversationInfo: (_token, channelId) =>
    Promise.resolve({
      ok: true as const,
      channel: { id: channelId, name: channelId, isPrivate: false, isMember: true, isArchived: false },
    }),
  fetchConversationHistoryPage: () =>
    Promise.resolve({ ok: true as const, messages: [], nextCursor: null, dropped: 0 }),
};

describeIfPg("brain source scope (real Postgres, #5203)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5203_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `hasInternalDB()` reads DATABASE_URL rather than the pool — without this
    // the cycle takes its "no database" arm and test 1 passes vacuously.
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;

    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // `organization` is Better-Auth's own table, skipped with
    // MANAGED_AUTH_MIGRATIONS — while the sync engine's tier-cap check
    // (`resolveIngestCaps`) reads it on every attempt. A MISSING TABLE faults
    // the lookup (fails closed, sync errors); a missing ROW is the "no plan →
    // no tier cap" self-hosted arm, which is what this suite wants. Columns
    // mirror `getWorkspaceDetails`'s SELECT list, per the wedge suite's stub.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS organization (
        id TEXT PRIMARY KEY,
        name TEXT,
        slug TEXT,
        workspace_status TEXT,
        plan_tier TEXT,
        byot BOOLEAN,
        "stripeCustomerId" TEXT,
        trial_ends_at TIMESTAMPTZ,
        suspended_at TIMESTAMPTZ,
        suspension_source TEXT,
        plan_override_until TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        region TEXT,
        region_assigned_at TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS * 2);

  afterAll(async () => {
    _resetPool(null);
    _resetBrainSourceConnectors();
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });

  it(
    "dispatches the Slack episode source off the chat install ALONE, and its sync state lands",
    async () => {
      // The chat-platform install, written through the real store — the same
      // row the adapter resolves tokens from. This is the ONLY Slack-shaped
      // state in the database: no workspace_plugins row, no catalog row, no
      // scope rows. If a second act of any kind were still required, the cycle
      // below would inspect zero workspaces and this test could not pass.
      await saveInstallation(TEAM_ID, "xoxb-scope-test", { orgId: WORKSPACE });

      // The REAL connector, with only its two Slack-API-touching seams faked.
      // `listWorkspaces` is deliberately left at its default —
      // `listSlackInstalledOrgIds` reading the row above — because that seam
      // IS the claim under test.
      const refreshedWorkspaces: string[] = [];
      _resetBrainSourceConnectors();
      registerBrainSourceConnector(
        createSlackHistoryConnector({
          refreshScope: ({ workspaceId }) => {
            refreshedWorkspaces.push(workspaceId);
            return Promise.resolve({
              mode: "membership" as const,
              observed: 0,
              retired: 0,
              reconciledExclusions: 0,
              membershipIncomplete: false,
              probed: 0,
              unhealthy: 0,
              warnings: [],
            });
          },
          resolvePollScope: () =>
            Promise.resolve({
              mode: "membership" as const,
              channels: [],
              excludedInMembership: 0,
            }),
        }),
      );

      const cycle = await runKnowledgeSyncCycle();
      expect(cycle.queryFailed).toBe(false);
      expect(cycle.inspected).toBe(1);
      expect(cycle.succeeded).toBe(1);
      expect(cycle.failed).toBe(0);
      expect(refreshedWorkspaces).toEqual([WORKSPACE]);

      // The C1 half: the attempt's outcome was RECORDED, with no
      // workspace_plugins row anywhere in the database. Round 1's
      // install-anchored guard made this row structurally unwritable, which
      // turned a revoked token into a green-but-frozen source.
      const { rows } = await pool.query<{ collection_id: string; status: string }>(
        `SELECT collection_id, status FROM knowledge_sync_state WHERE workspace_id = $1`,
        [WORKSPACE],
      );
      expect(rows).toEqual([{ collection_id: SLACK_EPISODE_SYNC_ID, status: "success" }]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it("anchors the sync-state guard on scope: workspace writes land, install writes still refuse", async () => {
    const ws = "ws-5203-anchor";
    const write = {
      status: "success" as const,
      error: null,
      report: { probe: true },
      highWaterMark: null,
      cursor: null,
      reconciledAt: null,
    };

    // Workspace anchor: no install row exists and none is required.
    await upsertConnectorSyncState(ws, "slack-history", write, "workspace");
    const landed = await pool.query(
      `SELECT 1 FROM knowledge_sync_state WHERE workspace_id = $1 AND collection_id = 'slack-history'`,
      [ws],
    );
    expect(landed.rows).toHaveLength(1);

    // Install anchor with no install row: the WHERE EXISTS guard refuses, by
    // design — that is bundle-sync's uninstall-race protection. What #5203
    // fixed is per-workspace sources being routed through THIS arm.
    await upsertConnectorSyncState(ws, "some-connector", write, "install");
    const refused = await pool.query(
      `SELECT 1 FROM knowledge_sync_state WHERE workspace_id = $1 AND collection_id = 'some-connector'`,
      [ws],
    );
    expect(refused.rows).toHaveLength(0);
  });

  it(
    "defers the lazy reconcile on an incomplete membership walk, then reconciles on a complete one",
    async () => {
      const ws = "ws-5203-reconcile";
      await pool.query(
        `INSERT INTO brain_slack_ingest_scope (workspace_id, legacy_channels)
         VALUES ($1, ARRAY['C0LEGACY'])`,
        [ws],
      );

      // ── An enumeration that never ends: every page full, always a cursor.
      // The refresh hits MEMBERSHIP_MAX_PAGES and flags the walk incomplete.
      const endlessPages: SlackScopeRefreshDeps = {
        ...HEALTHY_PROBES,
        fetchUserConversationsPage: (_token, params) => {
          const cursor = params.cursor ?? "0";
          const base = Number(cursor);
          return Promise.resolve({
            ok: true as const,
            channels: Array.from({ length: MEMBERSHIP_PAGE_LIMIT }, (_, i) => ({
              id: `C${String(base + i).padStart(8, "0")}`,
              name: `chan-${base + i}`,
              isPrivate: false,
              isMember: true,
              isArchived: false,
            })),
            nextCursor: String(base + MEMBERSHIP_PAGE_LIMIT),
          });
        },
      };
      const deferred = await refreshSlackIngestScope({
        workspaceId: ws,
        token: "xoxb-test",
        deps: endlessPages,
      });
      expect(deferred.membershipIncomplete).toBe(true);
      // Still legacy-pending: the caller must NOT act on membership.
      expect(deferred.mode).toBe("legacy-pending");
      expect(deferred.reconciledExclusions).toBe(0);
      // The deferral is SAID in the report the admin surface reads, not only
      // logged — deleting the warnings.push is what this goes red on.
      expect(deferred.warnings).toContainEqual(
        expect.stringContaining("was not reconciled this cycle"),
      );
      // Nothing stamped, nothing excluded. Reconciling here would have
      // computed exclusions from a partial `observed` and let every channel
      // past the page bound into scope unexcluded next cycle (AC-5).
      const afterDeferral = await pool.query<{ reconciled_at: Date | null }>(
        `SELECT reconciled_at FROM brain_slack_ingest_scope WHERE workspace_id = $1`,
        [ws],
      );
      expect(afterDeferral.rows[0]?.reconciled_at).toBeNull();
      const excludedEarly = await pool.query(
        `SELECT 1 FROM brain_slack_channel WHERE workspace_id = $1 AND excluded_at IS NOT NULL`,
        [ws],
      );
      expect(excludedEarly.rows).toHaveLength(0);
      // And the poll still reads the captured allowlist.
      expect(await resolveSlackPollScope(ws)).toMatchObject({
        mode: "legacy-pending",
        channels: ["C0LEGACY"],
      });

      // ── A complete walk: the bot is in the legacy channel and one more —
      // plus a DM whose id the stored-key pattern refuses, which must be
      // COUNTED into the report's warnings rather than dropped in silence
      // (the round-1 comment claimed counting that the code did not do).
      const completePage: SlackScopeRefreshDeps = {
        ...HEALTHY_PROBES,
        fetchUserConversationsPage: () =>
          Promise.resolve({
            ok: true as const,
            channels: [
              { id: "C0LEGACY", name: "legacy", isPrivate: false, isMember: true, isArchived: false },
              { id: "C0BEYOND", name: "beyond", isPrivate: false, isMember: true, isArchived: false },
              { id: "D0DMUSER", name: "dm", isPrivate: true, isMember: true, isArchived: false },
            ],
            nextCursor: null,
          }),
      };
      const reconciled = await refreshSlackIngestScope({
        workspaceId: ws,
        token: "xoxb-test",
        deps: completePage,
      });
      expect(reconciled.membershipIncomplete).toBe(false);
      expect(reconciled.mode).toBe("membership");
      expect(reconciled.observed).toBe(2);
      expect(reconciled.warnings).toContainEqual(
        expect.stringContaining("not a channel"),
      );
      // Exactly the set difference: observed − legacy.
      expect(reconciled.reconciledExclusions).toBe(1);
      const afterReconcile = await pool.query<{ reconciled_at: Date | null }>(
        `SELECT reconciled_at FROM brain_slack_ingest_scope WHERE workspace_id = $1`,
        [ws],
      );
      expect(afterReconcile.rows[0]?.reconciled_at).not.toBeNull();
      expect(await resolveSlackPollScope(ws)).toMatchObject({
        mode: "membership",
        channels: ["C0LEGACY"],
      });
    },
    PG_TEST_TIMEOUT_MS,
  );

  it("lists exactly the live, distinct Slack-installed orgs — the dispatch list for the whole feature", async () => {
    // `listSlackInstalledOrgIds` is what turns "Slack is connected" into "the
    // brain reads Slack", so its SQL semantics are behaviour, not plumbing:
    // an expired install must not dispatch, and one org with several TEAM
    // installs (a Slack org-wide app) must dispatch ONCE — a DISTINCT
    // regression double-syncs the workspace per cycle, two syncs clobbering
    // one cursor, the same collision class the reserved-syncId guards refuse.
    const { listSlackInstalledOrgIds } = await import("@atlas/api/lib/slack/store");

    // A second team install of the SAME org test 1 installed.
    await saveInstallation("T5203SECOND", "xoxb-scope-test-2", { orgId: WORKSPACE });
    // An EXPIRED install for a different org — the predicate must skip it.
    await pool.query(
      `INSERT INTO chat_cache (key, value, expires_at)
       VALUES ('slack:installation:TEXPIRED',
               jsonb_build_object('orgId', 'ws-5203-expired', 'botToken', 'xoxb-dead'),
               now() - interval '1 hour')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
    );
    // A row with no orgId at all — the env-fallback single-workspace shape.
    await pool.query(
      `INSERT INTO chat_cache (key, value)
       VALUES ('slack:installation:TNOORG', jsonb_build_object('botToken', 'xoxb-anon'))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );

    expect(await listSlackInstalledOrgIds()).toEqual([WORKSPACE]);
  });

  it("applies an admin exclusion under legacy-pending, in both predicates", async () => {
    const ws = "ws-5203-legacy-exclusion";
    await pool.query(
      `INSERT INTO brain_slack_ingest_scope (workspace_id, legacy_channels)
       VALUES ($1, ARRAY['C0KEEP', 'C0DROP'])`,
      [ws],
    );
    // Through the real writer — the same one the admin route calls after
    // answering 200 {changed: true}. If the predicates only consulted
    // exclusions after the first reconcile, that answer would be a lie for as
    // long as this workspace's Slack read kept failing.
    await excludeSlackChannel({
      workspaceId: ws,
      channelId: "C0DROP",
      reason: "confidential",
      actor: "user-admin",
    });

    expect(await resolveSlackPollScope(ws)).toMatchObject({
      mode: "legacy-pending",
      channels: ["C0KEEP"],
      excludedInMembership: 1,
    });
    expect(await isEventChannelInScope(ws, "C0KEEP")).toBe(true);
    expect(await isEventChannelInScope(ws, "C0DROP")).toBe(false);
    // Not in the allowlist at all — legacy-pending still refuses unknowns.
    expect(await isEventChannelInScope(ws, "C0NEVER")).toBe(false);
  });
});
