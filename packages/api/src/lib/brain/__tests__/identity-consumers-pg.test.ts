/**
 * The three claim-identity consumers, over ONE corpus (#5021, ADR-0037 §9).
 *
 * `identity-corpus.ts` holds the fixture set; this file is the only place that
 * consumes it. Corroboration (`CORROBORATION_LOOKUP_SQL`), the advisory rival
 * scan (`TENSION_CANDIDATES_SQL`), and the publish gate's
 * `supersessionCollisionJoin` each read the same materialized
 * `(subject_key, predicate_key, object_key, object_cmp, subject_cmp)` tuple, and
 * each turns
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
 * `tier-guarded-rival` holds pairs whose subject, predicate and object are
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
 * ## ⚠️ And since #5032 a SIXTH relation refuses a pair every key arm ADMITS
 *
 * `proven-homonym` is refused by a residual filter rather than by a key — as
 * `tier-guarded-rival`'s `supersedes: false` already is (`supersedableTierSql`,
 * #5033), so it is the shape that is notable here and not the precedent. One
 * surface, two ENTITIES: the subject key, the predicate key
 * and (for three of the four entries) the object key all match, so every
 * consumer WOULD collide the pair — and `subject_cmp` is a residual filter that
 * stops them. Its verdict row is byte-identical to `different-claim`'s and the
 * two are not interchangeable: fold them together and the filter is falsified by
 * nothing, because a `different-claim` pair is refused by an arm that would have
 * refused it anyway.
 *
 * ⚠️ **Its polarity is INVERTED against `object_cmp`'s**, which is the mistake
 * ADR-0037 §5 names by hand: proven difference at the OBJECT enables a stamp, at
 * the SUBJECT it suppresses corroboration, tension and supersession alike. So
 * `proven-homonym`'s tension cell is `false` where `proven-rival`'s is `true`,
 * and a reader "restoring symmetry" there would mint advisory edges between
 * entities the store has just proven are different.
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
 * **GENERATED — see `packages/api/scripts/mutations/identity-corpus.md`**, from
 * `scripts/mutations/identity-corpus.mutations.ts`:
 *
 *     cd packages/api && bun run scripts/mutate.ts scripts/mutations/identity-corpus.mutations.ts
 *
 * Two sibling tables cover the arms this one deliberately omits, so no number
 * lives in two places: `tier-guard.md` (the consequence ordering, #5033) and
 * `subject-cmp.md` (the homonymy suppression, #5032).
 *
 * ⚠️ **This table used to be hand-typed here, and #5032 is what finally
 * promoted it — because it went stale AGAIN, exactly as its own header
 * predicted.** That header said every count had been re-measured and that
 * several MOVED when #5033 added five corpus entries (the case fold 9→14, both
 * tension-repoint rows 2→7, the tension edge 5→10). #5032 added four more
 * entries and five cells moved again — the case fold 14→20, two corroboration
 * rows 6→12 and a third 6→16. The exact numbers are in the generated table;
 * naming them here at all is the habit this promotion exists to break, so they
 * are named once, as evidence that the cells move, and never maintained. Every count here is a function of the CORPUS SIZE,
 * and the corpus is what a slice in this arc grows — so a number stored in
 * prose is a claim that goes false on the next slice, under a comment that
 * reads as measurement. #5060 built the runner for exactly this.
 *
 * The prose below is what the generated table cannot carry: WHY each row means
 * something, and which fixture is load-bearing for it.
 *
 * The tier rows are what #5033 buys, and they are worth reading
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
 * ⚠️ **Four of `tier-guard.md`'s rows are ZEROS in this file's column, and they
 * are stated rather than omitted.** They mark this file's blind spot exactly,
 * and `promotion-pg.test.ts` is where each is falsified:
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
 * no edge — worse than either verdict alone.
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
 * The `objectNotSameSql`'s `IS NOT TRUE` row is the one worth pausing on.
 * `NOT (object_cmp = $5)` reads as the same thing and is NULL whenever either
 * side is unparseable; a WHERE clause treats NULL as false, so the entire
 * `unknown` population silently stops earning tension edges — the abstain band
 * would exist in the documentation and nowhere else. It is caught by ONE test,
 * and `subject-cmp.md` records the identical distinction one position over,
 * where the blast radius is the whole corpus rather than one band.
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
 * The four `homonym-*` entries (#5032) are measured in `subject-cmp.md` rather
 * than here, and the pairing is worth reading there rather than assuming: three
 * of them hold their OBJECTS equal, which is what makes them reach
 * corroboration — and is also why they cannot reach the collision join on any
 * implementation. `homonym-rival` exists because that gap was MEASURED: with
 * only the equal-object rows, deleting the subject arm from
 * `collisionCorePredicate` killed zero tests in this file. A prohibition blocked
 * by the wrong arm is the trap the corpus's arm-coverage table exists to close,
 * and it caught this one.
 *
 * Two entries — `inverse-relations` and `entity-alias` — are not falsified by
 * any mutation in the tables, and that is stated rather than hidden: no rule reachable
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
import { loadSupersessionPreview, loadWideningPreview } from "@atlas/api/lib/brain/oversight";
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
import { identityAlias, identityVocabulary, slotKey } from "@atlas/api/lib/brain/identity";
import { declarePredicateCardinality } from "@atlas/api/lib/brain/cardinality";
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

    // …and the entries present pairwise DISTINCT tier shapes. Without this,
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

  it("the homonym fixtures vary ONLY the subject ids (#5032)", () => {
    // `the tier fixtures vary ONLY the tier`'s argument, one position over, and
    // it closes the same failure. `homonym-subject` refuses corroboration; if
    // its CLAIMS drifted from its control's — one different object, one
    // different predicate spelling — it would refuse for a reason that has
    // nothing to do with the subject ids, and the mutation that deletes the
    // subject arm would quietly survive on it. All three consumers stay green
    // throughout, which is what makes this invisible without an assertion.
    const identityOf = (claim: Claim) => ({
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      objectType: claim.objectType,
      source: claim.source,
    });
    const homonyms: readonly ClaimPair[] = IDENTITY_CORPUS.filter((pair) =>
      pair.id.startsWith("homonym-"),
    );
    // The equal-object family and the rival share nothing but their name, so
    // they are checked against DIFFERENT controls — `homonym-subject` and
    // `priced-rival` respectively.
    const [equalObjectControl] = homonyms.filter((pair) => pair.id === "homonym-subject");
    expect(
      equalObjectControl,
      "`homonym-subject` is gone — the equal-object homonym fixtures have no control",
    ).toBeDefined();
    for (const pair of homonyms.filter((p) => p.id !== "homonym-rival")) {
      expect(
        [identityOf(pair.a), identityOf(pair.b)],
        `\`${pair.id}\` is not identity-identical to \`homonym-subject\` — it can no longer show that ONLY the subject ids changed the verdict`,
      ).toEqual([identityOf(equalObjectControl!.a), identityOf(equalObjectControl!.b)]);
    }
    // …and `homonym-rival` against `priced-rival`, which is the shape that
    // reaches consumers 2 and 3. Objects deliberately differ from the family
    // above, so it needs its own control rather than sharing one.
    const [rivalControl] = pairsWhere("proven-rival").filter((p) => p.id === "priced-rival");
    // `pairsWhere` already returns `readonly ClaimPair[]`, so this one needs no
    // widening — only the direct `IDENTITY_CORPUS` reads above do.
    const [homonymRival] = homonyms.filter((p) => p.id === "homonym-rival");
    expect(rivalControl, "`priced-rival` is gone — `homonym-rival` has no control").toBeDefined();
    expect(homonymRival, "`homonym-rival` is gone — consumers 2 and 3 lose their only falsifier").toBeDefined();
    expect(
      [identityOf(homonymRival!.a), identityOf(homonymRival!.b)],
      "`homonym-rival` is not identity-identical to `priced-rival` — it can no longer show that ONLY the subject ids withheld the stamp",
    ).toEqual([identityOf(rivalControl!.a), identityOf(rivalControl!.b)]);

    // …and the ids themselves present the three DISTINCT shapes the falsification
    // needs. Collapse any two and a whole mutation class stops being visible:
    // without `absent` the suppression cannot be told from a broken lookup,
    // without `same` it cannot be told from `both sides non-null ⇒ suppress`,
    // and without `differ` nothing exercises the arm at all.
    // Annotated `ClaimPair`, not `(typeof IDENTITY_CORPUS)[number]`. The corpus
    // is `as const satisfies readonly ClaimPair[]`, so its element type is a
    // union of LITERALS in which the optional `subjectEntityId` is absent from
    // every arm that does not set it — reading it off the literal type is a
    // compile error. Widening to the declared interface is what makes the
    // optional field readable, and is why `identityOf` above takes `Claim`.
    const shapeOf = (pair: ClaimPair) =>
      pair.a.subjectEntityId === undefined && pair.b.subjectEntityId === undefined
        ? "absent"
        : pair.a.subjectEntityId === pair.b.subjectEntityId
          ? "same"
          : "differ";
    expect(new Set(homonyms.map(shapeOf))).toEqual(new Set(["absent", "same", "differ"]));
    // Every `proven-homonym` entry really carries DIFFERING ids — the relation
    // asserts the store proved a difference, and a fixture that forgot the ids
    // would be a `same-claim` wearing the label, passing every consumer's
    // prohibition because the pair never reached the arm.
    for (const pair of pairsWhere("proven-homonym")) {
      expect(
        shapeOf(pair),
        `\`${pair.id}\` claims relation \`proven-homonym\` but its two sides do not carry DIFFERENT subject entity ids — nothing is being suppressed`,
      ).toBe("differ");
    }
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
      // `source` and `subjectEntityId` are spread in with the rest and are
      // harmless — `FactCandidate` has neither field. The tier the guard reads
      // comes off the EPISODE above and the subject id comes off the RESOLVER
      // below, which are the only two places a producer can stamp them.
      candidates: [{ ...claim, predicateCardinality: "single" }],
      // The entity store, standing in for a warehouse-backed one (#5032).
      // Answers for the SUBJECT surface only, and only when the fixture names an
      // id: that is what `subject_cmp` can ever be fed from, since
      // `subject-cmp.ts` never parses a surface.
      //
      // Omitted entries are an ABSTAIN, not a failure — which is what leaves
      // every pre-#5032 entry in the corpus landing exactly as it did before,
      // with `subject_cmp` NULL and nothing suppressed.
      ...(claim.subjectEntityId === undefined
        ? {}
        : {
            resolveEntity: (surfaces: ReadonlySet<string>) =>
              new Map(
                [...surfaces]
                  .filter((surface) => surface === claim.subject.trim())
                  .map((surface) => [surface, { entityId: claim.subjectEntityId! }]),
              ),
          }),
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
      // ⭐ THE consumer for #5032, and the reason `subject_cmp` exists. Every
      // key arm merges this pair; only the residual subject filter keeps them
      // apart. A merge here attaches the second episode as EVIDENCE to the
      // first fact, and publish then unions in its grant — so this cell is the
      // one that stops a private claim's BODY reaching a public audience.
      "proven-homonym": "⭐ does not absorb a claim about a DIFFERENT ENTITY with the same name",
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
      // ⚠️ `false`, and this is where the polarity is easiest to get wrong.
      // `object_cmp` sends proven difference TO tension; `subject_cmp` sends it
      // nowhere. Two claims about provably different entities are not rivals,
      // so an edge here would assert a contradiction that does not exist — the
      // failure mode ADR-0037 §5 names when it forbids reading this column as a
      // mirror of the object one.
      "proven-homonym": "does not flag two claims about DIFFERENT entities as rivals",
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
      // The LEAST important of this column's three cells, and worth saying so:
      // supersession already needs `single` cardinality and a provably
      // different object, so a homonym rarely reaches it. Corroboration is
      // where #5032 earns its place.
      "proven-homonym": "stamps nothing between two claims about DIFFERENT entities",
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
      // Cardinality is a property of the CANONICAL PREDICATE since #5027, and
      // absent means `multi` — so without an approved entry this consumer
      // stamps nothing for ANY pair and all nine cases below would agree on
      // zero, which is the shape of a suite that has stopped asking anything.
      //
      // BOTH predicates are curated, and deliberately: this suite is about the
      // identity and object arms, so cardinality must be a non-factor rather
      // than a second variable moving with the fixture. `predicate-differs`
      // carries two different predicates, and curating only one would make it
      // pass for a reason it is not testing.
      await curateSingle(workspaceId, pair.a.predicate);
      await curateSingle(workspaceId, pair.b.predicate);
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

    /**
     * Declare a predicate `single` through the shipped authoring door (#5027).
     *
     * `declarePredicateCardinality` rather than a raw INSERT, so a change to
     * what the write path admits reaches this suite instead of being routed
     * around by a fixture that writes the table directly.
     */
    async function curateSingle(workspaceId: string, predicate: string) {
      const result = await declarePredicateCardinality(pool, workspaceId, {
        predicateKey: slotKey(predicate, identityAlias),
        cardinality: "single",
        authoredBy: "curator-1",
      });
      expect(
        result.ok,
        `curating "${predicate}" failed — this consumer would then stamp nothing for any reason`,
      ).toBe(true);
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
  // ══════════════════════════════════════════════════════════════════════
  // The review-gate widening disclosure, against the real schema (#5032)
  // ══════════════════════════════════════════════════════════════════════

  describe("the widening notice runs (#5032)", () => {
    // ⚠️ This block exists because `willWidenRowsSql` was, until the review
    // panel measured it, **never executed anywhere**. Every other assertion on
    // it is `toContain` against a fake reader keyed on `sql.includes(…)`, so a
    // syntax error, a wrong alias, a broken `aclVisibilityClause` interpolation,
    // or a `||` label expression collapsing to NULL would all have shipped
    // green — on the one surface whose failure mode is *"an admin published an
    // ACL change they were not shown"*. Its sibling `willSupersedePairsSql` has
    // had a real-schema exercise since #4912; this closes the asymmetry.
    //
    // Deliberately NOT driven from the corpus. The corpus varies IDENTITY; this
    // varies GRANTS, which no `ClaimPair` expresses — and bolting a grant field
    // onto `Claim` would put a field on every entry that fifteen of them ignore.

    async function seedGrantedEpisode(
      workspaceId: string,
      sourceId: string,
      visibleTo: readonly string[],
    ): Promise<ReconcileEpisodeRef> {
      const occurredAt = new Date("2026-06-21T09:00:00.000Z");
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO brain_episodes
           (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
         VALUES ($1, 'slack', $2, 'U123', 'evidence', $3::timestamptz, $4::text[])
         RETURNING id`,
        [workspaceId, sourceId, occurredAt.toISOString(), [...visibleTo]],
      );
      return {
        id: rows[0]!.id,
        workspaceId,
        source: "slack",
        sourceId,
        sourceActor: "U123",
        occurredAt,
        visibleTo: [...visibleTo],
      };
    }

    /** The same claim, twice, from two differently-granted episodes. */
    async function landCorroboratedPair(
      workspaceId: string,
      first: readonly string[],
      second: readonly string[],
    ) {
      for (const [i, grant] of [first, second].entries()) {
        await reconcileFacts({
          vocabulary: identityVocabulary,
          episode: await seedGrantedEpisode(workspaceId, `widen-${i}`, grant),
          candidates: [{ subject: "acme corp", predicate: "status", object: "active" }],
          producer: "widening-notice",
          extractedAt: new Date("2026-06-21T10:00:00.000Z"),
        });
      }
      // The PRECONDITION: one row with two evidence edges. If the second
      // observation forked instead of corroborating there is nothing to widen,
      // and every assertion below would pass vacuously.
      expect(await factIds(workspaceId), "the pair did not corroborate").toHaveLength(1);
      expect(await provenanceEdgeCount(workspaceId)).toBe(2);
    }

    async function previewFor(workspaceId: string) {
      const readerCtx = await resolvePrincipalContext(pool, {
        workspaceId,
        mode: "managed",
        userId: "u1",
        resolvedRole: { role: "owner", orgId: workspaceId },
      });
      return loadWideningPreview(pool, readerCtx);
    }

    it(
      "⭐ names the claim and the grant tokens publish will add",
      async () => {
        // The statement executes, the CTE bound parses, the ACL clause
        // interpolates at the right placeholder, and the label expression
        // survives the concatenation. None of that was covered before.
        const ws = "ws-5032-widen-fires";
        // ⚠️ The first grant is `role:member` and NOT `audience:procurement`,
        // and the reason is the disclosure's own scoping rule rather than
        // convenience: an entry appears only where the reader's ACL admits the
        // DRAFT, and an `owner` reviewer holds no `audience:procurement`. The
        // evocative private-channel story is the one the LAST test in this block
        // pins — where the widening happens and the notice correctly says
        // nothing. Here the reviewer must be able to see what they are being
        // warned about, or the test would pass against a loader that returns
        // nothing for any input.
        await landCorroboratedPair(ws, ["role:member"], ["org"]);

        const preview = await previewFor(ws);
        expect(preview.total).toBe(1);
        expect(preview.entries[0]?.label).toBe("acme corp status active");
        expect(preview.entries[0]?.added).toEqual(["org"]);
        expect(preview.truncated).toBe(false);
        expect(preview.incomplete).toBe(false);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "…and says nothing when the second episode grants what the fact already holds",
      async () => {
        // THE prohibition, and its control is the test above — byte-identical
        // but for the second episode's grant. Widening fires on ordinary
        // corroboration too, so a notice that reported "there are evidence
        // edges" would fire on essentially every publish and be clicked
        // through; the gate is `widenGrantFromEvidence` returning non-null.
        const ws = "ws-5032-widen-silent";
        await landCorroboratedPair(ws, ["org"], ["org"]);

        const preview = await previewFor(ws);
        expect(preview.total).toBe(0);
        expect(preview.entries).toEqual([]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "the notice lists exactly what the publish then writes",
      async () => {
        // The #4912 property, applied to this disclosure: the preview and the
        // transaction are two call sites of ONE decision function, and drift
        // between them is an ACL change disclosed as one thing and performed as
        // another. Asserted against `PromotionReport.widened`, which is the
        // durable record of what actually happened.
        const ws = "ws-5032-widen-agrees";
        await landCorroboratedPair(ws, ["role:member"], ["org"]);

        const preview = await previewFor(ws);
        const report = await publish(ws);

        expect(report.widened?.map((w) => w.added)).toEqual(
          preview.entries.map((e) => e.added),
        );
        expect(report.widened?.map((w) => w.rowId)).toEqual(
          preview.entries.map((e) => e.factId),
        );
        // …and the grant really widened at rest, so neither list is a pair of
        // agreeing intentions about a write that did not happen.
        const { rows } = await pool.query<{ visible_to: string[] }>(
          `SELECT visible_to FROM brain_facts WHERE workspace_id = $1`,
          [ws],
        );
        expect(rows[0]!.visible_to.toSorted()).toEqual(["org", "role:member"]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      '⚠️ an empty list means "none that YOU can see", never "none"',
      async () => {
        // The stated limit of this disclosure, made falsifiable instead of left
        // in a docstring. The first episode is `audience:procurement`, which an
        // `owner` reviewer does not hold — so the draft is outside their ACL,
        // the notice lists nothing, and publishing widens it to `org` anyway.
        //
        // This is the case with NO unscoped `withheld` counterpart:
        // `willSupersede` can count what a reader may not see because a
        // `COUNT(*)` needs no content, while the equivalent here would have to
        // run the grant grammar over other readers' episode grants — which
        // `oversight.ts`'s no-unscoped-content rule forbids. So the honest
        // reading of an empty list is "none that you can see", and this test is
        // what stops a future reader treating it as an all-clear.
        const ws = "ws-5032-widen-out-of-scope";
        await landCorroboratedPair(ws, ["audience:procurement"], ["org"]);

        const preview = await previewFor(ws);
        expect(preview.total, "a draft outside the reader's ACL was listed").toBe(0);
        expect(preview.entries).toEqual([]);
        // …and the widening HAPPENS regardless — publish is workspace-wide.
        // Without this half the test would pass against a loader that never
        // finds anything, which is the failure it exists to distinguish from.
        const report = await publish(ws);
        expect(
          report.widened?.map((w) => w.added),
          "the publish did not widen, so the silence above proves nothing",
        ).toEqual([["org"]]);
      },
      PG_TEST_TIMEOUT_MS,
    );
  });
});
