/**
 * `openapi-paginator` tests (slice 4, #2928).
 *
 *  - Table-driven `next()` per strategy: a fixed request + fixed response →
 *    expected next-request, no live HTTP (AC: each of the four strategies).
 *  - The headline AC: a Twenty query naturally returning ~5,000 leads follows
 *    cursors transparently through `executeOperationPaged` and the agent loop
 *    sees ONE merged result — driven over the REAL Twenty operation graph with a
 *    paged `fetch` stub (no live HTTP).
 *  - Page cache: per-page caching avoids re-fetch, 5-min TTL expiry re-fetches,
 *    the `cache_invalidated_at` watermark flush re-fetches, and WRITES ARE NEVER
 *    CACHED.
 *  - Registry: the four built-ins are present and a fifth registers without an
 *    engine edit (the "one new file" property).
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { buildOperationGraph } from "../spec";
import { executeOperationPaged } from "../client";
import {
  paginate,
  derivePageCacheKey,
  detectPaginationConfig,
  extractItems,
  dotGet,
  isPageFresh,
  invalidateInstallCache,
  requireString,
  InMemoryPageCacheStore,
  PaginatorRegistry,
  PaginationConfigError,
  DEFAULT_PAGE_CACHE_TTL_MS,
  type CachedPage,
  type PageCacheIdentity,
  type PageRequest,
  type PaginationConfig,
} from "../paginator";
import { defaultPaginatorRegistry, BUILT_IN_STRATEGIES } from "../strategies";
import type { OperationResult } from "../types";

const IDENTITY: PageCacheIdentity = { workspaceId: "ws-1", pluginInstallId: "inst-1" };

/** A minimal 2xx JSON {@link OperationResult} with the given body + headers. */
function ok(body: unknown, headers: Record<string, string> = {}): OperationResult {
  return { status: 200, headers, body, bodyIsRaw: false };
}

// ─────────────────────────────────────────────────────────────────────
//  Table-driven per-strategy `next()`
// ─────────────────────────────────────────────────────────────────────

interface NextCase {
  readonly title: string;
  readonly config: PaginationConfig;
  readonly request: PageRequest;
  readonly response: OperationResult;
  readonly expected: PageRequest | null;
}

const NEXT_CASES: NextCase[] = [
  // ── cursor ──────────────────────────────────────────────────────────
  {
    title: "cursor: follows endCursor onto starting_after while hasNextPage",
    config: {
      strategy: "cursor",
      itemsPath: "data.people",
      cursorParam: "starting_after",
      cursorPath: "pageInfo.endCursor",
      hasMorePath: "pageInfo.hasNextPage",
    },
    request: { operationId: "findManyPeople", params: { query: { limit: 1000 } } },
    response: ok({ data: { people: [{ id: "p1" }] }, pageInfo: { endCursor: "c2", hasNextPage: true } }),
    expected: { operationId: "findManyPeople", params: { query: { limit: 1000, starting_after: "c2" } } },
  },
  {
    title: "cursor: stops when hasNextPage is false",
    config: {
      strategy: "cursor",
      itemsPath: "data.people",
      cursorParam: "starting_after",
      cursorPath: "pageInfo.endCursor",
      hasMorePath: "pageInfo.hasNextPage",
    },
    request: { operationId: "findManyPeople", params: { query: { starting_after: "c2" } } },
    response: ok({ data: { people: [{ id: "p2" }] }, pageInfo: { endCursor: "c3", hasNextPage: false } }),
    expected: null,
  },
  {
    title: "cursor: stops on no-progress (echoed cursor)",
    config: {
      strategy: "cursor",
      itemsPath: "data.people",
      cursorParam: "starting_after",
      cursorPath: "pageInfo.endCursor",
    },
    request: { operationId: "findManyPeople", params: { query: { starting_after: "c2" } } },
    response: ok({ data: { people: [{ id: "p2" }] }, pageInfo: { endCursor: "c2" } }),
    expected: null,
  },
  {
    title: "cursor: stops when cursor is absent",
    config: {
      strategy: "cursor",
      itemsPath: "data.people",
      cursorParam: "starting_after",
      cursorPath: "pageInfo.endCursor",
    },
    request: { operationId: "findManyPeople", params: {} },
    response: ok({ data: { people: [] }, pageInfo: {} }),
    expected: null,
  },

  // ── offset ──────────────────────────────────────────────────────────
  {
    title: "offset: advances offset by limit on a full page",
    config: { strategy: "offset", itemsPath: "items", offsetParam: "offset", limitParam: "limit", limit: 2 },
    request: { operationId: "list", params: { query: { offset: 0, limit: 2 } } },
    response: ok({ items: [{ id: 1 }, { id: 2 }] }),
    expected: { operationId: "list", params: { query: { offset: 2, limit: 2 } } },
  },
  {
    title: "offset: stops on a short page (fewer than limit)",
    config: { strategy: "offset", itemsPath: "items", offsetParam: "offset", limit: 2 },
    request: { operationId: "list", params: { query: { offset: 2 } } },
    response: ok({ items: [{ id: 3 }] }),
    expected: null,
  },
  {
    title: "offset: stops when next offset reaches total",
    config: { strategy: "offset", itemsPath: "items", offsetParam: "offset", limit: 2, totalPath: "total" },
    request: { operationId: "list", params: { query: { offset: 2 } } },
    response: ok({ items: [{ id: 3 }, { id: 4 }], total: 4 }),
    expected: null,
  },

  // ── page ────────────────────────────────────────────────────────────
  {
    title: "page: increments page on a full page",
    config: { strategy: "page", itemsPath: "results", pageParam: "page", pageSize: 2 },
    request: { operationId: "list", params: { query: { page: 1 } } },
    response: ok({ results: [{ id: 1 }, { id: 2 }] }),
    expected: { operationId: "list", params: { query: { page: 2 } } },
  },
  {
    title: "page: defaults the first page to 1 (no page param yet)",
    config: { strategy: "page", itemsPath: "results", pageParam: "page", pageSize: 2 },
    request: { operationId: "list", params: {} },
    response: ok({ results: [{ id: 1 }, { id: 2 }] }),
    expected: { operationId: "list", params: { query: { page: 2 } } },
  },
  {
    title: "page: stops at totalPages",
    config: { strategy: "page", itemsPath: "results", pageParam: "page", totalPagesPath: "meta.totalPages" },
    request: { operationId: "list", params: { query: { page: 3 } } },
    response: ok({ results: [{ id: 5 }], meta: { totalPages: 3 } }),
    expected: null,
  },

  // ── link-header ──────────────────────────────────────────────────────
  {
    title: "link-header: follows rel=next query params",
    config: { strategy: "link-header", itemsPath: "items" },
    request: { operationId: "list", params: { query: { per_page: 2 } } },
    response: ok({ items: [{ id: 1 }] }, {
      link: '<https://api.example.com/things?page=2&per_page=2>; rel="next", <https://api.example.com/things?page=9>; rel="last"',
    }),
    expected: { operationId: "list", params: { query: { per_page: "2", page: "2" } } },
  },
  {
    title: "link-header: stops when no Link header",
    config: { strategy: "link-header", itemsPath: "items" },
    request: { operationId: "list", params: {} },
    response: ok({ items: [{ id: 1 }] }),
    expected: null,
  },
  {
    title: "link-header: stops when there is no rel=next",
    config: { strategy: "link-header", itemsPath: "items" },
    request: { operationId: "list", params: {} },
    response: ok({ items: [{ id: 1 }] }, { link: '<https://api.example.com/things?page=1>; rel="prev"' }),
    expected: null,
  },
];

describe("paginator — strategy.next() (table-driven, no HTTP)", () => {
  for (const c of NEXT_CASES) {
    it(c.title, () => {
      const strategy = defaultPaginatorRegistry.resolve(c.config);
      expect(strategy.next(c.response, c.request)).toEqual(c.expected);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  Headline AC — ~5,000 Twenty leads merged transparently
// ─────────────────────────────────────────────────────────────────────

const TWENTY_SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "twenty-acceptance", "spec.json"), "utf8"),
);
const twentyGraph = buildOperationGraph(TWENTY_SPEC);

const TWENTY_CURSOR_CONFIG: PaginationConfig = {
  strategy: "cursor",
  itemsPath: "data.people",
  cursorParam: "starting_after",
  cursorPath: "pageInfo.endCursor",
  hasMorePath: "pageInfo.hasNextPage",
};

/**
 * A `fetch` stub that serves a cursor-paginated `/people`: `pages` pages of
 * `pageSize` synthetic people each, reading the `starting_after` cursor from the
 * query. Records each request path+query for assertions.
 */
function makePagingFetch(pages: number, pageSize: number) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const href = typeof input === "string" ? input : input.toString();
    const url = new URL(href);
    calls.push(url.pathname + url.search);
    const after = url.searchParams.get("starting_after");
    const pageIndex = after === null ? 0 : Number(after.replace("cursor-", ""));
    const people = Array.from({ length: pageSize }, (_, i) => ({ id: `p-${pageIndex}-${i}` }));
    const hasNextPage = pageIndex < pages - 1;
    const body = {
      data: { people },
      pageInfo: { endCursor: hasNextPage ? `cursor-${pageIndex + 1}` : null, hasNextPage },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

describe("paginator — Twenty cursor walk (headline AC, real graph, no live HTTP)", () => {
  it("merges ~5,000 leads across 5 pages into one result", async () => {
    const strategy = defaultPaginatorRegistry.resolve(TWENTY_CURSOR_CONFIG);
    const { fetchImpl, calls } = makePagingFetch(5, 1000);

    const merged = await executeOperationPaged(
      twentyGraph,
      "findManyPeople",
      { query: { limit: 1000 } },
      { kind: "bearer", token: "t" },
      { baseUrl: "https://twenty.example.com/rest", fetchImpl, pagination: strategy, maxPages: 100 },
    );

    expect(merged.items).toHaveLength(5000);
    expect(merged.pageCount).toBe(5);
    expect(merged.truncated).toBe(false);
    expect(merged.lastStatus).toBe(200);
    // One fetch per page; the cursor advanced each time.
    expect(calls).toHaveLength(5);
    expect(calls[0]).toContain("/people");
    expect(calls[0]).not.toContain("starting_after");
    expect(calls[4]).toContain("starting_after=cursor-4");
  });

  it("respects maxItems — slices the merge and marks it truncated", async () => {
    const strategy = defaultPaginatorRegistry.resolve(TWENTY_CURSOR_CONFIG);
    const { fetchImpl } = makePagingFetch(5, 1000);

    const merged = await executeOperationPaged(
      twentyGraph,
      "findManyPeople",
      { query: { limit: 1000 } },
      { kind: "bearer", token: "t" },
      { baseUrl: "https://twenty.example.com/rest", fetchImpl, pagination: strategy, maxItems: 2500 },
    );

    expect(merged.items).toHaveLength(2500);
    expect(merged.truncated).toBe(true);
  });

  it("respects maxPages — stops early and marks truncated", async () => {
    const strategy = defaultPaginatorRegistry.resolve(TWENTY_CURSOR_CONFIG);
    const { fetchImpl, calls } = makePagingFetch(5, 1000);

    const merged = await executeOperationPaged(
      twentyGraph,
      "findManyPeople",
      { query: { limit: 1000 } },
      { kind: "bearer", token: "t" },
      { baseUrl: "https://twenty.example.com/rest", fetchImpl, pagination: strategy, maxPages: 2 },
    );

    expect(merged.pageCount).toBe(2);
    expect(merged.items).toHaveLength(2000);
    expect(merged.truncated).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Page cache
// ─────────────────────────────────────────────────────────────────────

/** A deterministic 3-page cursor walk over the request's `starting_after`. */
function cursorPage(req: PageRequest): OperationResult {
  const after = req.params.query?.["starting_after"];
  const idx = typeof after === "string" ? Number(after.replace("c", "")) : 0;
  const hasNextPage = idx < 2; // pages idx 0,1,2
  return ok({
    items: [{ id: idx }],
    pageInfo: { endCursor: hasNextPage ? `c${idx + 1}` : null, hasNextPage },
  });
}

const CACHE_STRATEGY_CONFIG: PaginationConfig = {
  strategy: "cursor",
  itemsPath: "items",
  cursorParam: "starting_after",
  cursorPath: "pageInfo.endCursor",
  hasMorePath: "pageInfo.hasNextPage",
};

function countingExecute() {
  const calls: PageRequest[] = [];
  const execute = (req: PageRequest) => {
    calls.push(req);
    return Promise.resolve(cursorPage(req));
  };
  return { execute, calls };
}

const FIRST: PageRequest = { operationId: "findManyThings", params: { query: {} } };

describe("paginator — page cache (per-page, TTL, watermark)", () => {
  it("caches each page so a second walk does zero fetches within TTL", async () => {
    const store = new InMemoryPageCacheStore();
    const clock = 1_000_000;
    const now = () => clock;
    const strategy = defaultPaginatorRegistry.resolve(CACHE_STRATEGY_CONFIG);

    const cold = countingExecute();
    const first = await paginate(FIRST, cold.execute, {
      strategy,
      cache: { store, identity: IDENTITY, now },
    });
    expect(first.items).toHaveLength(3);
    expect(cold.calls).toHaveLength(3); // three pages fetched
    expect(first.servedFromCache).toBe(0);
    expect(store.size()).toBe(3); // each page cached independently

    const warm = countingExecute();
    const second = await paginate(FIRST, warm.execute, {
      strategy,
      cache: { store, identity: IDENTITY, now },
    });
    expect(second.items).toHaveLength(3);
    expect(warm.calls).toHaveLength(0); // every page served from cache
    expect(second.servedFromCache).toBe(3);
  });

  it("re-fetches once the 5-minute TTL has elapsed", async () => {
    const store = new InMemoryPageCacheStore();
    let clock = 2_000_000;
    const now = () => clock;
    const strategy = defaultPaginatorRegistry.resolve(CACHE_STRATEGY_CONFIG);

    const cold = countingExecute();
    await paginate(FIRST, cold.execute, { strategy, cache: { store, identity: IDENTITY, now } });
    expect(cold.calls).toHaveLength(3);

    clock += DEFAULT_PAGE_CACHE_TTL_MS + 1; // age past the default 5-minute TTL
    const stale = countingExecute();
    const after = await paginate(FIRST, stale.execute, {
      strategy,
      cache: { store, identity: IDENTITY, now },
    });
    expect(after.servedFromCache).toBe(0);
    expect(stale.calls).toHaveLength(3); // all stale → re-fetched
  });

  it("the cache_invalidated_at watermark flushes the install's cache (Rediscover schema)", async () => {
    const store = new InMemoryPageCacheStore();
    let clock = 3_000_000;
    const now = () => clock;
    const strategy = defaultPaginatorRegistry.resolve(CACHE_STRATEGY_CONFIG);

    const cold = countingExecute();
    await paginate(FIRST, cold.execute, { strategy, cache: { store, identity: IDENTITY, now } });
    expect(cold.calls).toHaveLength(3);

    // Admin "Rediscover schema" bumps the watermark to now …
    await invalidateInstallCache(store, IDENTITY, clock);
    clock += 1; // … and the next request happens a tick later

    const flushed = countingExecute();
    const after = await paginate(FIRST, flushed.execute, {
      strategy,
      cache: { store, identity: IDENTITY, now },
    });
    expect(after.servedFromCache).toBe(0);
    expect(flushed.calls).toHaveLength(3); // watermark invalidated everything

    // A different install's cache is untouched by the flush.
    const other: PageCacheIdentity = { workspaceId: "ws-2", pluginInstallId: "inst-2" };
    const otherCold = countingExecute();
    await paginate(FIRST, otherCold.execute, { strategy, cache: { store, identity: other, now } });
    const otherWarm = countingExecute();
    await paginate(FIRST, otherWarm.execute, { strategy, cache: { store, identity: other, now } });
    expect(otherWarm.calls).toHaveLength(0);
  });

  it("never caches writes (non-GET) even with a cache bound", async () => {
    const store = new InMemoryPageCacheStore();
    const strategy = defaultPaginatorRegistry.resolve(TWENTY_CURSOR_CONFIG);
    // createOnePerson is a POST in the Twenty graph; the mock returns 201.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { createPerson: { id: "p-new" } } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    await executeOperationPaged(
      twentyGraph,
      "createOnePerson",
      { body: { emails: { primaryEmail: "x@y.com" } } },
      { kind: "bearer", token: "t" },
      {
        baseUrl: "https://twenty.example.com/rest",
        fetchImpl,
        pagination: strategy,
        cache: { store, identity: IDENTITY },
      },
    );
    expect(store.size()).toBe(0); // a write is never stored
  });

  it("never caches a non-2xx page", async () => {
    const store = new InMemoryPageCacheStore();
    const strategy = defaultPaginatorRegistry.resolve(CACHE_STRATEGY_CONFIG);
    const execute = () =>
      Promise.resolve<OperationResult>({ status: 500, headers: {}, body: { error: "boom" }, bodyIsRaw: false });

    const result = await paginate(FIRST, execute, {
      strategy,
      cache: { store, identity: IDENTITY },
    });
    expect(result.lastStatus).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(0);
    expect(store.size()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Cache key + freshness units
// ─────────────────────────────────────────────────────────────────────

describe("paginator — cache key + freshness", () => {
  it("derivePageCacheKey ignores param key order but changes with values", () => {
    const a = derivePageCacheKey(IDENTITY, "op", { query: { a: 1, b: 2 } });
    const b = derivePageCacheKey(IDENTITY, "op", { query: { b: 2, a: 1 } });
    const c = derivePageCacheKey(IDENTITY, "op", { query: { a: 1, b: 3 } });
    expect(a).toBe(b); // sorted-params hash is order-insensitive
    expect(a).not.toBe(c); // a different cursor/value is a distinct page
    expect(a.startsWith("ws-1::inst-1::op::")).toBe(true);
  });

  it("isPageFresh: stale past TTL, stale at/under watermark, fresh otherwise", () => {
    const entry: CachedPage = { cachedAt: 1000, result: ok(null) };
    expect(isPageFresh(entry, { ttlMs: 100, watermark: 0, now: 1050 })).toBe(true);
    expect(isPageFresh(entry, { ttlMs: 100, watermark: 0, now: 1100 })).toBe(false); // TTL boundary
    expect(isPageFresh(entry, { ttlMs: 9999, watermark: 1000, now: 1050 })).toBe(false); // cachedAt <= watermark
    expect(isPageFresh(entry, { ttlMs: 9999, watermark: 999, now: 1050 })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Detection + registry extensibility
// ─────────────────────────────────────────────────────────────────────

describe("paginator — detection + registry", () => {
  it("detectPaginationConfig reads x-pagination (type|strategy), null otherwise", () => {
    expect(detectPaginationConfig(undefined)).toBeNull();
    expect(detectPaginationConfig({})).toBeNull();
    expect(detectPaginationConfig({ "x-pagination": [] })).toBeNull();

    const detected = detectPaginationConfig({
      "x-pagination": { type: "cursor", itemsPath: "data", cursorParam: "after", cursorPath: "c" },
    });
    expect(detected).toEqual({
      type: "cursor",
      strategy: "cursor",
      itemsPath: "data",
      cursorParam: "after",
      cursorPath: "c",
    });
    // …and it resolves to a real strategy.
    const strategy = defaultPaginatorRegistry.resolve(detected!);
    expect(strategy.name).toBe("cursor");
  });

  it("the four built-ins are registered", () => {
    expect(defaultPaginatorRegistry.list().toSorted()).toEqual([
      "cursor",
      "link-header",
      "offset",
      "page",
    ]);
    expect(BUILT_IN_STRATEGIES).toHaveLength(4);
  });

  it("a fifth strategy registers without touching the engine ('one new file')", () => {
    const registry = new PaginatorRegistry(BUILT_IN_STRATEGIES);
    registry.register({
      name: "starting-after",
      create: (config) => ({
        name: "starting-after",
        itemsPath: requireString(config, "itemsPath"),
        next: () => null,
      }),
    });
    expect(registry.has("starting-after")).toBe(true);
    expect(registry.resolve({ strategy: "starting-after", itemsPath: "data" }).name).toBe(
      "starting-after",
    );
  });

  it("resolve fails loud on an unknown strategy and a missing required field", () => {
    expect(() => defaultPaginatorRegistry.resolve({ strategy: "nope" })).toThrow(PaginationConfigError);
    expect(() => defaultPaginatorRegistry.resolve({ strategy: "cursor" })).toThrow(PaginationConfigError);
  });

  it("duplicate strategy registration is a fail-loud programming error", () => {
    const registry = new PaginatorRegistry(BUILT_IN_STRATEGIES);
    expect(() => registry.register(BUILT_IN_STRATEGIES[0])).toThrow(/already registered/);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

describe("paginator — pure helpers", () => {
  it("dotGet traverses and returns undefined for missing/non-object segments", () => {
    expect(dotGet({ a: { b: 2 } }, "a.b")).toBe(2);
    expect(dotGet({ a: { b: 2 } }, "a.c")).toBeUndefined();
    expect(dotGet({ a: 1 }, "a.b")).toBeUndefined();
    expect(dotGet(null, "a")).toBeUndefined();
  });

  it("extractItems returns the array at the path, else []", () => {
    expect(extractItems({ data: { people: [1, 2] } }, "data.people")).toEqual([1, 2]);
    expect(extractItems({ data: { people: "nope" } }, "data.people")).toEqual([]);
    expect(extractItems({}, "missing")).toEqual([]);
  });
});
