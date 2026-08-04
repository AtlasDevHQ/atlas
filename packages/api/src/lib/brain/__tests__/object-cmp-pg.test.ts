/**
 * `object_cmp` against a real Postgres (#5030, ADR-0037 §2 / §7).
 *
 * Two things live here that no unit suite can see, and they are unrelated to
 * each other except in needing the real column.
 *
 * ## 1. The column is NEVER BACKFILLED
 *
 * An acceptance criterion, not a nice-to-have, and the one most likely to be
 * "finished" by a later reader who notices that migration 0187 backfilled its
 * keys and 0191 does not. Giving existing rows a comparable value retroactively
 * manufactures positive evidence of DIFFERENCE on pairs a reviewer already saw
 * as `unknown` — and unlike a cardinality flip there is no gate to hang a
 * preview on, so the next publish stamps `valid_to` across them unattended.
 *
 * The property has two halves and BOTH are asserted, because either alone is
 * satisfied by something broken:
 *
 *   - the migration runs no `UPDATE` — satisfied by a migration that does not
 *     exist at all, so it is paired with a LEXICAL control asserting the
 *     `ADD COLUMN` is still there (there is no `information_schema` probe here;
 *     the ⚠️ below says why the whole migration half is lexical);
 *   - a pre-store row still reads NULL after a producer pass — satisfied by a
 *     stage that writes no comparable value ANYWHERE, so it is paired with a
 *     positive control proving a fresh write does get one.
 *
 * ## 2. The SQL tag reader and the TypeScript one agree on BYTES
 *
 * `comparableDifferentSql` gates its inequality on `split_part(v, ':', 1)` and
 * `comparableTag` does the same job in TypeScript. They are two implementations
 * of one rule — the shape migration 0187's header records for `lexicalNorm` —
 * and the failure they would produce is silent in the worst direction: a
 * disagreement on `time:` or `money:` values (the two whose PAYLOADS contain
 * separators) makes the difference arm compare two values that share no type,
 * which is a `valid_to` stamp on a pair nothing proved apart.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 *
 * ## MUTATIONS THIS CATCHES
 *
 * MEASURED on the final tree, one at a time, against this file alone.
 *
 * | Mutation | Dies on |
 * |---|---|
 * | `INSERT_FACT_SQL` binds the object SURFACE into `object_cmp` | 1 — the fresh-write control, and only it: the pre-store test never inserts, and the two-tier join is 0 either way |
 * | `comparableDifferentSql` loses its `split_part` tag EQUALITY arm | 2 — `cross-type`, `date-vs-instant` |
 * | `comparableDifferentSql` loses its known-tag `IN` arm | 1 — the unknown-tag pair |
 * | `comparableDifferentSql` loses its `strpos(…) > 0` separator arms | 1 — the same test, via the BARE-TAG fixtures |
 * | `agree` loses its `tagA !== null` arm (the oracle's half of the same rule) | 1 — the same test |
 * | `objectSameSql` loses its difference VETO | 1 — `sign-flip` |
 * | 0191 grows an `UPDATE brain_facts SET object_cmp = object` backfill | 1 — the lexical check |
 *
 * ⚠️ **The migration backfill dies on the LEXICAL check and nothing else, and
 * that is a limit rather than a redundancy.** These suites run migrations into
 * an empty schema, so at 0191's `UPDATE` there are no rows for it to touch —
 * the behavioural half is structurally blind to it, and the lexical half is the
 * only guard the property has. That is exactly why the prohibition is paired
 * with an `adds object_cmp` control: without one, "runs no UPDATE" would also
 * be satisfied by a migration that does nothing at all.
 *
 * The pre-store prohibition covers the OTHER route to the same damage — a
 * producer pass repairing a legacy row — which a migration check cannot see.
 * Neither one subsumes the other.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import {
  supersedingDraftPredicate,
  supersessionCollisionPredicate,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { identityAlias, identityKey, slotKey } from "@atlas/api/lib/brain/identity";
import {
  comparableDifferentSql,
  comparableSameSql,
  comparableTag,
  comparableValue,
  objectSameSql,
} from "@atlas/api/lib/brain/object-cmp";
import { AGREEMENT_CORPUS, agree } from "./object-cmp-corpus";
import { reconcileFacts, type ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..", "..");
const MIGRATION = join(
  REPO,
  "packages/api/src/lib/db/migrations/0191_brain_fact_object_cmp.sql",
);

// ---------------------------------------------------------------------------
// The lexical half — outside the Postgres gate, so it runs on every local pass
// ---------------------------------------------------------------------------

describe("migration 0191 adds the column and backfills nothing (#5030)", () => {
  // Read once. A missing file throws at module scope, which is the correct
  // failure: silently reading `""` would make every assertion below vacuous.
  const sql = readFileSync(MIGRATION, "utf8");
  /** Statements, comments stripped — `--` prose in this file discusses UPDATEs at length. */
  const statements = sql
    .replace(/^\s*--[^\n]*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  it("adds `object_cmp`", () => {
    // The control. Without it "runs no UPDATE" is satisfied by an empty file,
    // and the prohibition below would be decoration.
    expect(
      statements.some((s) => /ALTER TABLE brain_facts ADD COLUMN.*object_cmp/is.test(s)),
      "0191 no longer adds `object_cmp` — every assertion here and the whole slice rest on it",
    ).toBe(true);
  });

  it("runs no UPDATE, and no DEFAULT either", () => {
    for (const statement of statements) {
      expect(
        /^UPDATE\b/i.test(statement) ? statement.slice(0, 120) : undefined,
        "0191 grew an UPDATE. `object_cmp` is NEVER backfilled: giving existing rows a value retroactively manufactures positive evidence of DIFFERENCE on pairs a reviewer already saw as `unknown`, and the next publish stamps `valid_to` across them with no gate to disclose it. The rows stay NULL — permanently `unknown`, tension-only — until a new observation reconciles the claim.",
      ).toBeUndefined();
    }
    // A `DEFAULT` is the same backfill wearing DDL clothes: it writes a value
    // onto every existing row, and a constant one at that — so every legacy row
    // would compare EQUAL to every other, which is worse than the stamp above.
    //
    // Matched over the comment-STRIPPED statements, not the raw file. This
    // header discusses `ADD COLUMN` and 0187's rejected `DEFAULT ''` several
    // paragraphs apart, and a prose-spanning match reported a defect in a file
    // that has neither — a guard that cries wolf on its own tree gets deleted
    // rather than fixed.
    for (const statement of statements) {
      expect(
        /ADD COLUMN\b/i.test(statement) && /\bDEFAULT\b/i.test(statement)
          ? statement.slice(0, 160)
          : undefined,
        "0191's ADD COLUMN grew a DEFAULT — that is a backfill with a constant value, so every pre-existing row would compare `same` to every other one",
      ).toBeUndefined();
    }
    // …and `GENERATED ALWAYS AS (…) STORED`, which is the third spelling of the
    // same thing and the one neither arm above sees. A generated column computes
    // for every existing row at `ALTER` time — a backfill in DDL clothes, on
    // exactly the terms the `DEFAULT` arm names — and it would additionally make
    // the column un-writable by `INSERT_FACT_SQL`, so the failure would present
    // as an ingest error rather than as the corpus-wide re-verdict it really is.
    for (const statement of statements) {
      expect(
        /ADD COLUMN\b/i.test(statement) && /\bGENERATED\b/i.test(statement)
          ? statement.slice(0, 160)
          : undefined,
        "0191's ADD COLUMN grew a GENERATED expression — that computes a value for every pre-existing row, which is the backfill this migration exists not to do",
      ).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------

describeIfPg("object_cmp against a real schema (#5030)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5030_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `reconcileFacts` writes through the module-level pool when no runner is
    // injected; `_resetPool(pool)` is what points it at this schema.
    // `DATABASE_URL` is set because sibling brain helpers gate on
    // `hasInternalDB()`, which reads the env var rather than the pool.
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
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  async function seedEpisode(workspaceId: string, sourceId: string): Promise<ReconcileEpisodeRef> {
    const occurredAt = new Date("2026-06-21T09:00:00.000Z");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U123', 'evidence', $3::timestamptz, ARRAY['org'])
       RETURNING id`,
      [workspaceId, sourceId, occurredAt.toISOString()],
    );
    return {
      id: rows[0]!.id,
      workspaceId,
      source: "slack",
      sourceId,
      sourceActor: "U123",
      occurredAt,
      visibleTo: ["org"],
    };
  }

  async function land(workspaceId: string, sourceId: string, claim: {
    subject: string;
    predicate: string;
    object: string;
  }) {
    const episode = await seedEpisode(workspaceId, sourceId);
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      candidates: [{ ...claim, predicateCardinality: "single" }],
      producer: "object-cmp-5030",
      extractedAt: new Date("2026-06-21T10:00:00.000Z"),
    });
    expect(
      report.outcomes[0],
      `"${claim.subject} ${claim.predicate} ${claim.object}" was refused, not landed — the assertions are vacuous`,
    ).not.toMatchObject({ kind: "blocked" });
    return report;
  }

  async function cmpOf(id: string): Promise<string | null> {
    const { rows } = await pool.query<{ object_cmp: string | null }>(
      `SELECT object_cmp FROM brain_facts WHERE id = $1::uuid`,
      [id],
    );
    return rows[0]!.object_cmp;
  }

  /**
   * A row as it exists in the corpus this deploys onto: keyed by 0187/0188,
   * `object_cmp` NULL because no writer had ever produced one.
   *
   * Inserted directly rather than through the stage, which is the only way to
   * reach the state — the stage has written a comparable value on every row
   * since this slice, so a pre-store row is precisely the one it cannot make.
   */
  async function seedPreStoreFact(workspaceId: string, episodeId: string, claim: {
    subject: string;
    predicate: string;
    object: string;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance,
          visible_to, predicate_cardinality, subject_key, predicate_key, object_key)
       VALUES ($1, $2, $3, $4, $5, '{"actor":"test"}'::jsonb, ARRAY['org'], 'single',
               $6, $7, $8)
       RETURNING id`,
      [
        workspaceId,
        claim.subject,
        claim.predicate,
        claim.object,
        episodeId,
        slotKey(claim.subject, identityAlias),
        slotKey(claim.predicate, identityAlias),
        slotKey(claim.object, identityAlias),
      ],
    );
    return rows[0]!.id;
  }

  // ── the no-backfill rule ────────────────────────────────────────────────

  it(
    "a pre-store row still reads NULL after a producer pass — nothing repairs it",
    async () => {
      // The claim is `499 USD`, which PARSES. That matters: if the surface were
      // unparseable this would pass against an implementation that backfilled
      // enthusiastically, because there would be nothing to write.
      const ws = "ws-5030-no-backfill";
      const episode = await seedEpisode(ws, "legacy-seed");
      const legacy = await seedPreStoreFact(ws, episode.id, {
        subject: "business tier",
        predicate: "priced at",
        object: "499 USD",
      });
      expect(await cmpOf(legacy), "the seeded row was not pre-store").toBeNull();

      // A producer re-observes the identical claim. It corroborates the legacy
      // row through `object_key`, so no new row is minted — and the corroborate
      // path writes nothing to the fact at all, which is the property: an
      // opportunistic "while we're here, fill in the comparable value" would be
      // a backfill through the side door, on a live path, with no reviewer.
      const again = await land(ws, "re-observe", {
        subject: "Business Tier",
        predicate: "Priced At",
        object: "499 USD",
      });
      expect(again.corroborated, "the re-observation did not corroborate the legacy row").toBe(1);
      expect(again.created).toBe(0);

      expect(
        await cmpOf(legacy),
        "a producer pass gave a pre-store row a comparable value. That is the backfill by another route: the row was `unknown` when a reviewer last looked at it, and it is now positive evidence of difference against every rival in its slot — with no gate to disclose the change",
      ).toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "…and a FRESH write does get one — the positive control",
    async () => {
      // Its own `it()`, sharing nothing with the prohibition above: in a long
      // proof the first failure hides the rest, and a positive control that
      // broke would silently mask the prohibition it licenses. Every assertion
      // in the previous test is satisfied by a stage that writes no comparable
      // value anywhere at all.
      const ws = "ws-5030-fresh";
      await land(ws, "fresh", {
        subject: "business tier",
        predicate: "priced at",
        object: "499 USD",
      });
      const { rows } = await pool.query<{ object_cmp: string | null }>(
        `SELECT object_cmp FROM brain_facts WHERE workspace_id = $1`,
        [ws],
      );
      expect(rows).toHaveLength(1);
      expect(
        rows[0]!.object_cmp,
        "a fresh reconcile wrote no comparable value — `INSERT_FACT_SQL` is the ONLY writer of this column (0191 does not backfill), so a row it misses abstains forever",
      ).toBe("money:USD:499");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a pre-store row is `unknown`, so it neither supersedes nor is superseded",
    async () => {
      // What the NULL actually MEANS, asserted rather than left implied by the
      // two tests above. This is the permanent two-tier corpus the issue records
      // as an accepted cost, and it is the reason the no-backfill rule is safe
      // to keep: the legacy row is not broken, it abstains.
      const ws = "ws-5030-two-tier";
      const episode = await seedEpisode(ws, "two-tier-seed");
      const legacy = await seedPreStoreFact(ws, episode.id, {
        subject: "business tier",
        predicate: "priced at",
        object: "499 USD",
      });
      await pool.query("UPDATE brain_facts SET status = 'published' WHERE id = $1::uuid", [legacy]);
      await land(ws, "two-tier-rival", {
        subject: "business tier",
        predicate: "priced at",
        object: "599 USD",
      });

      // The publish gate's own join, built from the EXPORTED predicate rather
      // than hand-copied. An earlier cut spelled the `ON` clause inline and was
      // vacuous twice over: it dropped the `split_part` tag arm and the
      // cardinality/status arms, so it passed against a `supersessionCollisionPredicate`
      // reverted to `object_key <>`, and it was a second spelling of "what
      // collides" in a module whose docstring forbids exactly that.
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM brain_facts d
           JOIN brain_facts p ON ${supersessionCollisionPredicate("d", "p")}
          WHERE d.workspace_id = $1 AND ${supersedingDraftPredicate("d")}`,
        [ws],
      );
      // The pair differs at the surface, at the key, and (on the draft side) at
      // the comparable value, and still does not collide — because the PUBLISHED
      // side has nothing to compare.
      expect(Number(rows[0]!.n)).toBe(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── the two tag readers agree ───────────────────────────────────────────

  // ⚠️ ONE `it()` PER CORPUS ROW, not one sweep over all of them. The fast lane
  // registers a test per row for the same reason: in a long proof the first
  // failure hides the rest, so a single loop reports "1 death" no matter how
  // many rows a real regression touches — and that number then lands in the
  // mutation table as if it meant something. Same argument that split
  // `promotion-pg.test.ts`'s abstain control into its own block.
  //
  // These are THE tests that license `object-cmp-corpus.ts`'s oracle. `agree` is
  // a SECOND implementation of `comparableSameSql` / `comparableDifferentSql`,
  // which this subsystem otherwise forbids outright; it is admissible only
  // because these hold the two to the same answers over the same rows. Without
  // them the oracle is unvalidated and every verdict assertion in the fast lane
  // is a claim about the oracle rather than about the system.
  for (const c of AGREEMENT_CORPUS) {
    it(
      `SQL agrees with the oracle and the corpus: ${c.id}`,
      async () => {
        // The rows carry SURFACES; both sides are parsed by the real
        // `comparableValue` and only the COMPARISON is done twice.
        const a = comparableValue({ surface: c.a.surface, declared: c.a.declared });
        const b = comparableValue({ surface: c.b.surface, declared: c.b.declared });
        const { rows } = await pool.query<{ same: boolean | null; different: boolean | null }>(
          `SELECT (${comparableSameSql("$1::text", "$2::text")}) AS same,
                  (${comparableDifferentSql("$1::text", "$2::text")}) AS different`,
          [a, b],
        );
        // Read back through the three-valued reduction the consumers use:
        // corroboration fires on `same`, supersession on `different`, the band
        // between reaches tension alone. `=== true`, so a NULL from either arm
        // reads as "not proven" exactly as a WHERE clause treats it.
        const sqlVerdict =
          rows[0]!.same === true ? "same" : rows[0]!.different === true ? "different" : "unknown";
        expect(
          sqlVerdict,
          `Postgres and the \`agree\` oracle disagree on \`${c.id}\` (${JSON.stringify(a)} vs ${JSON.stringify(b)}). The oracle is what every verdict assertion in the fast lane is written against, so a divergence means that whole suite is testing something the database does not do.`,
        ).toBe(agree(a, b));
        expect(sqlVerdict, `${c.id}: ${c.why}`).toBe(c.verdict);
      },
      PG_TEST_TIMEOUT_MS,
    );
  }

  for (const c of AGREEMENT_CORPUS) {
    it(
      `\`objectSameSql\` never agrees with \`comparableDifferentSql\` — the VETO: ${c.id}`,
      async () => {
        // ⚠️ The disjointness the difference VETO exists to create, and the ONLY
        // assertions that involve the KEY arm — which is where the overlap
        // lives. The cmp arms are trivially disjoint (`=` and `<>` on one pair),
        // so a disjointness test over `comparableSameSql` alone is a tautology.
        // `objectSameSql` is what corroboration actually runs, and its key arm
        // is what fires `same` on `-499` / `499`: `lexicalNorm` strips a leading
        // `-`, so those two key IDENTICALLY while their comparable values prove
        // they disagree. Without the veto both verdicts hold, corroboration
        // merges a margin with its own negation, and the second claim never
        // gets a row.
        //
        // Separate from the parity block above, which compares a REDUCTION that
        // resolves `same` first — it stays green while `different` is also
        // quietly true.
        //
        // Keys come from `identityKey`, which is what `slotKey` computes under
        // the empty vocabulary every corpus row is parsed against.
        const a = comparableValue({ surface: c.a.surface, declared: c.a.declared });
        const b = comparableValue({ surface: c.b.surface, declared: c.b.declared });
        const { rows } = await pool.query<{ same: boolean | null; different: boolean | null }>(
          `SELECT (${objectSameSql("$1::text", "$2::text", "$3::text", "$4::text")}) AS same,
                  (${comparableDifferentSql("$3::text", "$4::text")}) AS different`,
          [identityKey(c.a.surface), identityKey(c.b.surface), a, b],
        );
        expect(
          rows[0]!.same === true && rows[0]!.different === true,
          `\`${c.id}\` is BOTH provably same and provably different — the veto in \`objectSameSql\` is gone, so corroboration merges a pair the publish gate would supersede`,
        ).toBe(false);
      },
      PG_TEST_TIMEOUT_MS,
    );
  }

  it(
    "…and the veto is not a blanket refusal — a key-equal pair with no proven difference still corroborates",
    async () => {
      // THE positive control for the veto. Every assertion above is satisfied by
      // an `objectSameSql` that returns FALSE unconditionally, which would
      // switch corroboration off for the entire corpus.
      const { rows } = await pool.query<{ same: boolean | null }>(
        `SELECT (${objectSameSql("$1::text", "$2::text", "$3::text", "$4::text")}) AS same`,
        [identityKey("Business Tier"), identityKey("business_tier"), null, null],
      );
      expect(
        rows[0]!.same,
        "a key-equal pair with no comparable value on either side stopped corroborating — the veto is firing on the abstain band, which is every unparseable object in the corpus",
      ).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "an UNKNOWN-tag pair is `unknown`, not different — the membership arm (#5035's writer)",
    async () => {
      // ⚠️ The only BEHAVIOURAL falsifier of `comparableDifferentSql`'s
      // `IN (…known tags…)` and `strpos(…) > 0` arms (`reconcile.test.ts` pins
      // the generated tag list lexically). MEASURED: deleting that arm killed ZERO tests
      // before this one existed, because nothing in the corpus can reach it —
      // `comparableValue` cannot produce an unknown tag, and `INSERT_FACT_SQL`
      // is the column's only writer today.
      //
      // It stops being unreachable at #5035, which makes the region importer a
      // SECOND writer of this column and whose entire job is deciding which
      // tags to carry verbatim. A `foo:1` / `foo:2` pair shares a `split_part`
      // head, so without the membership arm it reads as *provably different*
      // and the publish gate stamps `valid_to` on two values nothing can
      // interpret. Values are hand-written here precisely because the parser
      // refuses to make them — that is the point, not a fixture shortcut.
      for (const [a, b] of [
        ["foo:1", "foo:2"],
        ["moneys:1", "moneys:2"],
        ["Money:1", "Money:2"],
        // ⚠️ The BARE TAG NAMES, and they are the shape that actually failed.
        // `split_part('money', ':', 1)` returns the whole string `'money'`,
        // which IS in the known-tag list — so before the `strpos` arm these
        // read as *provably different* from every real value of their own type,
        // measured on PG 16. The three fixtures above all carry a separator and
        // so dodge the one shape the membership arm cannot handle alone; that
        // is the fixtures-agree-by-construction trap, inside the test written
        // to close it.
        ["money", "money:USD:499"],
        ["entity", "entity:01JABC"],
        ["number", "number:499"],
      ]) {
        const { rows } = await pool.query<{ different: boolean | null }>(
          `SELECT (${comparableDifferentSql("$1::text", "$2::text")}) AS different`,
          [a, b],
        );
        expect(
          rows[0]!.different === true,
          `\`${a}\` and \`${b}\` read as provably DIFFERENT. Their shared head is not a tag this module knows, so nothing interprets either value — and *different* is what stamps \`valid_to\`.`,
        ).toBe(false);
        // …and the TypeScript oracle agrees, which is what keeps the fast-lane
        // suite honest about the same population.
        expect(agree(a, b), `the oracle disagrees with SQL on \`${a}\`/\`${b}\``).toBe("unknown");
      }

      // THE positive control: a KNOWN tag with the same shape still compares.
      // Without it the assertion above is satisfied by a difference arm that
      // never fires at all.
      const { rows } = await pool.query<{ different: boolean | null }>(
        `SELECT (${comparableDifferentSql("$1::text", "$2::text")}) AS different`,
        ["money:USD:1", "money:USD:2"],
      );
      expect(rows[0]!.different).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "`split_part(v, ':', 1)` and `comparableTag` read the same tag off every value",
    async () => {
      // Every shape the parser can emit — and ONLY those, deliberately. Values
      // it cannot emit (`moneys`, `foo:1`) are out of scope here: the two readers
      // genuinely diverge on them (TypeScript `null` vs the whole string), which
      // is safe only because the difference arm's `IN (…known tags…)` membership
      // check excludes them and nothing writes one. The `time:` and `money:`
      // entries are the load-bearing ones — their PAYLOADS contain the separator, so a reader
      // that split on all of them, or took the last field, disagrees exactly
      // there and nowhere else.
      const surfaces = [
        { surface: "499 USD" },
        { surface: "499" },
        { surface: "2026-08-04" },
        { surface: "2026-08-04T10:00:00+02:00" },
        { surface: "true" },
        { surface: "x", entityId: "01J8ZQ:7" },
      ];
      const values = surfaces.map((s) => comparableValue(s));
      expect(values.every((v) => v !== null), "a fixture surface stopped parsing").toBe(true);

      for (const value of values) {
        const { rows } = await pool.query<{ tag: string }>(
          `SELECT split_part($1::text, ':', 1) AS tag`,
          [value],
        );
        expect(
          rows[0]!.tag,
          `Postgres and \`comparableTag\` disagree about the tag of \`${value}\`. The difference arm reads the SQL one and every other consumer reads the TypeScript one, so a disagreement compares two values that share no type — a \`valid_to\` stamp on a pair nothing proved apart.`,
        ).toBe(comparableTag(value!)!);
      }
    },
    PG_TEST_TIMEOUT_MS,
  );
});
