/**
 * Unit coverage for `searchKnowledge` (#4210) — the pure query builders and the
 * injected-executor core. The real FTS + graph SQL is exercised against live
 * Postgres in `knowledge-search-pg.test.ts`; here we assert the SQL shape
 * (parameterization, status gating, FTS vs recency branch) and the row → result
 * mapping without a database.
 */

import { describe, expect, it } from "bun:test";
import {
  buildSearchQuery,
  buildNeighborQuery,
  searchKnowledgeCore,
  normalizeFilters,
  type KnowledgeQueryExec,
  type KnowledgeSearchFilters,
} from "@atlas/api/lib/tools/search-knowledge";

const WS = "ws-1";

function filters(overrides: Partial<KnowledgeSearchFilters> = {}): KnowledgeSearchFilters {
  return { limit: 10, expand: true, ...overrides };
}

describe("buildSearchQuery", () => {
  it("published mode gates on status = 'published' and scopes to the workspace", () => {
    const { sql, params } = buildSearchQuery(WS, "published", filters());
    expect(sql).toContain("kd.workspace_id = $1");
    expect(sql).toContain("kd.status = 'published'");
    expect(sql).not.toContain("draft");
    expect(params[0]).toBe(WS);
  });

  it("developer mode overlays drafts via the shared status clause", () => {
    const { sql } = buildSearchQuery(WS, "developer", filters());
    expect(sql).toContain("kd.status IN ('published', 'draft')");
  });

  it("with a query, emits FTS match, ts_headline snippet, ts_rank, and rank-first ordering", () => {
    const { sql, params } = buildSearchQuery(WS, "published", filters({ query: "replica lag" }));
    expect(sql).toContain("websearch_to_tsquery('english', $2)");
    expect(sql).toContain("@@");
    expect(sql).toContain("ts_headline('english', kd.body");
    expect(sql).toContain("ts_rank(");
    expect(sql).toMatch(/ORDER BY\s+rank DESC NULLS LAST/);
    expect(params).toContain("replica lag");
  });

  it("without a query, snippet + rank are NULL and ordering is recency-only", () => {
    const { sql } = buildSearchQuery(WS, "published", filters());
    expect(sql).toContain("NULL AS snippet");
    expect(sql).toContain("NULL AS rank");
    expect(sql).not.toContain("websearch_to_tsquery");
    expect(sql).toMatch(/ORDER BY\s+coalesce\(kd\."timestamp", kd\.atlas_ingested_at\) DESC/);
  });

  it("blank/whitespace query is treated as no query (structured filter only)", () => {
    const { sql } = buildSearchQuery(WS, "published", filters({ query: "   " }));
    expect(sql).not.toContain("websearch_to_tsquery");
    expect(sql).toContain("NULL AS snippet");
  });

  it("adds a bound clause for each frontmatter filter (type, collection, tags, since)", () => {
    const { sql, params } = buildSearchQuery(
      WS,
      "published",
      filters({ type: "Runbook", collection: "runbooks", tags: ["ops", "eu"], since: "2026-01-01" }),
    );
    expect(sql).toContain("kd.type = $");
    expect(sql).toContain("kd.collection_id = $");
    expect(sql).toContain("kd.tags @> $");
    expect(sql).toContain("::jsonb");
    expect(sql).toContain('coalesce(kd."timestamp", kd.atlas_ingested_at) >= $');
    expect(sql).toContain("::timestamptz");
    expect(params).toContain("Runbook");
    expect(params).toContain("runbooks");
    expect(params).toContain(JSON.stringify(["ops", "eu"]));
    expect(params).toContain("2026-01-01");
    // Last param is always the LIMIT.
    expect(params[params.length - 1]).toBe(10);
  });

  it("reuses the same tsquery placeholder across match, snippet, and rank (single bind)", () => {
    const { sql, params } = buildSearchQuery(WS, "published", filters({ query: "x", type: "Runbook" }));
    // Query text is $2; it must appear exactly once in params.
    expect(params.filter((p) => p === "x")).toHaveLength(1);
    expect(sql.match(/\$2/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("normalizeFilters", () => {
  it("defaults limit to 10 and expand to true", () => {
    const f = normalizeFilters({});
    expect(f.limit).toBe(10);
    expect(f.expand).toBe(true);
  });

  it("clamps limit to [1, 50] and floors fractional values", () => {
    expect(normalizeFilters({ limit: 999 }).limit).toBe(50);
    expect(normalizeFilters({ limit: 0 }).limit).toBe(1);
    expect(normalizeFilters({ limit: 2.7 }).limit).toBe(2);
  });

  it("trims tags, drops blanks, and collapses an all-blank list to undefined", () => {
    expect(normalizeFilters({ tags: [" ops ", "", "  "] }).tags).toEqual(["ops"]);
    expect(normalizeFilters({ tags: ["", "   "] }).tags).toBeUndefined();
  });

  it("coerces blank string filters to undefined", () => {
    const f = normalizeFilters({ type: "  ", collection: "", since: "   " });
    expect(f.type).toBeUndefined();
    expect(f.collection).toBeUndefined();
    expect(f.since).toBeUndefined();
  });

  it("respects an explicit expand: false", () => {
    expect(normalizeFilters({ expand: false }).expand).toBe(false);
  });
});

describe("buildNeighborQuery", () => {
  it("expands outbound + inbound edges, re-applies the status clause to the neighbor, excludes seeds", () => {
    const { sql, params } = buildNeighborQuery(WS, "published", ["a", "b"]);
    expect(sql).toContain("'outbound' AS direction");
    expect(sql).toContain("'inbound' AS direction");
    expect(sql).toContain("kd.status = 'published'");
    expect(sql).toContain("kd.id <> ALL($2::uuid[])");
    expect(sql).toContain("array_agg(DISTINCT e.via)");
    expect(sql).toContain("LIMIT $3");
    expect(params[0]).toBe(WS);
    expect(params[1]).toEqual(["a", "b"]);
    // Third bind is the neighbor cap.
    expect(params[2]).toBe(25);
  });

  it("developer mode surfaces draft neighbors too", () => {
    const { sql } = buildNeighborQuery(WS, "developer", ["a"]);
    expect(sql).toContain("kd.status IN ('published', 'draft')");
  });
});

// A recording fake executor that returns queued result batches in order.
function fakeExec(batches: Record<string, unknown>[][]): {
  exec: KnowledgeQueryExec;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  let i = 0;
  const exec: KnowledgeQueryExec = async (sql, params) => {
    calls.push({ sql, params });
    return (batches[i++] ?? []) as never;
  };
  return { exec, calls };
}

describe("searchKnowledgeCore", () => {
  const seedRow = {
    id: "doc-1",
    path: "runbooks/eu.md",
    collection_id: "runbooks",
    title: "EU",
    description: "European runbook",
    type: "Runbook",
    tags: ["eu", "ops"],
    resource: "https://example.com",
    atlas_source: "upload",
    atlas_ingested_at: new Date("2026-05-01T00:00:00Z"),
    timestamp: "2026-04-28T22:49:59Z",
    status: "published",
    snippet: "…**replica** lag…",
    rank: 0.5,
  };

  it("maps rows into provenance-carrying results", async () => {
    const { exec } = fakeExec([[seedRow]]);
    const res = await searchKnowledgeCore({
      workspaceId: WS,
      mode: "published",
      filters: filters({ query: "replica", expand: false }),
      exec,
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toEqual({
      path: "runbooks/eu.md",
      collection: "runbooks",
      title: "EU",
      snippet: "…**replica** lag…",
      provenance: {
        type: "Runbook",
        tags: ["eu", "ops"],
        resource: "https://example.com",
        source: "upload",
        ingestedAt: "2026-05-01T00:00:00.000Z",
        timestamp: "2026-04-28T22:49:59.000Z",
        status: "published",
      },
    });
    expect(res.neighbors).toEqual([]);
  });

  it("parses jsonb tags handed back as a raw string", async () => {
    const { exec } = fakeExec([[{ ...seedRow, tags: '["eu","ops"]' }]]);
    const res = await searchKnowledgeCore({
      workspaceId: WS,
      mode: "published",
      filters: filters({ expand: false }),
      exec,
    });
    expect(res.results[0].provenance.tags).toEqual(["eu", "ops"]);
  });

  it("does NOT run the expansion query when expand is false", async () => {
    const { exec, calls } = fakeExec([[seedRow]]);
    await searchKnowledgeCore({
      workspaceId: WS,
      mode: "published",
      filters: filters({ expand: false }),
      exec,
    });
    expect(calls).toHaveLength(1);
  });

  it("skips the expansion query when there are no seed documents", async () => {
    const { exec, calls } = fakeExec([[]]);
    const res = await searchKnowledgeCore({
      workspaceId: WS,
      mode: "published",
      filters: filters({ expand: true }),
      exec,
    });
    expect(calls).toHaveLength(1);
    expect(res.results).toEqual([]);
    expect(res.neighbors).toEqual([]);
  });

  it("runs expansion with the seed ids and maps neighbor edge aggregates", async () => {
    const neighborRow = {
      id: "doc-2",
      path: "glossary/replica.md",
      collection_id: "runbooks",
      title: "Replica",
      description: null,
      type: "Document",
      tags: [],
      resource: null,
      atlas_source: "upload",
      atlas_ingested_at: new Date("2026-05-02T00:00:00Z"),
      timestamp: null,
      status: "published",
      snippet: null,
      rank: null,
      via: ["runbooks/eu.md"],
      direction: ["outbound"],
      anchors: ["glossary"],
    };
    const { exec, calls } = fakeExec([[seedRow], [neighborRow]]);
    const res = await searchKnowledgeCore({
      workspaceId: WS,
      mode: "published",
      filters: filters({ query: "replica", expand: true }),
      exec,
    });
    expect(calls).toHaveLength(2);
    // Seed ids threaded into the expansion query's $2 param.
    expect(calls[1].params[1]).toEqual(["doc-1"]);
    expect(res.neighbors).toHaveLength(1);
    expect(res.neighbors[0]).toMatchObject({
      path: "glossary/replica.md",
      collection: "runbooks",
      title: "Replica",
      via: ["runbooks/eu.md"],
      direction: ["outbound"],
      anchors: ["glossary"],
    });
  });

  it("normalizes a null anchors aggregate to an empty array", async () => {
    const neighborRow = {
      ...seedRow,
      id: "doc-3",
      path: "n.md",
      via: ["runbooks/eu.md"],
      direction: ["inbound"],
      anchors: null,
    };
    const { exec } = fakeExec([[seedRow], [neighborRow]]);
    const res = await searchKnowledgeCore({
      workspaceId: WS,
      mode: "published",
      filters: filters({ expand: true }),
      exec,
    });
    expect(res.neighbors[0].anchors).toEqual([]);
  });
});
