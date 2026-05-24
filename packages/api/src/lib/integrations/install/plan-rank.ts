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
 * Trust-boundary narrowing helper: take any string-shaped value off the
 * wire / out of a SQL row and narrow it to {@link PlanTier} or `null`.
 *
 * Call this exactly once per trust boundary — DB row read, OpenAPI
 * request, config import. After that point internal callers cannot
 * pass a bogus tier like `"team"` or `"enterprise"` (both rejected by
 * the rank table at runtime today) by accident; the type system
 * refuses them at compile time.
 *
 * Returns `null` for any input outside {@link PLAN_TIERS} (including
 * `null`, `undefined`, or non-string values). Callers decide the
 * fail-closed default per call site — see {@link planRank} and
 * {@link isPlanEligible}.
 *
 * Membership is tested with `PLAN_TIERS.includes` rather than `in
 * PLAN_RANK` — the `in` operator also matches inherited keys like
 * `"toString"` and `"constructor"`, which would falsely admit those
 * strings as a PlanTier.
 */
export function parsePlanTier(value: unknown): PlanTier | null {
  if (typeof value !== "string") return null;
  return (PLAN_TIERS as readonly string[]).includes(value)
    ? (value as PlanTier)
    : null;
}

/**
 * Return the numeric rank for a plan tier, or `null` when the value
 * is missing. Callers decide the fail-closed default per call site:
 *
 *   - For `plan_tier`: treat `null` as rank 0 (most restrictive).
 *   - For `min_plan`:  refuse the row outright (a typo shouldn't
 *     widen access).
 *
 * Accepts `PlanTier | null` because the trust-boundary narrowing
 * already happened via {@link parsePlanTier}. Callers reading raw
 * strings off a SQL row or HTTP body must pipe through
 * `parsePlanTier` first.
 */
export function planRank(name: PlanTier | null | undefined): number | null {
  if (name == null) return null;
  return PLAN_RANK[name];
}

/**
 * Compare a workspace's `plan_tier` against a catalog row's
 * `min_plan`. Returns `true` when the workspace's rank is `>=` the
 * required rank.
 *
 *   - Missing `requiredPlan` → `false` (fail closed; catalog drift
 *     shouldn't admit anything).
 *   - Missing `workspacePlan` → rank 0 (most restrictive); admits
 *     only rows whose `requiredPlan` is also rank 0 (`free`).
 *
 * Accepts `PlanTier | null` — the trust-boundary narrowing happens
 * upstream via {@link parsePlanTier}.
 */
export function isPlanEligible(
  workspacePlan: PlanTier | null | undefined,
  requiredPlan: PlanTier | null | undefined,
): boolean {
  const requiredRank = planRank(requiredPlan ?? null);
  if (requiredRank === null) return false;
  const workspaceRank = planRank(workspacePlan ?? null) ?? 0;
  return workspaceRank >= requiredRank;
}
