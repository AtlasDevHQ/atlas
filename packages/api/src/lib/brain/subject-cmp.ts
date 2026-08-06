/**
 * The subject's comparable value — `brain_facts.subject_cmp` (#5032,
 * ADR-0037 §5).
 *
 * ## ⚠️ THIS IS NOT `object-cmp.ts` AT ANOTHER POSITION. THE POLARITY IS
 * ## INVERTED
 *
 * It is a separate module for exactly that reason. Both columns are nullable and
 * both prove DIFFERENCE, and there the resemblance stops:
 *
 * | | Null | Proves | Effect when proven |
 * |---|---|---|---|
 * | `object_cmp` | yes | *difference* | **enables** supersession |
 * | `subject_cmp` | yes | *difference* | **suppresses everything** — corroboration, tension and supersession alike |
 *
 * Two claims about *different entities* are not in the same slot at all. There
 * is nothing to strengthen, nothing to flag as a rival, and nothing to retire.
 * So `object-cmp.ts`'s rule — *"tension fires on `different` and `unknown`,
 * supersession on `different` only"* — **does not transfer**, and an
 * implementation written by copying {@link objectSameSql} /
 * {@link objectNotSameSql} mints `in-tension-with` edges between entities the
 * store has just PROVEN are different. That is the wrong direction: the whole
 * point is that the pair never met.
 *
 * There is therefore exactly ONE arm here ({@link subjectNotDifferentSql}) where
 * the object position has two, and all three consumers take the same one.
 *
 * ## What it is for: corroboration is the consumer with no brake
 *
 * The slot keys collide two SURFACES, and homonymy is by definition the case
 * where one surface names two referents — so no key function can separate them,
 * at any future date. `CORROBORATION_LOOKUP_SQL` (`reconcile.ts`) is the only
 * identity consumer with **no grant arm and no cardinality arm**: on a hit it
 * attaches a public episode as evidence to a private fact, and publish then
 * overwrites `visible_to` with the union of the evidence grants
 * (`widenGrantFromEvidence`). Supersession is gated on `single` cardinality at
 * the CANONICAL predicate, which since #5027 needs positive evidence; the
 * tension scan is gated only on the producer's per-claim hint, which defaults to
 * `multi`. Corroboration is gated by neither.
 *
 * So a homonym does not merely mislabel a claim — it discloses a private claim's
 * BODY to a wider audience. That is why the suppression covers corroboration
 * first and the destructive pair second, and why a test asserting only *"no
 * supersession"* passes against a half-implementation that still widens an ACL.
 *
 * ## Only a warehouse-backed subject can supply one — permanently
 *
 * {@link subjectComparableValue} takes a resolved entity id and NOTHING ELSE. It
 * deliberately does not parse the surface, which is the one design decision in
 * this module a reader is most likely to try to "finish" by reaching for
 * `comparableValue`. Two reasons, in order:
 *
 *   1. **ADR-0037 §5 states the limit as absolute** — *"the extractor can never
 *      supply one, for any subject, ever"* — and a surface parse would make that
 *      sentence false in the tree. This slice exists in part to correct exactly
 *      that class of defect one file over (`promotion.ts`'s widening comment),
 *      so introducing a fresh one here would be self-defeating.
 *   2. **It would buy almost nothing and cost silently.** The column is only
 *      ever consulted where the subject KEYS already matched, so a surface parse
 *      changes a verdict only for pairs that normalize together while parsing
 *      apart — `-499` and `499`, since `lexicalNorm` strips a leading `-`. A
 *      subject that is a signed number is not a subject any producer emits, and
 *      the failure it would buy is a SUPPRESSED corroboration: evidence silently
 *      not linked, which is the direction nobody can report.
 *
 * The consequence is stated plainly because it is the weak point: the
 * extracted↔extracted homonym — the case that occurs TODAY — stays
 * unresolvable, and is guarded by the review-gate widening disclosure
 * (`loadWideningPreview`, `lib/brain/oversight.ts`) rather than prevented.
 * Accepting it means accepting it forever.
 *
 * ## NULL is byte-identical to the pre-#5032 behaviour
 *
 * {@link subjectNotDifferentSql} is `(difference) IS NOT TRUE`, and a NULL on
 * either side makes every conjunct of the difference test unknown — so the
 * predicate is NULL, `IS NOT TRUE` is TRUE, and the arm admits the pair. With
 * the column NULL everywhere, which it is on every existing row and on every
 * extractor-produced row forever, nothing changes. That is a stronger
 * non-regression property than `object_cmp` had, and it is ASSERTED rather than
 * read off the SQL (`identity-consumers-pg.test.ts`).
 *
 * ## Cross-region, the failure direction FLIPS to safe
 *
 * `subject_cmp` inherits `object_cmp`'s cross-region hazard (#5035) with the
 * polarity inverted, which is worth stating because it inverts the conclusion: a
 * foreign store id at the subject is non-null and, by construction, unequal to
 * every id the destination mints for the same real entity — so it reads as
 * *different* and **suppresses**. Under-match, recoverable, a missed
 * corroboration. At `object_cmp` the same shape is counterfeit positive evidence
 * of difference and stamps `valid_to`. The two columns must not be given one
 * import rule on the assumption that they fail alike.
 */

import {
  comparableDifferentSql,
  entityComparable,
  type EntityComparable,
} from "@atlas/api/lib/brain/object-cmp";

/**
 * An entity id that a store returned AND that the resolver seam validated —
 * non-empty after trim, for a surface that was actually requested, not a
 * duplicate.
 *
 * ⚠️ **A brand, and it is load-bearing rather than decoration.** The rule this
 * module exists to hold is *the subject's comparable value is a store id and
 * never a parse of the surface* — and until #5032's review panel measured it,
 * that rule was enforced only by a docstring. With a plain `string` parameter,
 * `subjectComparableValue(subject)` compiled at the one call site where both are
 * in scope, and its failure is STRICTLY WORSE than the surface parse the rule
 * forbids: the raw, un-normalized surface becomes the payload, so `Acme Corp`
 * and `acme-corp` produce `entity:Acme Corp` / `entity:acme-corp` — same tag,
 * unequal, *proven different* — and corroboration switches off for exactly the
 * pair the corpus was built around.
 *
 * `reconcile.ts`'s `resolveEntitiesForEpisode` is the ONE place in production
 * code that casts a value into this type, because it is the one place an id is
 * validated. The only other mint in the tree is `subject-cmp.test.ts`'s
 * `resolved()` helper — a deliberate, named exemption, since a test that pins
 * the brand has to be able to construct one.
 *
 * ⚠️ **Guarding this parameter is only half the rule, and the half that does
 * less** (#5032, panel round 4). A brand on the INPUT stops
 * `subjectComparableValue(surface)`; it does not stop a caller skipping this
 * function altogether. While the subject position's destination types spelled
 * {@link EntityComparable}, `entityComparable(subject)` — exported, unbranded,
 * one identifier away in an import list `reconcile.ts` already had — satisfied
 * every one of them with no cast and reintroduced the defect verbatim. That is
 * why {@link SubjectComparable} brands the OUTPUT: the two together mean no
 * NON-NULL value can be built except by passing a validated id through here.
 * The `null` abstain stays constructible anywhere, deliberately — it suppresses
 * nothing, so there is no property to forge.
 */
export type ResolvedEntityId = string & { readonly __resolvedEntityId: unique symbol };

declare const subjectComparableBrand: unique symbol;

/**
 * A subject's comparable value — `entity:<id>` off a validated store id, or
 * `null` for an abstain. The type `brain_facts.subject_cmp` is written from and
 * the type all three identity consumers bind.
 *
 * ⚠️ **Deliberately NOT {@link EntityComparable}, and the difference is the
 * guard.** `EntityComparable` says *"shaped like `entity:…`"*, which the object
 * position also satisfies and which `entityComparable(anyString)` hands out on
 * request. This says *"came from {@link subjectComparableValue}"* — a provenance
 * claim, unforgeable without a cast, and provenance is what the rule is about.
 * The shape was never the thing in doubt: the round-1 defect produced a
 * perfectly well-shaped `entity:Acme Corp`.
 *
 * Derived from `EntityComparable` rather than respelled so the two cannot drift
 * on the shape axis; `NonNullable` because a branded `null` is `never`, and the
 * abstain has to stay a plain `null` for every consumer that tests it.
 */
export type SubjectComparable =
  | (NonNullable<EntityComparable> & { readonly [subjectComparableBrand]: true })
  | null;

/**
 * What lands in `brain_facts.subject_cmp` — a resolved entity id, or `null`.
 *
 * A named function rather than a bare call to {@link entityComparable} at the
 * one call site, because the RULE is what needs a home: *the subject's
 * comparable value is a store id or nothing, never a parse of the surface.* An
 * inlined call is a line someone widens; a function with this docstring is a
 * claim they have to argue with.
 *
 * The claim is enforced at BOTH ends rather than asserted, and it needs both
 * (#5032, panel round 4). The parameter is a {@link ResolvedEntityId}, which a
 * surface cannot satisfy — that closes `subjectComparableValue(surface)`. The
 * return is a {@link SubjectComparable}, which nothing else can produce — that
 * closes the bypass, where a caller reaches past this function to
 * `entityComparable(surface)` and satisfies the destination type anyway. With
 * only the first, the rule held for callers who used this function and not for
 * the ones who didn't, which is the wrong half.
 *
 * The cast is the seam. It is the single point where "shaped like `entity:…`"
 * becomes "came from a validated store id", and it is sound HERE and only here
 * because the parameter type is what makes it so.
 *
 * `subject-cmp.test.ts` pins both halves at compile time with `@ts-expect-error`
 * — the repo's idiom for a brand, and self-falsifying, since an unused
 * `@ts-expect-error` is itself an error the moment either guard is widened. It
 * pins the runtime behaviour too, including the refusal of surfaces that DO
 * parse at the object position, which is what makes it a real refusal rather
 * than a restatement of "unparseable surfaces abstain".
 *
 * `null` here means *unknown*, which suppresses nothing. It is the honest answer
 * for every extractor-produced claim and will stay the answer for them forever.
 */
export function subjectComparableValue(
  entityId: ResolvedEntityId | undefined,
): SubjectComparable {
  return entityComparable(entityId) as SubjectComparable;
}

/**
 * *Not provably a different entity* — the ONE arm, taken by all three consumers.
 *
 * Read the name precisely: it is not "the same subject". It is the complement of
 * PROVEN difference in a three-valued logic, so it admits the entire `unknown`
 * band — which is where every extractor-supplied subject lives, permanently, and
 * is exactly what makes NULL a no-op.
 *
 * `IS NOT TRUE` rather than `NOT (…)`, and this is not a style note: `NOT NULL`
 * is NULL and a `WHERE` treats that as false, so the readable spelling would
 * suppress corroboration for every claim in the corpus whose subject has no
 * comparable value — i.e. all of them. The same trap `objectNotSameSql` records,
 * with a far larger blast radius here because the abstain band at this position
 * is not a minority, it is the default.
 *
 * Built from {@link comparableDifferentSql} rather than re-spelling the tag and
 * well-formedness arms, so the two positions cannot drift about what "provably
 * different" means. The tag arm matters at this position too even though the
 * only tag a subject can carry today is `entity:` — #5035 makes the region
 * importer a second writer of both `_cmp` columns, and the arms that refuse
 * `'entity'`-with-no-payload are the ones that stop a truncated import from
 * reading as proof.
 *
 * ⚠️ There is deliberately no positive `subjectSameSql` counterpart. Nothing
 * needs one: no consumer asks *"are these provably the same subject?"* — the
 * slot keys answer that — and adding one would invite a reader to restore the
 * two-arm symmetry `object-cmp.ts` has, which is where the inverted polarity
 * gets lost.
 *
 * `a` / `b` are interpolated; callers pass column expressions or bind
 * placeholders they control — same contract as `comparableDifferentSql`.
 */
export function subjectNotDifferentSql(a: string, b: string): string {
  return `(${comparableDifferentSql(a, b)}) IS NOT TRUE`;
}
