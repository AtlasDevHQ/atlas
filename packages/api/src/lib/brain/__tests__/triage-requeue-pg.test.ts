/**
 * Real-Postgres coverage for the triage backlog and the re-queue verb (#5534).
 *
 * `triage-requeue.test.ts` pins the statements' SHAPE against a literal handle.
 * Four questions need a real database and none of them can be answered there —
 * and until this file existed, **no Postgres had ever parsed either statement**:
 * `REQUEUE_TRIAGED_SQL` shipped with #5531 caller-less, and both
 * {@link TRIAGE_BACKLOG_SQL} and {@link REQUEUE_TRIAGED_COUNTED_SQL} are new
 * with this change. The first database to see them would otherwise have been
 * production, on an act that cannot be undone.
 *
 *   1. **Does the data-modifying CTE parse and run?**
 *      `WITH requeued AS (UPDATE … RETURNING 1) SELECT count(*)::int` is
 *      assembled by string concatenation from a constant another module owns.
 *      A trailing clause on that constant makes it `RETURNING … RETURNING 1`,
 *      and every `toContain` pin in both local suites stays green through it.
 *      Only executing it proves the composition.
 *   2. **Do the count and the verb describe the SAME rows?** They share a
 *      predicate by convention; a real backlog seeded across both arms is what
 *      shows the number an admin reads is the number the verb moves — including
 *      the trap row (triaged AND extracted) that the count must exclude because
 *      the UPDATE declines to touch it.
 *   3. **Does a cleared episode actually return to the drain, in its original
 *      position?** The whole warrant for calling this a re-queue rather than a
 *      re-ingest. Answered by running `DRAIN_EPISODES_SQL` before and after.
 *   4. **Does 0210's CHECK admit the cleared state?**
 *      `num_nonnulls(triaged_out_at, triage_reason) <> 1` is satisfied by BOTH
 *      columns NULL and by both set. A re-queue that violated it would fail at
 *      the constraint, in prod, mid-act.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { DRAIN_EPISODES_SQL, MARK_TRIAGED_SQL } from "@atlas/api/lib/brain/extract";
import {
  TRIAGE_BACKLOG_SQL,
  REQUEUE_TRIAGED_COUNTED_SQL,
  loadTriageBacklog,
  requeueTriagedEpisodes,
  type TriageBacklogReader,
} from "@atlas/api/lib/brain/triage-requeue";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

describeIfPg("brain triage backlog + re-queue (real Postgres)", () => {
  let pool: Pool;
  let reader: TriageBacklogReader;
  const schemaName = `brain_triage_requeue_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const WORKSPACE = "ws-triage-pg";
  /** A second workspace, seeded on every test — the `$1` scope's falsifier. */
  const OTHER_WORKSPACE = "ws-triage-pg-other";

  beforeAll(async () => {
    // `search_path` baked into the connection string, not SET from an unawaited
    // `pool.on("connect")` handler — see the note in `acl-visibility-pg.test.ts`.
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
    reader = { query: (sql, params) => pool.query(sql, params) };
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    await pool.query("DELETE FROM brain_episodes");
  });

  /**
   * Seed one episode. `ingestedAt` is explicit so the drain-order assertion has
   * something to be about — the re-queue's claim is that a cleared episode
   * returns to its ORIGINAL position, which is unfalsifiable if every row
   * shares a timestamp.
   */
  async function seedEpisode(opts: {
    readonly workspaceId?: string;
    readonly sourceId: string;
    readonly ingestedAt: string;
    readonly extracted?: boolean;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, body, visible_to, ingested_at, extracted_at)
       VALUES ($1, 'slack', $2, 'a body', ARRAY['org']::text[], $3::timestamptz, $4)
       RETURNING id`,
      [
        opts.workspaceId ?? WORKSPACE,
        opts.sourceId,
        opts.ingestedAt,
        opts.extracted === true ? new Date() : null,
      ],
    );
    return rows[0]!.id;
  }

  /**
   * Write a triage mark through the fiber's OWN statement, never a hand-rolled
   * UPDATE. The re-queue's contract is against what the mark path actually
   * writes; a fixture that set the columns itself could satisfy this suite
   * while disagreeing with production.
   *
   * ⚠️ `MARK_TRIAGED_SQL` carries `AND extracted_at IS NULL`, so it declines an
   * already-extracted row. {@link markExtractedAndTriaged} is how the trap row
   * for that state gets built.
   */
  async function mark(episodeId: string, rule: string, workspaceId = WORKSPACE): Promise<number> {
    const res = await pool.query(MARK_TRIAGED_SQL, [episodeId, workspaceId, rule]);
    return res.rowCount ?? 0;
  }

  /**
   * The state neither statement's WHERE clause may treat as backlog: marked,
   * and extracted anyway by some other path. `MARK_TRIAGED_SQL` refuses to
   * build it (by design), so it is written directly — the one place this suite
   * bypasses the production statement, because the point is to construct a row
   * production's happy path cannot.
   */
  async function markExtractedAndTriaged(episodeId: string, rule: string): Promise<void> {
    await pool.query(
      `UPDATE brain_episodes
          SET triaged_out_at = now(), triage_reason = $2, extracted_at = now()
        WHERE id = $1`,
      [episodeId, rule],
    );
  }

  async function drainedIds(limit = 50): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(DRAIN_EPISODES_SQL, [limit, []]);
    return rows.map((r) => r.id);
  }

  it("the counting CTE parses, runs, and returns the rows it changed", async () => {
    // Question 1. If `REQUEUE_TRIAGED_SQL` ever gains a trailing clause, the
    // composed statement becomes `RETURNING … RETURNING 1` and this line is
    // what fails — nothing in the two local suites can see it.
    const a = await seedEpisode({ sourceId: "a", ingestedAt: "2026-08-01T00:00:00Z" });
    const b = await seedEpisode({ sourceId: "b", ingestedAt: "2026-08-02T00:00:00Z" });
    expect(await mark(a, "known_ack")).toBe(1);
    expect(await mark(b, "known_ack")).toBe(1);

    const { rows } = await pool.query(REQUEUE_TRIAGED_COUNTED_SQL, [WORKSPACE, null]);
    expect(rows[0]).toEqual({ requeued: 2 });
  });

  it("counts and clears the SAME population, trap row included", async () => {
    // Question 2. `held` is backlog; `extractedToo` is marked but extracted, so
    // the UPDATE declines it — and a count that included it would offer an
    // admin a re-queue of a row nothing can move.
    const held = await seedEpisode({ sourceId: "held", ingestedAt: "2026-08-01T00:00:00Z" });
    const extractedToo = await seedEpisode({
      sourceId: "trap",
      ingestedAt: "2026-08-02T00:00:00Z",
      extracted: true,
    });
    await mark(held, "known_ack");
    await markExtractedAndTriaged(extractedToo, "known_ack");

    const before = await loadTriageBacklog(reader, WORKSPACE);
    expect(before).toEqual({
      total: 1,
      byRule: [{ rule: "known_ack", episodes: 1, known: true }],
      degraded: false,
    });

    const { requeued } = await requeueTriagedEpisodes(reader, WORKSPACE, null);
    expect(requeued).toBe(before.total);
    expect(await loadTriageBacklog(reader, WORKSPACE)).toEqual({ total: 0, byRule: [], degraded: false });

    // The trap row is untouched — still marked, still extracted.
    const { rows } = await pool.query<{ triage_reason: string | null }>(
      "SELECT triage_reason FROM brain_episodes WHERE id = $1",
      [extractedToo],
    );
    expect(rows[0]?.triage_reason).toBe("known_ack");
  });

  it("returns a cleared episode to the drain in its ORIGINAL position", async () => {
    // Question 3. `oldest` is ingested first and triaged out; `newer` is not.
    // A re-queue that re-ingested rather than re-admitted would put `oldest`
    // last, and `ORDER BY e.ingested_at` is what this asserts against.
    const oldest = await seedEpisode({ sourceId: "oldest", ingestedAt: "2026-08-01T00:00:00Z" });
    const newer = await seedEpisode({ sourceId: "newer", ingestedAt: "2026-08-05T00:00:00Z" });
    await mark(oldest, "pure_reaction");

    expect(await drainedIds()).toEqual([newer]);

    await requeueTriagedEpisodes(reader, WORKSPACE, "pure_reaction");

    expect(await drainedIds()).toEqual([oldest, newer]);
  });

  it("narrows to one rule and leaves the others held", async () => {
    const ack = await seedEpisode({ sourceId: "ack", ingestedAt: "2026-08-01T00:00:00Z" });
    const emoji = await seedEpisode({ sourceId: "emoji", ingestedAt: "2026-08-02T00:00:00Z" });
    await mark(ack, "known_ack");
    await mark(emoji, "pure_reaction");

    const { requeued } = await requeueTriagedEpisodes(reader, WORKSPACE, "known_ack");
    expect(requeued).toBe(1);

    expect(await loadTriageBacklog(reader, WORKSPACE)).toEqual({
      total: 1,
      byRule: [{ rule: "pure_reaction", episodes: 1, known: true }],
      degraded: false,
    });
    expect(await drainedIds()).toEqual([ack]);
  });

  it("clears BOTH triage columns, which 0210's CHECK admits", async () => {
    // Question 4. `num_nonnulls(triaged_out_at, triage_reason) <> 1` is
    // satisfied by both-NULL and both-set. Clearing one column alone would
    // raise here rather than in prod, mid-act.
    const id = await seedEpisode({ sourceId: "one", ingestedAt: "2026-08-01T00:00:00Z" });
    await mark(id, "known_ack");
    await requeueTriagedEpisodes(reader, WORKSPACE, null);

    const { rows } = await pool.query<{ triaged_out_at: Date | null; triage_reason: string | null; extracted_at: Date | null }>(
      "SELECT triaged_out_at, triage_reason, extracted_at FROM brain_episodes WHERE id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ triaged_out_at: null, triage_reason: null, extracted_at: null });
  });

  it("a rule id no deploy still evaluates is counted, and cleared by the all-rules arm", async () => {
    // The retired-rule case the wire's `known: false` exists for. It is
    // reachable ONLY through the all-rules arm — a per-rule request cannot name
    // a rule the deploy does not know — so if this ever stopped working the
    // backlog would be unclearable rather than merely unnamed.
    const id = await seedEpisode({ sourceId: "retired", ingestedAt: "2026-08-01T00:00:00Z" });
    await mark(id, "channel_join_notice");

    expect(await loadTriageBacklog(reader, WORKSPACE)).toEqual({
      total: 1,
      byRule: [{ rule: "channel_join_notice", episodes: 1, known: false }],
      degraded: false,
    });

    expect((await requeueTriagedEpisodes(reader, WORKSPACE, null)).requeued).toBe(1);
    expect(await drainedIds()).toEqual([id]);
  });

  it("never reaches another workspace's marks", async () => {
    // `workspace_id = $1` on both statements, against a real second tenant
    // rather than a comment saying so.
    const mine = await seedEpisode({ sourceId: "mine", ingestedAt: "2026-08-01T00:00:00Z" });
    const theirs = await seedEpisode({
      workspaceId: OTHER_WORKSPACE,
      sourceId: "theirs",
      ingestedAt: "2026-08-01T00:00:00Z",
    });
    await mark(mine, "known_ack");
    await mark(theirs, "known_ack", OTHER_WORKSPACE);

    expect((await requeueTriagedEpisodes(reader, WORKSPACE, null)).requeued).toBe(1);
    expect(await loadTriageBacklog(reader, OTHER_WORKSPACE)).toEqual({
      total: 1,
      byRule: [{ rule: "known_ack", episodes: 1, known: true }],
      degraded: false,
    });
  });

  it("orders the backlog by size, largest bucket first", async () => {
    for (const [i, rule] of ["known_ack", "known_ack", "known_ack", "pure_reaction"].entries()) {
      const id = await seedEpisode({
        sourceId: `bulk-${i}`,
        ingestedAt: `2026-08-0${i + 1}T00:00:00Z`,
      });
      await mark(id, rule);
    }
    const backlog = await loadTriageBacklog(reader, WORKSPACE);
    expect(backlog.byRule.map((b) => b.rule)).toEqual(["known_ack", "pure_reaction"]);
    expect(backlog.total).toBe(4);
  });

  it("can use 0210's partial index rather than scanning the episode table", async () => {
    // The index exists FOR this grouping; a planner that cannot reach it means
    // the statement's predicate has drifted from the index's, which is
    // invisible at any fixture size and expensive at a real one.
    const id = await seedEpisode({ sourceId: "idx", ingestedAt: "2026-08-01T00:00:00Z" });
    await mark(id, "known_ack");

    // ⚠️ ONE CLIENT, held for all three statements. `pool.query` may hand out a
    // different connection per call, so `SET enable_seqscan = off` issued that
    // way could land on a connection the EXPLAIN never uses — the setting would
    // silently not apply and the assertion would be measuring the default
    // planner. (`SET LOCAL` is worse here: outside an explicit transaction it
    // warns and does nothing at all.)
    //
    // Forcing the choice is the point: at one row a seq scan is genuinely
    // cheaper, so an unforced plan says nothing about whether the index is
    // USABLE — which is the only thing a fixture-sized table can answer.
    const client = await pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN ${TRIAGE_BACKLOG_SQL}`,
        [WORKSPACE],
      );
      const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toContain("idx_brain_episodes_triaged_out");
    } finally {
      // RESET on the same client before it returns to the pool — a leaked
      // `enable_seqscan = off` would follow that connection into whichever
      // sibling test picks it up next.
      await client.query("RESET enable_seqscan");
      client.release();
    }
  });
});
