/**
 * Feature entitlement — the single source of truth mapping every gated
 * capability to the minimum plan tier that unlocks it (WS1 of #3984 / #3986).
 *
 * Before this module the per-tier feature ladder the /pricing page sells was
 * fictional on the hosted SaaS: the ten "Business-only" capabilities (SSO,
 * SCIM, custom roles, IP allowlist, approvals, audit-retention, masking,
 * residency, backups, white-label) plus proactive monitoring gated only on
 * whether the *deployment* was enterprise-enabled — never on the workspace's
 * plan tier. The four `PlanFeatures` booleans in `plans.ts` were read for
 * display, never to gate. This module makes the ladder real:
 *
 *   - {@link FEATURE_ENTITLEMENTS} enumerates every gated feature → minimum
 *     tier. It is the authoritative map both enforcement and (eventually,
 *     via the WS4 drift guard) the pricing page read from.
 *   - {@link isFeatureEntitled} is a pure predicate over `(tier, feature)`,
 *     reusing the `plan-rank` ordering vocabulary
 *     (`free < trial < starter < pro < business`, `locked` = no entitlement).
 *
 * The default tier line is **Business** for every feature; a feature that
 * should sit at Pro+ instead is a single-line override in the map below.
 *
 * The request-time guard (`requireFeatureEntitlement`) that resolves a
 * workspace's tier and returns the standard upgrade/403 lives in
 * `feature-entitlement-guard.ts` so the pure predicate here stays free of
 * Effect / DB dependencies and remains trivially table-testable.
 *
 * @module
 */

import type { MinPlanTier, PlanTier } from "@useatlas/types";
import { isPlanEligible } from "@atlas/api/lib/integrations/install/plan-rank";

/**
 * The set of gated capabilities the feature ladder enforces. Each maps to a
 * minimum {@link PlanTier} in {@link FEATURE_ENTITLEMENTS}. Adding a member
 * here forces a corresponding entry in that map (the `Record<GatedFeature,
 * PlanTier>` annotation makes the omission a compile error), so a new premium
 * feature is correct-by-construction gated rather than silently ungated.
 *
 * The string values are stable wire/log identifiers (snake_case) — they appear
 * in structured logs and may surface in the WS4 drift guard, so they are not
 * cosmetic.
 */
export type GatedFeature =
  | "sso"
  | "scim"
  | "custom_roles"
  | "ip_allowlist"
  | "approvals"
  | "audit_retention"
  | "masking"
  | "residency"
  | "backups"
  | "white_label"
  | "custom_domain"
  | "proactive";

/**
 * Feature → minimum plan tier. The default line is **Business** for every
 * gated capability, matching the current /pricing page. Where a feature
 * should unlock earlier (Pro+), change its value here — that single edit moves
 * both enforcement and the SSOT-rendered page in lockstep.
 *
 * Keyed by {@link GatedFeature} so adding a feature without assigning a tier
 * is a compile error — the ladder can't drift open. Values are typed
 * {@link MinPlanTier} (the tier union excluding `locked`) so a `locked`
 * minimum — an illegal state that would make the feature ungateable to every
 * workspace ({@link isPlanEligible} returns `false` for a `locked` requirement)
 * — is unrepresentable.
 */
export const FEATURE_ENTITLEMENTS: Readonly<Record<GatedFeature, MinPlanTier>> = {
  sso: "business",
  scim: "business",
  custom_roles: "business",
  ip_allowlist: "business",
  approvals: "business",
  audit_retention: "business",
  masking: "business",
  residency: "business",
  backups: "business",
  white_label: "business",
  // Pro+ override (not the Business default): the custom-domain route has always
  // documented "Pro or Business plan … required to create a domain" (see
  // admin-domains.ts), so the SSOT pins its minimum at `pro` to match the
  // product's established intent. #3988 / #3984 acceptance criteria explicitly
  // permit custom domain to sit at Pro+ where the SSOT says so.
  custom_domain: "pro",
  proactive: "business",
};

/**
 * Pure predicate: is a workspace on `tier` entitled to `feature`?
 *
 * Returns `true` iff the workspace's tier ranks at or above the feature's
 * minimum tier in the `plan-rank` ordering. Delegates the rank comparison to
 * {@link isPlanEligible} so the fail-closed semantics are shared with the
 * install gate and can't drift:
 *
 *   - `locked` (rank -1) is entitled to nothing — fails closed.
 *   - An unknown / `null` tier (a legacy `plan_tier`, a row not found, or the
 *     self-hosted no-billing sentinel) resolves to the rank of `free`, so it
 *     satisfies only a `free`-min feature. No gated feature is `free`-min, so
 *     `null` fails closed for every member of {@link FEATURE_ENTITLEMENTS}.
 *
 * This predicate is the SaaS per-tier decision only. Self-hosted deployments
 * (including self-hosted enterprise, whose workspaces are on `free`) never reach
 * it: the request-time guard short-circuits non-SaaS deploy mode before
 * consulting this predicate, so the enterprise-license Tag — not the plan tier —
 * is what gates features there. See `feature-entitlement-guard.ts`.
 *
 * Exhaustive over the tier union by construction: every recognized tier has a
 * `plan-rank` entry, and the lookup of `feature` in {@link FEATURE_ENTITLEMENTS}
 * is total over {@link GatedFeature}.
 */
export function isFeatureEntitled(
  tier: PlanTier | null | undefined,
  feature: GatedFeature,
): boolean {
  const requiredTier = FEATURE_ENTITLEMENTS[feature];
  return isPlanEligible(tier ?? null, requiredTier);
}
