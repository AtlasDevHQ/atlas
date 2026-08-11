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
 *   - `in-tension-with` surfaces the conflict cluster (#4913): both directions,
 *     unranked, each visible counterpart with its own provenance, and withheld
 *     counterparts reported as a count rather than dropped.
 *
 * A literal `BrainSearchReader` stands in for the pool — no `mock.module()`, no
 * singleton mutation. That the emitted SQL actually selects what these tests
 * assume is the `-pg` suite's job.
 */

import { describe, expect, it } from "bun:test";
import {
  BrainAsOfInvalidError,
  buildEpisodeQuery,
  buildFactQuery,
  parseBrainAsOf,
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
 * the assertion passes vacuously on the withheld arm. Since #4913 the
 * counterpart statement carries the corroboration subquery as well.
 *
 * The fact page is keyed on `last_observed_at` — the one column only it
 * selects. It was `valid_to` until #4935 gave the counterpart statement that
 * column too, at which point the counterpart query matched the fact page's key
 * first and was answered with the fact page's rows; then `predicate_cardinality`
 * until #5028 removed that column from `FACT_COLUMNS` on the way to dropping it.
 *
 * ⚠️ That removal made `FACT_COLUMNS` and `COUNTERPART_COLUMNS` BYTE-IDENTICAL,
 * so no key in the shared column list can ever separate them again — the
 * discriminator has to come from what `buildFactQuery` APPENDS. Corroboration is
 * not it (the counterpart statement carries that subquery too since #4913);
 * `last_observed_at` is the decay anchor (#4914) and the fact page is its only
 * selector. If a future slice gives the counterpart statement a decay signal,
 * this key has to move again: the invariant is "a column exactly one statement
 * selects", not any particular column.
 *
 * `reader()` ENFORCES that rather than trusting this paragraph. #4935 got a
 * loud failure only by luck of array order — `find()` is first-match-wins, so
 * the same collision with the keys listed the other way round yields a
 * VACUOUS PASS instead. The throw makes the next collision self-reporting.
 */
const SQL = {
  factPage: "AS last_observed_at",
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
      const hits = responses.filter((r) => sql.includes(r.match));
      if (hits.length > 1) {
        throw new Error(
          `ambiguous SQL fixture key: ${hits.map((h) => JSON.stringify(h.match)).join(", ")} all match one statement — one of them must move to a column exactly one statement selects`,
        );
      }
      return { rows: hits[0]?.rows ?? [] };
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
    visible_to: ["org"],
    pre_widening_visible_to: null,
    provenance: { source: "slack", sourceId: "m-1", episodeId: "ep-1" },
    source_episode_id: "ep-1",
    valid_from: null,
    valid_to: null,
    invalidated_at: null,
    ingested_at: new Date("2026-06-01T00:00:00Z"),
    corroboration_count: 1,
    // Selected by the fact query (#4914); NULL = no provenance edges. Present
    // in the fixture so no test row trips the decay drift arm by accident.
    last_observed_at: null,
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

  it("hides superseded facts exactly as tombstoned ones — the fourth predicate (#4912)", () => {
    // The regression this pins cuts both ways: a `valid_to IS NULL` row (every
    // pre-supersession fact) must still satisfy the predicate — the OR arm is
    // what keeps the whole corpus readable — while a stamped `valid_to` in the
    // past falls out of it, because a human promotion explicitly replaced that
    // belief and serving it as current would undo the arbitration.
    const { sql } = buildFactQuery("published", { limit: 10, ...acl(ctx(), "brain_facts") });
    expect(sql).toContain("(f.valid_to IS NULL OR f.valid_to > now())");
    // Developer mode overlays DRAFTS, not superseded history — the supersession
    // axis is orthogonal to review status and gates both modes.
    const dev = buildFactQuery("developer", { limit: 10, ...acl(ctx(), "brain_facts") });
    expect(dev.sql).toContain("(f.valid_to IS NULL OR f.valid_to > now())");
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

// ---------------------------------------------------------------------------
// asOf — the bi-temporal point read (#4916)
// ---------------------------------------------------------------------------

describe("asOf — the bi-temporal point read (#4916)", () => {
  const AS_OF = "2026-07-01T00:00:00.000Z";

  it("switches the temporal predicate to the validity window, both bounds off ONE parameter", () => {
    const { sql, params } = buildFactQuery("published", {
      limit: 10,
      asOf: parseBrainAsOf(AS_OF),
      ...acl(ctx(), "brain_facts"),
    });
    // `valid_from <= asOf < COALESCE(valid_to, ∞)` — a NULL `valid_from`
    // (an unrecorded start) is admitted, matching the default read.
    expect(sql).toContain("(f.valid_from IS NULL OR f.valid_from <= $3::timestamptz)");
    expect(sql).toContain("(f.valid_to IS NULL OR f.valid_to > $3::timestamptz)");
    // The as-of-now supersession clause is REPLACED, not composed: composing
    // both would hide every superseded fact from the historical read — the
    // exact rows the point read exists to serve.
    expect(sql).not.toContain("now()");
    expect(params).toContain(AS_OF);
  });

  it("keeps the tombstone filter under asOf — retraction hides history at EVERY instant", () => {
    // The boundary rule cut both ways in the ADR: superseded facts DO appear
    // inside their window (previous test); tombstoned facts NEVER do, because
    // retraction (the review gate's reject verb, and the GDPR-erasure path) is
    // the one verb whose job is hiding.
    const { sql } = buildFactQuery("published", {
      limit: 10,
      asOf: parseBrainAsOf(AS_OF),
      ...acl(ctx(), "brain_facts"),
    });
    expect(sql).toContain("f.invalidated_at IS NULL");
  });

  it("leaves the default read byte-identical — the regression pin", () => {
    // A GOLDEN pin, not a contains-check: the literal below is the statement
    // the pre-#4916 builder emitted (captured from it verbatim), so any
    // reordering, reformatting, or new clause the asOf branch leaks into the
    // default arm fails byte-for-byte. If this fails because you CHANGED the
    // default fact read on purpose, re-capture the literal — that is the
    // deliberate act this pin exists to force.
    const { sql, params } = buildFactQuery("published", {
      query: "billing",
      limit: 10,
      ...acl(ctx(), "brain_facts"),
    });
    expect(sql).toBe(`SELECT f.id::text AS id,
         f.subject,
         f.predicate,
         f.object,
         f.status,
         f.visible_to,
         f.pre_widening_visible_to,
         f.provenance,
         f.source_episode_id::text AS source_episode_id,
         f.valid_from,
         f.valid_to,
         f.invalidated_at,
         f.ingested_at,
         (
    SELECT COUNT(DISTINCT ed.to_episode_id)
      FROM brain_edges ed
     WHERE ed.workspace_id = f.workspace_id
       AND ed.edge_type = 'provenance'
       AND ed.from_fact_id = f.id
  )::int AS corroboration_count,
         (
    SELECT MAX(COALESCE(ep.occurred_at, ep.ingested_at))
      FROM brain_edges ed
      JOIN brain_episodes ep
        ON ep.workspace_id = ed.workspace_id
       AND ep.id = ed.to_episode_id
     WHERE ed.workspace_id = f.workspace_id
       AND ed.edge_type = 'provenance'
       AND ed.from_fact_id = f.id
  ) AS last_observed_at,
         ts_headline('english', f.subject || ' ' || f.predicate || ' ' || f.object, websearch_to_tsquery('english', $3),
        'StartSel=**, StopSel=**, MaxFragments=1, MaxWords=28, MinWords=4') AS snippet,
         ts_rank(f.fts, websearch_to_tsquery('english', $3)) AS rank
    FROM brain_facts f
   WHERE (f.workspace_id = $1 AND f.visible_to && $2::text[])
     AND f.status = 'published'
     AND f.invalidated_at IS NULL
     AND (f.valid_to IS NULL OR f.valid_to > now())
     AND f.fts @@ websearch_to_tsquery('english', $3)
   ORDER BY rank DESC NULLS LAST, f.ingested_at DESC, f.id DESC
   LIMIT $4`);
    expect(params).toEqual([WS, ["org", "role:member", "user:user-1"], "billing", 10]);
  });

  it("rejects a malformed asOf loudly, naming the value — never falls through to as-of-now", () => {
    expect(() => parseBrainAsOf("last tuesday")).toThrow(BrainAsOfInvalidError);
    expect(() => parseBrainAsOf("last tuesday")).toThrow(/"last tuesday"/);
    expect(() => parseBrainAsOf("last tuesday")).toThrow(/ISO-8601/);
    // `new Date()` would happily parse these; the ISO shape gate must not.
    expect(() => parseBrainAsOf("July 1 2026")).toThrow(BrainAsOfInvalidError);
    expect(() => parseBrainAsOf("07/01/2026")).toThrow(BrainAsOfInvalidError);
  });

  it("rejects a zone-less time — it would be read in the SERVER's timezone", () => {
    // `new Date("2026-07-01T02:00:00")` is interpreted in the process's local
    // zone (ECMA-262), so the same call would answer a different instant per
    // deployment — a silent hours-scale shift of the point read. Malformed.
    expect(() => parseBrainAsOf("2026-07-01T02:00:00")).toThrow(BrainAsOfInvalidError);
    expect(() => parseBrainAsOf("2026-07-01T02:00:00")).toThrow(/zone/);
    // A bare DATE is fine: ECMA-262 reads it as UTC midnight, deterministically.
    const dateOnly: string = parseBrainAsOf("2026-07-01");
    expect(dateOnly).toBe(AS_OF);
  });

  it("rejects instants below the timestamptz floor instead of failing the bind as an internal fault", () => {
    // JS parses year zero; Postgres has no year zero. Without the floor this
    // would surface at the bind as a retryable `search_failed` — the wrong
    // recovery signal for a caller-argument problem.
    expect(() => parseBrainAsOf("0000-01-05T00:00:00Z")).toThrow(BrainAsOfInvalidError);
    expect(() => parseBrainAsOf("0000-01-05T00:00:00Z")).toThrow(/0001-01-01/);
  });

  it("caps the echoed value in the rejection message — caller input is unbounded", () => {
    const huge = `${"9".repeat(500)}!`;
    try {
      parseBrainAsOf(huge);
      throw new Error("expected a rejection");
    } catch (err) {
      if (!(err instanceof BrainAsOfInvalidError)) throw err;
      expect(err.message.length).toBeLessThan(400);
      expect(err.message).toContain("…");
    }
  });

  it("rejects a BLANK asOf rather than treating it as absent", () => {
    // '   '.trim() || undefined is the sibling params' normalization, and it
    // is exactly the silent fall-through #4916 forbids on this one.
    expect(() => parseBrainAsOf("")).toThrow(BrainAsOfInvalidError);
    expect(() => parseBrainAsOf("   ")).toThrow(BrainAsOfInvalidError);
  });

  it("rejects a FUTURE asOf — beliefs not yet held are not a point this surface answers", () => {
    const now = () => Date.parse("2026-07-30T00:00:00Z");
    expect(() => parseBrainAsOf("2026-08-01T00:00:00Z", now)).toThrow(BrainAsOfInvalidError);
    expect(() => parseBrainAsOf("2026-08-01T00:00:00Z", now)).toThrow(/future/);
    // The boundary itself is admitted: `asOf === now` is a valid past-or-present instant.
    const atNow: string = parseBrainAsOf("2026-07-30T00:00:00Z", now);
    expect(atNow).toBe("2026-07-30T00:00:00.000Z");
  });

  it("normalizes the instant to canonical ISO-8601 UTC", () => {
    // Bound as `timestamptz` and echoed on the response, so both carry the
    // canonical spelling rather than the caller's local-offset one.
    const normalized: string = parseBrainAsOf(" 2026-07-01T02:00:00+02:00 ");
    expect(normalized).toBe(AS_OF);
  });

  it("echoes the normalized asOf on the response — a historical page must say it is one", async () => {
    const db = reader([{ match: SQL.factPage, rows: [factRow()] }]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      asOf: "2026-07-01T02:00:00+02:00",
      limit: 10,
      expand: false,
    });
    expect(res.asOf).toBe(AS_OF);
    const factCall = db.calls.find((c) => c.sql.includes(SQL.factPage))!;
    expect(factCall.params).toContain(AS_OF);
  });

  it("omits the field entirely on a default read — absence IS the 'current belief' statement", async () => {
    const db = reader([{ match: SQL.factPage, rows: [factRow()] }]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    expect("asOf" in res).toBe(false);
  });

  it("refuses an unusable asOf BEFORE any store runs", async () => {
    const db = reader();
    await expect(
      searchBrainCore(db, {
        ctx: ctx(),
        mode: "published",
        asOf: "garbage",
        limit: 10,
        expand: false,
      }),
    ).rejects.toBeInstanceOf(BrainAsOfInvalidError);
    expect(db.calls).toHaveLength(0);
  });

  it("refuses asOf when `include` excludes the fact store — a temporal ask of atemporal stores", async () => {
    // Echoing `asOf` over current-only documents/episodes would label
    // as-of-now content as a historical page; dropping the parameter silently
    // is the fall-through #4916 forbids. So it is a refusal, before any store.
    const db = reader();
    await expect(
      searchBrainCore(db, {
        ctx: ctx(),
        mode: "published",
        include: ["document", "raw-episode"],
        asOf: AS_OF,
        limit: 10,
        expand: false,
      }),
    ).rejects.toBeInstanceOf(BrainAsOfInvalidError);
    expect(db.calls).toHaveLength(0);
  });

  it("does NOT leak the temporal predicate into the episode store — episodes have no validity window", async () => {
    const db = reader();
    await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact", "raw-episode"],
      asOf: AS_OF,
      limit: 10,
      expand: false,
    });
    const episodeCall = db.calls.find((c) => c.sql.includes(SQL.episodePage))!;
    expect(episodeCall.sql).not.toContain("valid_from");
    expect(episodeCall.sql).not.toContain("valid_to");
    expect(episodeCall.params).not.toContain(AS_OF);
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
    // The STORE statement, not any statement touching the table — the fact
    // page's decay anchor (#4914) also names `brain_episodes`, in a subquery.
    const episodeCall = db.calls.find((c) => c.sql.includes(SQL.episodePage))!;
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

/**
 * A counterpart row as the shared cluster loader's SELECT shapes it
 * (`lib/brain/tensions.ts`). Fully formed so the provenance assertions below
 * are about projection, not about drift fallbacks.
 */
function rivalRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    subject: "billing pipeline",
    predicate: "owned_by",
    object: `team-${id}`,
    status: "published",
    visible_to: ["org"],
    pre_widening_visible_to: null,
    provenance: {
      source: "slack",
      sourceId: `m-${id}`,
      episodeId: `ep-${id}`,
      actor: `U-${id}`,
      producer: "extraction:v1",
      occurredAt: "2026-05-30T00:00:00.000Z",
      extractedAt: "2026-05-30T00:05:00.000Z",
      reconciledAt: "2026-05-30T00:06:00.000Z",
    },
    source_episode_id: `ep-${id}`,
    valid_from: null,
    invalidated_at: null,
    ingested_at: new Date("2026-06-01T00:00:00Z"),
    corroboration_count: 1,
    ...overrides,
  };
}

describe("in-tension-with — the conflict cluster (#4913)", () => {
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
        rows: [rivalRow("rival-a"), rivalRow("rival-b")],
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
    const visible = fact.tensions.filter((t) => t.visible === true);
    expect(visible.map((t) => t.edgeDirection).sort()).toEqual(["from", "to"]);
    // Ordered by id — deliberately NOT by time, status, or corroboration, any
    // of which would be an arbitration this slice must not perform.
    expect(visible.map((t) => t.factId)).toEqual(["rival-a", "rival-b"]);
  });

  it("carries each visible counterpart's claim WITH its provenance — surfaced-both-with-provenance", async () => {
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: [{ from_id: "fact-1", to_id: "rival-a" }] },
      { match: SQL.tensionCounterparts, rows: [rivalRow("rival-a")] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const fact = res.results[0] as BrainFactResult;
    const rival = fact.tensions[0];
    if (rival?.visible !== true) throw new Error("expected a visible counterpart");
    expect(rival.object).toBe("team-rival-a");
    expect(rival.status).toBe("published");
    expect(rival.corroborationCount).toBe(1);
    expect(rival.ingestedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(rival.provenance.producer).toBe("extraction:v1");
    expect(rival.provenance.source).toBe("slack");
    expect(rival.provenance.attribution).toEqual({
      visible: true,
      sourceId: "m-rival-a",
      actor: "U-rival-a",
      occurredAt: "2026-05-30T00:00:00.000Z",
    });
  });

  it("decides attribution per COUNTERPART row, off the rival's own pre-widening grant (#4836)", async () => {
    // The rival was first stated in a private channel and reached this reader
    // only through publish-time widening — its attribution triple is withheld
    // even though the OWNER fact's is not. Inheriting the owner's decision
    // would be a guess about a different row's grant.
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: [{ from_id: "fact-1", to_id: "rival-a" }] },
      {
        match: SQL.tensionCounterparts,
        rows: [
          rivalRow("rival-a", {
            visible_to: ["audience:chat-channel:slack:C-SECRET", "org"],
            pre_widening_visible_to: ["audience:chat-channel:slack:C-SECRET"],
          }),
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
    const rival = fact.tensions[0];
    if (rival?.visible !== true) throw new Error("expected a visible counterpart");
    // The CLAIM is disclosed — the reader is entitled to it — but who said it
    // first, where, and when stay with the original audience. Absent from the
    // serialized entry, not merely unreachable through the type.
    expect(rival.provenance.attribution).toEqual({ visible: false });
    expect(JSON.stringify(rival)).not.toContain("C-SECRET");
    expect(JSON.stringify(rival)).not.toContain("U-rival-a");
  });

  it("collapses counterparts the reader may not see into ONE withheld count rather than dropping them", async () => {
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      {
        match: SQL.tensionEdges,
        rows: [
          { from_id: "fact-1", to_id: "secret-rival-1" },
          { from_id: "fact-1", to_id: "secret-rival-2" },
        ],
      },
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
    // trust-labeled surface must never imply. Asserted with toEqual so the
    // withheld arm structurally cannot smuggle a claim payload (the wire
    // schema's z.strictObject, restated as a test).
    expect(fact.tensions).toEqual([{ visible: false, withheldCount: 2 }]);
  });

  it("appends the withheld count AFTER the id-sorted counterparts in a mixed cluster", async () => {
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      {
        match: SQL.tensionEdges,
        rows: [
          { from_id: "fact-1", to_id: "secret-rival" },
          { from_id: "fact-1", to_id: "rival-b" },
          { from_id: "rival-a", to_id: "fact-1" },
        ],
      },
      { match: SQL.tensionCounterparts, rows: [rivalRow("rival-a"), rivalRow("rival-b")] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const fact = res.results[0] as BrainFactResult;
    expect(
      fact.tensions.map((t) => (t.visible ? t.factId : `withheld:${t.withheldCount}`)),
    ).toEqual(["rival-a", "rival-b", "withheld:1"]);
  });

  it("never picks a winner — ordering ignores every authority signal, and no entry carries a verdict", async () => {
    // Every surfacing hint is stacked in favour of the LATER-sorting rival:
    // more corroboration, newer, published-vs-draft. If any code path ranked
    // by authority, recency, or status, `rival-z-strong` would lead. It must
    // not: entries are ordered by factId alone, and the shape has no field
    // that could carry a verdict.
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      {
        match: SQL.tensionEdges,
        rows: [
          { from_id: "fact-1", to_id: "rival-z-strong" },
          { from_id: "fact-1", to_id: "rival-a-weak" },
        ],
      },
      {
        match: SQL.tensionCounterparts,
        rows: [
          rivalRow("rival-z-strong", {
            status: "published",
            corroboration_count: 900,
            ingested_at: new Date("2026-07-01T00:00:00Z"),
          }),
          rivalRow("rival-a-weak", {
            status: "draft",
            corroboration_count: 0,
            ingested_at: new Date("2020-01-01T00:00:00Z"),
          }),
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
    const visible = fact.tensions.filter((t) => t.visible === true);
    expect(visible.map((t) => t.factId)).toEqual(["rival-a-weak", "rival-z-strong"]);
    // The entry's key set is closed: authority signals travel as display
    // fields, and there is no `rank`, `score`, `winner`, or `preferred` for a
    // producer to start setting.
    for (const entry of visible) {
      expect(Object.keys(entry).toSorted()).toEqual([
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
      ]);
    }
  });

  it("fetches counterparts in a SEPARATE ACL-gated statement, never a join onto the fact row", async () => {
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: [{ from_id: "fact-1", to_id: "rival-a" }] },
      { match: SQL.tensionCounterparts, rows: [rivalRow("rival-a")] },
    ]);
    await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    // The fact-page statement resolves no counterpart — a join gated by the
    // OWNER's predicate would hand a reader a rival's claim and provenance
    // because they were entitled to the fact it conflicts with.
    const factCall = db.calls.find((c) => c.sql.includes(SQL.factPage))!;
    expect(factCall.sql).not.toContain("in-tension-with");
    // The counterpart statement is its own query, carries the FRESH fact
    // predicate with the reader's own bound tokens, and joins nothing.
    const counterpartCall = db.calls.find((c) => c.sql.includes(SQL.tensionCounterparts))!;
    expect(counterpartCall.sql).toContain("f.visible_to && $2::text[]");
    expect(counterpartCall.sql).not.toContain("JOIN");
    expect(counterpartCall.params[1]).toEqual([
      "org",
      "role:member",
      "user:user-1",
    ]);
  });

  it("does NOT hide a superseded rival from the counterpart lookup (#4912)", async () => {
    // The queue-side sweep applied the current-validity predicate to the fact
    // page; the counterpart lookup must stay exempt, like the tombstone axis —
    // a rival retired at the publish gate is still why this claim was
    // contested, and hiding it would make the contradiction vanish the moment
    // its replacement published.
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: [{ from_id: "fact-1", to_id: "rival" }] },
      { match: SQL.tensionCounterparts, rows: [] },
    ]);
    await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const counterpart = db.calls.find((c) => c.sql.includes("= ANY(") && !c.sql.includes("in-tension-with"));
    // Both columns are SELECTED (that is #4935's label) — what must never
    // appear is a PREDICATE on either axis. Matched as a SHAPE, not as the two
    // spellings the fact query happens to use today: `IS NOT NULL`, `>=`, and
    // `COALESCE(valid_to, ...)` would all slip past a literal check.
    const temporalPredicate = /(valid_to|invalidated_at)\s*(IS\b|[<>=]|BETWEEN)|COALESCE\s*\(\s*f?\.?(valid_to|invalidated_at)/i;
    expect(counterpart?.sql).not.toMatch(temporalPredicate);
    // ...and both are still selected, which is the half a filter-only
    // assertion would let a regression drop silently.
    expect(counterpart?.sql).toContain("f.valid_to");
    expect(counterpart?.sql).toContain("f.invalidated_at");
  });

  it("carries a retracted counterpart's tombstone, because retraction never writes status", async () => {
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: [{ from_id: "fact-1", to_id: "rival" }] },
      {
        match: SQL.tensionCounterparts,
        rows: [rivalRow("rival", { invalidated_at: new Date("2026-06-05T00:00:00Z") })],
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
    // The other axis is untouched: retraction does not close the window.
    expect(tension.validTo).toBeNull();
  });

  it("carries a superseded counterpart's closed window, because supersession never writes status either (#4935)", async () => {
    // The publish-gate path, and the reason this matters more than the
    // tombstone axis: `reconcile.ts` writes the `in-tension-with` edge at
    // ingest, the gate later stamps `valid_to` on the claim it retires, and
    // nothing deletes the edge. So the winner permanently carries the loser as
    // a counterpart. Without `validTo` that counterpart reports `published` /
    // `invalidatedAt: null` — a conflict a human already arbitrated, served to
    // the agent as live and unresolved.
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: [{ from_id: "fact-1", to_id: "rival" }] },
      {
        match: SQL.tensionCounterparts,
        rows: [rivalRow("rival", { valid_to: new Date("2026-06-05T00:00:00Z") })],
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
    expect(tension.validTo).toBe("2026-06-05T00:00:00.000Z");
    // The negative that pins WHY the field is needed: every other signal on
    // this counterpart still reads exactly like a live rival.
    expect(tension.status).toBe("published");
    expect(tension.invalidatedAt).toBeNull();
  });

  it("leaves a live counterpart's validTo null", async () => {
    // The negative. A projection hard-coding a timestamp, or one carrying the
    // OWNER's window onto its rivals, would satisfy the assertion above.
    const db = reader([
      { match: SQL.factPage, rows: [factRow({ valid_to: new Date("2026-06-09T00:00:00Z") })] },
      { match: SQL.tensionEdges, rows: [{ from_id: "fact-1", to_id: "rival" }] },
      { match: SQL.tensionCounterparts, rows: [rivalRow("rival")] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const tension = (res.results[0] as BrainFactResult).tensions[0];
    if (!tension.visible) throw new Error("unreachable");
    expect(tension.validTo).toBeNull();
  });

  it("keeps the counterpart labels absolute under asOf — neither rewound nor filtered (#4935)", async () => {
    // `loadTensionClusters` takes no `asOf`, which the agent prompt now states
    // as a promise ("both labels are as of NOW"). Nothing pinned it: the shape
    // assertion above runs on a non-`asOf` call, and the pg loop never reads
    // `.tensions` on its point read. So a later "consistency" pass that
    // threaded `asOf` into the counterpart query would go undetected — and it
    // has two bad outcomes, both silent. Filtering makes a rival superseded
    // before `asOf` VANISH, which is this module's cardinal sin: an omitted
    // conflict reads as "nothing contradicts this". Rewinding makes the label
    // `asOf`-relative while the prompt still tells the model it is not.
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: [{ from_id: "fact-1", to_id: "rival" }] },
      {
        match: SQL.tensionCounterparts,
        rows: [rivalRow("rival", { valid_to: new Date("2026-06-05T00:00:00Z") })],
      },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
      asOf: "2026-06-01T00:00:00.000Z",
    });
    const counterpartSql = db.calls.find(
      (c) => c.sql.includes("= ANY(") && !c.sql.includes("in-tension-with"),
    )?.sql;
    // No temporal predicate reached the counterpart query, so the rival is
    // still listed even though it was live at the requested instant.
    expect(counterpartSql).not.toMatch(/(valid_to|invalidated_at)\s*(IS\b|[<>=]|BETWEEN)/i);
    const tension = (res.results[0] as BrainFactResult).tensions[0];
    if (!tension.visible) throw new Error("the counterpart was dropped under asOf");
    // The stamp itself, not a value relative to `asOf` — which is BEFORE it.
    expect(tension.validTo).toBe("2026-06-05T00:00:00.000Z");
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
    // And the loader asked for cap + 1 edges — the overflow row is how
    // truncation is DETECTED, so a bind regressed to `cap` would silently
    // drop the tail edge with the flag never set. The literal reader ignores
    // LIMIT, so only the bound parameter can pin this.
    const edgeCall = db.calls.find((c) => c.sql.includes(SQL.tensionEdges))!;
    expect(edgeCall.params[2]).toBe(TENSION_FANOUT_CAP + 1);
  });

  it("never converts truncated-away edges into withheld rivals", async () => {
    // The two degradations must stay distinct: an edge lost to the cap is
    // reported ONLY through `tensionsTruncated`, while `withheldCount` means
    // "this rival exists and ACL hides it from you". Conflating them would be
    // fabricated ACL withholding. Every surviving counterpart here is visible,
    // so no withheld arm may appear even though the cap bit.
    const edges = Array.from({ length: TENSION_FANOUT_CAP + 1 }, (_, i) => ({
      from_id: "fact-1",
      // Padded so the mock's array order is also lexicographic — the loader
      // slices the first `cap` edges before pairing.
      to_id: `rival-${String(i).padStart(4, "0")}`,
    }));
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      { match: SQL.tensionEdges, rows: edges },
      {
        match: SQL.tensionCounterparts,
        rows: edges.map((e) => rivalRow(e.to_id)),
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
    expect(res.tensionsTruncated).toBe(true);
    expect(fact.tensions).toHaveLength(TENSION_FANOUT_CAP);
    expect(fact.tensions.every((t) => t.visible === true)).toBe(true);
  });

  it("counts DISTINCT withheld rivals, not edge-ends, under a raced reciprocal pair", async () => {
    // `reconcile.ts`'s `WHERE NOT EXISTS` dedupes one direction only, so A→B
    // and B→A can coexist after a race. One hidden rival must not report as
    // two — the count is the whole signal the withheld arm carries.
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      {
        match: SQL.tensionEdges,
        rows: [
          { from_id: "fact-1", to_id: "secret-rival" },
          { from_id: "secret-rival", to_id: "fact-1" },
        ],
      },
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
    expect(fact.tensions).toEqual([{ visible: false, withheldCount: 1 }]);
  });

  it("lists a VISIBLE reciprocal rival once per direction — graph-faithful, not double-counted", async () => {
    // The counterpart to the dedupe above, pinned so neither semantics can
    // silently drift into the other: a visible entry carries `edgeDirection`,
    // so one entry per edge is a faithful report of the graph; only the
    // direction-less withheld COUNT collapses to distinct rivals.
    const db = reader([
      { match: SQL.factPage, rows: [factRow()] },
      {
        match: SQL.tensionEdges,
        rows: [
          { from_id: "fact-1", to_id: "rival-a" },
          { from_id: "rival-a", to_id: "fact-1" },
        ],
      },
      { match: SQL.tensionCounterparts, rows: [rivalRow("rival-a")] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const fact = res.results[0] as BrainFactResult;
    expect(
      fact.tensions.map((t) => (t.visible ? `${t.factId}:${t.edgeDirection}` : "withheld")),
    ).toEqual(["rival-a:to", "rival-a:from"]);
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

// ---------------------------------------------------------------------------
// Provenance attribution on a widened fact (#4836)
// ---------------------------------------------------------------------------

/**
 * `searchBrain` is what makes #4836 a user-visible disclosure rather than an
 * admin-queue one: it feeds agent chat answers, so a widened fact reaching an
 * org reader here hands them a private channel's first speaker without anybody
 * opening `/admin/brain/facts`. That is why this suite covers it and not only
 * `candidates.test.ts`.
 *
 * The reader-visible SELECT is deliberately NOT what is asserted — the row came
 * back through `aclVisibilityClause` and it is supposed to, because the CLAIM is
 * legitimately visible. What is asserted is what the projection does with it.
 */
describe("provenance attribution — the widened-fact disclosure (#4836)", () => {
  /** The Slack private channel a claim was first stated in. */
  const PRIVATE = "audience:chat-channel:slack:C-FOUNDERS";

  /**
   * Stated first in `#atlas-founders`, restated publicly, published with the
   * union — the §C3 shape from the soak corpus. `sourceId` is
   * `<channelId>:<ts>`, which is where the channel id leaks.
   */
  const widenedRow = () =>
    factRow({
      visible_to: [PRIVATE, "org"],
      pre_widening_visible_to: [PRIVATE],
      provenance: {
        source: "slack",
        sourceId: "C-FOUNDERS:1799999999.001",
        episodeId: "ep-1",
        actor: "U-FOUNDER",
        producer: "extraction:v1",
        occurredAt: "2026-05-30T00:00:00.000Z",
        extractedAt: "2026-05-30T00:05:00.000Z",
        reconciledAt: "2026-05-30T00:06:00.000Z",
      },
    });

  async function provenanceFor(context: BrainPrincipalContext, row: Record<string, unknown>) {
    const db = reader([
      { match: SQL.factPage, rows: [row] },
      { match: SQL.tensionEdges, rows: [] },
    ]);
    const res = await searchBrainCore(db, {
      ctx: context,
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    return (res.results[0] as BrainFactResult).provenance;
  }

  it("withholds actor, sourceId and occurredAt from a reader gained by widening", async () => {
    const p = await provenanceFor(ctx(), widenedRow());
    expect(p.attribution).toEqual({ visible: false });
    // Asserted on the SERIALIZED row too, not just the union arm. The point of
    // a discriminated variant over three nulled fields is that the withheld
    // shape cannot carry the payload — so the leak must be absent from the
    // object, not merely unreachable through the type.
    expect(JSON.stringify(p)).not.toContain("C-FOUNDERS");
    expect(JSON.stringify(p)).not.toContain("U-FOUNDER");
  });

  it("still discloses the non-attributing half of the payload", async () => {
    // Withholding the triple must not blank the row. `source` is a connector
    // CLASS and `producer` a pipeline stage — neither names a person or a
    // place, and an agent that lost them could no longer say where a claim
    // came from at all.
    const p = await provenanceFor(ctx(), widenedRow());
    expect(p.source).toBe("slack");
    expect(p.producer).toBe("extraction:v1");
    expect(p.episodeId).toBe("ep-1");
  });

  it("does not report withholding as a drifted payload", async () => {
    // `payloadComplete` answers "did the producer write a well-formed record",
    // and the stored record here is perfect. Letting an ACL decision flip it
    // would tell every org reader Atlas has a data-integrity problem.
    const p = await provenanceFor(ctx(), widenedRow());
    expect(p.payloadComplete).toBe(true);
  });

  it("gives a member of the ORIGINAL audience full attribution", async () => {
    // The half that must not regress: the private channel's own members are
    // exactly the readers who can act on this claim.
    const p = await provenanceFor(
      ctx({ audienceIds: ["chat-channel:slack:C-FOUNDERS"] }),
      widenedRow(),
    );
    expect(p.attribution).toEqual({
      visible: true,
      sourceId: "C-FOUNDERS:1799999999.001",
      actor: "U-FOUNDER",
      occurredAt: "2026-05-30T00:00:00.000Z",
    });
  });

  it("leaves a fact that was NEVER widened untouched", async () => {
    // The negative. `pre_widening_visible_to IS NULL` is the overwhelming
    // majority of any corpus, and a fix that quietly withheld across the board
    // would satisfy every assertion above.
    const p = await provenanceFor(
      ctx(),
      factRow({
        visible_to: ["org"],
        pre_widening_visible_to: null,
        provenance: {
          source: "slack",
          sourceId: "C-ENG:1799999999.002",
          episodeId: "ep-1",
          actor: "U-ENG",
          producer: "extraction:v1",
          occurredAt: "2026-05-30T00:00:00.000Z",
          extractedAt: "2026-05-30T00:05:00.000Z",
          reconciledAt: "2026-05-30T00:06:00.000Z",
        },
      }),
    );
    expect(p.attribution).toEqual({
      visible: true,
      sourceId: "C-ENG:1799999999.002",
      actor: "U-ENG",
      occurredAt: "2026-05-30T00:00:00.000Z",
    });
  });

  it("selects the pre-widening grant, so the decision has an input at all", async () => {
    // Cheap to assert, and it is what keeps every test above non-vacuous: the
    // mocked rows supply `pre_widening_visible_to` themselves, so without this
    // the suite would pass against a SELECT that never asked for it.
    //
    // Dropping the column is not a DISCLOSURE — `attributionDecision` treats
    // the resulting `undefined` as drift and withholds. It is the opposite
    // failure: attribution withheld across the entire corpus, degrading the
    // review surface for exactly the people #4836 refuses to degrade it for.
    // Silent either way, which is why it is pinned.
    const db = reader([{ match: SQL.factPage, rows: [] }]);
    await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    expect(db.calls[0]?.sql).toContain("f.pre_widening_visible_to");
  });
});

/**
 * Read-time decay on the agent path (#4914, ADR-0036 §Temporal).
 *
 * `searchBrain` is where a stale claim reaches a chat answer, so the wire must
 * hand the agent the fact's age — and must NOT let decay touch anything else:
 * not the trust tier, not the status, not the retrieval ranking.
 */
describe("searchBrainCore — read-time decay (#4914)", () => {
  const OLD = "2020-01-01T00:00:00.000Z";

  async function factFor(row: Record<string, unknown>) {
    const db = reader([{ match: SQL.factPage, rows: [row] }]);
    const response = await searchBrainCore(db, {
      ctx: ctx(),
      mode: "published",
      include: ["fact"],
      limit: 10,
      expand: false,
    });
    const fact = response.results[0] as BrainFactResult | undefined;
    if (!fact) throw new Error("expected one fact result");
    return { fact, db };
  }

  it("carries the temporal metadata the agent presents instead of arbitrating", async () => {
    const { fact } = await factFor(
      factRow({ last_observed_at: OLD, valid_from: "2019-06-01T00:00:00.000Z" }),
    );
    expect(fact.decay.level).toBe("stale");
    expect(fact.decay.lastObservedAt).toBe(OLD);
    expect(fact.decay.ageDays).toBeGreaterThan(0);
    expect(fact.validFrom).toBe("2019-06-01T00:00:00.000Z");
    expect(fact.corroborationCount).toBe(1);
  });

  it("leaves the trust label untouched by staleness", async () => {
    // The acceptance criterion as a negative: `stale` never demotes. The row
    // keeps tier-2, its stored status, and its place in the result set.
    const { fact } = await factFor(factRow({ last_observed_at: OLD }));
    expect(fact.tier).toBe("fact");
    expect(fact.trustTier).toBe(2);
    expect(fact.status).toBe("published");
  });

  it("emits only reads while serving decay — no write path from the signal", async () => {
    const { db } = await factFor(factRow({ last_observed_at: OLD }));
    expect(db.calls.length).toBeGreaterThan(0);
    for (const call of db.calls) {
      expect(call.sql.trimStart()).toMatch(/^SELECT/i);
    }
  });

  it("selects the observation but never ranks by it", async () => {
    // Retrieval order stays relevance (then recency of ingest) — age-ordering
    // results would be exactly the arbitration decay is forbidden to do. The
    // decay anchor appears in the SELECT list only.
    const { db } = await factFor(factRow({ last_observed_at: OLD }));
    const sql = db.calls[0]?.sql ?? "";
    expect(sql).toContain("AS last_observed_at");
    const orderAt = sql.indexOf("ORDER BY");
    expect(orderAt).toBeGreaterThan(-1);
    expect(sql.slice(orderAt)).not.toContain("last_observed_at");
    expect(sql.slice(orderAt)).not.toContain("make_interval");
  });

  it("withholds the numbers with attribution but keeps the level (#4836)", async () => {
    // Same decision, both consumers: for a singly-corroborated fact the
    // newest observation IS the withheld `occurredAt`.
    const { fact } = await factFor(
      factRow({
        visible_to: ["audience:chat-channel:slack:C-PRIVATE", "org"],
        pre_widening_visible_to: ["audience:chat-channel:slack:C-PRIVATE"],
        last_observed_at: OLD,
      }),
    );
    expect(fact.provenance.attribution).toEqual({ visible: false });
    expect(fact.decay).toEqual({ level: "stale", ageDays: null, lastObservedAt: null });
  });
});
