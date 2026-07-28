import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";

import {
  __resetGatewayCatalogCacheForTests,
  __getRecommendedIdsForTests,
  getGatewayCatalog,
  peekModelContextWindow,
  warmGatewayCatalog,
  isSelectableGatewayModel,
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
    // Every fallback entry must survive the REAL predicate, not a hand-copied
    // restatement of it (#4869 review). This asserted `type === "language" &&
    // supportsTools === true`, which is just FALLBACK_MODELS' own literals read
    // back — it would stay green if `isSelectableGatewayModel` grew a third
    // gate, and a gateway outage would then empty the picker, the exact
    // scenario the assertion claims to guard.
    for (const model of res.models) {
      expect(isSelectableGatewayModel(model)).toBe(true);
    }
    // The fallback must also carry the platform default, or an outage forces a
    // downgrade to change models at all.
    const ids = res.models.map((m) => m.id);
    expect(ids).toContain("anthropic/claude-opus-5");
  });

  test("the bundled fallback covers the shipped ATLAS_RECOMMENDED_MODELS default", async () => {
    // Drift guard: the manifest and the registry default are two hand-written
    // lists of the same intent, and they had silently diverged by a whole
    // model generation (#4869 review). Reads the registry default rather than
    // restating it, so curation changes surface here instead of in a
    // screenshot during the next outage.
    delete process.env.ATLAS_RECOMMENDED_MODELS;
    const shortlist = __getRecommendedIdsForTests();
    expect(shortlist.length).toBeGreaterThan(0);

    globalThis.fetch = mockFetchFail(503);
    const res = await getGatewayCatalog();
    expect(res.fallback).toBe(true);

    const ids = new Set(res.models.map((m) => m.id));
    const missing = shortlist.filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
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

  test("an unknown type fails CLOSED to 'other', never to 'language'", async () => {
    // The old behavior mapped an unrecognized type to `language` — the ONE
    // value that passes the picker's type gate — so a type the gateway adds
    // tomorrow would be offered as a selectable chat model. The capability
    // gate can't backstop it: `supported_parameters` is absent on 97 of the
    // 101 current non-language entries, so such an entry gets
    // `supportsTools: null` and `null !== false` passes (#4869 review).
    globalThis.fetch = mockFetchOk({
      data: [{ id: "x/audio-model", type: "audio" }],
    });
    const res = await getGatewayCatalog();
    expect(res.models[0]?.type).toBe("other");
  });

  test("an unknown-typed entry is NOT selectable, even with no capability data", async () => {
    // The end-to-end version of the above: this is the property that actually
    // matters, asserted through the shared predicate the picker filters on and
    // the API enforces — not through the normalizer's internals.
    globalThis.fetch = mockFetchOk({
      data: [{ id: "x/audio-model", type: "audio" }],
    });
    const res = await getGatewayCatalog();
    const entry = res.models[0]!;
    expect(entry.supportsTools).toBeNull(); // no supported_parameters ⇒ unknown
    expect(isSelectableGatewayModel(entry)).toBe(false);
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

  describe("warmGatewayCatalog (#4869 review)", () => {
    test("is a no-op when the cache is already fresh", async () => {
      let fetches = 0;
      globalThis.fetch = (async () => {
        fetches += 1;
        return new Response(JSON.stringify({ data: [{ id: "a/b", type: "language" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as FetchFn;

      await getGatewayCatalog();
      expect(fetches).toBe(1);

      warmGatewayCatalog();
      warmGatewayCatalog();
      await Promise.resolve();
      // The early return is load-bearing: this runs on every agent step for a
      // gateway-shaped id, so a regression here is one fetch PER STEP.
      expect(fetches).toBe(1);
    });

    test("does not stampede — concurrent warms share one inflight fetch", async () => {
      let fetches = 0;
      globalThis.fetch = (async () => {
        fetches += 1;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ data: [{ id: "a/b", type: "language" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as FetchFn;

      for (let i = 0; i < 25; i += 1) warmGatewayCatalog();
      await getGatewayCatalog();
      expect(fetches).toBe(1);
    });

    test("never throws from its synchronous call site, even when fetch rejects", () => {
      globalThis.fetch = (() => {
        throw new Error("network stack exploded");
      }) as unknown as FetchFn;
      // Called from `prepareStep`-adjacent sync code — a throw here would take
      // the turn down.
      expect(() => warmGatewayCatalog()).not.toThrow();
    });
  });

  describe("Recommended group ordering (#4869 review)", () => {
    test("renders the shortlist in the OPERATOR's order, not catalog order", async () => {
      // The setting is a RANKED shortlist — the first entry is the house
      // default. `applyRecommended` used to return catalog order, silently
      // discarding that curation.
      process.env.ATLAS_RECOMMENDED_MODELS = "c/third,a/first,b/second";
      globalThis.fetch = mockFetchOk({
        data: [
          { id: "a/first", type: "language" },
          { id: "b/second", type: "language" },
          { id: "c/third", type: "language" },
          { id: "z/unlisted", type: "language" },
        ],
      });
      const res = await getGatewayCatalog();
      const recommended = res.models.filter((m) => m.recommended).map((m) => m.id);
      expect(recommended).toEqual(["c/third", "a/first", "b/second"]);
    });

    test("keeps non-recommended models present after the shortlist", async () => {
      process.env.ATLAS_RECOMMENDED_MODELS = "b/second";
      globalThis.fetch = mockFetchOk({
        data: [
          { id: "a/first", type: "language" },
          { id: "b/second", type: "language" },
        ],
      });
      const res = await getGatewayCatalog();
      expect(res.models.map((m) => m.id)).toEqual(["b/second", "a/first"]);
      // ...and nothing is dropped or duplicated by the reordering.
      expect(res.models).toHaveLength(2);
    });

    test("de-duplicates a repeated id in the setting", async () => {
      process.env.ATLAS_RECOMMENDED_MODELS = "a/one,a/one,b/two";
      globalThis.fetch = mockFetchOk({
        data: [
          { id: "a/one", type: "language" },
          { id: "b/two", type: "language" },
        ],
      });
      const res = await getGatewayCatalog();
      expect(res.models.map((m) => m.id)).toEqual(["a/one", "b/two"]);
    });
  });

  describe("bundled fallback is never treated as authoritative (#4869 review)", () => {
    async function forceFallback() {
      globalThis.fetch = mock(async () => new Response("down", { status: 503 })) as unknown as FetchFn;
      return getGatewayCatalog();
    }

    test("peekModelContextWindow returns null off a fallback cache", async () => {
      const res = await forceFallback();
      expect(res.fallback).toBe(true);
      // sonnet-5 IS in FALLBACK_MODELS with a contextWindow, so a naive peek
      // would happily return it. Four hand-maintained constants must not size
      // compaction — the manifest had opus-4.8 at 200k against a real 1M.
      expect(peekModelContextWindow("anthropic/claude-sonnet-5")).toBeNull();
      expect(peekModelContextWindow("anthropic/claude-opus-4.8")).toBeNull();
    });

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
