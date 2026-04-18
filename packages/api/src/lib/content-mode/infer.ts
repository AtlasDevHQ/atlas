/**
 * Compile-time derivation of `ModeDraftCounts` from the static
 * `CONTENT_MODE_TABLES` tuple.
 *
 * Separated from `tables.ts` so the type machinery stays out of the
 * way of the registration data. The derived type should always equal
 * `ModeDraftCounts` from `@useatlas/types/mode` — the assertion in
 * `__tests__/registry.test.ts` fails at compile time if it drifts.
 */

import type { ContentModeEntry } from "./port";

/** Collapse a union of object types into their intersection. */
type UnionToIntersection<U> = (U extends unknown ? (_: U) => void : never) extends (
  _: infer I,
) => void
  ? I
  : never;

/** Map a single entry to its contribution to `ModeDraftCounts`. */
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
 * The derived shape of `ModeDraftCounts` for a given registry tuple.
 * Only meaningful when the registry is declared with `as const` so key
 * literals survive inference.
 */
export type InferDraftCounts<
  T extends ReadonlyArray<ContentModeEntry>,
> = UnionToIntersection<EntryToRecord<T[number]>> extends infer R
  ? { readonly [K in keyof R]: R[K] }
  : never;
