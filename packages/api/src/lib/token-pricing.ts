/**
 * Approximate per-token cost estimation (#3931).
 *
 * Powers the "estimated $" figure on the /platform/demo tracking page. This is
 * a RELATIVE cost SIGNAL for operators eyeballing demo spend — NOT a billing
 * source of truth; `usage_events.gateway_cost_usd` is the exact at-cost dollar
 * figure billing denominates on. A model with no known rate returns `null` (the
 * UI renders "—") rather than a misleading $0.
 *
 * Cost model — `token_usage.prompt_tokens` is the AI-SDK `inputTokens` (the
 * input-token total), which INCLUDES the cache_read + cache_write split
 * (verified: inputTokens 100 = noCacheTokens 90 + cacheReadTokens 7 +
 * cacheWriteTokens 3). So the fresh (uncached) input is
 * `prompt_tokens − cache_read − cache_write`, priced at the base input rate;
 * cache reads/writes are priced with Anthropic's standard 5-minute prompt-cache
 * multipliers (read ≈ 0.1×, write ≈ 1.25× of base input). Pricing the four
 * buckets independently avoids double-counting the cached portion of the input.
 *
 * Rate resolution is two-tier (#4869 follow-up): the LIVE gateway catalog first
 * (real per-model rates, incl. the cache read/write split where published),
 * then the static Anthropic family table as the offline fallback. Before that,
 * this module knew three families and returned `null` for everything else — so
 * the operator spend page went blank the moment a workspace ran a non-Anthropic
 * model, which is exactly the set the model picker now exposes.
 *
 * The catalog tier reads from memory and does NOT fetch — see {@link resolveRate}
 * for why this stays sync and who is responsible for priming it (#4872).
 */

import { peekModelPricing, type UsdPerMTok } from "@atlas/api/lib/gateway-catalog";

export interface TokenCounts {
  /** Total input tokens (AI-SDK `inputTokens`, inclusive of the cache split). */
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

interface ModelRate {
  /** USD per million fresh (uncached) input tokens. */
  readonly inputPerMTok: UsdPerMTok;
  /** USD per million output tokens. */
  readonly outputPerMTok: UsdPerMTok;
}

/**
 * Anthropic prompt-cache multipliers relative to the base input rate. A cache
 * HIT is read at ~10% of base; writing the 5-minute cache costs ~125% of base.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Base rates keyed by model family — the OFFLINE fallback, used only when the
 * live catalog hasn't been fetched yet or doesn't carry the model.
 *
 * Refreshed against the live gateway catalog 2026-07-28 (#4869 review). They
 * had drifted badly: `opus` was $15/$75 when every current Opus (4.5 through
 * 5) is $5/$25 — a 3x over-report — and `sonnet` was $3/$15 against Sonnet 5's
 * $2/$10. Because this is a per-FAMILY table it cannot track per-version
 * pricing, so these now sit on the CURRENT flagship of each family and will
 * drift again; the live catalog is what keeps the estimate honest, and this is
 * only the cold-start floor.
 */
const FAMILY_RATES = {
  // Literals are already per-MTok, so the brand is asserted rather than
  // derived — the `satisfies` below keeps the shape honest.
  haiku: { inputPerMTok: 1 as UsdPerMTok, outputPerMTok: 5 as UsdPerMTok },
  sonnet: { inputPerMTok: 2 as UsdPerMTok, outputPerMTok: 10 as UsdPerMTok },
  opus: { inputPerMTok: 5 as UsdPerMTok, outputPerMTok: 25 as UsdPerMTok },
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

/** Rates for a turn, plus where they came from (for observability/tests). */
export interface ResolvedRate {
  readonly inputPerMTok: UsdPerMTok;
  readonly outputPerMTok: UsdPerMTok;
  /** Explicit cache-read rate; `null` ⇒ derive from input via the multiplier. */
  readonly cacheReadPerMTok: UsdPerMTok | null;
  /** Explicit cache-write rate; `null` ⇒ derive from input via the multiplier. */
  readonly cacheWritePerMTok: UsdPerMTok | null;
  readonly source: "catalog" | "family";
}

/**
 * Resolve rates for a model: the live gateway catalog first, the static
 * Anthropic family table second, `null` when neither knows it.
 *
 * The catalog tier (#4869 follow-up) is what makes this estimator honest for
 * the models the picker now exposes. The family table only knows haiku/sonnet/
 * opus, so a workspace on GLM, Kimi or Grok rendered "—" for every figure on
 * the operator spend page — the numbers didn't exist rather than being wrong,
 * but a blank dashboard is its own failure. The catalog publishes real
 * per-token rates for ~300 models, including the cache read/write split for
 * most of them, so those turns can be priced from live data instead of from
 * prices hardcoded here and fixed by redeploy.
 *
 * Order matters: catalog wins even for Anthropic models, because it tracks
 * price changes and the static table does not.
 *
 * SYNC on purpose (#4872). This runs per ROW inside `foldUsage`'s loop, so the
 * catalog is fetched by ONE awaited `primeGatewayCatalog(models)` in the
 * `/platform/demo` route handlers before the fold, and read from memory here.
 * It replaced a fire-and-forget `warmGatewayCatalog()` call that used to sit on
 * this line: correct, but authoritative only from the SECOND page load, and
 * split across two call sites in a way that let a tier reordering strand it
 * (#4869 review — an earlier iteration had the warm inside the `!family` branch
 * below, which `resolveModelFamily`'s haiku/sonnet/opus substring match made
 * unreachable for every Anthropic gateway id).
 *
 * A forgotten prime never yields a confidently-wrong number, but it does NOT
 * degrade uniformly — the two halves land in different places:
 *  - Anthropic ids fall to `FAMILY_RATES`; the rollup flags `costEstimated`,
 *    and the spend page explains the figure came from the offline table.
 *  - Everything else (GLM, Kimi, Grok, DeepSeek — the models #4869 added the
 *    catalog tier FOR) returns `null` here, so those rows drop out of the total
 *    and `costComplete` goes false. On an all-non-Anthropic workspace
 *    `estimatedCostUsd` is null, and BOTH banners are gated on it being
 *    non-null, so the page renders a bare "—+" with no explanation at all.
 */
export function resolveRate(model: string | null | undefined): ResolvedRate | null {
  const fromCatalog = peekModelPricing(model ?? undefined);
  if (fromCatalog) {
    return {
      inputPerMTok: fromCatalog.inputPerMTok,
      outputPerMTok: fromCatalog.outputPerMTok,
      cacheReadPerMTok: fromCatalog.cacheReadPerMTok,
      cacheWritePerMTok: fromCatalog.cacheWritePerMTok,
      source: "catalog",
    };
  }

  const family = resolveModelFamily(model);
  if (!family) return null;
  const rate = FAMILY_RATES[family];
  return {
    inputPerMTok: rate.inputPerMTok,
    outputPerMTok: rate.outputPerMTok,
    // The static table has never carried explicit cache rates — the Anthropic
    // multipliers below stand in, as they always have for this tier.
    cacheReadPerMTok: null,
    cacheWritePerMTok: null,
    source: "family",
  };
}

/**
 * Estimate the USD cost of a turn (or an aggregate bucket) from its token
 * counts. Returns `null` when no rate is known for the model, so callers can
 * distinguish "no price known" from "$0 spent". Negative inputs are clamped to 0.
 */
export function estimateCostUsd(
  model: string | null | undefined,
  counts: TokenCounts,
): number | null {
  const rate = resolveRate(model);
  if (!rate) return null;

  const cacheRead = Math.max(0, counts.cacheReadTokens);
  const cacheWrite = Math.max(0, counts.cacheWriteTokens);
  // Fresh (uncached) input = total input minus the cache split. Clamp so a
  // provider that reports cache tokens exceeding the total can't go negative.
  const freshInput = Math.max(0, counts.promptTokens - cacheRead - cacheWrite);
  const completion = Math.max(0, counts.completionTokens);

  // Prefer the model's OWN published cache rates. When the catalog doesn't
  // publish them, the fallback depends on where the base rate came from
  // (#4869 review):
  //
  //  - `family` (the Anthropic-only static table) — the Anthropic 0.1x/1.25x
  //    multipliers are correct for that family, so use them.
  //  - `catalog` — do NOT borrow Anthropic's shape. 62 of 204 live language
  //    models publish input+output but no cache-read rate, and the published
  //    ratios among those that DO declare one span 0.008x-0.52x. Applying 0.1x
  //    blindly under-reported by ~5x for `gpt-4-turbo` and `deepseek-r1`
  //    (whose siblings publish 0.5x), while reporting `source: "catalog"` with
  //    full confidence. The likeliest reason a model publishes no cache-read
  //    rate is that it gives no cache discount, so charge cache tokens at the
  //    FULL input rate: an over-report is the safe direction for a spend
  //    signal, and it can't silently make a bill look smaller than it is.
  const assumeNoDiscount = rate.source === "catalog";
  const cacheReadRate =
    rate.cacheReadPerMTok ??
    (assumeNoDiscount ? rate.inputPerMTok : rate.inputPerMTok * CACHE_READ_MULTIPLIER);
  const cacheWriteRate =
    rate.cacheWritePerMTok ??
    (assumeNoDiscount ? rate.inputPerMTok : rate.inputPerMTok * CACHE_WRITE_MULTIPLIER);

  const cost =
    (freshInput * rate.inputPerMTok +
      cacheRead * cacheReadRate +
      cacheWrite * cacheWriteRate +
      completion * rate.outputPerMTok) /
    TOKENS_PER_MILLION;

  return cost;
}
