/**
 * The comparable value — the fail-closed typed parser (#5030, ADR-0037 §2 / §9).
 *
 * ## What this file is actually for
 *
 * Not "does the parser parse". The load-bearing half is the REFUSALS, because
 * the abstain band has to be produced HONESTLY: a canonicalizer that returns
 * the raw surface instead of `null` collapses `unknown` to empty, restoring
 * exact-string matching with extra machinery — and it would look like it was
 * working. Every green test in a suite that only asserted successful parses
 * would stay green under that mutation.
 *
 * So the shape here is: for every refusal, a POSITIVE CONTROL in its own
 * `test()` proving the same shape parses once the ambiguity is removed. A
 * refusal alone is satisfied by `return null`, and a suite of them would pass
 * against a parser that does nothing at all.
 *
 * ## The three verdicts must be DISTINGUISHABLE, not merely reachable
 *
 * `same` / `different` / `unknown` is a three-valued type, and a fixture set
 * that only ever exercises one value passes against an implementation that
 * hardcodes it. {@link AGREEMENT_CORPUS} below is the shared table: every row
 * names the two surfaces and the verdict a human says they earn, all three
 * verdicts are asserted present, and {@link agree} — the TypeScript twin of the
 * two SQL builders — is applied to every row. A `cross-type` row and an
 * `unknown` row are what separate this from a suite that would accept
 * `a === b`.
 *
 * ## MUTATIONS THIS CATCHES
 *
 * MEASURED on the final tree, one at a time, against this file alone. Counts
 * are what the runner reported, not what the assertions look like they should
 * catch.
 *
 * | Mutation | Dies on |
 * |---|---|
 * | `parseSurface` returns `{tag:"number", payload: trimmed}` for any unmatched surface — the raw-surface collapse | 9 |
 * | `DECIMAL_RE` loses its anchors (`^…$`) | 17 |
 * | `MONEY_RE` accepts a leading `$` as a currency | 1 |
 * | `CURRENCY_RE` widened to `[A-Za-z]+` (accepts `dollars`) | 3 |
 * | `DECIMAL_RE` admits `,` | 1 |
 * | `canonicalDecimal` loses its trailing-zero trim | 2 |
 * | `canonicalDecimal` loses its `-0` fold | 1 |
 * | `canonicalDate`'s round-trip check deleted (`2026-02-31` rolls to March 3) | 1 |
 * | `canonicalInstant` returns the raw string instead of `toISOString()` | 2 |
 * | `canonicalBool` accepts `yes`/`no` | 1 |
 * | `canonicalCurrency` loses its upper-case fold | 3 |
 * | `comparableTag` loses its `boundary === -1` arm (`moneys` reads as `money`) | 1 |
 * | a declaration OVERRIDES the surface instead of narrowing it | 2 |
 * | `comparableValue` prefers the surface parse over `entityId` | 1 |
 * | `comparableDifferentSql` loses its `split_part` tag arm | **1, and it is LEXICAL** — see below |
 *
 * ⚠️ **The tag arm has no behavioural falsifier in this file, and cannot have
 * one.** {@link agree} is the TypeScript twin; deleting the SQL arm does not
 * touch it, so the only thing that dies here is the SQL-arms assertion at the
 * bottom. The behavioural proof is `identity-consumers-pg.test.ts`'s
 * `cross-type-rival` corpus entry — measured, and the ONLY test in the repo
 * that kills that mutation. Do not delete either one on the grounds that the
 * other covers it: one pins the string, the other pins what Postgres does with
 * it, and the arm matters because `number:499` and `money:USD:499` are unequal
 * strings that nothing proves are different values.
 */

import { describe, expect, test } from "bun:test";
import {
  COMPARABLE_TAGS,
  ENTITY_TAG,
  comparableDifferentSql,
  comparableSameSql,
  comparableTag,
  comparableValue,
  type DeclaredObjectType,
} from "@atlas/api/lib/brain/object-cmp";

/** The parse, with the two optional inputs defaulted away. */
function parse(surface: string, declared?: DeclaredObjectType, entityId?: string): string | null {
  return comparableValue({ surface, declared, entityId });
}

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
type Agreement = "same" | "different" | "unknown";

function agree(a: string | null, b: string | null): Agreement {
  if (a === null || b === null) return "unknown";
  if (a === b) return "same";
  return comparableTag(a) === comparableTag(b) ? "different" : "unknown";
}

// ---------------------------------------------------------------------------
// The shared agreement corpus
// ---------------------------------------------------------------------------

interface AgreementCase {
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
export const AGREEMENT_CORPUS = [
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
    id: "bool-disagrees",
    why: "The smallest possible `different`. Present because the money rows are the only other ones, and a tag arm that special-cased money would pass without it.",
    a: { surface: "true" },
    b: { surface: "FALSE" },
    verdict: "different",
  },
] as const satisfies readonly AgreementCase[];

const VERDICTS_PRESENT = ["same", "different", "unknown"] as const;

describe("the agreement corpus itself", () => {
  test("exercises all three verdicts", () => {
    // The anti-vacuity guard, and the reason it is its own `test()`: a corpus
    // that drifted to one verdict would pass every assertion below against an
    // implementation that hardcoded it. #5024 shipped a suite where every
    // fixture sat at one position of the parameter under test and a hardcoded
    // literal passed all hundred cases.
    for (const verdict of VERDICTS_PRESENT) {
      expect(
        AGREEMENT_CORPUS.filter((c) => c.verdict === verdict).length,
        `no corpus row earns \`${verdict}\` — that verdict is unexercised, and an implementation that never returns it passes this file`,
      ).toBeGreaterThan(0);
    }
  });

  test("holds no duplicate id", () => {
    const ids = AGREEMENT_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("three-valued agreement over the corpus", () => {
  for (const c of AGREEMENT_CORPUS) {
    test(`${c.id} — ${c.verdict}`, () => {
      const a = comparableValue({ surface: c.a.surface, declared: c.a.declared });
      const b = comparableValue({ surface: c.b.surface, declared: c.b.declared });
      expect(agree(a, b), c.why).toBe(c.verdict);
      // Symmetric, always. `different` is read by a JOIN whose two sides are a
      // draft and a published row, and which of the two is which is decided by
      // publish order — an asymmetric comparison would make supersession depend
      // on who was written first.
      expect(agree(b, a), `${c.id} is not symmetric`).toBe(c.verdict);
    });
  }
});

// ---------------------------------------------------------------------------
// The refusals, each with its own positive control
// ---------------------------------------------------------------------------

describe("the parser fails closed — the refusals", () => {
  test("refuses every currency SYMBOL, including the unambiguous-looking ones", () => {
    // `$` is the pinned case (USD/CAD/AUD/NZD/…). `€` and `£` are refused on
    // different grounds and the difference matters: they look unambiguous
    // TODAY, and an allowlist of "safe" symbols is a maintenance surface where
    // one wrong entry buys an irreversible stamp. The direction that costs
    // nothing is refusing the lot.
    for (const surface of ["$499", "$ 499", "499$", "€499", "£499", "¥499", "499 €"]) {
      expect(parse(surface), `\`${surface}\` parsed — a symbol named a currency`).toBeNull();
    }
  });

  test("…and parses the same amounts once an ISO-4217 code names the currency", () => {
    // THE control for the block above. Without it every refusal there is
    // satisfied by a parser that returns `null` unconditionally.
    expect(parse("499 USD")).toBe("money:USD:499");
    expect(parse("USD 499")).toBe("money:USD:499");
    expect(parse("499 EUR")).toBe("money:EUR:499");
  });

  test("refuses a currency NAME as well as a symbol", () => {
    for (const surface of ["499 dollars", "499 euro", "USD dollars"]) {
      expect(parse(surface), `\`${surface}\` parsed`).toBeNull();
    }
  });

  test("refuses `,` outright rather than guessing thousands-vs-decimal", () => {
    // `1,499` is one thousand four hundred ninety-nine in en-US and one-and-a-bit
    // across most of Europe. Either reading is a guess about locale landing in a
    // column whose entire job is certainty.
    for (const surface of ["1,499", "1,499 USD", "1,5", "1,5 EUR"]) {
      expect(parse(surface), `\`${surface}\` parsed`).toBeNull();
    }
  });

  test("…and parses the same magnitudes written without one", () => {
    expect(parse("1499")).toBe("number:1499");
    expect(parse("1499 USD")).toBe("money:USD:1499");
    expect(parse("1.5")).toBe("number:1.5");
  });

  test("refuses an unanchored match — a number inside a sentence is not a number", () => {
    for (const surface of [
      "about 499",
      "499 or so",
      "roughly 499 USD",
      "priced at 499 USD today",
      "499 USD per seat",
    ]) {
      expect(parse(surface), `\`${surface}\` parsed`).toBeNull();
    }
  });

  test("refuses an ambiguous date format, and a date that does not exist", () => {
    for (const surface of [
      // D/M or M/D — the reading changes the day and nothing on the surface says
      // which producer wrote it.
      "08/04/2026",
      "04-08-2026",
      // No zone: names a different instant in every region the fleet runs in.
      "2026-08-04T10:00",
      "2026-08-04 10:00:00",
      // Shaped like a date, is not one. Refused rather than rolled forward —
      // `Date.UTC` normalizes February 31 to March 3, which would make the two
      // surfaces compare EQUAL.
      "2026-02-31",
      "2026-13-01",
      "2026-00-10",
    ]) {
      expect(parse(surface), `\`${surface}\` parsed`).toBeNull();
    }
  });

  test("…and parses a strict ISO date and a zoned instant", () => {
    expect(parse("2026-08-04")).toBe("date:2026-08-04");
    expect(parse("2026-02-28")).toBe("date:2026-02-28");
    expect(parse("2026-08-04T08:00:00Z")).toBe("time:2026-08-04T08:00:00.000Z");
    expect(parse("2026-08-04T10:00:00+02:00")).toBe("time:2026-08-04T08:00:00.000Z");
  });

  test("refuses every boolean spelling but `true`/`false`", () => {
    // `1` and `0` are refused for a second reason on top of the vocabulary
    // guess: they are perfectly good NUMBERS, and admitting them here would
    // make one surface parse two ways depending on which arm ran first.
    for (const surface of ["yes", "no", "y", "n", "on", "off", "1", "0"]) {
      const parsed = parse(surface);
      expect(
        parsed === null || parsed.startsWith("number:"),
        `\`${surface}\` parsed as a boolean`,
      ).toBe(true);
    }
  });

  test("…and parses `true`/`false` in any casing", () => {
    expect(parse("true")).toBe("bool:true");
    expect(parse("TRUE")).toBe("bool:true");
    expect(parse("False")).toBe("bool:false");
  });

  test("refuses exponent notation, which it would have to expand to compare", () => {
    for (const surface of ["1e3", "1E3", "1.5e-3", "1e3 USD"]) {
      expect(parse(surface), `\`${surface}\` parsed`).toBeNull();
    }
  });

  test("…and parses the expanded spelling", () => {
    expect(parse("1000")).toBe("number:1000");
  });

  test("refuses an ordinary entity surface, and that is the COMMON case", () => {
    // Not an edge case being tidied away — this is what most objects in the
    // corpus look like, and `unknown` is the honest verdict for all of them
    // until an entity store lands.
    for (const surface of ["Grace", "Enterprise tier", "the deploy box", "Thursdays", ""]) {
      expect(parse(surface), `\`${surface}\` parsed`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

describe("canonicalization makes equal values equal STRINGS", () => {
  test("folds trailing zeros, leading zeros, and negative zero", () => {
    expect(parse("499.00")).toBe(parse("499"));
    expect(parse("0499")).toBe(parse("499"));
    expect(parse("499.50")).toBe("number:499.5");
    expect(parse("-0")).toBe(parse("0"));
    expect(parse("-0.000")).toBe(parse("0"));
  });

  test("does NOT fold two genuinely different numbers", () => {
    // The control for the block above: a canonicalizer that returned a constant
    // would satisfy every assertion there.
    expect(parse("499")).not.toBe(parse("4990"));
    expect(parse("499.5")).not.toBe(parse("499.05"));
    expect(parse("-499")).not.toBe(parse("499"));
  });

  test("keeps large integers exact rather than routing them through a float", () => {
    // `parseFloat("9007199254740993")` returns `9007199254740992`. A value that
    // silently changes on the way into the column is a value two producers can
    // disagree about while both being correct.
    expect(parse("9007199254740993")).toBe("number:9007199254740993");
    expect(parse("9007199254740993")).not.toBe(parse("9007199254740992"));
  });

  test("upper-cases the currency so `usd` and `USD` are one currency", () => {
    expect(parse("499 usd")).toBe(parse("499 USD"));
  });
});

// ---------------------------------------------------------------------------
// The producer declaration
// ---------------------------------------------------------------------------

describe("a declaration narrows; it never overrides", () => {
  test("supplies a currency the surface lacks", () => {
    expect(parse("499", { kind: "money", currency: "USD" })).toBe("money:USD:499");
    // …and it is the SAME value the explicit surface produces, or the two
    // producers still never compare.
    expect(parse("499", { kind: "money", currency: "USD" })).toBe(parse("499 USD"));
  });

  test("abstains when it CONTRADICTS the surface, in both directions", () => {
    // A declaration that won would let a mis-configured producer relabel every
    // object in a slot — and relabelling is what makes two values comparable,
    // which is what stamps `valid_to`.
    expect(parse("599 EUR", { kind: "money", currency: "USD" })).toBeNull();
    expect(parse("499 USD", { kind: "number" })).toBeNull();
    expect(parse("2026-08-04", { kind: "number" })).toBeNull();
    expect(parse("true", { kind: "date" })).toBeNull();
  });

  test("…and CONFIRMS when it agrees", () => {
    // The control. Every assertion above is satisfied by an implementation that
    // returns `null` whenever a declaration is present.
    expect(parse("499 USD", { kind: "money", currency: "USD" })).toBe("money:USD:499");
    expect(parse("499 usd", { kind: "money", currency: "usd" })).toBe("money:USD:499");
    expect(parse("499", { kind: "number" })).toBe("number:499");
    expect(parse("2026-08-04", { kind: "date" })).toBe("date:2026-08-04");
    expect(parse("true", { kind: "bool" })).toBe("bool:true");
  });

  test("cannot make an unparseable surface parse", () => {
    // A declaration is not a parser. `Enterprise tier` declared as money is
    // still a name, and inventing a value for it is exactly the sentinel hazard
    // the nullable column exists to avoid.
    expect(parse("Enterprise tier", { kind: "money", currency: "USD" })).toBeNull();
    expect(parse("$499", { kind: "money", currency: "USD" })).toBeNull();
  });

  test("refuses a currency it cannot canonicalize rather than passing it through", () => {
    // A broken producer, not a licence to guess. `money:US Dollars:499` would
    // compare unequal to `money:USD:499` forever, which is counterfeit evidence
    // of difference between two rows saying the same thing.
    expect(parse("499", { kind: "money", currency: "US Dollars" })).toBeNull();
    expect(parse("499", { kind: "money", currency: "" })).toBeNull();
    expect(parse("499", { kind: "money", currency: "US" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The entity id
// ---------------------------------------------------------------------------

describe("a resolved entity id outranks any parse of the surface", () => {
  test("wins over a surface that would otherwise parse", () => {
    // The store is strictly better evidence than the text. A surface that looks
    // like a number but resolves to an entity is that entity — and the reverse
    // precedence would make a store-backed slot silently fall back to text
    // comparison for exactly the values that parse.
    expect(parse("499", undefined, "01J8ZQ")).toBe("entity:01J8ZQ");
    expect(parse("Enterprise tier", undefined, "01J8ZQ")).toBe("entity:01J8ZQ");
  });

  test("…and an absent or blank id falls back to the surface parse", () => {
    expect(parse("499", undefined, undefined)).toBe("number:499");
    expect(parse("499", undefined, "")).toBe("number:499");
    expect(parse("499", undefined, "   ")).toBe("number:499");
  });

  test("two entity ids compare, and never against a value-typed canonical", () => {
    // The second half is #5035's whole rule in miniature: an id is tagged, so a
    // region import can find and null exactly the store-local values without
    // guessing, and an id can never read as *different* from a price.
    expect(agree(parse("a", undefined, "01A"), parse("b", undefined, "01A"))).toBe("same");
    expect(agree(parse("a", undefined, "01A"), parse("b", undefined, "01B"))).toBe("different");
    expect(agree(parse("a", undefined, "01A"), parse("499 USD"))).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// The tag vocabulary — a cross-issue contract, not an implementation detail
// ---------------------------------------------------------------------------

describe("the tag is a contract (#5035 reads it)", () => {
  test("tags every value it produces, with a tag from the declared set", () => {
    const produced = [
      parse("499 USD"),
      parse("499"),
      parse("2026-08-04"),
      parse("2026-08-04T00:00:00Z"),
      parse("true"),
      parse("x", undefined, "01A"),
    ];
    for (const value of produced) {
      expect(value, "a corpus surface stopped parsing").not.toBeNull();
      expect(
        comparableTag(value!),
        `\`${value}\` carries no tag from COMPARABLE_TAGS — #5035 discriminates store-local ids from value-typed canonicals on exactly this, and an untagged value is carried verbatim across a region boundary as counterfeit evidence of difference`,
      ).not.toBeNull();
    }
    // Every declared tag is actually produced by something. A tag nothing emits
    // is a branch #5035 would write against and never exercise.
    expect(new Set(produced.map((v) => comparableTag(v!))).size).toBe(COMPARABLE_TAGS.length);
  });

  test("reads the tag off values whose PAYLOAD contains the separator", () => {
    // `time:` and `money:` payloads both do. A tag reader that split on every
    // separator, or took the last field, would mis-tag exactly the two types
    // whose difference arm matters most.
    expect(comparableTag("time:2026-08-04T08:00:00.000Z")).toBe("time");
    expect(comparableTag("money:USD:499")).toBe("money");
    expect(comparableTag(ENTITY_TAG + ":01J:8Z")).toBe("entity");
  });

  test("returns null for anything not carrying a known tag", () => {
    for (const value of [
      "499",
      "",
      ":",
      "unknown:499",
      // Case-sensitive: the tags are written by this module, so a differently
      // cased one came from somewhere else.
      "Money:499",
      // ⚠️ Separator-LESS values whose prefix is a tag. `moneys` reports `money`
      // under a `slice(0, indexOf(…))` that does not special-case `-1`, and a
      // mis-tag lets the difference arm compare two values sharing no type.
      "moneys",
      "money",
      "entityx",
    ]) {
      expect(comparableTag(value), `\`${value}\` read as tagged`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The SQL builders
// ---------------------------------------------------------------------------

describe("the SQL arms", () => {
  test("the difference arm carries BOTH the inequality and the tag equality", () => {
    // Two arms, and the tag one is the one a reader deletes as redundant. It is
    // not: `<>` alone calls `number:499` and `money:USD:499` different, which is
    // a stamp on a pair nothing proved apart.
    const sql = comparableDifferentSql("p.object_cmp", "d.object_cmp");
    expect(sql).toContain("p.object_cmp <> d.object_cmp");
    expect(sql).toContain("split_part(p.object_cmp, ':', 1) = split_part(d.object_cmp, ':', 1)");
    expect(sql.trimStart().startsWith("("), "the difference arm is not parenthesized").toBe(true);
    expect(sql.trimEnd().endsWith(")")).toBe(true);
  });

  test("the sameness arm is bare equality, and its lack of a tag arm is deliberate", () => {
    // Equal strings already share a tag — the tag IS a prefix of the string — so
    // a tag arm here is a tautology. Pinned because a reader restoring symmetry
    // with the difference arm would add one, and a tautology beside a
    // load-bearing arm is how the load-bearing one later gets deleted as "the
    // same redundancy".
    const sql = comparableSameSql("object_cmp", "$5");
    expect(sql).toBe("object_cmp = $5");
    expect(sql).not.toContain("split_part");
  });

  test("both builders interpolate the operands they are given", () => {
    // The contract callers rely on: column expressions on one side, bind
    // placeholders on the other, and the same builder for both.
    expect(comparableSameSql("a.x", "b.y")).toContain("a.x = b.y");
    expect(comparableDifferentSql("a.x", "b.y")).toContain("a.x <> b.y");
  });
});
