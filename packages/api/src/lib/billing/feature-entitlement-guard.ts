/**
 * Request-time feature-entitlement guard (WS1 of #3984 / #3986).
 *
 * {@link requireFeatureEntitlement} resolves a workspace's plan tier and, when
 * it ranks below the feature's minimum tier in the {@link FEATURE_ENTITLEMENTS}
 * SSOT, fails with {@link FeatureEntitlementError} — the bridge maps that to a
 * 403 `plan_upgrade_required` carrying the same `PlanUpgradeRequiredBody`
 * envelope the integration install endpoints emit.
 *
 * Enforcement posture mirrors `billing/enforcement.ts` exactly so the per-tier
 * ladder and the token-budget gate behave consistently:
 *
 *   - **Self-hosted / no internal DB / no orgId** → pass. There is no billing
 *     context, so per-tier gating doesn't apply. On a self-hosted *enterprise*
 *     deploy the feature itself is still gated — by the enterprise-license Tag
 *     (`SSOPolicy` et al. fail with `EnterpriseError`), not by plan tier. This
 *     guard is the SaaS per-tier layer that sits *in addition to* that Tag.
 *   - **Lookup error** → fail closed with {@link BillingCheckFailedError}
 *     (503 "try again"), matching `checkPlanLimits`' workspace-lookup fail-
 *     closed arm. A transient internal-DB fault must not silently widen access.
 *   - **Operator workspace** → pass (the same admin bypass the install gate
 *     honors via {@link WorkspaceEntitlement.isOperator}).
 *   - **Tier below minimum** → fail with {@link FeatureEntitlementError} (403
 *     upgrade). `null` tier (row not found / legacy value) collapses to `free`
 *     for the upgrade-prompt body, exactly as the install gate does.
 *
 * The guard is split out from the pure `feature-entitlement.ts` predicate so
 * that module stays free of Effect / DB imports and trivially table-testable.
 *
 * @module
 */

import { Effect } from "effect";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  BillingCheckFailedError,
  FeatureEntitlementError,
} from "@atlas/api/lib/effect/errors";
import { getWorkspaceEntitlement } from "@atlas/api/lib/integrations/install/workspace-entitlement";
import { createLogger } from "@atlas/api/lib/logger";
import {
  FEATURE_ENTITLEMENTS,
  isFeatureEntitled,
  type GatedFeature,
} from "./feature-entitlement";

const log = createLogger("billing:feature-entitlement");

/**
 * Effect guard: require that the workspace identified by `orgId` is entitled to
 * `feature`, or fail with the appropriate tier/upgrade error.
 *
 * Succeeds (`void`) when entitled, self-hosted, or operator-bypassed. Fails
 * with {@link FeatureEntitlementError} (→ 403 `plan_upgrade_required`) when the
 * tier ranks below the feature's minimum, or {@link BillingCheckFailedError}
 * (→ 503 `billing_check_failed`) when the workspace lookup throws.
 *
 * Intended to be yielded at the top of an EE feature route handler, after the
 * enterprise-license Tag is resolved — so a SaaS workspace below tier is denied
 * even when the deployment is enterprise-enabled:
 *
 * ```ts
 * const { orgId } = yield* AuthContext;
 * const sso = yield* SSOPolicy;            // deployment-level enterprise gate
 * yield* requireFeatureEntitlement(orgId, "sso"); // per-tier ladder gate
 * ```
 */
export function requireFeatureEntitlement(
  orgId: string | undefined,
  feature: GatedFeature,
): Effect.Effect<void, FeatureEntitlementError | BillingCheckFailedError> {
  // Self-hosted / no org / no internal DB — no per-tier billing context. The
  // enterprise-license Tag is what gates the feature on self-hosted enterprise
  // deploys; this per-tier layer is a no-op there.
  if (!orgId || orgId === "self-hosted" || !hasInternalDB()) {
    return Effect.void;
  }

  return Effect.tryPromise({
    try: () => getWorkspaceEntitlement(orgId),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    // Lookup fault → fail closed (503), never silently widen access.
    Effect.catchAll((err) => {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          orgId,
          feature,
        },
        "Failed to resolve workspace entitlement for feature gate — blocking as precaution",
      );
      return Effect.fail(
        new BillingCheckFailedError({
          message: "Unable to verify your plan. Please try again.",
          workspaceId: orgId,
        }),
      );
    }),
    Effect.flatMap((entitlement) => {
      // Operator-workspace admin bypass (parity with the install gate).
      if (entitlement.isOperator) return Effect.void;
      if (isFeatureEntitled(entitlement.planTier, feature)) return Effect.void;

      const requiredPlan = FEATURE_ENTITLEMENTS[feature];
      // `null` tier (row not found / legacy value) collapses to "free" for the
      // upgrade-prompt body, matching the install gate's current_plan handling.
      const currentPlan = entitlement.planTier ?? "free";
      log.info(
        { orgId, feature, requiredPlan, currentPlan },
        "Feature denied: workspace plan ranks below the feature's minimum tier",
      );
      return Effect.fail(
        new FeatureEntitlementError({
          message: `This feature requires the "${requiredPlan}" plan. Your workspace is on the "${currentPlan}" plan.`,
          feature,
          requiredPlan,
          currentPlan,
        }),
      );
    }),
  );
}
