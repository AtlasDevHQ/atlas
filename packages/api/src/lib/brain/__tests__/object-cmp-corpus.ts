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
 * ⚠️ This is a SECOND implementation of what {@link comparableSameSql} and
 * {@link comparableDifferentSql} express in SQL, and a second implementation is
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
 */
/**
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
    why: "A bare number against declared money. Unequal as strings, and NOT different: nothing proves the bare `499` is not 499 dollars. The only row in the repo that kills the `split_part` tag arm.",
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

