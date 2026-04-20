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
 * brands are zero-runtime (phantom types); the emitted JS is pure `number`.
 * Only the `asPercentage`, `asRatio`, `percentageToRatio`, and
 * `ratioToPercentage` constructors may mint branded values — ordinary
 * `number` expressions do not satisfy the brands.
 *
 * Conversion helpers are explicit by design. A caller writing
 * `percentageToRatio(counters.errorRatePct) > thresholds.errorRateThreshold`
 * has typechecked that both sides are `Ratio`. A caller who forgets the
 * conversion fails at compile time, not at runtime boundary rounding.
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

/**
 * Brand a raw number as a `Percentage` without performing a conversion.
 *
 * The caller is asserting the input is already on the 0–100 scale.
 * Typical use: wrapping an SQL aggregate that the query computed as a
 * percentage (e.g., `ROUND(failed::float / total * 100, 2)`).
 *
 * No runtime range check — branding is a compile-time concern; validation
 * at the wire boundary is the Zod schema's job.
 */
export function asPercentage(n: number): Percentage {
  return n as Percentage;
}

/**
 * Brand a raw number as a `Ratio` without performing a conversion.
 *
 * The caller is asserting the input is already on the 0–1 scale.
 * Typical use: wrapping config / env-var values authored as fractions.
 */
export function asRatio(n: number): Ratio {
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
