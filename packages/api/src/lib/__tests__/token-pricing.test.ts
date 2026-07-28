import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import {
  estimateCostUsd,
  resolveModelFamily,
  resolveRate,
} from "@atlas/api/lib/token-pricing";
import {
  getGatewayCatalog,
  __resetGatewayCatalogCacheForTests,
} from "@atlas/api/lib/gateway-catalog";

/** Neutral counts for cases that only care about priced-vs-unpriced. */
const COUNTS = {
  promptTokens: 1_000,
  completionTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe("resolveModelFamily", () => {
  it("maps gateway ids to families by substring", () => {
    expect(resolveModelFamily("anthropic/claude-haiku-4.5")).toBe("haiku");
    expect(resolveModelFamily("anthropic/claude-sonnet-4.6")).toBe("sonnet");
    expect(resolveModelFamily("anthropic/claude-opus-4.8")).toBe("opus");
  });

  it("maps direct (non-gateway) ids too", () => {
    expect(resolveModelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("is case-insensitive", () => {
    expect(resolveModelFamily("Anthropic/Claude-HAIKU")).toBe("haiku");
  });

  it("returns null for unknown / empty models", () => {
    expect(resolveModelFamily("gpt-4o")).toBeNull();
    expect(resolveModelFamily("")).toBeNull();
    expect(resolveModelFamily(null)).toBeNull();
    expect(resolveModelFamily(undefined)).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("returns null for an unknown model (distinct from $0)", () => {
    expect(
      estimateCostUsd("mistral-large", {
        promptTokens: 1000,
        completionTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });

  it("prices fresh input + output at the family base rate", () => {
    // Haiku: $1/MTok input, $5/MTok output. 1M fresh input + 1M output.
    const cost = estimateCostUsd("anthropic/claude-haiku-4.5", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(1 + 5, 6);
  });

  it("does not double-count cache tokens — they are subtracted from prompt_tokens", () => {
    // prompt_tokens (1,000,000) INCLUDES the cache split: 200k read + 100k
    // write, leaving 700k fresh input. Haiku base $1/MTok.
    //   fresh:  700k * $1   = $0.70
    //   read:   200k * $1 * 0.1  = $0.02
    //   write:  100k * $1 * 1.25 = $0.125
    //   output: 0
    const cost = estimateCostUsd("anthropic/claude-haiku-4.5", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 100_000,
    });
    expect(cost).toBeCloseTo(0.7 + 0.02 + 0.125, 6);
  });

  it("scales by family — Sonnet costs 3× Haiku on the same input", () => {
    const counts = {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const haiku = estimateCostUsd("anthropic/claude-haiku-4.5", counts)!;
    const sonnet = estimateCostUsd("anthropic/claude-sonnet-4.6", counts)!;
    expect(sonnet).toBeCloseTo(haiku * 3, 6);
  });

  it("clamps fresh input to 0 when the cache split exceeds prompt_tokens (isolated)", () => {
    // prompt_tokens 100 < cache_read 500 → fresh input clamps to 0; no
    // completion. Cost is then ONLY the cache-read contribution, proving the
    // clamp isn't masked by a negative input flowing through.
    const cost = estimateCostUsd("anthropic/claude-haiku-4.5", {
      promptTokens: 100,
      completionTokens: 0,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
    });
    // 500 * $1/MTok * 0.1 (cache-read multiplier) = $0.00005.
    expect(cost).toBeCloseTo(500 * 0.1 / 1_000_000, 12);
  });

  it("clamps negative / cache-exceeds-total inputs to a non-negative cost", () => {
    const cost = estimateCostUsd("anthropic/claude-haiku-4.5", {
      promptTokens: 100,
      completionTokens: -50,
      cacheReadTokens: 500, // exceeds prompt_tokens → fresh input clamps to 0
      cacheWriteTokens: 0,
    });
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Live gateway catalog tier (#4869 follow-up)
// ---------------------------------------------------------------------------

describe("resolveRate — catalog tier", () => {
  const realFetch = globalThis.fetch;

  function warmCatalogWith(entries: unknown[]): Promise<unknown> {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: entries }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    return getGatewayCatalog();
  }

  beforeEach(() => {
    __resetGatewayCatalogCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetGatewayCatalogCacheForTests();
  });

  it("prices a model the static family table has never heard of", async () => {
    // The whole point: before this tier, every non-Anthropic model returned
    // null and the operator spend page rendered "—".
    expect(estimateCostUsd("zai/glm-5.2", COUNTS)).toBeNull();

    await warmCatalogWith([
      {
        id: "zai/glm-5.2",
        type: "language",
        pricing: { input: "0.0000014", output: "0.0000044" },
      },
    ]);

    const rate = resolveRate("zai/glm-5.2");
    expect(rate?.source).toBe("catalog");
    // Per-token 0.0000014 → $1.40 per MTok.
    expect(rate?.inputPerMTok).toBeCloseTo(1.4, 10);
    expect(rate?.outputPerMTok).toBeCloseTo(4.4, 10);
    expect(estimateCostUsd("zai/glm-5.2", COUNTS)).not.toBeNull();
  });

  it("prefers live catalog rates over the static table for Anthropic too", async () => {
    // The static table pins sonnet at $3/$15. A catalog that says otherwise is
    // the current truth — it tracks price changes, the hardcoded table doesn't.
    expect(resolveRate("anthropic/claude-sonnet-5")?.source).toBe("family");

    await warmCatalogWith([
      {
        id: "anthropic/claude-sonnet-5",
        type: "language",
        pricing: { input: "0.000002", output: "0.00001" },
      },
    ]);

    const rate = resolveRate("anthropic/claude-sonnet-5");
    expect(rate?.source).toBe("catalog");
    expect(rate?.inputPerMTok).toBeCloseTo(2, 10);
  });

  it("uses the model's OWN cache rates rather than the Anthropic multipliers", async () => {
    await warmCatalogWith([
      {
        id: "a/cached",
        type: "language",
        pricing: {
          input: "0.000001", // $1/MTok
          output: "0.000005",
          input_cache_read: "0.0000005", // $0.50/MTok — 0.5x, NOT the 0.1x default
          input_cache_write: "0.000002", // $2/MTok — 2x, NOT the 1.25x default
        },
      },
    ]);

    const cost = estimateCostUsd("a/cached", {
      promptTokens: 2_000,
      completionTokens: 0,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 1_000,
    });
    // fresh input clamps to 0; 1000 * $0.50/MTok + 1000 * $2/MTok.
    expect(cost).toBeCloseTo((1_000 * 0.5 + 1_000 * 2) / 1_000_000, 12);
    // The multiplier-derived answer would have been materially cheaper.
    expect(cost).toBeGreaterThan((1_000 * 0.1 + 1_000 * 1.25) / 1_000_000);
  });

  it("falls back to the multipliers when the catalog omits cache rates", async () => {
    await warmCatalogWith([
      { id: "a/nocache", type: "language", pricing: { input: "0.000001", output: "0.000005" } },
    ]);
    const rate = resolveRate("a/nocache");
    expect(rate?.source).toBe("catalog");
    expect(rate?.cacheReadPerMTok).toBeNull();

    const cost = estimateCostUsd("a/nocache", {
      promptTokens: 1_000,
      completionTokens: 0,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo((1_000 * 1 * 0.1) / 1_000_000, 12);
  });

  it("treats a half-priced or zero-priced entry as unpriced, not as free", async () => {
    // A confident $0.00 is worse than "—": it reads as real spend data.
    await warmCatalogWith([
      { id: "a/half", type: "language", pricing: { input: "0.000001" } },
      { id: "a/zero", type: "language", pricing: { input: "0", output: "0" } },
    ]);
    expect(resolveRate("a/half")).toBeNull();
    expect(resolveRate("a/zero")).toBeNull();
  });

  it("keeps the static family fallback when the catalog is cold", () => {
    const rate = resolveRate("anthropic/claude-opus-4.8");
    expect(rate?.source).toBe("family");
    expect(rate?.inputPerMTok).toBe(15);
  });

  it("does not price off the bundled fallback catalog", async () => {
    // The fallback carries no pricing on purpose — the live catalog is
    // authoritative for cost, and bundled numbers would go stale silently.
    globalThis.fetch = (async () =>
      new Response("upstream broken", { status: 503 })) as unknown as typeof globalThis.fetch;
    const res = await getGatewayCatalog();
    expect(res.fallback).toBe(true);
    expect(resolveRate("anthropic/claude-opus-4.8")?.source).toBe("family");
  });
});
