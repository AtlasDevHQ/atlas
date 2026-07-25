/**
 * Unit coverage for the fused `searchBrain` read (#4773, ADR-0036).
 *
 * The claims worth pinning are the ones a green build would otherwise hide, so
 * most of these probe a guard rather than a happy path:
 *
 *   - the ACL predicate is PUSHED DOWN into every store's WHERE, above the FTS
 *     match, the ranking expression, and the LIMIT — and the fail-closed case
 *     is asserted as a NEGATIVE (a reader who should see nothing produces a
 *     query that CAN return nothing, not a query whose rows are dropped);
 *   - the fact read ANDs `invalidated_at IS NULL` ITSELF, because
 *     `brainFactStatusClause` gates review status only and retraction is the
 *     review gate's reject verb — the single most likely defect in the slice;
 *   - the EPISODE carries its own predicate, never the fact's;
 *   - an unextracted episode is RETURNED and labelled, not skipped;
 *   - every row carries `tier` + `trustTier`, written at one seam;
 *   - `in-tension-with` surfaces both directions, unranked, and a withheld
 *     counterpart is reported rather than dropped.
 *
 * A literal `BrainSearchReader` stands in for the pool — no `mock.module()`, no
 * singleton mutation. That the emitted SQL actually selects what these tests
 * assume is the `-pg` suite's job.
 */

import { describe, expect, it } from "bun:test";
import {
  buildEpisodeQuery,
  buildFactQuery,
  searchBrainCore,
  TENSION_FANOUT_CAP,
  type BrainSearchReader,
} from "@atlas/api/lib/brain/search";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import { aclVisibilityClause, type BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import type { BrainFactResult, BrainSearchResult } from "@useatlas/types";

const WS = "ws-search-test";

function ctx(
  partial: Partial<Extract<BrainPrincipalContext, { origin: "authenticated" }>> = {},
): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-1",
    role: "member",
    audienceIds: [],
    ...partial,
  };
}

interface Call {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * Match keys chosen to be UNAMBIGUOUS across the four statements this module
 * emits. The obvious `"brain_facts"` is not: the fact page's corroboration
 * subquery names `brain_edges`, and the tension-counterpart query names
 * `brain_facts` too — so a loose key silently answers the wrong statement and
 * the assertion passes vacuously on the withheld arm.
 */
const SQL = {
  factPage: "COUNT(DISTINCT ed.to_episode_id)",
  episodePage: "FROM brain_episodes e",
  tensionEdges: "edge_type = 'in-tension-with'",
  tensionCounterparts: "AND f.id = ANY(",
} as const;

function reader(
  responses: Array<{ match: string; rows: Record<string, unknown>[] }> = [],
): BrainSearchReader & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const hit = responses.find((r) => sql.includes(r.match));
      return { rows: hit?.rows ?? [] };
    },
  };
}

function factRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fact-1",
    subject: "billing pipeline",
    predicate: "owned_by",
    object: "platform team",
    status: "published",
    predicate_cardinality: "single",
    visible_to: ["org"],
    provenance: { source: "slack", sourceId: "m-1", episodeId: "ep-1" },
    source_episode_id: "ep-1",
    valid_from: null,
    valid_to: null,
    invalidated_at: null,
    ingested_at: new Date("2026-06-01T00:00:00Z"),
    corroboration_count: 1,
    snippet: null,
    ...overrides,
  };
}

function episodeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ep-1",
    source: "slack",
    source_id: "m-1",
    source_actor: "U1",
    body: "the billing pipeline belongs to the platform team",
    locator: null,
    occurred_at: new Date("2026-05-30T00:00:00Z"),
    ingested_at: new Date("2026-05-30T00:01:00Z"),
    extracted_at: null,
    visible_to: ["org"],
    snippet: null,
    ...overrides,
  };
}

/** The clause a real caller would compose, for the builder-level tests. */
function acl(context: BrainPrincipalContext, table: "brain_facts" | "brain_episodes") {
  const clause = aclVisibilityClause(context, {
    table,
    alias: table === "brain_facts" ? "f" : "e",
    paramIndex: 1,
  });
  return { aclSql: clause.sql, aclParams: clause.params };
}

// ---------------------------------------------------------------------------
// Push-down
// ---------------------------------------------------------------------------

describe("buildFactQuery — push-down and the tombstone trap", () => {
  it("ANDs the ACL predicate, the mode clause, and the tombstone filter into one WHERE", () => {
    const { sql } = buildFactQuery("published", { limit: 10, ...acl(ctx(), "brain_facts") });
    expect(sql).toContain("f.workspace_id = $1");
    expect(sql).toContain("f.visible_to && $2::text[]");
    expect(sql).toContain("f.status = 'published'");
    // THE trap. `brainFactStatusClause` gates review status only; ADR-0036
    // keeps retracted facts readable, so a current-belief read must exclude
    // them itself or the agent is served withdrawn claims.
    expect(sql).toContain("f.invalidated_at IS NULL");
  });

  it("keeps the LIMIT and the ranking BELOW the gated WHERE, so an unreadable row is never ranked or counted", () => {
    const { sql } = buildFactQuery("published", {
      query: "billing",
      limit: 5,
      ...acl(ctx(), "brain_facts"),
    });
    const whereAt = sql.indexOf("WHERE");
    // A post-fetch filter leaks existence through result counts and latency
    // even when the rows never render; the only defence is ordering these three
    // after the predicate in one statement.
    expect(whereAt).toBeGreaterThan(-1);
    expect(sql.indexOf("ORDER BY")).toBeGreaterThan(whereAt);
    expect(sql.indexOf("LIMIT")).toBeGreaterThan(whereAt);
    expect(sql.indexOf("f.visible_to &&")).toBeGreaterThan(whereAt);
    expect(sql.indexOf("f.fts @@")).toBeGreaterThan(whereAt);
  });

  it("binds exactly the reader's principal tokens — a narrower reader binds a narrower array", () => {
    const wide = buildFactQuery("published", { limit: 10, ...acl(ctx({ role: "owner" }), "brain_facts") });
    const narrow = buildFactQuery("published", { limit: 10, ...acl(ctx({ role: null }), "brain_facts") });
    expect(wide.params[1]).toEqual(["org", "role:owner", "role:admin", "role:member", "user:user-1"]);
    // No role ⇒ no `role:` tokens. The SQL is the SAME shape; only the bound
    // set narrows — which is what push-down means.
    expect(narrow.params[1]).toEqual(["org", "user:user-1"]);
    expect(narrow.sql).toContain("f.visible_to && $2::text[]");
  });

  it("developer mode overlays drafts through the shared content-mode clause", () => {
    const { sql } = buildFactQuery("developer", { limit: 10, ...acl(ctx(), "brain_facts") });
    expect(sql).toContain("f.status IN ('published', 'draft')");
    expect(sql).toContain("f.invalidated_at IS NULL");
  });

  it("without a query, emits no tsquery and orders by recency", () => {
    const { sql } = buildFactQuery("published", { limit: 10, ...acl(ctx(), "brain_facts") });
    expect(sql).not.toContain("websearch_to_tsquery");
    expect(sql).toContain("NULL AS snippet");
    expect(sql).toMatch(/ORDER BY\s+f\.ingested_at DESC/);
  });

  it("blank/whitespace query is treated as no query", () => {
    const { sql } = buildFactQuery("published", {
      query: "   ",
      limit: 10,
      ...acl(ctx(), "brain_facts"),
    });
    expect(sql).not.toContain("websearch_to_tsquery");
  });

  it("matches and ranks against the stored generated column, never an inline to_tsvector", () => {
    const { sql } = buildFactQuery("published", {
      query: "billing",
      limit: 10,
      ...acl(ctx(), "brain_facts"),
    });
    // An inline vector would seq-scan past the GIN index built by 0181.
    expect(sql).toContain("f.fts @@ websearch_to_tsquery('english', $3)");
    expect(sql).toContain("ts_rank(f.fts,");
    expect(sql).not.toContain("to_tsvector(");
  });
});

describe("buildEpisodeQuery", () => {
  it("gates on the EPISODE's own predicate and applies no content-mode clause", () => {
    const { sql } = buildEpisodeQuery({ limit: 10, ...acl(ctx(), "brain_episodes") });
    expect(sql).toContain("e.workspace_id = $1");
    expect(sql).toContain("e.visible_to && $2::text[]");
    // Episodes are immutable evidence with no `status` column — nothing to gate.
    expect(sql).not.toContain("status");
  });

  it("does NOT filter unextracted episodes — the committed edge behavior", () => {
    const { sql } = buildEpisodeQuery({ limit: 10, ...acl(ctx(), "brain_episodes") });
    expect(sql).not.toContain("extracted_at IS NOT NULL");
    // It is SELECTED, because the label is derived from it.
    expect(sql).toContain("e.extracted_at");
  });

  it("snippets over body-or-locator, never both concatenated", () => {
    const { sql } = buildEpisodeQuery({
      query: "billing",
      limit: 10,
      ...acl(ctx(), "brain_episodes"),
    });
    expect(sql).toContain("coalesce(e.body, e.locator, '')");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed, written as a negative
// ---------------------------------------------------------------------------

describe("fail-closed", () => {
  it("REFUSES rather than returning an empty page when the reader is unresolved", async () => {
    const db = reader();
    await expect(
      searchBrainCore(db, {
        ctx: { origin: "unresolved", workspaceId: WS, userId: null, role: null, audienceIds: [] },
        mode: "published",
        limit: 10,
        expand: false,
      }),
    ).rejects.toBeInstanceOf(BrainReaderUnresolvedError);
    // And it never reached the database — the refusal is the answer, not a
    // filter over rows already fetched.
    expect(db.calls).toHaveLength(0);
  });

  // The refusal must not be a function of the caller's arguments. The document
  // store carries no per-row grant, so an `include` that reaches only it once
  // slipped past the guard entirely and served an unresolvable reader a normal
  // page — a permission decision made by a query parameter.
  for (const include of [["raw-episode"], ["document"], []] as const) {
    it(`refuses when the caller narrowed include to ${JSON.stringify(include)}`, async () => {
      const db = reader();
      await expect(
        searchBrainCore(db, {
          ctx: { origin: "unresolved", workspaceId: WS, userId: null, role: null, audienceIds: [] },
          mode: "published",
          include,
          limit: 10,
          expand: false,
        }),
      ).rejects.toBeInstanceOf(BrainReaderUnresolvedError);
      expect(db.calls).toHaveLength(0);
    });
  }

  it("a reader entitled to nothing produces a query that CAN return nothing", async () => {
    // The negative form the acceptance criterion asks for: not "we dropped the
    // rows", but "the statement we sent could not have returned them". A reader
    // holding only `org` binds only `org`, so a fact granted to
    // `audience:secret` is unmatchable by the predicate itself.
    const narrow: BrainPrincipalContext = {
      origin: "unauthenticated-local",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    const db = reader();
    await searchBrainCore(db, {
      ctx: narrow,
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const factCall = db.calls.find((c) => c.sql.includes("brain_facts"))!;
    expect(factCall.sql).toContain("f.visible_to && $2::text[]");
    expect(factCall.params[1]).toEqual(["org"]);
    // Postgres evaluates `ARRAY['audience:secret'] && ARRAY['org']` as FALSE,
    // so such a row is excluded by the WHERE. What makes this a NEGATIVE rather
    // than a claim about the SQL text is the bound array above — the tokens are
    // parameters, never interpolated, so asserting the literal is absent from
    // the statement would pass no matter what. The real proof that the row
    // cannot come back is in `search-pg.test.ts`, against live Postgres.
    //
    // What IS worth pinning here: exactly one statement is issued — no second
    // pass, no follow-up filtering query. The only post-query row drop in this
    // module is the `id`-drift guard, which is not ACL-conditioned.
    expect(db.calls).toHaveLength(1);
  });

  it("reads the episode store through a FRESH episode predicate, not the fact's", async () => {
    const db = reader();
    await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact", "raw-episode"],
      limit: 10,
      expand: false,
    });
    const episodeCall = db.calls.find((c) => c.sql.includes("brain_episodes"))!;
    // A join gated by the FACT's predicate would hand a caller a private
    // message because they were entitled to a conclusion drawn from it.
    expect(episodeCall.sql).toContain("e.visible_to && $2::text[]");
    expect(episodeCall.sql).not.toContain("f.visible_to");
  });
});

// ---------------------------------------------------------------------------
// Labeling
// ---------------------------------------------------------------------------

describe("trust labeling", () => {
  it("labels every fused row with its class and trust tier", async () => {
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.episodePage, rows: [episodeRow()] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact", "raw-episode"],
      limit: 10,
      expand: false,
    });
    expect(res.results).toHaveLength(2);
    for (const row of res.results) {
      expect(row.tier).toBeDefined();
      expect(row).toHaveProperty("trustTier");
    }
    const byTier = new Map<string, BrainSearchResult>(res.results.map((r) => [r.tier, r]));
    expect(byTier.get("fact")?.trustTier).toBe(2);
    expect(byTier.get("raw-episode")?.trustTier).toBe(3);
  });

  it("orders a fused cohort by trust tier — the fact leads, the episode follows", async () => {
    // The one place trust touches ordering. Swapping `tierRank`'s subtraction
    // would leave every other assertion in this file green: `search.test.ts`
    // otherwise reads results through a Map, and `fusion.test.ts` exercises a
    // synthetic tiebreak rather than this one.
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.episodePage, rows: [episodeRow()] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact", "raw-episode"],
      limit: 10,
      expand: false,
    });
    expect(res.results.map((r) => r.tier)).toEqual(["fact", "raw-episode"]);
  });

  it("clamps an over-large limit in the core, not only in the tool wrapper", async () => {
    const db = reader();
    await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 9_999,
      expand: false,
    });
    const call = db.calls.find((c) => c.sql.includes(SQL.factPage))!;
    expect(call.params[call.params.length - 1]).toBe(50);
  });

  it("returns an unextracted episode tagged `pending`, with its stable source id", async () => {
    // ADR-0036's committed behavior — and with the extraction fiber default-OFF
    // this is the ONLY thing the brain half of a fresh deployment can return.
    const db = reader([{ match: SQL.episodePage, rows: [episodeRow({ extracted_at: null })] }]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["raw-episode"],
      limit: 10,
      expand: false,
    });
    const row = res.results[0];
    expect(row.tier).toBe("raw-episode");
    if (row.tier !== "raw-episode") throw new Error("unreachable");
    expect(row.extraction).toBe("pending");
    expect(row.extractedAt).toBeNull();
    expect(row.sourceId).toBe("m-1");
  });

  it("labels an extracted episode `complete`", async () => {
    const db = reader([
      {
        match: SQL.episodePage,
        rows: [episodeRow({ extracted_at: new Date("2026-06-02T00:00:00Z") })],
      },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["raw-episode"],
      limit: 10,
      expand: false,
    });
    const row = res.results[0];
    if (row.tier !== "raw-episode") throw new Error("expected an episode");
    expect(row.extraction).toBe("complete");
  });

  it("clips an over-long episode body and says so", async () => {
    const db = reader([
      { match: SQL.episodePage, rows: [episodeRow({ body: "x".repeat(5_000) })] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["raw-episode"],
      limit: 10,
      expand: false,
    });
    const row = res.results[0];
    if (row.tier !== "raw-episode") throw new Error("expected an episode");
    expect(row.bodyTruncated).toBe(true);
    expect(row.body).toHaveLength(4_000);
  });

  it("drops an episode row with no usable id rather than failing the whole read", async () => {
    const db = reader([
      { match: SQL.episodePage, rows: [episodeRow(), { ...episodeRow(), id: null }] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["raw-episode"],
      limit: 10,
      expand: false,
    });
    expect(res.results).toHaveLength(1);
  });

  it("labels and fuses DOCUMENT rows through the adapted executor", async () => {
    // The document store speaks a different port shape — a flat array, not
    // `{ rows }` — so `searchBrainCore` adapts the handle. Nothing else in this
    // file exercises that adapter, the document `resultKey` namespacing, or the
    // neighbours passthrough.
    const docRow = {
      id: "doc-1",
      path: "runbooks/eu.md",
      collection_id: "runbooks",
      title: "EU",
      description: null,
      type: "Runbook",
      tags: ["ops"],
      resource: null,
      atlas_source: "upload",
      atlas_ingested_at: null,
      timestamp: null,
      status: "published",
      snippet: "…**replica** lag…",
      rank: 0.4,
    };
    const db = reader([{ match: "FROM knowledge_documents kd", rows: [docRow] }]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["document"],
      limit: 10,
      expand: false,
    });
    expect(res.results).toHaveLength(1);
    const row = res.results[0];
    expect(row.tier).toBe("document");
    if (row.tier !== "document") throw new Error("unreachable");
    // `trustTier: null` is the honest answer: descriptive prose has no position
    // in ADR-0036's truth ordering. A number here would claim it does.
    expect(row.trustTier).toBeNull();
    expect(row.path).toBe("runbooks/eu.md");
    expect(row.provenance.status).toBe("published");
    expect(res.stores.document).toEqual({ queried: true, matched: 1, truncated: false });
  });

  it("reports each store's contribution, including stores it did not query", async () => {
    const db = reader([{ match: SQL.factPage, rows: [factRow()] }]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    expect(res.stores.fact).toEqual({ queried: true, matched: 1, truncated: false });
    expect(res.stores["raw-episode"].queried).toBe(false);
    expect(res.stores.document.queried).toBe(false);
  });

  it("flags a store that filled its page — silent truncation reads as 'nothing else exists'", async () => {
    const db = reader([{ match: SQL.factPage, rows: [factRow(), factRow({ id: "fact-2" })] }]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 2,
      expand: false,
    });
    const facts = res.stores.fact;
    expect(facts.queried).toBe(true);
    if (!facts.queried) throw new Error("unreachable");
    expect(facts.truncated).toBe(true);
  });

  it("coerces an out-of-vocabulary status to the CONSERVATIVE arm", async () => {
    // Query drift, not tenant data (`chk_brain_facts_status`). An unknown
    // status must never present to an agent as reviewed.
    const db = reader([{ match: SQL.factPage, rows: [factRow({ status: "weird" })] }]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "developer",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const row = res.results[0] as BrainFactResult;
    expect(row.status).toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// Tensions
// ---------------------------------------------------------------------------

describe("in-tension-with", () => {
  it("surfaces both edge directions and never orders by anything that implies a winner", async () => {
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      {
        match: SQL.tensionEdges,
        rows: [
          { from_id: "fact-1", to_id: "rival-b" },
          { from_id: "rival-a", to_id: "fact-1" },
        ],
      },
      {
        match: SQL.tensionCounterparts,
        rows: [
          { id: "rival-a", subject: "s", predicate: "p", object: "a", invalidated_at: null },
          { id: "rival-b", subject: "s", predicate: "p", object: "b", invalidated_at: null },
        ],
      },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const fact = res.results[0] as BrainFactResult;
    expect(fact.tensions).toHaveLength(2);
    expect(fact.tensions.map((t) => t.edgeDirection).sort()).toEqual(["from", "to"]);
    // Ordered by id — deliberately NOT by time, status, or corroboration, any
    // of which would be an arbitration this slice must not perform.
    expect(fact.tensions.map((t) => t.factId)).toEqual(["rival-a", "rival-b"]);
  });

  it("REPORTS a counterpart the reader may not see rather than dropping it", async () => {
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: [{ from_id: "fact-1", to_id: "secret-rival" }] },
      // The counterpart query is ACL-gated independently and returns nothing.
      { match: SQL.tensionCounterparts, rows: [] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const fact = res.results[0] as BrainFactResult;
    // An omitted row reads as "nothing contradicts this" — the one thing a
    // trust-labeled surface must never imply.
    expect(fact.tensions).toEqual([
      { visible: false, factId: "secret-rival", edgeDirection: "to" },
    ]);
  });

  it("carries a retracted counterpart's tombstone, because retraction never writes status", async () => {
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: [{ from_id: "fact-1", to_id: "rival" }] },
      {
        match: SQL.tensionCounterparts,
        rows: [
          {
            id: "rival",
            subject: "s",
            predicate: "p",
            object: "o",
            invalidated_at: new Date("2026-06-05T00:00:00Z"),
          },
        ],
      },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const fact = res.results[0] as BrainFactResult;
    const tension = fact.tensions[0];
    expect(tension.visible).toBe(true);
    if (!tension.visible) throw new Error("unreachable");
    expect(tension.invalidatedAt).toBe("2026-06-05T00:00:00.000Z");
  });

  it("reports the fan-out cap instead of silently shortening the conflict list", async () => {
    const edges = Array.from({ length: TENSION_FANOUT_CAP + 1 }, (_, i) => ({
      from_id: "fact-1",
      to_id: `rival-${i}`,
    }));
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: edges },
      { match: SQL.tensionCounterparts, rows: [] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    expect(res.tensionsTruncated).toBe(true);
  });

  it("skips the edge lookup entirely when no facts matched", async () => {
    const db = reader([{ match: SQL.factPage, rows: [] }]);
    await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    expect(db.calls.filter((c) => c.sql.includes(SQL.tensionEdges))).toHaveLength(0);
  });
});
