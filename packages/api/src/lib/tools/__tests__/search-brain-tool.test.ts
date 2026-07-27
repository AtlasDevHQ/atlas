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
// Mock all value exports of the logger module (mock.module is file-global; a
// partial stub would hand `undefined` to any importer reaching an unmocked one).
const noopLogger = {
  info: () => {},
  warn: () => {},
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

/** SQL the tool issued against one table, in call order. */
function sqlFor(table: string): string[] {
  return queryCalls.map((c) => c.sql).filter((s) => s.includes(table));
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
 *     LLM-facing tool description `packages/mcp/src/tools.ts` registers, i.e.
 *     what an external MCP client's model reads.
 *
 * They are NOT the same string and neither is derived from the other, so
 * guidance added to one reaches only half the agents. The MCP half is the one
 * Atlas does not control the model of, which makes it the half where an
 * unguided `{ "visible": false }` is most likely to be narrated as "nobody
 * recorded who said this".
 */
describe.each([
  ["SEARCH_BRAIN_DESCRIPTION (in-process agent system prompt)", SEARCH_BRAIN_DESCRIPTION],
  ["SEARCH_BRAIN_TOOL_DESCRIPTION (MCP tool description)", SEARCH_BRAIN_TOOL_DESCRIPTION],
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
