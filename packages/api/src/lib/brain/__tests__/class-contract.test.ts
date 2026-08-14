/**
 * The class coverage contract (#5212, ADR-0041 declared at ADR-0040's site).
 *
 * ## What this file is defending
 *
 * Three properties, each of which fails in a direction that is invisible from
 * the outside:
 *
 *   - **`vendorPublic`** gates a DISCLOSURE. Flipping it open on `email` names
 *     mailboxes on an admin page — "naming a mailbox is naming a person" —
 *     and nothing about the page's shape changes when it does.
 *   - **`activityMetadata`** gates a WORD. Flipping it to `reports` on a class
 *     that cannot read vendor activity lets the surface say "stale" about a lag
 *     it did not measure, which is the guess ADR-0041 refuses in both
 *     directions.
 *   - **the denominator** gates a NUMBER. A class that gained a universe it
 *     cannot enumerate contributes a count with nothing behind it, and
 *     ADR-0041's fabrication discipline calls that a false statement rather than
 *     an error state.
 *
 * So the assertions are about the ANSWERS, pinned as a table, and about the
 * fail-closed arms, exercised through the derivations rather than reasoned
 * about. The table is deliberately a literal: a test that read each answer back
 * out of `CLASS_CONTRACTS` and compared it to itself would stay green for every
 * possible contract, which is the self-referential agreement `sources.test.ts`
 * exists to defeat one file over.
 *
 * ## The hypothetical-new-class arm
 *
 * A class the compiler CAN see is a compile error without a contract — that is
 * the Record's totality gate, asserted below with `@ts-expect-error`. The
 * runtime arm covers the class the compiler CANNOT see: a value arriving through
 * a cast, a region import, a separately-compiled plugin. Every derivation gets
 * the same hostile inputs, and the claim is uniform — no label under either
 * clause, never the word stale, no denominator.
 */

import { describe, expect, test } from "bun:test";
import {
  CLASS_CONTRACTS,
  classDenominator,
  coverageLabelPolicy,
  stalenessVerdictKind,
  type ClassContract,
  type SurveyUnitDisclosureFacts,
} from "@atlas/api/lib/brain/class-contract";
import {
  CHAT_CLASS,
  EMAIL_CLASS,
  EPISODE_SOURCE_CLASSES,
  TRANSCRIPT_CLASS,
  WAREHOUSE_CLASS,
  type EpisodeSourceClass,
} from "@atlas/api/lib/brain/sources";

/**
 * Values that are not a class this deploy can resolve.
 *
 * Three families, and each one is a real lane rather than a hostile-input
 * flourish. `docs`/`wiki`/`code`/`drive` are ADR-0036 classes that have NOT
 * shipped — the literal hypothetical-new-class case. `slack`/`zoom`/`outlook`
 * are legal stored SOURCE values that are not classes, which is `sources.ts`'s
 * two-axes hazard arriving at a disclosure gate; `human ` and `Chat` are the
 * whitespace and casing near-misses of real class names. The prototype keys are
 * the ones a bare index would resolve to a FUNCTION whose `.coverage` is
 * `undefined` — measured, not assumed: dropping the narrow in `contractOf`
 * reddens three of the tests below.
 */
const UNRESOLVABLE: readonly unknown[] = [
  "docs",
  "wiki",
  "drive",
  "code",
  "slack",
  "zoom",
  "outlook",
  "human ",
  "Chat",
  "",
  "toString",
  "constructor",
  "hasOwnProperty",
  "valueOf",
  "__proto__",
  null,
  undefined,
  42,
  { class: "chat" },
  ["chat"],
];

/** Both per-unit inputs, every combination — the label policy's whole domain. */
const UNIT_FACTS: readonly SurveyUnitDisclosureFacts[] = [
  { deliberateAct: false, vendorReportsPublic: false },
  { deliberateAct: false, vendorReportsPublic: true },
  { deliberateAct: true, vendorReportsPublic: false },
  { deliberateAct: true, vendorReportsPublic: true },
];

describe("the class contract Record (#5212)", () => {
  test("is TOTAL over the class set — one entry per class, no orphan key", () => {
    // Both directions. A MISSING class is already a compile error (the
    // `satisfies Record<EpisodeSourceClass, …>` on the map) and an EXTRA key is
    // one too (`_CONTRACT_KEYS_IN_SYNC`), so what this adds is the runtime
    // statement of the same fact — the thing a reader can check without running
    // `tsc`, and the thing that stays true if either compile-time guard is ever
    // weakened by a refactor.
    expect(Object.keys(CLASS_CONTRACTS).toSorted()).toEqual([...EPISODE_SOURCE_CLASSES].toSorted());
    for (const cls of EPISODE_SOURCE_CLASSES) {
      expect([cls, CLASS_CONTRACTS[cls]]).not.toEqual([cls, undefined]);
      expect([cls, typeof CLASS_CONTRACTS[cls].coverage.vendorPublic]).toEqual([cls, "boolean"]);
    }
  });

  test("adding a class WITHOUT a contract is a compile error", () => {
    // The Record's whole structural claim, and the only instrument that can pin
    // it. Both lines fail to compile TODAY, so weakening the annotation to
    // `Partial<Record<…>>` — the natural "fix" when a new class does not
    // compile — turns them into unused-@ts-expect-error errors instead of
    // silently admitting a class with no coverage answer.
    // @ts-expect-error a contract map missing a class is not assignable
    const partial: Record<EpisodeSourceClass, ClassContract> = {
      chat: CLASS_CONTRACTS.chat,
      transcript: CLASS_CONTRACTS.transcript,
      email: CLASS_CONTRACTS.email,
      warehouse: CLASS_CONTRACTS.warehouse,
    };
    // …and a class outside the closed set cannot be indexed for one, so a
    // consumer cannot reach past the Record to invent an answer either.
    // @ts-expect-error `docs` is an ADR-0036 class that has not shipped
    const unshipped: ClassContract = CLASS_CONTRACTS.docs;
    void partial;
    void unshipped;
  });

  test("declares EXACTLY the three coverage properties — no invented field", () => {
    // Excess-property checking only fires on a fresh object literal and
    // `Object.freeze(...)` is a call result, so the per-entry `satisfies` inside
    // the map is what restores it — and a `satisfies` cannot be asserted after
    // the fact. A typo'd field (`vendorPublik`) on a disclosure gate is exactly
    // the shape that produces confidence in something nothing reads.
    for (const cls of EPISODE_SOURCE_CLASSES) {
      expect([cls, Object.keys(CLASS_CONTRACTS[cls]).toSorted()]).toEqual([cls, ["coverage"]]);
      expect([cls, Object.keys(CLASS_CONTRACTS[cls].coverage).toSorted()]).toEqual([
        cls,
        ["activityMetadata", "denominator", "vendorPublic"],
      ]);
    }
  });

  test("is FROZEN all the way down — the disclosure gate cannot be rewritten at runtime", () => {
    // `Object.freeze` is shallow and the gate lives two levels down, so the
    // top-level freeze alone would leave `CLASS_CONTRACTS.email.coverage
    // .vendorPublic = true` working. Every reader would then see the same
    // mutated map and stay agreed while all of them were wrong — no log, no
    // throw, no red test. Asserted per level rather than only on the root.
    expect(Object.isFrozen(CLASS_CONTRACTS)).toBe(true);
    for (const cls of EPISODE_SOURCE_CLASSES) {
      expect([cls, Object.isFrozen(CLASS_CONTRACTS[cls])]).toEqual([cls, true]);
      expect([cls, Object.isFrozen(CLASS_CONTRACTS[cls].coverage)]).toEqual([cls, true]);
      expect([cls, Object.isFrozen(CLASS_CONTRACTS[cls].coverage.denominator)]).toEqual([cls, true]);
    }
    // And the freeze BITES rather than merely being reported: ESM modules are
    // strict, so the write throws. A test that only read `Object.isFrozen`
    // would pass against a sealed-but-writable object.
    expect(() => {
      (CLASS_CONTRACTS.email.coverage as { vendorPublic: boolean }).vendorPublic = true;
    }).toThrow(TypeError);
    expect(CLASS_CONTRACTS.email.coverage.vendorPublic).toBe(false);
  });
});

describe("the three coverage answers, per class", () => {
  test("the whole table, pinned to literals", () => {
    // The one place the answers are anchored to values rather than to each
    // other. Every other assertion in this file is about agreement or about a
    // derivation, so without this line a coordinated edit — flip `vendorPublic`
    // in the map, flip the expectation in a derivation test — stays green.
    //
    // Read the `vendorPublic` column as CLASS-LEVEL ADMISSIBILITY, not as "these
    // units are public": `chat` is the only class ADR-0041 argues open, and the
    // per-unit half is ANDed in `coverageLabelPolicy` below.
    expect(
      Object.fromEntries(
        EPISODE_SOURCE_CLASSES.map((cls) => {
          const { vendorPublic, activityMetadata, denominator } = CLASS_CONTRACTS[cls].coverage;
          return [
            cls,
            [
              vendorPublic,
              activityMetadata,
              denominator.surveyable ? denominator.enumeratedFrom : null,
            ],
          ];
        }),
      ),
    ).toEqual({
      chat: [true, "reports", "chat-channel-roster"],
      transcript: [false, "reports", "granted-recording-scopes"],
      email: [false, "reports", "mailbox-list"],
      warehouse: [false, "absent", "semantic-layer-enrollment"],
      human: [false, "absent", null],
    });
  });

  test("vendorPublic defaults CLOSED — chat is the only class argued open", () => {
    // Stated as a rule over the whole set rather than only in the table above,
    // so a NEW class declaring `true` fails here with a reason attached rather
    // than merely editing a literal. ADR-0041: the clause leans on each vendor's
    // notion of "public", so a class must argue its way open.
    const open = EPISODE_SOURCE_CLASSES.filter((cls) => CLASS_CONTRACTS[cls].coverage.vendorPublic);
    expect(open).toEqual([CHAT_CLASS]);
  });

  test("`human` is explicitly NON-SURVEYABLE, and it is the only one", () => {
    // The AC that omission would have satisfied far more weakly: an absent row
    // is indistinguishable from an unfinished one. Asserted through the
    // derivation as well as off the map, because the derivation is what the
    // Coverage Surface will call and it has its own fail-closed arm that could
    // produce the same `{surveyable: false}` for the wrong reason.
    expect(classDenominator("human")).toEqual({ surveyable: false });
    const nonSurveyable = EPISODE_SOURCE_CLASSES.filter(
      (cls) => !CLASS_CONTRACTS[cls].coverage.denominator.surveyable,
    );
    expect(nonSurveyable).toEqual(["human"]);
  });

  test("no two classes share a denominator origin — the layers stay incommensurable", () => {
    // ADR-0041's "No single number, permanently", made structural. A shared
    // origin slug is the first thing that would make a blend across classes look
    // defensible, and the blend is the refusal the ADR expects to be asked for
    // repeatedly.
    const origins = EPISODE_SOURCE_CLASSES.flatMap((cls) => {
      const denominator = CLASS_CONTRACTS[cls].coverage.denominator;
      return denominator.surveyable ? [denominator.enumeratedFrom] : [];
    });
    // Non-vacuity first: with an empty list the uniqueness assertion below is
    // `0 === 0` and would hold for a Record that had stopped declaring
    // denominators at all.
    expect(origins.length).toBeGreaterThan(1);
    expect(new Set(origins).size).toBe(origins.length);
  });
});

describe("the coverage label policy — ADR-0041's two clauses", () => {
  test("names a unit under the deliberate-act clause, whatever the class", () => {
    // The clause that does not depend on any vendor's notion of "public": the
    // admin typed the id, so showing it back discloses nothing they did not
    // supply. True for `email` too, which is the sharp case — a mailbox nobody
    // named stays counted-only, and one an admin entered on the install form
    // does not.
    for (const cls of EPISODE_SOURCE_CLASSES) {
      expect([cls, coverageLabelPolicy(cls, { deliberateAct: true, vendorReportsPublic: false })])
        .toEqual([cls, { policy: "name", clause: "deliberate-act" }]);
    }
  });

  test("the vendor-public clause needs BOTH halves — class admissibility AND the vendor's answer", () => {
    // The AND is the whole design, and each half is checked with the other one
    // held wrong so neither can be carrying the test alone.
    //
    // Half one — the class says yes, the vendor says no (a PRIVATE Slack
    // channel). No label: `chat`'s `vendorPublic: true` is admissibility, not a
    // blanket verdict over the class's units.
    expect(coverageLabelPolicy(CHAT_CLASS, { deliberateAct: false, vendorReportsPublic: false }))
      .toEqual({ policy: "count-only", reason: "no-clause" });
    // Half two — the vendor says yes, the class says no. No label: a caller's
    // per-unit claim cannot open a class a human declined to open, which is the
    // direction that matters because the claim comes from vendor data.
    for (const cls of [TRANSCRIPT_CLASS, EMAIL_CLASS, WAREHOUSE_CLASS, "human"] as const) {
      expect([cls, coverageLabelPolicy(cls, { deliberateAct: false, vendorReportsPublic: true })])
        .toEqual([cls, { policy: "count-only", reason: "no-clause" }]);
    }
    // Both halves — the only combination that labels under this clause.
    expect(coverageLabelPolicy(CHAT_CLASS, { deliberateAct: false, vendorReportsPublic: true }))
      .toEqual({ policy: "name", clause: "vendor-public" });
  });

  test("reports WHICH clause fired, so the two cannot be swapped unnoticed", () => {
    // The decision carries the clause rather than a bare boolean precisely so
    // this is falsifiable. `warehouse` is the case that makes it worth having:
    // its units are freely namable, and they get there by DELIBERATE ACT
    // (enrollment, ADR-0039) while the class declares `vendorPublic: false`. A
    // boolean return would report the same `true` under either reading, and an
    // edit that opened `warehouse`'s vendor-public flag to "fix" a page would
    // look like a no-op.
    expect(
      coverageLabelPolicy(WAREHOUSE_CLASS, { deliberateAct: true, vendorReportsPublic: true }),
    ).toEqual({ policy: "name", clause: "deliberate-act" });
    // …and chat with only the vendor half is the other clause, from the same
    // input shape. The two results differ in the `clause` field alone, which is
    // the assertion a bare boolean could not make.
    expect(
      coverageLabelPolicy(CHAT_CLASS, { deliberateAct: false, vendorReportsPublic: true }),
    ).toEqual({ policy: "name", clause: "vendor-public" });
  });

  test("deliberate-act WINS when both clauses would admit the unit", () => {
    // Order is a real decision (the older clause, and the one whose
    // justification survives a vendor redefining "public"), so it is pinned
    // rather than left to fall out of the `if` order.
    expect(
      coverageLabelPolicy(CHAT_CLASS, { deliberateAct: true, vendorReportsPublic: true }),
    ).toEqual({ policy: "name", clause: "deliberate-act" });
  });
});

describe("the fail-closed arms — a class this deploy cannot resolve", () => {
  test("gets NO label, under EITHER clause", () => {
    // The hypothetical-new-class AC, exercised across the label policy's whole
    // input domain rather than only on the natural `{false, false}` case. The
    // `deliberateAct: true` rows are the ones that carry the argument: every act
    // that clause enumerates is class-specific machinery (an install form, an
    // exclusion list, an enrollment), so a class with no contract has none of it
    // built and a caller asserting the flag is asserting a fact about a form
    // that does not exist.
    for (const cls of UNRESOLVABLE) {
      for (const unit of UNIT_FACTS) {
        expect([String(cls), unit.deliberateAct, coverageLabelPolicy(cls, unit)]).toEqual([
          String(cls),
          unit.deliberateAct,
          { policy: "count-only", reason: "unresolvable-class" },
        ]);
      }
    }
  });

  test("distinguishes the fail-closed withhold from the ordinary one", () => {
    // `no-clause` and `unresolvable-class` are different sentences to an admin —
    // "we counted this and correctly did not name it" versus "we do not know
    // what this is" — and only the second is a bug. Collapsing them to one
    // `count-only` would pass every other assertion in this describe block,
    // which is why the reasons are asserted against EACH OTHER here.
    const ordinary = coverageLabelPolicy(EMAIL_CLASS, {
      deliberateAct: false,
      vendorReportsPublic: true,
    });
    const failClosed = coverageLabelPolicy("docs", {
      deliberateAct: false,
      vendorReportsPublic: true,
    });
    expect(ordinary).toEqual({ policy: "count-only", reason: "no-clause" });
    expect(failClosed).toEqual({ policy: "count-only", reason: "unresolvable-class" });
    expect(ordinary).not.toEqual(failClosed);
  });

  test("never yields a staleness verdict that could read as `stale`", () => {
    for (const cls of UNRESOLVABLE) {
      expect([String(cls), stalenessVerdictKind(cls)]).toEqual([String(cls), "unverified-since"]);
    }
  });

  test("has no denominator — a count with no universe behind it is a fabrication", () => {
    for (const cls of UNRESOLVABLE) {
      expect([String(cls), classDenominator(cls)]).toEqual([String(cls), { surveyable: false }]);
    }
  });
});

describe("the staleness capability, per class", () => {
  test("only a class that reads vendor activity may say `stale`", () => {
    // Derivation against the declared capability, class by class. NOT a literal
    // list of the three connector classes: that would agree with a derivation
    // that stopped consulting `activityMetadata` at all — the same coincidence
    // `sources.test.ts` guards against — and it would silently exclude the next
    // connector class to arrive.
    for (const cls of EPISODE_SOURCE_CLASSES) {
      expect([cls, stalenessVerdictKind(cls)]).toEqual([
        cls,
        CLASS_CONTRACTS[cls].coverage.activityMetadata === "reports"
          ? "measured-lag"
          : "unverified-since",
      ]);
    }
    // …plus the value anchor, so a coordinated rename of the capability arm and
    // the verdict arm cannot pass. `warehouse` is the one worth spelling: it is
    // surveyable AND connect-and-it-works, so "it must be able to report
    // staleness" is the reading someone will have.
    expect(stalenessVerdictKind(WAREHOUSE_CLASS)).toBe("unverified-since");
    expect(stalenessVerdictKind("human")).toBe("unverified-since");
    expect(stalenessVerdictKind(CHAT_CLASS)).toBe("measured-lag");
  });

  test("a non-surveyable class still answers the staleness question", () => {
    // `human` has no denominator, and the two properties are independent: a
    // derivation that short-circuited on `surveyable: false` would return
    // something else here, and the surface would have no sentence for a class it
    // still has to account for.
    expect(classDenominator("human")).toEqual({ surveyable: false });
    expect(stalenessVerdictKind("human")).toBe("unverified-since");
  });
});
