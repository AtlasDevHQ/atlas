/**
 * Real-Postgres coverage for the malformed-grant sweep (#4797, ADR-0036).
 *
 * `grant-sweep.test.ts` pins what counts as malformed — the parse, the
 * boundary with `logGrantAnomalies`, the degradation shape. All of that runs
 * against fixture rows and none of it needs a database.
 *
 * What only real Postgres can settle is the SAFETY OF THE NARROW, which is the
 * one place this module could silently under-report. `NOT ('org' =
 * ANY(visible_to))` runs in the database, over `text[]` with NULL elements in
 * it, against grants that migration 0180's CHECK legally admits. The claim it
 * has to survive is not "it sheds most rows" but "it sheds ONLY rows that
 * demonstrably carry a valid principal" — and the counter-example that matters
 * (`['role:bogus']`: valid prefix, does not parse) is invisible to any
 * assertion made in TypeScript about SQL text.
 *
 * So the shape here is a CROSS-CHECK: seed every legal-at-rest grant, run the
 * narrowed scan, and separately run an UNNARROWED scan over the same rows
 * through the same parse. The two must flag exactly the same set. If the narrow
 * ever drops a row TS would call malformed, that equality breaks — which is the
 * only test that can fail in the direction this module cares about.
 *
 * Also pinned: that `grantScanSql` executes at all against the live schema. The
 * per-table status projection (`brain_episodes` has no `status` column) is a
 * runtime error on one of the two tables if it is written once and shared.
 *
 * Opt in locally with:
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/atlas_dev
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { ACL_GATED_TABLES, parseGrant, type AclGatedTable } from "@atlas/api/lib/brain/acl";
import { grantScanSql, runGrantSweepCycle } from "@atlas/api/lib/brain/grant-sweep";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-sweep-pg";
const WS_B = "ws-sweep-pg-b";

/**
 * Every grant below is legal at rest under `chk_brain_*_grant_nonempty`, which
 * requires one non-NULL non-empty element and says nothing about the grammar.
 * `malformed` is the EXPECTATION — derived by hand, not from `parseGrant`, so
 * this table is an independent statement of the contract rather than a mirror
 * of the implementation.
 */
const GRANTS: ReadonlyArray<{
  label: string;
  visibleTo: (string | null)[];
  malformed: boolean;
}> = [
  // --- carries a valid principal: must never be flagged ---
  { label: "org", visibleTo: ["org"], malformed: false },
  { label: "role-member", visibleTo: ["role:member"], malformed: false },
  { label: "user", visibleTo: ["user:user-1"], malformed: false },
  { label: "audience", visibleTo: ["audience:eng"], malformed: false },
  // Partly malformed — logGrantAnomalies' remit at read time, not this sweep's.
  { label: "half-malformed", visibleTo: ["everyone", "user:user-1"], malformed: false },
  { label: "padded-org", visibleTo: ["org", null, ""], malformed: false },
  { label: "padded-user", visibleTo: ["", "user:user-2"], malformed: false },

  // --- entirely malformed: the rows this sweep exists for ---
  //
  // The four that a prefix-based SQL narrow would DROP. Each has a valid
  // prefix and does not parse, so any pre-filter reasoning about the
  // parameterised arms silently under-reports exactly here.
  { label: "role-bogus", visibleTo: ["role:bogus"], malformed: true },
  { label: "role-platform-admin", visibleTo: ["role:platform_admin"], malformed: true },
  { label: "bare-prefixes", visibleTo: ["user:", "audience:"], malformed: true },
  { label: "case-variant-audience", visibleTo: ["Audience:eng"], malformed: true },
  // The obvious ones, kept for completeness — they prove far less.
  { label: "everyone", visibleTo: ["everyone"], malformed: true },
  { label: "team-eng", visibleTo: ["team:eng"], malformed: true },
  { label: "shouty-org", visibleTo: ["ORG"], malformed: true },
  { label: "padded-org-space", visibleTo: ["org "], malformed: true },
  // Legal at rest AND entirely unusable: one non-empty element, no grammar.
  { label: "empty-plus-junk", visibleTo: ["", "everyone"], malformed: true },
];

const EXPECTED_MALFORMED = GRANTS.filter((g) => g.malformed).map((g) => g.label).toSorted();

/** `hasInternalDB()` reads DATABASE_URL; set inside tests, never at top level. */
function withDatabaseUrl<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.DATABASE_URL;
  process.env.DATABASE_URL = TEST_DB_URL ?? "postgres://stub/stub";
  return fn().finally(() => {
    if (prior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior;
  });
}

describeIfPg("brain malformed-grant sweep (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `brain_sweep_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** Insert an episode; its `source_id` carries the fixture label. */
  async function seedEpisode(
    workspaceId: string,
    label: string,
    visibleTo: readonly (string | null)[],
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to)
       VALUES ($1, 'test', $2, 'evidence', $3::text[])
       RETURNING id`,
      [workspaceId, label, visibleTo],
    );
    return rows[0]!.id;
  }

  async function seedFact(opts: {
    workspaceId: string;
    episodeId: string;
    subject: string;
    visibleTo: readonly (string | null)[];
    status?: "draft" | "published" | "archived";
  }): Promise<void> {
    await pool.query(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance, status, visible_to)
       VALUES ($1, $2, 'is', 'thing', $3, '{"actor":"test"}'::jsonb, $4, $5::text[])`,
      [opts.workspaceId, opts.subject, opts.episodeId, opts.status ?? "published", opts.visibleTo],
    );
  }

  /** The sweep's own query, run for real. Returns the rows it would parse. */
  async function narrowedScan(table: AclGatedTable) {
    const { rows } = await pool.query(grantScanSql(table), [10_000]);
    return rows as Array<{ id: string; visible_to: unknown[]; status: string | null }>;
  }

  /**
   * The same projection WITHOUT the narrow — the control arm. Anything this
   * flags and {@link narrowedScan} does not is a row the optimisation dropped.
   */
  async function unnarrowedScan(table: AclGatedTable) {
    const status = table === "brain_facts" ? "status" : "NULL::text AS status";
    const { rows } = await pool.query(
      `SELECT workspace_id, id, visible_to, ${status} FROM ${table} ORDER BY workspace_id, id`,
    );
    return rows as Array<{ id: string; visible_to: unknown[]; status: string | null }>;
  }

  const flagged = (rows: Array<{ visible_to: unknown[] }>, key: (i: number) => string) =>
    rows
      .map((r, i) => ({ label: key(i), parsed: parseGrant(r.visible_to) }))
      .filter((r) => r.parsed.principals.length === 0)
      .map((r) => r.label)
      .toSorted();

  beforeAll(async () => {
    // `search_path` baked into the connection string rather than SET from an
    // unawaited `pool.on("connect")` handler — same reasoning as
    // `acl-visibility-pg.test.ts`: no window in which a checked-out client is
    // still pointed at `public` and runs the migration set against the
    // developer's real database.
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

    // Seed both tables with the same grant matrix. The episode carrying each
    // fact is granted `org` so the fact's own grant is the only variable — a
    // malformed EPISODE grant would otherwise be indistinguishable from the
    // fact's in the totals.
    const carrier = await seedEpisode(WS, "carrier", ["org"]);
    for (const g of GRANTS) {
      await seedFact({
        workspaceId: WS,
        episodeId: carrier,
        subject: g.label,
        visibleTo: g.visibleTo,
      });
      await seedEpisode(WS, `ep-${g.label}`, g.visibleTo);
    }
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it("executes against the live schema for every gated table", async () => {
    // The status projection branches per table; written once and shared it is a
    // 42703 on `brain_episodes`, which has no `status` column.
    for (const table of ACL_GATED_TABLES) {
      const rows = await narrowedScan(table);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it("the `org` narrow sheds ONLY rows that carry a valid principal", async () => {
    // The load-bearing test. Narrowed and unnarrowed scans must flag the same
    // set — the narrow may drop rows, but never a row the parse would flag.
    for (const table of ACL_GATED_TABLES) {
      const narrowed = await narrowedScan(table);
      const all = await unnarrowedScan(table);

      const byId = (rows: Array<{ id: string; visible_to: unknown[] }>) =>
        flagged(rows, (i) => rows[i]!.id);

      expect({ table, flagged: byId(narrowed) }).toEqual({ table, flagged: byId(all) });
      // And it must actually be narrowing, or the assertion above is vacuous.
      expect(narrowed.length).toBeLessThan(all.length);
    }
  });

  it("flags exactly the hand-listed malformed grants, not a superset", async () => {
    const rows = await narrowedScan("brain_facts");
    const { rows: labelled } = await pool.query<{ id: string; subject: string }>(
      `SELECT id, subject FROM brain_facts WHERE workspace_id = $1`,
      [WS],
    );
    const subjectById = new Map(labelled.map((r) => [r.id, r.subject]));

    expect(flagged(rows, (i) => subjectById.get(rows[i]!.id) ?? "?")).toEqual(EXPECTED_MALFORMED);
  });

  it("keeps `role:bogus` — the row a prefix-based narrow would drop", async () => {
    // Called out on its own because it is the single fixture that distinguishes
    // a real parse from every cheaper approximation. If someone "optimises" the
    // scan into a prefix predicate, the equality test above and this one are
    // what break.
    const rows = await narrowedScan("brain_facts");
    const { rows: labelled } = await pool.query<{ id: string }>(
      `SELECT id FROM brain_facts WHERE workspace_id = $1 AND subject = 'role-bogus'`,
      [WS],
    );
    expect(rows.some((r) => r.id === labelled[0]!.id)).toBe(true);
  });

  it("counts rows and distinct workspaces across both tables", async () => {
    // A second workspace, so `malformedWorkspaces` is provably a DISTINCT count
    // and not a row count that happens to match.
    const carrierB = await seedEpisode(WS_B, "carrier-b", ["org"]);
    await seedFact({
      workspaceId: WS_B,
      episodeId: carrierB,
      subject: "b-malformed",
      visibleTo: ["role:bogus"],
      status: "draft",
    });

    const result = await withDatabaseUrl(() =>
      runGrantSweepCycle({ query: (sql, params) => pool.query(sql, params).then((r) => r.rows) }),
    );

    // Facts + episodes from WS, plus the one draft fact in WS_B.
    const perTable = EXPECTED_MALFORMED.length;
    expect(result.status).toBe("success");
    expect(result.malformedRows).toBe(perTable * 2 + 1);
    expect(result.malformedWorkspaces).toBe(2);
    expect(result.scanTruncated).toBe(false);

    // The draft is in the flagged set — invisible to the review queue as well
    // as to every reader, so it is the row least likely to surface any other
    // way. It also proves `status` survives the projection into the log sample.
    expect(result.sample.some((s) => s.status === "draft" && s.workspaceId === WS_B)).toBe(true);
    // Episodes carry a NULL status; facts never do.
    expect(result.sample.some((s) => s.table === "brain_episodes" && s.status === null)).toBe(true);
  });

  it("respects the row cap and reports the truncation", async () => {
    const result = await withDatabaseUrl(() =>
      runGrantSweepCycle({
        query: (sql, params) => pool.query(sql, params).then((r) => r.rows),
        rowCap: 2,
      }),
    );

    expect(result.scanTruncated).toBe(true);
    expect(result.rowsScanned).toBe(4); // 2 per table, both capped
  });
});
