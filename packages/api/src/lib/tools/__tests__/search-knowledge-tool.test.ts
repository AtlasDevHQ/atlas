/**
 * Execute-wrapper coverage for the `searchKnowledge` tool (#4210) — the guards
 * and context wiring that live OUTSIDE the pure `searchKnowledgeCore`
 * (unit-tested with an injected exec in `search-knowledge.test.ts`):
 *   - the no-internal-DB and no-workspace degraded paths (distinct shapes),
 *   - the fail-closed `mode` default (missing context ⇒ published, never leaks drafts),
 *   - `normalizeFilters` applied end-to-end (limit clamp),
 *   - the error catch: a thrown query is logged and mapped to a generic,
 *     secret-free `{ error }` (CLAUDE.md: no stack/connection-string in responses).
 *
 * Kept in its own file (mock.module is file-global under the isolated runner) so
 * the mock-free pure-builder tests in `search-knowledge.test.ts` stay clean.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

// Mutable mock state — set per test before invoking the tool.
let mockRequestContext:
  | { user?: { activeOrganizationId?: string }; atlasMode?: "developer" | "published" }
  | undefined;
let mockHasInternalDB = true;
const queryCalls: { sql: string; params: unknown[] }[] = [];
let queryImpl: (sql: string, params?: unknown[]) => Promise<unknown[]> = async () => [];

// Full internal-DB mock via the sanctioned helper (mock-all-exports
// discipline) — a new export on db/internal must not break this file's load.
mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: async (sql: string, params?: unknown[]) => {
      queryCalls.push({ sql, params: params ?? [] });
      return queryImpl(sql, params);
    },
    hasInternalDB: () => mockHasInternalDB,
  }),
  hasInternalDB: () => mockHasInternalDB,
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
mock.module("@atlas/api/lib/logger", () => ({
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

const { searchKnowledge } = await import("@atlas/api/lib/tools/search-knowledge");

function run(input: Record<string, unknown> = {}) {
  // AI SDK tool.execute(args, ToolCallOptions). Cast through unknown: the tool's
  // arg/return types are internal to this test and we only assert on the shape.
  return searchKnowledge.execute!(
    input as never,
    { toolCallId: "t1", messages: [] } as never,
  ) as unknown as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  mockRequestContext = { user: { activeOrganizationId: "ws-1" }, atlasMode: "published" };
  mockHasInternalDB = true;
  queryCalls.length = 0;
  queryImpl = async () => [];
  loggedError = undefined;
});

describe("searchKnowledge tool.execute", () => {
  it("returns an error (not empty results) when no internal DB is configured", async () => {
    mockHasInternalDB = false;
    const res = await run({ query: "x" });
    expect(res.error).toContain("internal database");
    expect(queryCalls).toHaveLength(0);
  });

  it("returns empty results (not an error) when there is no active workspace", async () => {
    mockRequestContext = { user: {} };
    const res = await run({ query: "x" });
    expect(res).toEqual({ results: [], neighbors: [] });
    expect(queryCalls).toHaveLength(0);
  });

  it("defaults to published mode when request context carries no atlasMode", async () => {
    mockRequestContext = { user: { activeOrganizationId: "ws-1" } };
    await run({ query: "x", expand: false });
    expect(queryCalls).toHaveLength(1);
    // Fail-closed: the published-only clause, never the draft overlay.
    expect(queryCalls[0].sql).toContain("kd.status = 'published'");
    expect(queryCalls[0].sql).not.toContain("'draft'");
  });

  it("uses the developer draft overlay when atlasMode is developer", async () => {
    mockRequestContext = { user: { activeOrganizationId: "ws-1" }, atlasMode: "developer" };
    await run({ query: "x", expand: false });
    expect(queryCalls[0].sql).toContain("kd.status IN ('published', 'draft')");
  });

  it("clamps an over-large limit through normalizeFilters before querying", async () => {
    await run({ query: "x", limit: 999, expand: false });
    const params = queryCalls[0].params;
    // The LIMIT is the last bind param.
    expect(params[params.length - 1]).toBe(50);
  });

  it("logs and returns a generic, secret-free error when the query throws", async () => {
    queryImpl = async () => {
      throw new Error("connection to postgres://user:pw@host failed");
    };
    const res = await run({ query: "x" });
    expect(res.error).toContain("Knowledge search failed");
    // The raw exception (which carries a connection string) must not leak.
    expect(JSON.stringify(res)).not.toContain("postgres://");
    expect(loggedError).toBeDefined();
  });

  it("returns the mapped results on success", async () => {
    queryImpl = async () => [
      {
        id: "d1",
        path: "a.md",
        collection_id: "c",
        title: "A",
        description: null,
        type: "Document",
        tags: [],
        resource: null,
        atlas_source: "upload",
        atlas_ingested_at: null,
        timestamp: null,
        status: "published",
        snippet: null,
        rank: null,
      },
    ];
    const res = await run({ query: "a", expand: false });
    expect(res.results).toEqual([
      {
        path: "a.md",
        collection: "c",
        title: "A",
        snippet: null,
        provenance: {
          type: "Document",
          tags: [],
          resource: null,
          source: "upload",
          ingestedAt: null,
          timestamp: null,
          status: "published",
        },
      },
    ]);
    expect(res.neighbors).toEqual([]);
  });
});
