/**
 * `exactOptionalPropertyTypes` adapter for this package's `satisfies
 * z.ZodType<T>` pattern (#4955).
 *
 * Zod's `.optional()` infers `p?: T | undefined` — the parsed value may carry
 * the key present-with-`undefined`, and Zod's types say so. Under
 * `exactOptionalPropertyTypes` that is no longer the same type as the exact
 * `p?: T` our domain interfaces in `@useatlas/types` declare, so every
 * `satisfies` against an interface with an optional property fails.
 *
 * The fix is at the `satisfies` target, never at the domain interface:
 * `WithLooseOptionals<T>` widens ONLY the optional properties, deeply, by
 * `| undefined` — exactly the widening Zod's inference carries. Required
 * properties stay exact, so everything the `satisfies` exists to catch (a
 * renamed field, a missing field, a wrong type on a required field) still
 * breaks at compile time. Do NOT widen the interfaces themselves: constructing
 * a domain value with an explicit `undefined` in an optional slot must remain
 * a compile error for every consumer — that is the bug class the flag exists
 * to reject.
 */
export type WithLooseOptionals<T> = unknown extends T
  ? T
  : T extends string | number | boolean | bigint | symbol | null | undefined
    ? T
    : T extends (...args: never[]) => unknown
    ? T
    : T extends readonly unknown[]
      ? { [K in keyof T]: WithLooseOptionals<T[K]> }
      : {
          [K in keyof T]: Record<never, never> extends Pick<T, K>
            ? WithLooseOptionals<T[K]> | undefined
            : WithLooseOptionals<T[K]>;
        };
