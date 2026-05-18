/**
 * Deploy mode detection for Atlas Enterprise.
 *
 * Resolves `ATLAS_DEPLOY_MODE` (env var or settings) to a binary
 * `"saas" | "self-hosted"` value. The `"saas"` mode requires enterprise
 * to be enabled — without it, deploy mode always resolves to `"self-hosted"`.
 *
 * Slice 10/11 of #2017 (#2572) moved the resolver to core
 * (`@atlas/api/lib/effect/deploy-mode`) so `lib/config.ts:applyDeployMode`
 * could stop dynamic-importing from `@atlas/ee`. This file is now a thin
 * re-export plus the EE-side `DeployModeResolver` Layer wiring — same
 * behavior, no behavior change for either SaaS or self-hosted.
 */

import { Layer } from "effect";
import { resolveDeployMode } from "@atlas/api/lib/effect/deploy-mode";
import {
  DeployModeResolver,
  type DeployModeResolverShape,
} from "@atlas/api/lib/effect/services";

export { resolveDeployMode };

// ── Tag wiring (#2572 — slice 10/11 of #2017) ────────────────────────
//
// Bridges `resolveDeployMode` into the `DeployModeResolver` Tag so core
// can `yield* DeployModeResolver` instead of `await import("@atlas/ee/deploy-mode")`.
// Aggregated into `ee/src/layers.ts:EELayer`; the no-op default in
// `lib/effect/services.ts:NoopDeployModeResolverLayer` returns
// `"self-hosted"` (the correct answer when EE is not loaded — `"saas"`
// mode requires enterprise).

export const makeDeployModeResolverLive = (): DeployModeResolverShape => ({
  resolve: () => resolveDeployMode(),
});

export const DeployModeResolverLive: Layer.Layer<DeployModeResolver> =
  Layer.sync(DeployModeResolver, makeDeployModeResolverLive);
