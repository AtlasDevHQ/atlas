/**
 * Shared workspace-entitlement resolution — single source of truth for
 * "what plan tier is this workspace on, and is it an operator?" reads.
 *
 * Before this module the same `getWorkspaceEntitlement` body was duplicated
 * byte-for-byte across two integration route files
 * (`routes/integrations.ts` and `routes/integrations-discord.ts`). Both copies
 * resolved the workspace's `plan_tier` + `is_operator_workspace` from the
 * `organization` table and narrowed the tier via {@link parsePlanTier} at the
 * SQL boundary. Centralizing here means the install plan-gates and the new
 * per-tier feature-entitlement guard ({@link import("@atlas/api/lib/billing/feature-entitlement").requireFeatureEntitlement})
 * resolve entitlement identically — one edit moves every consumer in lockstep
 * (WS1 of #3984 / #3986).
 *
 * @module
 */

import { internalQuery } from "@atlas/api/lib/db/internal";
import type { PlanTier } from "@useatlas/types";
import { parsePlanTier } from "./plan-rank";

/**
 * Resolved entitlement for a workspace: its plan tier (narrowed to
 * {@link PlanTier} or `null`) and whether it is an operator workspace
 * (the admin bypass that admits any install / feature regardless of tier).
 */
export interface WorkspaceEntitlement {
  /**
   * The workspace's plan tier, narrowed at the SQL boundary. `null` means
   * "no plan / no billing context" — the self-hosted no-auth sentinel, a
   * workspace row not found, or a legacy/unknown `plan_tier` string. Callers
   * treat `null` as the most restrictive default (rank of `free` via
   * {@link import("./plan-rank").isPlanEligible}) for install gates; the
   * feature-entitlement guard additionally short-circuits self-hosted (no
   * internal DB) before reaching this resolver, so a `null` here on SaaS
   * collapses to `free` for the upgrade-prompt body.
   */
  readonly planTier: PlanTier | null;
  /** Operator-workspace bypass — admits any install / gated feature. */
  readonly isOperator: boolean;
}

/**
 * Resolve `{ planTier, isOperator }` for a workspace from the `organization`
 * table. `planTier` is narrowed via {@link parsePlanTier} at the SQL boundary
 * so downstream gates see `PlanTier | null` rather than a raw string — a
 * legacy / unknown value maps to `null` and callers treat `null` as "no plan /
 * not an operator", which by construction denies any `min_plan != 'free'`
 * install attempt without admitting the operator bypass.
 *
 * On a self-hosted no-auth deploy (sentinel `workspaceId = "self-hosted"`),
 * there's no organization row at all. The function returns
 * `{ planTier: null, isOperator: false }` and the same fail-closed default
 * applies — `null` collapses to `"free"` in the response body only when the
 * caller builds an upgrade prompt.
 */
export async function getWorkspaceEntitlement(
  orgId: string,
): Promise<WorkspaceEntitlement> {
  if (orgId === "self-hosted") return { planTier: null, isOperator: false };
  const rows = await internalQuery<{
    plan_tier: string | null;
    is_operator_workspace: boolean | null;
  }>(
    `SELECT plan_tier, is_operator_workspace
       FROM organization
      WHERE id = $1
      LIMIT 1`,
    [orgId],
  );
  if (rows.length === 0) return { planTier: null, isOperator: false };
  return {
    planTier: parsePlanTier(rows[0]?.plan_tier),
    isOperator: rows[0]?.is_operator_workspace === true,
  };
}
