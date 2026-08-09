/**
 * Compile-time assertions that have no runtime.
 *
 * These exist because the two failure modes they catch are both silent at build
 * time and loud in production: an engine type and its `@useatlas/types` wire
 * twin drifting apart, with only a runtime `z.strictObject` between them.
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
 * Both verified, and both matter only because a `z.strictObject` on the wire is
 * stricter than this pin:
 *
 * - **Optionality.** `{ a: string }` and `{ a: string; b?: string }` are mutually
 *   assignable, so a `?:` added to either side passes here and is still refused
 *   at runtime. Prefer required fields on wire types; that is the house style
 *   anyway.
 * - **`readonly`.** Mutual assignability ignores the modifier, so a wire field
 *   losing `readonly` is invisible to this.
 *
 * Anything required and non-optional — added, removed, renamed, or retyped,
 * including a nested union narrowing — does fail, in both directions.
 */
export type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
