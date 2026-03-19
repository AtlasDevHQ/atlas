/**
 * Plan limit enforcement.
 *
 * Called before agent execution in chat and query routes.
 * Mirrors the checkWorkspaceStatus() pattern — returns { allowed: true }
 * when the request should proceed, or { allowed: false, ... } with an
 * error code, message, and HTTP status to block it.
 *
 * Enforcement is skipped entirely when:
 * - No internal DB is configured (self-hosted without managed auth)
 * - No orgId is provided (user not in an org)
 * - Billing is not enabled (STRIPE_SECRET_KEY not set)
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

const log = createLogger("billing:enforcement");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanCheckResult =
  | { allowed: true }
  | {
      allowed: false;
      errorCode: "trial_expired" | "query_limit_exceeded" | "token_limit_exceeded" | "billing_check_failed";
      errorMessage: string;
      httpStatus: 403 | 429 | 503;
    };

// ---------------------------------------------------------------------------
// Main enforcement check
// ---------------------------------------------------------------------------

/**
 * Check if the workspace's current usage is within its plan limits.
 *
 * Returns `{ allowed: true }` when the request may proceed.
 * Returns `{ allowed: false, errorCode, errorMessage, httpStatus }` when
 * the workspace has exceeded its plan limits or its trial has expired.
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
    workspace = await getWorkspaceDetails(orgId);
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

      if (!isUnlimited(limits.queriesPerMonth) && usage.queryCount >= limits.queriesPerMonth) {
        return {
          allowed: false,
          errorCode: "query_limit_exceeded",
          errorMessage: `You have reached your plan's query limit (${limits.queriesPerMonth.toLocaleString()} queries/month). Upgrade your plan or wait until the next billing period.`,
          httpStatus: 429,
        };
      }

      if (!isUnlimited(limits.tokensPerMonth) && usage.tokenCount >= limits.tokensPerMonth) {
        return {
          allowed: false,
          errorCode: "token_limit_exceeded",
          errorMessage: `You have reached your plan's token limit (${limits.tokensPerMonth.toLocaleString()} tokens/month). Upgrade your plan or wait until the next billing period.`,
          httpStatus: 429,
        };
      }
    } catch (err) {
      // If we can't read usage, allow the request — metering is best-effort.
      // Logged at error level so persistent metering failures trigger alerts.
      log.error(
        { err: err instanceof Error ? err.message : String(err), orgId },
        "Failed to read usage for plan enforcement — allowing request (metering unavailable)",
      );
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTrialExpired(workspace: WorkspaceRow): boolean {
  if (!workspace.trial_ends_at) {
    // No trial_ends_at set — check if the workspace was created more than TRIAL_DAYS ago
    const createdAt = new Date(workspace.createdAt);
    const trialCutoff = new Date(Date.now() - TRIAL_DAYS * 24 * 60 * 60 * 1000);
    return createdAt < trialCutoff;
  }

  return new Date(workspace.trial_ends_at) < new Date();
}
