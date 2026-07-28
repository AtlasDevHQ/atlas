/**
 * Stale-shortlist warning behavior (#4869 review).
 *
 * Split into its own file for one reason: `gateway-catalog.ts` captures its
 * logger at module-init time (`const log = createLogger(...)`). A `mock.module`
 * in a file that ALSO statically imports the module never takes effect, because
 * ES import hoisting runs the import first — an earlier version of these tests
 * intercepted `console.warn` instead and passed even with the fix reverted
 * (pino does not route through console). Mocking the logger and then importing
 * the subject dynamically is what makes the assertion real.
 *
 * What's under test: `applyRecommended` must NOT warn that an operator's
 * shortlist is stale when the catalog it's comparing against is the 4-model
 * bundled fallback. The shipped shortlist names 9 models, so during a gateway
 * outage this told the operator to "prune or replace" 8 CORRECT ids — once per
 * request, at a 60s fallback TTL, for the whole incident.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";

const warnLog: Array<{ ctx: unknown; msg: string }> = [];

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: (ctx: unknown, msg: string) => void warnLog.push({ ctx, msg }),
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => null,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

function mockFetchOk(body: unknown): FetchFn {
  return mock(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as FetchFn;
}

// Dynamic — must resolve AFTER the mock above is installed.
const { getGatewayCatalog, __resetGatewayCatalogCacheForTests } = await import(
  "@atlas/api/lib/gateway-catalog"
);

describe("applyRecommended — stale-shortlist warning", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.ATLAS_RECOMMENDED_MODELS;
    warnLog.length = 0;
    __resetGatewayCatalogCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.ATLAS_RECOMMENDED_MODELS;
    else process.env.ATLAS_RECOMMENDED_MODELS = saved;
    __resetGatewayCatalogCacheForTests();
  });

  function staleWarnings() {
    return warnLog.filter((w) => w.msg.includes("prune or replace"));
  }

  test("warns for an id a LIVE catalog genuinely does not serve", async () => {
    process.env.ATLAS_RECOMMENDED_MODELS = "a/one,ghost/retired-model";
    globalThis.fetch = mockFetchOk({ data: [{ id: "a/one", type: "language" }] });

    const res = await getGatewayCatalog();

    expect(res.fallback).toBe(false);
    const warned = staleWarnings();
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0]?.ctx)).toContain("ghost/retired-model");
    // ...and the real id is still starred.
    expect(res.models.find((m) => m.id === "a/one")?.recommended).toBe(true);
  });

  test("does NOT warn when the catalog is the bundled fallback", async () => {
    // Every one of these IS served by the live gateway — they're simply absent
    // from the 4-model emergency manifest, which is not evidence of anything.
    process.env.ATLAS_RECOMMENDED_MODELS = "anthropic/claude-opus-5,zai/glm-5.2";
    globalThis.fetch = mock(
      async () => new Response("gateway down", { status: 503 }),
    ) as unknown as FetchFn;

    const res = await getGatewayCatalog();

    expect(res.fallback).toBe(true);
    expect(staleWarnings()).toHaveLength(0);
  });

  test("de-duplicates the warning across repeated catalog reads", async () => {
    // `applyRecommended` runs on every read (several per admin page load). An
    // un-deduped warn buries the one stale id that matters under repeats.
    process.env.ATLAS_RECOMMENDED_MODELS = "ghost/retired-model";
    globalThis.fetch = mockFetchOk({ data: [{ id: "a/one", type: "language" }] });

    await getGatewayCatalog();
    await getGatewayCatalog();
    await getGatewayCatalog();

    expect(staleWarnings()).toHaveLength(1);
  });
});
