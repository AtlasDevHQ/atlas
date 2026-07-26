/**
 * Real-Postgres coverage for audience-membership sync (#4801, ADR-0036).
 *
 * The unit suites pin the decisions; this pins the two claims that are only
 * true against a real database and a real ACL read:
 *
 *   1. **Revocation flows through LIVE.** Removing someone from the source
 *      roster and re-running the sync makes the facts disappear from THEIR next
 *      read — no re-ingest, no rewrite of a stored row. That is the entire
 *      reason ADR-0036 routes sensitive facts through an `audience:` rather
 *      than baking principals into the grant, and it is a property of the
 *      membership table plus `resolvePrincipalContext` together.
 *   2. **Re-sync is idempotent.** The second identical pass writes nothing.
 *
 * Reader identity is resolved with the real `resolvePrincipalContext` rather
 * than hand-built, so what is asserted is the membership → token expansion the
 * production read performs. A hand-built context would make every assertion
 * below a statement about the fixture (#4775's finding).
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { resolvePrincipalContext, type BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { chatChannelAudienceId } from "@atlas/api/lib/brain/ingest/grant";
import {
  SLACK_HISTORY_CATALOG_ID,
  SLACK_HISTORY_SOURCE,
} from "@atlas/api/lib/brain/ingest/slack/config";
import { AUDIENCE_STALENESS_SQL, AUDIENCE_SYNC_INSTALLS_SQL } from "../sync";
import { reconcileAudienceMembership, type MembershipExecutor } from "../membership";
import { resolvePrincipals } from "../resolver";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-audience";
const OTHER_WORKSPACE = "ws-other";
const CHANNEL = "C0EXEC";
const AUDIENCE = chatChannelAudienceId(SLACK_HISTORY_SOURCE, CHANNEL);

describeIfPg("brain audience membership (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `brain_4801_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    const { rows } = await pool.query(sql, params);
    return rows as T[];
  };

  const withTransaction = async <T>(fn: (tx: MembershipExecutor) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn({
        query: async (sql, params) => {
          const res = await client.query(sql, params);
          return { rows: res.rows as readonly unknown[] };
        },
      });
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        console.debug("fixture rollback failed", rbErr);
      });
      throw err;
    } finally {
      client.release();
    }
  };

  const reconcile = (userIds: readonly string[]) =>
    reconcileAudienceMembership(
      { workspaceId: WORKSPACE, audienceId: AUDIENCE, source: SLACK_HISTORY_SOURCE, userIds },
      { withTransaction },
    );

  /** The real reader-identity resolution, against the real membership table. */
  const readerFor = (userId: string): Promise<BrainPrincipalContext> =>
    resolvePrincipalContext(
      { query: (sql, params) => pool.query(sql, params).then((r) => ({ rows: r.rows })) },
      {
        workspaceId: WORKSPACE,
        mode: "managed",
        userId,
        resolvedRole: { role: "member", orgId: WORKSPACE },
      },
    );

  beforeAll(async () => {
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
    // Better Auth's tables, stubbed to exactly the shape the resolver joins.
    await pool.query(`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS member (
        id TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        role TEXT
      )
    `);
    await pool.query(
      `INSERT INTO "user" (id, email) VALUES
         ('user-ada', 'ada@corp.test'),
         ('user-bob', 'bob@corp.test'),
         ('user-eve', 'eve@gmail.test'),
         ('user-far', 'far@corp.test')`,
    );
    await pool.query(
      `INSERT INTO member (id, "organizationId", "userId", role) VALUES
         ('m1', $1, 'user-ada', 'member'),
         ('m2', $1, 'user-bob', 'member'),
         ('m3', $1, 'user-eve', 'member'),
         ('m4', $2, 'user-far', 'member')`,
      [WORKSPACE, OTHER_WORKSPACE],
    );
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await pool.query(`TRUNCATE fact_audience_member`);
    await pool.query(`DELETE FROM sso_providers`);
  });

  it("grants on the reader's NEXT read, with no re-ingest", async () => {
    const before = await readerFor("user-ada");
    expect(before.audienceIds).toEqual([]);

    await reconcile(["user-ada"]);

    const after = await readerFor("user-ada");
    expect(after.audienceIds).toEqual([AUDIENCE]);
  }, PG_TEST_TIMEOUT_MS);

  it("REVOKES on the next read when the source roster drops someone", async () => {
    // The acceptance criterion that carries the design weight. Nothing about
    // the fact or the episode is touched — only this table — and the reader
    // loses the audience token on their very next resolution.
    await reconcile(["user-ada", "user-bob"]);
    expect((await readerFor("user-bob")).audienceIds).toEqual([AUDIENCE]);

    const changed = await reconcile(["user-ada"]);
    expect(changed).toEqual({ added: 0, revoked: 1 });

    expect((await readerFor("user-bob")).audienceIds).toEqual([]);
    // The member who stayed is untouched — a revocation must be surgical, not
    // a rebuild that briefly empties the audience.
    expect((await readerFor("user-ada")).audienceIds).toEqual([AUDIENCE]);
  }, PG_TEST_TIMEOUT_MS);

  it("is idempotent — an unchanged re-sync reports nothing, preserves created_at, and REFRESHES synced_at", async () => {
    await reconcile(["user-ada", "user-bob"]);
    // The two clocks must be able to diverge for the assertions below to mean
    // anything; without this the re-sync could land inside the same millisecond.
    await pool.query(
      `UPDATE fact_audience_member SET created_at = created_at - interval '1 hour',
                                       synced_at  = synced_at  - interval '1 hour'`,
    );
    const aged = await pool.query<{ created_at: Date; synced_at: Date }>(
      `SELECT created_at, synced_at FROM fact_audience_member WHERE user_id = 'user-ada'`,
    );

    const second = await reconcile(["user-ada", "user-bob"]);
    // THE TRAP. The natural way to stamp `synced_at` on a re-sync is to turn
    // the INSERT's `ON CONFLICT DO NOTHING` into `DO UPDATE SET synced_at =
    // now()` — and that makes `RETURNING user_id` emit the WHOLE roster every
    // cycle, so `added` silently stops meaning "newly granted" and starts
    // meaning "everyone". The "membership granted" log would then fire every 30
    // minutes and `atlas.brain.audience.members_added` would stop meaning
    // anything, with nothing erroring and no other assertion noticing.
    expect(second).toEqual({ added: 0, revoked: 0 });

    const after = await pool.query<{ created_at: Date; synced_at: Date }>(
      `SELECT created_at, synced_at FROM fact_audience_member WHERE user_id = 'user-ada'`,
    );
    // `created_at` answers "since when has this person been able to see this?".
    // An upsert that rewrote it every cycle would turn that into "since the
    // last cycle", i.e. into nothing.
    expect(after.rows[0]?.created_at).toEqual(aged.rows[0]?.created_at);
    // `synced_at` answers a DIFFERENT question — "when did we last CHECK?" — so
    // the no-op pass must advance it. "Unchanged" is still "verified"; if the
    // steady-state pass skipped the stamp, the column would age on every
    // healthy audience and the read-time bound would start denying correct
    // grants. Both properties, one re-sync: that is why they are one test.
    expect(after.rows[0]!.synced_at.getTime()).toBeGreaterThan(
      aged.rows[0]!.synced_at.getTime(),
    );
  }, PG_TEST_TIMEOUT_MS);

  it("leaves synced_at ALONE when the reconcile aborts — 'last verified', never 'last touched'", async () => {
    // The column's whole meaning. `sync.ts` aborts an audience whose roster it
    // could not read COMPLETELY, without calling `reconcileAudienceMembership`
    // at all — so the abort is modelled here as exactly that: no call. If a
    // failed read stamped the column anyway, `synced_at` would read healthiest
    // for precisely the workspaces that are broken, and the staleness bound
    // would never fire on the case it exists for.
    await reconcile(["user-ada"]);
    await pool.query(`UPDATE fact_audience_member SET synced_at = now() - interval '9 days'`);
    const before = await pool.query<{ synced_at: Date }>(
      `SELECT synced_at FROM fact_audience_member WHERE user_id = 'user-ada'`,
    );

    // ... a cycle in which the roster read fails: membership untouched.
    const after = await pool.query<{ synced_at: Date }>(
      `SELECT synced_at FROM fact_audience_member WHERE user_id = 'user-ada'`,
    );
    expect(after.rows[0]?.synced_at).toEqual(before.rows[0]?.synced_at);

    // And that is what the reader now acts on: past the bound the grant stops
    // being served, so a permanently-failing roster read can no longer keep
    // granting access forever (#4808).
    expect((await readerFor("user-ada")).audienceIds).toEqual([]);
  }, PG_TEST_TIMEOUT_MS);

  it("keeps serving a grant that is stale but still INSIDE the bound", async () => {
    // The other half, and the one that keeps the bound from being a hair
    // trigger: a workspace whose Slack is briefly unreachable must not lose its
    // private-channel facts over a bad afternoon.
    await reconcile(["user-ada"]);
    await pool.query(`UPDATE fact_audience_member SET synced_at = now() - interval '2 days'`);
    expect((await readerFor("user-ada")).audienceIds).toEqual([AUDIENCE]);
  }, PG_TEST_TIMEOUT_MS);

  it("counts stale audiences with the sweep the span reports", async () => {
    // Runs the exact production string against the live schema. The aggregate
    // is easy to get subtly wrong — a `WHERE` on `synced_at` rather than a
    // `HAVING`-shaped filter on the grouped minimum would count ROWS (people)
    // and report a two-person audience as two stale audiences.
    await reconcile(["user-ada", "user-bob"]);
    const fresh = await query<{ stale_audiences: number; oldest_age_seconds: string }>(
      AUDIENCE_STALENESS_SQL,
      [7 * 24 * 3600],
    );
    expect(fresh[0]?.stale_audiences).toBe(0);

    await pool.query(`UPDATE fact_audience_member SET synced_at = now() - interval '11 days'`);
    const stale = await query<{
      stale_audiences: number;
      stale_workspaces: number;
      oldest_age_seconds: string;
    }>(AUDIENCE_STALENESS_SQL, [7 * 24 * 3600]);
    // TWO members, ONE audience.
    expect(stale[0]?.stale_audiences).toBe(1);
    expect(stale[0]?.stale_workspaces).toBe(1);
    expect(Number(stale[0]?.oldest_age_seconds)).toBeGreaterThan(10 * 24 * 3600);
  }, PG_TEST_TIMEOUT_MS);

  it("an empty roster revokes the whole audience", async () => {
    await reconcile(["user-ada", "user-bob"]);
    const changed = await reconcile([]);
    expect(changed).toEqual({ added: 0, revoked: 2 });
    expect((await readerFor("user-ada")).audienceIds).toEqual([]);
  }, PG_TEST_TIMEOUT_MS);

  it("does not reconcile away another source's rows in the same audience", async () => {
    await pool.query(
      `INSERT INTO fact_audience_member (workspace_id, audience_id, user_id, source)
       VALUES ($1, $2, 'user-bob', 'teams')`,
      [WORKSPACE, AUDIENCE],
    );
    const changed = await reconcile(["user-ada"]);
    expect(changed.revoked).toBe(0);
    const { rows } = await pool.query(
      `SELECT user_id FROM fact_audience_member WHERE source = 'teams'`,
    );
    expect(rows).toHaveLength(1);
  }, PG_TEST_TIMEOUT_MS);

  describe("the install scan against the live schema", () => {
    // The one statement in this feature that touches `workspace_plugins`'
    // `pillar` / `enabled` / `status` / `config` columns. Its doc-comment claims
    // it is run here; before this block that claim was false, and a column
    // rename would have silently returned zero installs — a cycle that reports
    // success forever while reconciling nothing, which is the "revocation
    // stopped and nobody noticed" failure with no signal at all.
    const seedInstall = (id: string, over: Record<string, unknown> = {}) => {
      const row = {
        workspace_id: WORKSPACE,
        catalog_id: SLACK_HISTORY_CATALOG_ID,
        install_id: id,
        pillar: "knowledge",
        enabled: true,
        status: "published",
        config: { channels: [CHANNEL] },
        ...over,
      };
      return pool.query(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, enabled, status, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          `wp-${id}`,
          row.workspace_id,
          row.catalog_id,
          row.install_id,
          row.pillar,
          row.enabled,
          row.status,
          JSON.stringify(row.config),
        ],
      );
    };

    it("returns enabled non-archived installs and excludes the rest", async () => {
      // `workspace_plugins.catalog_id` is FK-constrained to this table.
      await pool.query(
        `INSERT INTO plugin_catalog (id, slug, name, type, pillar)
         VALUES ($1, 'slack-history', 'Slack history', 'context', 'knowledge')
         ON CONFLICT (id) DO NOTHING`,
        [SLACK_HISTORY_CATALOG_ID],
      );
      await seedInstall("live");
      await seedInstall("off", { enabled: false });
      await seedInstall("archived", { status: "archived" });
      // `draft` is admitted by the predicate (`status <> 'archived'`), matching
      // the ingest cycle's filter exactly — an install being edited must not
      // stop having its membership reconciled.
      await seedInstall("draft", { status: "draft" });

      const rows = await query<{ install_id: string; config: Record<string, unknown> }>(
        AUDIENCE_SYNC_INSTALLS_SQL,
        [SLACK_HISTORY_CATALOG_ID],
      );
      expect(rows.map((r) => r.install_id)).toEqual(["draft", "live"]);
      // The `config` column has to come back as parsed JSON, or
      // `parseSlackHistoryConfig` refuses every install with "no channel list".
      expect(rows[0]?.config).toEqual({ channels: [CHANNEL] });

      await pool.query(`DELETE FROM workspace_plugins WHERE workspace_id = $1`, [WORKSPACE]);
    }, PG_TEST_TIMEOUT_MS);
  });

  describe("resolvePrincipals against the live schema", () => {
    it("resolves an email to the workspace member and skips a user in another org", async () => {
      const result = await resolvePrincipals(
        WORKSPACE,
        [
          { id: "U_ADA", email: "Ada@Corp.test" },
          // A real Atlas user, but a member of a DIFFERENT org. Resolving them
          // would write a membership row granting inside THIS tenant.
          { id: "U_FAR", email: "far@corp.test" },
        ],
        { query },
      );
      expect(result.resolved.get("U_ADA")).toBe("user-ada");
      expect(result.resolved.has("U_FAR")).toBe(false);
      expect(result.unresolvedCount).toBe(1);
    }, PG_TEST_TIMEOUT_MS);

    it("narrows to a DNS-verified SSO domain when the workspace has one", async () => {
      await pool.query(
        `INSERT INTO sso_providers (id, org_id, type, issuer, domain, enabled, config, domain_verified)
         VALUES (gen_random_uuid(), $1, 'oidc', 'https://idp.test', 'corp.test', true, '{}'::jsonb, true)`,
        [WORKSPACE],
      );
      const result = await resolvePrincipals(
        WORKSPACE,
        [
          { id: "U_ADA", email: "ada@corp.test" },
          // A real member of this workspace — excluded purely because the
          // address is outside the verified domain. This is the narrowing.
          { id: "U_EVE", email: "eve@gmail.test" },
        ],
        { query },
      );
      expect(result.resolved.get("U_ADA")).toBe("user-ada");
      expect(result.resolved.has("U_EVE")).toBe(false);
    }, PG_TEST_TIMEOUT_MS);

    it("does not narrow on an UNVERIFIED domain", async () => {
      // Narrowing to an unproven domain would let whoever can add a domain row
      // decide which emails resolve.
      //
      // `enabled` is false because `chk_enabled_requires_verified` makes
      // enabled-and-unverified UNREPRESENTABLE — which is exactly why
      // `VERIFIED_SSO_DOMAINS_SQL`'s `domain_verified = true` is belt-and-
      // braces rather than the load-bearing half. Pinned here so that if the
      // CHECK is ever relaxed, this row becomes constructible in the shape the
      // predicate is written to exclude, and the test still holds.
      await pool.query(
        `INSERT INTO sso_providers (id, org_id, type, issuer, domain, enabled, config, domain_verified)
         VALUES (gen_random_uuid(), $1, 'oidc', 'https://idp.test', 'corp.test', false, '{}'::jsonb, false)`,
        [WORKSPACE],
      );
      const result = await resolvePrincipals(
        WORKSPACE,
        [{ id: "U_EVE", email: "eve@gmail.test" }],
        { query },
      );
      expect(result.resolved.get("U_EVE")).toBe("user-eve");
    }, PG_TEST_TIMEOUT_MS);
  });
});
