/**
 * Real-Postgres coverage for the gate-decision export (#5335).
 *
 * `gate-export.test.ts` pins the projection's SHAPE against a literal handle.
 * Four questions need a real database and none of them can be answered there:
 *
 *   1. **Are the three classes actually reachable?** `positive`, `rejected` and
 *      `negative` are claims about two columns and a NOT EXISTS. Only a real
 *      insert proves the retract verb's `invalidated_at` row is storable with
 *      `status` left alone, which is the whole reason the classes do not read
 *      off `status`.
 *   2. **Does a purged workspace really export zero rows?** Acceptance
 *      criterion 5. The exporter must not be able to resurrect deleted content,
 *      and the honest test deletes the rows the purge deletes and then runs the
 *      real query.
 *   3. **Are warehouse observations really excluded?** ADR-0042's exclusion is
 *      composed from `observation.ts`'s predicates; only a seeded warehouse
 *      episode proves the composition works rather than merely parses.
 *   4. **Does one episode with two decisions produce two rows?** The triple
 *      grain is per-decision, not per-episode, and a join that collapsed them
 *      would silently halve a measurement.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { PURGE_TABLE_DECISIONS } from "@atlas/api/lib/db/purge-scope";
import { WAREHOUSE_SOURCE } from "@atlas/api/lib/brain/sources";
import {
  buildGateExportBundle,
  loadGateDecisions,
  type GateExportReader,
} from "@atlas/api/lib/brain/gate-export";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

describeIfPg("brain gate-decision export (real Postgres)", () => {
  let pool: Pool;
  let reader: GateExportReader;
  const schemaName = `brain_gate_export_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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

  async function seedEpisode(
    workspaceId: string,
    sourceId: string,
    opts: {
      readonly source?: string;
      readonly extracted?: boolean;
      readonly visibleTo?: readonly string[];
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to, extracted_at)
       VALUES ($1, $2, $3, 'evidence', $4::text[], $5)
       RETURNING id`,
      [
        workspaceId,
        opts.source ?? "slack",
        sourceId,
        [...(opts.visibleTo ?? ["org"])],
        opts.extracted === false ? null : new Date(),
      ],
    );
    return rows[0]!.id;
  }

  async function seedFact(
    workspaceId: string,
    episodeId: string,
    opts: {
      readonly predicate?: string;
      readonly status?: string;
      readonly invalidated?: boolean;
      readonly source?: string;
      readonly visibleTo?: readonly string[];
    } = {},
  ): Promise<string> {
    const predicate = opts.predicate ?? "leads";
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts (
         workspace_id, subject, predicate, object,
         subject_key, predicate_key, object_key,
         source_episode_id, provenance, status, visible_to, extracted_at, invalidated_at
       ) VALUES (
         $1, 'Ana', $2, 'Platform',
         'ana', $3, 'platform',
         $4::uuid, $5::jsonb, $6, $7::text[], now(), $8
       ) RETURNING id`,
      [
        workspaceId,
        predicate,
        predicate,
        episodeId,
        JSON.stringify({
          actor: "slack:U1",
          sourceId: "C1:1",
          source: opts.source ?? "slack",
          // A stand-in for the PINNED SQL a warehouse-derived fact carries. It
          // must never reach a bundle — pinned below.
          pinnedSql: "SELECT secret_column FROM payroll",
        }),
        opts.status ?? "published",
        [...(opts.visibleTo ?? ["org"])],
        opts.invalidated === true ? new Date() : null,
      ],
    );
    return rows[0]!.id;
  }

  it("reads ONLY tables the purge deletes — the structural half of AC5", () => {
    // `purge-scope.test.ts` already pins that every `purged` entry has a real
    // DELETE in `hardDeleteWorkspace`. Composed with this, "the exporter cannot
    // resurrect deleted content" holds for reasons a future edit cannot quietly
    // break: joining a `retained` table into the export fails HERE.
    for (const table of ["brain_facts", "brain_episodes"] as const) {
      expect(PURGE_TABLE_DECISIONS[table].decision).toBe("purged");
    }
  });

  it("distinguishes positive, rejected and negative", async () => {
    const ws = "ws-classes";
    const approved = await seedEpisode(ws, "c:1");
    await seedFact(ws, approved, { predicate: "leads", status: "published" });

    const retracted = await seedEpisode(ws, "c:2");
    // The retract verb stamps `invalidated_at` and leaves `status` alone —
    // ADR-0036 makes withdrawal a tombstone, not a demotion. A `draft` row with
    // an `invalidated_at` is the shape a rejection actually has.
    await seedFact(ws, retracted, {
      predicate: "owns",
      status: "draft",
      invalidated: true,
    });

    // Extracted, and the extractor proposed nothing.
    await seedEpisode(ws, "c:3");

    // Ingested but NOT yet extracted — no decision has been made, so this is
    // not a negative and must not appear at all.
    await seedEpisode(ws, "c:4", { extracted: false });

    const result = await loadGateDecisions(reader, ws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byClass = result.decisions.reduce<Record<string, number>>((acc, row) => {
      acc[row.decision] = (acc[row.decision] ?? 0) + 1;
      return acc;
    }, {});
    expect(byClass).toEqual({ positive: 1, rejected: 1, negative: 1 });

    // `fact` is null on exactly the negative arm.
    for (const row of result.decisions) {
      if (row.decision === "negative") expect(row.fact).toBeNull();
      else expect(row.fact).not.toBeNull();
    }
  });

  it("emits one row per DECISION, not per episode", async () => {
    const ws = "ws-two-decisions";
    const episode = await seedEpisode(ws, "d:1");
    await seedFact(ws, episode, { predicate: "leads", status: "published" });
    await seedFact(ws, episode, { predicate: "owns", status: "draft", invalidated: true });

    const result = await loadGateDecisions(reader, ws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A reviewer who published one claim and retracted another from the same
    // message produced two decisions, and both are signal.
    expect(result.decisions).toHaveLength(2);
    expect(new Set(result.decisions.map((d) => d.decision))).toEqual(
      new Set(["positive", "rejected"]),
    );
    // ...and the episode is NOT additionally counted as a negative: it proposed
    // something, so claiming the extractor stayed silent would be false.
    expect(result.decisions.some((d) => d.decision === "negative")).toBe(false);
  });

  it("carries the grant and only the narrow provenance fields", async () => {
    const ws = "ws-projection";
    const episode = await seedEpisode(ws, "p:1", { visibleTo: ["org", "role:admin"] });
    await seedFact(ws, episode, { visibleTo: ["role:admin"] });

    const result = await loadGateDecisions(reader, ws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.decisions[0]!;

    // Grants travel with the rows — an episode's `visible_to` is not decoration
    // in an exported bundle.
    expect(row.episode.visibleTo).toEqual(["org", "role:admin"]);
    expect(row.fact?.visibleTo).toEqual(["role:admin"]);

    // The narrow provenance projection is the secret-exclusion arm.
    expect(row.fact?.actor).toBe("slack:U1");
    expect(row.fact?.provenanceSourceId).toBe("C1:1");
    // The pinned SQL is not reachable anywhere in the serialized row.
    expect(JSON.stringify(row)).not.toContain("payroll");
    expect(JSON.stringify(row)).not.toContain("pinnedSql");
  });

  it("excludes warehouse observations on both grains", async () => {
    const ws = "ws-observations";
    // A warehouse EPISODE, and a fact derived from it. No human ever ruled on
    // either — publish refuses warehouse-derived promotions (ADR-0042, #5342).
    const warehouseEpisode = await seedEpisode(ws, "w:1", { source: WAREHOUSE_SOURCE });
    await seedFact(ws, warehouseEpisode, { status: "published", source: WAREHOUSE_SOURCE });

    const result = await loadGateDecisions(reader, ws);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Neither the fact (as a positive) nor the episode (as a negative).
    expect(result.decisions).toHaveLength(0);
  });

  it("exports zero rows for a purged workspace — AC5", async () => {
    const ws = "ws-purged";
    const episode = await seedEpisode(ws, "x:1");
    await seedFact(ws, episode, { status: "published" });
    await seedEpisode(ws, "x:2");

    const before = await loadGateDecisions(reader, ws);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    // The fixture is real: without this the assertion below would pass on an
    // empty workspace and prove nothing.
    expect(before.decisions.length).toBeGreaterThan(0);

    // The purge's own statements, in the order `hardDeleteWorkspace` uses:
    // facts before episodes, because the composite FK is RESTRICT.
    await pool.query(`DELETE FROM brain_facts WHERE workspace_id = $1`, [ws]);
    await pool.query(`DELETE FROM brain_episodes WHERE workspace_id = $1`, [ws]);

    const after = await loadGateDecisions(reader, ws);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.decisions).toHaveLength(0);
  });

  it("refuses a workspace carrying a grant it cannot represent", async () => {
    const ws = "ws-bad-grant";
    // `everyone` passes migration 0180's CHECK (cardinality > 0) but is outside
    // the grant grammar — so it is genuinely storable and genuinely
    // unrepresentable, which is what makes the refusal a real rule.
    const episode = await seedEpisode(ws, "g:1", { visibleTo: ["everyone"] });
    await seedFact(ws, episode, { status: "published" });

    const result = await loadGateDecisions(reader, ws);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.refusal).toBe("unrepresentable-grant");
  });

  it("builds a bundle with analytics derived from the same rows", async () => {
    const ws = "ws-bundle";
    const a = await seedEpisode(ws, "b:1");
    await seedFact(ws, a, { predicate: "leads", status: "published" });
    const b = await seedEpisode(ws, "b:2");
    await seedFact(ws, b, { predicate: "owns", status: "draft", invalidated: true });

    const built = await buildGateExportBundle(reader, {
      workspaceId: ws,
      apiRegion: "us",
      workspaceRegion: "us",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.analytics.positives).toBe(1);
    expect(built.bundle.analytics.rejected).toBe(1);
    expect(built.bundle.analytics.approvalRate).toBe(0.5);
    expect(built.bundle.analytics.topRejectedPredicates).toEqual([
      { predicate: "owns", rejections: 1 },
    ]);
    expect(built.bundle.notice).toContain("EVALUATION ONLY");
  });
});
