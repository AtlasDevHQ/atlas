/**
 * Unit tests for the smoke-crm diff reporter.
 *
 * These pin the exact diagnostic shape from PR #2865's comment thread:
 *  - N distinct personas → N distinct expected Persons (collapsed by email).
 *  - atlasFirstSource is sticky across the same email; atlasLastSource isn't.
 *  - A demo→signup pair on the same email collapses to ONE expected Person
 *    with first=DEMO, last=SIGNUP.
 *  - Each sales-form persona produces exactly one expected Note on its
 *    matching Person; duplicate sales-form events on the same email produce
 *    two Notes (per #2729's idempotency contract).
 *  - The bug #2865 surfaces as: every expected email is `missingPersons`
 *    except the one Person the workspace collapsed onto, plus a
 *    `noteCountMismatch` reading the inflated count.
 */
import { describe, expect, test } from "bun:test";

import type { AtlasLeadEvent } from "@useatlas/twenty/lead-normalizer";

import {
  buildExpectedState,
  computeDiff,
  formatDiff,
  isClean,
  type ObservedState,
  type ExpectedNote,
} from "../../lib/smoke-crm/diff";

// ─────────────────────────────────────────────────────────────────────
//  buildExpectedState
// ─────────────────────────────────────────────────────────────────────

describe("buildExpectedState — single-event cases", () => {
  test("demo persona → one Person, no Notes", () => {
    const state = buildExpectedState([
      { source: "demo", email: "a@b.com", ip: null, userAgent: null },
    ]);
    expect(state.persons).toHaveLength(1);
    expect(state.persons[0]).toEqual({
      email: "a@b.com",
      atlasFirstSource: "DEMO",
      atlasLastSource: "DEMO",
    });
    expect(state.notes).toEqual([]);
  });

  test("sales-form persona → one Person, one Note", () => {
    const state = buildExpectedState([
      {
        source: "sales-form",
        email: "alice@acme.com",
        name: "Alice Anderson",
        company: "Acme",
        planInterest: "Pro",
        message: "interested",
        ip: "1.2.3.4",
        userAgent: null,
      },
    ]);
    expect(state.persons).toHaveLength(1);
    expect(state.persons[0].atlasFirstSource).toBe("SALES_FORM");
    expect(state.persons[0].atlasLastSource).toBe("SALES_FORM");
    expect(state.persons[0].name).toEqual({ firstName: "Alice", lastName: "Anderson" });
    expect(state.persons[0].atlasIp).toBe("1.2.3.4");
    expect(state.notes).toEqual([
      {
        personEmail: "alice@acme.com",
        title: "Talk to sales — Acme (Pro)",
        body: "interested",
      },
    ]);
  });
});

describe("buildExpectedState — multi-event email collapses", () => {
  test("demo → signup on the same email keeps atlasFirstSource sticky", () => {
    // This is the C10 stickiness pair from the default fixture.
    const events: AtlasLeadEvent[] = [
      { source: "demo", email: "g@globex.com", ip: null, userAgent: null },
      { source: "signup", email: "g@globex.com", name: "Greta Worth" },
    ];
    const state = buildExpectedState(events);
    expect(state.persons).toHaveLength(1);
    expect(state.persons[0]).toMatchObject({
      email: "g@globex.com",
      atlasFirstSource: "DEMO",
      atlasLastSource: "SIGNUP",
      name: { firstName: "Greta", lastName: "Worth" },
    });
  });

  test("demo → demo idempotency pair collapses to one Person", () => {
    // B8 idempotency pair — duplicate dispatches must not produce duplicate Persons.
    const events: AtlasLeadEvent[] = [
      { source: "demo", email: "m@cyberdyne.com", ip: "1.1.1.1", userAgent: null },
      { source: "demo", email: "m@cyberdyne.com", ip: "2.2.2.2", userAgent: null },
    ];
    const state = buildExpectedState(events);
    expect(state.persons).toHaveLength(1);
    expect(state.persons[0]).toEqual({
      email: "m@cyberdyne.com",
      atlasFirstSource: "DEMO",
      atlasLastSource: "DEMO",
      atlasIp: "2.2.2.2", // last-write-wins on the customField
    });
    expect(state.notes).toEqual([]);
  });

  test("two sales-form events on the same email produce TWO Notes", () => {
    // Per #2729 idempotency contract: createNote runs once per dispatch.
    // Same email → one Person but two Notes.
    const events: AtlasLeadEvent[] = [
      {
        source: "sales-form",
        email: "a@b.com",
        name: "Alice A",
        company: "Acme",
        planInterest: "Pro",
        message: "first",
        ip: null,
        userAgent: null,
      },
      {
        source: "sales-form",
        email: "a@b.com",
        name: "Alice A",
        company: "Acme",
        planInterest: "Pro",
        message: "second",
        ip: null,
        userAgent: null,
      },
    ];
    const state = buildExpectedState(events);
    expect(state.persons).toHaveLength(1);
    expect(state.notes).toHaveLength(2);
    expect(state.notes.map((n) => n.body).sort()).toEqual(["first", "second"]);
  });

  test("10-persona default-fixture shape → 8 distinct Persons + 4 Notes", () => {
    // Mirror of the default fixture (without re-reading the file).
    const events: AtlasLeadEvent[] = [
      // 4 sales-form
      makeSalesForm("dlockhart@initech.com", "David Lockhart", "Initech"),
      makeSalesForm("wbell@massivedynamic.com", "Walter Bell", "Massive Dynamic"),
      makeSalesForm("vmiller@veridiandynamics.com", "Veronica Miller", "Veridian Dynamics"),
      makeSalesForm("kflynn@encom.com", "Kevin Flynn", "ENCOM"),
      // 1 demo
      { source: "demo", email: "jvalois@pendantpub.com", ip: null, userAgent: null },
      // 1 signup
      { source: "signup", email: "lallworth@wayneent.com", name: "Lucius Allworth" },
      // 1 demo→signup pair (same email)
      { source: "demo", email: "g@globex.com", ip: null, userAgent: null },
      { source: "signup", email: "g@globex.com", name: "Greta Worth" },
      // 1 demo→demo pair (same email)
      { source: "demo", email: "m@cyberdyne.com", ip: null, userAgent: null },
      { source: "demo", email: "m@cyberdyne.com", ip: null, userAgent: null },
    ];
    const state = buildExpectedState(events);
    // 4 sales-form emails + jvalois + lallworth + g@globex.com + m@cyberdyne.com = 8 distinct
    expect(state.persons).toHaveLength(8);
    expect(state.notes).toHaveLength(4); // one per sales-form persona
  });
});

// ─────────────────────────────────────────────────────────────────────
//  computeDiff + isClean
// ─────────────────────────────────────────────────────────────────────

describe("computeDiff — clean diff", () => {
  test("isClean is true when expected matches observed exactly", () => {
    const expected = buildExpectedState([
      { source: "demo", email: "a@b.com", ip: null, userAgent: null },
    ]);
    const observed: ObservedState = {
      persons: [
        { id: "p_1", email: "a@b.com", atlasFirstSource: "DEMO", atlasLastSource: "DEMO" },
      ],
      notes: [],
    };
    const diff = computeDiff(expected, observed);
    expect(isClean(diff)).toBe(true);
  });

  test("unexpectedPersons (workspace had pre-existing rows) does NOT mark diff dirty", () => {
    // The smoke command runs against a workspace that may have unrelated
    // rows; without --wipe-twenty we shouldn't fail just because the
    // workspace isn't pristine.
    const expected = buildExpectedState([
      { source: "demo", email: "a@b.com", ip: null, userAgent: null },
    ]);
    const observed: ObservedState = {
      persons: [
        { id: "p_1", email: "a@b.com", atlasFirstSource: "DEMO", atlasLastSource: "DEMO" },
        { id: "p_2", email: "pre-existing@example.com" }, // unrelated
      ],
      notes: [],
    };
    const diff = computeDiff(expected, observed);
    expect(diff.unexpectedPersons).toEqual(["pre-existing@example.com"]);
    expect(isClean(diff)).toBe(true);
  });
});

describe("computeDiff — dirty diffs", () => {
  test("missing Person marks the diff dirty", () => {
    const expected = buildExpectedState([
      { source: "demo", email: "a@b.com", ip: null, userAgent: null },
    ]);
    const observed: ObservedState = { persons: [], notes: [] };
    const diff = computeDiff(expected, observed);
    expect(diff.missingPersons).toEqual(["a@b.com"]);
    expect(isClean(diff)).toBe(false);
  });

  test("wrong atlasFirstSource (the #2865 stickiness break) marks the diff dirty", () => {
    const expected = buildExpectedState([
      { source: "demo", email: "a@b.com", ip: null, userAgent: null },
      { source: "signup", email: "a@b.com", name: "Alice" },
    ]);
    // Pretend the dispatcher OVERWROTE atlasFirstSource — what the
    // pre-#2865 filter bug effectively caused on subsequent dispatches.
    const observed: ObservedState = {
      persons: [
        {
          id: "p_1",
          email: "a@b.com",
          atlasFirstSource: "SIGNUP", // wrong — should still be DEMO
          atlasLastSource: "SIGNUP",
          name: { firstName: "Alice" },
        },
      ],
      notes: [],
    };
    const diff = computeDiff(expected, observed);
    expect(diff.mismatchedPersons).toEqual([
      {
        email: "a@b.com",
        field: "atlasFirstSource",
        expected: "DEMO",
        observed: "SIGNUP",
      },
    ]);
    expect(isClean(diff)).toBe(false);
  });

  test("the #2865 bug — N expected Persons all collapse onto one observed Person", () => {
    // 10 distinct emails → 1 Person in observed (the filter bug). The diff
    // surfaces this as 9 missing Persons AND a noteCountMismatch on the
    // one observed Person whose Notes ballooned to 10.
    const events: AtlasLeadEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(makeSalesForm(`p${i}@example.com`, `Person ${i}`, `Co ${i}`));
    }
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        {
          id: "p_collapsed",
          email: "p0@example.com",
          atlasFirstSource: "SALES_FORM",
          atlasLastSource: "SALES_FORM",
        },
      ],
      notes: events.map((e, i) => ({
        id: `n_${i}`,
        title: `Talk to sales — Co ${i} (Pro)`,
        body: "msg",
        personEmail: "p0@example.com", // all linked to the one collapsed Person
      })),
    };
    const diff = computeDiff(expected, observed);
    expect(diff.missingPersons).toHaveLength(9);
    // Source fields on p0 happen to match (both SALES_FORM) but name fields
    // don't because the observed payload was constructed without a name —
    // i.e. the dispatcher's PATCH-every-write merged inconsistent names
    // across dispatches. Pin that the SOURCE fields specifically didn't
    // mismatch: that's how the diagnostic visually separates "wrong Person
    // entirely" (missingPersons) from "wrong attribution on the right
    // Person" (mismatchedPersons on atlasFirstSource / atlasLastSource).
    const sourceMismatches = diff.mismatchedPersons.filter(
      (m) =>
        m.email === "p0@example.com" &&
        (m.field === "atlasFirstSource" || m.field === "atlasLastSource"),
    );
    expect(sourceMismatches).toHaveLength(0);
    // Note-count mismatch on the collapsed Person: expected 1 note for p0,
    // observed 10 notes (all the other personas' notes piled on).
    expect(diff.noteCountMismatches).toContainEqual({
      personEmail: "p0@example.com",
      expected: 1,
      observed: 10,
    });
    expect(isClean(diff)).toBe(false);
  });

  test("atlasIp mismatch on an existing Person is surfaced", () => {
    // The #2737-shape regression: dispatcher writes atlasIp on the wrong
    // Person. The fixture supplied 1.2.3.4 but Twenty has 9.9.9.9.
    const events: AtlasLeadEvent[] = [
      { source: "demo", email: "alice@example.com", ip: "1.2.3.4", userAgent: null },
    ];
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        {
          id: "p_1",
          email: "alice@example.com",
          atlasFirstSource: "DEMO",
          atlasLastSource: "DEMO",
          atlasIp: "9.9.9.9",
        },
      ],
      notes: [],
    };
    const diff = computeDiff(expected, observed);
    expect(diff.mismatchedPersons).toContainEqual({
      email: "alice@example.com",
      field: "atlasIp",
      expected: "1.2.3.4",
      observed: "9.9.9.9",
    });
    expect(isClean(diff)).toBe(false);
  });

  test("atlasStripeCustomerId mismatch on an existing Person is surfaced", () => {
    // The #2737-shape regression: Stripe conversion stamps the wrong cus_
    // on the matching Twenty Person. Without this check the smoke would
    // report clean on a real attribution bug.
    const events: AtlasLeadEvent[] = [
      {
        source: "conversion",
        email: "paying@example.com",
        stripeCustomerId: "cus_expected",
      },
    ];
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        {
          id: "p_1",
          email: "paying@example.com",
          atlasFirstSource: "CONVERSION",
          atlasLastSource: "CONVERSION",
          atlasStripeCustomerId: "cus_wrong",
        },
      ],
      notes: [],
    };
    const diff = computeDiff(expected, observed);
    expect(diff.mismatchedPersons).toContainEqual({
      email: "paying@example.com",
      field: "atlasStripeCustomerId",
      expected: "cus_expected",
      observed: "cus_wrong",
    });
    expect(isClean(diff)).toBe(false);
  });

  test("duplicate observed Persons surface as duplicateObservedEmails (#2865 dedupe regression)", () => {
    // Codex P2-E: a dedupe regression in upsertPerson can leave two Person
    // rows with the same primary email. The first one wins the Map lookup
    // and the second is silently dropped — masking the real bug. Surface
    // as a dedicated category.
    const events: AtlasLeadEvent[] = [
      { source: "demo", email: "alice@example.com", ip: null, userAgent: null },
    ];
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        {
          id: "p_1",
          email: "alice@example.com",
          atlasFirstSource: "DEMO",
          atlasLastSource: "DEMO",
        },
        {
          id: "p_2",
          email: "alice@example.com",
          atlasFirstSource: "SIGNUP",
          atlasLastSource: "SIGNUP",
        },
      ],
      notes: [],
    };
    const diff = computeDiff(expected, observed);
    expect(diff.duplicateObservedEmails).toEqual(["alice@example.com"]);
    expect(isClean(diff)).toBe(false);
  });

  test("no-wipe mode tolerates a duplicate on a NON-fixture email (shared staging workspace)", () => {
    // The unattended staging smoke (#2898) runs without --wipe-twenty against
    // a shared Twenty workspace that may already hold unrelated duplicate
    // leads. A duplicate on an email the fixture never touched must NOT fail
    // the smoke — otherwise one stray pre-existing dup fails every deploy.
    // Mirrors the `unexpectedPersons` informational-by-default rule. (Codex
    // P2 on PR #3090.)
    const events: AtlasLeadEvent[] = [
      { source: "demo", email: "fixture@example.com", ip: null, userAgent: null },
    ];
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        { id: "p_1", email: "fixture@example.com", atlasFirstSource: "DEMO", atlasLastSource: "DEMO" },
        { id: "p_2", email: "stranger@example.com" }, // unrelated pre-existing dup
        { id: "p_3", email: "stranger@example.com" },
      ],
      notes: [],
    };
    const diff = computeDiff(expected, observed);
    expect(diff.duplicateObservedEmails).toEqual([]);
    expect(isClean(diff)).toBe(true);
  });

  test("a duplicate ON a fixture email is still dirty in no-wipe mode (#2865 still caught)", () => {
    // Scoping duplicates to fixture emails must NOT weaken #2865 detection:
    // the upsert-dedup regression duplicates the fixture rows too.
    const events: AtlasLeadEvent[] = [
      { source: "demo", email: "fixture@example.com", ip: null, userAgent: null },
    ];
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        { id: "p_1", email: "fixture@example.com", atlasFirstSource: "DEMO", atlasLastSource: "DEMO" },
        { id: "p_2", email: "fixture@example.com", atlasFirstSource: "DEMO", atlasLastSource: "DEMO" },
      ],
      notes: [],
    };
    const diff = computeDiff(expected, observed);
    expect(diff.duplicateObservedEmails).toEqual(["fixture@example.com"]);
    expect(isClean(diff)).toBe(false);
  });

  test("strict-workspace mode widens the duplicate check to ANY email (post-wipe must be pristine)", () => {
    // After --wipe-twenty the workspace should be empty before the smoke runs,
    // so a duplicate anywhere — fixture email or not — means the wipe was
    // partial / a dedupe regression is live. Strict widens the scope to global.
    const events: AtlasLeadEvent[] = [
      { source: "demo", email: "fixture@example.com", ip: null, userAgent: null },
    ];
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        { id: "p_1", email: "fixture@example.com", atlasFirstSource: "DEMO", atlasLastSource: "DEMO" },
        { id: "p_2", email: "stranger@example.com" },
        { id: "p_3", email: "stranger@example.com" },
      ],
      notes: [],
    };
    const lenient = computeDiff(expected, observed);
    expect(lenient.duplicateObservedEmails).toEqual([]); // tolerated no-wipe
    expect(isClean(lenient)).toBe(true);
    const strict = computeDiff(expected, observed, { requireCleanWorkspace: true });
    expect(strict.duplicateObservedEmails).toEqual(["stranger@example.com"]);
    expect(isClean(strict)).toBe(false);
  });

  test("strict-workspace mode flips unexpectedPersons from informational to dirty", () => {
    // Codex P2-A: after --wipe-twenty the workspace should be empty before
    // the smoke runs. Residual rows = partial/truncated wipe = dirty.
    const events: AtlasLeadEvent[] = [
      { source: "demo", email: "alice@example.com", ip: null, userAgent: null },
    ];
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        {
          id: "p_1",
          email: "alice@example.com",
          atlasFirstSource: "DEMO",
          atlasLastSource: "DEMO",
        },
        {
          id: "p_2",
          email: "leftover@example.com", // residual — wipe missed it
        },
      ],
      notes: [],
    };
    const lenient = computeDiff(expected, observed);
    expect(isClean(lenient)).toBe(true); // informational by default
    const strict = computeDiff(expected, observed, { requireCleanWorkspace: true });
    expect(strict.unexpectedPersons).toEqual(["leftover@example.com"]);
    expect(strict.strictWorkspace).toBe(true);
    expect(isClean(strict)).toBe(false);
  });

  test("note diff matches on body too — right title, wrong body is dirty (Codex P2-D)", () => {
    // Catches the case where a Note's title is correct (so a title-only
    // check would pass) but the body got swapped — exactly what would
    // happen if a dispatcher dropped the message field on a sales-form.
    const events: AtlasLeadEvent[] = [
      {
        source: "sales-form",
        email: "alice@example.com",
        name: "Alice A",
        company: "Acme",
        planInterest: "Pro",
        message: "I want the right body",
        ip: null,
        userAgent: null,
      },
    ];
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        {
          id: "p_1",
          email: "alice@example.com",
          atlasFirstSource: "SALES_FORM",
          atlasLastSource: "SALES_FORM",
          name: { firstName: "Alice", lastName: "A" },
        },
      ],
      notes: [
        {
          id: "n_1",
          title: "Talk to sales — Acme (Pro)", // right title
          body: "WRONG BODY",
          personEmail: "alice@example.com",
        },
      ],
    };
    const diff = computeDiff(expected, observed);
    expect(diff.missingNotes).toHaveLength(1);
    expect(diff.missingNotes[0].body).toBe("I want the right body");
    expect(isClean(diff)).toBe(false);
  });

  test("note diff multiplicity — expected 2 same-titled notes, observed 1 is dirty (Codex P2-B)", () => {
    // Same-titled sales-form events on the same email = 2 distinct notes
    // (per #2729 idempotency contract within row, distinct rows produce
    // distinct notes). A title-only contains-check would pass.
    const events: AtlasLeadEvent[] = [
      makeSalesForm("a@b.com", "Alice A", "Acme"),
      makeSalesForm("a@b.com", "Alice A", "Acme"),
    ];
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        {
          id: "p_1",
          email: "a@b.com",
          atlasFirstSource: "SALES_FORM",
          atlasLastSource: "SALES_FORM",
          name: { firstName: "Alice", lastName: "A" },
        },
      ],
      notes: [
        {
          id: "n_1",
          title: "Talk to sales — Acme (Pro)",
          body: "msg",
          personEmail: "a@b.com",
        },
        // The second note is missing.
      ],
    };
    const diff = computeDiff(expected, observed);
    // missingNotes counts the multiplicity gap (expected 2, observed 1 = 1 missing).
    expect(diff.missingNotes).toHaveLength(1);
    // noteCountMismatches also fires on the per-email total.
    expect(diff.noteCountMismatches).toContainEqual({
      personEmail: "a@b.com",
      expected: 2,
      observed: 1,
    });
    expect(isClean(diff)).toBe(false);
  });

  test("atlasIp absent from fixture → no atlasIp check is emitted (no false positive)", () => {
    // Many personas don't carry an IP. The diff must not fire a mismatch on
    // `expected="(unset)", observed="(unset)"` in that case.
    const events: AtlasLeadEvent[] = [
      { source: "demo", email: "alice@example.com", ip: null, userAgent: null },
    ];
    const expected = buildExpectedState(events);
    const observed: ObservedState = {
      persons: [
        {
          id: "p_1",
          email: "alice@example.com",
          atlasFirstSource: "DEMO",
          atlasLastSource: "DEMO",
        },
      ],
      notes: [],
    };
    const diff = computeDiff(expected, observed);
    expect(diff.mismatchedPersons).toEqual([]);
    expect(isClean(diff)).toBe(true);
  });

  test("note count mismatch (expected 1, observed 2) is dirty", () => {
    const expected: ExpectedNote[] = [
      { personEmail: "a@b.com", title: "T", body: "B" },
    ];
    const observed: ObservedState = {
      persons: [{ id: "p_1", email: "a@b.com", atlasFirstSource: "SALES_FORM", atlasLastSource: "SALES_FORM" }],
      notes: [
        { id: "n_1", title: "T", body: "B", personEmail: "a@b.com" },
        { id: "n_2", title: "T", body: "B", personEmail: "a@b.com" }, // duplicate
      ],
    };
    const diff = computeDiff(
      {
        persons: [
          {
            email: "a@b.com",
            atlasFirstSource: "SALES_FORM",
            atlasLastSource: "SALES_FORM",
          },
        ],
        notes: expected,
      },
      observed,
    );
    expect(diff.noteCountMismatches).toEqual([
      { personEmail: "a@b.com", expected: 1, observed: 2 },
    ]);
    expect(isClean(diff)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  formatDiff
// ─────────────────────────────────────────────────────────────────────

describe("formatDiff", () => {
  test("clean diff renders a single ✓ line", () => {
    const out = formatDiff(
      {
        missingPersons: [],
        unexpectedPersons: [],
        duplicateObservedEmails: [],
        mismatchedPersons: [],
        missingNotes: [],
        noteCountMismatches: [],
        strictWorkspace: false,
      },
      {
        totals: {
          expectedPersons: 1,
          observedPersons: 1,
          expectedNotes: 0,
          observedNotes: 0,
        },
      },
    );
    expect(out).toContain("✓ Diff is clean");
    expect(out).toContain("Totals:");
  });

  test("dirty diff lists every category that has at least one finding", () => {
    const out = formatDiff({
      missingPersons: ["a@b.com"],
      unexpectedPersons: ["pre@x.com"],
      duplicateObservedEmails: ["dup@x.com"],
      mismatchedPersons: [
        { email: "c@d.com", field: "atlasFirstSource", expected: "DEMO", observed: "SIGNUP" },
      ],
      missingNotes: [{ personEmail: "e@f.com", title: "T", body: "B" }],
      noteCountMismatches: [{ personEmail: "g@h.com", expected: 1, observed: 2 }],
      strictWorkspace: false,
    });
    expect(out).toContain("Missing Persons (1)");
    expect(out).toContain("Unexpected Persons");
    expect(out).toContain("Field mismatches (1)");
    expect(out).toContain("c@d.com :: atlasFirstSource");
    expect(out).toContain("Missing Notes (1)");
    expect(out).toContain("Note count mismatches (1)");
    expect(out).toContain("g@h.com: expected 1, observed 2");
    expect(out).toContain("Duplicate observed Persons (1)");
    expect(out).toContain("dup@x.com");
    expect(out).not.toContain("✓ Diff is clean");
  });

  test("renders (unset) when observed field is missing", () => {
    // Catches a regression where missing observed fields render as "undefined".
    const out = formatDiff({
      missingPersons: [],
      unexpectedPersons: [],
      duplicateObservedEmails: [],
      mismatchedPersons: [
        { email: "a@b.com", field: "atlasFirstSource", expected: "DEMO", observed: "(unset)" },
      ],
      missingNotes: [],
      noteCountMismatches: [],
      strictWorkspace: false,
    });
    expect(out).toContain('observed="(unset)"');
    expect(out).not.toContain("undefined");
  });

  test("unexpectedPersons label flips to ✗ in strictWorkspace mode (post-wipe)", () => {
    // Codex P2-A: after --wipe-twenty the workspace is supposed to be
    // deterministic; residual rows mean partial / truncated wipe.
    const out = formatDiff({
      missingPersons: [],
      unexpectedPersons: ["leftover@x.com"],
      duplicateObservedEmails: [],
      mismatchedPersons: [],
      missingNotes: [],
      noteCountMismatches: [],
      strictWorkspace: true,
    });
    expect(out).toContain("✗ Unexpected Persons");
    expect(out).toContain("wipe did not fully drain");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

function makeSalesForm(
  email: string,
  name: string,
  company: string,
): AtlasLeadEvent {
  return {
    source: "sales-form",
    email,
    name,
    company,
    planInterest: "Pro",
    message: "msg",
    ip: null,
    userAgent: null,
  };
}
