/**
 * Symlink-stub aggregator. Mirrors `ee/src/layers.ts`'s public surface
 * with a no-op `EELayer` so the core-only build job
 * (`.github/workflows/ci.yml:ee-stub-build`) can prove `@atlas/api` has
 * zero structural coupling to enterprise code. If a new core file ever
 * tries to import anything from `@atlas/ee/...` that isn't covered by
 * this stub, the type-check fails and the closeout invariant
 * (issue #2017 / milestone 1.5.1 #48) is preserved.
 *
 * The real `ee/src/layers.ts` exports `EELayer` typed by the union of
 * every Tag it binds. Here we widen to `Layer.Layer<never>` so the
 * grep-gate-allowed call site in `lib/effect/enterprise-layer.ts`
 * (`await import("@atlas/ee/layers")`) still resolves; the
 * `NoopEnterpriseDefaultsLayer` in services.ts provides every Tag,
 * and the empty EELayer adds nothing on top (matching what the real
 * `ConditionalEELayer` falls back to when `isEnterpriseEnabled()` is
 * false).
 */

import { Layer } from "effect";

export const EELayer: Layer.Layer<never> = Layer.empty;
