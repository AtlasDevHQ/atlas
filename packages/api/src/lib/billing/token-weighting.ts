/**
 * TokenWeighting — output-equivalent token accounting (#3989, WS2).
 *
 * A pure module that normalizes a turn's raw input/output tokens to
 * "output-equivalent tokens" via a per-model weight table. This is what makes
 * the advertised "model-aware budget" framing literally true: a turn on a more
 * capable (pricier) model consumes more of the budget per raw token than a turn
 * on a cheaper model, in proportion to how much more it costs to serve.
 *
 * ## The model
 *
 * Output tokens are the reference unit — they cost the most and are the natural
 * denominator for a usage-priced product. Each model is assigned a single
 * `weight` relative to a REFERENCE model (whose weight is exactly 1.0):
 *
 *   output_equivalent = round((inputTokens * INPUT_WEIGHT + outputTokens) * weight)
 *
 * `INPUT_WEIGHT` captures that an input token is cheaper than an output token
 * for the SAME model. We use a single ratio across the Anthropic family
 * (input ≈ 1/5 of output, matching the published 1:5 input:output list-price
 * ratio for Haiku/Sonnet/Opus), so a turn that is mostly cached/cheap input
 * doesn't denominate as if every input token were an output token.
 *
 * The per-model `weight` then scales the whole turn by how expensive that
 * model is relative to the reference. We anchor the reference at Sonnet
 * (weight 1.0) — the default workhorse model — so Haiku turns weigh LESS than
 * their raw count and Opus turns weigh MORE, exactly as they cost.
 *
 * ## Unknown models
 *
 * An unrecognized model id MUST NOT silently fall back to 0 (that would let a
 * BYO-model or a newly-added model consume budget for free) nor to an
 * arbitrarily punitive number. It falls back to {@link DEFAULT_WEIGHT} — the
 * reference weight of 1.0 — so an unknown model is denominated exactly like the
 * reference model: never free, never over-charged. The fallback is surfaced via
 * `resolveModelWeight(...).known === false` so callers can log/alert if they
 * care, without changing the math.
 *
 * ## Why a separate module from `../token-pricing.ts`
 *
 * `lib/token-pricing.ts` estimates *dollars* for an operator-facing demo signal and
 * returns `null` for unknown models (the UI renders "—"). This module computes
 * the *budget denominator* for billing enforcement, where "null" is not an
 * option — every turn must denominate to a concrete, non-negative integer.
 * They share the family-by-substring resolution idiom but answer different
 * questions, so they stay separate.
 */

/** Known model families for weighting. Resolved from a model id by substring. */
export type WeightedModelFamily = "haiku" | "sonnet" | "opus";

/**
 * The reference model family. Its weight is exactly 1.0 — every other family's
 * weight is expressed relative to it, and an unknown model denominates as if it
 * were this family (see {@link DEFAULT_WEIGHT}).
 */
export const REFERENCE_MODEL_FAMILY: WeightedModelFamily = "sonnet";

/**
 * Per-family weight relative to the reference (Sonnet = 1.0). These mirror the
 * published Anthropic list-price ratios: Haiku is ~1/3 the cost of Sonnet and
 * Opus is ~5× — so Haiku turns weigh less than their raw token count and Opus
 * turns weigh more, making the budget genuinely model-aware.
 *
 * Same source of truth ballpark as `lib/token-pricing.ts`'s `FAMILY_RATES`
 * (haiku 1/5, sonnet 3/15, opus 15/75 input/output per MTok) — the weight is
 * the output-rate ratio: haiku 5/15 ≈ 0.33, sonnet 15/15 = 1.0, opus 75/15 = 5.
 */
export const MODEL_WEIGHTS = {
  haiku: 1 / 3,
  sonnet: 1.0,
  opus: 5.0,
} satisfies Record<WeightedModelFamily, number>;

/**
 * Weight applied to an unrecognized model. Equal to the reference weight (1.0):
 * an unknown model is never free (would be a budget bypass) and never punished
 * (would over-bill a legitimate new model) — it denominates exactly like the
 * reference model until it's added to {@link MODEL_WEIGHTS}.
 */
export const DEFAULT_WEIGHT = MODEL_WEIGHTS[REFERENCE_MODEL_FAMILY];

/**
 * How much one input token weighs relative to one output token, for the SAME
 * model. The published Anthropic list prices are a 1:5 input:output ratio
 * across Haiku/Sonnet/Opus, so an input token is worth 1/5 of an output token
 * before the per-model weight is applied.
 */
export const INPUT_WEIGHT = 1 / 5;

/** Raw token counts for a turn (or aggregate), as recorded at agent-step time. */
export interface RawTokenCounts {
  /** Total input tokens for the turn (AI-SDK `inputTokens`). */
  readonly inputTokens: number;
  /** Total output/completion tokens for the turn (AI-SDK `outputTokens`). */
  readonly outputTokens: number;
}

/** Result of resolving a model id to its weight. */
export interface ResolvedModelWeight {
  /** The numeric weight to scale the turn by. */
  readonly weight: number;
  /**
   * `true` when the model id matched a known family; `false` when it fell back
   * to {@link DEFAULT_WEIGHT}. Lets callers alert on unknown models without
   * changing the math.
   */
  readonly known: boolean;
  /** The resolved family, or `null` when unknown. */
  readonly family: WeightedModelFamily | null;
}

/**
 * Resolve a model id to its weight family. Substring match (case-insensitive)
 * so it's robust to the gateway prefix (`anthropic/claude-opus-4.8`) and the
 * direct/versioned form (`claude-opus-4-8-20251101`).
 *
 * An unknown or empty id resolves to {@link DEFAULT_WEIGHT} with
 * `known: false` — never throws, never returns 0.
 */
export function resolveModelWeight(
  model: string | null | undefined,
): ResolvedModelWeight {
  if (model) {
    const id = model.toLowerCase();
    // Order matters only for disjoint substrings; the three families never
    // co-occur in a single id, so any order is correct. Listed cheap→dear.
    if (id.includes("haiku")) return { weight: MODEL_WEIGHTS.haiku, known: true, family: "haiku" };
    if (id.includes("sonnet")) return { weight: MODEL_WEIGHTS.sonnet, known: true, family: "sonnet" };
    if (id.includes("opus")) return { weight: MODEL_WEIGHTS.opus, known: true, family: "opus" };
  }
  return { weight: DEFAULT_WEIGHT, known: false, family: null };
}

/**
 * Normalize a turn's raw input/output tokens to output-equivalent tokens for
 * the given model.
 *
 * Pure and total: negative inputs are clamped to 0, the result is a
 * non-negative integer (rounded), and an unknown model uses
 * {@link DEFAULT_WEIGHT} rather than throwing or returning 0.
 *
 *   output_equivalent = round((input * INPUT_WEIGHT + output) * weight)
 *
 * @param counts - The turn's raw `{ inputTokens, outputTokens }`.
 * @param model  - The model id the turn ran on; unknown ids use the default weight.
 */
export function toOutputEquivalentTokens(
  counts: RawTokenCounts,
  model: string | null | undefined,
): number {
  const input = Math.max(0, counts.inputTokens);
  const output = Math.max(0, counts.outputTokens);
  const { weight } = resolveModelWeight(model);
  const weighted = (input * INPUT_WEIGHT + output) * weight;
  // Round to a whole token — the budget denominates in integer tokens and the
  // `weighted_quantity` column is an integer. Clamp guards against a NaN/−0
  // sneaking through (Math.round(NaN) is NaN → coalesced to 0).
  const rounded = Math.round(weighted);
  return Number.isFinite(rounded) ? Math.max(0, rounded) : 0;
}
