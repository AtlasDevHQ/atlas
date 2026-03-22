/**
 * Plan limit enforcement with graceful degradation.
 *
 * Called before agent execution in chat and query routes.
 * Returns { allowed: true } (with optional warning) when the request
 * should proceed, or { allowed: false, ... } to block it.
 *
 * Degradation tiers:
 * - **OK (0–79%):** No warning, request proceeds normally.
 * - **Warning (80–99%):** Request proceeds, warning metadata attached.
 * - **Soft limit (100–109%):** 10% grace buffer. Request proceeds with
 *   overage warning. Structured log emitted.
 * - **Hard limit (110%+):** Request blocked with 429, upgrade CTA.
 *
 * Enforcement is skipped entirely when:
 * - No internal DB is configured (self-hosted without managed auth)
 * - No orgId is provided (user not in an org)
 * - The workspace is on the "free" or "enterprise" tier
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  getWorkspaceDetails,
  type WorkspaceRow,
} from "@atlas/api/lib/db/internal";
import { getCurrentPeriodUsage } from "@atlas/api/lib/metering";
import { getPlanLimits, isUnlimited, TRIAL_DAYS } from "./plans";
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
 */
async function getCachedWorkspace(
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
 * Returns `{ allowed: true }` (with optional `warning`) when the request
 * may proceed. Returns `{ allowed: false, ... }` when the workspace has
 * exceeded its hard limit or its trial has expired.
 */
export async function checkPlanLimits(
  orgId: string | undefined,
): Promise<PlanCheckResult> {
  // Self-hosted / no org — no enforcement
  if (!orgId || !hasInternalDB()) {
    return { allowed: true };
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

  const { plan_tier: tier } = workspace;

  // Free (self-hosted) and enterprise — no limits enforced
  if (tier === "free" || tier === "enterprise") {
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

  // Usage limit check (trial + team)
  const limits = getPlanLimits(tier);
  if (!isUnlimited(limits.queriesPerMonth) || !isUnlimited(limits.tokensPerMonth)) {
    try {
      const usage = await getCurrentPeriodUsage(orgId);
      return evaluateUsage(orgId, usage, limits);
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
  usage: { queryCount: number; tokenCount: number },
  limits: { queriesPerMonth: number; tokensPerMonth: number },
): PlanCheckResult {
  const metrics: PlanLimitStatus[] = [];

  // Evaluate each metered dimension
  if (!isUnlimited(limits.queriesPerMonth)) {
    metrics.push(
      buildMetricStatus("queries", usage.queryCount, limits.queriesPerMonth),
    );
  }
  if (!isUnlimited(limits.tokensPerMonth)) {
    metrics.push(
      buildMetricStatus("tokens", usage.tokenCount, limits.tokensPerMonth),
    );
  }

  // Find the worst status across all metrics
  const worst = metrics.reduce<PlanLimitStatus | undefined>(
    (prev, cur) =>
      !prev || severityOf(cur.status) > severityOf(prev.status) ? cur : prev,
    undefined,
  );

  if (!worst) {
    return { allowed: true };
  }

  // Hard limit — block the request
  if (worst.status === "hard_limit") {
    const graceUsed = worst.usagePercent - 100;
    log.warn(
      {
        orgId,
        metric: worst.metric,
        currentUsage: worst.currentUsage,
        limit: worst.limit,
        usagePercent: worst.usagePercent,
        threshold: "hard_limit",
      },
      "Workspace exceeded hard limit (%d%% of %s limit) — blocking request",
      worst.usagePercent,
      worst.metric,
    );
    return {
      allowed: false,
      errorCode: "plan_limit_exceeded",
      errorMessage:
        `You have exceeded your plan's ${worst.metric} limit ` +
        `(${worst.currentUsage.toLocaleString()} / ${worst.limit.toLocaleString()}). ` +
        `The 10% grace buffer has been used (${graceUsed.toFixed(0)}% over). ` +
        `Upgrade your plan or wait until the next billing period.`,
      httpStatus: 429,
      usage: {
        currentUsage: worst.currentUsage,
        limit: worst.limit,
        metric: worst.metric,
      },
    };
  }

  // Soft limit (100–109%) — allow with overage warning
  if (worst.status === "soft_limit") {
    log.warn(
      {
        orgId,
        metric: worst.metric,
        currentUsage: worst.currentUsage,
        limit: worst.limit,
        usagePercent: worst.usagePercent,
        threshold: "soft_limit",
      },
      "Workspace in grace buffer (%d%% of %s limit) — allowing with warning",
      worst.usagePercent,
      worst.metric,
    );
    return {
      allowed: true,
      warning: {
        code: "plan_limit_warning",
        message:
          `You have exceeded your plan's ${worst.metric} limit ` +
          `(${worst.currentUsage.toLocaleString()} / ${worst.limit.toLocaleString()}). ` +
          `You are in a 10% grace period. Upgrade to avoid service interruption.`,
        metrics,
      },
    };
  }

  // Warning (80–99%) — allow with usage warning
  if (worst.status === "warning") {
    log.info(
      {
        orgId,
        metric: worst.metric,
        usagePercent: worst.usagePercent,
        threshold: "warning",
      },
      "Workspace approaching plan limit (%d%% of %s limit)",
      worst.usagePercent,
      worst.metric,
    );
    return {
      allowed: true,
      warning: {
        code: "plan_limit_warning",
        message:
          `You are approaching your plan's ${worst.metric} limit ` +
          `(${worst.usagePercent}% used: ${worst.currentUsage.toLocaleString()} / ${worst.limit.toLocaleString()}).`,
        metrics,
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
  metric: "queries" | "tokens",
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

function severityOf(status: OverageStatus): number {
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
