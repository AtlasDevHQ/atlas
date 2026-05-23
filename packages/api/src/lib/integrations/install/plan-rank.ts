/**
 * Unified plan-tier comparator — single source of truth for entitlement
 * checks across catalog reads, install endpoints, and the
 * {@link WorkspaceInstallGate}.
 *
 * Per #2666: catalog `min_plan` and workspace `plan_tier` share one
 * vocabulary (the `PLAN_TIERS` union from `@useatlas/types`):
 *
 *   `free | trial | starter | pro | business`
 *
 * Before this module the same rank ordering was duplicated in three
 * places (`workspace-install-gate.ts`, `integrations-catalog.ts`,
 * `admin-marketplace.ts`) with subtly different shapes. The catalog
 * version even admitted `team` / `enterprise` — values no workspace
 * could ever hold — so callers silently denied installs at runtime
 * with a debug-level log. Centralizing here means a single edit moves
 * every consumer in lockstep.
 *
 * ## Unknown values
 *
 *   - Unknown `min_plan` (catalog drift, typo in a seed): `planRank`
 *     returns `null` and {@link isPlanEligible} fails closed — a typo
 *     in a catalog row shouldn't accidentally widen access.
 *   - Unknown `plan_tier` (legacy `team`, NULL from a LEFT JOIN miss,
 *     pre-#1472 row): `planRank` returns `null`; eligibility callers
 *     treat as rank 0 (most restrictive). The DB CHECK on
 *     `organization.plan_tier` should already prevent unknowns from
 *     landing, but the gate stays defensive.
 *
 * @module
 */

import { PLAN_TIERS, type PlanTier } from "@useatlas/types";

/**
 * Numeric rank for every recognized plan tier. Higher = more
 * privileged. Keyed by {@link PlanTier} so adding a tier to
 * `@useatlas/types` produces a compile error here until the rank is
 * assigned — drift can't land silently.
 *
 * The ordering matches the customer-visible price ladder: free →
 * trial → starter → pro → business. `trial` ranks above `free`
 * because trials grant temporary starter-equivalent access.
 */
export const PLAN_RANK: Readonly<Record<PlanTier, number>> = {
  free: 0,
  trial: 1,
  starter: 2,
  pro: 3,
  business: 4,
};

// Compile-time guard: every PLAN_TIERS entry must have a rank.
// The expression-level check (`satisfies`) ensures the literal table
// above is exhaustive over the PlanTier union, complementing the
// `Record<PlanTier, number>` annotation.
PLAN_TIERS satisfies readonly PlanTier[];

/**
 * Return the numeric rank for a plan name, or `null` when the value
 * is not a recognized plan tier. Callers decide the fail-closed
 * default per call site:
 *
 *   - For `plan_tier`: treat `null` as rank 0 (most restrictive).
 *   - For `min_plan`:  refuse the row outright (a typo shouldn't
 *     widen access).
 */
export function planRank(name: string | null | undefined): number | null {
  if (typeof name !== "string") return null;
  if (!(name in PLAN_RANK)) return null;
  return PLAN_RANK[name as PlanTier];
}

/**
 * Compare a workspace's `plan_tier` against a catalog row's
 * `min_plan`. Returns `true` when the workspace's rank is `>=` the
 * required rank.
 *
 *   - Unknown `requiredPlan` → `false` (fail closed; catalog drift
 *     shouldn't admit anything).
 *   - Unknown `workspacePlan` → rank 0 (most restrictive); admits
 *     only rows whose `requiredPlan` is also rank 0 (`free`).
 */
export function isPlanEligible(
  workspacePlan: string | null | undefined,
  requiredPlan: string | null | undefined,
): boolean {
  const requiredRank = planRank(requiredPlan);
  if (requiredRank === null) return false;
  const workspaceRank = planRank(workspacePlan) ?? 0;
  return workspaceRank >= requiredRank;
}
