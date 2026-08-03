/**
 * Real-Postgres coverage for claim identity's day-one substrate (#5019,
 * ADR-0037): migration 0187's key columns, its backfill, and the repointed slot
 * index.
 *
 * ## Why this file has to exist, stated plainly
 *
 * The slice it covers is expected to change no observable behaviour at all —
 * with an empty vocabulary `alias` is the identity function, so every key is
 * exactly `lexicalNorm(surface)` and nothing reads the columns yet. A green
 * unit suite therefore proves almost nothing here, and `identity.test.ts`'s
 * assertions about `lexicalNorm` prove nothing about the migration, which is a
 * SECOND implementation of the same function written in SQL. Two
 * implementations that were never run against each other are two functions.
 *
 * So every claim below needs a live database:
 *
 *   1. **Do the SQL and the TypeScript agree?** Over a corpus chosen to break
 *      them, not to confirm them — including the two characters where
 *      `lower()` and `String#toLowerCase()` are known to disagree.
 *   2. **Does the backfill reach TOMBSTONED and SUPERSEDED rows?** The load-
 *      bearing half. Re-deriving a key from the retained surface form is the
 *      only way back from an alias removal, and a corpus whose history is
 *      unkeyed has that undo working for live rows and silently broken for
 *      everything else. A test over live rows only passes vacuously.
 *   3. **Is the backfill status-blind?** A draft and a published fact have
 *      identical identity, and a status-aware backfill would need an allowlist
 *      entry in `check-brain-fact-promotion.sh` that it has no reason to want.
 *   4. **Is `updated_at` left alone?** It sorts the publish preview. Every
 *      other write in the brain-facts module stamps it, so declining is a
 *      special case with no mechanical guard — this is the guard.
 *   5. **Is the FTS vector still built from the SURFACE?** Retrieval wants what
 *      people said, identity wants what they meant. Asserted against the
 *      generation expression Postgres actually stored, not against the
 *      migration text.
 *   6. **Was the slot index REPOINTED rather than added?** Zero net new
 *      indexes is a result, and a result nobody checks is a wish.
 *   7. **Are the columns still NULLABLE?** #5020 owns `SET NOT NULL`, because
 *      landing it before its writer would refuse every brain-fact write.
 *
 * The migration is executed by READING THE FILE and running it, so there is no
 * copy of its SQL here to drift from it. `WHERE … IS NULL` is what makes that
 * re-run meaningful: null the keys, run the real file, compare.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { lexicalNorm } from "@atlas/api/lib/brain/identity";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-identity-pg";

const MIGRATION = join(
  import.meta.dir,
  "..",
  "..",
  "db",
  "migrations",
  "0187_brain_fact_identity_keys.sql",
);

/**
 * Surfaces chosen to FALSIFY the pairing, not to confirm it.
 *
 * The last two are the whole reason the fold is ASCII-only: `İstanbul` (U+0130)
 * lowers to `istanbul` under Postgres's `lower()` and to `i` + U+0307 under
 * JavaScript's Unicode special-casing, and `ΣΊΣΥΦΟΣ` lowers with a context-
 * sensitive word-final `ς` in JavaScript and a plain `σ` in Postgres. Restoring
 * `lower()` on EITHER side fails this file rather than shipping keys that two
 * regions compute differently. They stay in the corpus for that reason and no
 * other.
 */
const SURFACES = [
  "is owned by",
  "owned_by",
  "OWNED-BY",
  "  Reports   To  ",
  // Both live in the corpus and are INVERSE relations. They must NOT collapse.
  "led_by",
  "leads",
  "escalates_to",
  "is priced at",
  "priced at",
  "Acme Corp",
  "ACME\tCORP",
  "line\nbreak",
  "vertical\vtab",
  "form\ffeed",
  "carriage\rreturn",
  "Business tier",
  "business  tier",
  "$499",
  "499 USD",
  "naïve-Test_Case",
  "Café",
  "CAFÉ",
  "İstanbul",
  "ΣΊΣΥΦΟΣ",
] as const;

interface FactRow {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly subject_key: string | null;
  readonly predicate_key: string | null;
  readonly object_key: string | null;
  readonly status: string;
  readonly invalidated_at: Date | null;
  readonly valid_to: Date | null;
  readonly updated_at: Date;
}

describeIfPg("claim identity against the live schema (#5019)", () => {
  let pool: Pool;
  const schemaName = `brain_identity_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const migrationSql = readFileSync(MIGRATION, "utf8");

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

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', 'identity-1', 'U1', 'evidence', now(), ARRAY['org'])
       RETURNING id`,
      [WS],
    );
    const episodeId = rows[0]!.id;

    // Four lifecycle states across the corpus, cycled so each state carries a
    // spread of surfaces rather than one shape. `tombstoned` and `superseded`
    // are the states the backfill is most likely to be quietly scoped away
    // from; `draft` and `published` are what a status-aware backfill would
    // split.
    const states = ["draft", "published", "tombstoned", "superseded"] as const;
    for (const [i, surface] of SURFACES.entries()) {
      const state = states[i % states.length]!;
      await pool.query(
        `INSERT INTO brain_facts
           (workspace_id, subject, predicate, object, source_episode_id, provenance,
            status, visible_to, invalidated_at, valid_to)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, ARRAY['org'], $8, $9)`,
        [
          WS,
          surface,
          // Rotated so a single position cannot carry every interesting case —
          // the three columns are three separate expressions in the migration.
          SURFACES[(i + 1) % SURFACES.length]!,
          SURFACES[(i + 2) % SURFACES.length]!,
          episodeId,
          JSON.stringify({ source: "slack", actor: "U1" }),
          state === "tombstoned" ? "draft" : state === "superseded" ? "published" : state,
          state === "tombstoned" ? new Date() : null,
          state === "superseded" ? new Date() : null,
        ],
      );
    }
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });

  /** Null the keys, then run the REAL migration file over the seeded corpus. */
  async function rerunBackfill(): Promise<void> {
    await pool.query(
      `UPDATE brain_facts SET subject_key = NULL, predicate_key = NULL, object_key = NULL`,
    );
    await pool.query(migrationSql);
  }

  async function allFacts(): Promise<FactRow[]> {
    const { rows } = await pool.query<FactRow>(
      `SELECT id::text AS id, subject, predicate, object,
              subject_key, predicate_key, object_key,
              status, invalidated_at, valid_to, updated_at
         FROM brain_facts WHERE workspace_id = $1 ORDER BY subject, predicate`,
      [WS],
    );
    return rows;
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. The two implementations of lexicalNorm agree
  // ══════════════════════════════════════════════════════════════════

  it(
    "the migration's SQL and lib/brain/identity.ts produce the same key for every surface",
    async () => {
      await rerunBackfill();
      const rows = await allFacts();

      expect(
        rows.length,
        "the corpus is empty — every assertion in this file would pass vacuously",
      ).toBe(SURFACES.length);

      // Non-vacuity: at least some keys must DIFFER from their surface, or
      // "SQL agrees with TypeScript" is satisfied by both being the identity
      // function and the whole normalization could be deleted.
      const normalized = rows.filter((r) => r.subject_key !== r.subject);
      expect(
        normalized.length,
        "no seeded surface normalizes to anything other than itself — the corpus cannot falsify the normalization",
      ).toBeGreaterThan(0);

      for (const row of rows) {
        expect(row.subject_key, `subject_key for ${JSON.stringify(row.subject)}`).toBe(
          lexicalNorm(row.subject),
        );
        expect(row.predicate_key, `predicate_key for ${JSON.stringify(row.predicate)}`).toBe(
          lexicalNorm(row.predicate),
        );
        expect(row.object_key, `object_key for ${JSON.stringify(row.object)}`).toBe(
          lexicalNorm(row.object),
        );
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "keeps `led_by` and `leads` in DIFFERENT slots — the inverse-relation collapse",
    async () => {
      await rerunBackfill();
      const { rows } = await pool.query<{ subject: string; subject_key: string }>(
        `SELECT subject, subject_key FROM brain_facts
          WHERE workspace_id = $1 AND subject IN ('led_by', 'leads')`,
        [WS],
      );
      expect(rows.length, "the inverse-relation pair is missing from the corpus").toBe(2);
      const keys = new Set(rows.map((r) => r.subject_key));
      // Any stemmer collapses these into one slot, and over-matching a join arm
      // is what stamps `valid_to` on a belief nobody arbitrated. `led_by` norms
      // to `led by` (separator unification) and `leads` to itself.
      expect(
        keys.size,
        "`led_by` and `leads` normalized to the same key — a morphological rule crept into lexicalNorm, and these are INVERSE relations",
      ).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 2. Coverage: every row, every lifecycle state
  // ══════════════════════════════════════════════════════════════════

  it(
    "keys every row including tombstoned and superseded ones, unscoped by status",
    async () => {
      await rerunBackfill();
      const rows = await allFacts();

      // Prove the fixture actually contains each state before concluding the
      // backfill covered it. Without this the interesting halves could be
      // absent and the test would report success over live drafts alone.
      const tombstoned = rows.filter((r) => r.invalidated_at !== null);
      const superseded = rows.filter((r) => r.valid_to !== null);
      const drafts = rows.filter((r) => r.status === "draft");
      const published = rows.filter((r) => r.status === "published");
      expect(tombstoned.length, "no tombstoned row in the fixture").toBeGreaterThan(0);
      expect(superseded.length, "no superseded row in the fixture").toBeGreaterThan(0);
      expect(drafts.length, "no draft row in the fixture").toBeGreaterThan(0);
      expect(published.length, "no published row in the fixture").toBeGreaterThan(0);

      for (const row of rows) {
        expect(
          row.subject_key === null || row.predicate_key === null || row.object_key === null,
          `row ${row.id} (status=${row.status}, invalidated=${row.invalidated_at !== null}, superseded=${row.valid_to !== null}) has an unkeyed position — an unkeyed tombstone breaks the re-derive-from-surface undo after an alias removal`,
        ).toBe(false);
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "leaves the surface columns byte-identical",
    async () => {
      const before = await allFacts();
      await rerunBackfill();
      const after = await allFacts();

      expect(after.map((r) => [r.subject, r.predicate, r.object])).toEqual(
        before.map((r) => [r.subject, r.predicate, r.object]),
      );
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 3. `updated_at` is not stamped
  // ══════════════════════════════════════════════════════════════════

  it(
    "does not stamp `updated_at` — the publish preview's sort key stays put",
    async () => {
      // Spread the timestamps first, so "unchanged" is a real claim rather than
      // one satisfied by every row already sharing a value.
      await pool.query(
        `UPDATE brain_facts SET updated_at = now() - (random() * interval '30 days')
          WHERE workspace_id = $1`,
        [WS],
      );
      const before = await allFacts();
      const distinct = new Set(before.map((r) => r.updated_at.toISOString()));
      expect(
        distinct.size,
        "every row shares one `updated_at` — a reshuffle would be undetectable",
      ).toBeGreaterThan(1);

      await rerunBackfill();
      const after = await allFacts();

      const byId = new Map(before.map((r) => [r.id, r.updated_at.toISOString()]));
      for (const row of after) {
        const was = byId.get(row.id);
        // A row that exists after and not before would mean the migration
        // INSERTED something, which is a different bug wearing this one's
        // clothes — and `toBe(undefined)` would have quietly passed for it.
        expect(was, `row ${row.id} did not exist before the backfill`).toBeDefined();
        expect(
          row.updated_at.toISOString(),
          `row ${row.id}'s \`updated_at\` moved. A key recomputation moved neither the claim's content nor its review state, and \`brainFactPreviewSql\` sorts the reviewer's queue by this column — a workspace-wide stamp reshuffles it into backfill order`,
        ).toBe(was!);
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 4. Structure: the FTS vector, the index, the nullability
  // ══════════════════════════════════════════════════════════════════

  it(
    "leaves the FTS vector reading the SURFACE columns, never the keys",
    async () => {
      // Read the expression Postgres actually stored, not the migration text —
      // the claim is about what the database will do, and 0187 changing 0181's
      // column would be invisible to a source grep of 0181.
      const { rows } = await pool.query<{ expr: string }>(
        `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
           FROM pg_attrdef d
           JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = 'brain_facts'::regclass AND a.attname = 'fts'`,
      );
      expect(rows.length, "brain_facts.fts has no stored generation expression").toBe(1);
      const expr = rows[0]!.expr;

      for (const surface of ["subject", "predicate", "object"]) {
        expect(expr.includes(surface), `fts no longer reads \`${surface}\``).toBe(true);
      }
      for (const key of ["subject_key", "predicate_key", "object_key"]) {
        expect(
          expr.includes(key),
          `fts reads \`${key}\`. Retrieval wants what people said; identity wants what they meant. Coupling them lets a vocabulary edit silently re-rank searchBrain`,
        ).toBe(false);
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "REPOINTS the slot index onto the keys rather than adding a second one",
    async () => {
      const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = $1 AND tablename = 'brain_facts'`,
        [schemaName],
      );
      expect(rows.length, "no indexes found — wrong schema?").toBeGreaterThan(0);

      const slot = rows.find((r) => r.indexname === "idx_brain_facts_subject");
      expect(slot, "idx_brain_facts_subject is gone").toBeDefined();
      expect(slot!.indexdef).toContain("subject_key");
      expect(slot!.indexdef).toContain("predicate_key");
      expect(slot!.indexdef).toContain("invalidated_at IS NULL");
      expect(slot!.indexdef).toContain("valid_to IS NULL");

      // Zero net new indexes: exactly ONE index mentions the keys, and no index
      // still leads on the surface columns. A second key index would be the
      // easy, wrong way to keep the surface consumers fast through the cut.
      const keyed = rows.filter((r) => /\bsubject_key\b/.test(r.indexdef));
      expect(
        keyed.map((r) => r.indexname),
        "more than one index on the identity keys — the slot index was ADDED, not repointed",
      ).toEqual(["idx_brain_facts_subject"]);

      const surfaceIndexed = rows.filter((r) =>
        /\(\s*workspace_id\s*,\s*subject\s*[,)]/.test(r.indexdef),
      );
      expect(
        surfaceIndexed.map((r) => r.indexname),
        "an index still leads on the surface `subject` column — the old one survived the repoint",
      ).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "leaves the key columns NULLABLE — `SET NOT NULL` belongs to #5020",
    async () => {
      const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'brain_facts'
            AND column_name IN ('subject_key', 'predicate_key', 'object_key')
          ORDER BY column_name`,
        [schemaName],
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        "object_key",
        "predicate_key",
        "subject_key",
      ]);
      for (const row of rows) {
        expect(
          row.is_nullable,
          `${row.column_name} is NOT NULL. Neither INSERT site names these columns yet — \`INSERT_FACT_SQL\` (#5020) and the region import's 18-column INSERT (#5035) — so the constraint refuses every brain-fact write and every region import until its writer lands. Flip it in #5020, with the writer, not here`,
        ).toBe("YES");
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "admits an INSERT that names no key column — the constraint cannot have crept in",
    async () => {
      // The positive control for the nullability assertion above: a metadata
      // read passes if the column is absent from the result set for any reason,
      // and `INSERT_FACT_SQL`'s exact shape is the thing that must keep working.
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO brain_episodes
           (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
         VALUES ($1, 'slack', 'identity-unkeyed', 'U1', 'evidence', now(), ARRAY['org'])
         RETURNING id`,
        [WS],
      );
      await pool.query(
        `INSERT INTO brain_facts
           (workspace_id, subject, predicate, object, source_episode_id, provenance, visible_to)
         VALUES ($1, 'unkeyed subject', 'unkeyed predicate', 'unkeyed object', $2, $3::jsonb, ARRAY['org'])`,
        [WS, rows[0]!.id, JSON.stringify({ source: "slack", actor: "U1" })],
      );

      const { rows: check } = await pool.query<{ subject_key: string | null }>(
        `SELECT subject_key FROM brain_facts WHERE workspace_id = $1 AND subject = 'unkeyed subject'`,
        [WS],
      );
      expect(check.length).toBe(1);
      // No default, either — a `DEFAULT ''` would silently corrupt the corpus by
      // making every unkeyed row join every other unkeyed row.
      expect(
        check[0]!.subject_key,
        "an unkeyed INSERT produced a non-NULL key — a DEFAULT crept onto the column, and every unkeyed row now shares one slot",
      ).toBeNull();

      await pool.query(`DELETE FROM brain_facts WHERE workspace_id = $1 AND subject = 'unkeyed subject'`, [
        WS,
      ]);
      await pool.query(`DELETE FROM brain_episodes WHERE workspace_id = $1 AND source_id = 'identity-unkeyed'`, [
        WS,
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
