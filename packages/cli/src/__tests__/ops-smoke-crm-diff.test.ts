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
    // Note-count mismatch on the collapsed Person: expected 1 note for p0,
    // observed 10 notes (all the other personas' notes piled on).
    expect(diff.noteCountMismatches).toContainEqual({
      personEmail: "p0@example.com",
      expected: 1,
      observed: 10,
    });
    expect(isClean(diff)).toBe(false);
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
        mismatchedPersons: [],
        missingNotes: [],
        noteCountMismatches: [],
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
      mismatchedPersons: [
        { email: "c@d.com", field: "atlasFirstSource", expected: "DEMO", observed: "SIGNUP" },
      ],
      missingNotes: [{ personEmail: "e@f.com", title: "T", body: "B" }],
      noteCountMismatches: [{ personEmail: "g@h.com", expected: 1, observed: 2 }],
    });
    expect(out).toContain("Missing Persons (1)");
    expect(out).toContain("Unexpected Persons");
    expect(out).toContain("Field mismatches (1)");
    expect(out).toContain("c@d.com :: atlasFirstSource");
    expect(out).toContain("Missing Notes (1)");
    expect(out).toContain("Note count mismatches (1)");
    expect(out).toContain("g@h.com: expected 1, observed 2");
    expect(out).not.toContain("✓ Diff is clean");
  });

  test("renders (unset) when observed field is missing", () => {
    // Catches a regression where missing observed fields render as "undefined".
    const out = formatDiff({
      missingPersons: [],
      unexpectedPersons: [],
      mismatchedPersons: [
        { email: "a@b.com", field: "atlasFirstSource", expected: "DEMO", observed: "(unset)" },
      ],
      missingNotes: [],
      noteCountMismatches: [],
    });
    expect(out).toContain('observed="(unset)"');
    expect(out).not.toContain("undefined");
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
