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
import { identityKey, lexicalNorm } from "@atlas/api/lib/brain/identity";
import type { BrainFactStatus } from "@atlas/api/lib/brain/types";

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
  // Degenerate: every one of these norms to the empty string, and a STORED `''`
  // would be the `DEFAULT ''` hazard the migration header rejects, reached from
  // the other side — every such row in one slot. They are here to pin that both
  // implementations answer NULL, and that they agree about which surfaces are
  // degenerate.
  "___",
  "-",
  "  ",
  " - _ ",
] as const;

interface FactRow {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly subject_key: string | null;
  readonly predicate_key: string | null;
  readonly object_key: string | null;
  readonly status: BrainFactStatus;
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

    // Cycled across the corpus so each state carries a spread of surfaces
    // rather than one shape. `tombstoned` and `superseded` are the states a
    // backfill is most likely to be quietly scoped away from.
    //
    // The 2×2-ish product of (review status × lifecycle nullability), spelled
    // out rather than derived by ternary from a stringly state name. `archived`
    // is 0180's third legal status and its ABSENCE was the gap: a backfill
    // scoped `WHERE status <> 'archived'` — the most natural scoping mistake,
    // "skip the dead ones" — passed every assertion in this file without it.
    const states = [
      { label: "draft", status: "draft", invalidatedAt: null, validTo: null },
      { label: "published", status: "published", invalidatedAt: null, validTo: null },
      { label: "archived", status: "archived", invalidatedAt: null, validTo: null },
      { label: "tombstoned", status: "draft", invalidatedAt: new Date(), validTo: null },
      { label: "superseded", status: "published", invalidatedAt: null, validTo: new Date() },
    ] as const satisfies readonly {
      label: string;
      status: BrainFactStatus;
      invalidatedAt: Date | null;
      validTo: Date | null;
    }[];
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
          state.status,
          state.invalidatedAt,
          state.validTo,
        ],
      );
    }
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      // `finally`, so a failed DROP cannot leak the pool — an open handle is
      // the shape behind a suite that hangs instead of failing.
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await pool.end();
      }
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

      // Non-vacuity, per POSITION: "SQL agrees with TypeScript" is satisfied by
      // both being the identity function, so each of the three expressions has
      // to be shown to actually change something. Checked separately because
      // they are three separate expressions in the migration and a corpus that
      // exercised only the subject would leave two of them unpinned.
      for (const [label, changed] of [
        ["subject", rows.filter((r) => r.subject_key !== r.subject)],
        ["predicate", rows.filter((r) => r.predicate_key !== r.predicate)],
        ["object", rows.filter((r) => r.object_key !== r.object)],
      ] as const) {
        expect(
          changed.length,
          `no seeded ${label} normalizes to anything other than itself — the corpus cannot falsify that expression`,
        ).toBeGreaterThan(0);
      }

      for (const row of rows) {
        expect(row.subject_key, `subject_key for ${JSON.stringify(row.subject)}`).toBe(
          identityKey(row.subject),
        );
        expect(row.predicate_key, `predicate_key for ${JSON.stringify(row.predicate)}`).toBe(
          identityKey(row.predicate),
        );
        expect(row.object_key, `object_key for ${JSON.stringify(row.object)}`).toBe(
          identityKey(row.object),
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
      expect(tombstoned.length, "no tombstoned row in the fixture").toBeGreaterThan(0);
      expect(superseded.length, "no superseded row in the fixture").toBeGreaterThan(0);
      // All THREE legal statuses (0180's CHECK), not just the two obvious ones.
      // Without `archived` here, `WHERE status <> 'archived'` — the natural
      // "skip the dead ones" scoping mistake — is unfalsifiable.
      for (const status of ["draft", "published", "archived"] as const) {
        expect(
          rows.filter((r) => r.status === status).length,
          `no ${status} row in the fixture — a backfill scoped away from ${status} would pass this file`,
        ).toBeGreaterThan(0);
      }

      for (const row of rows) {
        // "Covered" means "the backfill visited it", which for a surface that
        // norms away is NULL rather than a key — the `identityKey` contract.
        // Comparing against it (rather than asserting non-null) keeps this
        // assertion honest for the degenerate rows while still failing for a
        // row the backfill skipped, since those rows have non-degenerate
        // surfaces and would come back NULL against a non-null expectation.
        expect(
          [row.subject_key, row.predicate_key, row.object_key],
          `row ${row.id} (status=${row.status}, invalidated=${row.invalidated_at !== null}, superseded=${row.valid_to !== null}) was not keyed as the backfill defines it — an unkeyed tombstone breaks the re-derive-from-surface undo after an alias removal`,
        ).toEqual([
          identityKey(row.subject),
          identityKey(row.predicate),
          identityKey(row.object),
        ]);
      }

      // …and the skipped-row failure mode has to be REACHABLE, so at least one
      // row must have a key the assertion above would miss if it were absent.
      expect(
        rows.filter((r) => r.subject_key !== null).length,
        "every seeded surface is degenerate — the coverage assertion cannot detect a skipped row",
      ).toBeGreaterThan(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "changes NOTHING on any row except the three key columns",
    async () => {
      // Deliberately a whole-row compare rather than a list of columns worth
      // checking. An earlier cut asserted the surface triple and `updated_at`
      // and nothing else, which left these mutations of the `SET` list passing
      // the entire file:
      //
      //   SET …keys…, valid_to = now()          ← the IRREVERSIBLE column
      //   SET …keys…, visible_to = ARRAY['org'] ← the DISCLOSING one
      //   SET …keys…, invalidated_at = now()
      //
      // None can be caught by `check-brain-fact-promotion.sh` either: it is the
      // guard that would refuse them in TypeScript, and its `--include` cannot
      // scan a `.sql` file. So this is the only thing standing between a
      // migration and a silent corpus-wide write to the column whose damage
      // every as-of-now read hides.
      //
      // Spread `updated_at` first, so "unchanged" is a real claim rather than
      // one satisfied by every row already sharing a value. It sorts the publish
      // preview; a workspace-wide stamp reshuffles every reviewer's queue into
      // backfill order.
      await pool.query(
        `UPDATE brain_facts SET updated_at = now() - (random() * interval '30 days')
          WHERE workspace_id = $1`,
        [WS],
      );

      const KEYS = new Set(["subject_key", "predicate_key", "object_key"]);
      const snapshot = async (): Promise<Map<string, Record<string, unknown>>> => {
        const { rows } = await pool.query<Record<string, unknown>>(
          `SELECT * FROM brain_facts WHERE workspace_id = $1 ORDER BY id`,
          [WS],
        );
        return new Map(
          rows.map((r) => [
            String(r.id),
            Object.fromEntries(
              Object.entries(r)
                .filter(([col]) => !KEYS.has(col))
                .map(([col, v]) => [col, v instanceof Date ? v.toISOString() : v]),
            ),
          ]),
        );
      };

      const before = await snapshot();
      // Non-vacuity for the `updated_at` half specifically: with one shared
      // timestamp a reshuffle would be undetectable.
      const stamps = new Set([...before.values()].map((r) => r.updated_at));
      expect(
        stamps.size,
        "every row shares one `updated_at` — a workspace-wide stamp would be undetectable",
      ).toBeGreaterThan(1);
      // …and the compare has to actually cover `valid_to`, which is the column
      // this test exists for. A projection that silently stopped returning it
      // would make the assertion below vacuous on the one axis that matters.
      for (const column of ["valid_to", "visible_to", "status", "invalidated_at", "updated_at"]) {
        expect(
          [...before.values()][0],
          `the row snapshot does not carry \`${column}\` — this compare cannot see a write to it`,
        ).toHaveProperty(column);
      }

      await rerunBackfill();
      const after = await snapshot();

      expect(
        [...after.keys()].sort(),
        "the backfill inserted or deleted rows",
      ).toEqual([...before.keys()].sort());
      for (const [id, row] of after) {
        expect(
          row,
          `row ${id} changed a column outside the three keys. A key recomputation moved neither the claim's content nor its review state — and \`valid_to\` in particular is the stamp no autonomous writer may make`,
        ).toEqual(before.get(id)!);
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
      // The whole tuple, in order. `toContain("subject_key")` +
      // `toContain("predicate_key")` is satisfied by
      // `(subject_key, workspace_id, predicate_key)`, which is a different,
      // workspace-blind-leading access path.
      expect(slot!.indexdef).toContain("(workspace_id, subject_key, predicate_key)");
      expect(slot!.indexdef).toContain("invalidated_at IS NULL");
      expect(slot!.indexdef).toContain("valid_to IS NULL");
      // NOT unique. A `CREATE UNIQUE INDEX` satisfies every assertion above and
      // makes TENSION STRUCTURALLY IMPOSSIBLE — two live claims in one
      // subject+predicate slot IS a tension edge (ADR-0036), and a unique index
      // refuses the second at ingest. On a small corpus the CREATE succeeds and
      // the loss only shows up in production. ADR-0037 §1 defers the unique
      // constraint past #5035 deliberately.
      expect(
        slot!.indexdef,
        "the slot index is UNIQUE — that refuses the second live claim in a slot, which is exactly what a tension edge is",
      ).not.toContain("UNIQUE");

      // Zero net new indexes, measured as a TOTAL rather than inferred from the
      // keyed subset: an added `(workspace_id, object_key)` — the plausible
      // "keep the surface consumers fast through the cut" hedge this repoint
      // exists to avoid — matches neither filter below.
      expect(
        rows.map((r) => r.indexname).sort(),
        "the index set on brain_facts changed. 0187 repoints one index and adds none; if you meant to add one, ADR-0037 §1's zero-net-new-indexes result is what you are trading away",
      ).toEqual([
        "brain_facts_pkey",
        "idx_brain_facts_fts",
        "idx_brain_facts_source_episode",
        "idx_brain_facts_status",
        "idx_brain_facts_subject",
        "idx_brain_facts_valid_from",
        "idx_brain_facts_visible_to",
        "uq_brain_facts_workspace_id",
      ]);

      // No index anywhere still leads on the SURFACE subject — matched loosely
      // (any position, with or without workspace_id in front) so the old index
      // cannot survive under a different shape.
      const surfaceIndexed = rows.filter((r) =>
        /\(([^)]*,)?\s*subject\s*[,)]/.test(r.indexdef),
      );
      expect(
        surfaceIndexed.map((r) => r.indexname),
        "an index still keys on the surface `subject` column — the old one survived the repoint",
      ).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "leaves the key columns NULLABLE — `SET NOT NULL` belongs to #5020",
    async () => {
      const { rows } = await pool.query<{
        column_name: string;
        is_nullable: string;
        data_type: string;
        collation_name: string | null;
      }>(
        `SELECT column_name, is_nullable, data_type, collation_name
           FROM information_schema.columns
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
        // Plain `text`, database-default collation. The entire ASCII-fold
        // argument rests on `subject_key = $1` being a BYTE comparison: a
        // `citext` column, or an explicit non-deterministic collation, makes it
        // case-insensitive or locale-dependent and restores exactly the
        // region-to-region divergence `identity.ts` refuses `lower()` to avoid
        // — silently, and where no other test looks.
        expect(
          row.data_type,
          `${row.column_name} is not plain \`text\`. Identity comparison must be byte-exact; a citext or collated column reintroduces the locale dependence the ASCII fold exists to remove`,
        ).toBe("text");
        expect(
          row.collation_name,
          `${row.column_name} carries an explicit collation. Key equality has to be byte-exact and identical in every region`,
        ).toBeNull();
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
