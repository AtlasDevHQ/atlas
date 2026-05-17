/**
 * Enterprise Layer composition — extracted from `layers.ts` so the Hono
 * bridge (`runEffect`/`runHandler`) can import the composed layer
 * without pulling in the full startup DAG (`buildAppLayer`,
 * `InternalDBLive`, the SaaS guard family, etc.). Routes load this
 * module transitively via `hono.ts`; the surface here is intentionally
 * thin so partial `mock.module()` setups in existing tests aren't
 * forced to stub heavy startup-only exports.
 *
 * Slice 2/11 of #2017 (#2564) carved this file out. Pre-slice the
 * `EnterpriseLayer` const lived in `layers.ts`; both files now import
 * it from here so the canonical definition has a single home, and the
 * closeout CI grep (#2573) only needs to allow `@atlas/ee` in this
 * file plus the `@atlas/ee/layers` aggregator dynamic import below.
 */

import { Effect, Layer } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import {
  NoopEnterpriseDefaultsLayer,
  type ResidencyResolver,
  type ModelRouter,
  type MaskingPolicy,
  type ComplianceReports,
  type ApprovalGate,
  type SlaMetrics,
  type BackupsManager,
  type AuditRetention,
  type IpAllowlistPolicy,
  type SSOPolicy,
  type SCIMProvenance,
  type RolesPolicy,
  type Branding,
  type Domains,
  type ProactiveGate,
  type DeployModeResolver,
} from "./services";

const log = createLogger("effect:enterprise-layer");

/**
 * Read whether enterprise is enabled without importing from `@atlas/ee`.
 *
 * Mirrors `ee/src/index.ts:isEnterpriseEnabled` resolution:
 *   1. `enterprise.enabled` in atlas.config.ts
 *   2. `ATLAS_ENTERPRISE_ENABLED` env var
 *
 * Lazy-requires the config module so this file stays at the bottom of
 * the dep graph (config-resolution code transitively pulls in pieces of
 * the layer DAG via type-only paths in `lib/db/internal`).
 */
function isEnterpriseEnabledLocal(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getConfig } = require("@atlas/api/lib/config") as {
    getConfig: () => { enterprise?: { enabled?: boolean } } | null;
  };
  const config = getConfig();
  if (config?.enterprise?.enabled !== undefined) {
    return config.enterprise.enabled;
  }
  return process.env.ATLAS_ENTERPRISE_ENABLED === "true";
}

/**
 * Conditional EE Layer. When enterprise is enabled, lazy-imports
 * `@atlas/ee/layers` and exposes its `EELayer`. Otherwise falls back to
 * `Layer.empty`. Wrapped in `Layer.unwrapEffect` so the dynamic import
 * is deferred to Layer construction time (not module load), and a
 * missing/broken `@atlas/ee` install never fails core startup — the
 * catch arm logs and falls back to the empty Layer, leaving the no-op
 * defaults from `NoopEnterpriseDefaultsLayer` in effect.
 *
 * This is the **single permitted runtime reference** to `@atlas/ee`
 * from core. Adding any other `@atlas/ee` or `isEnterpriseEnabled`
 * reference to `packages/api/src/` will fail the CI grep slice #2573
 * installs (the closeout grep allow-list covers this file + the
 * conditional import below).
 */
const ConditionalEELayer: Layer.Layer<never> = Layer.unwrapEffect(
  Effect.sync(() => isEnterpriseEnabledLocal()).pipe(
    Effect.flatMap((enabled) => {
      if (!enabled) return Effect.succeed(Layer.empty as Layer.Layer<never>);
      return Effect.tryPromise({
        try: async () => {
          const mod = (await import("@atlas/ee/layers")) as { EELayer: Layer.Layer<never> };
          return mod.EELayer;
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "Enterprise enabled but @atlas/ee/layers failed to load — falling back to no-op defaults",
          );
          return Effect.succeed(Layer.empty as Layer.Layer<never>);
        }),
      );
    }),
  ),
);

/**
 * Union of all enterprise subsystem Tags. Exported so the Hono bridge
 * can widen its `R` constraint to accept route programs that
 * `yield* ResidencyResolver` (or any other Tag). Grows in lockstep with
 * `NoopEnterpriseDefaultsLayer` as slices widen contracts — the union
 * is the type-level source of truth.
 */
export type EnterpriseSubsystem =
  | ResidencyResolver
  | ModelRouter
  | MaskingPolicy
  | ComplianceReports
  | ApprovalGate
  | SlaMetrics
  | BackupsManager
  | AuditRetention
  | IpAllowlistPolicy
  | SSOPolicy
  | SCIMProvenance
  | RolesPolicy
  | Branding
  | Domains
  | ProactiveGate
  | DeployModeResolver;

/**
 * Composed enterprise Layer — no-op defaults overlaid by the conditional
 * EE layer (last-wins via `Layer.mergeAll`). Provided per-request by
 * `runEffect`/`runHandler` so route programs can `yield* ResidencyResolver`
 * without threading the layer through every handler.
 *
 * Construction is cheap: the no-op defaults are constants, and the
 * conditional EE layer's lazy `await import("@atlas/ee/layers")` hits
 * Node's module cache after the first load. Effect's Layer memoization
 * elides repeat work within a single program run.
 */
export const EnterpriseLayer: Layer.Layer<EnterpriseSubsystem> = Layer.mergeAll(
  NoopEnterpriseDefaultsLayer,
  ConditionalEELayer,
);
