/**
 * The comparable value — `brain_facts.object_cmp` (#5030, ADR-0037 §2).
 *
 * The slot keys prove SAMENESS. This module owns the column that can prove
 * DIFFERENCE, and it is a separate column rather than a second reading of
 * `object_key` because *same* and *different* are not complements:
 *
 * | Column | Null | Proves |
 * |---|---|---|
 * | `object_key` | *aspirationally no* | *sameness* — `alias(lexicalNorm(surface))` |
 * | `object_cmp` | **yes, permanently** | *difference* — a typed canonical value, parsed fail-closed |
 *
 * - **same** — (`object_key` equal **or** both `object_cmp` non-null and equal)
 *   **and not provably different** — see {@link objectSameSql} for the veto
 * - **different** — both `object_cmp` non-null, same tag, unequal
 * - **unknown** — everything else → **tension only, never a stamp**
 *
 * ⚠️ Three corrections to the table ADR-0037 §2 states, all of which matter to
 * anyone reading the arms below. First, `object_key` is **nullable on disk** —
 * 0187 landed all three keys nullable and `SET NOT NULL` still has unmet
 * prerequisites (#5035, #5047), while a surface that norms away is permanently
 * NULL by design. Every consumer's NULL handling depends on that, so reading
 * `object_key = $4` as total is exactly wrong. Second, the `same` rule carries
 * no tag clause: equal strings already share a tag, since the tag is a prefix,
 * and stating the tautology invites someone to "restore symmetry" by adding a
 * real tag arm to {@link comparableSameSql}, where it does not belong. Third,
 * and load-bearing: `same` carries a VETO. The two are not disjoint without it —
 * `lexicalNorm` strips a leading `-`, so `-499` and `499` key identically while
 * their comparable values prove they disagree, and the key arm alone merges a
 * margin with its own negation. {@link objectSameSql} is where that lives.
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
 * An array rather than a bare union so the SQL-side membership arm
 * ({@link KNOWN_TAGS_SQL}) and the test enumeration are GENERATED from it rather
 * than re-spelled — one list, not three. (There is no `Record<ComparableTag, …>`
 * in the tree; an earlier version of this comment claimed one as the reason and
 * it was never true.) Adding an arm here is a claim that two canonical values of that type can
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

/**
 * The tag vocabulary as a SQL `IN` list, generated from {@link COMPARABLE_TAGS}
 * so a new tag is still declared in exactly one place.
 *
 * Safe to interpolate: every member is a literal in that array, not input.
 */
const KNOWN_TAGS_SQL = COMPARABLE_TAGS.map((tag) => `'${tag}'`).join(", ");

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
export type DeclarableTag = Exclude<ComparableTag, typeof ENTITY_TAG>;

export type DeclaredObjectType =
  | { readonly kind: "money"; readonly currency: string }
  | { readonly kind: Exclude<DeclarableTag, "money"> };

/**
 * A tagged canonical value — `<tag>:<payload>`, with `tag` from
 * {@link COMPARABLE_TAGS}.
 *
 * A template-literal type rather than a bare `string`, and it costs nothing at
 * runtime. `PreparedCandidate` in `reconcile.ts` carries this beside
 * `object: string` and spreads both into `unknown[]` bind arrays, so
 * `agreementBinds(keys, item.object)` would type-check perfectly and bind a raw
 * SURFACE into a column whose comparisons stamp `valid_to`. Under this type it
 * does not compile.
 *
 * It does NOT stop a hand-written `"money:garbage"` literal. That would need a
 * brand plus a `parseStoredComparable` entry point for values read back OUT of
 * the column — which #5035 will need anyway, and is the right time to add it.
 * The template literal is the part that is free today.
 */
export type TaggedComparable = `${ComparableTag}${typeof TAG_SEPARATOR}${string}`;

/** A parsed, tagged, canonical value — or `null`, meaning *unknown*. */
export type ComparableValue = TaggedComparable | null;

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

/**
 * ISO-4217 alphabetic codes — a SET, not a shape test, and the distinction is
 * the whole safety argument.
 *
 * `/^[A-Za-z]{3}$/` looks like "an ISO-4217 code" and is really "any three
 * letters", i.e. an accept-everything rule with 17,576 entries. Measured on the
 * shape test before this list existed: `499 net` → `money:NET:499`, `12 mos` →
 * `money:MOS:12`, `1 yrs` → `money:YRS:1`, `10 kgs` → `money:KGS:10`. The
 * currency lives in the PAYLOAD, not the tag, so `money:MOS:12` and
 * `money:YRS:1` share the `money` tag, compare unequal, and read as **provably
 * different** — one belief stated two ways, stamped `valid_to`. That is the
 * exact counterfeit-difference this column exists to prevent, re-entering
 * through the arm meant to prevent it. `12 mos` is not an exotic surface for a
 * warehouse producer reading a units column.
 *
 * ⚠️ **This is not the symbol allowlist the module header refuses, and the
 * difference is the failure DIRECTION.** A missing symbol there would have made
 * an ambiguous surface parse — a stamp. A missing code here makes a
 * well-formed surface abstain — a missed supersession, recoverable, repaired by
 * adding the code. Refusing a list is only correct when being wrong costs the
 * irreversible direction.
 *
 * The list is ISO-4217's active alphabetic codes. It moves slowly, and it is
 * fine for it to lag: an unlisted currency abstains.
 *
 * ⚠️ **The residual, which no list can remove.** Some codes ARE ordinary
 * three-letter English abbreviations — `KGS` is the Kyrgyzstani som and the
 * obvious short form of kilograms; `TRY`, `MOP`, `SEK`, `MAD` collide the same
 * way. `10 kgs` therefore reads as `money:KGS:10`, and the surface genuinely
 * does not say which was meant. It is tolerable because the reading is wrong
 * about the TYPE and right about the VERDICT: two weights in one unit still
 * compare as two quantities in one unit, so `different` is the answer a
 * reviewer would give either way. The dangerous shape — one quantity, two units
 * (`12 mos` / `1 yrs`) — needs BOTH tokens to be ISO codes, which no producer
 * vocabulary reaches. Pinned by a test rather than left to be rediscovered.
 */
const ISO_4217 = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
  "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
  "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
  "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB",
  "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX",
  "USD", "UYU", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAF", "XCD",
  "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG",
]);

/** The SHAPE a currency token must have before {@link ISO_4217} is consulted. */
const CURRENCY_SHAPE_RE = /^[A-Za-z]{3}$/;

/**
 * `499 USD` or `USD 499`. Exactly two tokens, either order.
 *
 * Separated by SPACES OR TABS, never `\s`. `\s` matches a newline, so a
 * multi-line object surface with a number on one line and a three-letter token
 * on the next parsed as money — measured: `"499\nUSD"` → `money:USD:499`. A
 * claim spanning two lines is not a price; it is a producer emitting something
 * this module has no business canonicalizing.
 */
const MONEY_RE = /^(\S+)[ \t]+(\S+)$/;

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
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

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
  const match = INSTANT_RE.exec(raw);
  if (match === null) return null;
  const [, year = "", month = "", day = ""] = match;
  // ⚠️ The SAME calendar round-trip {@link canonicalDate} performs, and its
  // absence here was a live defect rather than a theoretical one. `new Date`
  // does NOT return `Invalid Date` for an impossible calendar day inside a
  // well-formed timestamp — it rolls forward, measured on this repo's runtime:
  //
  //   2026-02-31T10:00:00Z      -> 2026-03-03T10:00:00.000Z
  //   2026-04-31T00:00:00Z      -> 2026-05-01T00:00:00.000Z
  //   2026-02-30T10:00:00+00:00 -> 2026-03-02T10:00:00.000Z
  //
  // Both irreversible directions are reachable from that. A rolled instant is
  // byte-identical to the real day it lands on, so the two CORROBORATE and the
  // real observation is discarded into a row recording the nonsense surface.
  // And a rolled instant against a genuine neighbouring day is same-tag and
  // unequal — *provably different* — so publish stamps `valid_to` on a belief
  // nobody arbitrated, from an input that names no instant at all.
  //
  // Delegated to `canonicalDate` rather than re-derived, so the two arms cannot
  // disagree about which days exist. Only Y-M-D is constrained: `24:00:00` is
  // ISO-legal and genuinely the next midnight, and rolling THAT forward is
  // correct.
  if (canonicalDate(`${year}-${month}-${day}`) === null) return null;
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
  if (!CURRENCY_SHAPE_RE.test(raw)) return null;
  const upper = raw.toUpperCase();
  // Membership, not shape — see {@link ISO_4217}. Without this arm every
  // three-letter unit token (`mos`, `yrs`, `kgs`, `net`, `min`) names a
  // currency, and two spellings of one quantity read as provably different.
  return ISO_4217.has(upper) ? upper : null;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** `<tag>:<payload>`, the one place the wire format is written. */
function tagged(tag: ComparableTag, payload: string): TaggedComparable {
  return `${tag}${TAG_SEPARATOR}${payload}`;
}

/**
 * What a surface says about itself, before any declaration is consulted.
 *
 * Returns the tag AND the parts, because the money arm needs the currency and
 * the amount separately: a declaration may supply a currency the surface lacks,
 * but it may never CONTRADICT one the surface states.
 */
type SurfaceParse =
  /** The `money` arm — the only one carrying a currency, and it always does. */
  | { readonly tag: "money"; readonly payload: string; readonly currency: string }
  /**
   * Everything else. A two-member union rather than one shape with an optional
   * `currency`. That alternative admits `{ tag: "bool", currency: "USD" }` —
   * inert, because the one reader fails closed on it — and the union costs
   * three lines, so the illegal state is simply removed.
   */
  | { readonly tag: Exclude<ComparableTag, "money">; readonly payload: string };

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
    // unambiguous. A SINGLE token cannot parse as both a decimal and an ISO
    // code, so the `??` never picks the wrong one. When BOTH tokens are the
    // same kind (`USD EUR`, `499 500`) the other lookup returns null and the
    // arm abstains — which is the safety, not an impossibility.
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
export function comparableValue(input: ComparableInput): ComparableValue {
  return comparableValueWithReason(input).value;
}

/** {@link comparableValueWithReason}'s inputs — see {@link comparableValue}. */
export interface ComparableInput {
  readonly surface: string;
  readonly declared?: DeclaredObjectType | undefined;
  readonly entityId?: string | undefined;
}

/**
 * WHY the value is what it is — the distinction {@link comparableValue}'s single
 * `null` cannot carry.
 *
 * `null` is the same VERDICT for two very different facts about the world, and
 * only one of them is actionable:
 *
 *   - `"abstained"` — the surface names nothing comparable AT ALL
 *     (`Enterprise tier`, `$499`, `N/A`) and no declaration rescued it. The
 *     COMMON case, permanent, and nothing anyone should be told about.
 *   - `"declaration-rejected"` — the producer declared something the surface
 *     contradicts, or a currency this module cannot canonicalize. A broken
 *     producer: `objectType` exists solely to make an ambiguous surface
 *     comparable, so a rejected declaration silently switches supersession off
 *     for that producer's whole slot population with no other symptom.
 *
 *     ⚠️ This ALSO covers the deliberate use of a payload-less declaration to
 *     REFUSE a coincidence — `{kind:"number"}` over a slot whose surfaces are
 *     sometimes dates, which {@link applyDeclaration} documents as intended. It
 *     is kept here rather than moved to `abstained` because the resulting log
 *     is the only thing that would ever tell an operator a row in their NUMBER
 *     slot is a date, and it is bounded in a way the `N/A` case is not: it
 *     fires only on surfaces that parse as the WRONG type, never on the
 *     unparseable majority. Pinned by `object-cmp.test.ts`.
 *
 * Split because a warn on the first is noise per claim and buries the second.
 * `reconcile.ts` is the only caller that needs it; #5035 will want it too.
 */
export type ComparableReason = "resolved" | "abstained" | "declaration-rejected";

export interface ComparableOutcome {
  readonly value: ComparableValue;
  readonly reason: ComparableReason;
}

export function comparableValueWithReason(input: ComparableInput): ComparableOutcome {
  const { surface, declared, entityId } = input;

  if (entityId !== undefined && entityId.trim() !== "") {
    return { value: tagged(ENTITY_TAG, entityId.trim()), reason: "resolved" };
  }

  const parsed = parseSurface(surface);
  if (declared === undefined) {
    return parsed === null
      ? { value: null, reason: "abstained" }
      : { value: tagged(parsed.tag, parsed.payload), reason: "resolved" };
  }

  const value = applyDeclaration(surface, parsed, declared);
  if (value !== null) return { value, reason: "resolved" };

  // A currency this module cannot canonicalize is a producer defect on EVERY
  // claim in the slot, not a property of this surface — so it is reported even
  // when the surface would have abstained anyway. It is also the single most
  // actionable thing here: it is static misconfiguration, and it is why the
  // remediation sentence in `reconcile.ts` talks about ISO-4217 codes.
  if (declared.kind === "money" && canonicalCurrency(declared.currency) === null) {
    return { value: null, reason: "declaration-rejected" };
  }
  // Otherwise: the surface named nothing to begin with, so the declaration is
  // not what lost the value — it never had one to lose. Only a declaration that
  // contradicted a REAL parse is a defect.
  return { value: null, reason: parsed === null ? "abstained" : "declaration-rejected" };
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
 *
 * Agrees with the SQL side — `split_part(…, ':', 1)` plus the `IN (…known
 * tags…)` and `strpos(…) > 0` arms in {@link comparableDifferentSql} — on every
 * value this module PRODUCES, which is what `object-cmp-pg.test.ts` checks with
 * one fixture per tag. The two are not the same function on other inputs and
 * are not meant to be: `split_part` returns the whole STRING for a
 * separator-less value, so the membership arm alone does NOT reproduce this
 * function's `-1` behaviour — a bare tag name (`'money'`) passes it. That is
 * what the separate `strpos` arm is for, and its docstring records the measured
 * failure it closes.
 *
 * This function has no production consumer. It exists for the agreement oracle
 * in `object-cmp-corpus.ts`, and from #5035 for the null-at-import decision,
 * where a mis-tag means a store-local id travels verbatim as counterfeit
 * evidence of difference.
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
 * `:` (every `time:` value, every `money:` value) is unaffected.
 *
 * ⚠️ **The `strpos(…) > 0` arms are NOT redundant with the membership test, and
 * their absence was a live defect.** `split_part` returns the WHOLE STRING when
 * there is no separator — so the six bare tag names (`'money'`, `'entity'`, …)
 * pass the membership test and read as *provably different* from every real
 * value of their own type. Measured on this repo's PG 16: `'money'` vs
 * `'money:USD:499'` returned TRUE. `comparableTag` says `null` for those same
 * strings (its `boundary === -1` arm), so the two readers disagreed exactly
 * where the disagreement costs a `valid_to` stamp.
 *
 * Unreachable from `comparableValue`, which always emits a separator — and that
 * is precisely the point: #5035 makes the region importer a SECOND writer of
 * this column, and an importer that nulls a store-local id by writing the
 * discriminator alone, or any truncation that drops a payload, produces exactly
 * `'entity'`. It agrees with
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
 * PARENTHESIZED, and the reason is a FUTURE arm rather than a present caller:
 * every arm here is `AND`, so spliced into an `AND` chain the parens buy nothing
 * — precisely because `AND` binds tighter. What they stop is an `OR` arm added
 * INSIDE this builder later (a restored `object_key` fallback is the obvious
 * one) binding looser than the conjunction and re-widening the whole join.
 * Migration 0187's `WHERE` carries redundant parens for the mirror-image case:
 * all-`OR` arms guarded against a later `AND`.
 *
 * `a` / `b` are interpolated; callers pass column expressions or bind
 * placeholders they control — same contract as `supersessionCollisionPredicate`
 * and `brainFactStatusClause`.
 */
export function comparableDifferentSql(a: string, b: string): string {
  return `(${a} <> ${b}
      AND split_part(${a}, '${TAG_SEPARATOR}', 1) = split_part(${b}, '${TAG_SEPARATOR}', 1)
      AND split_part(${a}, '${TAG_SEPARATOR}', 1) IN (${KNOWN_TAGS_SQL})
      AND strpos(${a}, '${TAG_SEPARATOR}') > 0
      AND strpos(${b}, '${TAG_SEPARATOR}') > 0)`;
}


/**
 * *Provably the same* at the object position — the full two-arm test, with the
 * difference veto that keeps the two verdicts disjoint.
 *
 * ⚠️ **`same` and `different` as ADR-0037 §2 states them are NOT disjoint, and
 * the overlap is reachable.** `lexicalNorm` treats `-` as a separator and trims
 * it, so `-499` and `499` key IDENTICALLY (`499`) while their comparable values
 * are `number:-499` and `number:499` — same tag, unequal, provably different.
 * Under the rule as written the key arm fires `same`, corroboration merges the
 * two rows, and the second claim never gets a row at all: Atlas records one more
 * piece of evidence for the OPPOSITE-signed belief, the tension scan never runs,
 * and no reviewer ever sees it. That is T2's *"corroboration merges two distinct
 * beliefs into one row — silent, unattended, no human in the loop"*, arriving
 * through the arm nobody changed. A signed number is exactly the object a
 * warehouse producer emits for a margin or a delta, which is the producer
 * `objectType` exists to serve.
 *
 * So proven difference VETOES sameness. The three verdicts are then disjoint by
 * construction rather than by assumption, and the pair falls to `different` —
 * a fresh row, a tension edge, and a supersession the reviewer can see coming.
 *
 * `IS NOT TRUE` on the veto, never `NOT (…)`: the veto is NULL for the whole
 * abstain band, and `NOT NULL` is NULL, which a `WHERE` treats as false. The
 * readable spelling would delete corroboration for every unparseable object in
 * the corpus.
 */
export function objectSameSql(keyA: string, keyB: string, cmpA: string, cmpB: string): string {
  return `((${keyA} = ${keyB} OR ${comparableSameSql(cmpA, cmpB)})
      AND (${comparableDifferentSql(cmpA, cmpB)}) IS NOT TRUE)`;
}

/**
 * *Not provably the same* at the object position — what the advisory rival scan
 * asks, and where the whole `unknown` band lands.
 *
 * NOT spelled as `objectSameSql(…) IS NOT TRUE`, and the difference is
 * deliberate: that spelling would make a NULL-keyed row (a surface of only
 * separators) earn a tension edge, reversing the documented abstention
 * `TENSION_CANDIDATES_SQL` has carried since #5020 — an advisory edge from a
 * real claim to a placeholder that asserts nothing.
 *
 * Instead: the keys differ **or** the values prove they differ, and the values
 * do not prove they are the same. The second disjunct is what carries the
 * `-499` / `499` case above into tension once the veto has kept it out of
 * corroboration; without it that pair would mint a second row and then earn no
 * edge, which is worse than either verdict alone.
 */
export function objectNotSameSql(keyA: string, keyB: string, cmpA: string, cmpB: string): string {
  // The inner parens around the equality are REDUNDANT under PostgreSQL's
  // precedence table — comparison binds tighter than `IS`, verified on this
  // repo's PG 16 (`NULL = 'x' IS NOT TRUE` → t, `'a' = 'a' IS NOT TRUE` → f) —
  // and they are written anyway. `x = y IS NOT TRUE` reads as `x = (y IS NOT
  // TRUE)` to most people, which is a different and wrong expression, and the
  // cost of being wrong here is deleting the whole abstain band. Migration
  // 0187's `WHERE` carries redundant parens too, though for a different reason:
  // future-arm protection, not readability under a precedence rule.
  return `((${keyA} <> ${keyB} OR ${comparableDifferentSql(cmpA, cmpB)})
      AND (${comparableSameSql(cmpA, cmpB)}) IS NOT TRUE)`;
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

// ⚠️ AND it carries no WELL-FORMEDNESS arm either, unlike its difference twin —
// which is a known asymmetry with a named owner, not an oversight. Two
// byte-identical malformed values (`'entity'` on both sides, from a truncating
// writer) compare EQUAL here and corroborate, merging two claims into one row
// with no reviewer: T2's silent-merge direction, mirroring the stamp direction
// the `strpos` arms close in `comparableDifferentSql`.
//
// Not fixed by adding a third arm here. Enumerating malformed shapes in two SQL
// builders is the wrong shape for the class, and migration 0191's header
// records the right one — a `CHECK` on the column, which makes every reader
// safe against any second writer and is sequenced with #5035, the issue that
// creates one. Unreachable from `comparableValue`, which is the only writer
// until then.
