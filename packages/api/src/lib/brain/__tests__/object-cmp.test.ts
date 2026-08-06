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
 * **Generated — see `packages/api/scripts/mutations/object-cmp.md`.** The
 * mutation list is `packages/api/scripts/mutations/object-cmp.mutations.ts`,
 * and the table is produced by running each mutation against this suite:
 *
 *     cd packages/api && bun run scripts/mutate.ts scripts/mutations/object-cmp.mutations.ts
 *
 * The numbers used to live here, by hand, and they did not survive contact
 * with the review rounds: four rows had already gone stale (20→22, 11→13,
 * 3→4, 2→3) because a later round appended tests to this file and edited the
 * prose above the table without re-running anything. Regenerating found two
 * more — one cell stale, one that depended on a spelling of the mutation the
 * prose never recorded. Both are written up in the generated file's notes.
 *
 * Add a test to this file and the table is wrong until it is regenerated;
 * nothing here can tell you that, which is precisely why the numbers are no
 * longer stored in this docstring.
 *
 * ⚠️ **Three SQL arms have no behavioural falsifier in this file, and none can
 * have one.** {@link agree} is the TypeScript twin; deleting a SQL arm does not
 * touch it, so the only thing that can die here is the SQL-arms assertion at the
 * bottom. All three are covered elsewhere:
 *
 *   - the **`split_part` tag equality arm** — `identity-consumers-pg.test.ts`'s
 *     `cross-type-rival`, and `object-cmp-pg.test.ts`'s per-row parity tests
 *     via `cross-type` and `date-vs-instant`.
 *   - the **known-tag `IN` arm** and the **`strpos` separator arms** —
 *     `object-cmp-pg.test.ts`'s unknown-tag test. Both were written
 *     BECAUSE the mutations measured zero deaths across the whole suite: nothing
 *     can produce an unknown or separator-less tag today, so they guard a
 *     population that only exists once #5035 makes the region importer a second
 *     writer of this column. Unreachable is not the same as unnecessary, and an
 *     unfalsifiable guard is one somebody deletes.
 *
 * Do not delete either the lexical or the behavioural half on the grounds that
 * the other covers it: one pins the string, the other pins what Postgres does
 * with it.
 */

import { describe, expect, test } from "bun:test";
import {
  COMPARABLE_TAGS,
  ENTITY_TAG,
  comparableDifferentSql,
  comparableSameSql,
  comparableTag,
  comparableValue,
  comparableValueWithReason,
  regionPortableComparable,
  type DeclaredObjectType,
  type TaggedComparable,
} from "@atlas/api/lib/brain/object-cmp";
// The corpus and the agreement oracle live in a non-`.test.ts` sibling so this
// suite and `object-cmp-pg.test.ts` can share them without the isolated runner
// executing either one twice — `identity-corpus.ts`'s arrangement exactly.
import { AGREEMENT_CORPUS, agree } from "./object-cmp-corpus";

/** The parse, with the two optional inputs defaulted away. */
function parse(surface: string, declared?: DeclaredObjectType, entityId?: string): string | null {
  return comparableValue({ surface, declared, entityId });
}

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

  test("refuses a THREE-LETTER token that is not an ISO-4217 code", () => {
    // ⚠️ The block above cannot see this: every fixture there is four letters
    // or more, so all of them are satisfied by a length check alone and none of
    // them says anything about the three-letter band. The parser shipped with
    // `/^[A-Za-z]{3}$/` — "an ISO-4217 code" in the docstring, "any three
    // letters" in the code — and these were the measured result:
    //
    //   499 net -> money:NET:499     12 mos -> money:MOS:12
    //   10 kgs  -> money:KGS:10      1 yrs  -> money:YRS:1
    //
    // `money:MOS:12` and `money:YRS:1` share the `money` tag (the currency is in
    // the PAYLOAD) and compare unequal, so one contract length reads as provably
    // different from the same contract length stated in the other unit, and
    // publish stamps `valid_to`. Every one of these is an ordinary surface for a
    // warehouse producer reading a units column.
    for (const surface of [
      "499 net",
      "12 mos",
      "1 yrs",
      "50 pcs",
      "5 min",
      "30 day",
      "3 Jan",
      "499 ZZZ",
      "5 Pro",
    ]) {
      expect(parse(surface), `\`${surface}\` named a currency`).toBeNull();
    }
    // …and the consequence, which is the whole reason the refusal matters.
    expect(agree(parse("499 net"), parse("499 USD"))).toBe("unknown");
    expect(agree(parse("12 mos"), parse("1 yrs"))).toBe("unknown");
  });

  test("⚠️ a unit that IS a currency code is still read as money — the residual, recorded", () => {
    // `KGS` is the Kyrgyzstani som AND the obvious abbreviation for kilograms;
    // `TRY`, `MOP`, `SEK`, `MAD` collide with English words the same way. No
    // list can separate them, because the surface genuinely does not say which
    // it means — so this is a LIMIT of the design, not a defect to fix, and it
    // is asserted rather than left for someone to discover.
    expect(parse("10 kgs")).toBe("money:KGS:10");

    // Why it is tolerable, and the test that says so: the reading is wrong
    // about the TYPE and right about the VERDICT. Two weights in the same unit
    // still compare as two quantities in one unit, so `different` is the honest
    // answer either way and the supersession it licenses is the one a reviewer
    // would make.
    expect(agree(parse("10 kgs"), parse("5 kgs"))).toBe("different");
    // And the dangerous shape — one quantity, two units — is still refused,
    // because a unit pair that is BOTH ISO codes is not reachable from any
    // vocabulary a producer actually uses.
    expect(agree(parse("10 kgs"), parse("10000 gms"))).toBe("unknown");
  });

  test("refuses a declared currency that is not an ISO-4217 code either", () => {
    // The same rule on the declaration path. A producer cannot route around the
    // list by declaring what the surface may not say.
    for (const currency of ["abc", "ZZZ", "MOS", "NET"]) {
      expect(
        parse("499", { kind: "money", currency }),
        `declared currency \`${currency}\` was accepted`,
      ).toBeNull();
    }
  });

  test("refuses money split across a NEWLINE", () => {
    // `MONEY_RE` used `\s+`, which matches a newline — measured: `"499\nUSD"`
    // parsed as `money:USD:499`. A claim whose object spans two lines is not a
    // price; it is a producer emitting something this module has no business
    // canonicalizing.
    expect(parse("499\nUSD")).toBeNull();
    expect(parse("USD\n499")).toBeNull();
    // …and the tab spelling, which IS legitimate whitespace inside one line.
    expect(parse("499\tUSD")).toBe("money:USD:499");
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
      // ⚠️ The SAME impossible days in the INSTANT spelling. The bare-date arm
      // had the round-trip guard and the instant arm did not, so these parsed —
      // measured: `2026-02-31T10:00:00Z` → `time:2026-03-03T10:00:00.000Z`,
      // `2026-04-31T00:00:00Z` → `time:2026-05-01T00:00:00.000Z`. `new Date`
      // does not reject an impossible calendar day inside a well-formed
      // timestamp; it rolls forward.
      "2026-02-31T10:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-02-30T10:00:00+00:00",
      "2026-13-01T00:00:00Z",
    ]) {
      expect(parse(surface), `\`${surface}\` parsed`).toBeNull();
    }
  });

  test("…and a rolled instant does not become EQUAL to the real day it lands on", () => {
    // Both irreversible directions of the bug above, stated as consequences
    // rather than as a refusal — because a reader tempted to "just let `Date`
    // normalize it" needs to see what normalizing costs.
    //
    // False `same`: the garbage instant and a genuine March 3 canonicalize to
    // one string, so they corroborate and the real observation is discarded
    // into a row recording the nonsense surface.
    expect(agree(parse("2026-02-31T10:00:00Z"), parse("2026-03-03T10:00:00Z"))).toBe("unknown");
    // False `different`: the same garbage against its own neighbouring day is
    // same-tag and unequal — provably different — so publish stamps `valid_to`
    // from an input that names no instant at all.
    expect(agree(parse("2026-02-31T10:00:00Z"), parse("2026-03-01T10:00:00Z"))).toBe("unknown");
  });

  test("…and still accepts `24:00:00`, which IS the next midnight", () => {
    // The guard constrains Y-M-D only. Rolling a 24:00 instant forward is
    // correct — it is ISO-legal and genuinely names midnight of the next day —
    // so a guard that refused it would be over-broad.
    expect(parse("2026-08-04T24:00:00Z")).toBe("time:2026-08-05T00:00:00.000Z");
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
    // The `time` arm, which shares a switch case with the three above and had
    // no fixture at all — arm-coverage discipline, not suspicion.
    expect(parse("2026-08-04T08:00:00Z", { kind: "time" })).toBe("time:2026-08-04T08:00:00.000Z");
    expect(parse("2026-08-04", { kind: "time" })).toBeNull();
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
// Reading a value back out of the column (#5035, ADR-0037 §8)
// ---------------------------------------------------------------------------

describe("what survives a region hop", () => {
  /**
   * One well-formed stored value per REGION-INVARIANT tag.
   *
   * Typed rather than left as a bare `string[]` so the fixtures are checked
   * against the shape the column actually holds, and shared between the two
   * tests below so the "every tag is decided" assertion cannot pass over a
   * shorter list than the carry assertion used.
   */
  const VALUE_TYPED: readonly TaggedComparable[] = [
    "money:USD:499",
    "number:499",
    "date:2026-08-04",
    "time:2026-08-04T08:00:00.000Z",
    "bool:true",
  ];

  test("re-admits a well-formed value and refuses the rest", () => {
    // ⚠️ Asserted through `regionPortableComparable`, which is the module's ONLY
    // export that hands out a comparable read back off the wire. Round 2 of
    // #5035's panel found the reason it has to be: an exported
    // `parseStoredComparable` returned a `ComparableValue` and admitted
    // `entity:` verbatim, so `subjectCmp: parseStoredComparable(fact.subjectCmp)`
    // compiled with NO CAST and reintroduced the whole defect — #5032's
    // sibling-producer bypass, one column over. It was deleted; the re-admission
    // arms are asserted through the survivor.
    //
    // `reason` is what separates the two `null`s: `unreadable` (refused) from
    // `store-local` (the rule) and `absent` (nothing arrived).
    for (const value of VALUE_TYPED) {
      expect(regionPortableComparable(value), `\`${value}\` was refused`).toMatchObject({
        value,
        reason: "carried",
      });
    }
    // An entity id is well-formed and re-admitted — then dropped as store-local.
    expect(regionPortableComparable("entity:01J").reason).toBe("store-local");
    for (const bad of [
      null,
      undefined,
      // No tag at all — a raw surface that reached the column somehow.
      "499",
      "Enterprise tier",
      // A tag this module does not know.
      "currency:USD:499",
      // ⚠️ The truncated-import shapes. `entity:` with an empty payload is
      // exactly what `subjectNotDifferentSql`'s SQL arms refuse, and a value the
      // SQL refuses has no business being stored — otherwise a truncated import
      // lands a row whose comparisons the database and this module disagree on.
      "entity:",
      "money:",
      "",
      ":",
    ]) {
      expect(regionPortableComparable(bad).reason, `\`${String(bad)}\` was admitted`).not.toBe(
        "carried",
      );
    }
  });

  test("REFUSES a payload this region cannot re-derive", () => {
    // ⚠️ The first cut of this function ADMITTED these, reasoning that an
    // unreadable payload "compares unequal to everything and proves nothing".
    // That is false in the direction that stamps: *different* is `a <> b AND
    // same tag`, so an unreadable payload proves DIFFERENCE against every honest
    // local value of its own type, and the publish gate stamps `valid_to` on it
    // with no human. Region skew produces exactly these — the two regions are
    // independently deployed and the bundle version does not track this grammar.
    for (const bad of [
      // The impossible calendar day `canonicalDate`'s round-trip refuses. A
      // region predating that check could have written it; here it would read as
      // provably different from a genuine `date:2026-03-01`.
      "date:2026-02-31",
      // THREE letters, not ISO-4217 — the shape `CURRENCY_SHAPE_RE` accepts and
      // the membership set refuses. (An earlier fixture here was `ZZZ9`, four
      // characters, which never reaches the membership arm its comment named.)
      "money:ZZZ:499",
      "money:MOS:12",
      // A payload that is not a fixpoint of its own canonicalizer.
      "number:0499",
      "number:1,499",
      "bool:TRUE",
      "time:2026-08-04T08:00:00+02:00",
      // Money with no currency/amount split at all.
      "money:499",
    ]) {
      expect(regionPortableComparable(bad), `\`${bad}\` was admitted`).toMatchObject({
        value: null,
        reason: "unreadable",
      });
    }

    // …and the positive control on the same axis: a payload this region WOULD
    // produce is admitted, so the refusals above are a grammar check rather than
    // a blanket refusal of every money/date value.
    const CANONICAL: readonly TaggedComparable[] = [
      "date:2026-03-01",
      "money:USD:499",
      "number:499",
      "bool:true",
    ];
    for (const good of CANONICAL) {
      expect(regionPortableComparable(good), `\`${good}\` was refused`).toMatchObject({
        value: good,
        reason: "carried",
      });
    }
  });

  test("the fixpoint check CALLS the canonicalizers rather than re-stating them", () => {
    // The property that keeps the import path and the ingest path from drifting:
    // a value this region's own parser produces from a surface must survive a
    // round-trip through the stored-value reader. Asserted over the corpus the
    // parser is already tested against, so a grammar change tightened in one
    // place cannot leave the other admitting what it now refuses.
    for (const surface of ["499 USD", "499", "2026-08-04", "2026-08-04T08:00:00Z", "true"]) {
      const produced = comparableValue({ surface });
      expect(produced, `\`${surface}\` stopped parsing`).not.toBeNull();
      expect(
        // `String(...)` because the carried value is BRANDED — deliberately not
        // assignable from `comparableValue`'s output, which is the guard itself
        // (round 3 measured `comparableValue({…})` as one of seven cast-free
        // spellings that satisfied the unbranded destination). The bytes are
        // what this test is about.
        String(regionPortableComparable(produced).value),
        `\`${produced}\` is produced by comparableValue but refused on the way back in — the two are now different grammars`,
        // `produced!` rather than `String(produced)`: the assertion above proves
        // it is non-null, and `String(null)` would make this pass vacuously if
        // it ever were.
      ).toBe(produced!);
    }
  });

  test("drops an entity id and carries every value-typed tag", () => {
    // THE rule. A store-local id is non-null and, by construction, unequal to
    // every id the destination mints for the same real entity — at `object_cmp`
    // that is counterfeit positive evidence of DIFFERENCE, which is the arm that
    // stamps `valid_to`. Strictly worse than the NULL it replaces, because NULL
    // is `unknown` and reaches a human.
    expect(regionPortableComparable("entity:01JSOURCE7X")).toMatchObject({
      value: null,
      reason: "store-local",
    });
    // Not a length or a prefix test: an entity id whose payload happens to look
    // like money is still an entity id.
    expect(regionPortableComparable("entity:USD:499").value).toBeNull();

    // Region-invariant parses travel. These read a SURFACE and no store, so the
    // same input produces the same bytes in either region.
    for (const value of VALUE_TYPED) {
      expect(regionPortableComparable(value), `\`${value}\` was dropped`).toMatchObject({
        value,
        reason: "carried",
      });
    }

    // Every tag is covered by one arm or the other, and the split is checked
    // against the vocabulary rather than against this test's own list — a tag
    // added to COMPARABLE_TAGS with no decision here would otherwise fall
    // silently into the "travels" arm, which is the carry direction.
    const decided = new Set<string>([ENTITY_TAG, ...VALUE_TYPED.map((v) => comparableTag(v)!)]);
    expect([...COMPARABLE_TAGS].filter((t) => !decided.has(t))).toEqual([]);
  });

  test("a malformed stored value is dropped, not carried — and says so distinctly", () => {
    // The fail-closed direction, and it is the one that matters: an unreadable
    // value is same-tag-and-unequal against every honest local value of its
    // type, so carrying one manufactures difference out of a string nobody can
    // interpret.
    //
    // The REASON is asserted, not just the null. `store-local` is the design
    // working and `unreadable` is two regions disagreeing about what a
    // comparable value looks like — the importer logs the second and an operator
    // acts on it, so collapsing them into one `null` is the silent failure this
    // return shape exists to prevent.
    for (const bad of ["499", "entity:", "wat:1", "money:ZZZ9:499", "date:2026-02-31"]) {
      expect(regionPortableComparable(bad), `\`${bad}\` was carried`).toMatchObject({
        value: null,
        reason: "unreadable",
      });
    }
    // …and a genuinely absent value is neither: nothing was lost, so nothing is
    // worth recomputing and the row must not be marked `provisional`.
    for (const absent of [null, undefined, ""]) {
      expect(regionPortableComparable(absent), `\`${String(absent)}\``).toMatchObject({
        value: null,
        reason: "absent",
      });
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

// ---------------------------------------------------------------------------
// The reason code — what separates an honest abstain from a broken producer
// ---------------------------------------------------------------------------

describe("comparableValueWithReason distinguishes the two nulls (#5030)", () => {
  // `null` is one VERDICT for two very different facts about the world, and
  // `reconcile.ts` warns on exactly one of them. Getting this split wrong is
  // not a correctness bug — it is a log that fires per claim on the common case
  // and buries the signal it exists for.

  test("an honest abstain is NOT a declaration defect", () => {
    // The surface named nothing comparable to begin with, so the declaration
    // never had a value to lose. This is `price` columns with `N/A` rows, and
    // it is the majority of every declared slot.
    for (const declared of [
      { kind: "money", currency: "USD" },
      { kind: "number" },
      { kind: "date" },
    ] as const) {
      expect(
        comparableValueWithReason({ surface: "Enterprise tier", declared }).reason,
        `\`${declared.kind}\` over an unparseable surface reported a defect`,
      ).toBe("abstained");
    }
  });

  test("⚠️ a WRONG-TYPE surface in a declared slot does report a defect, and that is deliberate", () => {
    // `{kind: "number"}` over a date-shaped surface is the case
    // `applyDeclaration` documents as the payload-less declarations' purpose —
    // refusing a coincidence so a `date:` value nothing in that slot will ever
    // compare against does not get stored. So the declaration is working, and
    // it still reports `declaration-rejected`.
    //
    // Kept, rather than reclassified to `abstained`, because the log this feeds
    // is the only thing that would ever tell an operator a row in their NUMBER
    // slot is a date. It is bounded in a way the `N/A` case is not: it fires
    // only on surfaces that parse as the WRONG type, never on the unparseable
    // majority — which is the whole reason the two are split at all.
    expect(
      comparableValueWithReason({ surface: "2026-08-04", declared: { kind: "number" } }),
    ).toEqual({ value: null, reason: "declaration-rejected" });
    // …while the unparseable row beside it in the same slot stays quiet.
    expect(
      comparableValueWithReason({ surface: "N/A", declared: { kind: "number" } }).reason,
    ).toBe("abstained");
  });

  test("…and a CONTRADICTED declaration is", () => {
    // The surface parses as something real and the declaration disagrees. One
    // of the two is wrong, nothing here knows which, and an operator can act.
    expect(
      comparableValueWithReason({
        surface: "599 EUR",
        declared: { kind: "money", currency: "USD" },
      }).reason,
    ).toBe("declaration-rejected");
    expect(
      comparableValueWithReason({ surface: "499 USD", declared: { kind: "number" } }).reason,
    ).toBe("declaration-rejected");
  });

  test("…and an uncanonicalizable CURRENCY is, even over a surface that would abstain anyway", () => {
    // Static misconfiguration: wrong on every claim in the slot, not a property
    // of this surface. Reported regardless, because it is the single most
    // actionable thing this seam can say — and because gating it on the surface
    // would hide it behind exactly the rows that abstain.
    expect(
      comparableValueWithReason({
        surface: "Enterprise tier",
        declared: { kind: "money", currency: "US Dollars" },
      }).reason,
    ).toBe("declaration-rejected");
    expect(
      comparableValueWithReason({ surface: "499", declared: { kind: "money", currency: "ZZZ" } })
        .reason,
    ).toBe("declaration-rejected");
  });

  test("a successful parse reports `resolved`, declared or not", () => {
    // THE positive control. Every assertion above is satisfied by an
    // implementation that never returns `resolved` at all.
    expect(comparableValueWithReason({ surface: "499 USD" })).toEqual({
      value: "money:USD:499",
      reason: "resolved",
    });
    expect(
      comparableValueWithReason({ surface: "499", declared: { kind: "money", currency: "USD" } }),
    ).toEqual({ value: "money:USD:499", reason: "resolved" });
    expect(comparableValueWithReason({ surface: "x", entityId: "01J" })).toEqual({
      value: "entity:01J",
      reason: "resolved",
    });
  });

  test("a store id beats a declaration too — including one that would have been REJECTED", () => {
    // The precedence table says the id wins outright, and this is the corner
    // that costs something: `declaration-rejected` is the only operator-actionable
    // signal in this module, and a resolved id silences it. Deliberate — the
    // declaration exists solely to make an ambiguous SURFACE comparable, and
    // nothing about the object is ambiguous once a store has named it — but it
    // means a producer's broken `objectType` goes quiet exactly when a real
    // entity store is wired up, so it is pinned rather than left to be
    // rediscovered as a lost warning (#5031).
    expect(
      comparableValueWithReason({
        surface: "499",
        declared: { kind: "money", currency: "ZZZ9" },
        entityId: "01J",
      }),
    ).toEqual({ value: "entity:01J", reason: "resolved" });
  });

  test("`comparableValue` is exactly this function's value half", () => {
    // Two entry points, one implementation — the delegation is what stops the
    // reason code drifting from the value it explains.
    for (const input of [
      { surface: "499 USD" },
      { surface: "Enterprise tier" },
      { surface: "599 EUR", declared: { kind: "money", currency: "USD" } as const },
      { surface: "x", entityId: "01J" },
    ]) {
      expect(comparableValue(input)).toBe(comparableValueWithReason(input).value);
    }
  });
});
