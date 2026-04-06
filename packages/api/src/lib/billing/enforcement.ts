/**
 * Plan limit enforcement with graceful degradation.
 *
 * Called before agent execution in chat and query routes.
 * Returns { allowed: true } (with optional warning) when the request
 * should proceed, or { allowed: false, ... } to block it.
 *
 * Token budgets are per-seat: total budget = tokenBudgetPerSeat * seatCount.
 *
 * Degradation tiers:
 * - **OK (0-79%):** No warning, request proceeds normally.
 * - **Warning (80-99%):** Request proceeds, warning metadata attached.
 * - **Soft limit (100-109%):** 10% grace buffer. Request proceeds with
 *   overage warning. Structured log emitted.
 * - **Hard limit (110%+):** Request blocked with 429, upgrade CTA.
 *
 * Enforcement is skipped entirely when:
 * - No internal DB is configured (self-hosted without managed auth)
 * - No orgId is provided (user not in an org)
 * - The workspace is on the "free" tier
 * - The workspace has BYOT enabled (unlimited when bringing own keys)
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  getWorkspaceDetails,
  internalQuery,
  type WorkspaceRow,
} from "@atlas/api/lib/db/internal";
import { getCurrentPeriodUsage } from "@atlas/api/lib/metering";
import { computeTokenBudget, getPlanLimits, isUnlimited, TRIAL_DAYS } from "./plans";
import type { OverageStatus, PlanLimitStatus } from "@useatlas/types";

const log = createLogger("billing:enforcement");

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Usage percent at which a warning is included in the response. */
const WARNING_THRESHOLD = 80;

/** Usage percent at which the hard block kicks in (grace buffer ends). */
const HARD_LIMIT_THRESHOLD = 110;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanLimitWarning {
  code: "plan_limit_warning";
  message: string;
  metrics: PlanLimitStatus[];
}

export type PlanCheckResult =
  | { allowed: true; warning?: PlanLimitWarning }
  | { allowed: false; errorCode: "trial_expired"; errorMessage: string; httpStatus: 403 }
  | { allowed: false; errorCode: "plan_limit_exceeded"; errorMessage: string; httpStatus: 429; usage: { currentUsage: number; limit: number; metric: string } }
  | { allowed: false; errorCode: "billing_check_failed"; errorMessage: string; httpStatus: 503 };

// ---------------------------------------------------------------------------
// Plan limit cache
// ---------------------------------------------------------------------------

interface CachedPlanData {
  workspace: WorkspaceRow;
  fetchedAt: number;
}

const planCache = new Map<string, CachedPlanData>();

/** Cache TTL in milliseconds — workspace/plan data changes infrequently. */
const PLAN_CACHE_TTL_MS = 60_000;

/**
 * Get workspace details, using a short-lived cache to avoid querying
 * the internal DB on every request.
 *
 * Exported so that workspace status checks can reuse the same cache
 * instead of making a separate DB query per request.
 */
export async function getCachedWorkspace(
  orgId: string,
): Promise<WorkspaceRow | null> {
  const cached = planCache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < PLAN_CACHE_TTL_MS) {
    return cached.workspace;
  }

  const workspace = await getWorkspaceDetails(orgId);
  if (workspace) {
    planCache.set(orgId, { workspace, fetchedAt: Date.now() });
  } else {
    planCache.delete(orgId);
  }
  return workspace;
}

/** Clear cached workspace data. Called after plan tier changes (e.g. Stripe webhook) to force a fresh DB read. */
export function invalidatePlanCache(orgId?: string): void {
  if (orgId) {
    planCache.delete(orgId);
  } else {
    planCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Main enforcement check
// ---------------------------------------------------------------------------

/**
 * Check if the workspace's current usage is within its plan limits.
 *
 * @param orgId - The organization/workspace ID.
 * @param seatCount - Number of seats (members) in the org. Defaults to 1.
 *
 * Returns `{ allowed: true }` (with optional `warning`) when the request
 * may proceed. Returns `{ allowed: false, ... }` when the workspace has
 * exceeded its hard limit or its trial has expired.
 */
export async function checkPlanLimits(
  orgId: string | undefined,
  seatCount?: number,
): Promise<PlanCheckResult> {
  // Self-hosted / no org — no enforcement
  if (!orgId || !hasInternalDB()) {
    return { allowed: true };
  }

  // Fetch seat count from member table if not provided
  if (seatCount === undefined) {
    try {
      const rows = await internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM member WHERE "organizationId" = $1`,
        [orgId],
      );
      seatCount = rows[0]?.count ?? 1;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), orgId },
        "Failed to query member count for plan enforcement — defaulting to 1 seat",
      );
      seatCount = 1;
    }
  }

  let workspace: WorkspaceRow | null;
  try {
    workspace = await getCachedWorkspace(orgId);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to fetch workspace for plan enforcement — blocking as precaution",
    );
    return {
      allowed: false,
      errorCode: "billing_check_failed",
      errorMessage: "Unable to verify billing status. Please try again.",
      httpStatus: 503,
    };
  }

  // Org not found or pre-migration — allow
  if (!workspace) {
    return { allowed: true };
  }

  const { plan_tier: tier, byot } = workspace;

  // Free (self-hosted) — no limits enforced
  if (tier === "free") {
    return { allowed: true };
  }

  // BYOT workspaces skip token enforcement (unlimited when bringing own keys)
  if (byot) {
    return { allowed: true };
  }

  // Trial expiry check
  if (tier === "trial") {
    const trialExpired = isTrialExpired(workspace);
    if (trialExpired) {
      return {
        allowed: false,
        errorCode: "trial_expired",
        errorMessage:
          "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
        httpStatus: 403,
      };
    }
  }

  // Token budget check — budget scales with seat count
  const totalBudget = computeTokenBudget(tier, seatCount ?? 1);
  if (!isUnlimited(totalBudget)) {
    try {
      const usage = await getCurrentPeriodUsage(orgId);
      return evaluateUsage(orgId, usage.tokenCount, totalBudget);
    } catch (err) {
      // If we can't read usage, allow the request — metering is best-effort.
      // Surface the degradation as a warning so clients know enforcement is impaired.
      log.error(
        { err: err instanceof Error ? err.message : String(err), orgId },
        "Failed to read usage for plan enforcement — allowing request (metering unavailable)",
      );
      return {
        allowed: true,
        warning: {
          code: "plan_limit_warning" as const,
          message:
            "Usage metering is temporarily unavailable. Your request was allowed, but usage tracking may be inaccurate.",
          metrics: [],
        },
      };
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Usage evaluation (3-tier degradation)
// ---------------------------------------------------------------------------

function evaluateUsage(
  orgId: string,
  tokenCount: number,
  tokenBudget: number,
): PlanCheckResult {
  const metric = buildMetricStatus("tokens", tokenCount, tokenBudget);

  // Hard limit — block the request
  if (metric.status === "hard_limit") {
    const graceUsed = metric.usagePercent - 100;
    log.warn(
      {
        orgId,
        metric: metric.metric,
        currentUsage: metric.currentUsage,
        limit: metric.limit,
        usagePercent: metric.usagePercent,
        threshold: "hard_limit",
      },
      "Workspace exceeded hard limit (%d%% of token budget) — blocking request",
      metric.usagePercent,
    );
    return {
      allowed: false,
      errorCode: "plan_limit_exceeded",
      errorMessage:
        `You have exceeded your plan's token budget ` +
        `(${metric.currentUsage.toLocaleString()} / ${metric.limit.toLocaleString()} tokens). ` +
        `The 10% grace buffer has been used (${graceUsed.toFixed(0)}% over). ` +
        `Upgrade your plan, add seats, or wait until the next billing period.`,
      httpStatus: 429,
      usage: {
        currentUsage: metric.currentUsage,
        limit: metric.limit,
        metric: metric.metric,
      },
    };
  }

  // Soft limit (100-109%) — allow with overage warning
  if (metric.status === "soft_limit") {
    log.warn(
      {
        orgId,
        metric: metric.metric,
        currentUsage: metric.currentUsage,
        limit: metric.limit,
        usagePercent: metric.usagePercent,
        threshold: "soft_limit",
      },
      "Workspace in grace buffer (%d%% of token budget) — allowing with warning",
      metric.usagePercent,
    );
    return {
      allowed: true,
      warning: {
        code: "plan_limit_warning",
        message:
          `You have exceeded your plan's token budget ` +
          `(${metric.currentUsage.toLocaleString()} / ${metric.limit.toLocaleString()} tokens). ` +
          `You are in a 10% grace period. Upgrade or add seats to avoid service interruption.`,
        metrics: [metric],
      },
    };
  }

  // Warning (80-99%) — allow with usage warning
  if (metric.status === "warning") {
    log.info(
      {
        orgId,
        metric: metric.metric,
        usagePercent: metric.usagePercent,
        threshold: "warning",
      },
      "Workspace approaching token budget (%d%%)",
      metric.usagePercent,
    );
    return {
      allowed: true,
      warning: {
        code: "plan_limit_warning",
        message:
          `You are approaching your plan's token budget ` +
          `(${metric.usagePercent}% used: ${metric.currentUsage.toLocaleString()} / ${metric.limit.toLocaleString()} tokens).`,
        metrics: [metric],
      },
    };
  }

  // OK — no warning needed
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildMetricStatus(
  metric: "tokens",
  currentUsage: number,
  limit: number,
): PlanLimitStatus {
  if (limit <= 0) {
    // Invalid limit (not the -1 unlimited sentinel, which is filtered upstream).
    // Fail safe: treat as hard limit so misconfigured plans don't silently allow everything.
    log.error({ metric, limit }, "Invalid plan limit value — treating as hard limit");
    return { metric, currentUsage, limit, usagePercent: 999, status: "hard_limit" };
  }
  const usagePercent = Math.round((currentUsage / limit) * 100);
  return {
    metric,
    currentUsage,
    limit,
    usagePercent,
    status: classifyUsage(usagePercent),
  };
}

function classifyUsage(usagePercent: number): OverageStatus {
  if (usagePercent >= HARD_LIMIT_THRESHOLD) return "hard_limit";
  if (usagePercent >= 100) return "soft_limit";
  if (usagePercent >= WARNING_THRESHOLD) return "warning";
  return "ok";
}

const SEVERITY_ORDER: Record<OverageStatus, number> = {
  ok: 0,
  warning: 1,
  soft_limit: 2,
  hard_limit: 3,
};

/** Exported for tests. */
export function severityOf(status: OverageStatus): number {
  return SEVERITY_ORDER[status];
}

function isTrialExpired(workspace: WorkspaceRow): boolean {
  if (!workspace.trial_ends_at) {
    // No trial_ends_at set — check if the workspace was created more than TRIAL_DAYS ago
    const createdAt = new Date(workspace.createdAt);
    const trialCutoff = new Date(Date.now() - TRIAL_DAYS * 24 * 60 * 60 * 1000);
    return createdAt < trialCutoff;
  }

  return new Date(workspace.trial_ends_at) < new Date();
}

// ---------------------------------------------------------------------------
// Resource limit enforcement (seats, connections)
// ---------------------------------------------------------------------------

export type ResourceLimitResult =
  | { allowed: true }
  | { allowed: false; errorMessage: string; limit: number };

/**
 * Check whether adding one more resource (seat or connection) would
 * exceed the plan's limit for the given workspace.
 *
 * Returns `{ allowed: true }` when the resource can be created, or
 * `{ allowed: false, errorMessage, limit }` when the plan cap has been
 * reached.
 *
 * Enforcement is skipped (always allowed) when:
 * - No internal DB is configured (self-hosted without managed auth)
 * - No orgId is provided
 * - The workspace is on the "free" tier (unlimited)
 */
export async function checkResourceLimit(
  orgId: string | undefined,
  resource: "seats" | "connections",
  currentCount: number,
): Promise<ResourceLimitResult> {
  if (!orgId || !hasInternalDB()) {
    return { allowed: true };
  }

  let workspace: WorkspaceRow | null;
  try {
    workspace = await getCachedWorkspace(orgId);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, resource },
      "Failed to fetch workspace for resource limit check — blocking as precaution",
    );
    // Fail closed: consistent with checkPlanLimits behavior per CLAUDE.md
    return { allowed: false, errorMessage: "Unable to verify plan limits. Please try again.", limit: 0 };
  }

  if (!workspace) {
    return { allowed: true };
  }

  const { plan_tier: tier } = workspace;

  // Free (self-hosted) — no resource limits
  if (tier === "free") {
    return { allowed: true };
  }

  const limits = getPlanLimits(tier);
  const cap = resource === "seats" ? limits.maxSeats : limits.maxConnections;

  if (isUnlimited(cap)) {
    return { allowed: true };
  }

  if (currentCount >= cap) {
    const resourceLabel = resource === "seats"
      ? (cap === 1 ? "seat" : "seats")
      : (cap === 1 ? "connection" : "connections");
    log.warn(
      { orgId, resource, currentCount, limit: cap, tier },
      "Workspace at or over %s limit (%d/%d) — blocking resource creation",
      resourceLabel,
      currentCount,
      cap,
    );
    return {
      allowed: false,
      errorMessage: `Your ${tier} plan allows up to ${cap} ${resourceLabel}. Upgrade to add more.`,
      limit: cap,
    };
  }

  return { allowed: true };
}

