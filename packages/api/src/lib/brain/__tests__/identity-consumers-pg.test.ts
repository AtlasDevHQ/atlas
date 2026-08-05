/**
 * The three claim-identity consumers, over ONE corpus (#5021, ADR-0037 §9).
 *
 * `identity-corpus.ts` holds the fixture set; this file is the only place that
 * consumes it. Corroboration (`CORROBORATION_LOOKUP_SQL`), the advisory rival
 * scan (`TENSION_CANDIDATES_SQL`), and the publish gate's
 * `supersessionCollisionJoin` each read the same materialized
 * `(subject_key, predicate_key, object_key, object_cmp)` tuple, and each turns
 * it into a different verdict — *same*, *different-and-coexisting*,
 * *different-and-stamping*. Running all three over one fixture set is what stops
 * them drifting into disagreeing about what collides, which three private
 * fixture sets could not detect by construction.
 *
 * ## ⚠️ Since #5030 the three consumers no longer partition the corpus
 *
 * Agreement is THREE-VALUED, so the consumers take non-complementary halves of
 * it: corroboration fires on *same*, supersession on *different*, and the band
 * between them — *unknown* — reaches tension and nothing else. The corpus grew a
 * fourth relation to express that, and the two rival classes are what make the
 * band visible: `unproven-rival` earns a tension edge and NO stamp,
 * `proven-rival` earns both. A corpus with only one rival class cannot tell an
 * abstaining implementation from a stamping one, which is the risk ADR-0037 §9
 * names — the band has to be produced honestly, and a canonicalizer returning
 * the raw surface collapses it to empty while looking like it worked.
 *
 * Every expectation below is COMPUTED from `VERDICTS[pair.relation]` rather than
 * written beside the assertion, so the table is the single definition of what
 * collides and flipping a cell turns three tests red.
 *
 * ## ⚠️ And since #5033 a fifth relation varies something that is NOT identity
 *
 * `tier-guarded-rival` holds five pairs whose subject, predicate and object are
 * byte-identical to `priced-rival`'s. Only the episode's stored `source` differs
 * — the value `reconcile.ts` copies into `provenance.source`, which no arm of
 * any consumer's MATCHING reads. Consumers 1 and 2 must therefore answer exactly
 * as they do for `proven-rival`, and consumer 3 must answer differently; that
 * asymmetry across one held-fixed fixture is what ADR-0037 §4's *identity is
 * source-agnostic; consequence is tier-ordered* means, expressed as tests.
 *
 * The consequence for reading the prohibitions below: consumer 3's
 * `tier-guarded-rival` block is the only place in THIS FILE where a pair that
 * collides on every identity arm is refused a stamp for a non-identity reason.
 * Its positive control is `priced-rival`, one relation up, and the two are the
 * same claims. `promotion-pg.test.ts` carries the other non-identity refusals —
 * the cardinality gate, and the tier guard's absent-`source` carve-out.
 *
 * ## Why this is a `-pg` suite and not a unit one
 *
 * Because the question is which COLUMNS the statements name, and no in-memory
 * executor can see that. `reconcile.test.ts`'s fake dispatches on each SQL
 * constant's string identity and reads its binds positionally, so repointing
 * `CORROBORATION_LOOKUP_SQL` back at the surface columns leaves every
 * BEHAVIOURAL test in that file green — only its lexical backstop, which greps
 * the statement text, catches it. That fake no longer answers identity questions
 * at all (#5021); this file is where the answers moved.
 *
 * **Accepted cost, recorded in the map's T7 §4:** the most load-bearing
 * assertions in the identity slice now live in the slower, WSL2-flakier lane,
 * and a `--affected` run over `lib/brain/` no longer covers them without
 * `TEST_DATABASE_URL`. The one-corpus design bounds that rather than removing
 * it — eighteen pairs, three consumers, not three suites.
 *
 * ## Every prohibition has a positive control, in its own `test()`
 *
 * Each consumer gets a *does collide* block and *does not collide* blocks over
 * the same corpus. The prohibitions are the load-bearing half and every one of
 * them passes green against machinery that does nothing at all — a rival scan
 * that returns zero rows satisfies consumer 2's, a lookup that never hits
 * satisfies consumer 1's, and a join that never matches satisfies consumer 3's.
 * The positive control is what proves each can fire.
 *
 * The control and the prohibitions are SEPARATE `test()` blocks sharing the
 * fixture, never both arms in one body: in a long proof the first failure hides
 * the rest, and a positive control that breaks would silently mask the
 * prohibition it licenses.
 *
 * ## Nothing here writes a key
 *
 * Both sides of every pair land through `reconcileFacts`, so every `*_key`
 * column is a value the stage produced. The corpus supplies surfaces and a claim
 * about English; the system supplies the identity and the observed verdict. A
 * test that hand-wrote the expected key would pin it twice in one commit and
 * agree with itself forever.
 *
 * ## MUTATIONS THIS CATCHES
 *
 * Run one at a time against this file; each line is verified, not asserted.
 *
 * | Mutation | Dies on |
 * |---|---|
 * | `lexicalNorm` loses its ASCII case fold | 14 |
 * | `CORROBORATION_LOOKUP_SQL` repointed at the surface columns | 6 |
 * | the corroboration call site binds raw surfaces instead of `item.keys.*` | 6 — **and 3 in `reconcile.test.ts`**, which is the bind half it can still see |
 * | `INSERT_TENSION_EDGE_SQL`'s endpoints swapped | 10 — the edge DIRECTION is what the review queue renders |
 * | `CORROBORATION_LOOKUP_SQL`'s `object_key = $4` arm neutralized | 6 — via both key-equal `same-claim` pairs |
 * | `CORROBORATION_LOOKUP_SQL`'s `object_cmp = $5` arm neutralized (arity-preserving) | 3 — via `same-through-value` |
 * | `objectSameSql` loses its difference VETO | 3 — via `sign-flip-rival` |
 * | `objectNotSameSql` loses its `OR comparableDifferentSql(…)` disjunct | 1 — `sign-flip-rival`, consumer 2 |
 * | `supersessionCollisionPredicate` back on `object_key <> object_key` | 3 — `rival-through-phrasing`, `cross-type-rival`, `sign-flip-rival` |
 * | `lexicalNorm` loses its edge trim | 3 — via `separator-edges` |
 * | `identityAlias` given a global rule (`/^is /` stripped) | 3 — all three PROHIBITIONS, via `copula-pair` |
 * | `TENSION_CANDIDATES_SQL` repointed at the surface columns | 7 |
 * | the tension call site binds raw surfaces | 7 |
 * | `supersessionCollisionJoin` repointed at the surface columns | 1 — via `priced-rival` |
 * | `subject_key =` neutralized in the rival scan / dropped from the collision join | 1 each, via `subject-differs` |
 * | `predicate_key =` neutralized in the rival scan / dropped from the collision join | 1 each, via `predicate-differs` |
 * | `comparableDifferentSql` loses its `split_part` tag arm | 1 — `cross-type-rival` (`object-cmp-pg.test.ts`'s parity tests catch it too, at the SQL level) |
 * | `objectNotSameSql`'s `IS NOT TRUE` weakened to `NOT (…)` | **1 — `rival-through-phrasing`** |
 * | the tier guard deleted from `supersessionCollisionPredicate` | 5 — every `tier-guarded-rival` |
 * | the tier guard applied to the PUBLISHED side only | 2 — `warehouse-draft`, `unresolvable-draft` |
 * | the tier guard applied to the DRAFT side only | 2 — `warehouse-incumbent`, `unresolvable-incumbent` |
 * | the tier guard weakened to a denylist — the allowlist ARM replaced by `<> 'warehouse'`, the absent-key disjunct kept | **2 — both `unresolvable-*`** |
 * | the tier guard loses its absent-key disjunct | **0 — see below** |
 * | the carve-out simplified to `->>'source' IS NULL` | **0 — see below** |
 * | `TIER_HELD_BACK_COUNT_SQL`'s `IS NOT TRUE` weakened to `NOT (…)` | **0 — see below** |
 * | `TIER_HELD_BACK_COUNT_SQL` hard-wired to `SELECT 0` | **0 — see below** |
 *
 * ⚠️ **EVERY count above was re-measured on this tree, one mutation at a time,
 * and several MOVED** — the case fold 9→14, both tension-repoint rows 2→7, the
 * tension-edge direction 5→10, because #5033 added five corpus entries. (#5030
 * had already moved them from 8, 1 and 1.) Numbers are regenerated in one pass
 * against the FINAL tree and never edited a row at a time, because slice B's
 * table carried numbers forward twice under a header claiming they had been
 * re-measured — and the first cut of THIS slice reproduced that exact defect,
 * updating this paragraph while leaving four cells above it stale.
 *
 * The five tier rows are what #5033 buys, and three of them are worth reading
 * as a set. Two aliases carry the same guard, so "it is present" is not the
 * assertion — *which side* it is present on is, and the one-sided mutations die
 * on DISJOINT fixtures (the two `*-draft` entries versus the two `*-incumbent`
 * ones; `warehouse-both` survives either, since the surviving arm still blocks
 * it). The denylist row is the whole argument for spelling the guard as an
 * allowlist: `<> 'warehouse'` passes every other tier fixture and admits an
 * imported `warehouse:prod`, which is #4964's fail-open lane arriving where the
 * consequence is a `valid_to` stamp.
 *
 * ⚠️ **The denylist row spells its mutation out because the number depends on
 * the spelling, and the first cut of these tables got that wrong.** It replaces
 * the allowlist ARM with `<> 'warehouse'` and keeps the absent-key disjunct.
 * Spelled `IS DISTINCT FROM 'warehouse'` instead, the number here is the same
 * but `promotion-pg.test.ts`'s becomes 1 rather than 0, because `<>` is NULL
 * for a null-valued `source` while `IS DISTINCT FROM` is TRUE. Replacing the
 * WHOLE predicate is a third mutation — it drops the carve-out too, so it
 * additionally kills 8 over there and the rows stop being separable. Both
 * tables in this slice are measured with the `<>` spelling above.
 *
 * ⚠️ **The last four rows are ZEROS, and they are stated rather than omitted.**
 * They mark this file's blind spot exactly, and `promotion-pg.test.ts` is where
 * each is falsified — 8, 1, 1 and 2 respectively:
 *
 *   - The first two are the absent-`source` carve-out. Every pair here lands
 *     through `reconcileFacts`, which spreads `source: episode.source` onto
 *     every fact it writes, so this corpus cannot produce a provenance with no
 *     `source` key — nor one whose `source` is present and `null`, which is the
 *     single input separating `NOT jsonb_exists(…)` from the `IS NULL`
 *     simplification a reader will reach for.
 *   - The last two are the held-back DIAGNOSTIC. Nothing here reads
 *     `PromotionReport.supersessionHeldBack`, so a diagnostic that answered 0
 *     forever — the one failure its own docstring says it exists to prevent —
 *     is green in every test in this file.
 *
 * The two files' blind spots are complements: this one owns the vocabulary
 * cases and the two aliases, that one owns the carve-out and the count.
 *
 * The `objectNotSameSql` disjunct row is the least obvious arm in the slice and
 * the one a reader would delete as redundant: it is what carries a key-equal,
 * provably-different pair into TENSION after the veto has kept it out of
 * corroboration. Without it `sign-flip-rival` mints a second row and then earns
 * no edge — worse than either verdict alone. Said
 * explicitly, and the numbers regenerated in one pass rather than edited row by
 * row, because slice B's table carried numbers forward twice under a header
 * claiming they had been re-measured.
 *
 * Three rows widen what collides rather than narrowing it — `identityAlias`,
 * which widens the KEY FUNCTION, and the two key-arm mutations, which widen the
 * JOINS. All three are caught EXCLUSIVELY by prohibitions, because
 * `copula-pair`, `subject-differs` and `predicate-differs` are all
 * `different-claim` entries. Delete either half of the corpus and a whole
 * direction of failure stops being visible.
 *
 * The two STATEMENT-repoint rows for the rival scan and the collision join
 * survived until BOTH sides of `rival-through-phrasing` were spelled off normal
 * form. A pair with one already-normalized side is blind to either the statement
 * repoint or the call-site bind, depending which side is clean.
 *
 * The last row is the one worth pausing on. `NOT (object_cmp = $5)` reads as
 * the same thing and is NULL whenever either side is unparseable; a WHERE
 * clause treats NULL as false, so the entire `unknown` population silently
 * stops earning tension edges — the abstain band would exist in the
 * documentation and nowhere else. It is caught by ONE test.
 *
 * The two corroboration rows are a matched pair, and the second was added
 * because the first measured ZERO behavioural deaths: with only key-equal
 * `same-claim` entries, neutralizing the `object_cmp` arm killed nothing but a
 * lexical assertion in `reconcile.test.ts`. `same-through-value` is what
 * reaches that arm alone. Both arms of a disjunction need an entry that
 * exercises each in isolation, or one of them is decoration.
 *
 * NOT in the table, and stated because its absence is load-bearing: the rival
 * scan's `object_key <> $4` arm is NOT falsifiable from this corpus. The shape
 * that would catch it is `subject =, predicate =, object =` presented as TWO
 * rows, and `reconcileFacts` cannot produce that — corroboration collapses it
 * first.
 *
 * ⚠️ It has NO real-schema owner anywhere, and an earlier version of this
 * sentence named `promotion-pg.test.ts` — which owned it only through the
 * COLLISION join, and #5030 deleted that join's `object_key` arm entirely.
 * `promotion-pg.test.ts` does not reference `TENSION_CANDIDATES_SQL` at all.
 * What bounds the gap: since #5030 the arm is a DISJUNCT, so deleting it
 * NARROWS rather than widens, and `unproven-rival` catches that direction. A
 * TRUE-substitution — the widening one — is still unowned.
 *
 * Two entries — `inverse-relations` and `entity-alias` — are not falsified by
 * any mutation above, and that is stated rather than hidden: no rule reachable
 * from `lexicalNorm` can swap a subject with an object or unify two spellings of
 * one machine. They prohibit a direction a FUTURE normalization could take
 * (T3 §3 falsified morphological folding with the first of them), and they are
 * licensed by the controls beside them rather than by a mutation of their own.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { promoteBrainFacts } from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { resolvePrincipalContext } from "@atlas/api/lib/brain/acl";
import { loadSupersessionPreview } from "@atlas/api/lib/brain/oversight";
import {
  reconcileFacts,
  type ReconcileEpisodeRef,
} from "@atlas/api/lib/brain/reconcile";
import {
  IDENTITY_CORPUS,
  RELATIONS,
  VERDICTS,
  pairsWhere,
  type Claim,
  type ClaimPair,
  type SlotRelation,
} from "./identity-corpus";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { isEpisodeSource, isWarehouseDerivedSource } from "@atlas/api/lib/brain/sources";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// The corpus's own invariants — deliberately OUTSIDE the Postgres gate
// ---------------------------------------------------------------------------
//
// This needs no database, and it is what licenses every prohibition/control
// pairing below. `for (const pair of pairsWhere("proven-rival"))` over an empty
// array registers ZERO `it()` blocks and reports success, so deleting the last
// entry of a relation silently deletes three tests across three consumers. If
// this guard sat inside `describeIfPg` it would be skipped in exactly the lane
// where the rest of the identity coverage is also skipped — the default local
// and `--affected` runs — which is where a silent deletion would land.

describe("the identity corpus itself (#5021)", () => {
  it("populates every row of the verdict table", () => {
    for (const relation of RELATIONS) {
      expect(
        pairsWhere(relation).length,
        `no corpus entry has relation \`${relation}\` — a consumer's control or prohibition is empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("holds no entry that compares a claim with itself", () => {
    for (const pair of IDENTITY_CORPUS) {
      expect(pair.a, `corpus entry \`${pair.id}\` compares a claim with itself`).not.toEqual(pair.b);
    }
  });

  it("the tier fixtures name what they claim to (#5033)", () => {
    // `identity-corpus.ts` may not import behaviour — that is its stated
    // discipline, and it is what stops a fixture agreeing with the
    // implementation by sharing code with it. The cost is that its `source`
    // values are bare literals, so renaming the vocabulary member `warehouse`
    // would silently turn three warehouse fixtures into three more copies of
    // `unresolvable-incumbent`: still green, still refusing the stamp, but for
    // the OUT-OF-VOCABULARY reason rather than the CLASS reason — and the
    // corpus's claim that the two entries are each other's controls would be
    // quietly false.
    //
    // So the corpus keeps the literals and this file, which may import, checks
    // that they still mean what the corpus says. Asserted as "at least one of
    // each" rather than per-id, because which fixture carries which shape is
    // the corpus's business; that BOTH shapes are present is what licenses the
    // allowlist-vs-denylist argument.
    const tierSources = pairsWhere("tier-guarded-rival").flatMap((pair) => [
      pair.a.source,
      pair.b.source,
    ]);
    expect(
      tierSources.filter((source) => isWarehouseDerivedSource(source)),
      "no `tier-guarded-rival` fixture carries a WAREHOUSE-CLASS source — the guard's headline case is untested and the class arm is falsified by nothing",
    ).not.toHaveLength(0);
    expect(
      tierSources.filter(
        (source) => source !== undefined && !isEpisodeSource(source),
      ),
      "no `tier-guarded-rival` fixture carries an OUT-OF-VOCABULARY source — nothing then distinguishes the shipped allowlist from a `<> 'warehouse'` denylist",
    ).not.toHaveLength(0);
  });

  it("the tier fixtures vary ONLY the tier (#5033)", () => {
    // The corpus's whole falsification argument is *hold identity fixed, vary
    // the tier*: `warehouse-incumbent`'s own `why` says that without a stamping
    // control of the same shape, it "passes green against a guard that dropped
    // the pair from every statement". That control is `priced-rival`, and
    // nothing else checks the two are actually the same claims.
    //
    // The failure this closes is the #5030 shape, twice paid for: change a tier
    // fixture's objects to two NAMES and it becomes an `unproven-rival` wearing
    // a `tier-guarded-rival` label — no comparable value, so the object arm
    // blocks it, so it refuses the stamp for a reason that has nothing to do
    // with the tier, and the guard-deleted mutation quietly survives on it. All
    // three consumers stay green throughout.
    const [control] = pairsWhere("proven-rival").filter((pair) => pair.id === "priced-rival");
    expect(control, "`priced-rival` is gone — the tier fixtures have no control").toBeDefined();
    const identityOf = (claim: Claim) => ({
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      objectType: claim.objectType,
    });
    for (const pair of pairsWhere("tier-guarded-rival")) {
      expect(
        [identityOf(pair.a), identityOf(pair.b)],
        `\`${pair.id}\` is not identity-identical to \`priced-rival\` — it can no longer show that ONLY the tier changed the verdict, and a guard that dropped every pair would pass it`,
      ).toEqual([identityOf(control!.a), identityOf(control!.b)]);
    }

    // …and the five entries present five DISTINCT tier shapes. Without this,
    // dropping `source: "warehouse"` from `warehouse-both`'s `b` side leaves
    // every other invariant and all three consumers green — while deleting the
    // only `-pg` test that kills the weakening `warehouse-both` exists to pin
    // (block only when EXACTLY ONE side is warehouse, i.e. let
    // warehouse↔warehouse stamp). A corpus that collapses two fixtures into one
    // shape loses a mutation and says nothing about it.
    const shapes = pairsWhere("tier-guarded-rival").map(
      (pair) => `${pair.a.source ?? "-"}|${pair.b.source ?? "-"}`,
    );
    expect(new Set(shapes).size, `two tier fixtures share a source shape: ${shapes.join(", ")}`).toBe(
      shapes.length,
    );
    // The both-sides-warehouse shape specifically, named because it is the one
    // that has no other killer anywhere in the repo.
    expect(
      shapes.some((shape) => {
        const [a, b] = shape.split("|");
        return isWarehouseDerivedSource(a) && isWarehouseDerivedSource(b);
      }),
      "no fixture has BOTH sides warehouse-class — warehouse↔warehouse re-emission is then untested, and weakening the guard to an exclusive-or passes every suite",
    ).toBe(true);
  });

  it("holds no duplicate id", () => {
    // The id names a workspace AND both episode source ids, so a duplicate makes
    // two entries share a corpus and points every failure at the wrong one.
    const ids = IDENTITY_CORPUS.map((pair) => pair.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describeIfPg("claim identity — three consumers, one corpus (#5021)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5021_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `reconcileFacts` writes through the module-level pool when no runner is
    // injected. The `_resetPool(pool)` at the end of this hook is what points
    // that pool at this schema, and is the real guard here; `DATABASE_URL` is set because sibling
    // brain helpers gate on `hasInternalDB()`, which reads the env var rather
    // than the pool. Set inside the hook, never at module top level.
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

  afterEach(async () => {
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
    await pool.query("DELETE FROM admin_action_log");
  });

  // ── landing the corpus ──────────────────────────────────────────────────

  /** One workspace per pair, so a failure names the entry that produced it. */
  const workspaceFor = (pair: ClaimPair): string => `ws-identity-${pair.id}`;

  /**
   * `source` is the episode's stored kind, which `reconcile.ts` copies into
   * `provenance.source` — the column #5033's tier guard reads. Defaulted to the
   * ordinary extracted case so every pre-#5033 entry lands exactly as before.
   *
   * Bound as a PARAMETER, not interpolated, and deliberately unvalidated: 0180
   * puts no CHECK on the column and the region import writes out-of-vocabulary
   * values through it, so a corpus entry must be able to reach that state.
   */
  async function seedEpisode(
    workspaceId: string,
    sourceId: string,
    source = "slack",
  ): Promise<ReconcileEpisodeRef> {
    const occurredAt = new Date("2026-06-21T09:00:00.000Z");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, $4, $2, 'U123', 'evidence', $3::timestamptz, ARRAY['org'])
       RETURNING id`,
      [workspaceId, sourceId, occurredAt.toISOString(), source],
    );
    return {
      id: rows[0]!.id,
      workspaceId,
      source,
      sourceId,
      sourceActor: "U123",
      occurredAt,
      visibleTo: ["org"],
    };
  }

  /**
   * Reconcile one side of a pair, through the real stage.
   *
   * `single` cardinality throughout, because it is the ONE configuration all
   * three consumers read: the collision join requires it on BOTH sides, the
   * rival scan is only ISSUED for a `single` incoming candidate (a TypeScript
   * gate in `reconcile.ts`, not an arm of the statement), and corroboration is
   * indifferent. Varying it per consumer would be three configurations of one
   * corpus, which is the drift this file exists to prevent.
   */
  async function land(workspaceId: string, sourceId: string, claim: Claim) {
    const episode = await seedEpisode(workspaceId, sourceId, claim.source);
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      // `source` is spread in with the rest and is harmless — `FactCandidate`
      // has no such field, and the tier the guard reads comes off the EPISODE
      // above, which is the only place a producer can stamp it.
      candidates: [{ ...claim, predicateCardinality: "single" }],
      producer: "identity-corpus",
      extractedAt: new Date("2026-06-21T10:00:00.000Z"),
    });
    // A PRECONDITION, asserted where all nine test bodies inherit it.
    // `reconcileFacts` returns every domain refusal as a counted outcome and
    // never throws, so a candidate that tripped `MALFORMED_CLAIM` would land
    // zero rows and every prohibition below would pass against an empty table.
    // Not hypothetical: `reconcile.ts`'s header plans to widen that guard from
    // `trim() === ""` to refusing a candidate whose key is null, and a corpus
    // entry is only ever one edit away from tripping it.
    expect(
      report.outcomes[0],
      `\`${sourceId}\` was refused, not landed — every assertion downstream is vacuous`,
    ).not.toMatchObject({ kind: "blocked" });
    return report;
  }

  /** Both sides of a pair, `a` then `b`, into that pair's own workspace. */
  async function landPair(pair: ClaimPair) {
    const workspaceId = workspaceFor(pair);
    await land(workspaceId, `${pair.id}-a`, pair.a);
    const b = await land(workspaceId, `${pair.id}-b`, pair.b);
    return { workspaceId, b };
  }

  async function publish(workspaceId: string) {
    const client = await pool.connect();
    // Set only when ROLLBACK itself failed; passing it to `release` DESTROYS the
    // connection instead of returning a client with an open transaction to the
    // pool, where the next test's `afterEach` DELETE would block on its locks
    // rather than failing where the fault actually was.
    let destroyReason: Error | undefined;
    try {
      await client.query("BEGIN");
      const report = await Effect.runPromise(promoteBrainFacts(client, workspaceId));
      await client.query("COMMIT");
      return report;
    } catch (err) {
      // The ROLLBACK must not REPLACE the failure the test was about —
      // `reconcile.ts`'s own runner is the pattern. Its cause is logged rather
      // than dropped: a broken socket or a server-side FATAL here is the reason
      // the next test misbehaves, and silence makes that untraceable.
      await client.query("ROLLBACK").catch((cause: unknown) => {
        destroyReason = cause instanceof Error ? cause : new Error(String(cause));
        console.warn(
          `publish(${workspaceId}): ROLLBACK failed after "${
            err instanceof Error ? err.message : String(err)
          }" — destroying the connection so the next test does not inherit an open transaction: ${destroyReason.message}`,
        );
      });
      throw err;
    } finally {
      // In the `finally`, so a throw from `release` on the success path cannot
      // fall into the catch and re-`ROLLBACK` an already-released client.
      client.release(destroyReason);
    }
  }

  async function factIds(workspaceId: string): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM brain_facts WHERE workspace_id = $1 ORDER BY ingested_at, id`,
      [workspaceId],
    );
    return rows.map((r) => r.id);
  }

  /** The retained SURFACES, in insertion order — what a reviewer actually reads. */
  async function subjectsOf(workspaceId: string): Promise<string[]> {
    const { rows } = await pool.query<{ subject: string }>(
      `SELECT subject FROM brain_facts WHERE workspace_id = $1 ORDER BY ingested_at, id`,
      [workspaceId],
    );
    return rows.map((r) => r.subject);
  }

  /** Every `in-tension-with` edge's endpoints — the DIRECTION is a contract. */
  async function tensionEdges(workspaceId: string): Promise<{ from: string; to: string }[]> {
    const { rows } = await pool.query<{ from: string; to: string }>(
      `SELECT from_fact_id::text AS "from", to_fact_id::text AS "to"
         FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'in-tension-with'`,
      [workspaceId],
    );
    return rows;
  }

  async function tensionEdgeCount(workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'in-tension-with'`,
      [workspaceId],
    );
    return Number(rows[0]!.n);
  }

  async function provenanceEdgeCount(workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'provenance'`,
      [workspaceId],
    );
    return Number(rows[0]!.n);
  }

  /** Facts still answering as-of-now reads — the population supersession shrinks. */
  async function currentFactCount(workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_facts
        WHERE workspace_id = $1 AND valid_to IS NULL AND invalidated_at IS NULL`,
      [workspaceId],
    );
    return Number(rows[0]!.n);
  }

  /** How many rows a pair leaves behind: one if it collapsed, two if it did not. */
  const rowsFor = (pair: ClaimPair): number => (VERDICTS[pair.relation].corroborates ? 1 : 2);

  // ══════════════════════════════════════════════════════════════════════
  // Consumer 1 — corroboration (CORROBORATION_LOOKUP_SQL): *same*
  // ══════════════════════════════════════════════════════════════════════

  describe("consumer 1 — corroboration says *same*", () => {
    // `Record<SlotRelation, …>` rather than three hand-written `pairsWhere("…")`
    // loops: adding a relation to the corpus is then a COMPILE error here, not a
    // corpus entry that no consumer reads. Same in the two consumers below.
    const TITLES: Record<SlotRelation, string> = {
      "same-claim": "⭐ strengthens instead of forking",
      "unproven-rival": "does not absorb a different VALUE in the same slot",
      "proven-rival": "does not absorb a provably different VALUE either",
      // Identity is source-agnostic (#5033): corroboration must behave here
      // EXACTLY as it does for `proven-rival`. A guard that leaked into the
      // lookup would start merging or forking on tier, which is per-class
      // matching — the thing ADR-0037 §4 rules out.
      "tier-guarded-rival": "does not absorb one across a tier boundary either",
      "different-claim": "does not collide a different SLOT",
    };

    for (const relation of RELATIONS) {
      for (const pair of pairsWhere(relation)) {
        it(
          `${TITLES[relation]}: ${pair.id}`,
          async () => {
            const { workspaceId, b } = await landPair(pair);
            const verdict = VERDICTS[pair.relation];

            expect(b.corroborated).toBe(verdict.corroborates ? 1 : 0);
            expect(b.created).toBe(verdict.corroborates ? 0 : 1);
            // The row count is the control that keeps the prohibitions honest:
            // "did not corroborate" is also true of a stage that wrote nothing.
            expect(await factIds(workspaceId)).toHaveLength(rowsFor(pair));
            // Either way BOTH episodes are cited — one belief with two pieces of
            // evidence behind it, or two beliefs with one each.
            expect(await provenanceEdgeCount(workspaceId)).toBe(2);
            // Identity moved; the record of what a producer SAID did not. On a
            // collapse the corpus keeps the FIRST phrasing verbatim and the
            // second episode arrives as evidence — a corroboration that
            // overwrote the surface would silently rewrite history, and nothing
            // else in the repo pins this.
            expect(await subjectsOf(workspaceId)).toEqual(
              verdict.corroborates ? [pair.a.subject] : [pair.a.subject, pair.b.subject],
            );
          },
          PG_TEST_TIMEOUT_MS,
        );
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // Consumer 2 — the rival scan (TENSION_CANDIDATES_SQL):
  // *different-and-coexisting*
  // ══════════════════════════════════════════════════════════════════════

  describe("consumer 2 — the rival scan says *different-and-coexisting*", () => {
    const TITLES: Record<SlotRelation, string> = {
      "unproven-rival": "⭐ flags a contradiction it CANNOT prove — the abstain band",
      "proven-rival": "⭐ flags a contradiction it can prove",
      // ⭐ The half of #5033 that says the pair is HELD BACK rather than
      // dropped. The tier guard withholds the stamp; if it also cost the
      // tension edge, a cross-tier contradiction would vanish from the review
      // queue entirely — silently, and precisely where the authoritative side
      // is the one at stake.
      "tier-guarded-rival": "⭐ still flags the contradiction the publish gate will NOT act on",
      "same-claim": "does not put one claim in tension with itself",
      "different-claim": "does not flag two claims that share no slot",
    };

    for (const relation of RELATIONS) {
      for (const pair of pairsWhere(relation)) {
        it(
          `${TITLES[relation]}: ${pair.id}`,
          async () => {
            const { workspaceId, b } = await landPair(pair);
            const verdict = VERDICTS[pair.relation];
            const edges = verdict.tension ? 1 : 0;

            expect(await tensionEdgeCount(workspaceId)).toBe(edges);
            // …and it points the right way. `INSERT_TENSION_EDGE_SQL` sets
            // `from_fact_id` to the row just written, which is what the review
            // queue renders as "this new claim contradicts that one". Nothing
            // else in the repo asserts the direction — every other site counts.
            if (verdict.tension) {
              const [aId, bId] = await factIds(workspaceId);
              expect(await tensionEdges(workspaceId)).toEqual([{ from: bId!, to: aId! }]);
            }
            // The stage's own count, on whichever outcome shape the verdict
            // implies — a corroboration carries no `tensionEdges` at all,
            // because the claim collapsed into the existing row and the scan
            // is only reached on the create path.
            expect(b.outcomes[0]).toMatchObject(
              verdict.corroborates ? { kind: "corroborated" } : { kind: "created", tensionEdges: edges },
            );
            // Both rows have to EXIST for a prohibition to mean anything — an
            // empty table has no tension either. And where an edge was written,
            // it is ADVISORY: both beliefs are still current, nothing was
            // superseded, invalidated, or ranked at ingest. A human at the
            // publish gate arbitrates — that is consumer 3.
            expect(await currentFactCount(workspaceId)).toBe(rowsFor(pair));
          },
          PG_TEST_TIMEOUT_MS,
        );
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // Consumer 3 — the publish gate (supersessionCollisionJoin):
  // *different-and-stamping*
  // ══════════════════════════════════════════════════════════════════════

  describe("consumer 3 — the publish gate says *different-and-stamping*", () => {
    const TITLES: Record<SlotRelation, string> = {
      "proven-rival": "⭐ stamps the incumbent it can PROVE it contradicts",
      "unproven-rival":
        "stamps nothing when it cannot PROVE the contradiction — tension only (#5030)",
      "tier-guarded-rival":
        "stamps nothing across a TIER boundary, however provable the contradiction (#5033)",
      "same-claim": "stamps nothing when the draft merely restates the incumbent",
      "different-claim": "stamps nothing across two slots — the irreversible direction",
    };

    /**
     * Land `a`, publish it so it is the incumbent, then land `b` as a draft.
     *
     * The publish-between step is what makes this consumer's question different
     * from the other two: the collision join reads a PUBLISHED left side, so a
     * corpus landed all-at-once would exercise nothing.
     */
    async function landWithIncumbent(pair: ClaimPair) {
      const workspaceId = workspaceFor(pair);
      await land(workspaceId, `${pair.id}-a`, pair.a);
      expect((await publish(workspaceId)).promoted).toBe(1);
      const [incumbent] = await factIds(workspaceId);
      await land(workspaceId, `${pair.id}-b`, pair.b);
      return { workspaceId, incumbent: incumbent! };
    }

    async function validToOf(workspaceId: string): Promise<(Date | null)[]> {
      const { rows } = await pool.query<{ valid_to: Date | null }>(
        `SELECT valid_to FROM brain_facts WHERE workspace_id = $1 ORDER BY ingested_at, id`,
        [workspaceId],
      );
      return rows.map((r) => r.valid_to);
    }

    /** The disclosure an admin sees BEFORE pressing publish. */
    async function previewFor(workspaceId: string) {
      const reader = await resolvePrincipalContext(pool, {
        workspaceId,
        mode: "managed",
        userId: "u1",
        resolvedRole: { role: "owner", orgId: workspaceId },
      });
      return loadSupersessionPreview(pool, reader);
    }

    for (const relation of RELATIONS) {
      for (const pair of pairsWhere(relation)) {
        it(
          `${TITLES[relation]}: ${pair.id}`,
          async () => {
            const { workspaceId, incumbent } = await landWithIncumbent(pair);
            const verdict = VERDICTS[pair.relation];
            const stamps = verdict.supersedes ? 1 : 0;

            // The disclosure and the transaction are two call sites of ONE join,
            // and drift between them is silent supersession (#4912). Asserted
            // before the transaction, because that is when an admin reads it —
            // and on the PAIR IDS, not only the count: a disclosure that says
            // "1" while naming a different row is exactly the drift, and a count
            // comparison agrees with it.
            const preview = await previewFor(workspaceId);
            expect(preview).toMatchObject({ total: stamps, withheld: 0 });
            expect(preview.pairs.map((p) => p.supersededId)).toEqual(
              verdict.supersedes ? [incumbent] : [],
            );

            const report = await publish(workspaceId);
            // `superseded` is optional on the report — absent is the same claim
            // as empty, and `toHaveLength(1)` still fails if the field vanishes.
            const superseded = report.superseded ?? [];
            expect(superseded).toHaveLength(stamps);
            // …and the transaction stamped the row the disclosure named.
            expect(superseded.flatMap((s) => s.superseded)).toEqual(
              verdict.supersedes ? [incumbent] : [],
            );

            const validTo = await validToOf(workspaceId);
            expect(validTo).toHaveLength(rowsFor(pair));
            expect(validTo.filter((t) => t !== null)).toHaveLength(stamps);
            // The population still answering as-of-now reads. For a
            // `different-claim` this is the whole point: both beliefs survive,
            // and a stamped `valid_to` has no correction path — `supersede`
            // refuses a target whose end is already decided, and no verb clears
            // one, so an over-match here irreversibly ends a true belief. `Osprey rollout led_by Ana`
            // retired because someone also said `Ana leads Osprey rollout`.
            expect(await currentFactCount(workspaceId)).toBe(rowsFor(pair) - stamps);
          },
          PG_TEST_TIMEOUT_MS,
        );
      }
    }
  });
});
