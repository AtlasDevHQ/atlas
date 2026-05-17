/**
 * Aggregator for EE-side `Layer.effect` implementations.
 *
 * `buildAppLayer()` in `@atlas/api/lib/effect/layers` lazy-imports this
 * module (the ONLY post-closeout `@atlas/ee` import permitted from core)
 * and merges `EELayer` on top of `NoopEnterpriseDefaultsLayer` when
 * `isEnterpriseEnabled()` is true. Layer.mergeAll resolves duplicate
 * Tags by "last wins", so EE's real implementations override core's
 * no-op defaults.
 *
 * Slice 1/11 (#2563) — foundation scaffolding only. `EELayer` is the
 * empty Layer; slices #2564–#2572 each replace one dynamic
 * `await import("@atlas/ee/...")` call site with `yield* TagName` and
 * append the real `Layer.effect` implementation here.
 *
 * See the parent issue (#2017) for the architectural rationale.
 */

import { Layer } from "effect";

/**
 * Empty aggregator — populated by slices 2–10. Each slice adds one
 * `Layer.effect(Tag, ...)` here and removes the corresponding dynamic
 * import from core.
 */
export const EELayer: Layer.Layer<never> = Layer.empty;
