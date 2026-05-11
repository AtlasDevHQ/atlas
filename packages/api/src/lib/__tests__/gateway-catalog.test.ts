import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import {
  __resetGatewayCatalogCacheForTests,
  __getRecommendedIdsForTests,
  getGatewayCatalog,
} from "../gateway-catalog";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

function mockFetchOk(body: unknown): FetchFn {
  return mock(async (): Promise<Response> => {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
}

function mockFetchFail(status: number): FetchFn {
  return mock(async (): Promise<Response> => {
    return new Response("upstream broken", { status });
  }) as unknown as FetchFn;
}

describe("gateway-catalog", () => {
  beforeEach(() => {
    __resetGatewayCatalogCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetGatewayCatalogCacheForTests();
  });

  test("normalizes a live catalog payload", async () => {
    globalThis.fetch = mockFetchOk({
      data: [
        {
          id: "anthropic/claude-opus-4.6",
          name: "Claude Opus 4.6",
          type: "language",
          context_window: 200_000,
          max_tokens: 32_000,
          pricing: { input: "0.000015", output: "0.000075" },
        },
        {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o mini",
          type: "language",
          context_window: 128_000,
          max_tokens: 16_000,
          pricing: { input: "0.00000015", output: "0.0000006" },
        },
        // Entry without id is dropped.
        { name: "missing id", type: "language" },
      ],
    });

    const res = await getGatewayCatalog();
    expect(res.fallback).toBe(false);
    expect(res.models).toHaveLength(2);
    const claude = res.models.find((m) => m.id === "anthropic/claude-opus-4.6");
    expect(claude?.provider).toBe("anthropic");
    expect(claude?.contextWindow).toBe(200_000);
    expect(claude?.maxOutputTokens).toBe(32_000);
    expect(claude?.inputPrice).toBe("0.000015");
    expect(claude?.recommended).toBe(true);
  });

  test("returns bundled fallback when the live fetch fails", async () => {
    globalThis.fetch = mockFetchFail(503);
    const res = await getGatewayCatalog();
    expect(res.fallback).toBe(true);
    expect(res.models.length).toBeGreaterThan(0);
    // Every fallback entry must be in the recommended set.
    for (const model of res.models) {
      expect(__getRecommendedIdsForTests().has(model.id)).toBe(true);
    }
  });

  test("caches the catalog within a TTL window", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "a/b", type: "language" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as FetchFn;

    await getGatewayCatalog();
    await getGatewayCatalog();
    await getGatewayCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("dedupes concurrent fetches via inflight promise", async () => {
    let resolveLive: (value: Response) => void = () => {};
    const livePromise = new Promise<Response>((resolve) => {
      resolveLive = resolve;
    });
    const fetchMock = mock((): Promise<Response> => livePromise);
    globalThis.fetch = fetchMock as unknown as FetchFn;

    const a = getGatewayCatalog();
    const b = getGatewayCatalog();

    resolveLive(
      new Response(JSON.stringify({ data: [{ id: "x/y", type: "language" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.models).toEqual(resB.models);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("non-numeric or non-positive metadata becomes null", async () => {
    globalThis.fetch = mockFetchOk({
      data: [
        {
          id: "weird/model",
          name: "Weird",
          type: "language",
          context_window: "lots",
          max_tokens: -1,
          pricing: { input: null, output: null },
        },
      ],
    });
    const res = await getGatewayCatalog();
    const entry = res.models[0];
    expect(entry?.contextWindow).toBeNull();
    expect(entry?.maxOutputTokens).toBeNull();
    expect(entry?.inputPrice).toBeNull();
    expect(entry?.outputPrice).toBeNull();
  });

  test("number-typed pricing values are coerced to strings", async () => {
    globalThis.fetch = mockFetchOk({
      data: [
        {
          id: "vercel/numeric-pricing",
          type: "language",
          pricing: { input: 0.000015, output: 0.000075 },
        },
      ],
    });
    const res = await getGatewayCatalog();
    const entry = res.models[0];
    expect(entry?.inputPrice).toBe("0.000015");
    expect(entry?.outputPrice).toBe("0.000075");
  });

  test("unknown type values fall back to 'language'", async () => {
    globalThis.fetch = mockFetchOk({
      data: [{ id: "x/audio-model", type: "audio" }],
    });
    const res = await getGatewayCatalog();
    expect(res.models[0]?.type).toBe("language");
  });
});
