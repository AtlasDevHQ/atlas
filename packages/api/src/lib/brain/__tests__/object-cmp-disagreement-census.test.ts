/**
 * The set of pair shapes where the sameness evidence and `comparableDifferentSql`
 * disagree — a CENSUS, pinned (#5318).
 *
 * ## The gap this closes
 *
 * PR 5315 went looking for one pair, driven by a prod trace, and found that a
 * fact can be retired by a fact asserting the identical claim. Nothing anywhere
 * said what else lives in that region. The two predicates were each tested
 * against their own contract and against each other's POST-VETO disjointness
 * (`object-cmp-pg.test.ts`), and every one of those tests is green on every row
 * in the census — because `objectSameSql` resolves FALSE on all of them. The
 * disagreement is one conjunct in, where nothing was looking.
 *
 * ## Why this is not a prohibition, and must never become one
 *
 * The obvious test — *"no pair is both same and different"* — is FALSE BY
 * DESIGN. `entity-homonym` is two different companies both surfaced as `Acme
 * Corp`; the sameness evidence is right about the name, the difference proof is
 * right about the company, and superseding is the CORRECT outcome. A prohibition
 * fails on that row on the day it is written, and the repair anyone would reach
 * for is weakening the homonym handling — trading a visible disagreement for the
 * silent merge `objectSameSql`'s veto was added to prevent (T2: *corroboration
 * merges two distinct beliefs into one row — silent, unattended, no human in the
 * loop*).
 *
 * So: the region is real, partly intended, and what was missing is a written
 * shape. Below, every shape is enumerated, each carries the outcome a person
 * says it should get and why, and a NEW shape fails {@link PINNED_CENSUS} and
 * has to be classified deliberately.
 *
 * ## What it pins, in three layers
 *
 *   1. Every census row really is in the region — MEASURED through
 *      `identityKey`/`slotKey` and the `agree` oracle, never asserted. A row
 *      whose surfaces stopped keying together, or whose comparables stopped
 *      proving difference, is not evidence of anything and fails here.
 *   2. The classification is pinned as a literal. Adding a row to
 *      `DISAGREEMENT_CENSUS` without classifying it fails, in the
 *      `collision-sql-pinned.test.ts` shape — a literal a person updates in the
 *      same commit, deliberately not `toMatchSnapshot()`, which would turn that
 *      review moment into a keystroke.
 *   3. The region's two ENTRANCES are pinned structurally: the sameness
 *      evidence's second disjunct cannot contribute, and no row of the shared
 *      agreement corpus may enter the region unclassified.
 *
 * The fast lane, not `-pg`, and deliberately: a pin that self-skips without
 * `TEST_DATABASE_URL` is not a pin. The oracle it runs on is licensed by
 * `object-cmp-pg.test.ts`, which holds `agree` to the real SQL row by row, and
 * the same file carries this census through real Postgres besides.
 */

import { describe, expect, it } from "bun:test";
import { comparableValue } from "@atlas/api/lib/brain/object-cmp";
import {
  identityAlias,
  identityKey,
  slotKey,
  type AliasLookup,
} from "@atlas/api/lib/brain/identity";
import {
  AGREEMENT_CORPUS,
  DISAGREEMENT_CENSUS,
  agree,
  type DisagreementCase,
} from "./object-cmp-corpus";

/**
 * The one approved edge the `approved-alias` rows need.
 *
 * A hand-built `AliasLookup` rather than a loaded vocabulary: the census is
 * about what key equality DOES to the two predicates, not about how the
 * vocabulary decides to grant it. `vocabulary-*.test.ts` owns the second
 * question, and coupling this pin to it would make an unrelated approval-flow
 * change read as a new disagreement shape.
 */
const ACME_ALIAS: AliasLookup = (norm) => (norm === "acme" ? "acme corp" : norm);

const keyOf = (c: DisagreementCase, side: "a" | "b"): string | null =>
  c.keyRoute === "approved-alias"
    ? slotKey(c[side].surface, ACME_ALIAS)
    : slotKey(c[side].surface, identityAlias);

const cmpOf = (c: DisagreementCase, side: "a" | "b") =>
  comparableValue({
    surface: c[side].surface,
    declared: c[side].declared,
    entityId: c[side].entityId,
  });

// ---------------------------------------------------------------------------
// 1 — every census row is really in the region
// ---------------------------------------------------------------------------

describe("the census rows are measured, not asserted (#5318)", () => {
  // ONE `it()` PER ROW, on `object-cmp-pg.test.ts`'s reason: in a single sweep
  // the first failure hides the rest, so a regression touching four rows reports
  // one death.
  for (const c of DISAGREEMENT_CENSUS) {
    it(`${c.id}: the sameness evidence fires AND the difference proof fires`, () => {
      const keyA = keyOf(c, "a");
      const keyB = keyOf(c, "b");
      const cmpA = cmpOf(c, "a");
      const cmpB = cmpOf(c, "b");

      // The sameness evidence — `objectSameSql`'s first conjunct. `keyA !== null`
      // is load-bearing: `null = null` is NULL in SQL, so two unkeyable surfaces
      // do NOT satisfy the key arm, and a row that reached this region by both
      // sides norming away would be a different finding entirely.
      expect(
        keyA !== null && keyA === keyB,
        `${c.id}: the two surfaces no longer share a slot key, so this row is no longer evidence of a disagreement`,
      ).toBe(true);

      expect(
        agree(cmpA, cmpB),
        `${c.id}: the comparables no longer prove a difference, so this row is no longer in the region`,
      ).toBe("different");

      // And therefore `supersessionCollisionJoin`, which reads only the second,
      // supersedes this pair — whatever the first says.
      expect(cmpA).not.toBeNull();
      expect(cmpB).not.toBeNull();
    });

    it(`${c.id}: the key route is the one recorded`, () => {
      // The route is not decoration — it says which POPULATION the row stands
      // for, and the three reach different ones. Checked because a row whose
      // surfaces quietly became byte-identical would still pass everything above
      // while ceasing to exercise the fold or the alias at all.
      const identical = c.a.surface === c.b.surface;
      const foldsTogether = identityKey(c.a.surface) === identityKey(c.b.surface);
      if (c.keyRoute === "byte-identical") {
        expect(identical, `${c.id}: recorded byte-identical, but the surfaces differ`).toBe(true);
      } else if (c.keyRoute === "lexical-fold") {
        expect(identical, `${c.id}: recorded as a fold, but the surfaces are byte-identical`).toBe(
          false,
        );
        expect(
          foldsTogether,
          `${c.id}: recorded as a fold, but \`lexicalNorm\` does not fold them together`,
        ).toBe(true);
      } else {
        expect(
          foldsTogether,
          `${c.id}: recorded as an alias route, but the two surfaces fold together WITHOUT one — the row proves nothing the fold rows do not`,
        ).toBe(false);
      }
    });
  }

  it("a `remedy` is recorded on exactly the unintended rows", () => {
    for (const c of DISAGREEMENT_CENSUS) {
      expect(
        c.remedy !== undefined,
        `${c.id}: an unintended row needs somewhere to point, and an intended one must not pretend to be a defect awaiting a fix`,
      ).toBe(!c.intendedToSupersede);
    }
  });

  it("the region is not uniformly one verdict — both classifications are populated", () => {
    // The control for the pin below. A census whose rows all carry the same
    // verdict is satisfied by a classification field nobody reads, and the whole
    // point is that `entity-homonym` and `entity-remint` are the SAME SHAPE with
    // OPPOSITE verdicts.
    const intended = DISAGREEMENT_CENSUS.filter((c) => c.intendedToSupersede);
    expect(intended.length).toBeGreaterThan(0);
    expect(intended.length).toBeLessThan(DISAGREEMENT_CENSUS.length);
  });
});

// ---------------------------------------------------------------------------
// 2 — the classification, pinned
// ---------------------------------------------------------------------------

/**
 * The classified set, as a literal.
 *
 * Adding a shape to `DISAGREEMENT_CENSUS` fails here until it is given a
 * mechanism and a verdict, which is the review moment #5318 exists to force.
 * This is `collision-sql-pinned.test.ts`'s shape and not `toMatchSnapshot()`,
 * for that file's stated reason: an auto-written snapshot updates itself on
 * `--update-snapshots`.
 */
const PINNED_CENSUS: readonly (readonly [string, string, string, boolean])[] = [
  ["entity-homonym", "byte-identical", "id-behind-a-shared-name", true],
  ["entity-remint", "byte-identical", "id-behind-a-shared-name", false],
  ["entity-alias-merged-names", "approved-alias", "id-behind-a-shared-name", true],
  ["sign-flip", "lexical-fold", "sign-the-key-discards", true],
  ["sign-flip-money", "lexical-fold", "sign-the-key-discards", true],
  ["sign-flip-declared", "lexical-fold", "sign-the-key-discards", true],
];

describe("the census is pinned (#5318)", () => {
  it("enumerates exactly the classified shapes", () => {
    expect(
      DISAGREEMENT_CENSUS.map((c) => [c.id, c.keyRoute, c.mechanism, c.intendedToSupersede]),
      "the disagreement census moved. This is the review moment: a new shape needs an " +
        "`intendedToSupersede` verdict and a reason from a person — and if it is NOT intended, a " +
        "remedy ticket — before this literal is updated. Do not update it to make the suite green.",
    ).toEqual(PINNED_CENSUS.map((row) => [...row]));
  });

  it("every row carries a reason a reviewer can act on", () => {
    for (const c of DISAGREEMENT_CENSUS) {
      // Length, not presence: `why: ""` satisfies a presence check and is the
      // shape an author reaches for when adding a row to silence the pin above.
      expect(c.why.length, `${c.id} has no reason recorded`).toBeGreaterThan(80);
    }
  });

  it("the two indistinguishable rows really are indistinguishable — and disagree on the verdict", () => {
    // THE finding, asserted rather than left in prose. `entity-homonym` and
    // `entity-remint` present identically to both predicates: same key relation,
    // same tag, two ids. One should supersede and one should not, and NOTHING in
    // the columns separates them — which is why the remedy cannot live in
    // `object-cmp.ts` at all.
    const homonym = DISAGREEMENT_CENSUS.find((c) => c.id === "entity-homonym")!;
    const remint = DISAGREEMENT_CENSUS.find((c) => c.id === "entity-remint")!;
    expect(homonym.mechanism).toBe(remint.mechanism);
    expect(homonym.keyRoute).toBe(remint.keyRoute);
    expect(agree(cmpOf(homonym, "a"), cmpOf(homonym, "b"))).toBe(
      agree(cmpOf(remint, "a"), cmpOf(remint, "b")),
    );
    expect(homonym.intendedToSupersede).not.toBe(remint.intendedToSupersede);
    expect(
      remint.remedy,
      "the unintended row must point at where the remedy lives, since it cannot live in these predicates",
    ).toContain("#5233");
  });
});

// ---------------------------------------------------------------------------
// 3 — the region's entrances
// ---------------------------------------------------------------------------

describe("nothing enters the region unclassified (#5318)", () => {
  it("the sameness evidence's comparable arm cannot contribute", () => {
    // `comparableSameSql` is `a = b` and `comparableDifferentSql` opens with
    // `a <> b`, so a pair satisfying both needs a comparison and its negation.
    // Asserted rather than assumed: it is what licenses `keyRoute` being a
    // property of every row, and a future arm on `comparableSameSql` — the
    // tautological tag arm its docstring warns someone will "restore" — would
    // reopen the door with no other test noticing.
    for (const c of DISAGREEMENT_CENSUS) {
      expect(
        cmpOf(c, "a") === cmpOf(c, "b"),
        `${c.id}: a pair is proving difference while its comparables are equal — the two arms are no longer negations of each other`,
      ).toBe(false);
    }
  });

  it("no row of the shared agreement corpus is in the region without being in the census", () => {
    // The corpus that grows. `AGREEMENT_CORPUS` is where a new object TYPE lands
    // first, and a new type that can prove difference over a folded key enters
    // this region silently — which is exactly how nobody noticed the region
    // existed. `sign-flip` is in both, deliberately: it is the one agreement row
    // that already sits here.
    const censusPairs = new Set(DISAGREEMENT_CENSUS.map((c) => `${c.a.surface} ${c.b.surface}`));
    const uncatalogued = AGREEMENT_CORPUS.filter((c) => {
      const keyA = slotKey(c.a.surface, identityAlias);
      const keyB = slotKey(c.b.surface, identityAlias);
      if (keyA === null || keyA !== keyB) return false;
      const verdict = agree(
        comparableValue({ surface: c.a.surface, declared: c.a.declared }),
        comparableValue({ surface: c.b.surface, declared: c.b.declared }),
      );
      if (verdict !== "different") return false;
      return !censusPairs.has(`${c.a.surface} ${c.b.surface}`);
    }).map((c) => c.id);

    expect(
      uncatalogued,
      "an agreement-corpus row shares a slot key with its partner AND proves a difference, so it " +
        "supersedes at the publish gate — and it is not in the disagreement census. Classify it in " +
        "`DISAGREEMENT_CENSUS` (intended, or not intended with a remedy) rather than deleting it here.",
    ).toEqual([]);
  });
});
