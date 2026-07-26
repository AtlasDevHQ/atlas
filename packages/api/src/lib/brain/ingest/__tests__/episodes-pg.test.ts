/**
 * Real-Postgres coverage for the brain ingest core (#4770, ADR-0036
 * §Ingestion & connectors).
 *
 * The whole slice rests on claims only a live schema can settle, and every one
 * of them would pass vacuously against a mock:
 *
 *   1. **Is re-ingest genuinely a no-op?** The acceptance criterion is "a
 *      re-poll of the same window writes zero new rows". That is a property of
 *      `uq_brain_episodes_source_id` + `ON CONFLICT DO NOTHING`, not of the
 *      TypeScript around it — a mock would report whatever it was told.
 *   2. **Is re-ingest a no-op rather than an UPSERT?** Different claim, and
 *      the one that matters for evidence: a second write with the same
 *      source-id and DIFFERENT body must leave the first body untouched.
 *   3. **Do the screens match the CHECKs they stand in for?** Blank body and
 *      unusable grant are dropped BEFORE the INSERT so one bad record can't
 *      abort a batch; the test also asserts the CHECK would in fact have
 *      rejected them, so the screen can never quietly diverge from it.
 *   4. **Does `extracted_at` stay NULL?** It is #4771's work-queue marker and
 *      the partial index is what makes the backlog visible; an ingest that
 *      stamped it would silently drop every episode off the queue.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4770_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { ingestEpisodes } from "@atlas/api/lib/brain/ingest/episodes";
import type { BrainEpisodeRecord } from "@atlas/api/lib/brain/ingest/types";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-ingest";
const SOURCE = "slack";

function record(overrides: Partial<BrainEpisodeRecord> = {}): BrainEpisodeRecord {
  return {
    sourceId: "C01ABCDEF:1719000000.000100",
    sourceActor: "U123",
    body: "the deploy window is Thursdays",
    occurredAt: new Date("2026-06-21T00:00:00.000Z"),
    visibleTo: ["org"],
    ...overrides,
  };
}

describeIfPg("brain episode ingest core (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `brain_ingest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `search_path` baked into the connection string, not SET from an unawaited
    // `pool.on("connect")` handler — the pattern `promotion-pg.test.ts` and
    // `acl-visibility-pg.test.ts` established.
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
    // `ingestEpisodes` writes through `internalQuery`, so the module-level pool
    // has to BE this schema-scoped one for the test to exercise the real SQL.
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await pool.query(`DELETE FROM brain_episodes WHERE workspace_id = $1`, [WORKSPACE]);
  });

  async function countEpisodes(): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_episodes WHERE workspace_id = $1`,
      [WORKSPACE],
    );
    return Number(rows[0]!.n);
  }

  // ══════════════════════════════════════════════════════════════════
  // 1 + 2. Re-ingest is a NO-OP, not an upsert — the acceptance criterion
  // ══════════════════════════════════════════════════════════════════

  it("a re-poll of the same window inserts zero new rows", async () => {
    const window = [
      record({ sourceId: "C1:1.000001" }),
      record({ sourceId: "C1:1.000002" }),
      record({ sourceId: "C1:1.000003" }),
    ];

    const first = await ingestEpisodes({ workspaceId: WORKSPACE, source: SOURCE, episodes: window });
    expect(first.inserted).toBe(3);
    expect(first.duplicate).toBe(0);

    const second = await ingestEpisodes({ workspaceId: WORKSPACE, source: SOURCE, episodes: window });
    expect(second.inserted).toBe(0);
    expect(second.duplicate).toBe(3);
    expect(await countEpisodes()).toBe(3);
  });

  it("re-ingest with a CHANGED body leaves the stored evidence untouched", async () => {
    // The difference between DO NOTHING and DO UPDATE, and the reason 0180 has
    // no `updated_at`: an upstream edit is a new episode's business, never a
    // rewrite of evidence already cited.
    await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [record({ sourceId: "C1:9.000001", body: "original" })],
    });
    const again = await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [record({ sourceId: "C1:9.000001", body: "edited upstream" })],
    });

    expect(again.inserted).toBe(0);
    const { rows } = await pool.query<{ body: string }>(
      `SELECT body FROM brain_episodes WHERE workspace_id = $1 AND source_id = $2`,
      [WORKSPACE, "C1:9.000001"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("original");
  });

  it("dedupes per (workspace, source, source_id) — not across sources or tenants", async () => {
    const shared = record({ sourceId: "SAME:1.000001" });
    await ingestEpisodes({ workspaceId: WORKSPACE, source: SOURCE, episodes: [shared] });
    const otherSource = await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: "teams",
      episodes: [shared],
    });
    const otherWorkspace = await ingestEpisodes({
      workspaceId: "ws-other",
      source: SOURCE,
      episodes: [shared],
    });

    expect(otherSource.inserted).toBe(1);
    expect(otherWorkspace.inserted).toBe(1);
    await pool.query(`DELETE FROM brain_episodes WHERE workspace_id = 'ws-other'`);
  });

  it("collapses a source that emitted the same record twice in one batch", async () => {
    const report = await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [record({ sourceId: "C1:2.000001" }), record({ sourceId: "C1:2.000001" })],
    });
    // Reported as a BATCH duplicate, not a storage duplicate: "the source
    // repeated itself" and "we already had it" are different facts about the
    // world and point at different bugs.
    expect(report.inserted).toBe(1);
    expect(report.batchDuplicate).toBe(1);
    expect(report.duplicate).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════
  // 3. The screens stand in for CHECKs that WOULD have fired
  // ══════════════════════════════════════════════════════════════════

  it("drops a blank body before the INSERT — and the CHECK would have refused it", async () => {
    const report = await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [record({ sourceId: "C1:3.000001", body: "   " }), record({ sourceId: "C1:3.000002" })],
    });
    // One bad record must not abort the batch — the good one still lands.
    expect(report.refused.blank_body).toBe(1);
    expect(report.inserted).toBe(1);

    await expect(
      pool.query(
        `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to)
         VALUES ($1, $2, 'direct-blank', '', ARRAY['org'])`,
        [WORKSPACE, SOURCE],
      ),
    ).rejects.toThrow(/chk_brain_episodes_body_xor_locator/);
  });

  it("drops an unusable grant that the CHECK would have ADMITTED", async () => {
    // The asymmetry this whole module exists for: `['everyone']` is legal at
    // rest and grants nobody anything. The screen is stricter than the CHECK on
    // the WRITE side, which `grant.ts` explains is legitimate precisely because
    // it is not a rejection at rest or at import.
    const report = await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [record({ sourceId: "C1:4.000001", visibleTo: ["everyone"] })],
    });
    expect(report.refused.unusable_grant).toBe(1);
    expect(report.inserted).toBe(0);

    const direct = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to)
       VALUES ($1, $2, 'direct-everyone', 'x', ARRAY['everyone']) RETURNING id`,
      [WORKSPACE, SOURCE],
    );
    expect(direct.rows).toHaveLength(1);
  });

  it("drops an Invalid Date rather than letting it abort the whole batch", async () => {
    // `new Date(NaN).toISOString()` throws RangeError synchronously, so without
    // a screen one poison record kills the batch — and because the engine
    // leaves the mark unmoved on an error, the same record would be re-fetched
    // and re-thrown every cycle forever.
    const report = await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [
        record({ sourceId: "C1:bad.000001", occurredAt: new Date("nonsense") }),
        record({ sourceId: "C1:good.000001" }),
      ],
    });
    expect(report.refused.invalid_occurred_at).toBe(1);
    expect(report.inserted).toBe(1);
  });

  it("drops a blank source id — a blank dedupe key would collapse the source", async () => {
    const report = await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [record({ sourceId: "  " })],
    });
    expect(report.refused.blank_source_id).toBe(1);
    expect(await countEpisodes()).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════
  // 4. The stored row's shape
  // ══════════════════════════════════════════════════════════════════

  it("stores by value, leaves locator NULL, and leaves extracted_at on the queue", async () => {
    await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [record({ sourceId: "C1:5.000001" })],
    });
    const { rows } = await pool.query<{
      body: string;
      locator: string | null;
      extracted_at: Date | null;
      source_actor: string | null;
      occurred_at: Date | null;
      visible_to: string[];
    }>(
      `SELECT body, locator, extracted_at, source_actor, occurred_at, visible_to
         FROM brain_episodes WHERE workspace_id = $1 AND source_id = $2`,
      [WORKSPACE, "C1:5.000001"],
    );
    const row = rows[0]!;
    expect(row.body).toBe("the deploy window is Thursdays");
    expect(row.locator).toBeNull();
    // NULL forever is a VISIBLE BACKLOG. A stamped value here is a silent drop.
    expect(row.extracted_at).toBeNull();
    expect(row.source_actor).toBe("U123");
    expect(row.occurred_at?.toISOString()).toBe("2026-06-21T00:00:00.000Z");
    expect(row.visible_to).toEqual(["org"]);
  });

  it("keeps the episode on #4771's extraction-queue index", async () => {
    await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [record({ sourceId: "C1:6.000001" })],
    });
    // The exact predicate the extraction fiber drains
    // (`idx_brain_episodes_extraction_queue`).
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_episodes
        WHERE workspace_id = $1 AND extracted_at IS NULL`,
      [WORKSPACE],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("stores a null actor and a null event time without coercing them", async () => {
    await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [record({ sourceId: "C1:7.000001", sourceActor: null, occurredAt: null })],
    });
    const { rows } = await pool.query<{ source_actor: string | null; occurred_at: Date | null }>(
      `SELECT source_actor, occurred_at FROM brain_episodes
        WHERE workspace_id = $1 AND source_id = $2`,
      [WORKSPACE, "C1:7.000001"],
    );
    expect(rows[0]!.source_actor).toBeNull();
    expect(rows[0]!.occurred_at).toBeNull();
  });

  it("stores a multi-principal grant without flattening it", async () => {
    await ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SOURCE,
      episodes: [
        record({ sourceId: "C1:8.000001", visibleTo: ["audience:chat-channel:slack:C1"] }),
        record({ sourceId: "C1:8.000002", visibleTo: ["role:admin", "user:u-9"] }),
      ],
    });
    const { rows } = await pool.query<{ source_id: string; visible_to: string[] }>(
      `SELECT source_id, visible_to FROM brain_episodes
        WHERE workspace_id = $1 AND source_id LIKE 'C1:8.%' ORDER BY source_id`,
      [WORKSPACE],
    );
    // Mixed grant arities in ONE batch — the case a parallel-`unnest` binding
    // could not express at all (Postgres requires `text[][]` to be rectangular).
    expect(rows[0]!.visible_to).toEqual(["audience:chat-channel:slack:C1"]);
    expect(rows[1]!.visible_to).toEqual(["role:admin", "user:u-9"]);
  });

  it("is a no-op on an empty batch and never touches the database", async () => {
    const report = await ingestEpisodes({ workspaceId: WORKSPACE, source: SOURCE, episodes: [] });
    expect(report).toEqual({
      inserted: 0,
      duplicate: 0,
      refused: {
        blank_source_id: 0,
        blank_body: 0,
        unusable_grant: 0,
        invalid_occurred_at: 0,
      },
      batchDuplicate: 0,
    });
  });
});
