/**
 * The agreement corpus, and the TypeScript twin of the two SQL builders (#5030).
 *
 * Not a `.test.ts`, for `identity-corpus.ts`'s reason exactly: the isolated
 * runner executes every `.test.ts` it finds, so a suite importing another
 * suite's fixtures would run that suite's tests a second time. Two files
 * consume this one — `object-cmp.test.ts` (the parser, in the fast lane) and
 * `object-cmp-pg.test.ts` (the same corpus through real SQL), which is the
 * whole point: {@link agree} is a SECOND implementation of what
 * `comparableSameSql` / `comparableDifferentSql` express in SQL, and the `-pg`
 * suite is what holds the two to the same answers.
 */

import type { DeclaredObjectType } from "@atlas/api/lib/brain/object-cmp";
import { comparableTag, comparableValue } from "@atlas/api/lib/brain/object-cmp";

// ---------------------------------------------------------------------------
// The TypeScript twin of the two SQL builders
// ---------------------------------------------------------------------------

/**
 * The three-valued agreement, in TypeScript.
 *
 * ⚠️ This is a SECOND implementation of what `comparableSameSql` and
 * `comparableDifferentSql` (in `lib/brain/object-cmp.ts`) express in SQL, and a second implementation is
 * normally exactly what this subsystem forbids. It is admissible here for one
 * reason and under one condition: it is a TEST ORACLE, never imported by
 * production code, and `object-cmp-pg.test.ts` runs the real SQL against the
 * real column and compares it to this function row by row over the same corpus.
 * If the two ever disagree, that suite fails — which is the same
 * two-implementations-must-agree-on-bytes shape migration 0187 records for
 * `lexicalNorm`.
 *
 * Without it this file could only assert string equality, which is not the
 * property: `unknown` is a verdict, and `null === null` being `true` in
 * JavaScript is precisely the confusion the three-valued type exists to
 * prevent.
 */
export type Agreement = "same" | "different" | "unknown";

export function agree(a: string | null, b: string | null): Agreement {
  if (a === null || b === null) return "unknown";
  if (a === b) return "same";
  const tagA = comparableTag(a);
  // `tagA !== null`, not just `tagA === tagB`. Two values with an UNRECOGNIZED
  // head both read `null` here, and `null === null` would call them *different*
  // — while the SQL twin's `IN (…known tags…)` arm says `unknown`. The oracle
  // has to match the SQL on that population too, or the `-pg` parity suite
  // passes only because nothing in the corpus reaches it. Neither `comparableValue`
  // nor `INSERT_FACT_SQL` can produce such a value today; #5035's importer is a
  // second writer of this column and is exactly where one would come from.
  return tagA !== null && tagA === comparableTag(b) ? "different" : "unknown";
}

// ---------------------------------------------------------------------------
// The shared agreement corpus
// ---------------------------------------------------------------------------

export interface AgreementCase {
  readonly id: string;
  readonly why: string;
  readonly a: { readonly surface: string; readonly declared?: DeclaredObjectType };
  readonly b: { readonly surface: string; readonly declared?: DeclaredObjectType };
  readonly verdict: Agreement;
}

/**
 * Two claims' objects and the verdict a human says they earn.
 *
 * Written as SURFACES and a claim about meaning — never as expected canonical
 * values. Writing the canonical form beside the surface would pin the parser
 * against itself and pass against any implementation, including one that
 * returns its input. Same rule `identity-corpus.ts` states for the slot layer.
 *
 * ANNOTATED rather than `as const satisfies`, unlike `identity-corpus.ts`.
 *
 * `as const` narrows every entry to its own literal shape, so `c.a.declared` is
 * not a property of the union at all once a single entry omits it — and the two
 * consumers read exactly that field. The annotation keeps the checking that
 * matters (a missing field or a misspelled verdict is still a compile error at
 * the entry) and gives up only literal-type narrowing, which nothing here uses.
 */
export const AGREEMENT_CORPUS: readonly AgreementCase[] = [
  {
    id: "money-spelling",
    why: "One price, two idioms. The pinned case from ADR-0037 §2 — under exact string equality the draft supersedes the published fact over a word order.",
    a: { surface: "499 USD" },
    b: { surface: "USD 499" },
    verdict: "same",
  },
  {
    id: "money-precision",
    why: "A warehouse column renders `499.00` and a human types `499`. Same money. A canonicalizer that kept trailing zeros calls these different and stamps `valid_to`.",
    a: { surface: "499.00 USD" },
    b: { surface: "499 usd" },
    verdict: "same",
  },
  {
    id: "money-disagrees",
    why: "#5000's live rows, in the shape that actually contradicts: two prices, same currency, genuinely different. THE positive control for supersession — without a row like this the whole `different` verdict is unexercised and a parser returning null always passes.",
    a: { surface: "499 USD" },
    b: { surface: "599 USD" },
    verdict: "different",
  },
  {
    id: "money-currency-disagrees",
    why: "499 dollars and 499 euros are different prices. The currency is part of the value, not a unit annotation on it — dropping it from the canonical form makes these `same`.",
    a: { surface: "499 USD" },
    b: { surface: "499 EUR" },
    verdict: "different",
  },
  {
    id: "money-symbol",
    why: "⚠️ THE pinned refusal. `$` spans USD/CAD/AUD, so `$499` names no currency and `$499` vs `599 USD` cannot be shown to differ. It abstains into tension, where a human reads both surfaces — instead of into a stamp.",
    a: { surface: "$499" },
    b: { surface: "599 USD" },
    verdict: "unknown",
  },
  {
    id: "cross-type",
    why: "A bare number against declared money. Unequal as strings, and NOT different: nothing proves the bare `499` is not 499 dollars. The row in THIS corpus that reaches the `split_part` tag arm most directly; `date-vs-instant` kills it too, and `identity-corpus.ts`'s `cross-type-rival` kills it at the consumer level.",
    a: { surface: "499" },
    b: { surface: "499", declared: { kind: "money", currency: "USD" } },
    verdict: "unknown",
  },
  {
    id: "declared-rescues",
    why: "The feature's whole reason to exist: a warehouse producer knows its `price` column is USD and the bare number never will. Two declared prices become comparable — and disagree.",
    a: { surface: "499", declared: { kind: "money", currency: "USD" } },
    b: { surface: "599", declared: { kind: "money", currency: "USD" } },
    verdict: "different",
  },
  {
    id: "declaration-contradicted",
    why: "A producer declares USD and the surface says EUR. One of the two is wrong and nothing here knows which, so the pair abstains rather than picking the producer — the coin flip whose losing face is irreversible.",
    a: { surface: "599 EUR", declared: { kind: "money", currency: "USD" } },
    b: { surface: "499 USD" },
    verdict: "unknown",
  },
  {
    id: "entity-surfaces",
    why: "The common case, and the accepted cost: with no entity store `Grace` and `Alan` have no comparable value, so a manager change is tension-only and never supersedes. `passthroughEntityResolver` behaving honestly — it genuinely cannot prove two people are different people.",
    a: { surface: "Grace" },
    b: { surface: "Alan" },
    verdict: "unknown",
  },
  {
    id: "instant-zones",
    why: "One instant, two zone spellings. Without the UTC canonicalization publish stamps `valid_to` over a time-zone conversion.",
    a: { surface: "2026-08-04T10:00:00+02:00" },
    b: { surface: "2026-08-04T08:00:00Z" },
    verdict: "same",
  },
  {
    id: "date-vs-instant",
    why: "A DAY and a POINT are not the same kind of thing, so they get separate tags and abstain rather than reading as different. `date` and `time` sharing a tag would make a daily-granularity producer supersede an instant-granularity one on every observation.",
    a: { surface: "2026-08-04" },
    b: { surface: "2026-08-04T00:00:00Z" },
    verdict: "unknown",
  },
  {
    id: "sign-flip",
    why:
      "⚠️ The pair where `same` and `different` would BOTH hold under ADR-0037 §2's rule as " +
      "written. `lexicalNorm` strips a leading `-`, so these two surfaces key IDENTICALLY " +
      "(`499`) while their comparable values prove they disagree — and the key arm of " +
      "corroboration would fire `same`, merging a margin with its own negation and never " +
      "minting a row for the second claim. At the VALUE level, which is all `agree` sees, " +
      "the verdict is plainly `different`; the disjointness suite is what checks the veto " +
      "keeps it that way once the KEY arm is in play.",
    a: { surface: "-499" },
    b: { surface: "499" },
    verdict: "different",
  },
  {
    id: "bool-disagrees",
    why: "The smallest possible `different`. Present because the money rows are the only other ones, and a tag arm that special-cased money would pass without it.",
    a: { surface: "true" },
    b: { surface: "FALSE" },
    verdict: "different",
  },
];


// ---------------------------------------------------------------------------
// The disagreement census (#5318)
// ---------------------------------------------------------------------------

/**
 * How a pair's two object surfaces came to share a slot key.
 *
 * Recorded because it is the half of the census that is NOT a property of
 * `object_cmp`: the disagreement needs key equality AND a proof of difference,
 * and the three routes to key equality reach different populations. Byte
 * equality is the one every reader assumes; the fold is the one `-499` / `499`
 * arrives by; the alias is the one a HUMAN opened, and it is the only route that
 * can put two surfaces with nothing in common into one slot.
 */
export type KeyRoute = "byte-identical" | "lexical-fold" | "approved-alias";

/**
 * Why a pair sits in the disagreement region — the property that makes the two
 * predicates read it differently.
 *
 * Two, and the census asserts there are no others (see
 * `object-cmp-disagreement-census.test.ts`). They are the only two ways a pair
 * can carry both key equality and a proof of difference, because they are the
 * only two ways the comparable can know something the key does not:
 *
 *   - `id-behind-a-shared-name` — the comparable is an `entity:` id and the key
 *     is the NAME. The store can distinguish two rows a name cannot.
 *   - `sign-the-key-discards` — `lexicalNorm` collapses `[ \t\n\v\f\r_-]+`, so a
 *     leading `-` is not in the key while the comparable parser keeps it.
 *
 * Measured rather than reasoned: the probe that produced this census also ran
 * `_` runs, whitespace runs, the ASCII case fold, `-0` / `0`, interior and
 * trailing `-`, and separator-substituted dates and instants. Every one of them
 * is `same` or `unknown`, never `different` — a discarded character that is not
 * a leading sign either leaves the comparable equal or stops it parsing at all.
 */
export type DisagreementMechanism = "id-behind-a-shared-name" | "sign-the-key-discards";

export interface DisagreementCase {
  readonly id: string;
  readonly a: {
    readonly surface: string;
    readonly declared?: DeclaredObjectType;
    readonly entityId?: string;
  };
  readonly b: {
    readonly surface: string;
    readonly declared?: DeclaredObjectType;
    readonly entityId?: string;
  };
  /** How the two surfaces reached one slot key. */
  readonly keyRoute: KeyRoute;
  /** What makes the comparable able to prove a difference the key cannot see. */
  readonly mechanism: DisagreementMechanism;
  /**
   * Whether SUPERSEDING is the outcome this pair should get.
   *
   * ⚠️ NOT "whether the disagreement is a bug". Every row here disagrees; the
   * question the census answers is what the disagreement should COST. `true`
   * means the publish gate stamping `valid_to` is right about this pair.
   */
  readonly intendedToSupersede: boolean;
  readonly why: string;
  /** Set on, and only on, the rows where {@link intendedToSupersede} is false. */
  readonly remedy?: string;
}

/**
 * Every pair shape where the sameness evidence and `comparableDifferentSql`
 * disagree (#5318).
 *
 * ## What "disagree" means here, precisely
 *
 * NOT "both predicates return true" — `objectSameSql` cannot, because it carries
 * the difference VETO and resolves to FALSE on every row below. The
 * disagreement is one conjunct in: `objectSameSql`'s SAMENESS EVIDENCE
 * (`object_key` equal **or** both comparables non-null and equal) fires, and
 * `comparableDifferentSql` fires too. `supersessionCollisionJoin` consults only
 * the second, so these pairs supersede.
 *
 * That distinction is why nobody had written this set down. The veto makes the
 * overlap invisible to any test that asks the two shipped predicates whether
 * they agree — `object-cmp-pg.test.ts`'s disjointness block asks exactly that,
 * correctly, and is green on every row here.
 *
 * ⚠️ **The second disjunct of the sameness evidence can never contribute.** It
 * is `a = b` and the difference arm opens with `a <> b`, so a pair satisfying
 * both would need one comparison to be true and its negation with it. Every
 * disagreement therefore enters through the `object_key` arm, which is what
 * makes {@link KeyRoute} a field rather than a footnote — and the census test
 * asserts it rather than assuming it, because a future arm added to
 * `comparableSameSql` would silently reopen that door.
 *
 * ## Why this is a census and NOT a prohibition
 *
 * ⚠️ The test *"no pair is both same and different"* is FALSE BY DESIGN and must
 * never be written here. `entity-homonym` below is two different companies both
 * surfaced as `Acme Corp` and a person moving between them: the sameness
 * evidence is right (it is the same name) and the difference proof is right (it
 * is not the same company), and superseding is the CORRECT outcome. A
 * prohibition would fail on that row immediately — and the repair someone would
 * reach for is weakening the homonym handling, which trades a visible failure
 * for the silent merge `objectSameSql`'s veto exists to prevent.
 *
 * So the assertion is a pin over the classified set. A new shape arriving here
 * has to be given an {@link intendedToSupersede} verdict and a reason by a
 * person, in the same commit — instead of being discovered by a prod incident,
 * which is how `entity-remint` was found.
 *
 * ## What the census cannot do
 *
 * `entity-homonym` and `entity-remint` are the SAME SHAPE at the SQL level: two
 * `entity:`-tagged comparables, same tag, unequal, over one key. Nothing in the
 * two predicates can tell them apart, and no arm added to either could — the
 * information that separates them (did the store re-mint an id for a row that
 * did not change?) is not in the columns. That is the finding, not a gap in this
 * file: the remedy has to live where the ids are minted, which is what #5233's
 * remaining tickets are about.
 */
export const DISAGREEMENT_CENSUS: readonly DisagreementCase[] = [
  {
    id: "entity-homonym",
    a: { surface: "Acme Corp", entityId: `wh_${"a".repeat(64)}` },
    b: { surface: "Acme Corp", entityId: `wh_${"b".repeat(64)}` },
    keyRoute: "byte-identical",
    mechanism: "id-behind-a-shared-name",
    intendedToSupersede: true,
    why:
      "⚠️ THE ROW THAT MAKES A PROHIBITION WRONG. Two different companies both surfaced as " +
      "`Acme Corp`, and someone who moved between them. Both readings are correct — it IS the " +
      "same name, and it is NOT the same company — and retiring the old employer is what the " +
      "store's whole reason for existing buys: without an entity id this pair is `unknown` and " +
      "a manager change is tension-only forever (`entity-surfaces` in the agreement corpus). " +
      "Asserting that no pair is both would fail here, and the repair would be to blind the " +
      "resolver, which is strictly worse than the disagreement.",
  },
  {
    id: "entity-remint",
    a: { surface: "Acme Corp", entityId: `wh_${"c".repeat(64)}` },
    b: { surface: "Acme Corp", entityId: `wh_${"d".repeat(64)}` },
    keyRoute: "byte-identical",
    mechanism: "id-behind-a-shared-name",
    intendedToSupersede: false,
    why:
      "⚠️ NOT INTENDED, and byte-for-byte indistinguishable from `entity-homonym` above — same " +
      "surface, same tag, two ids. Here the two ids name ONE warehouse row whose id was " +
      "re-minted between the two claims, so a fact is retired by a fact asserting the identical " +
      "thing. PR 5315 measured the stamp at the join with the id as the only moving variable. " +
      "`warehouseRowId` digests `(workspace, entity, primary key)`, so the entity component " +
      "alone moving is enough: a region-migration bridge window, or a semantic-layer rename " +
      "inside one region.",
    remedy:
      "#5233 — the fix is where ids are minted (retire the superseded comparable, or make a " +
      "re-minted id recognisable), NOT in these two predicates: the columns do not carry what " +
      "separates this row from the one above it.",
  },
  {
    id: "entity-alias-merged-names",
    a: { surface: "Acme", entityId: `wh_${"e".repeat(64)}` },
    b: { surface: "Acme Corp", entityId: `wh_${"f".repeat(64)}` },
    keyRoute: "approved-alias",
    mechanism: "id-behind-a-shared-name",
    intendedToSupersede: true,
    why:
      "The alias route, and the only one that can put two surfaces with nothing lexical in " +
      "common into one slot. `Acme` and `Acme Corp` do not fold together — a human approved an " +
      "edge saying they name one thing. Present because it reaches a population the fold cannot: " +
      "every pair of names a reviewer has ever merged is now a candidate for this region. The " +
      "verdict is `entity-homonym`'s and for the same reason — the reviewer asserted the names " +
      "are one, the store proved the ROWS are two, and the second beats the first.",
  },
  {
    id: "sign-flip",
    a: { surface: "-499" },
    b: { surface: "499" },
    keyRoute: "lexical-fold",
    mechanism: "sign-the-key-discards",
    intendedToSupersede: true,
    why:
      "The case `objectSameSql`'s veto was written for. `lexicalNorm` collapses `-` as a " +
      "separator, so both surfaces key `499` while the comparables prove they disagree. Without " +
      "the veto the key arm fires `same`, corroboration merges a margin with its own negation, " +
      "and the second claim never gets a row at all — T2's silent merge. Superseding is right: " +
      "the two ARE different numbers, and a signed number is exactly what a warehouse producer " +
      "emits for a margin or a delta.",
  },
  {
    id: "sign-flip-money",
    a: { surface: "-499 USD" },
    b: { surface: "499 USD" },
    keyRoute: "lexical-fold",
    mechanism: "sign-the-key-discards",
    intendedToSupersede: true,
    why:
      "`sign-flip` one tag over, and NOT a duplicate of it: the money parser carries the sign " +
      "through a currency canonicalization the bare-number parser never runs, so a fix that " +
      "dropped the sign in one would leave the other green. A refund and a charge.",
  },
  {
    id: "sign-flip-declared",
    a: { surface: "-499", declared: { kind: "money", currency: "USD" } },
    b: { surface: "499", declared: { kind: "money", currency: "USD" } },
    keyRoute: "lexical-fold",
    mechanism: "sign-the-key-discards",
    intendedToSupersede: true,
    why:
      "The DECLARED arm — a producer that knows its column is USD, over surfaces that carry no " +
      "currency of their own. Present because the declaration is applied on a path of its own " +
      "(`applyDeclaration`, not `parseSurface`), so it is the arm through which the feature " +
      "designed to CREATE comparability puts new pairs into this region. Nothing about the " +
      "verdict changes: they are still 499 dollars apart.",
  },
];
