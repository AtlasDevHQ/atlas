/**
 * Approximate per-token cost estimation (#3931).
 *
 * Powers the "estimated $" figure on the /platform/demo tracking page. This is
 * a RELATIVE cost SIGNAL for operators eyeballing demo spend — NOT a billing
 * source of truth. The rates are approximate Anthropic list prices per million
 * tokens; gateway-routed pricing may differ, and an unknown model returns
 * `null` (the UI renders "—") rather than a misleading $0.
 *
 * Cost model — `token_usage.prompt_tokens` is the AI-SDK `inputTokens` (the
 * input-token total), which INCLUDES the cache_read + cache_write split
 * (verified: inputTokens 100 = noCacheTokens 90 + cacheReadTokens 7 +
 * cacheWriteTokens 3). So the fresh (uncached) input is
 * `prompt_tokens − cache_read − cache_write`, priced at the base input rate;
 * cache reads/writes are priced with Anthropic's standard 5-minute prompt-cache
 * multipliers (read ≈ 0.1×, write ≈ 1.25× of base input). Pricing the four
 * buckets independently avoids double-counting the cached portion of the input.
 */

export interface TokenCounts {
  /** Total input tokens (AI-SDK `inputTokens`, inclusive of the cache split). */
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

interface ModelRate {
  /** USD per million fresh (uncached) input tokens. */
  readonly inputPerMTok: number;
  /** USD per million output tokens. */
  readonly outputPerMTok: number;
}

/**
 * Anthropic prompt-cache multipliers relative to the base input rate. A cache
 * HIT is read at ~10% of base; writing the 5-minute cache costs ~125% of base.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Base rates keyed by model family. The demo path defaults to Haiku (the
 * cheapest tier); Sonnet/Opus are covered so an operator who points the demo at
 * a pricier model still gets a sane estimate. Keep these in the same ballpark
 * as Anthropic's published list pricing — they're an estimate, not a contract.
 */
const FAMILY_RATES = {
  haiku: { inputPerMTok: 1, outputPerMTok: 5 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  opus: { inputPerMTok: 15, outputPerMTok: 75 },
} satisfies Record<string, ModelRate>;

export type ModelFamily = keyof typeof FAMILY_RATES;

/**
 * Map a model id (gateway `anthropic/claude-haiku-4.5` or a direct
 * `claude-haiku-4-5`) to a known pricing family, or `null` when unrecognized.
 * Substring match keeps it robust to the gateway prefix and version suffixes.
 */
export function resolveModelFamily(model: string | null | undefined): ModelFamily | null {
  if (!model) return null;
  const id = model.toLowerCase();
  if (id.includes("haiku")) return "haiku";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("opus")) return "opus";
  return null;
}

/**
 * Estimate the USD cost of a turn (or an aggregate bucket) from its token
 * counts. Returns `null` for an unknown model so callers can distinguish "no
 * price known" from "$0 spent". Negative inputs are clamped to 0.
 */
export function estimateCostUsd(
  model: string | null | undefined,
  counts: TokenCounts,
): number | null {
  const family = resolveModelFamily(model);
  if (!family) return null;
  const rate = FAMILY_RATES[family];

  const cacheRead = Math.max(0, counts.cacheReadTokens);
  const cacheWrite = Math.max(0, counts.cacheWriteTokens);
  // Fresh (uncached) input = total input minus the cache split. Clamp so a
  // provider that reports cache tokens exceeding the total can't go negative.
  const freshInput = Math.max(0, counts.promptTokens - cacheRead - cacheWrite);
  const completion = Math.max(0, counts.completionTokens);

  const cost =
    (freshInput * rate.inputPerMTok +
      cacheRead * rate.inputPerMTok * CACHE_READ_MULTIPLIER +
      cacheWrite * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER +
      completion * rate.outputPerMTok) /
    TOKENS_PER_MILLION;

  return cost;
}
