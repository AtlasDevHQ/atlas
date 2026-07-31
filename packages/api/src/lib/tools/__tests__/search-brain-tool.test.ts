/**
 * Execute-wrapper coverage for the `searchBrain` tool (#4773) — the guards and
 * context wiring that live OUTSIDE the pure `searchBrainCore` (unit-tested with
 * an injected reader in `lib/brain/__tests__/search.test.ts`):
 *   - the four degraded paths, each carrying a machine-readable `reason`:
 *     no internal DB / unresolvable reader / failed search ⇒ `{ error, reason }`,
 *     no workspace ⇒ a shaped empty response LABELLED `unavailable`. The
 *     `reason` is what the MCP edge branches on, so a copy edit to the prose
 *     cannot silently reclassify an ACL refusal,
 *   - the fail-closed `mode` default (missing context ⇒ published, never drafts),
 *   - `normalizeSearchInput` applied end-to-end (limit clamp, `include` filter),
 *   - the error catch: a thrown query is logged and mapped to a generic,
 *     secret-free `{ error }` (CLAUDE.md: no stack/connection-string in responses).
 *
 * Kept in its own file (mock.module is file-global under the isolated runner) so
 * the mock-free query-builder tests stay clean.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { z } from "zod";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { AuthMode } from "@useatlas/types";

// Mutable mock state — set per test before invoking the tool.
let mockRequestContext:
  | {
      requestId?: string;
      user?: { id?: string; role?: string; activeOrganizationId?: string };
      atlasMode?: "developer" | "published";
    }
  | undefined;
let mockHasInternalDB = true;
let mockAuthMode: AuthMode = "none";
const queryCalls: { sql: string; params: unknown[] }[] = [];
let queryImpl: (sql: string, params?: unknown[]) => Promise<unknown[]> = async () => [];

const fakePool = {
  query: async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params: params ?? [] });
    return { rows: await queryImpl(sql, params) };
  },
};

// Full internal-DB mock via the sanctioned helper (mock-all-exports
// discipline) — a new export on db/internal must not break this file's load.
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: async (sql: string, params?: unknown[]) => {
      queryCalls.push({ sql, params: params ?? [] });
      return queryImpl(sql, params);
    },
    hasInternalDB: () => mockHasInternalDB,
  }),
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => fakePool,
}));

// The deployment's auth mode is env-derived and process-cached; mocking the
// module keeps this file self-contained (no top-level `process.env.X =`).
void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => mockAuthMode,
  getAuthModeSource: () => "explicit" as const,
  resetAuthModeCache: () => {},
}));

let loggedError: unknown;
let loggedWarn: unknown;
// Mock all value exports of the logger module (mock.module is file-global; a
// partial stub would hand `undefined` to any importer reaching an unmocked one).
const noopLogger = {
  info: () => {},
  warn: (obj: unknown) => {
    loggedWarn = obj;
  },
  debug: () => {},
  error: (obj: unknown) => {
    loggedError = obj;
  },
};
void mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  createLogger: () => noopLogger,
  getLogger: () => noopLogger,
  getRequestContext: () => mockRequestContext,
  withRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (v: unknown) => v,
  scrubLogFormatter: (o: unknown) => o,
  hashShareToken: (t: string) => t,
  setLogLevel: () => true,
}));

const { searchBrain, SEARCH_BRAIN_DESCRIPTION } = await import("@atlas/api/lib/tools/search-brain");
const { SEARCH_BRAIN_TOOL_DESCRIPTION } = await import("@atlas/api/lib/tools/descriptions");

function run(input: Record<string, unknown> = {}) {
  // AI SDK tool.execute(args, ToolCallOptions). Cast through unknown: the tool's
  // arg/return types are internal to this test and we only assert on the shape.
  return searchBrain.execute!(
    input as never,
    { toolCallId: "t1", messages: [] } as never,
  ) as unknown as Promise<Record<string, unknown>>;
}

/**
 * SQL the tool issued whose FROM targets one table, in call order.
 *
 * Matches `FROM <table>` rather than a bare substring: the fact statement
 * names `brain_episodes` inside its decay-anchor subquery (#4914) and
 * `brain_edges` inside corroboration, so a substring match would count the
 * fact read as an episode-store read and fail the include-filter negatives
 * vacuously. The subqueries spell `FROM brain_edges ed` / `JOIN brain_episodes
 * ep`, so anchoring on the store statements' own `FROM <table> <alias>` shape
 * keeps the discrimination honest.
 */
function sqlFor(table: string): string[] {
  return queryCalls
    .map((c) => c.sql)
    .filter((s) => new RegExp(`FROM ${table} (?:f|e|d|kd)\\b`).test(s) || s.includes(`FROM ${table}\n`));
}

beforeEach(() => {
  mockRequestContext = {
    requestId: "req-1",
    user: { activeOrganizationId: "ws-1" },
    atlasMode: "published",
  };
  mockHasInternalDB = true;
  mockAuthMode = "none";
  queryCalls.length = 0;
  queryImpl = async () => [];
  loggedError = undefined;
  loggedWarn = undefined;
});

describe("searchBrain tool.execute", () => {
  it("returns an error (not empty results) when no internal DB is configured", async () => {
    mockHasInternalDB = false;
    const res = await run({ query: "x" });
    expect(res.error).toContain("internal database");
    expect(res.reason).toBe("no_internal_db");
    expect(queryCalls).toHaveLength(0);
  });

  it("labels the no-workspace empty response `unavailable` rather than leaving it bare", async () => {
    // Reachable in practice: an unbound stdio MCP actor (`system:mcp`) has no
    // `activeOrganizationId` and takes this path on every call. A bare
    // `{ results: [] }` there reads as "the company brain is empty", forever.
    mockRequestContext = { user: {} };
    const res = await run({ query: "x" });
    expect(res.error).toBeUndefined();
    expect(res.results).toEqual([]);
    expect(res.neighbors).toEqual([]);
    expect(res.unavailable).toBe("no_workspace");
    // Every store is still reported — an omitted `stores` block would read as
    // "the shape changed" rather than "nothing was searched".
    expect(res.stores).toEqual({
      fact: { queried: false },
      "raw-episode": { queried: false },
      document: { queried: false },
    });
    expect(queryCalls).toHaveLength(0);
  });

  it("reads all three stores by default", async () => {
    await run({ query: "x", expand: false });
    expect(sqlFor("brain_facts").length).toBeGreaterThan(0);
    expect(sqlFor("brain_episodes").length).toBeGreaterThan(0);
    expect(sqlFor("knowledge_documents").length).toBeGreaterThan(0);
  });

  it("honours `include` and skips the stores the caller excluded", async () => {
    await run({ query: "x", include: ["fact"], expand: false });
    expect(sqlFor("brain_facts").length).toBeGreaterThan(0);
    expect(sqlFor("brain_episodes")).toHaveLength(0);
    expect(sqlFor("knowledge_documents")).toHaveLength(0);
  });

  it("treats an entirely unrecognized `include` as absent rather than as 'read nothing'", async () => {
    // A typo must not silently produce an empty page — that is
    // indistinguishable from an empty brain, the failure this surface exists
    // to prevent.
    await run({ query: "x", include: ["facts"], expand: false });
    expect(sqlFor("brain_facts").length).toBeGreaterThan(0);
    expect(sqlFor("brain_episodes").length).toBeGreaterThan(0);
    expect(sqlFor("knowledge_documents").length).toBeGreaterThan(0);
  });

  it("defaults to published mode when request context carries no atlasMode", async () => {
    mockRequestContext = { user: { activeOrganizationId: "ws-1" } };
    await run({ query: "x", expand: false });
    const facts = sqlFor("brain_facts")[0];
    // Fail-closed on BOTH review-gated stores: the published-only clause,
    // never the draft overlay.
    expect(facts).toContain("f.status = 'published'");
    expect(facts).not.toContain("'draft'");
    expect(sqlFor("knowledge_documents")[0]).toContain("kd.status = 'published'");
  });

  it("uses the developer draft overlay when atlasMode is developer", async () => {
    mockRequestContext = {
      user: { activeOrganizationId: "ws-1" },
      atlasMode: "developer",
    };
    await run({ query: "x", expand: false });
    expect(sqlFor("brain_facts")[0]).toContain("f.status IN ('published', 'draft')");
    expect(sqlFor("knowledge_documents")[0]).toContain("kd.status IN ('published', 'draft')");
  });

  it("always ANDs the tombstone filter onto the fact read — the retracted-claims trap", async () => {
    await run({ query: "x", expand: false });
    expect(sqlFor("brain_facts")[0]).toContain("f.invalidated_at IS NULL");
  });

  it("clamps an over-large limit before querying", async () => {
    await run({ query: "x", limit: 999, expand: false });
    const factCall = queryCalls.find((c) => c.sql.includes("brain_facts"));
    expect(factCall).toBeDefined();
    // The LIMIT is the last bind param on every store query.
    expect(factCall!.params[factCall!.params.length - 1]).toBe(50);
  });

  it("refuses (does NOT return empty results) when the reader's identity is unresolvable", async () => {
    // `simple-key` mode with no user id ⇒ `unresolved` origin ⇒ `deny-all`.
    // Reporting that as an empty brain is what sends the agent to answer from
    // its own priors, so the tool must say the read was refused.
    mockAuthMode = "simple-key";
    mockRequestContext = { requestId: "req-1", user: { activeOrganizationId: "ws-1" } };
    const res = await run({ query: "x" });
    expect(res.error).toContain("refused");
    expect(res.error).toContain("not an empty knowledge base");
    // The machine-readable half — this is what the MCP edge branches on, and
    // what stops a copy edit to the prose above from silently demoting an ACL
    // refusal to a generic internal error.
    expect(res.reason).toBe("reader_unresolved");
    expect(res.results).toBeUndefined();
    // The request id is quotable, so the refusal correlates to the server log.
    expect(res.error).toContain("req-1");
    expect(loggedError).toBeDefined();
  });

  it("threads a valid asOf into the fact read and echoes it — the historical page says so (#4916)", async () => {
    const res = await run({ query: "x", include: ["fact"], asOf: "2026-07-01T00:00:00Z", expand: false });
    const factCall = queryCalls.find((c) => c.sql.includes("brain_facts"))!;
    expect(factCall.sql).toContain("f.valid_from IS NULL OR f.valid_from <=");
    expect(factCall.params).toContain("2026-07-01T00:00:00.000Z");
    expect(res.asOf).toBe("2026-07-01T00:00:00.000Z");
    expect(res.error).toBeUndefined();
  });

  it("rejects a malformed asOf with its own machine-readable reason — never answers as-of-now (#4916)", async () => {
    const res = await run({ query: "x", asOf: "yesterday-ish" });
    expect(res.error).toContain("yesterday-ish");
    expect(res.error).toContain("ISO-8601");
    expect(res.reason).toBe("invalid_as_of");
    expect(res.results).toBeUndefined();
    // Fail closed: nothing was searched — a page of CURRENT beliefs under a
    // rejected historical ask would be attributed to the asked-about instant.
    expect(queryCalls).toHaveLength(0);
    // Logged at warn (a caller mistake, not a server fault), with correlation.
    expect(loggedWarn).toMatchObject({ workspaceId: "ws-1", requestId: "req-1" });
    expect(loggedError).toBeUndefined();
  });

  it("rejects a BLANK asOf rather than normalizing it away like the document filters", async () => {
    // `since: '  '` becomes absent; `asOf: '  '` must NOT — an explicit
    // point-read argument that silently degrades to as-of-now is the exact
    // fall-through #4916 forbids.
    const res = await run({ query: "x", asOf: "   " });
    expect(res.reason).toBe("invalid_as_of");
    expect(queryCalls).toHaveLength(0);
  });

  it("logs and returns a generic, secret-free error when the query throws", async () => {
    queryImpl = async () => {
      throw new Error("connection to postgres://user:pw@host failed");
    };
    const res = await run({ query: "x" });
    expect(res.error).toContain("Company-brain search failed");
    expect(res.reason).toBe("search_failed");
    // The raw exception (which carries a connection string) must not leak.
    expect(JSON.stringify(res)).not.toContain("postgres://");
    expect(loggedError).toBeDefined();
  });

  it("returns fused, tier-labeled results on success", async () => {
    queryImpl = async (sql) => {
      if (sql.includes("brain_facts")) {
        return [
          {
            id: "f1",
            subject: "billing pipeline",
            predicate: "owned_by",
            object: "platform",
            status: "published",
            predicate_cardinality: "single",
            visible_to: ["org"],
            provenance: { source: "slack", sourceId: "m1", episodeId: "e1" },
            source_episode_id: "e1",
            valid_from: null,
            valid_to: null,
            invalidated_at: null,
            ingested_at: new Date("2026-06-01T00:00:00Z"),
            corroboration_count: 2,
            snippet: "**billing pipeline** owned_by platform",
          },
        ];
      }
      if (sql.includes("brain_episodes")) {
        return [
          {
            id: "e1",
            source: "slack",
            source_id: "m1",
            source_actor: "U1",
            body: "the billing pipeline is ours",
            locator: null,
            occurred_at: new Date("2026-05-30T00:00:00Z"),
            ingested_at: new Date("2026-05-30T00:01:00Z"),
            extracted_at: null,
            visible_to: ["org"],
            snippet: "the **billing pipeline** is ours",
          },
        ];
      }
      return [];
    };
    const res = await run({ query: "billing pipeline", include: ["fact", "raw-episode"], expand: false });
    const results = res.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    // Shape-enforced labeling: every row carries a tier and its trust tier.
    // Sorted to make the assertion order-independent — the FUSED order is
    // pinned separately in `lib/brain/__tests__/search.test.ts`.
    const tiers = [...results.map((r) => r.tier)].sort((a, b) => String(a).localeCompare(String(b)));
    expect(tiers).toEqual(["fact", "raw-episode"]);
    const fact = results.find((r) => r.tier === "fact")!;
    expect(fact.trustTier).toBe(2);
    expect(fact.corroborationCount).toBe(2);
    const episode = results.find((r) => r.tier === "raw-episode")!;
    expect(episode.trustTier).toBe(3);
    // The committed edge behavior — unextracted evidence is returned, labeled.
    expect(episode.extraction).toBe("pending");
    expect(episode.sourceId).toBe("m1");
  });
});

/**
 * The agent-facing honesty property (#4836), on BOTH agent surfaces.
 *
 * Prose is the only thing standing between a withheld attribution and a model
 * reporting the claim as anonymous or undated — the wire shape says "withheld"
 * but nothing makes a model say it out loud. The web review surface pins the
 * same property with six rendering tests; these are the agent equivalents, and
 * they exist because a description is a string nobody would notice deleting.
 *
 * TWO strings, not one, and that is the whole reason this block is parameterised:
 *
 *   - `SEARCH_BRAIN_DESCRIPTION` (`lib/tools/search-brain.ts`) — workflow
 *     guidance injected into the in-process agent's SYSTEM PROMPT via
 *     `registry.ts`'s `describe()`.
 *   - `SEARCH_BRAIN_TOOL_DESCRIPTION` (`lib/tools/descriptions.ts`) — the
 *     LLM-facing TOOL description, served both to the in-process agent (as
 *     `searchBrain.description`) and, via `withErrorContract`, to every
 *     external MCP client.
 *
 * They are NOT the same string and neither is derived from the other, so
 * guidance added to the system prompt alone never reaches an external MCP
 * client — the one reader whose model Atlas does not control, and so the one
 * most likely to narrate an unguided `{ "visible": false }` as "nobody
 * recorded who said this".
 */
describe.each([
  ["SEARCH_BRAIN_DESCRIPTION (in-process agent system prompt)", SEARCH_BRAIN_DESCRIPTION],
  [
    "SEARCH_BRAIN_TOOL_DESCRIPTION (tool description — in-process agent and MCP)",
    SEARCH_BRAIN_TOOL_DESCRIPTION,
  ],
])("%s — withheld attribution is explained to the model", (_label, description) => {
  it("names the wire shape the model will actually see", () => {
    // A rule keyed on prose the response does not contain is unactionable.
    expect(description).toContain("provenance.attribution");
    expect(description).toContain('"visible": false');
  });

  it("forbids the three wrong readings and the inference", () => {
    // "Say nothing" is not enough: the failure mode is a model filling the
    // gap — reporting the claim as unsourced, or guessing the author from the
    // episode list. Each wrong reading is named explicitly.
    for (const forbidden of ["anonymous", "undated", "unsourced"]) {
      expect(description).toContain(forbidden);
    }
    expect(description).toMatch(/never infer the author|nor infer the author/i);
  });

  it("still tells the model the CLAIM is usable", () => {
    // The other half, and the one a well-meaning tightening would delete: the
    // fact is legitimately visible. A model that refused to use it would turn
    // an attribution boundary into a knowledge gap.
    expect(description).toMatch(/use the claim/i);
  });
});

/**
 * Same two-surface pin, for #4914's staleness guidance — and for the same
 * reason the attribution block states: a description is a string nobody would
 * notice deleting, the two surfaces are not derived from each other, and
 * guidance added to the system prompt alone never reaches an MCP client.
 */
describe.each([
  ["SEARCH_BRAIN_DESCRIPTION (in-process agent system prompt)", SEARCH_BRAIN_DESCRIPTION],
  [
    "SEARCH_BRAIN_TOOL_DESCRIPTION (tool description — in-process agent and MCP)",
    SEARCH_BRAIN_TOOL_DESCRIPTION,
  ],
])("%s — staleness is presented, never arbitrated (#4914)", (_label, description) => {
  it("names the temporal wire fields the model will actually see", () => {
    for (const field of ["decay", "validFrom", "corroborationCount"]) {
      expect(description).toContain(field);
    }
    expect(description).toMatch(/stale/i);
  });

  it("tells the model to PRESENT a stale fact's age", () => {
    expect(description).toMatch(/present .*(age|as of)/i);
  });

  it("forbids the two wrong moves: asserting as current, and dropping for age", () => {
    // The failure mode of unguided staleness metadata is a model treating
    // `stale` as a demotion — silently discarding the reviewed record — or
    // ignoring it and asserting a year-old claim as today's truth. Both
    // never-arms must survive a prompt-tightening pass.
    expect(description).toMatch(/never (assert|discard|overrule|drop)/i);
    expect(description).toMatch(/(as current|current[.,])/i);
  });
});

/**
 * The one rule every agent-facing string about retraction has to obey (#4933):
 * a sentence may state that a retracted fact NEVER comes back only if that same
 * sentence names the exception. `invalidatedAt` alone does not count — naming
 * the label without naming where it is read is what the pre-#4933 prose already
 * did on the surfaces that had it.
 *
 * Two predicates rather than one, because only the absolute claim is policed.
 * The label-defining sentences ("a non-null `invalidatedAt` is a rival since
 * RETRACTED") mention retraction without promising anything about reachability,
 * and a rule that demanded a carve-out from those would push the whole clause
 * out of the 150-word rubric for no truth gained.
 *
 * `ABSOLUTE` is deliberately broader than the two wordings that actually
 * shipped, and `CARVE_OUT` deliberately requires an exception marker next to
 * `tensions` rather than the bare word: a rewrite that merely mentions
 * `tensions` earlier in the sentence ("`tensions` unranked; superseded
 * included, retracted never returned") restates the exact defect and must not
 * buy immunity with a token.
 */
const RETRACTION_ABSOLUTE =
  /retract\w*\s+(?:facts?\s+)?(?:is |are )?never|never\s+(?:returned|surfaces?|appears?|as a RESULT)|retract\w*[^.]{0,40}\b(?:excluded|omitted)\b/i;
const RETRACTION_CARVE_OUT = /(only|except|still appears?|the one place)[^.]{0,80}tensions/i;

/** Sentences that promise retracted facts are unreachable without naming the exception. */
function unqualifiedRetractionSentences(description: string): readonly string[] {
  return (
    description
      // Two delimiters, and the bullet arm is the load-bearing one. Splitting
      // on `. ` alone under-splits the system prompt, whose markdown bullets
      // have no terminal period: bullet N's tail glues to bullet N+1's head,
      // and an offender could then borrow a NEIGHBOUR's carve-out — the same
      // "buy immunity with a token" hole this predicate exists to close, one
      // level up. Over-splitting (an "e.g." mid-sentence) is the safe
      // direction: it can only ever hand a smaller chunk to the same filters.
      .split(/(?<=\.)\s+|\n(?=[-*] )/)
      .filter((s) => /retract/i.test(s))
      .filter((s) => RETRACTION_ABSOLUTE.test(s))
      .filter((s) => !RETRACTION_CARVE_OUT.test(s))
  );
}

/**
 * Does a string state the `include` precondition `asOf` is hard-refused
 * without (#4939)?
 *
 * A bare `toContain("include")` would pass VACUOUSLY on both descriptions:
 * each already says "superseded versions **included**", and `include` is a
 * substring of it. So the predicate is word-bounded AND requires the word to
 * sit in a sentence that reads as a REQUIREMENT — which is the thing the
 * dropped sentence actually carried. A description that merely mentions the
 * argument in passing ("also accepts `include`") does not satisfy it.
 */
function statesIncludePrecondition(description: string): boolean {
  return description
    .split(/(?<=\.)\s+|\n(?=[-*] )/)
    .some((s) => /\binclude\b/.test(s) && /\b(requires?|needs?|must|only with)\b/i.test(s));
}

/**
 * The tension-counterpart lifecycle labels (#4935), pinned for the reason the
 * base commit exists: this block's `asOf` sentence claimed "Retracted facts
 * never appear, at any time" until #4913 made it false, and NOTHING failed.
 * Guidance prose is the one part of a wire contract with no compiler behind
 * it, so the never-arms have to be assertions or the next prompt-tightening
 * pass collapses them back to a blunt "surface both sides, never pick a
 * winner" — which is precisely the instruction that turns an arbitrated
 * conflict into a live one.
 *
 * BOTH surfaces, as of #4933. The block shipped with #4935 covering only
 * `SEARCH_BRAIN_DESCRIPTION` and said so, because `SEARCH_BRAIN_TOOL_DESCRIPTION`
 * — the description served to the in-process agent AND, via
 * `searchBrain.description` wrapped in `withErrorContract`, to every external
 * MCP client — had to trade words against the 80–150 rubric
 * (`description-rubric.test.ts`) before it could carry any of this. #4933 paid
 * that price, so the parameterisation is now the assertion.
 *
 * Note #4933's acceptance criteria PREDATE `validTo` and name only
 * `invalidatedAt`. Closing it that literally would have left the MCP model
 * able to spot a retracted rival and still unable to tell a superseded one
 * from a live one — half a fix on the surface Atlas does not control the model
 * of. Both axes are pinned on both strings for that reason.
 */
describe.each([
  ["SEARCH_BRAIN_DESCRIPTION (in-process agent system prompt)", SEARCH_BRAIN_DESCRIPTION],
  [
    "SEARCH_BRAIN_TOOL_DESCRIPTION (tool description — in-process agent and MCP)",
    SEARCH_BRAIN_TOOL_DESCRIPTION,
  ],
])("%s — a retired tension counterpart is labelled, not re-litigated (#4935, #4933)", (_label, description) => {
  it("names BOTH wire fields, so neither axis can be dropped in a rewrite", () => {
    expect(description).toContain("invalidatedAt");
    expect(description).toContain("validTo");
  });

  it("distinguishes the two verbs rather than merging them into one label", () => {
    // Retracted means "should never have been served"; superseded means "was
    // true, then stopped being". A prompt that says only "retired" loses the
    // ability to tell a reader which happened.
    expect(description).toMatch(/RETRACTED/);
    expect(description).toMatch(/SUPERSEDED/);
  });

  it("tells the model a retired rival is SETTLED, which is the actionable half", () => {
    // Naming the fields without saying what to do with them leaves the model
    // on its "never pick winners" default and changes nothing.
    //
    // Anchored to the INSTRUCTION, not to the word: a bare /settled/i passes
    // on the pre-#4935 string, which already says "never as settled" about
    // withheld rivals. Deleting this whole clause would have left it green.
    expect(description).toMatch(/report (those|them) as settled/i);
  });

  it("qualifies `validTo` by the clock, so a future window is not called settled", () => {
    // Non-null is not retired: `valid_to IS NULL OR valid_to > now()` is the
    // database's own liveness test, so a future-dated stamp is a LIVE rival.
    // Without this qualifier the prompt instructs the model to suppress an
    // open conflict — the exact inverse of the bug #4935 fixes.
    //
    // Both arms are anchored past the words themselves. `/in the past/i` alone
    // is matched by the pre-existing `asOf` bullet ("ISO-8601, in the past"),
    // and `/future/` alone would accept a prompt that called a future window
    // settled too — so the future arm has to carry its VERDICT.
    expect(description).toMatch(/ALREADY IN THE PAST/);
    expect(description).toMatch(/still in the future[^.]*\b(LIVE|contested)/);
  });

  it("keeps the never-arm that a labelling clause could plausibly displace", () => {
    // Labelling lifecycle state is not ranking. The moment this ban goes, the
    // model is free to read the labels as a verdict and pick a side on the
    // pair that is still genuinely live.
    expect(description).toMatch(/never pick a winner/i);
  });

  it("never states the absolute the wire does not keep (#4933)", () => {
    // The defect both #4932 and #4933 fixed was not a missing clause, it was a
    // PRESENT one: "retracted never", unqualified, in a sentence about what
    // `asOf` returns. True of results, false of the response — and a model
    // cannot tell which from the prose, so it reports a settled retraction as
    // a live contradiction.
    //
    // Rule-shaped rather than a blocklist of the two wordings that shipped: a
    // blocklist goes green the moment someone rephrases the absolute.
    expect(
      unqualifiedRetractionSentences(description),
      "a sentence promising retracted facts never come back must name the `tensions` carve-out in that same sentence",
    ).toEqual([]);
  });
});

/**
 * The third of the four strings that CARRY THE RETRACTION PROMISE, and the one
 * neither block above reaches: the `asOf` ARGUMENT description on this tool's
 * input schema (#4933). The four are the system prompt
 * (`SEARCH_BRAIN_DESCRIPTION`), the tool prose (`SEARCH_BRAIN_TOOL_DESCRIPTION`,
 * both blocks above), this argument, and its re-declared MCP twin. (searchBrain
 * has a dozen-odd other `.describe()` strings; none of them say anything about
 * retraction, which is why the count here is four and not twenty.) A model
 * deciding whether to PASS `asOf` reads the argument, not the tool prose, and
 * this one shipped promising "retracted facts never" — the same absolute, on a
 * surface with its own reader.
 *
 * `packages/mcp/src/tools.ts` re-declares the whole input schema rather than
 * importing it — `asOf` is only the argument where that drift is
 * correctness-bearing, and `query` has already drifted harmlessly — so the
 * fourth string is pinned there (`__tests__/tools.test.ts`, through
 * `listTools()`). Two files because there are genuinely two strings.
 */
describe("searchBrain `asOf` argument description — the carve-out travels with the promise (#4933)", () => {
  const asOfDescription = ((): string => {
    // Read what the model is SERVED, not what the builder was handed: the AI
    // SDK hands the LLM a JSON Schema, and zod resolves `.describe()` into it
    // wherever in the chain it was called. Reading `.shape.asOf.description`
    // instead would go red on a harmless `.describe()`/`.optional()` reorder
    // while the model still saw the right prose.
    //
    // BOTH shape failures throw rather than falling back, so an AI SDK or zod
    // reshape reports itself instead of collapsing to `""` and reading as a
    // prose regression in the assertions below. Only a dropped `.describe()`
    // returns `""`, which is the one case where an empty string IS the honest
    // signal — that genuinely is a prose regression.
    const schema = searchBrain.inputSchema;
    if (!(schema instanceof z.ZodObject)) {
      throw new Error(
        "searchBrain.inputSchema is no longer a ZodObject — re-point this read at whatever now carries the argument prose, or the retraction pins below pass vacuously",
      );
    }
    const properties = z.toJSONSchema(schema).properties;
    const asOf = properties?.asOf;
    if (typeof asOf !== "object") {
      throw new Error(
        `searchBrain's input schema no longer exposes an \`asOf\` object property (saw: ${Object.keys(properties ?? {}).join(", ") || "none"}) — re-point this read, or the retraction pins below pass vacuously`,
      );
    }
    return asOf.description ?? "";
  })();

  it("is readable at all — a reshape must fail here, not silently pass", () => {
    // Deliberately not keyed on a phrase: a reworded-but-intact description
    // ("point-in-time read") is not a failure of THIS pin, and the shape
    // failures it used to stand in for now throw above.
    expect(
      asOfDescription,
      "the `asOf` argument lost its `.describe()` — the retraction pins below would pass vacuously",
    ).toBeTruthy();
  });

  it("names where a retracted fact still surfaces, and the field that labels it", () => {
    expect(asOfDescription).toContain("tensions");
    expect(asOfDescription).toContain("invalidatedAt");
  });

  it("keeps the never-arm: retracted is still never a RESULT", () => {
    // The carve-out is what makes the sentence true; this is what makes it
    // useful. Drop it and the model has no reason to trust an `asOf` read.
    expect(asOfDescription).toMatch(/never as a RESULT/);
  });

  it("obeys the same absolute rule as the two descriptions above", () => {
    // The positive pins above all survive a rewrite that keeps the three
    // tokens and re-adds an unqualified absolute in a neighbouring sentence.
    // This is the arm that does not.
    expect(
      unqualifiedRetractionSentences(asOfDescription),
      "a sentence promising retracted facts never come back must name the `tensions` carve-out in that same sentence",
    ).toEqual([]);
  });

  // #4939. `searchBrain` HARD-REFUSES an `asOf` read whose `include` omits
  // facts (`lib/brain/search.ts`) — it is the caller's input problem and is
  // reported as such rather than degraded. A model deciding whether to combine
  // the two arguments reads THIS string, so the precondition living only in
  // the refusal makes the refusal reachable by a well-behaved caller. The
  // MCP twin re-declares this schema and had dropped the sentence; its own
  // suite carries the same rule.
  it("states the `include` precondition the read hard-refuses without", () => {
    expect(
      statesIncludePrecondition(asOfDescription),
      "the `asOf` argument description states no `include` precondition — the read throws BrainAsOfInvalidError when `include` excludes facts, so an unstated precondition is a refusal a well-behaved model cannot avoid",
    ).toBe(true);
  });
});
