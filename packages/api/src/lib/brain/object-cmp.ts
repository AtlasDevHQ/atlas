/**
 * The comparable value — `brain_facts.object_cmp` (#5030, ADR-0037 §2).
 *
 * The slot keys prove SAMENESS. This module owns the column that can prove
 * DIFFERENCE, and it is a separate column rather than a second reading of
 * `object_key` because *same* and *different* are not complements:
 *
 * | Column | Null | Proves |
 * |---|---|---|
 * | `object_key` | no | *sameness* — `alias(lexicalNorm(surface))` |
 * | `object_cmp` | **yes** | *difference* — a typed canonical value, parsed fail-closed |
 *
 * - **same** — `object_key` equal, **or** both `object_cmp` non-null, same tag, equal
 * - **different** — both `object_cmp` non-null, same tag, unequal
 * - **unknown** — everything else → **tension only, never a stamp**
 *
 * A single nullable column compared two ways fails quietly in BOTH directions
 * (T3 §4): made total, `$499` vs `499 USD` reads *different* and publish stamps
 * `valid_to` on a belief nobody arbitrated; made the only column, `Business
 * tier` vs `Business tier` reads *unknown* and corroboration stops firing on
 * exact repeats. Two columns is what lets each answer the question it can.
 *
 * ## The parser is COWARDLY, and that is the property it needs to have
 *
 * A type qualifies only if its parse is unambiguous AND its equality decidable.
 * Everything else is `null` — which is not a degraded answer, it is the honest
 * one: `null` means *unknown*, and unknown falls to tension, where a human sees
 * it. The failure directions are not symmetric and the whole module is shaped by
 * that. Refusing to parse costs a missed supersession — recoverable, a reviewer
 * arbitrates by hand. Parsing wrongly costs a `valid_to` stamp, and there is no
 * un-supersede verb anywhere in the product (`correction.ts` — both vouching
 * verbs REFUSE a target whose window has closed).
 *
 * So every judgement call in here resolves toward `null`, and the tests that
 * matter are the ones asserting it does NOT parse something.
 *
 * ⚠️ **No currency symbol is ever accepted.** Bare `$499` is `null` — `$` spans
 * USD/CAD/AUD/NZD and a dozen more. `€` and `£` are refused on the same terms
 * even though they look unambiguous today: a symbol allowlist is a maintenance
 * surface where one wrong entry buys an irreversible stamp, and the direction
 * that costs nothing is refusing the lot. An explicit ISO-4217 alphabetic code
 * is the only thing that names a currency here.
 *
 * ## The tag is load-bearing, and #5035 depends on it
 *
 * A value is stored as `<tag>:<canonical>` in ONE column. The tag is not
 * decoration:
 *
 *   1. **It gates the difference arm.** `number:499` and `money:USD:499` are
 *      unequal strings, and a bare `<>` would call them *different* — but
 *      nothing proves the bare `499` is not 499 dollars. Cross-tag pairs are
 *      `unknown`, which is why {@link comparableDifferentSql} compares tags as
 *      well as values. This pair is reachable the moment a warehouse producer
 *      declares `price` is USD money and the extractor reads a bare number off
 *      the same slot.
 *   2. **It is #5035's discriminator.** A region import must null every
 *      store-local id and carry every value-typed canonical verbatim, and
 *      *"null wherever it holds a store-local id"* is unimplementable without a
 *      tag to test. Guessing wrong in the carry direction reintroduces the
 *      counterfeit-difference stamp that issue exists to prevent. So the tag
 *      vocabulary below is a CONTRACT, not an implementation detail — renaming
 *      {@link ENTITY_TAG} is a cross-issue change.
 *
 * Equality is plain string equality over the whole tagged value, so the SQL
 * needs no parsing: `=` and `<>` do the work, and a mismatched tag is caught by
 * the separate `split_part` arm rather than by decoding the payload.
 *
 * ## What this module is NOT
 *
 * Not a normalizer of surfaces — that is `identity.ts`'s `lexicalNorm`, which is
 * a different function with a different job (it is TOTAL; this one abstains).
 * Not a matching rule either: a producer may DECLARE what its object is
 * ({@link DeclaredObjectType}), on `predicate_cardinality`'s precedent, and a
 * declaration only ever supplies information the surface lacks. It can never
 * make two surfaces compare equal that would not have.
 */

/**
 * The tag vocabulary — the closed set of things whose equality is decidable.
 *
 * An array rather than a bare union so a new type is a compile error in every
 * `Record<ComparableTag, …>` below, and so the SQL-side arms have one list to
 * read. Adding an arm here is a claim that two canonical values of that type can
 * be compared for equality with `=` and never be wrong.
 */
export const COMPARABLE_TAGS = [
  /** Money WITH an explicit ISO-4217 code. `money:USD:499` — never a symbol. */
  "money",
  /** A plain, unit-less decimal. `number:499`. */
  "number",
  /** A calendar date, no time zone in play. `date:2026-08-04`. */
  "date",
  /** An instant with an explicit offset, canonicalized to UTC. `time:2026-08-04T08:00:00.000Z`. */
  "time",
  /** `bool:true` / `bool:false`. */
  "bool",
  /**
   * A resolved entity id, supplied by the entity store and NEVER parsed from a
   * surface. `entity:01J…`.
   *
   * This is the tag #5035 keys its null-at-import rule on: an id minted in one
   * region is non-null and, by construction, unequal to every id the
   * destination mints for the SAME real entity — counterfeit positive evidence
   * of difference, which is strictly worse than the NULL it replaces.
   */
  "entity",
] as const;

export type ComparableTag = (typeof COMPARABLE_TAGS)[number];

/** {@link COMPARABLE_TAGS}'s entity arm, named once so #5035 imports it rather than a literal. */
export const ENTITY_TAG = "entity" satisfies ComparableTag;

/** The tag/payload separator. One character, and payloads may contain it — see {@link comparableTag}. */
export const TAG_SEPARATOR = ":";

/**
 * What a producer may say about its own object, on `predicate_cardinality`'s
 * precedent (`extract.ts` — a producer-declared property of the claim with a
 * conservative default, not a matching rule).
 *
 * The default is ABSENCE, which is the conservative one: with no declaration the
 * surface is parsed on its own terms and anything ambiguous is `null`. A
 * warehouse producer knows `price` is USD money and says so; the extractor
 * guesses and therefore declares nothing.
 *
 * `entity` is deliberately NOT declarable. An entity id comes from the store, so
 * letting a producer assert one would let it mint identity for a slot it does
 * not own — and the store is the thing the brain trusts here, not the caller.
 *
 * A discriminated union rather than a bare tag string because `money` is the one
 * type whose declaration carries a payload: declaring "this is money" without
 * saying which currency rescues nothing, since the ambiguity was never about
 * whether `$499` is money.
 */
export type DeclaredObjectType =
  | { readonly kind: "money"; readonly currency: string }
  | { readonly kind: "number" }
  | { readonly kind: "date" }
  | { readonly kind: "time" }
  | { readonly kind: "bool" };

/** A parsed, tagged, canonical value — or `null`, meaning *unknown*. */
export type ComparableValue = string | null;

// ---------------------------------------------------------------------------
// The grammars. Every one is anchored, and that is not a style choice
// ---------------------------------------------------------------------------
//
// An unanchored pattern would let `about 499 or so` parse as `number:499`,
// which is a claim the surface does not make. Anchoring is what turns each of
// these from "contains a number" into "IS a number".

/**
 * A decimal. No exponent, no thousands separator, no leading `+`.
 *
 * `,` is REFUSED outright rather than treated as a thousands separator: it is
 * the DECIMAL separator across most of Europe, so `1,499` is either one
 * thousand four hundred ninety-nine or one and a bit, and picking either is a
 * guess about locale that lands in a column whose whole job is to be certain.
 *
 * Exponent notation (`1e3`) is refused for the canonicalization reason rather
 * than an ambiguity one — `1e3` and `1000` are the same number and would have
 * to canonicalize together, and a parser that expands exponents is a parser
 * with float rounding in it. Refusing costs a missed supersession on a surface
 * no producer in this repo emits.
 */
const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;

/** ISO-4217 alphabetic. Three letters, and the ONLY way to name a currency here. */
const CURRENCY_RE = /^[A-Za-z]{3}$/;

/** `499 USD` or `USD 499`. Exactly two whitespace-separated tokens, either order. */
const MONEY_RE = /^(\S+)\s+(\S+)$/;

/** A calendar date. Strict `YYYY-MM-DD` — `08/04/2026` is D/M or M/D and is refused. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An instant, with an EXPLICIT zone. `Z` or `±HH:MM`.
 *
 * A zone-less `2026-08-04T10:00` names no instant — it is a different moment in
 * every deployment region — so it cannot be compared for equality and is
 * refused. That refusal is also what keeps this grammar disjoint from
 * {@link DATE_RE}: a bare date is a DAY and an instant is a POINT, they are not
 * the same kind of thing, and giving them separate tags is what stops
 * `2026-08-04` and `2026-08-04T00:00:00Z` reading as *different*.
 */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// The canonicalizers
// ---------------------------------------------------------------------------

/**
 * `499.00` → `499`, `-0` → `0`, `499.50` → `499.5`.
 *
 * Canonicalized as TEXT, never through `Number`: `parseFloat` round-trips
 * large integers wrong (`9007199254740993` comes back as `…92`), and a value
 * that silently changes on the way into the column is a value two producers
 * can disagree about while both being "correct".
 */
function canonicalDecimal(raw: string): string | null {
  if (!DECIMAL_RE.test(raw)) return null;
  const negative = raw.startsWith("-");
  const [whole = "", fraction = ""] = (negative ? raw.slice(1) : raw).split(".");
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const magnitude = trimmedFraction === "" ? trimmedWhole : `${trimmedWhole}.${trimmedFraction}`;
  // `-0` and `0` are one number and must be one string. Reached by `-0`,
  // `-0.0` and `-0.000` alike, which is why the test is on the CANONICAL
  // magnitude rather than on the raw input.
  if (magnitude === "0") return "0";
  return negative ? `-${magnitude}` : magnitude;
}

/**
 * A calendar date, round-tripped so `2026-02-31` is refused.
 *
 * The regex proves the SHAPE and nothing else — month 13 and February 31 both
 * match it. `Date.UTC` normalizes rather than rejecting (it rolls February 31
 * forward to March 3), so the check is that the constructed date reports back
 * the same three fields it was given. Silently accepting a rolled date would
 * make `2026-02-31` and `2026-03-03` compare EQUAL.
 */
function canonicalDate(raw: string): string | null {
  const match = DATE_RE.exec(raw);
  if (match === null) return null;
  const [, year = "", month = "", day = ""] = match;
  const stamp = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(stamp.getTime())) return null;
  if (
    stamp.getUTCFullYear() !== Number(year) ||
    stamp.getUTCMonth() !== Number(month) - 1 ||
    stamp.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

/**
 * An instant, canonicalized to UTC, so `2026-08-04T10:00:00+02:00` and
 * `2026-08-04T08:00:00Z` are the same value — which they are.
 *
 * That equality is the entire reason the `time` tag exists. Two producers
 * reading one timestamp out of two systems will spell its zone differently, and
 * without the normalization they would read as *different* and publish would
 * stamp `valid_to` over a time-zone conversion.
 */
function canonicalInstant(raw: string): string | null {
  if (!INSTANT_RE.test(raw)) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * `true` / `false`, case-insensitively, and nothing else.
 *
 * `yes`/`no`/`y`/`n`/`1`/`0` are refused. Each is a guess about what the
 * producer's vocabulary means — `1` in particular is a perfectly good NUMBER,
 * and admitting it here would make one surface parse two ways depending on
 * which arm ran first.
 */
function canonicalBool(raw: string): string | null {
  const folded = raw.toLowerCase();
  return folded === "true" || folded === "false" ? folded : null;
}

/** A currency code, upper-cased so `usd` and `USD` are one currency. */
function canonicalCurrency(raw: string): string | null {
  return CURRENCY_RE.test(raw) ? raw.toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** `<tag>:<payload>`, the one place the wire format is written. */
function tagged(tag: ComparableTag, payload: string): string {
  return `${tag}${TAG_SEPARATOR}${payload}`;
}

/**
 * What a surface says about itself, before any declaration is consulted.
 *
 * Returns the tag AND the parts, because the money arm needs the currency and
 * the amount separately: a declaration may supply a currency the surface lacks,
 * but it may never CONTRADICT one the surface states.
 */
interface SurfaceParse {
  readonly tag: ComparableTag;
  readonly payload: string;
  /** Set only on the `money` arm, and only when the SURFACE named the currency. */
  readonly currency?: string;
}

/**
 * Read a surface on its own terms.
 *
 * The arms are tried in an order that cannot matter, because the grammars are
 * disjoint by construction — a decimal has no letters, a bool has no digits, a
 * date has dashes in positions a decimal cannot, and the money form is the only
 * two-token shape. Stated rather than relied on silently: an arm added later
 * that overlaps an existing one makes this function order-dependent, which is
 * how one surface starts parsing two ways.
 */
function parseSurface(surface: string): SurfaceParse | null {
  const trimmed = surface.trim();
  if (trimmed === "") return null;

  const bool = canonicalBool(trimmed);
  if (bool !== null) return { tag: "bool", payload: bool };

  const date = canonicalDate(trimmed);
  if (date !== null) return { tag: "date", payload: date };

  const instant = canonicalInstant(trimmed);
  if (instant !== null) return { tag: "time", payload: instant };

  const decimal = canonicalDecimal(trimmed);
  if (decimal !== null) return { tag: "number", payload: decimal };

  const money = MONEY_RE.exec(trimmed);
  if (money !== null) {
    const [, left = "", right = ""] = money;
    // Either order — `499 USD` and `USD 499` are both idiomatic and both
    // unambiguous. Both tokens parsing as the same kind is impossible (a
    // three-letter code is not a decimal), so there is nothing to disambiguate.
    const amount = canonicalDecimal(left) ?? canonicalDecimal(right);
    const currency = canonicalCurrency(left) ?? canonicalCurrency(right);
    if (amount !== null && currency !== null) {
      return { tag: "money", payload: `${currency}${TAG_SEPARATOR}${amount}`, currency };
    }
  }

  // Everything else — an entity surface, a sentence, `$499`, `1,499 USD`,
  // `499 dollars`. Unknown, and it stays unknown until something that actually
  // knows (the entity store, a producer declaration) says otherwise.
  return null;
}

/**
 * The comparable value for one claim's object, or `null` for *unknown*.
 *
 * Three inputs, in strict precedence:
 *
 *   1. **`entityId`** — the entity store resolved the object. The strongest
 *      evidence available and it wins outright: a store id compares two
 *      surfaces the parser cannot see are the same thing (`Enterprise tier` /
 *      `Enterprise Plan`), which is the case the store exists for.
 *   2. **the surface**, parsed on its own terms.
 *   3. **`declared`** — a producer's claim about its own object, which may only
 *      supply what the surface LACKS.
 *
 * ## A declaration narrows; it never overrides
 *
 * Every disagreement between a declaration and the surface resolves to `null`,
 * because a disagreement means one of the two is wrong and nothing here knows
 * which. Concretely:
 *
 *   - declared `money`+`USD`, surface `499` → `money:USD:499`. The declaration
 *     supplied the currency the surface lacked. **This is the case the feature
 *     exists for** — a warehouse producer reading a `price` column knows what
 *     the number means and the number itself never will.
 *   - declared `money`+`USD`, surface `599 EUR` → `null`. The surface named a
 *     DIFFERENT currency. Trusting either side over the other is a coin flip
 *     whose losing face is an irreversible stamp.
 *   - declared `number`, surface `499 USD` → `null`. Same shape, inverted: the
 *     surface says money and the producer says plain number.
 *   - declared `money`+`USD`, surface `Enterprise tier` → `null`. A declaration
 *     is not a parser, and it cannot make an unparseable surface parse.
 *   - declared nothing, surface `$499` → `null`. The pinned case (ADR-0037 §2):
 *     `$` names no currency, and there is no declaration to supply one.
 */
export function comparableValue(input: {
  readonly surface: string;
  readonly declared?: DeclaredObjectType | undefined;
  readonly entityId?: string | undefined;
}): ComparableValue {
  const { surface, declared, entityId } = input;

  if (entityId !== undefined && entityId.trim() !== "") {
    return tagged(ENTITY_TAG, entityId.trim());
  }

  const parsed = parseSurface(surface);
  if (declared === undefined) return parsed === null ? null : tagged(parsed.tag, parsed.payload);

  return applyDeclaration(surface, parsed, declared);
}

/**
 * The declaration arms, one per declarable kind.
 *
 * An exhaustive switch with a throwing `default`, matching the house shape at
 * `supersedeStampSql`: a sixth declarable kind must be given a rule here rather
 * than silently inheriting whichever arm happened to be last.
 */
function applyDeclaration(
  surface: string,
  parsed: SurfaceParse | null,
  declared: DeclaredObjectType,
): ComparableValue {
  switch (declared.kind) {
    case "money": {
      const currency = canonicalCurrency(declared.currency);
      // A declaration naming a currency this module cannot canonicalize
      // (`US Dollars`, `""`) is a broken producer, not a licence to guess —
      // and `null` is what every other unresolvable input here returns.
      if (currency === null) return null;
      // The surface already IS money: the declaration may confirm it and
      // nothing more. A mismatch means the two disagree about the claim.
      if (parsed?.tag === "money") {
        return parsed.currency === currency ? tagged("money", parsed.payload) : null;
      }
      // The surface is a bare number and the declaration says what it means.
      if (parsed?.tag === "number") {
        return tagged("money", `${currency}${TAG_SEPARATOR}${parsed.payload}`);
      }
      // Unparseable, or parseable as something else entirely (`true`,
      // `2026-08-04`). Either way the declaration cannot rescue it.
      return null;
    }
    case "number":
    case "date":
    case "time":
    case "bool":
      // These four carry no payload, so a declaration can only ever CONFIRM
      // what the surface already said. It exists so a producer can refuse a
      // coincidence — declaring `number` over a slot whose surfaces are
      // sometimes dates makes the date parse `null` instead of a `date:` value
      // nothing else in that slot will ever compare against.
      return parsed !== null && parsed.tag === declared.kind
        ? tagged(parsed.tag, parsed.payload)
        : null;
    default: {
      // Throws rather than returning the value. The alternative spelling
      // returns the argument itself, and here that argument would be splayed
      // into a stored identity — an unvalidated object reaching a column whose
      // comparisons stamp `valid_to`.
      const exhaustive: never = declared;
      throw new Error(
        `comparableValue: unhandled declared object type ${JSON.stringify(exhaustive)} for surface ${JSON.stringify(surface)}`,
      );
    }
  }
}

/**
 * The tag of a stored value, or `null` if it carries none.
 *
 * `split` on the FIRST separator only, because payloads contain them: an
 * instant is `time:2026-08-04T08:00:00.000Z` and money is `money:USD:499`.
 * The SQL twin below is `split_part(…, ':', 1)`, which has the same behaviour
 * for the same reason.
 */
export function comparableTag(value: string): ComparableTag | null {
  const boundary = value.indexOf(TAG_SEPARATOR);
  // An explicit `-1` arm, not `slice(0, -1)`. Without it a separator-less value
  // is read as its own first n-1 characters, so `moneys` reports the tag
  // `money` — a mis-tag that would let the difference arm compare two values
  // that share no type. Nothing this module PRODUCES lacks a separator, which
  // is exactly why the arm has to be here rather than assumed away.
  if (boundary === -1) return null;
  const head = value.slice(0, boundary);
  return (COMPARABLE_TAGS as readonly string[]).includes(head) ? (head as ComparableTag) : null;
}

// ---------------------------------------------------------------------------
// The SQL arms — written ONCE, on `supersessionCollisionPredicate`'s precedent
// ---------------------------------------------------------------------------

/**
 * *Provably different*: both sides non-null, the SAME TAG, and unequal.
 *
 * A builder rather than a constant because the two consumers spell their
 * operands differently — the publish gate joins column to column
 * (`p.object_cmp` / `d.object_cmp`) and the reconcile stage compares a column
 * to a bind (`object_cmp` / `$5`) — and there must be exactly one place the
 * arms are written. Same argument, verbatim, as
 * `supersessionCollisionPredicate`: two spellings of "what differs" is a
 * disclosure that lists one set while the transaction stamps another.
 *
 * ## Why the tag arm is not redundant
 *
 * `<>` alone would call `number:499` and `money:USD:499` different, and they
 * are not: nothing proves the bare `499` is not 499 dollars. Cross-tag is
 * *unknown*, and unknown must never reach the stamp. The pair is reachable as
 * soon as one producer declares a slot's type and another does not — which is
 * the whole point of {@link DeclaredObjectType} — so this is a live case, not a
 * theoretical one.
 *
 * `split_part(v, ':', 1)` takes the FIRST field only, so a payload containing
 * `:` (every `time:` value, every `money:` value) is unaffected. It agrees with
 * {@link comparableTag} on bytes rather than on a shared parser, which is the
 * same two-implementations-must-agree shape migration 0187 records for
 * `lexicalNorm` — and `object-cmp-pg.test.ts` compares them row by row for the
 * same reason.
 *
 * NULL on either side makes every arm unknown, so the whole predicate is
 * not-true and the pair is excluded. That is fail-closed and it is the
 * direction this arm must fail in: no proof of difference means no `valid_to`
 * stamp, which is the recoverable outcome.
 *
 * PARENTHESIZED. The arms are all `AND` so the group is redundant today — it is
 * here because callers splice this into `AND` chains that already contain `OR`
 * groups, and `AND` binds tighter. Migration 0187's `WHERE` clause carries the
 * same parenthesization for the same reason, and its header records that the
 * unparenthesized shape passed every assertion in the suite.
 *
 * `a` / `b` are interpolated; callers pass column expressions or bind
 * placeholders they control — same contract as `supersessionCollisionPredicate`
 * and `brainFactStatusClause`.
 */
export function comparableDifferentSql(a: string, b: string): string {
  return `(${a} <> ${b}
      AND split_part(${a}, '${TAG_SEPARATOR}', 1) = split_part(${b}, '${TAG_SEPARATOR}', 1))`;
}

/**
 * *Provably the same*: both sides non-null and equal.
 *
 * No tag arm, and its absence is load-bearing rather than an oversight — two
 * values that are equal as strings already share a tag, since the tag is a
 * prefix of the string. Adding `split_part(…) = split_part(…)` here would be a
 * tautology, and a tautology beside a load-bearing arm in
 * {@link comparableDifferentSql} is exactly the kind of symmetry a later reader
 * "restores" in the wrong direction.
 *
 * NULL on either side is unknown, so this is not-true and the pair is excluded —
 * which is why *sameness* still needs the `object_key` arm beside it (T3 §4:
 * made the only test, byte-identical `Business tier` on both sides would stop
 * corroborating the moment it was unresolvable as an entity).
 */
export function comparableSameSql(a: string, b: string): string {
  return `${a} = ${b}`;
}
