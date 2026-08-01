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
  widenGrantFromEvidence,
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

  it("does NOT read provenance.source — the #4964 quarantine stops at correction", () => {
    // A deliberate asymmetry, characterized here so it cannot drift silently
    // in either direction. `correction.ts` refuses every correction verb on a
    // fact whose `provenance.source` this deployment cannot classify; this
    // function is the review queue's gate and reads no source vocabulary at
    // all, so such a draft stays PROMOTABLE while being un-rejectable.
    //
    // That is not the ADR-0036 §T4 invariant leaking. Tier-1 facts are computed
    // live and have no table (`lib/brain/acl.ts`), so anything in `brain_facts`
    // is tier-2/3 and publishing it is an ordinary review decision rather than
    // an arbitration over the warehouse. Tightening this to match the
    // correction gate would strand every imported draft in a queue no reviewer
    // could clear — so if a later change makes these red, that is the decision
    // being revisited, not a bug being fixed.
    for (const source of ["snowflake", "warehouse:prod", "", null, 42]) {
      expect([source, classifyFactForPromotion(validRow({ provenance: { source } }))]).toEqual([
        source,
        null,
      ]);
    }
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

// ══════════════════════════════════════════════════════════════════════
// `widenGrantFromEvidence` (#4823)
// ══════════════════════════════════════════════════════════════════════

describe("widenGrantFromEvidence", () => {
  const PRIVATE = "audience:chat-channel:slack:C0BKTMEDUN9";

  it("returns null when there is no evidence at all", () => {
    // `null`, not an empty widening: the caller must take the cheap blanket
    // promote that never rewrites `visible_to`, and the type is what forces it.
    expect(widenGrantFromEvidence([PRIVATE], [])).toBeNull();
  });

  it("returns null when every evidence episode is granted the same way", () => {
    // The overwhelmingly common case — one claim, one channel. It must not
    // cost an UPDATE that touches an ACL column.
    expect(widenGrantFromEvidence([PRIVATE], [[PRIVATE], [PRIVATE]])).toBeNull();
  });

  it("unions in a wider evidence grant — the cross-grant corroboration case", () => {
    // Same sentence in a private channel, then in a public one four minutes
    // later (#4823, found in the Brain M1 staging soak).
    const result = widenGrantFromEvidence([PRIVATE], [[PRIVATE], ["org"]]);
    expect(result?.added).toEqual(["org"]);
    expect(result?.grant).toEqual([PRIVATE, "org"]);
  });

  it("is APPEND-ONLY — it can never remove a token, so it can never narrow", () => {
    // The single property that makes this safe to run unattended in a publish.
    // `org` is subsumed by nothing, and even so a narrower episode leaves it in
    // place; the result is a superset of the input, always.
    expect(widenGrantFromEvidence(["org"], [[PRIVATE]])?.grant).toEqual(["org", PRIVATE]);
  });

  it("preserves the fact's own tokens verbatim, malformed ones included", () => {
    // Repairing a grant is `logGrantAnomalies`'s job to REPORT, not this
    // function's to do silently — an operator has to see `everyone` to fix the
    // deriver that emitted it.
    const result = widenGrantFromEvidence(["everyone", PRIVATE], [["org"]]);
    expect(result?.grant).toEqual(["everyone", PRIVATE, "org"]);
  });

  it("preserves a NULL element in place", () => {
    // `visible_to` may legally hold NULL beside a usable token. It is not a
    // token, matches nothing, and must survive the append untouched — this
    // value is written straight back into the column.
    const result = widenGrantFromEvidence([PRIVATE, null], [["org"]]);
    expect(result?.grant).toEqual([PRIVATE, null, "org"]);
  });

  it("never copies a malformed token OUT of the evidence", () => {
    // It grants nobody anything, so copying it spreads an anomaly to a second
    // row for no reader's benefit.
    const result = widenGrantFromEvidence([PRIVATE], [["everyone", null, "", "org"]]);
    expect(result?.added).toEqual(["org"]);
  });

  it("never copies `role:platform_admin` — a cross-tenant token is not a principal", () => {
    // Deliberately outside the grammar (`acl.ts`): ADR-0036 scopes the
    // admin/audit override to a region and admits no super-admin arm. An
    // evidence grant carrying it must contribute nothing.
    expect(widenGrantFromEvidence([PRIVATE], [["role:platform_admin"]])).toBeNull();
  });

  it("returns null when the fact already holds every evidence token", () => {
    expect(
      widenGrantFromEvidence(["org", PRIVATE], [["org"], [PRIVATE], ["org"]]),
    ).toBeNull();
  });

  it("dedupes across evidence episodes", () => {
    const result = widenGrantFromEvidence([PRIVATE], [["org"], ["org"], ["role:admin"]]);
    expect(result?.added).toEqual(["org", "role:admin"]);
  });

  it("unions INCOMPARABLE audiences rather than picking one", () => {
    // "Widest" is not a total order — two private channels are incomparable —
    // but visibility is token overlap, so the union is the least upper bound,
    // and a reader of either channel already saw the claim said there.
    const other = "audience:chat-channel:slack:C0BBXHYHQQ7";
    expect(widenGrantFromEvidence([PRIVATE], [[other]])?.grant).toEqual([PRIVATE, other]);
  });

  it("does NOT collapse to `org` when `org` is present", () => {
    // `org` subsumes every other principal, so `['audience:X','org']` is
    // redundant — and kept anyway. The pair records that the claim was made
    // both privately and publicly; collapsing would turn an append into a
    // rewrite and lose that.
    const result = widenGrantFromEvidence([PRIVATE], [["org"]]);
    expect(result?.grant).toContain(PRIVATE);
    expect(result?.grant).toContain("org");
  });

  it("round-trips tokens byte-exactly — it never re-spells a principal", () => {
    // `parseGrant` → `formatPrincipal` is the path an added token takes. If it
    // normalised case or trimmed, the stored token would stop matching
    // Postgres's byte-exact `&&` and the widening would grant nobody anything.
    const result = widenGrantFromEvidence(["org"], [["user:UPPER-Case_id.42"]]);
    expect(result?.added).toEqual(["user:UPPER-Case_id.42"]);
  });

  it("appends in evidence order, so the stored grant is deterministic", () => {
    const other = "audience:chat-channel:slack:C0BBXHYHQQ7";
    expect(widenGrantFromEvidence([PRIVATE], [["org"], [other]])?.added).toEqual([
      "org",
      other,
    ]);
    expect(widenGrantFromEvidence([PRIVATE], [[other], ["org"]])?.added).toEqual([
      other,
      "org",
    ]);
  });
});
