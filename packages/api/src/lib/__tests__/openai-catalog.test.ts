import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import {
  __resetOpenAICatalogCacheForTests,
  __getRecommendedOpenAIIdsForTests,
  OpenAICatalogRateLimited,
  OpenAICatalogUnauthorized,
  OpenAICatalogUnavailable,
  getOpenAICatalog,
  invalidateOpenAICatalog,
} from "../openai-catalog";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

const ORG_A = "org_a";
const KEY = "sk-test-key";

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

describe("openai-catalog", () => {
  beforeEach(() => {
    __resetOpenAICatalogCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetOpenAICatalogCacheForTests();
  });

  test("filters /v1/models down to chat-capable models", async () => {
    globalThis.fetch = mockFetchOk({
      object: "list",
      data: [
        // Chat — kept.
        { id: "gpt-4o", object: "model", created: 1, owned_by: "openai" },
        { id: "gpt-4o-mini", object: "model", created: 1, owned_by: "openai" },
        { id: "o3-mini", object: "model", created: 1, owned_by: "openai" },
        // Filtered.
        { id: "text-embedding-3-large", object: "model" },
        { id: "whisper-1", object: "model" },
        { id: "tts-1", object: "model" },
        { id: "dall-e-3", object: "model" },
        { id: "omni-moderation-latest", object: "model" },
        { id: "gpt-3.5-turbo-instruct", object: "model" },
        { id: "gpt-4o-realtime-preview", object: "model" },
        { id: "gpt-4o-audio-preview", object: "model" },
        // Malformed — dropped.
        { object: "model" },
      ],
    });

    const res = await getOpenAICatalog(ORG_A, KEY);
    expect(res.source).toBe("fresh");
    const ids = res.models.map((m) => m.id).sort();
    expect(ids).toEqual(["gpt-4o", "gpt-4o-mini", "o3-mini"]);
    const flagship = res.models.find((m) => m.id === "gpt-4o");
    expect(flagship?.provider).toBe("openai");
    expect(flagship?.recommended).toBe(true);
  });

  test("non-recommended chat models are kept but flagged recommended:false", async () => {
    globalThis.fetch = mockFetchOk({
      data: [
        { id: "gpt-4o", object: "model" },
        { id: "gpt-future-model-2027", object: "model" },
      ],
    });
    const res = await getOpenAICatalog(ORG_A, KEY);
    expect(res.models.find((m) => m.id === "gpt-future-model-2027")?.recommended).toBe(false);
    expect(res.models.find((m) => m.id === "gpt-4o")?.recommended).toBe(true);
  });

  test("forward-compat: unknown chat-prefixed IDs pass the filter", async () => {
    // Future OpenAI model ID patterns we want to keep surfacing even
    // without explicit knowledge of them. The filter is allowlist by
    // prefix + denylist by substring; this confirms the allowlist
    // dominates for novel `gpt-N-*` / `o*-N-*` ids and that omni
    // variants tagged as audio/moderation/realtime still drop.
    globalThis.fetch = mockFetchOk({
      data: [
        { id: "gpt-5-2027-08-mini", object: "model" },
        { id: "o4-2027-preview", object: "model" },
        { id: "chatgpt-5o-latest", object: "model" },
        { id: "omni-moderation-2027", object: "model" }, // drop: moderation
        { id: "gpt-5-audio-preview", object: "model" }, // drop: audio
      ],
    });
    const res = await getOpenAICatalog(ORG_A, KEY);
    const ids = res.models.map((m) => m.id).sort();
    expect(ids).toEqual(["chatgpt-5o-latest", "gpt-5-2027-08-mini", "o4-2027-preview"]);
  });

  test("401 surfaces OpenAICatalogUnauthorized", async () => {
    globalThis.fetch = mockFetchStatus(401);
    await expect(getOpenAICatalog(ORG_A, "bad-key")).rejects.toBeInstanceOf(
      OpenAICatalogUnauthorized,
    );
  });

  test("429 surfaces OpenAICatalogRateLimited with retry-after parsed", async () => {
    globalThis.fetch = mockFetchStatus(429, { "retry-after": "60" });
    try {
      await getOpenAICatalog(ORG_A, KEY);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenAICatalogRateLimited);
      if (err instanceof OpenAICatalogRateLimited) {
        expect(err.retryAfterSeconds).toBe(60);
      }
    }
  });

  test("503 surfaces OpenAICatalogUnavailable", async () => {
    globalThis.fetch = mockFetchStatus(503);
    await expect(getOpenAICatalog(ORG_A, KEY)).rejects.toBeInstanceOf(
      OpenAICatalogUnavailable,
    );
  });

  test("network failure surfaces OpenAICatalogUnavailable", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchFn;
    await expect(getOpenAICatalog(ORG_A, KEY)).rejects.toBeInstanceOf(
      OpenAICatalogUnavailable,
    );
  });

  test("malformed `data` field surfaces OpenAICatalogUnavailable", async () => {
    globalThis.fetch = mockFetchOk({ data: "not-an-array" });
    await expect(getOpenAICatalog(ORG_A, KEY)).rejects.toBeInstanceOf(
      OpenAICatalogUnavailable,
    );
  });

  test("caches a successful fetch per orgId", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as FetchFn;
    const first = await getOpenAICatalog(ORG_A, KEY);
    const second = await getOpenAICatalog(ORG_A, KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.source).toBe("fresh");
    expect(second.source).toBe("cache");
  });

  test("opts.refresh bypasses the cache", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as FetchFn;
    await getOpenAICatalog(ORG_A, KEY);
    const refreshed = await getOpenAICatalog(ORG_A, KEY, { refresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed.source).toBe("fresh");
  });

  test("invalidateOpenAICatalog forces a re-fetch on next call", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as FetchFn;
    await getOpenAICatalog(ORG_A, KEY);
    invalidateOpenAICatalog(ORG_A);
    const second = await getOpenAICatalog(ORG_A, KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.source).toBe("fresh");
  });

  test("concurrent fetches for the same org dedupe to one upstream call", async () => {
    const pending = Promise.withResolvers<Response>();
    const slowFetch: FetchFn = mock(() => pending.promise) as unknown as FetchFn;
    globalThis.fetch = slowFetch;

    const p1 = getOpenAICatalog(ORG_A, KEY);
    const p2 = getOpenAICatalog(ORG_A, KEY);

    pending.resolve(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(slowFetch).toHaveBeenCalledTimes(1);
    expect(r1.models[0].id).toBe("gpt-4o");
    expect(r2.models[0].id).toBe("gpt-4o");
  });

  test("recommended set is non-empty and includes the flagship", () => {
    const ids = __getRecommendedOpenAIIdsForTests();
    expect(ids.size).toBeGreaterThan(0);
    expect(ids.has("gpt-4o")).toBe(true);
  });
});
