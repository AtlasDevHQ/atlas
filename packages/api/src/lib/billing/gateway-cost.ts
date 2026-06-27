/**
 * Gateway at-cost capture — per-turn provider cost from the Vercel AI Gateway
 * (#4036, Structure B WS2).
 *
 * Atlas resolves models through the Vercel AI Gateway, which is zero-markup and
 * returns the ACTUAL charged cost per generation inline as
 * `providerMetadata.gateway.cost` (a USD decimal). This slice CAPTURES that cost
 * per turn (#4036); the Structure B credit + overage meter will draw against the
 * summed real dollars once the re-denomination lands (#4038/#4039). Until then
 * nothing enforces against it — it is recorded only.
 *
 * Float summation here (`total += cost`) is fine for the captured/displayed
 * value; the period rollup re-sums in Postgres `numeric` (exact) and the
 * exact-decimal handling for *enforcement* is the enforcement slice's concern.
 *
 * ## Why sum across steps
 *
 * A turn is multi-step (the agent loops tool calls). In the AI SDK the
 * **top-level** `onFinish` `providerMetadata` reflects the FINAL step only, so
 * the turn's true cost is the sum of each step's `providerMetadata.gateway.cost`.
 * {@link summarizeStepGatewayCostUsd} does exactly that, defensively.
 *
 * ## NULL vs 0, and present-but-unparseable
 *
 * The capture distinguishes "no gateway cost was recorded for this turn" (NULL —
 * a non-gateway / BYOK-direct provider, where the gateway never annotated a cost)
 * from "the recorded cost was zero" (0 — e.g. a fully-cached/free generation).
 * A THIRD case — a step whose cost is PRESENT but unparseable (a gateway
 * contract drift: renamed field, object shape, locale-formatted number, a
 * negative credit) — is dropped from the sum but COUNTED, so the caller can log
 * it rather than silently under-capturing. {@link summarizeStepGatewayCostUsd}
 * returns the total (`null` only when NO step carried a parseable cost — mirrors
 * the nullable `gateway_cost_usd` column, migration 0155) plus the skipped count.
 */

/**
 * Coerce a raw gateway cost value to a non-negative USD number, or `null` when
 * it's absent / unparseable. The gateway typically returns the cost as a decimal
 * string; a numeric form is tolerated defensively (the SDK types the value as
 * `unknown`). Negative or non-finite values are rejected as `null` (never a
 * negative cost) so a malformed annotation can't credit usage back.
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

/** Whether a raw cost value is PRESENT (not absent / empty-string) regardless of parseability. */
function isPresentCost(raw: unknown): boolean {
  if (raw == null) return false;
  if (typeof raw === "string" && raw.trim() === "") return false;
  return true;
}

/** Outcome of summing a turn's per-step gateway cost. */
export interface GatewayCostSummary {
  /**
   * Total at-cost USD for the turn — `null` only when NO step carried a
   * parseable cost (→ write NULL, "no gateway cost recorded"). A number
   * (possibly 0) when at least one step did.
   */
  readonly totalUsd: number | null;
  /** Steps that contributed a parseable cost to {@link totalUsd}. */
  readonly recordedSteps: number;
  /**
   * Steps whose `gateway.cost` was PRESENT but unparseable (NaN / object /
   * negative / non-finite) — dropped from the total but counted so the caller
   * can surface a gateway-contract-drift warning instead of silently
   * under-capturing. Should be 0 in normal operation.
   */
  readonly skippedSteps: number;
}

/**
 * Sum the per-step Vercel AI Gateway cost over a turn's steps, in USD, and
 * report how many present-but-unparseable steps were dropped.
 *
 * Pure and total — never throws, never returns NaN/negative. See the module doc
 * for the NULL-vs-0-vs-skipped semantics.
 */
export function summarizeStepGatewayCostUsd(
  steps: ReadonlyArray<StepProviderMetadata> | null | undefined,
): GatewayCostSummary {
  if (!steps || steps.length === 0) {
    return { totalUsd: null, recordedSteps: 0, skippedSteps: 0 };
  }
  let total = 0;
  let recordedSteps = 0;
  let skippedSteps = 0;
  for (const step of steps) {
    const raw = step?.providerMetadata?.gateway?.cost;
    const cost = parseGatewayCostUsd(raw);
    if (cost !== null) {
      total += cost;
      recordedSteps += 1;
    } else if (isPresentCost(raw)) {
      // Present but unparseable — a gateway contract drift. Drop it from the
      // total (never guess) but count it so the caller logs the under-capture.
      skippedSteps += 1;
    }
  }
  return { totalUsd: recordedSteps > 0 ? total : null, recordedSteps, skippedSteps };
}

/**
 * Convenience: the at-cost USD total for a turn, discarding the skipped-step
 * detail. `null` when no step carried a parseable cost. Prefer
 * {@link summarizeStepGatewayCostUsd} where the skipped count matters (the agent
 * write path logs it).
 */
export function sumStepGatewayCostUsd(
  steps: ReadonlyArray<StepProviderMetadata> | null | undefined,
): number | null {
  return summarizeStepGatewayCostUsd(steps).totalUsd;
}
