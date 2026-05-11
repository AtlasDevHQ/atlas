import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import {
  __resetAnthropicCatalogCacheForTests,
  __getRecommendedAnthropicIdsForTests,
  AnthropicCatalogRateLimited,
  AnthropicCatalogUnauthorized,
  AnthropicCatalogUnavailable,
  getAnthropicCatalog,
  invalidateAnthropicCatalog,
} from "../anthropic-catalog";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

const ORG_A = "org_a";
const ORG_B = "org_b";
const KEY = "sk-ant-test-key";

function mockFetchOk(body: unknown): FetchFn {
  return mock(async (): Promise<Response> => {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
}

function mockFetchStatus(status: number, headers: Record<string, string> = {}): FetchFn {
  return mock(async (): Promise<Response> => {
    return new Response("upstream", { status, headers });
  }) as unknown as FetchFn;
}

describe("anthropic-catalog", () => {
  beforeEach(() => {
    __resetAnthropicCatalogCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetAnthropicCatalogCacheForTests();
  });

  test("normalizes a live /v1/models payload", async () => {
    globalThis.fetch = mockFetchOk({
      data: [
        { type: "model", id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
        { type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
        // Entry without id is dropped.
        { type: "model", display_name: "Phantom" },
      ],
    });

    const res = await getAnthropicCatalog(ORG_A, KEY);
    expect(res.source).toBe("fresh");
    expect(res.models).toHaveLength(2);
    const opus = res.models.find((m) => m.id === "claude-opus-4-6");
    expect(opus?.name).toBe("Claude Opus 4.6");
    expect(opus?.provider).toBe("anthropic");
    expect(opus?.type).toBe("language");
    expect(opus?.recommended).toBe(true);
  });

  test("falls back to id when display_name is missing", async () => {
    globalThis.fetch = mockFetchOk({
      data: [{ type: "model", id: "claude-future-model" }],
    });
    const res = await getAnthropicCatalog(ORG_A, KEY);
    expect(res.models[0].name).toBe("claude-future-model");
    expect(res.models[0].recommended).toBe(false);
  });

  test("401 surfaces AnthropicCatalogUnauthorized", async () => {
    globalThis.fetch = mockFetchStatus(401);
    await expect(getAnthropicCatalog(ORG_A, "bad-key")).rejects.toBeInstanceOf(
      AnthropicCatalogUnauthorized,
    );
  });

  test("403 also surfaces AnthropicCatalogUnauthorized", async () => {
    globalThis.fetch = mockFetchStatus(403);
    await expect(getAnthropicCatalog(ORG_A, "bad-key")).rejects.toBeInstanceOf(
      AnthropicCatalogUnauthorized,
    );
  });

  test("429 surfaces AnthropicCatalogRateLimited with retry-after parsed", async () => {
    globalThis.fetch = mockFetchStatus(429, { "retry-after": "30" });
    try {
      await getAnthropicCatalog(ORG_A, KEY);
      throw new Error("expected rate-limit throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AnthropicCatalogRateLimited);
      if (err instanceof AnthropicCatalogRateLimited) {
        expect(err.retryAfterSeconds).toBe(30);
      }
    }
  });

  test("429 without retry-after still surfaces AnthropicCatalogRateLimited", async () => {
    globalThis.fetch = mockFetchStatus(429);
    try {
      await getAnthropicCatalog(ORG_A, KEY);
      throw new Error("expected rate-limit throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AnthropicCatalogRateLimited);
      if (err instanceof AnthropicCatalogRateLimited) {
        expect(err.retryAfterSeconds).toBeNull();
      }
    }
  });

  test("503 surfaces AnthropicCatalogUnavailable", async () => {
    globalThis.fetch = mockFetchStatus(503);
    await expect(getAnthropicCatalog(ORG_A, KEY)).rejects.toBeInstanceOf(
      AnthropicCatalogUnavailable,
    );
  });

  test("network failure surfaces AnthropicCatalogUnavailable", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchFn;
    await expect(getAnthropicCatalog(ORG_A, KEY)).rejects.toBeInstanceOf(
      AnthropicCatalogUnavailable,
    );
  });

  test("malformed `data` field surfaces AnthropicCatalogUnavailable", async () => {
    globalThis.fetch = mockFetchOk({ data: "not-an-array" });
    await expect(getAnthropicCatalog(ORG_A, KEY)).rejects.toBeInstanceOf(
      AnthropicCatalogUnavailable,
    );
  });

  test("caches a successful fetch per orgId", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as FetchFn;

    const first = await getAnthropicCatalog(ORG_A, KEY);
    const second = await getAnthropicCatalog(ORG_A, KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.source).toBe("fresh");
    expect(second.source).toBe("cache");
  });

  test("cache is scoped per orgId", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as FetchFn;

    await getAnthropicCatalog(ORG_A, KEY);
    await getAnthropicCatalog(ORG_B, KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("opts.refresh bypasses the cache", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as FetchFn;

    await getAnthropicCatalog(ORG_A, KEY);
    const refreshed = await getAnthropicCatalog(ORG_A, KEY, { refresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed.source).toBe("fresh");
  });

  test("invalidateAnthropicCatalog forces a re-fetch on next call", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as FetchFn;

    await getAnthropicCatalog(ORG_A, KEY);
    invalidateAnthropicCatalog(ORG_A);
    const second = await getAnthropicCatalog(ORG_A, KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.source).toBe("fresh");
  });

  test("concurrent fetches for the same org dedupe to one upstream call", async () => {
    type ResolveBody = (value: Response) => void;
    const pending = Promise.withResolvers<Response>();
    const slowFetch: FetchFn = mock(() => pending.promise) as unknown as FetchFn;
    globalThis.fetch = slowFetch;

    const p1 = getAnthropicCatalog(ORG_A, KEY);
    const p2 = getAnthropicCatalog(ORG_A, KEY);

    // Resolve the in-flight fetch once; both callers must share the result.
    (pending.resolve as ResolveBody)(
      new Response(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(slowFetch).toHaveBeenCalledTimes(1);
    expect(r1.models[0].id).toBe("claude-opus-4-6");
    expect(r2.models[0].id).toBe("claude-opus-4-6");
  });

  test("recommended set is non-empty and stable", () => {
    const ids = __getRecommendedAnthropicIdsForTests();
    expect(ids.size).toBeGreaterThan(0);
    expect(ids.has("claude-opus-4-6")).toBe(true);
  });
});
