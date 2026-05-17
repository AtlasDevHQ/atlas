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
 * Slice 2/11 (#2564) — appends the real `ResidencyResolver` Layer so
 * core call sites (`lib/db/connection.ts`, platform residency routes,
 * `shared-residency.ts`) can `yield* ResidencyResolver` and get EE's
 * full implementation when enterprise is enabled. Later slices
 * (#2565–#2572) follow the same pattern: one Tag, one Layer entry.
 *
 * See the parent issue (#2017) for the architectural rationale.
 */

import { Layer } from "effect";
import type { ResidencyResolver } from "@atlas/api/lib/effect/services";
import { ResidencyResolverLive } from "./platform/residency";

/**
 * Aggregated EE Layer — typed by the union of every Tag this module
 * binds, so a future regression that drops a binding (or forgets to
 * import a new slice's Layer) surfaces as a `tsgo` error rather than
 * silently falling through to the no-op default at runtime.
 */
export const EELayer: Layer.Layer<ResidencyResolver> = Layer.mergeAll(
  ResidencyResolverLive,
);
