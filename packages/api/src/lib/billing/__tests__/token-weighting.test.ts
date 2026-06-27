import { describe, it, expect } from "bun:test";
import {
  resolveModelWeight,
  toOutputEquivalentTokens,
  MODEL_WEIGHTS,
  DEFAULT_WEIGHT,
  REFERENCE_MODEL_FAMILY,
  INPUT_WEIGHT,
  type WeightedModelFamily,
} from "@atlas/api/lib/billing/token-weighting";

describe("token-weighting: invariants", () => {
  it("the reference family weighs exactly 1.0", () => {
    expect(MODEL_WEIGHTS[REFERENCE_MODEL_FAMILY]).toBe(1.0);
  });

  it("the unknown-model default equals the reference weight (never free, never punitive)", () => {
    expect(DEFAULT_WEIGHT).toBe(MODEL_WEIGHTS[REFERENCE_MODEL_FAMILY]);
    expect(DEFAULT_WEIGHT).toBe(1.0);
  });
});

describe("resolveModelWeight", () => {
  // [modelId, expectedFamily, expectedWeight, known]
  const cases: ReadonlyArray<
    [string | null | undefined, WeightedModelFamily | null, number, boolean]
  > = [
    ["anthropic/claude-haiku-4.5", "haiku", MODEL_WEIGHTS.haiku, true],
    ["anthropic/claude-sonnet-4.6", "sonnet", MODEL_WEIGHTS.sonnet, true],
    ["anthropic/claude-opus-4.8", "opus", MODEL_WEIGHTS.opus, true],
    // Direct / versioned ids (no gateway prefix).
    ["claude-haiku-4-5-20251001", "haiku", MODEL_WEIGHTS.haiku, true],
    ["claude-opus-4-8-20251101", "opus", MODEL_WEIGHTS.opus, true],
    // Case-insensitive.
    ["Anthropic/Claude-SONNET", "sonnet", MODEL_WEIGHTS.sonnet, true],
    // Unknown / empty → default weight, known:false, family:null.
    ["gpt-4o", null, DEFAULT_WEIGHT, false],
    ["mistral-large", null, DEFAULT_WEIGHT, false],
    ["", null, DEFAULT_WEIGHT, false],
    [null, null, DEFAULT_WEIGHT, false],
    [undefined, null, DEFAULT_WEIGHT, false],
  ];

  it.each(cases)(
    "resolves %p → family %p, weight %p, known %p",
    (model, family, weight, known) => {
      const r = resolveModelWeight(model);
      expect(r.family).toBe(family);
      expect(r.weight).toBe(weight);
      expect(r.known).toBe(known);
    },
  );
});

describe("toOutputEquivalentTokens", () => {
  // [model, inputTokens, outputTokens, expectedOutputEquivalent]
  const cases: ReadonlyArray<[string | null | undefined, number, number, number]> = [
    // Reference model (sonnet, weight 1.0): output passes through 1:1, input at
    // INPUT_WEIGHT (1/5). 1000 in + 1000 out = round(1000*0.2 + 1000) = 1200.
    ["anthropic/claude-sonnet-4.6", 1000, 1000, 1200],
    // Pure output on the reference model passes through unchanged.
    ["anthropic/claude-sonnet-4.6", 0, 1000, 1000],
    // Pure input on the reference model is discounted to INPUT_WEIGHT.
    ["anthropic/claude-sonnet-4.6", 1000, 0, 200],
    // Haiku weighs LESS than the reference: same tokens → fewer equivalents.
    // round((0*0.2 + 1000) * 1/3) = round(333.33) = 333.
    ["anthropic/claude-haiku-4.5", 0, 1000, 333],
    // Opus weighs MORE: round((0*0.2 + 1000) * 5) = 5000.
    ["anthropic/claude-opus-4.8", 0, 1000, 5000],
    // Unknown model uses the default (reference) weight: same as sonnet.
    ["gpt-4o", 1000, 1000, 1200],
    ["mistral-large", 0, 1000, 1000],
    [null, 0, 1000, 1000],
    // Zero tokens → 0.
    ["anthropic/claude-opus-4.8", 0, 0, 0],
    // Large counts don't overflow / stay integer.
    ["anthropic/claude-sonnet-4.6", 10_000_000, 10_000_000, 12_000_000],
    // Negative inputs clamp to 0 (defensive).
    ["anthropic/claude-sonnet-4.6", -500, -500, 0],
    ["anthropic/claude-sonnet-4.6", -500, 1000, 1000],
  ];

  it.each(cases)(
    "model %p, in %p, out %p → %p output-equivalent tokens",
    (model, input, output, expected) => {
      expect(
        toOutputEquivalentTokens({ inputTokens: input, outputTokens: output }, model),
      ).toBe(expected);
    },
  );

  it("always returns a non-negative finite integer", () => {
    for (const model of ["anthropic/claude-opus-4.8", "unknown", null]) {
      for (const [i, o] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [123_456, 789_012],
        [-1, -1],
      ] as const) {
        const v = toOutputEquivalentTokens({ inputTokens: i, outputTokens: o }, model);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("opus weighs strictly more than haiku for identical raw tokens", () => {
    const counts = { inputTokens: 5000, outputTokens: 5000 };
    const haiku = toOutputEquivalentTokens(counts, "anthropic/claude-haiku-4.5");
    const sonnet = toOutputEquivalentTokens(counts, "anthropic/claude-sonnet-4.6");
    const opus = toOutputEquivalentTokens(counts, "anthropic/claude-opus-4.8");
    expect(haiku).toBeLessThan(sonnet);
    expect(sonnet).toBeLessThan(opus);
  });

  it("INPUT_WEIGHT discounts input relative to output on the reference model", () => {
    const pureOutput = toOutputEquivalentTokens(
      { inputTokens: 0, outputTokens: 1000 },
      "anthropic/claude-sonnet-4.6",
    );
    const pureInput = toOutputEquivalentTokens(
      { inputTokens: 1000, outputTokens: 0 },
      "anthropic/claude-sonnet-4.6",
    );
    expect(pureInput).toBe(Math.round(pureOutput * INPUT_WEIGHT));
  });
});
