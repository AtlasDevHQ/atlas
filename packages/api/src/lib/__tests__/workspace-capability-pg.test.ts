/**
 * Real-Postgres coverage for the chat serviceability gate's capability probe
 * (#4826).
 *
 * `workspace-capability.test.ts` pins the probe's LOGIC against a stubbed row,
 * and its org-scoping assertions are string matches against the module's own
 * SQL constant — that proves the constant contains the text it contains. It
 * cannot prove the statement parses, that `workspace_plugins.pillar`,
 * `brain_facts.status`, and `brain_episodes.workspace_id` exist under that
 * spelling, or that `EXISTS` comes back as a JS boolean rather than `"t"`.
 *
 * That gap matters more here than usual because **every SQL fault in this probe
 * is silent to callers and to the mocked suite**: a throw lands in the `catch`,
 * is logged, and returns `{ kind: "unknown" }`, which fails OPEN. A column
 * rename would fail no mocked test — the gate would simply stop firing, and the
 * empty-workspace refusal this issue added would quietly stop existing while the
 * whole suite stayed green.
 *
 * The claims that need a live database:
 *
 *   1. **Does `CAPABILITY_SQL` parse against the migrated schema at all?**
 *   2. **Does each pillar light up independently?** A knowledge-only workspace
 *      must report `has_knowledge` and nothing else — that is the deployment
 *      shape #4826 unblocked, and the one with no prior coverage.
 *   3. **Is the workspace scoping real?** Every predicate binds `$1`; a missing
 *      one would let any tenant's rows satisfy another tenant's gate. Asserted
 *      by seeding a fully-populated neighbour and checking a bare workspace
 *      still reports all-false.
 *   4. **Does `status <> 'archived'` actually exclude?** The negative — an
 *      archived-only install must NOT count as a capability.
 *   5. **Is `has_brain` right to consult only `brain_episodes`?** The probe
 *      deliberately omits `brain_facts`, on the premise that the composite FK
 *      makes an episode mandatory for every fact. That premise is a schema
 *      claim, so it is asserted here rather than assumed.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { CAPABILITY_SQL } from "@atlas/api/lib/workspace-capability";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

interface CapabilityRow {
  has_datasource: boolean;
  has_knowledge: boolean;
  has_brain: boolean;
}

describeIfPg("CAPABILITY_SQL against real Postgres", () => {
  // Entropy beyond the timestamp, matching the other `-pg` suites: a collision
  // here is destructive rather than flaky, since `afterAll` DROPs the schema
  // CASCADE and this repo routinely runs concurrent `-pg` suites from several
  // worktrees against one local Postgres.
  const schemaName = `wscap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: Pool;

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

    // Catalog rows the installs below reference. `catalog:postgres` is seeded by
    // migration 0093, but a knowledge-pillar row is created at runtime in
    // production, so this test owns both to stay independent of seed drift.
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, install_model, pillar, enabled)
       VALUES ('catalog:wscap-ds', 'Cap DS', 'wscap-ds', 'datasource', 'form', 'datasource', true),
              ('catalog:wscap-kb', 'Cap KB', 'wscap-kb', 'context', 'form', 'knowledge', true)
       ON CONFLICT (id) DO NOTHING`,
    );
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  /** Run the production statement verbatim. */
  async function probe(workspaceId: string): Promise<CapabilityRow> {
    const { rows } = await pool.query<CapabilityRow>(CAPABILITY_SQL, [workspaceId]);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function installPlugin(opts: {
    workspaceId: string;
    pillar: "datasource" | "knowledge";
    status?: string;
  }): Promise<void> {
    const catalogId = opts.pillar === "datasource" ? "catalog:wscap-ds" : "catalog:wscap-kb";
    const installId = `${opts.workspaceId}-${opts.pillar}`;
    await pool.query(
      `INSERT INTO workspace_plugins
         (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, true, $6)`,
      [`wp-${installId}`, opts.workspaceId, catalogId, installId, opts.pillar, opts.status ?? "published"],
    );
  }

  async function seedEpisode(workspaceId: string, sourceId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U1', 'evidence', now(), ARRAY['org']::text[])
       RETURNING id`,
      [workspaceId, sourceId],
    );
    return rows[0]!.id;
  }

  async function seedFact(workspaceId: string, episodeId: string, status = "published"): Promise<void> {
    await pool.query(
      // `provenance` must be non-empty (chk_brain_facts_provenance_nonempty) —
      // NOT NULL alone would admit `'{}'`, an empty claim wearing the shape of
      // a real one. `visible_to` is likewise gated non-empty.
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance, status, visible_to)
       VALUES ($1, 'atlas', 'ships', 'brain', $2, $3::jsonb, $4, ARRAY['org']::text[])`,
      [workspaceId, episodeId, JSON.stringify({ extractor: "workspace-capability-pg-test" }), status],
    );
  }

  it("parses and reports all-false for a workspace with nothing", async () => {
    // Claim 1: if the statement does not parse against the migrated schema, the
    // probe fails open forever and the empty-workspace refusal never fires.
    const row = await probe("ws-cap-empty");

    expect(row).toEqual({ has_datasource: false, has_knowledge: false, has_brain: false });
    // Not `toBeTruthy`/`toBeFalsy`: production compares `=== true`, so a driver
    // returning the strings "t"/"f" would silently under-report every capability
    // and refuse every bound workspace — while a truthiness assertion stayed
    // green, since "f" is truthy. Pinning `typeof` catches the type, not the
    // value, which is the thing that can actually drift.
    expect(typeof row.has_datasource).toBe("boolean");
  });

  it("reports datasource alone for a datasource-only workspace", async () => {
    await installPlugin({ workspaceId: "ws-cap-ds", pillar: "datasource" });

    expect(await probe("ws-cap-ds")).toEqual({
      has_datasource: true,
      has_knowledge: false,
      has_brain: false,
    });
  });

  it("reports knowledge alone for a knowledge-only workspace", async () => {
    // The ADR-0028 deployment shape that had no chat surface before #4826.
    await installPlugin({ workspaceId: "ws-cap-kb", pillar: "knowledge" });

    expect(await probe("ws-cap-kb")).toEqual({
      has_datasource: false,
      has_knowledge: true,
      has_brain: false,
    });
  });

  it("reports brain alone for a workspace with only an episode", async () => {
    // `brain_episodes` carries no status column; this half of `has_brain` must
    // stand on its own, and a stray status predicate here would be a hard error.
    await seedEpisode("ws-cap-episode", "msg-1");

    expect(await probe("ws-cap-episode")).toEqual({
      has_datasource: false,
      has_knowledge: false,
      has_brain: true,
    });
  });

  it("reports brain for a workspace with facts — via the FK that makes an episode mandatory", async () => {
    // `has_brain` deliberately tests only `brain_episodes`. This asserts the
    // premise that makes that safe: a fact CANNOT exist without an episode in
    // the same workspace, because `brain_facts.source_episode_id` is NOT NULL
    // with a composite FK on (workspace_id, source_episode_id). If that FK were
    // ever relaxed, a facts-only workspace would become possible and the probe
    // would start under-reporting — so pin the constraint, not just the result.
    const episodeId = await seedEpisode("ws-cap-fact", "msg-2");
    await seedFact("ws-cap-fact", episodeId);

    expect((await probe("ws-cap-fact")).has_brain).toBe(true);

    // The negative: a fact referencing an episode from ANOTHER workspace must be
    // rejected outright, which is what forecloses the facts-without-episodes case.
    const foreignEpisodeId = await seedEpisode("ws-cap-fact-other", "msg-2b");
    await expect(seedFact("ws-cap-fact", foreignEpisodeId)).rejects.toThrow();
  });

  it("does NOT count an archived-only install", async () => {
    // The negative for `status <> 'archived'`. A workspace that archived its
    // last datasource is empty again and must get the refusal.
    await installPlugin({ workspaceId: "ws-cap-archived", pillar: "datasource", status: "archived" });
    await installPlugin({ workspaceId: "ws-cap-archived", pillar: "knowledge", status: "archived" });

    expect(await probe("ws-cap-archived")).toEqual({
      has_datasource: false,
      has_knowledge: false,
      has_brain: false,
    });
  });

  it("counts a draft install — content mode is deliberately ignored", async () => {
    // Documented trade-off: refusing a draft-only workspace would block an admin
    // mid-setup in developer mode. Pinned so it cannot be silently inverted.
    await installPlugin({ workspaceId: "ws-cap-draft", pillar: "datasource", status: "draft" });

    const row = await probe("ws-cap-draft");
    expect(row.has_datasource).toBe(true);
  });

  it("never lets one workspace's rows satisfy another workspace's gate", async () => {
    // Claim 3, the cross-tenant negative. A dropped `$1` on any predicate would
    // make a fully-populated neighbour light up this bare workspace — and the
    // failure direction is permissive, so nothing else would ever notice.
    await installPlugin({ workspaceId: "ws-cap-neighbour", pillar: "datasource" });
    await installPlugin({ workspaceId: "ws-cap-neighbour", pillar: "knowledge" });
    const episodeId = await seedEpisode("ws-cap-neighbour", "msg-3");
    await seedFact("ws-cap-neighbour", episodeId);

    // Sanity: the neighbour really is fully populated, so the assertion below
    // is not vacuous.
    expect(await probe("ws-cap-neighbour")).toEqual({
      has_datasource: true,
      has_knowledge: true,
      has_brain: true,
    });

    expect(await probe("ws-cap-bystander")).toEqual({
      has_datasource: false,
      has_knowledge: false,
      has_brain: false,
    });
  });
});
