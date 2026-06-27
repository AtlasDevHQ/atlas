/**
 * Gateway at-cost capture — per-turn provider cost from the Vercel AI Gateway
 * (#4036, Structure B WS2).
 *
 * Atlas resolves models through the Vercel AI Gateway, which is zero-markup and
 * returns the ACTUAL charged cost per generation inline as
 * `providerMetadata.gateway.cost` (a USD decimal). The Structure B billing model
 * draws the included usage credit and the overage meter against the SUM of this
 * real dollar cost, so each agent turn records its gateway cost alongside its
 * token usage.
 *
 * ## Why sum across steps
 *
 * A turn is multi-step (the agent loops tool calls). In the AI SDK the
 * **top-level** `onFinish` `providerMetadata` reflects the FINAL step only, so
 * the turn's true cost is the sum of each step's `providerMetadata.gateway.cost`.
 * {@link sumStepGatewayCostUsd} does exactly that, defensively.
 *
 * ## NULL vs 0
 *
 * The capture distinguishes "no gateway cost was recorded for this turn" (NULL —
 * a non-gateway / BYOK-direct provider, where the gateway never annotated a cost)
 * from "the recorded cost was zero" (0 — e.g. a fully-cached/free generation).
 * {@link sumStepGatewayCostUsd} returns `null` only when NO step carried a
 * parseable cost, and a number (possibly 0) otherwise — mirroring the nullable
 * `gateway_cost_usd` column semantics (migration 0155).
 */

/**
 * Coerce a raw gateway cost value to a non-negative USD number, or `null` when
 * it's absent / unparseable. The gateway returns the cost as a decimal STRING;
 * a numeric form is tolerated defensively. Negative or non-finite values are
 * rejected as `null` (never a negative cost) so a malformed annotation can't
 * credit usage back.
 */
export function parseGatewayCostUsd(raw: unknown): number | null {
  if (raw == null) return null;
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    // An empty / whitespace-only string is "not recorded", NOT zero — guard it
    // before `Number("")` coerces it to 0 (which would mark a turn as a recorded
    // $0 spend rather than a non-gateway no-op).
    if (raw.trim() === "") return null;
    n = Number(raw);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** A turn step, narrowed to the provider-metadata shape this module reads. */
export interface StepProviderMetadata {
  readonly providerMetadata?: Record<string, Record<string, unknown> | undefined> | null;
}

/**
 * Sum the per-step Vercel AI Gateway cost over a turn's steps, in USD.
 *
 * Returns `null` when the steps array is empty/absent OR no step carried a
 * parseable `providerMetadata.gateway.cost` (→ write NULL: "no gateway cost
 * recorded", e.g. a non-gateway provider). Returns a non-negative number
 * (possibly 0) when at least one step carried a cost. Pure and total — never
 * throws, never returns NaN/negative.
 */
export function sumStepGatewayCostUsd(
  steps: ReadonlyArray<StepProviderMetadata> | null | undefined,
): number | null {
  if (!steps || steps.length === 0) return null;
  let total = 0;
  let recorded = false;
  for (const step of steps) {
    const cost = parseGatewayCostUsd(step?.providerMetadata?.gateway?.cost);
    if (cost !== null) {
      total += cost;
      recorded = true;
    }
  }
  return recorded ? total : null;
}
