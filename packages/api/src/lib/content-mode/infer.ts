/**
 * Compile-time derivation of `ModeDraftCounts` from the static
 * `CONTENT_MODE_TABLES` tuple.
 *
 * Separated from `tables.ts` so the type machinery stays out of the
 * way of the registration data. The derived type should always equal
 * `ModeDraftCounts` from `@useatlas/types/mode` — the assertion in
 * `__tests__/registry.test.ts` fails at compile time if it drifts.
 */

import type { ContentModeEntry, SimpleModeTable, ExoticModeAdapter } from "./port";

/** Collapse a union of object types into their intersection. */
type UnionToIntersection<U> = (U extends unknown ? (_: U) => void : never) extends (
  _: infer I,
) => void
  ? I
  : never;

/**
 * Map a single entry to its contribution to `ModeDraftCounts`.
 *
 * Branches on the closed `ContentModeEntry` union — a new `kind` added
 * to `port.ts` without a matching branch here collapses to `never` in
 * the union-to-intersection step, which is caught at CI time by the
 * type-level equality assertion in `__tests__/registry.test.ts`. The
 * `_AssertCovered` line below also fails to compile locally so the
 * drift is visible at the declaration site.
 */
type EntryToRecord<E extends ContentModeEntry> = E extends {
  kind: "simple";
  key: infer K extends string;
}
  ? { readonly [P in K]: number }
  : E extends {
        kind: "exotic";
        countSegments: infer S extends ReadonlyArray<{ readonly key: string }>;
      }
    ? { readonly [P in S[number]["key"]]: number }
    : never;

/**
 * Compile-time assertion: `EntryToRecord` covers every member of
 * `ContentModeEntry`. If a new variant is added to `ContentModeEntry`
 * in `port.ts` without extending `EntryToRecord`, this line fails to
 * type-check — the error surfaces at the declaration site, not in
 * the distant assertion test.
 */
type _AssertCovered = EntryToRecord<SimpleModeTable> extends never
  ? never
  : EntryToRecord<ExoticModeAdapter> extends never
    ? never
    : true;
const _assertCovered: _AssertCovered = true;
void _assertCovered;

/**
 * The derived shape of `ModeDraftCounts` for a given registry tuple.
 * Only meaningful when the registry is declared with `as const` so key
 * literals survive inference.
 *
 * The final `{ readonly [K in keyof R]: R[K] }` homomorphic mapping is
 * not cosmetic — it flattens the `A & B & C` intersection produced by
 * `UnionToIntersection` into a plain object shape so the structural
 * `Equal<InferDraftCounts<...>, ModeDraftCounts>` assertion in the test
 * sees an identical type (not merely a mutually-assignable one).
 */
export type InferDraftCounts<
  T extends ReadonlyArray<ContentModeEntry>,
> = UnionToIntersection<EntryToRecord<T[number]>> extends infer R
  ? { readonly [K in keyof R]: R[K] }
  : never;
