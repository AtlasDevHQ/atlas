import { describe, it, expect } from "bun:test";
import {
  estimateCostUsd,
  resolveModelFamily,
} from "@atlas/api/lib/token-pricing";

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
