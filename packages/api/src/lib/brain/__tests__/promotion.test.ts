/**
 * Unit tests for the fact class's promotion refusals (#4769).
 *
 * The rules split into two very different kinds and the tests say which is
 * which, because a reader who assumes they are all live will delete the
 * "redundant" ones:
 *
 *   - `GRANT_UNUSABLE` is LIVE. `visible_to = ['everyone']` passes migration
 *     0180's CHECK, is storable today, and grants nobody access. The live-PG
 *     suite proves both halves (storable, and refused at promotion).
 *   - The provenance rules are DEFENSE IN DEPTH — unreachable today because
 *     the schema forbids the state. Exercised here against constructed rows,
 *     with `promotion-pg.test.ts` asserting that the CHECK is what refuses in
 *     the real database. Constructing an impossible row in a UNIT test is
 *     honest (it tests the classifier); inserting one in a PG test would not be.
 */

import { describe, expect, it } from "bun:test";
import {
  classifyFactForPromotion,
  FACT_REFUSAL_REASONS,
  GRANT_GRAMMAR_HINT,
  type DraftFactRow,
} from "@atlas/api/lib/brain/promotion";

/** A fact that satisfies every rule — the baseline each case perturbs. */
function validRow(over: Partial<DraftFactRow> = {}): DraftFactRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    subject: "acme",
    predicate: "uses",
    object: "postgres",
    source_episode_id: "22222222-2222-4222-8222-222222222222",
    provenance: { actor: "slack:U123", messageTs: "1700000000.0001" },
    visible_to: ["org"],
    ...over,
  };
}

describe("classifyFactForPromotion — promotable", () => {
  it("returns null for a fact with provenance and an org grant", () => {
    expect(classifyFactForPromotion(validRow())).toBeNull();
  });

  it.each([
    ["org", ["org"]],
    ["role", ["role:admin"]],
    ["user", ["user:abc"]],
    ["audience", ["audience:exec"]],
  ])("accepts a %s grant", (_label, visibleTo) => {
    expect(classifyFactForPromotion(validRow({ visible_to: visibleTo }))).toBeNull();
  });

  it("accepts a grant that is PARTLY malformed as long as one token is usable", () => {
    // Deliberate: `acl.ts` may never be stricter than the 0180 CHECK, and a
    // grant like this is enforceable — the valid token does real work while the
    // junk one matches nothing. `logGrantAnomalies` is what reports it; refusing
    // promotion here would make a legally-stored row unpublishable.
    expect(
      classifyFactForPromotion(validRow({ visible_to: ["everyone", "user:abc"] })),
    ).toBeNull();
  });
});

describe("classifyFactForPromotion — GRANT_UNUSABLE (the live rule)", () => {
  it("refuses a grant whose every token is outside the grammar", () => {
    const refusal = classifyFactForPromotion(validRow({ visible_to: ["everyone"] }));
    expect(refusal?.reasons).toEqual([FACT_REFUSAL_REASONS.grantUnusable]);
    // The offending token is quoted back — an admin cannot fix "the grant is
    // bad", only "`everyone` is not a principal".
    expect(refusal?.detail).toContain('"everyone"');
    expect(refusal?.rowId).toBe(validRow().id);
  });

  it.each([
    ["a platform role, which is outside the grammar by design", ["role:platform_admin"]],
    ["a wrong-cased token — matching is byte-exact", ["ROLE:admin"]],
    ["a bare prefix with no id", ["user:"]],
    ["an unknown namespace", ["team:eng"]],
  ])("refuses %s", (_label, visibleTo) => {
    expect(classifyFactForPromotion(validRow({ visible_to: visibleTo }))?.reasons).toEqual([
      FACT_REFUSAL_REASONS.grantUnusable,
    ]);
  });

  it.each([
    ["an empty array", []],
    ["NULL and '' elements only", [null, ""]],
  ])("refuses %s", (_label, visibleTo) => {
    expect(
      classifyFactForPromotion(validRow({ visible_to: visibleTo }))?.reasons,
    ).toEqual([FACT_REFUSAL_REASONS.grantUnusable]);
  });

  it("names the empty/null class instead of quoting it as an empty string", () => {
    // `parseGrant` reports every non-string element as `''`, so a raw
    // `JSON.stringify` join renders `[null, null]` as `"", ""` and sends the
    // reader hunting for empty strings that are not in their data.
    const refusal = classifyFactForPromotion(validRow({ visible_to: [null, null] }));
    expect(refusal?.detail).toContain("2 empty or null entries");
    expect(refusal?.detail).not.toContain('""');
  });

  it("tells the admin what a valid grant looks like", () => {
    // The refusal is only actionable if it says what to do next.
    const refusal = classifyFactForPromotion(validRow({ visible_to: ["everyone"] }));
    expect(refusal?.detail).toContain(GRANT_GRAMMAR_HINT);
  });
});

describe("classifyFactForPromotion — GRANT_NOT_AN_ARRAY (query drift, not bad data)", () => {
  it.each([
    ["a bare string", "org"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
  ])("refuses %s under its own code", (_label, visibleTo) => {
    // `visible_to text[] NOT NULL` makes this unreachable from the database, so
    // it is an Atlas bug. Reporting it as GRANT_UNUSABLE would tell the admin
    // their fact is wrong and send the investigation to the wrong place.
    const refusal = classifyFactForPromotion(validRow({ visible_to: visibleTo }));
    expect(refusal?.reasons).toEqual([FACT_REFUSAL_REASONS.grantNotAnArray]);
    expect(refusal?.detail).toContain("Atlas bug");
  });

  it("still fails CLOSED — a shape it cannot parse is never promoted", () => {
    expect(classifyFactForPromotion(validRow({ visible_to: "org" }))).not.toBeNull();
  });
});

describe("classifyFactForPromotion — provenance (defense in depth)", () => {
  it.each([
    ["a null episode id", null],
    ["an empty episode id", ""],
    ["a whitespace-only episode id", "   "],
  ])("refuses %s as PROVENANCE_MISSING", (_label, sourceEpisodeId) => {
    expect(
      classifyFactForPromotion(validRow({ source_episode_id: sourceEpisodeId }))?.reasons,
    ).toEqual([FACT_REFUSAL_REASONS.provenanceMissing]);
  });

  it.each([
    ["an empty object", {}],
    ["null", null],
    ["an array (jsonb_typeof would say 'array')", [{ actor: "x" }]],
    ["a bare string", "slack"],
  ])("refuses %s as PROVENANCE_EMPTY", (_label, provenance) => {
    expect(classifyFactForPromotion(validRow({ provenance }))?.reasons).toEqual([
      FACT_REFUSAL_REASONS.provenanceEmpty,
    ]);
  });
});

describe("classifyFactForPromotion — reporting", () => {
  it("collects EVERY broken rule, not just the first", () => {
    // One publish cycle per defect would turn a single repair into three.
    const refusal = classifyFactForPromotion(
      validRow({ source_episode_id: null, provenance: {}, visible_to: ["everyone"] }),
    );
    expect(refusal?.reasons).toEqual([
      FACT_REFUSAL_REASONS.provenanceMissing,
      FACT_REFUSAL_REASONS.provenanceEmpty,
      FACT_REFUSAL_REASONS.grantUnusable,
    ]);
  });

  it("names the CLAIM, not just the uuid, and says it is still a draft", () => {
    const refusal = classifyFactForPromotion(validRow({ visible_to: ["everyone"] }));
    // A uuid alone is unactionable: #4772's review surface has not shipped and
    // the publish preview (which renders the claim) is a different response.
    expect(refusal?.detail).toContain("acme uses postgres");
    expect(refusal?.detail).toContain(validRow().id);
    expect(refusal?.detail).toContain("still a draft");
  });

  it("reads as sentences — no run-on where two rules join", () => {
    // The grant arm ends in a full sentence (the grammar hint); the provenance
    // arms do not. Without normalization the join produced "…behind it Fix it".
    const refusal = classifyFactForPromotion(
      validRow({ source_episode_id: null, visible_to: ["org"] }),
    );
    expect(refusal?.detail).toContain("evidence behind it. Fix it");
  });
});
