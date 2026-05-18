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

import { Effect, Layer, ManagedRuntime } from "effect";
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
 * Conditional EE Layer.
 *
 * - When enterprise is DISABLED, returns `Layer.empty`. The no-op
 *   defaults from `NoopEnterpriseDefaultsLayer` cover every Tag and
 *   self-hosted runs unchanged.
 * - When enterprise is ENABLED, lazy-imports `@atlas/ee/layers` and
 *   exposes its `EELayer`. The dynamic import is deferred to Layer
 *   construction time (not module load) so a missing `@atlas/ee/`
 *   build doesn't break core's module graph.
 *
 * **Load failure handling (#2587).** When enterprise is enabled but the
 * `@atlas/ee/layers` import fails, this logs at ERROR with a structured
 * `event: "enterprise.load_failed"` field (alertable by SaaS monitoring)
 * then falls through to `Layer.empty`. Every enterprise subsystem then
 * resolves to its no-op default for the request.
 *
 * **Known weak spot — not yet fail-closed at the consumer level.** The
 * no-op defaults across the 16 Tags vary in how "fail-closed" they
 * really are. Most are correct on self-hosted but inadequate on a SaaS
 * install where `ATLAS_ENTERPRISE_ENABLED=true` but `ee/` failed to load:
 *
 *   - MaskingPolicy no-op passes rows through unmasked
 *   - IpAllowlistPolicy no-op always allows
 *   - ApprovalGate no-op never requires approval
 *   - ResidencyResolver no-op returns null (route falls back to default
 *     datasource — compliance break on EU workspaces)
 *
 * Hardening this is tracked in #2593 — consumer-side "available"
 * discriminator checks at each load-bearing call site. The change is
 * too invasive for #2587 because it touches every test's mock setup
 * (16 test files mock individual `@atlas/ee/*` modules without mocking
 * the `@atlas/ee/layers` aggregator; any change that hard-fails the
 * aggregator on partial-mock cascades through every consumer).
 *
 * This is the **single permitted runtime reference** to `@atlas/ee`
 * from core. Adding any other `@atlas/ee` or `isEnterpriseEnabled`
 * reference to `packages/api/src/` will fail the CI grep gate
 * (`scripts/check-ee-imports.sh`); the allow-list covers this file
 * plus the conditional import below.
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
          // Operator-visible structured log so SaaS monitoring picks this
          // up — `enterprise.load_failed` is the alertable event. Fall
          // through to `Layer.empty` so the request can still complete via
          // the no-op defaults. The downgrade is intentional but documented
          // as a known weak spot in the JSDoc above; consumer-side
          // hardening tracked in #2593.
          log.error(
            {
              err: err instanceof Error ? err.message : String(err),
              event: "enterprise.load_failed",
              flag: "ATLAS_ENTERPRISE_ENABLED",
            },
            "Enterprise enabled but @atlas/ee/layers failed to load — request will be " +
              "served by no-op defaults across every enterprise subsystem. Fix the " +
              "@atlas/ee install or set ATLAS_ENTERPRISE_ENABLED=false.",
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
 * EE layer (last-wins via `Layer.mergeAll`). Provided to programs via
 * the module-level `enterpriseRuntime` (see `getEnterpriseRuntime` +
 * `runEnterprise` below) so route programs can `yield* ResidencyResolver`
 * without threading the layer through every handler.
 *
 * Construction is paid ONCE per process: the runtime materialises the
 * layer the first time it's used and reuses the constructed services
 * across all subsequent runs. Pre-#2587 the bridge re-wrapped this Layer
 * with `Effect.provide(...)` per request — building a fresh runtime
 * Scope per call, defeating Effect's reference-keyed memoization.
 */
export const EnterpriseLayer: Layer.Layer<EnterpriseSubsystem> = Layer.mergeAll(
  NoopEnterpriseDefaultsLayer,
  ConditionalEELayer,
);

// ── Module-level ManagedRuntime (#2587) ──────────────────────────────
//
// Pre-#2587 every call site of `Effect.provide(EnterpriseLayer)` rebuilt
// the Layer's runtime per call. A single admin request handling a SQL
// execution rebuilt 6-8 times (auth middleware → IP allowlist →
// admin-router permission ×2 → SQL masking/SLA/approval ×3), and the
// EE-Layer's lazy `await import("@atlas/ee/layers")` re-allocated
// the `Effect.tryPromise` wrapper per call. The JSDoc above claimed
// "Effect's Layer memoization elides repeat work within a single program
// run" — true for one run, but each `Effect.runPromise` is a separate run.
//
// `ManagedRuntime.make(EnterpriseLayer)` materializes the layer once on
// first use. Subsequent `runtime.runPromise(...)` calls reuse the
// constructed services — the dynamic EE import hits Node's module cache
// AND Effect's Layer memoization simultaneously. Construction is lazy
// (deferred to first call) so tests that `mock.module("@atlas/ee/layers")`
// before any handler runs see their mocks.
//
// `runEnterprise(program)` is the canonical helper for the standalone
// (non-Hono) call sites. The Hono bridge (`hono.ts:runEffect`) uses the
// runtime directly so it can layer in per-request contextLayer.

let _runtime: ManagedRuntime.ManagedRuntime<EnterpriseSubsystem, never> | null = null;

/**
 * Get (or lazily create) the module-level ManagedRuntime for the
 * EnterpriseLayer. Lazy so tests can install `mock.module("@atlas/ee/layers")`
 * before the first runtime build.
 *
 * The runtime is process-lifetime; no explicit dispose. The Layer's
 * subsystems (Noop defaults + EELayer's Live impls) currently have no
 * scoped finalizers, so leaking the runtime at process exit is fine.
 * If a future EE Tag introduces a scoped finalizer, wire dispose into
 * the existing shutdown handler in `buildAppLayer`.
 */
export function getEnterpriseRuntime(): ManagedRuntime.ManagedRuntime<EnterpriseSubsystem, never> {
  if (_runtime === null) {
    _runtime = ManagedRuntime.make(EnterpriseLayer);
  }
  return _runtime;
}

/**
 * Run a program that requires `EnterpriseSubsystem` via the shared
 * module-level runtime. Use this instead of
 * `Effect.runPromise(program.pipe(Effect.provide(EnterpriseLayer)))` at
 * any non-Hono call site (the Hono bridge uses `getEnterpriseRuntime()`
 * directly so it can layer in per-request contextLayer).
 *
 * Rejects on EE-load failure when `ATLAS_ENTERPRISE_ENABLED=true` —
 * caller should treat the rejection as an operator-visible deploy error
 * (matching the fail-closed contract from #2587), not a per-request
 * recoverable.
 */
export function runEnterprise<A, E>(
  program: Effect.Effect<A, E, EnterpriseSubsystem>,
): Promise<A> {
  return getEnterpriseRuntime().runPromise(program);
}

/**
 * Exit-returning variant for call sites that need to inspect the failure
 * cause (defect vs typed failure vs interruption) without the
 * `runPromise` reject path.
 */
export function runEnterpriseExit<A, E>(
  program: Effect.Effect<A, E, EnterpriseSubsystem>,
) {
  return getEnterpriseRuntime().runPromiseExit(program);
}

/**
 * Test-only: clear the cached runtime so a `mock.module("@atlas/ee/layers")`
 * change between test files (or between test groups within a file) is
 * picked up on the next runtime build. Production code should never call
 * this; the runtime is process-lifetime.
 */
export function __resetEnterpriseRuntimeForTesting(): void {
  if (_runtime !== null) {
    void _runtime.dispose();
    _runtime = null;
  }
}
