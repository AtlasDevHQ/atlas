/**
 * Request-time feature-entitlement guard (WS1 of #3984 / #3986).
 *
 * {@link requireFeatureEntitlement} resolves a workspace's plan tier and, when
 * it ranks below the feature's minimum tier in the {@link FEATURE_ENTITLEMENTS}
 * SSOT, fails with {@link FeatureEntitlementError} — the bridge maps that to a
 * 403 `plan_upgrade_required` carrying the same `PlanUpgradeRequiredBody`
 * envelope the integration install endpoints emit.
 *
 * The per-tier ladder is a **SaaS** concept: only the hosted multi-tenant
 * deployment sells and bills tiers. So the guard is scoped to `saas` deploy
 * mode and is a no-op everywhere else — the enforcement posture then mirrors
 * `billing/enforcement.ts`:
 *
 *   - **Not SaaS deploy mode** → pass. A self-hosted deployment (including a
 *     self-hosted *enterprise* build) has no per-tier billing ladder; its
 *     workspaces sit on the unlimited `free` tier (see `plans.ts`). The feature
 *     is gated there by the enterprise-license Tag, NOT by plan tier: when
 *     enterprise is disabled the `SSOPolicy` *Noop* layer fails its
 *     enforcement/mutation methods with `EnterpriseError` (403); when enterprise is enabled the EE layer is
 *     active and SSO is unlocked. Either way this per-tier guard must not fire,
 *     or a self-hosted enterprise customer would be wrongly denied SSO because
 *     their tier is `free`.
 *   - **No orgId / no internal DB** → pass (no workspace to resolve a tier for).
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
import { resolveDeployMode } from "@atlas/api/lib/effect/deploy-mode";
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
 * Succeeds (`void`) when entitled, not in SaaS deploy mode, self-hosted, or
 * operator-bypassed. Fails with {@link FeatureEntitlementError}
 * (→ 403 `plan_upgrade_required`) when the SaaS tier ranks below the feature's
 * minimum, or {@link BillingCheckFailedError} (→ 503 `billing_check_failed`)
 * when the workspace lookup throws.
 *
 * Intended to be yielded near the top of an EE feature route handler, alongside
 * the enterprise-license Tag — so on SaaS a below-tier workspace is denied even
 * though the deployment is enterprise-enabled. Resolving the Tag itself never
 * fails (it returns the EE or Noop shape); the enterprise denial fires only
 * when a Noop *method* is invoked, so this guard's order relative to
 * `yield* SSOPolicy` is immaterial:
 *
 * ```ts
 * const { orgId } = yield* AuthContext;
 * yield* requireFeatureEntitlement(orgId, "sso"); // SaaS per-tier ladder gate
 * const sso = yield* SSOPolicy;                    // EE methods enforce license
 * ```
 */
export function requireFeatureEntitlement(
  orgId: string | undefined,
  feature: GatedFeature,
): Effect.Effect<void, FeatureEntitlementError | BillingCheckFailedError> {
  // The per-tier ladder only exists on the hosted SaaS. On any self-hosted
  // deploy — including a self-hosted *enterprise* build, whose workspaces sit
  // on the unlimited `free` tier — feature access is gated by the
  // enterprise-license Tag, not by plan tier. Gating here would wrongly deny a
  // self-hosted enterprise customer SSO (tier `free` < `business`). The
  // remaining short-circuits (no org / no internal DB) only matter inside SaaS.
  if (resolveDeployMode() !== "saas") {
    return Effect.void;
  }
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
