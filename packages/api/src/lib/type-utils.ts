/**
 * Compile-time assertions that have no runtime.
 *
 * {@link Exact} exists because the failure it catches is silent at build time
 * and loud in production: an engine type and its `@useatlas/types` wire twin
 * drifting apart, with only a runtime `z.strictObject` between them.
 */

/**
 * `true` when `A` and `B` are the same type, `never` otherwise.
 *
 * Used as `const _pin: Exact<A, B> = true`, which fails to compile on mismatch
 * because `true` is not assignable to `never`. Both sides are tuple-wrapped so a
 * union compares as a whole rather than distributing member by member.
 *
 * ## ⚠️ What it does NOT compare
 *
 * Two narrow holes, and BOTH are narrower than they first look — measured with
 * `tsgo`, because an over-broad warning here is worse than none: a maintainer
 * told "`readonly` is invisible" who then hits a real build break concludes the
 * pin is broken rather than that the docs were.
 *
 * - **A NEWLY ADDED optional field.** `Exact<{a: string}, {a: string; b?: string}>`
 *   is `true`. Turning an EXISTING required field optional is caught
 *   (`Exact<{a: string}, {a?: string}>` is `never`), so only the additive case
 *   slips through — and it is refused at runtime by `z.strictObject` only if the
 *   engine actually populates it. Prefer required fields on wire types; that is
 *   the house style anyway.
 * - **A `readonly` PROPERTY MODIFIER.** `Exact<{readonly a: string}, {a: string}>`
 *   is `true`. This does NOT extend to readonly array and tuple TYPES, which are
 *   compared and do fail: `Exact<{a: readonly string[]}, {a: string[]}>` and the
 *   tuple equivalent are both `never`. That matters here because the pinned wire
 *   types are full of them — `pairs: readonly Pair[]`, `pair: readonly [string,
 *   string]`.
 *
 * Everything else — a required field added, removed, renamed or retyped,
 * including a nested union narrowing — fails, in both directions.
 */
export type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
