import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import {
  __resetGatewayCatalogCacheForTests,
  __getRecommendedIdsForTests,
  getGatewayCatalog,
  peekModelContextWindow,
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
  // The shortlist is a hot-reloadable setting (#4869), so tests pin it through
  // the env tier rather than relying on the registry default — which is
  // curation and will drift as models ship. Saved/restored per test to stay
  // self-contained (no top-level env writes).
  let savedRecommended: string | undefined;

  beforeEach(() => {
    savedRecommended = process.env.ATLAS_RECOMMENDED_MODELS;
    __resetGatewayCatalogCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedRecommended === undefined) delete process.env.ATLAS_RECOMMENDED_MODELS;
    else process.env.ATLAS_RECOMMENDED_MODELS = savedRecommended;
    __resetGatewayCatalogCacheForTests();
  });

  test("normalizes a live catalog payload", async () => {
    process.env.ATLAS_RECOMMENDED_MODELS = "anthropic/claude-opus-4.8";
    globalThis.fetch = mockFetchOk({
      data: [
        {
          id: "anthropic/claude-opus-4.8",
          name: "Claude Opus 4.8",
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
    const claude = res.models.find((m) => m.id === "anthropic/claude-opus-4.8");
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
    // Every fallback entry must be usable by the agent loop — a gateway outage
    // must not leave the picker's capability filter with nothing to show.
    for (const model of res.models) {
      expect(model.type).toBe("language");
      expect(model.supportsTools).toBe(true);
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

  test("the types the gateway actually serves are NOT swept into 'language'", async () => {
    // Regression guard (#4869): `transcription` / `realtime` / `speech` were
    // missing from GATEWAY_MODEL_TYPES, so the unknown-type fallback above
    // silently relabelled 13 live models as chat models. The fallback is a
    // fail-OPEN, so every type the gateway really publishes must be listed.
    globalThis.fetch = mockFetchOk({
      data: [
        { id: "openai/whisper-1", type: "transcription" },
        { id: "openai/gpt-realtime-2", type: "realtime" },
        { id: "openai/tts-1", type: "speech" },
      ],
    });
    const res = await getGatewayCatalog();
    expect(res.models.map((m) => m.type)).toEqual(["transcription", "realtime", "speech"]);
  });

  describe("tool-calling capability (#4869)", () => {
    test("reads `tools` out of supported_parameters", async () => {
      globalThis.fetch = mockFetchOk({
        data: [
          {
            id: "a/agentic",
            type: "language",
            supported_parameters: ["max_tokens", "tools", "tool_choice"],
          },
          {
            id: "a/chat-only",
            type: "language",
            supported_parameters: ["max_tokens", "temperature"],
          },
        ],
      });
      const res = await getGatewayCatalog();
      expect(res.models.find((m) => m.id === "a/agentic")?.supportsTools).toBe(true);
      expect(res.models.find((m) => m.id === "a/chat-only")?.supportsTools).toBe(false);
    });

    test("a missing supported_parameters is unknown (null), NOT false", async () => {
      // The distinction is load-bearing: the picker filters on
      // `supportsTools !== false`, so collapsing absent→false here would hide
      // every model the moment upstream renamed the field.
      globalThis.fetch = mockFetchOk({ data: [{ id: "a/no-capability-data", type: "language" }] });
      const res = await getGatewayCatalog();
      expect(res.models[0]?.supportsTools).toBeNull();
    });

    test("a non-array supported_parameters is unknown, not a crash", async () => {
      globalThis.fetch = mockFetchOk({
        data: [{ id: "a/weird", type: "language", supported_parameters: "tools" }],
      });
      const res = await getGatewayCatalog();
      expect(res.models[0]?.supportsTools).toBeNull();
    });
  });

  describe("settings-backed shortlist (#4869)", () => {
    const TWO_MODELS = {
      data: [
        { id: "a/one", type: "language" },
        { id: "b/two", type: "language" },
      ],
    };

    test("stars exactly the IDs named in ATLAS_RECOMMENDED_MODELS", async () => {
      process.env.ATLAS_RECOMMENDED_MODELS = "b/two";
      globalThis.fetch = mockFetchOk(TWO_MODELS);
      const res = await getGatewayCatalog();
      expect(res.models.find((m) => m.id === "a/one")?.recommended).toBe(false);
      expect(res.models.find((m) => m.id === "b/two")?.recommended).toBe(true);
    });

    test("tolerates whitespace and empty entries", async () => {
      process.env.ATLAS_RECOMMENDED_MODELS = " b/two , , a/one ,";
      globalThis.fetch = mockFetchOk(TWO_MODELS);
      const res = await getGatewayCatalog();
      expect(res.models.every((m) => m.recommended)).toBe(true);
    });

    test("a blank setting means no Recommended group, not the seeded default", async () => {
      process.env.ATLAS_RECOMMENDED_MODELS = "";
      globalThis.fetch = mockFetchOk(TWO_MODELS);
      const res = await getGatewayCatalog();
      expect(res.models.some((m) => m.recommended)).toBe(false);
    });

    test("an edit applies WITHOUT waiting out the catalog TTL", async () => {
      // The whole point of moving curation out of source was that it shouldn't
      // need a deploy; it must not need a 30-minute cache expiry either. The
      // second read is served from cache (fetch called once) yet reflects the
      // new shortlist.
      const fetchMock = mock(
        async () =>
          new Response(JSON.stringify(TWO_MODELS), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      globalThis.fetch = fetchMock as unknown as FetchFn;

      process.env.ATLAS_RECOMMENDED_MODELS = "a/one";
      const before = await getGatewayCatalog();
      expect(before.models.find((m) => m.id === "a/one")?.recommended).toBe(true);
      expect(before.models.find((m) => m.id === "b/two")?.recommended).toBe(false);

      process.env.ATLAS_RECOMMENDED_MODELS = "b/two";
      const after = await getGatewayCatalog();
      expect(after.models.find((m) => m.id === "a/one")?.recommended).toBe(false);
      expect(after.models.find((m) => m.id === "b/two")?.recommended).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("the overlay does not mutate the shared cache entry", async () => {
      // The cached array is handed to every concurrent caller; stamping it in
      // place would leak one request's resolved shortlist into the next.
      globalThis.fetch = mockFetchOk(TWO_MODELS);
      process.env.ATLAS_RECOMMENDED_MODELS = "a/one";
      await getGatewayCatalog();
      process.env.ATLAS_RECOMMENDED_MODELS = "";
      const cleared = await getGatewayCatalog();
      expect(cleared.models.some((m) => m.recommended)).toBe(false);
    });

    test("__getRecommendedIdsForTests reflects the live setting", () => {
      process.env.ATLAS_RECOMMENDED_MODELS = "x/y,z/w";
      expect([...__getRecommendedIdsForTests()]).toEqual(["x/y", "z/w"]);
    });
  });

  describe("peekModelContextWindow (#4869)", () => {
    test("returns null on a cold cache and never fetches", () => {
      const fetchMock = mock(async () => new Response("{}", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as FetchFn;
      expect(peekModelContextWindow("a/one")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    test("serves the per-model window once the catalog is warm", async () => {
      globalThis.fetch = mockFetchOk({
        data: [
          { id: "zai/glm-5.2", type: "language", context_window: 1_040_000 },
          { id: "a/no-window", type: "language" },
        ],
      });
      await getGatewayCatalog();
      expect(peekModelContextWindow("zai/glm-5.2")).toBe(1_040_000);
      // Present in the catalog but with no window published → still a miss, so
      // the caller falls through to its static table rather than to `0`.
      expect(peekModelContextWindow("a/no-window")).toBeNull();
      expect(peekModelContextWindow("not/in-catalog")).toBeNull();
      expect(peekModelContextWindow(undefined)).toBeNull();
    });
  });
});
