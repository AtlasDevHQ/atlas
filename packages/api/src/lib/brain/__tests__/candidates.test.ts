/**
 * Unit coverage for the fact-candidate read model (#4772, ADR-0036).
 *
 * The claims worth pinning here are the ones a green build would otherwise
 * hide, so most of these tests probe the guard rather than the happy path:
 *
 *   - the EPISODE is gated by its own predicate, not the fact's — the likeliest
 *     leak in the slice, and a join would pass every other test in this file;
 *   - a withheld episode / counterpart is REPORTED, never dropped, because a
 *     dropped conflict reads as "nothing contradicts this";
 *   - contradiction hints surface from BOTH edge directions and are never
 *     ordered by anything that would imply a ranking;
 *   - rejection never mentions `status` in its UPDATE (the promotion guard
 *     refuses that shape, and `scripts/check-brain-fact-promotion.sh` is a grep
 *     — this test is what makes the intent survive a refactor);
 *   - `provisional` is detected by KEY PRESENCE, since it is written only when
 *     true.
 *
 * A literal `BrainCandidateReader` stands in for the pool — no `mock.module()`,
 * no singleton mutation. The live-Postgres half (that the emitted SQL actually
 * selects what these tests assume) belongs with the `-pg` suites.
 */

import { describe, expect, it } from "bun:test";
import {
  BrainReaderUnresolvedError,
  CANDIDATE_PAGE_MAX,
  EPISODE_BODY_MAX_CHARS,
  TENSION_FANOUT_CAP,
  loadFactCandidateSummary,
  loadFactCandidates,
  projectProvenance,
  type BrainCandidateReader,
} from "@atlas/api/lib/brain/candidates";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { DECAY_STALE_AFTER_DAYS } from "@atlas/api/lib/brain/staleness";
import {
  BrainFactCandidateListResponseSchema,
  BrainFactDecayViewSchema,
  BrainFactProvenanceViewSchema,
} from "@useatlas/schemas";

const WS = "ws-candidates-test";

function ctx(partial: Partial<Extract<BrainPrincipalContext, { origin: "authenticated" }>> = {}): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-1",
    role: "admin",
    audienceIds: [],
    ...partial,
  };
}

interface Call {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * A reader that answers each statement from a queue keyed by a substring of the
 * SQL, and records every call so a test can assert on the emitted statement
 * itself — which is the only way to prove the episode read carries the EPISODE
 * table's predicate rather than the fact's.
 *
 * A key must match EXACTLY ONE of the statements this module emits, and that
 * is enforced rather than assumed (the same guard `search.test.ts` carries,
 * for the same reason). The collision is already live: `TENSION_EXISTS_SELECT`
 * puts `edge_type = 'in-tension-with'` into the FACT PAGE's `WHERE` whenever
 * `inTensionOnly` is set, so the first test combining that filter with a
 * tension fixture has two keys matching one statement. Whether that is loud
 * or silent is down to array order alone — `find()` is first-match-wins, so
 * listing the tension fixture first hands the fact page the WRONG rows and the
 * assertions pass against them.
 */
function reader(
  responses: Array<{ match: string; rows: Record<string, unknown>[]; rowCount?: number }>,
): BrainCandidateReader & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const hits = responses.filter((r) => sql.includes(r.match));
      if (hits.length > 1) {
        throw new Error(
          `ambiguous SQL fixture key: ${hits.map((h) => JSON.stringify(h.match)).join(", ")} all match one statement — one of them must move to a fragment exactly one statement emits`,
        );
      }
      const hit = hits[0];
      return { rows: hit?.rows ?? [], rowCount: hit?.rowCount ?? hit?.rows.length ?? 0 };
    },
  };
}

const ISO = "2026-07-01T00:00:00.000Z";

function factRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fact-1",
    subject: "Acme",
    predicate: "uses",
    object: "Postgres",
    status: "draft",
    predicate_cardinality: "multi",
    visible_to: ["org"],
    pre_widening_visible_to: null,
    provenance: {
      source: "slack",
      sourceId: "C1/17",
      episodeId: "ep-1",
      actor: "U1",
      producer: "extraction:v1",
      occurredAt: ISO,
      extractedAt: ISO,
      reconciledAt: ISO,
    },
    source_episode_id: "ep-1",
    valid_from: null,
    valid_to: null,
    invalidated_at: null,
    extracted_at: ISO,
    ingested_at: ISO,
    updated_at: ISO,
    corroboration_count: 2,
    // Selected by the page query (#4914) and NULL when the fact has no
    // provenance edges — faithful to the real projection, so no test row
    // trips the decay drift arm by accident.
    last_observed_at: null,
    total_count: 1,
    ...overrides,
  };
}

describe("projectProvenance", () => {
  it("flags provisional on key PRESENCE, not truthiness", () => {
    // `provisional` is written only when true, so a filter keyed on the value
    // would be defeated the moment a producer started writing `false`.
    expect(projectProvenance({ provisional: true }, null, "disclose").provisional).toBe(true);
    expect(projectProvenance({}, null, "disclose").provisional).toBe(false);
    expect(projectProvenance({ provisional: false }, null, "disclose").provisional).toBe(false);
  });

  // #4939 — an INVERSE guard. The three correction markers
  // (`MERGE_PROVENANCE_MARKER_SQL`) are written and read by nothing. Plenty of
  // code reads the `provenance` PAYLOAD — `isWarehouseDerived`,
  // `classifyFactForPromotion`, the `jsonb_exists(…, 'provisional')` filter —
  // but this is the only thing that PROJECTS it onto a read surface, and it
  // whitelists its output keys, so all three markers are dropped here.
  //
  // That is a bounded, deliberate state, and the prose that used to imply
  // otherwise — `brain-corrections.mdx`'s `pin` section ("surfaces may read
  // the marker") and `lib/brain/correction.ts`'s matching header bullet — now
  // says so outright. This test fails the day one of the three gains a reader,
  // which is exactly when that prose becomes an understatement and should be
  // corrected in the same change.
  it("emits none of the three correction markers — nothing reads them yet, and the docs say so", () => {
    const marked = projectProvenance(
      {
        ...(factRow().provenance as object),
        reReview: { reason: "derives-from-retracted", retractedFactId: "f-1" },
        reAuthority: { actor: "admin-1", at: ISO },
        pinned: { actor: "admin-1", at: ISO },
      },
      null,
      "disclose",
    );
    for (const marker of ["reReview", "reAuthority", "pinned"]) {
      expect(
        marker in marked,
        `\`${marker}\` now reaches a read surface. That is a real improvement — and it makes the "nothing reads it yet" ` +
          "sentences in apps/docs/content/shared/guides/brain-corrections.mdx and lib/brain/correction.ts (the `pin` header " +
          "bullet and MERGE_PROVENANCE_MARKER_SQL's header) understatements. Correct them in this change, then update this guard.",
      ).toBe(false);
    }
    // The whitelist still did its ordinary job on the same payload, so this is
    // a statement about the markers rather than about a rejected payload.
    expect(marked.payloadComplete).toBe(true);
  });

  it("reports an incomplete payload rather than rendering blanks", () => {
    const complete = projectProvenance(factRow().provenance, null, "disclose");
    expect(complete.payloadComplete).toBe(true);

    // A renamed key must not read as "the producer recorded nothing".
    const renamed = projectProvenance(
      { ...(factRow().provenance as object), producer: undefined },
      null,
      "disclose",
    );
    expect(renamed.payloadComplete).toBe(false);
    expect(renamed.producer).toBeNull();
  });

  it("treats a null actor as present, since a source may have no author", () => {
    const p = projectProvenance(
      { ...(factRow().provenance as object), actor: null },
      null,
      "disclose",
    );
    expect(p.payloadComplete).toBe(true);
    expect(p.attribution).toEqual({ visible: true, sourceId: "C1/17", actor: null, occurredAt: ISO });
  });

  it("degrades a non-object payload to all-null instead of throwing", () => {
    const p = projectProvenance("not an object", null, "disclose");
    expect(p.payloadComplete).toBe(false);
    expect(p.episodeId).toBeNull();
  });

  it("keeps only real entity roles out of `unresolved`", () => {
    const p = projectProvenance({ provisional: true, unresolved: ["subject", "elbow"] }, null, "disclose");
    expect(p.unresolved).toEqual(["subject"]);
  });

  it("derives provisional from a side-list carrying no flag", () => {
    // Reachable through a region-import bundle. Without the OR it would present
    // as "resolved, but here are the unresolved sides".
    const p = projectProvenance({ unresolved: ["object"] }, null, "disclose");
    expect(p.provisional).toBe(true);
  });

  it("reports a provenance episode that disagrees with the FK column", () => {
    // The jsonb copy and `source_episode_id` naming different evidence for the
    // same claim is a real integrity failure on a provenance surface — and the
    // jsonb copy's only capability, absent this check, is to disagree.
    const p = projectProvenance(factRow().provenance, "some-other-episode", "disclose");
    expect(p.payloadComplete).toBe(false);
  });

  it("skips the episode cross-check when the caller has nothing to compare", () => {
    expect(projectProvenance(factRow().provenance, undefined, "disclose").payloadComplete).toBe(true);
    expect(projectProvenance(factRow().provenance, "ep-1", "disclose").payloadComplete).toBe(true);
  });

  it("reports an unparseable timestamp as an incomplete payload", () => {
    // Otherwise "Said at" renders a dash with no hint, which reads as "the
    // producer recorded nothing" rather than "Atlas lost track of it".
    const p = projectProvenance(
      { ...(factRow().provenance as object), occurredAt: "yesterday" },
      null,
      "disclose",
    );
    expect(p.payloadComplete).toBe(false);
  });

  it("treats a dropped nullable key as incomplete, not as a legitimate null", () => {
    const { occurredAt: _dropped, ...withoutKey } = factRow().provenance as Record<string, unknown>;
    expect(projectProvenance(withoutKey, null, "disclose").payloadComplete).toBe(false);
  });
});

describe("loadFactCandidates — visibility", () => {
  it("refuses to report an empty queue for a reader it could not resolve", async () => {
    // The dangerous alternative: return `{ candidates: [], total: 0 }`, which
    // the page renders as "Nothing to review — facts appear here once a
    // connector ingests episodes", directly above the button that publishes
    // every unreviewed draft in the workspace. There is no legitimate
    // no-principal reviewer here (`principalTokens` seeds `org` for both real
    // origins), so this is always an upstream defect and deserves a 500.
    const db = reader([]);
    await expect(
      loadFactCandidates(db, {
        ctx: { origin: "unresolved", workspaceId: WS, userId: null, role: null, audienceIds: [] },
        limit: 50,
        offset: 0,
      }),
    ).rejects.toBeInstanceOf(BrainReaderUnresolvedError);
    expect(db.calls).toHaveLength(0);
  });

  it("gates the episode with the EPISODE's predicate, not the fact's", async () => {
    // The whole point of the separate read. If this ever became a join off the
    // fact query, a private-channel message would reach a reviewer entitled
    // only to the conclusion drawn from it.
    const db = reader([
      { match: "FROM brain_facts f", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    const episodeCall = db.calls.find((c) => c.sql.includes("FROM brain_episodes e"));
    expect(episodeCall).toBeDefined();
    expect(episodeCall?.sql).toContain("e.visible_to &&");
    expect(episodeCall?.sql).toContain("e.workspace_id");
    // …and it is a statement of its own, not a join hanging off the facts read.
    expect(episodeCall?.sql).not.toContain("brain_facts");
  });

  it("reports a withheld episode instead of omitting it", async () => {
    const db = reader([
      { match: "FROM brain_facts f", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] }, // reader not entitled
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    // Not null: "there is evidence you may not read" must be distinguishable
    // from "there is no evidence".
    // The withheld arm is a VARIANT with no payload fields at all — it cannot
    // carry the body it is withholding, rather than merely happening not to.
    expect(page.candidates[0]?.episode).toEqual({ id: "ep-1", visible: false });
  });

  it("serves a visible episode body and marks truncation honestly", async () => {
    const long = "x".repeat(EPISODE_BODY_MAX_CHARS + 10);
    const db = reader([
      { match: "FROM brain_facts f", rows: [factRow()] },
      {
        match: "FROM brain_episodes e",
        rows: [
          {
            id: "ep-1",
            source: "slack",
            source_id: "C1/17",
            source_actor: "U1",
            body: long,
            locator: null,
            occurred_at: ISO,
            ingested_at: ISO,
            visible_to: ["org"],
          },
        ],
      },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    const episode = page.candidates[0]?.episode;
    expect(episode?.visible).toBe(true);
    if (episode?.visible !== true) throw new Error("expected a visible episode");
    expect(episode.body).toHaveLength(EPISODE_BODY_MAX_CHARS);
    expect(episode.bodyTruncated).toBe(true);
  });

  it("excludes retracted facts — the ACL clause does not filter them", async () => {
    const db = reader([{ match: "FROM brain_facts f", rows: [factRow()] }]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    expect(db.calls[0]?.sql).toContain("f.invalidated_at IS NULL");
  });

  it("excludes SUPERSEDED facts exactly as tombstoned ones (#4912)", async () => {
    // A stamped `valid_to` means a human promotion replaced this belief; there
    // is no trust call left to make on it and it leaves the queue the way a
    // retraction does. The OR arm is the regression pin for the other
    // direction: every `valid_to IS NULL` row — the whole pre-supersession
    // corpus — still satisfies the predicate.
    const db = reader([{ match: "FROM brain_facts f", rows: [factRow()] }]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    expect(db.calls[0]?.sql).toContain("(f.valid_to IS NULL OR f.valid_to > now())");
  });
});

describe("loadFactCandidates — filters", () => {
  it("filters provisional by jsonb key presence", async () => {
    const db = reader([{ match: "FROM brain_facts f", rows: [] }]);
    await loadFactCandidates(db, { ctx: ctx(), provisionalOnly: true, limit: 50, offset: 0 });
    expect(db.calls[0]?.sql).toContain("jsonb_exists(f.provenance, 'provisional')");
  });

  it("treats an `unresolved` side-list as provisional in the SQL too, not just on the wire", async () => {
    // The projection ORs the side-list into `provisional`. If the filter kept
    // only `jsonb_exists`, such a row would render the Provisional badge while
    // being excluded from the "Provisional only" queue and from
    // `provisionalTotal` — the quality queue hiding the rows most likely to be
    // corrupt, with the same word meaning two things on one screen.
    const db = reader([{ match: "FROM brain_facts f", rows: [] }]);
    await loadFactCandidates(db, { ctx: ctx(), provisionalOnly: true, limit: 50, offset: 0 });
    const sql = db.calls[0]?.sql ?? "";
    expect(sql).toContain("jsonb_exists(f.provenance, 'provisional')");
    expect(sql).toContain("jsonb_array_length");
  });

  it("matches tension in BOTH edge directions", async () => {
    // The incumbent of a conflict only ever appears on the `to` side, so a
    // `from`-only filter would hide the older claim whose trust is in question.
    const db = reader([{ match: "FROM brain_facts f", rows: [] }]);
    await loadFactCandidates(db, { ctx: ctx(), inTensionOnly: true, limit: 50, offset: 0 });
    expect(db.calls[0]?.sql).toContain("te.from_fact_id = f.id OR te.to_fact_id = f.id");
  });

  it("escapes LIKE metacharacters in the search term", async () => {
    const db = reader([{ match: "FROM brain_facts f", rows: [] }]);
    await loadFactCandidates(db, { ctx: ctx(), search: "100%_x", limit: 50, offset: 0 });
    expect(db.calls[0]?.params).toContain("%100\\%\\_x%");
  });

  it("clamps the page size to the read model's ceiling", async () => {
    const db = reader([{ match: "FROM brain_facts f", rows: [] }]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 10_000, offset: 0 });
    expect(db.calls[0]?.params).toContain(CANDIDATE_PAGE_MAX);
  });

  it("defaults to the draft queue", async () => {
    const db = reader([{ match: "FROM brain_facts f", rows: [] }]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    expect(db.calls[0]?.params).toContain("draft");
  });
});

describe("loadFactCandidates — contradiction hints", () => {
  const edgeRows = [{ from_id: "fact-1", to_id: "fact-2" }];

  it("surfaces the counterpart with its own provenance", async () => {
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: edgeRows },
      {
        match: "f.id = ANY(",
        rows: [factRow({ id: "fact-2", object: "MySQL", corroboration_count: 1, total_count: undefined })],
      },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    const tensions = page.candidates[0]?.tensions ?? [];
    expect(tensions).toHaveLength(1);
    expect(tensions[0]).toMatchObject({
      factId: "fact-2",
      visible: true,
      object: "MySQL",
      corroborationCount: 1,
    });
    if (tensions[0]?.visible !== true) throw new Error("expected a visible counterpart");
    expect(tensions[0].provenance.producer).toBe("extraction:v1");
    expect(tensions[0].invalidatedAt).toBeNull();
    expect(tensions[0].validTo).toBeNull();
  });

  it("reports an unreadable counterpart rather than dropping the conflict", async () => {
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: edgeRows },
      { match: "f.id = ANY(", rows: [] }, // counterpart not visible to this reader
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    // Dropping it would render as "nothing contradicts this claim", which is
    // the single most dangerous thing this surface could imply.
    expect(page.candidates[0]?.tensions).toEqual([
      { factId: "fact-2", edgeDirection: "to", visible: false },
    ]);
  });

  it("does NOT hide a superseded rival — settled history is still why the claim was contested (#4912)", async () => {
    // The negative that keeps a future "apply the current-validity predicate
    // everywhere" sweep honest: the queue itself now filters `valid_to`, but
    // the counterpart lookup must not — a rival retired at the publish gate is
    // still the reason this claim earned its tension edge, exactly like a
    // retracted one.
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: edgeRows },
      { match: "f.id = ANY(", rows: [] },
    ]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    const counterpart = db.calls.find((c) => c.sql.includes("f.id = ANY("));
    expect(counterpart?.sql).not.toContain("valid_to IS NULL OR");
    expect(counterpart?.sql).not.toContain("invalidated_at IS NULL");
  });

  it("gives each end of an on-page edge the other as a peer", async () => {
    const db = reader([
      {
        match: "COUNT(*) OVER ()",
        rows: [factRow(), factRow({ id: "fact-2", object: "MySQL", total_count: 2 })],
      },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: edgeRows },
      { match: "f.id = ANY(", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    // Symmetric on purpose — neither end is the authority over the other.
    expect(page.candidates[0]?.tensions[0]?.factId).toBe("fact-2");
    expect(page.candidates[1]?.tensions[0]?.factId).toBe("fact-1");
  });

  it("fetches counterparts in a SEPARATE ACL-gated statement, never a join onto the fact row", async () => {
    // The likeliest leak in the slice (#4913): a counterpart join gated by the
    // OWNER's predicate would hand a reviewer a rival's claim and provenance
    // because they were entitled to the fact it conflicts with.
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: edgeRows },
      { match: "f.id = ANY(", rows: [factRow({ id: "fact-2", total_count: undefined })] },
    ]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    const pageCall = db.calls.find((c) => c.sql.includes("COUNT(*) OVER ()"))!;
    // The page statement resolves no counterpart. Pinned on `to_fact_id`
    // rather than a blanket no-JOIN: #4914's decay anchor legitimately joins
    // `brain_episodes` for a timestamp inside the page query, so "no JOIN"
    // stopped being the invariant — "no tension-edge traversal" is.
    expect(pageCall.sql).not.toContain("to_fact_id");
    const counterpartCall = db.calls.find((c) => c.sql.includes("f.id = ANY("))!;
    // The FRESH fact predicate, with the reader's own bound tokens — not the
    // owner row's decision carried over, and no join in the statement. The
    // bound array is the real pin: `not.toContain("JOIN")` alone would pass a
    // correlated EXISTS against the owner row.
    expect(counterpartCall.sql).toContain("f.visible_to && $2::text[]");
    expect(counterpartCall.sql).not.toContain("JOIN");
    expect(counterpartCall.params[1]).toEqual([
      "org",
      "role:admin",
      "role:member",
      "user:user-1",
    ]);
    // And the edge fetch binds cap + 1 — the overflow row is how truncation is
    // detected, and the literal reader ignores LIMIT, so only the parameter
    // can pin it (and which cap this surface budgets).
    const edgeCall = db.calls.find((c) => c.sql.includes("edge_type = 'in-tension-with'"))!;
    expect(edgeCall.params[2]).toBe(TENSION_FANOUT_CAP + 1);
  });

  it("interleaves visible and withheld rivals by factId — the review surface's historical order", async () => {
    // The search surface appends its aggregate withheld arm LAST; the review
    // surface deliberately does not — each withheld rival is its own entry,
    // merged into one factId-sorted list. A regression copying the search
    // projection's append-last shape here would pass every other test.
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      {
        match: "edge_type = 'in-tension-with'",
        rows: [
          { from_id: "fact-1", to_id: "fact-2" },
          { from_id: "fact-1", to_id: "fact-0" },
          { from_id: "fact-9", to_id: "fact-1" },
        ],
      },
      // Only fact-2 is visible to this reader.
      { match: "f.id = ANY(", rows: [factRow({ id: "fact-2", total_count: undefined })] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    expect(
      (page.candidates[0]?.tensions ?? []).map((t) => `${t.factId}:${t.visible}`),
    ).toEqual(["fact-0:false", "fact-2:true", "fact-9:false"]);
  });

  it("never picks a winner — ordering ignores every authority signal, and no entry carries a verdict", async () => {
    // The review queue's half of the `search.test.ts` arm of the same name
    // (#4938). Both surfaces project the shared cluster INDEPENDENTLY, so
    // proving neutrality on retrieval says nothing about the surface where a
    // human is about to make the call — and this is the surface where a
    // `preferred` field would do the most damage, because it would read as
    // Atlas having already decided.
    //
    // The other arms here pose rivals whose id order is the only order they
    // could come back in, so none of them can tell a neutral sort from a ranked
    // one. Here every surfacing hint is stacked in favour of
    // the LATER-sorting rival: 900 corroborations against 0, `published`
    // against `draft`, 2026 against 2020. If any code path ranked by
    // authority, recency, or status, `rival-z-strong` would lead.
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      {
        match: "edge_type = 'in-tension-with'",
        rows: [
          { from_id: "fact-1", to_id: "rival-z-strong" },
          { from_id: "fact-1", to_id: "rival-a-weak" },
          // Withheld — the counterpart statement below never returns it. In
          // the merged list it must sit at its ID position like any other
          // rival: sorting the invisible ones to the end would tell a reviewer
          // which rivals they are allowed to see, and would also be the
          // search surface's append-last shape leaking across.
          { from_id: "fact-1", to_id: "rival-m-hidden" },
        ],
      },
      {
        match: "f.id = ANY(",
        rows: [
          factRow({
            id: "rival-z-strong",
            object: "MySQL",
            status: "published",
            corroboration_count: 900,
            ingested_at: "2026-07-01T00:00:00.000Z",
            total_count: undefined,
          }),
          factRow({
            id: "rival-a-weak",
            object: "SQLite",
            status: "draft",
            corroboration_count: 0,
            ingested_at: "2020-01-01T00:00:00.000Z",
            total_count: undefined,
          }),
        ],
      },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    const tensions = page.candidates[0]?.tensions ?? [];

    expect(tensions.map((t) => t.factId)).toEqual([
      "rival-a-weak",
      "rival-m-hidden",
      "rival-z-strong",
    ]);
    // The signals really are present and really are adverse — without this the
    // assertion above would also pass against a projection that dropped them,
    // and then it would be pinning nothing.
    const strong = tensions.find((t) => t.factId === "rival-z-strong");
    expect(strong).toMatchObject({ visible: true, status: "published", corroborationCount: 900 });

    // The entry's key set is CLOSED, per variant. Authority signals travel as
    // display fields for the reviewer to weigh; there is no `rank`, `score`,
    // `winner`, or `preferred` for a producer to start setting, and a withheld
    // rival stays an opaque handle rather than acquiring a payload.
    //
    // `validTo` is on this list because #4942 added it, and it belongs on the
    // display side of that line: a superseded rival LABELLED as superseded is
    // the reviewer being told the counterpart's status, which is the same
    // service `invalidatedAt` performs for a retracted one. The distinction
    // this assertion protects is not "no temporal fields" — it is that nothing
    // here tells the reviewer which rival WINS.
    for (const entry of tensions) {
      expect([entry.factId, Object.keys(entry).toSorted()]).toEqual([
        entry.factId,
        entry.visible
          ? [
              "corroborationCount",
              "edgeDirection",
              "factId",
              "ingestedAt",
              "invalidatedAt",
              "object",
              "predicate",
              "provenance",
              "status",
              "subject",
              "validFrom",
              "validTo",
              "visible",
            ]
          : ["edgeDirection", "factId", "visible"],
      ]);
    }
  });

  it("lists a reciprocal rival once per direction — the graph, not a double-count", async () => {
    // `reconcile.ts`'s `WHERE NOT EXISTS` dedupes one direction only, so a
    // raced reciprocal pair (A→B and B→A) is representable. Each review entry
    // carries its `edgeDirection`, so one entry per edge is a faithful report
    // of the graph — pinned so the search surface's direction-less
    // withheld-count dedupe is never "helpfully" copied here.
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      {
        match: "edge_type = 'in-tension-with'",
        rows: [
          { from_id: "fact-1", to_id: "fact-2" },
          { from_id: "fact-2", to_id: "fact-1" },
        ],
      },
      { match: "f.id = ANY(", rows: [factRow({ id: "fact-2", total_count: undefined })] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    expect(
      (page.candidates[0]?.tensions ?? []).map((t) => `${t.factId}:${t.edgeDirection}`),
    ).toEqual(["fact-2:to", "fact-2:from"]);
  });
});

describe("loadFactCandidates — honest totals and caps", () => {
  it("re-counts rather than asserting zero when a page lands past the end", async () => {
    // `COUNT(*) OVER ()` yields no row for an empty window. Reporting 0 would
    // collapse the client's pageCount to 1 and render "nothing to review" over
    // a queue that is merely paged past its end — while the stats bar directly
    // above says otherwise.
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [] },
      { match: "SELECT COUNT(*)::int AS n", rows: [{ n: 197 }] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 150 });

    expect(page).toEqual({ candidates: [], total: 197, tensionsTruncated: false });
    expect(db.calls).toHaveLength(2);
  });

  it("does not pay for a re-count on the genuinely empty first page", async () => {
    const db = reader([{ match: "COUNT(*) OVER ()", rows: [] }]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    expect(page.total).toBe(0);
    expect(db.calls).toHaveLength(1);
  });

  it("tells the REVIEWER when contradiction hints were truncated, not just the log", async () => {
    // The cap is applied in edge-id order across the whole page, so specific
    // candidates lose ALL of their hints. A page that quietly dropped them
    // would render as "nothing further conflicts with this claim".
    const edges = Array.from({ length: TENSION_FANOUT_CAP + 1 }, (_, i) => ({
      from_id: "fact-1",
      to_id: `rival-${String(i).padStart(4, "0")}`,
    }));
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: edges },
      { match: "f.id = ANY(", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    expect(page.tensionsTruncated).toBe(true);
    expect(page.candidates[0]?.tensions).toHaveLength(TENSION_FANOUT_CAP);
  });

  it("dedupes tension edges — 0180 has no unique index on the edge triple", async () => {
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: [] },
    ]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    const edgeCall = db.calls.find((c) => c.sql.includes("in-tension-with"));
    expect(edgeCall?.sql).toContain("SELECT DISTINCT");
  });
});

describe("loadFactCandidates — wire contract", () => {
  it("emits a payload its own response schema accepts", async () => {
    // The route parses through this schema before responding, so a coercion
    // here that violated it would be a 500 rather than a blanked queue in the
    // browser. Pinning it means the coercion sites (`String(t)` on a grant
    // token, the status fallback, `count()`) can't drift out of the contract.
    const db = reader([
      {
        match: "COUNT(*) OVER ()",
        rows: [factRow({ visible_to: ["org", null], status: "not-a-status" })],
      },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: [{ from_id: "fact-1", to_id: "fact-2" }] },
      { match: "f.id = ANY(", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    expect(() => BrainFactCandidateListResponseSchema.parse(page)).not.toThrow();
  });

  it("flags an undecodable grant instead of rendering it as visible-to-nobody", async () => {
    // A raw `text[]` literal from a driver that stopped decoding. An empty
    // token list would read as "harmless"; the flag says it is an Atlas bug.
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow({ visible_to: "{org}" })] },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    expect(page.candidates[0]?.grantReadable).toBe(false);
    expect(page.candidates[0]?.visibleTo).toEqual([]);
  });

  it("marks a NULL grant element by POSITION, since it renders as the token `null`", async () => {
    // `parseGrant` reports a non-string element as `""`, while the wire renders
    // it via `String(t)` as `null` — a value match would leave a
    // plausible-looking token unhighlighted under the sentence saying
    // highlighted tokens grant nobody access.
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow({ visible_to: ["org", null] })] },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    expect(page.candidates[0]?.visibleTo).toEqual(["org", "null"]);
    expect(page.candidates[0]?.malformedGrantIndices).toEqual([1]);
  });

  it("labels a WITHDRAWN counterpart, which `status` alone cannot show", async () => {
    // Retraction never writes `status`, so a retracted rival still reports
    // "draft" — indistinguishable from a live conflict without this field.
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: [{ from_id: "fact-1", to_id: "fact-2" }] },
      {
        match: "f.id = ANY(",
        rows: [factRow({ id: "fact-2", object: "MySQL", invalidated_at: ISO, total_count: undefined })],
      },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    const tension = page.candidates[0]?.tensions[0];
    if (tension?.visible !== true) throw new Error("expected a visible counterpart");
    expect(tension.status).toBe("draft");
    expect(tension.invalidatedAt).toBe(ISO);
    expect(tension.validTo).toBeNull();
  });

  it("labels a superseded counterpart, because supersession never writes status either (#4935)", async () => {
    // The reviewer's half of the same defect. After the publish gate retires a
    // rival, its counterpart entry still reads `published` with no tombstone —
    // so without `validTo` the queue renders a conflict the reviewer already
    // arbitrated as if it were still open.
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: [{ from_id: "fact-1", to_id: "fact-2" }] },
      {
        match: "f.id = ANY(",
        rows: [
          factRow({
            id: "fact-2",
            object: "MySQL",
            status: "published",
            valid_to: ISO,
            total_count: undefined,
          }),
        ],
      },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    const tension = page.candidates[0]?.tensions[0];
    if (tension?.visible !== true) throw new Error("expected a visible counterpart");
    expect(tension.validTo).toBe(ISO);
    // Every other signal still reads as live — which is the whole reason the
    // label has to exist.
    expect(tension.status).toBe("published");
    expect(tension.invalidatedAt).toBeNull();
  });
});

describe("loadFactCandidates — promotion pre-flight", () => {
  it("shows the publish endpoint's refusal before the reviewer publishes", async () => {
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow({ visible_to: ["everyone"] })] },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    const block = page.candidates[0]?.promotionBlock;
    expect(block?.reasons).toContain("GRANT_UNUSABLE");
    // Rendered verbatim by every surface, so it has to be actionable prose.
    expect(block?.detail).toContain("invisible to every reader");
  });

  it("reports junk tokens alongside a usable one without calling it a refusal", async () => {
    const db = reader([
      { match: "COUNT(*) OVER ()", rows: [factRow({ visible_to: ["org", "everyone"] })] },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });

    expect(page.candidates[0]?.promotionBlock).toBeNull();
    expect(page.candidates[0]?.malformedGrantIndices).toEqual([1]);
  });

  it("does not assume published implies promotable", async () => {
    // A region import writes `status` verbatim, so a workspace can arrive
    // holding an already-published fact this classifier would refuse.
    const db = reader([
      {
        match: "COUNT(*) OVER ()",
        rows: [factRow({ status: "published", visible_to: ["everyone"] })],
      },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), status: "published", limit: 50, offset: 0 });

    expect(page.candidates[0]?.status).toBe("published");
    expect(page.candidates[0]?.promotionBlock).not.toBeNull();
  });
});

describe("loadFactCandidateSummary", () => {
  it("throws rather than reporting a zeroed backlog for an unresolvable reader", async () => {
    // "0 awaiting review" is the reading that sends a reviewer off to publish a
    // backlog they never saw.
    const db = reader([]);
    await expect(
      loadFactCandidateSummary(db, {
        origin: "unresolved",
        workspaceId: WS,
        userId: null,
        role: null,
        audienceIds: [],
      }),
    ).rejects.toBeInstanceOf(BrainReaderUnresolvedError);
    expect(db.calls).toHaveLength(0);
  });

  it("counts live rows only", async () => {
    const db = reader([
      {
        match: "draft_total",
        rows: [{ draft_total: 3, provisional_total: 1, in_tension_total: 2, published_total: 9 }],
      },
    ]);
    const summary = await loadFactCandidateSummary(db, ctx());
    expect(summary).toEqual({
      draftTotal: 3,
      provisionalTotal: 1,
      inTensionTotal: 2,
      publishedTotal: 9,
    });
    expect(db.calls[0]?.sql).toContain("f.invalidated_at IS NULL");
    // The supersession axis (#4912): a superseded fact leaves the stats bar
    // the same way a tombstoned one does — including `publishedTotal`, which
    // otherwise counts rows the queue's own published filter would hide.
    expect(db.calls[0]?.sql).toContain("(f.valid_to IS NULL OR f.valid_to > now())");
  });
});

// Rejection (`retract`) moved to `lib/brain/correction.ts` (#4915) — the
// tombstone tests live in `correction.test.ts` beside the other three verbs.

// ---------------------------------------------------------------------------
// Provenance attribution on a widened fact (#4836)
// ---------------------------------------------------------------------------

/**
 * The review-queue half of #4836. `search.test.ts` covers the agent read path,
 * which is the one that makes this a user-visible disclosure; this one covers
 * the surface the reviewer looks at, plus the tension counterparts — which are
 * facts in their own right and were the easiest place for the decision to be
 * inherited from the wrong row.
 */
describe("loadFactCandidates — attribution on a widened fact (#4836)", () => {
  const PRIVATE = "audience:chat-channel:slack:C-FOUNDERS";

  /** First stated privately, restated publicly, published with the union. */
  const widened = (overrides: Record<string, unknown> = {}) =>
    factRow({
      visible_to: [PRIVATE, "org"],
      pre_widening_visible_to: [PRIVATE],
      ...overrides,
    });

  async function candidateFor(context: BrainPrincipalContext, row: Record<string, unknown>) {
    const db = reader([
      { match: "FROM brain_facts f", rows: [row] },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: context, limit: 50, offset: 0 });
    const candidate = page.candidates[0];
    if (!candidate) throw new Error("expected one candidate");
    return candidate;
  }

  it("withholds the attribution triple from a reader gained by widening", async () => {
    const c = await candidateFor(ctx(), widened());
    expect(c.provenance.attribution).toEqual({ visible: false });
    // The claim itself is still served — that is the point. Only who said it
    // first, where, and when are withheld.
    expect(c.subject).toBe("Acme");
    expect(JSON.stringify(c.provenance)).not.toContain("C1/17");
    expect(JSON.stringify(c.provenance)).not.toContain("U1");
  });

  it("gives a member of the ORIGINAL audience full attribution", async () => {
    const c = await candidateFor(
      ctx({ audienceIds: ["chat-channel:slack:C-FOUNDERS"] }),
      widened(),
    );
    expect(c.provenance.attribution).toEqual({
      visible: true,
      sourceId: "C1/17",
      actor: "U1",
      occurredAt: ISO,
    });
  });

  it("leaves a fact that was never widened untouched", async () => {
    // The negative: nothing widened, so nobody gained access through widening,
    // and full attribution still flows.
    const c = await candidateFor(ctx(), factRow());
    expect(c.provenance.attribution).toEqual({
      visible: true,
      sourceId: "C1/17",
      actor: "U1",
      occurredAt: ISO,
    });
  });

  it("still reports `visibleTo` as the grant that is actually in force", async () => {
    // The narrowing is about PROVENANCE, not about the grant. A reviewer must
    // still see that this fact is readable org-wide — hiding that would make
    // the ACL column lie in the other direction.
    const c = await candidateFor(ctx(), widened());
    expect(c.visibleTo).toEqual([PRIVATE, "org"]);
    expect(c.grantReadable).toBe(true);
  });

  it("selects the pre-widening grant, so the decision has an input at all", async () => {
    const db = reader([{ match: "FROM brain_facts f", rows: [] }]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    expect(db.calls[0]?.sql).toContain("f.pre_widening_visible_to");
  });

  it("decides per TENSION COUNTERPART, off that row's own grant", async () => {
    // A counterpart is a fact fetched through its own ACL predicate, so
    // inheriting the owner's decision would be a guess about a different row.
    // Here the owner was never widened and the rival was — the arrangement
    // that a shared decision silently gets wrong.
    const db = reader([
      { match: "FROM brain_facts f\n   WHERE", rows: [factRow()] },
      { match: "FROM brain_episodes e", rows: [] },
      { match: "edge_type = 'in-tension-with'", rows: [{ from_id: "fact-1", to_id: "rival-1" }] },
      {
        match: "AND f.id = ANY(",
        rows: [widened({ id: "rival-1", object: "MySQL" })],
      },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    const owner = page.candidates[0];
    if (!owner) throw new Error("expected one candidate");
    // Owner: never widened, full attribution.
    expect(owner.provenance.attribution.visible).toBe(true);
    const tension = owner.tensions[0];
    if (!tension || !tension.visible) throw new Error("expected a visible counterpart");
    // Counterpart: widened, attribution withheld.
    expect(tension.provenance.attribution).toEqual({ visible: false });
  });
});

describe("projectProvenance — the withheld arm (#4836)", () => {
  it("replaces the triple with a variant that cannot carry it", () => {
    const p = projectProvenance(factRow().provenance, "ep-1", "withhold");
    expect(p.attribution).toEqual({ visible: false });
    expect(Object.keys(p.attribution)).toEqual(["visible"]);
  });

  it("withholds on an unparseable payload too, rather than defaulting open", () => {
    // The degraded arm returns before the payload is read at all. If it built
    // its own attribution independently, the two arms could disagree about
    // entitlement — and the arm that disagrees is the one reached by drift.
    const p = projectProvenance("not an object", null, "withhold");
    expect(p.attribution).toEqual({ visible: false });
  });

  it("keeps `payloadComplete` a statement about the STORED payload", () => {
    // Entitlement and integrity are two different answers on the wire and must
    // stay independent: withheld-but-well-formed, and disclosed-but-drifted,
    // are both real states a reviewer has to be able to tell apart.
    expect(projectProvenance(factRow().provenance, "ep-1", "withhold").payloadComplete).toBe(true);
    expect(projectProvenance({ actor: null }, null, "withhold").payloadComplete).toBe(false);
  });

  it("still projects source, producer and the pipeline timestamps", () => {
    // Withholding is scoped to the three fields that name a person and a
    // place. `extractedAt` / `reconciledAt` are Atlas's own batch-scheduled
    // pipeline clocks, not the moment anything was said.
    const p = projectProvenance(factRow().provenance, "ep-1", "withhold");
    expect(p.source).toBe("slack");
    expect(p.producer).toBe("extraction:v1");
    expect(p.episodeId).toBe("ep-1");
    expect(p.extractedAt).toBe(ISO);
    expect(p.reconciledAt).toBe(ISO);
  });
});

describe("BrainFactAttributionViewSchema — the withheld arm is enforced, not conventional (#4836)", () => {
  // The type's `visible: false` arm has no fields, but TypeScript's
  // excess-property check covers OBJECT LITERALS only: a spread, or a widened
  // variable, assigns straight through. `satisfies z.ZodType<…>` does not see
  // strictness either — it is output-assignability, and a withheld arm that
  // carried `actor` would still be assignable to the union. So `z.strictObject`
  // is the actual enforcement, and these are what pin it.

  const provenance = (attribution: unknown) => ({
    source: "slack",
    episodeId: "ep-1",
    producer: "extraction:v1",
    attribution,
    extractedAt: ISO,
    reconciledAt: ISO,
    provisional: false,
    unresolved: [],
    payloadComplete: true,
  });

  it("REFUSES a withheld arm that smuggles the triple back in", () => {
    // The regression this exists to catch: a second producer builds the
    // withheld arm by spreading the disclosed one and nulling nothing.
    for (const leak of [
      { visible: false, actor: "U-FOUNDER" },
      { visible: false, sourceId: "C-FOUNDERS:1799999999.001" },
      { visible: false, occurredAt: ISO },
      { visible: false, sourceId: null, actor: null, occurredAt: null },
    ]) {
      const parsed = BrainFactProvenanceViewSchema.safeParse(provenance(leak));
      expect(parsed.success).toBe(false);
    }
  });

  it("accepts the empty withheld arm and the full disclosed arm", () => {
    expect(BrainFactProvenanceViewSchema.safeParse(provenance({ visible: false })).success).toBe(
      true,
    );
    expect(
      BrainFactProvenanceViewSchema.safeParse(
        provenance({ visible: true, sourceId: "C1/17", actor: "U1", occurredAt: ISO }),
      ).success,
    ).toBe(true);
  });

  it("REFUSES a disclosed arm missing the fields it promises", () => {
    // The other direction: `visible: true` with the triple omitted would let a
    // producer express "disclosed but blank", which is the collapse the
    // variant exists to prevent.
    expect(BrainFactProvenanceViewSchema.safeParse(provenance({ visible: true })).success).toBe(
      false,
    );
  });

  it("passes what `projectProvenance` actually builds, on both arms", () => {
    // Keeps the schema and the single constructor from drifting apart — the
    // pairing matters because `searchBrain` has no response parse, so on that
    // path the projection IS the guarantee.
    for (const decision of ["disclose", "withhold"] as const) {
      const built = projectProvenance(factRow().provenance, "ep-1", decision);
      expect(BrainFactProvenanceViewSchema.safeParse(built).success).toBe(true);
    }
  });
});

/**
 * Read-time decay on the review queue (#4914, ADR-0036 §Temporal).
 *
 * The stance under test: decay only SURFACES — a label on the wire and a
 * float-to-top hint in ORDER BY — and never demotes. The structural half
 * (the staleness module holds no mutating SQL) is `staleness.test.ts`'s;
 * this suite pins the read model's use of it.
 */
describe("loadFactCandidates — read-time decay (#4914)", () => {
  const OLD = "2020-01-01T00:00:00.000Z";
  const HINT = `make_interval(days => ${DECAY_STALE_AFTER_DAYS})`;

  it("labels a long-unobserved claim stale and carries the observation", async () => {
    const db = reader([
      { match: "FROM brain_facts f", rows: [factRow({ last_observed_at: OLD })] },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    const decay = page.candidates[0]?.decay;
    expect(decay?.level).toBe("stale");
    expect(decay?.lastObservedAt).toBe(OLD);
    expect(decay?.ageDays).toBeGreaterThanOrEqual(DECAY_STALE_AFTER_DAYS);
    // The whole page still satisfies the wire contract the browser parses.
    expect(BrainFactCandidateListResponseSchema.safeParse(page).success).toBe(true);
  });

  it("keeps the trust surface untouched by decay — status is whatever the row holds", async () => {
    // The acceptance criterion stated as a negative: a stale fact is not
    // demoted, re-labelled, or excluded. It arrives with its stored status.
    const db = reader([
      {
        match: "FROM brain_facts f",
        rows: [factRow({ status: "published", last_observed_at: OLD })],
      },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), status: "all", limit: 50, offset: 0 });
    expect(page.candidates[0]?.status).toBe("published");
    expect(page.candidates[0]?.decay.level).toBe("stale");
  });

  it("uses the stale hint in ORDER BY and nowhere else", async () => {
    const db = reader([{ match: "FROM brain_facts f", rows: [] }]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    const sql = db.calls[0]?.sql ?? "";
    const orderAt = sql.indexOf("ORDER BY");
    expect(orderAt).toBeGreaterThan(-1);
    // The hint keys on the SAME constant as the label (`staleness.test.ts`
    // pins the interpolation), floats stale first, and keeps the familiar
    // newest-ingest order beneath it.
    expect(sql.slice(orderAt)).toContain(HINT);
    expect(sql.slice(orderAt)).toContain("f.ingested_at DESC, f.id DESC");
    // …and it is a SURFACING hint only: the WHERE half of the statement never
    // mentions it, so a stale fact is floated, never filtered.
    expect(sql.slice(0, orderAt)).not.toContain(HINT);
  });

  it("emits only reads while serving a stale page — no write path from the signal", async () => {
    // The behavioral half of the acceptance criterion: rendering decay over a
    // stale queue performs zero writes of any kind, so there is no statement a
    // decay value could reach a fact row through.
    const db = reader([
      { match: "FROM brain_facts f", rows: [factRow({ last_observed_at: OLD })] },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    expect(db.calls.length).toBeGreaterThan(0);
    for (const call of db.calls) {
      expect(call.sql.trimStart()).toMatch(/^SELECT/i);
    }
  });

  it("withholds the numbers from a widened-in reader but keeps the level (#4836)", async () => {
    // For a singly-corroborated fact the newest observation IS the withheld
    // `occurredAt`; a day-precision age restates it as arithmetic. The coarse
    // bucket stays, because lying about the level would defeat the surface.
    const db = reader([
      {
        match: "FROM brain_facts f",
        rows: [
          factRow({
            visible_to: ["audience:chat-channel:slack:C-FOUNDERS", "org"],
            pre_widening_visible_to: ["audience:chat-channel:slack:C-FOUNDERS"],
            last_observed_at: OLD,
          }),
        ],
      },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    expect(page.candidates[0]?.decay).toEqual({
      level: "stale",
      ageDays: null,
      lastObservedAt: null,
    });
    // ONE decision feeds both consumers — the refactor's invariant. If decay
    // withheld while attribution disclosed (or vice versa) the row would
    // contradict itself about the same reader's entitlement to the "when".
    expect(page.candidates[0]?.provenance.attribution).toEqual({ visible: false });
  });

  it("reports drift, not a fabricated label, when the SELECT drops the decay anchor", async () => {
    // `pg` never yields `undefined` for a selected column, so a row without
    // the key means the page query stopped selecting `last_observed_at`.
    // Anchoring on ingest would label confidently while the ORDER BY hint —
    // which interpolates the subquery independently — kept sorting by the
    // real observation. The classifier refuses: age unknown.
    const { last_observed_at: _dropped, ...row } = factRow();
    const db = reader([
      { match: "FROM brain_facts f", rows: [row] },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    expect(page.candidates[0]?.decay).toEqual({
      level: "unknown",
      ageDays: null,
      lastObservedAt: null,
    });
  });

  it("reports `unknown` rather than fabricating an age when nothing decodes", async () => {
    const db = reader([
      {
        match: "FROM brain_facts f",
        rows: [factRow({ last_observed_at: null, valid_from: null, ingested_at: "junk" })],
      },
      { match: "FROM brain_episodes e", rows: [] },
    ]);
    const page = await loadFactCandidates(db, { ctx: ctx(), limit: 50, offset: 0 });
    expect(page.candidates[0]?.decay).toEqual({
      level: "unknown",
      ageDays: null,
      lastObservedAt: null,
    });
  });

  it("REFUSES decay states the constructor cannot build, at the schema gate", () => {
    // The refinements are the cross-field backstop for a hypothetical second
    // producer — the same role `z.strictObject` plays on the withheld
    // attribution arm. Deleting either refine must fail HERE, not surface as
    // a contradictory view shipped through `checked()`.
    const invalid = [
      { level: "unknown", ageDays: 5, lastObservedAt: null },
      { level: "unknown", ageDays: null, lastObservedAt: ISO },
      { level: "stale", ageDays: null, lastObservedAt: ISO },
    ];
    for (const decay of invalid) {
      expect(BrainFactDecayViewSchema.safeParse(decay).success).toBe(false);
    }
    // …and the polarity check: every state the constructor DOES build parses,
    // most importantly the withheld shape — a refine that rejected valid
    // withheld pages would take the review queue down for exactly the widened
    // readers #4836 protects.
    const valid = [
      { level: "stale", ageDays: null, lastObservedAt: null },
      { level: "unknown", ageDays: null, lastObservedAt: null },
      { level: "aging", ageDays: 50, lastObservedAt: null },
      { level: "fresh", ageDays: 5, lastObservedAt: ISO },
    ];
    for (const decay of valid) {
      expect(BrainFactDecayViewSchema.safeParse(decay).success).toBe(true);
    }
  });
});
