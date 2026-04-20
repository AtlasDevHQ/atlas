/**
 * Branded numeric types for percentage / ratio scales (#1685).
 *
 * Before this module, `errorRatePct` appeared in two incompatible
 * conventions across the codebase:
 *
 *   - Abuse engine: `AbuseCounters.errorRatePct` on 0–100 basis, but
 *     `AbuseThresholdConfig.errorRateThreshold` on 0–1 ratio basis.
 *   - SLA surfaces: `WorkspaceSLASummary.errorRatePct` and
 *     `SLAThresholds.errorRatePct` on 0–100 basis.
 *
 * `number` is structurally identical in all four positions, so a caller
 * that forgot to divide by 100 produced a latent boundary bug. PR #1681
 * nearly shipped exactly that regression — rounding the 0–100 percentage
 * to 1 decimal silently flipped `errorRatePct / 100 > 0.5` off at 50.04%
 * while the engine's own `checkThresholds` kept escalating.
 *
 * `Percentage` and `Ratio` are nominally branded via `unique symbol`. The
 * brands are zero-runtime as types (phantom types; the emitted JS is pure
 * `number`); the constructors below add a small one-time validation pass at
 * mint time. Only the `asPercentage`, `asRatio`, `percentageToRatio`, and
 * `ratioToPercentage` constructors may mint branded values — ordinary
 * `number` expressions do not satisfy the brands.
 *
 * What the brand *does* catch: assignment mixups. A plain `number` cannot
 * flow into a `Percentage`-typed slot, a `Percentage` cannot flow into a
 * `Ratio`-typed slot, and function arguments typed as `Ratio` reject raw
 * numbers. Together with the `asPercentage` / `asRatio` boundary casts,
 * this forces every numeric scale in the system to be declared at
 * construction — the `errorRatePct / 100 > threshold` footgun (where both
 * sides are raw `number`) is prevented by making `counters.errorRatePct`
 * non-assignable to the bare-number comparison chain.
 *
 * What the brand does *not* catch: TypeScript permits `<` / `>` / `===`
 * between any two number-subtype operands, so `p > r` still compiles.
 * Defense is upstream: the branded operands can only be produced via the
 * constructors, and they require explicit conversion (`percentageToRatio`
 * / `ratioToPercentage`) at any site that mixes scales. The
 * `@ts-expect-error` suite in `percentage.test.ts` pins exactly what the
 * brand enforces (assignment) and what it does not (comparison).
 */

declare const percentageBrand: unique symbol;
declare const ratioBrand: unique symbol;

/**
 * A number on the 0–100 scale (e.g., `errorRatePct: 50` = 50%). Output of
 * the `errorRatePct()` arithmetic helper and the `AbuseCounters` /
 * `WorkspaceSLASummary` wire fields.
 */
export type Percentage = number & { readonly [percentageBrand]: never };

/**
 * A number on the 0–1 scale (e.g., `errorRateThreshold: 0.5` = 50%).
 * Abuse engine thresholds are authored in config / env vars as ratios
 * because the engine's internal escalation math is fractional. The wire
 * type surfaces the ratio unchanged so `atlas.config.ts` edits do not
 * need a conversion step.
 */
export type Ratio = number & { readonly [ratioBrand]: never };

// A small tolerance above the scale ceiling swallows IEEE-754 slop from
// SQL aggregates (e.g. `ROUND(failed::float / total * 100, 2)` can overshoot
// by a few ULPs) without permitting a genuine scale mixup like `1.5 → 150`.
const PCT_TOLERANCE = 0.001;
const RATIO_TOLERANCE = 0.00001;

/**
 * Brand a raw number as a `Percentage` without performing a conversion.
 *
 * The caller is asserting the input is already on the 0–100 scale.
 * Typical use: wrapping an SQL aggregate (`ROUND(failed/total*100, 2)`),
 * a DB-stored percentage column, a Zod-parsed wire value, or an operator-
 * entered form field.
 *
 * Throws on non-finite input (NaN, Infinity) and on values outside
 * `[0 - tolerance, 100 + tolerance]` — ruling out the silent "brand
 * nonsense into existence" path that no-op casts would leave open. The
 * tolerance permits SQL rounding overshoot; values like `150` or `-50`
 * that signal a genuine scale mixup fail loudly at the cast site, not at
 * the admin-panel comparison three modules downstream.
 */
export function asPercentage(n: number): Percentage {
  if (!Number.isFinite(n)) {
    throw new Error(`asPercentage: non-finite input (${n})`);
  }
  if (n < -PCT_TOLERANCE || n > 100 + PCT_TOLERANCE) {
    throw new Error(`asPercentage: out of range (${n}); expected 0..100`);
  }
  return n as Percentage;
}

/**
 * Brand a raw number as a `Ratio` without performing a conversion.
 *
 * The caller is asserting the input is already on the 0–1 scale.
 * Typical use: wrapping config / env-var values authored as fractions.
 *
 * Throws on non-finite input and on values outside `[0 - ε, 1 + ε]`. Same
 * rationale as `asPercentage`: the cast is where scale mixups should
 * surface, not where they quietly propagate.
 */
export function asRatio(n: number): Ratio {
  if (!Number.isFinite(n)) {
    throw new Error(`asRatio: non-finite input (${n})`);
  }
  if (n < -RATIO_TOLERANCE || n > 1 + RATIO_TOLERANCE) {
    throw new Error(`asRatio: out of range (${n}); expected 0..1`);
  }
  return n as Ratio;
}

/** Convert `50` (as Percentage) → `0.5` (as Ratio). */
export function percentageToRatio(p: Percentage): Ratio {
  return (p / 100) as Ratio;
}

/** Convert `0.5` (as Ratio) → `50` (as Percentage). */
export function ratioToPercentage(r: Ratio): Percentage {
  return (r * 100) as Percentage;
}
