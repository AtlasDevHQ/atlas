/**
 * `lib/brain/subject-cmp.ts` — the inverted-polarity arm, unit-tested (#5032,
 * ADR-0037 §5).
 *
 * ## Why this file exists at all
 *
 * The module shipped with no direct test: both exports were reached only
 * transitively, through `reconcile.ts`'s statements and the `-pg` corpus. That
 * is thin in the one place it should not be, for two reasons.
 *
 * **`subjectNotDifferentSql` has the largest blast radius of any line in the
 * slice.** Its `IS NOT TRUE` covers the entire abstain band, and at THIS
 * position the abstain band is not a minority — it is every extractor-supplied
 * subject, i.e. essentially the whole corpus. Spelled `NOT (…)` it reads
 * identically and suppresses corroboration, tension and supersession for every
 * claim in the workspace, because `NOT NULL` is NULL and a `WHERE` treats that
 * as false.
 *
 * **And the `-pg` lane SKIPS without `TEST_DATABASE_URL`**, which is the default
 * local run. A module whose only falsifiers are in that lane is a module a
 * developer can break and still see green.
 *
 * ## What this file does NOT own
 *
 * Whether the arm produces the right VERDICT against real rows — that is
 * `identity-consumers-pg.test.ts`'s four `homonym-*` fixtures, and it cannot be
 * answered by string comparison. This file owns the two things that are true of
 * the module in isolation: the refusal to parse a surface, and the SHAPE of the
 * arm.
 */

import { describe, expect, test } from "bun:test";
import {
  subjectComparableValue,
  subjectNotDifferentSql,
  type ResolvedEntityId,
  type SubjectComparable,
} from "@atlas/api/lib/brain/subject-cmp";
import { comparableValue, entityComparable } from "@atlas/api/lib/brain/object-cmp";

/**
 * The one cast in this file, and it stands in for `resolveEntitiesForEpisode`'s.
 *
 * The brand exists so a SURFACE cannot reach `subjectComparableValue` — see the
 * type. A test has to mint one somehow; doing it through a single named helper
 * keeps the exemption visible rather than sprinkling `as` through the bodies.
 */
const resolved = (id: string): ResolvedEntityId => id as ResolvedEntityId;

/**
 * Widens a {@link SubjectComparable} back to a plain string for comparison.
 *
 * `expect(x).toBe(literal)` infers the expected type from the received one, so
 * the OUTPUT brand (#5032, panel round 4) makes every string literal in this
 * file a type error. Widening the RECEIVED side rather than casting the expected
 * side keeps each assertion byte-identical at runtime — the brand is a
 * compile-time claim and must not be able to change what these tests check.
 */
const stored = (value: SubjectComparable): string | null => value;

describe("the brand — compile-time (⚠️ the `@ts-expect-error` IS the assertion)", () => {
  // Both halves pinned, because #5032's round-4 finding was that guarding only
  // the parameter left the rule holding for callers who used the function and
  // not for the ones who reached past it. An unused `@ts-expect-error` is itself
  // an error, so widening EITHER guard turns this file red — which is the whole
  // reason to spend four lines here rather than trust a docstring.
  test("neither half can be widened without this file going red", () => {
    const surface: string = "Acme Corp";

    // HALF 1 — a bare surface is not a `ResolvedEntityId`. Without this the raw,
    // un-normalized surface becomes the payload and `Acme Corp` / `acme-corp`
    // read as two entities, switching corroboration off for the exact pair the
    // corpus is built around.
    // @ts-expect-error #5032 — a surface is not a ResolvedEntityId
    subjectComparableValue(surface);

    // HALF 2 — the destination type cannot be satisfied by going around this
    // function. `entityComparable` is exported and unbranded, so while the
    // subject position spelled `EntityComparable` this line compiled and WAS
    // the round-1 defect, with no cast anywhere.
    // @ts-expect-error #5032 — only subjectComparableValue produces a SubjectComparable
    const bypass: SubjectComparable = entityComparable(surface);
    // …and the runtime half of the same point: the bypass produces a perfectly
    // well-SHAPED value. The shape was never in doubt — provenance was, which is
    // why the brand claims provenance and not shape.
    expect(stored(bypass)).toBe("entity:Acme Corp");
  });
});

describe("subjectComparableValue", () => {
  test("tags a resolved id as `entity:<id>`", () => {
    expect(stored(subjectComparableValue(resolved("01J8ZK")))).toBe("entity:01J8ZK");
  });

  test("abstains on no id, and on an id that is blank once trimmed", () => {
    // The blank arm is not decoration: `"   "` would otherwise produce
    // `entity:` with no payload — one of the exact malformed shapes
    // `comparableDifferentSql`'s `strpos` arms exist to refuse, reached from
    // the WRITER rather than from a truncating importer.
    expect(subjectComparableValue(undefined)).toBeNull();
    expect(subjectComparableValue(resolved("   "))).toBeNull();
    expect(subjectComparableValue(resolved(""))).toBeNull();
  });

  test("trims a padded id rather than tagging the padding", () => {
    expect(stored(subjectComparableValue(resolved("  01J8ZK  ")))).toBe("entity:01J8ZK");
  });

  test("⭐ NEVER parses the surface — the value is a store id or nothing", () => {
    // ADR-0037 §5 states the limit as absolute: *"the extractor can never supply
    // one, for any subject, ever."* This is that sentence made falsifiable.
    //
    // The inputs are chosen to PARSE at the object position — that is what makes
    // this a real refusal rather than a restatement of "unparseable surfaces
    // abstain". `comparableValue` is called beside each one as the control: if a
    // future edit routed the subject through it, the left column would go
    // non-null and match the right.
    //
    // Why the refusal matters: at this position a value SUPPRESSES.
    // `lexicalNorm` strips a leading `-`, so a surface parse would make `-499`
    // and `499` — ONE subject key — read as two entities and silently stop
    // corroborating, which is the direction nobody can report.
    for (const surface of ["499", "true", "2026-08-04", "499 USD"]) {
      expect(
        comparableValue({ surface }),
        `\`${surface}\` does not parse at the OBJECT position, so it proves nothing about the refusal`,
      ).not.toBeNull();
      // …and the subject refuses it. The cast is what a caller would have to
      // write to get a surface in here at all — the brand makes that a
      // deliberate act rather than an accident, and this is the behavioural
      // half of the same guard.
      expect(
        stored(subjectComparableValue(resolved(surface))),
        `the subject surface \`${surface}\` was parsed — only a store id may land in subject_cmp`,
      ).toBe(`entity:${surface}`);
    }
  });
});

describe("subjectNotDifferentSql", () => {
  test("⚠️ wraps the difference test in `IS NOT TRUE`, never `NOT (…)`", () => {
    const arm = subjectNotDifferentSql("subject_cmp", "$6");
    expect(arm.endsWith(") IS NOT TRUE")).toBe(true);
    // The prohibition, and it is the whole test. `NOT (…)` reads identically and
    // is NULL for the entire abstain band — which at the subject is every
    // extractor-supplied claim — so a `WHERE` treats it as false and every
    // consumer stops firing, workspace-wide. `object-cmp.ts` records the same
    // distinction with a far smaller blast radius.
    expect(arm.startsWith("NOT (")).toBe(false);
  });

  test("is a SUPPRESSION — there is no positive arm anywhere in it", () => {
    const arm = subjectNotDifferentSql("subject_cmp", "$6");
    // ⚠️ The inverted polarity, asserted rather than described. A `=` arm would
    // be `object-cmp.ts`'s two-arm shape restored at the position whose polarity
    // is inverted — and `objectSameSql`'s `OR` disjunct is exactly what a reader
    // "restoring symmetry" would add. Nothing asks *"are these provably the same
    // subject?"*: the slot keys answer that.
    expect(arm).toContain("subject_cmp <> $6");
    expect(arm).not.toContain("subject_cmp = $6");
  });

  test("carries the tag and well-formedness arms, on BOTH operands", () => {
    // Built from `comparableDifferentSql` rather than re-spelling them, so the
    // two positions cannot drift about what "provably different" means. Pinned
    // because #5035 makes the region importer a second writer of both `_cmp`
    // columns: the arms that refuse a truncated `'entity'` with no payload are
    // what stop an import reading as PROOF — and at this position proof
    // suppresses corroboration on every row sharing the defect.
    const arm = subjectNotDifferentSql("p.subject_cmp", "d.subject_cmp");
    expect(arm).toContain("split_part(p.subject_cmp, ':', 1) = split_part(d.subject_cmp, ':', 1)");
    expect(arm).toContain("strpos(p.subject_cmp, ':') > 0");
    expect(arm).toContain("strpos(d.subject_cmp, ':') > 0");
  });

  test("interpolates the operands it is given, in order", () => {
    // A builder, so the two call-site shapes — column-to-bind at reconcile,
    // column-to-column at the publish gate — are one definition. Asserted
    // because a builder that ignored an argument would still produce valid SQL
    // comparing a column with itself, which is `IS NOT TRUE` of `false`, i.e.
    // an arm that never suppresses anything.
    expect(subjectNotDifferentSql("a.x", "b.y")).toContain("a.x <> b.y");
    expect(subjectNotDifferentSql("b.y", "a.x")).toContain("b.y <> a.x");
  });
});
