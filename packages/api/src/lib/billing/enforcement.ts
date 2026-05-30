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
// Resource limit enforcement (seats, connections, chat integrations)
// ---------------------------------------------------------------------------

/**
 * Outcome of a resource-limit check.
 *
 * The two `allowed: false` arms are deliberately distinct so callers can
 * map them to different HTTP statuses — mirroring the `plan_limit_exceeded`
 * (429) vs `billing_check_failed` (503) split in {@link checkPlanLimits}:
 *
 *  - `cap_reached` — the workspace is genuinely at/over its plan cap. The
 *    actionable response is "upgrade your plan" (429). Carries `limit`, the
 *    cap that was hit.
 *  - `check_failed` — we could NOT determine the count (DB error, missing
 *    row). Fail-closed: the request is blocked, but the actionable response
 *    is "try again" (503), NOT "upgrade your plan". Carries no `limit` —
 *    there is no meaningful cap to report.
 */
export type ResourceLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "cap_reached"; errorMessage: string; limit: number }
  | { allowed: false; reason: "check_failed"; errorMessage: string };

/** Plan-capped resources. Each maps to a `PlanLimits` field. */
export type CappedResource = "seats" | "connections" | "chat_integrations";

/**
 * Check whether adding one more resource (seat, connection, or chat
 * integration) would exceed the plan's limit for the given workspace.
 *
 * `currentCount` is the count of that resource the workspace already has;
 * the check blocks when `currentCount >= cap`. Because the block fires
 * only on *new* resource creation, a workspace that is already over a
 * newly-introduced cap keeps what it has (grandfathered) and is simply
 * unable to add more.
 *
 * Returns `{ allowed: true }` when the resource can be created,
 * `{ allowed: false, reason: "cap_reached", ... }` when the plan cap has
 * been reached, or `{ allowed: false, reason: "check_failed", ... }` when
 * the workspace lookup failed and we fail closed (see {@link ResourceLimitResult}).
 *
 * Enforcement is skipped (always allowed) when:
 * - No internal DB is configured (self-hosted without managed auth)
 * - No orgId is provided
 * - The workspace is on the "free" tier (unlimited)
 */
export async function checkResourceLimit(
  orgId: string | undefined,
  resource: CappedResource,
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
    // Fail closed: consistent with checkPlanLimits behavior per CLAUDE.md.
    // `check_failed` (not `cap_reached`) so the caller surfaces a 503
    // "try again", not a misleading 429 "upgrade your plan".
    return { allowed: false, reason: "check_failed", errorMessage: "Unable to verify plan limits. Please try again." };
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
  // Record (not a ternary chain) so a new CappedResource member is a
  // compile error here until it's mapped to a PlanLimits field — no silent
  // fall-through into the wrong cap/label.
  const cap = ({
    seats: limits.maxSeats,
    connections: limits.maxConnections,
    chat_integrations: limits.maxChatIntegrations,
  } satisfies Record<CappedResource, number>)[resource];

  if (isUnlimited(cap)) {
    return { allowed: true };
  }

  if (currentCount >= cap) {
    const resourceLabel = ({
      seats: cap === 1 ? "seat" : "seats",
      connections: cap === 1 ? "connection" : "connections",
      chat_integrations: cap === 1 ? "chat integration" : "chat integrations",
    } satisfies Record<CappedResource, string>)[resource];
    log.warn(
      { orgId, resource, currentCount, limit: cap, tier },
      "Workspace at or over %s limit (%d/%d) — blocking resource creation",
      resourceLabel,
      currentCount,
      cap,
    );
    return {
      allowed: false,
      reason: "cap_reached",
      errorMessage: `Your ${tier} plan allows up to ${cap} ${resourceLabel}. Upgrade to add more.`,
      limit: cap,
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Chat integration cap (#2953)
// ---------------------------------------------------------------------------

/**
 * Check whether the workspace may install one more chat-platform
 * integration without exceeding its plan's `maxChatIntegrations` cap (the
 * marketed per-tier numbers live next to the values in `billing/plans.ts`).
 *
 * Counts the workspace's existing chat-pillar installs in
 * `workspace_plugins` (the same store the connections cap counts) and
 * delegates the cap comparison to {@link checkResourceLimit}.
 *
 * `catalogId` is the catalog row id of the platform being installed (e.g.
 * `"catalog:slack"`). It matters for two reasons:
 *  - **Reconnect is never blocked.** Re-authing a platform the workspace
 *    already has does not increase the distinct count, so a workspace that
 *    is already over a (grandfathered) cap can still re-auth what it owns.
 *  - **The new platform is excluded from the count**, so the comparison is
 *    "do the *other* chat platforms already fill the cap?".
 *
 * The cap counts every `workspace_plugins` row with `pillar = 'chat'`, so it
 * only constrains platforms whose install actually writes such a row. Today
 * that is Slack (OAuth) and Discord — both write `pillar = 'chat'` rows. The
 * legacy credential-store-only chat routes (Telegram / Teams / gchat /
 * WhatsApp) don't yet write a `workspace_plugins` row, so they are neither
 * counted nor capped until they pivot to the unified install record (#2994).
 *
 * Fails closed when the count can't be determined (query error or no row),
 * surfacing `reason: "check_failed"` — consistent with {@link checkResourceLimit}.
 *
 * KNOWN LIMITATION (TOCTOU): this is a read-only precheck; the caller does the
 * `workspace_plugins` INSERT separately, so two *distinct* net-new platforms
 * installed concurrently (e.g. Slack + Discord finishing OAuth in the same
 * window while the workspace is one under its cap) can both pass and both
 * write, landing one over the cap. The same-platform case can't breach it —
 * the `workspace_plugins_singleton` partial unique index collapses a duplicate
 * install into an UPSERT (a reconnect, always allowed). Closing the
 * cross-platform window needs a per-workspace advisory lock / transaction
 * around count+INSERT; tracked in #3001 (deferred — narrow window, heavy lift).
 */
export async function checkChatIntegrationLimit(
  orgId: string | undefined,
  catalogId: string,
): Promise<ResourceLimitResult> {
  if (!orgId || !hasInternalDB()) {
    return { allowed: true };
  }

  let counts: { others: number; this_count: number } | undefined;
  try {
    const rows = await internalQuery<{ others: number; this_count: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE catalog_id <> $2)::int AS others,
         COUNT(*) FILTER (WHERE catalog_id = $2)::int  AS this_count
       FROM workspace_plugins
       WHERE workspace_id = $1
         AND pillar = 'chat'
         AND status <> 'archived'`,
      [orgId, catalogId],
    );
    counts = rows[0];
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, catalogId },
      "Failed to count chat integrations for limit check — blocking as precaution",
    );
    return { allowed: false, reason: "check_failed", errorMessage: "Unable to verify plan limits. Please try again." };
  }

  // The aggregate SQL above always returns exactly one row, so a missing
  // row means the driver/query contract was violated. Fail closed rather
  // than coerce the absent count to 0 — `?? 0` would silently breach the
  // cap (treat "unknown" as "no other integrations → allow").
  if (!counts) {
    log.error(
      { orgId, catalogId },
      "Chat-integration count query returned no row — blocking as precaution",
    );
    return { allowed: false, reason: "check_failed", errorMessage: "Unable to verify plan limits. Please try again." };
  }

  // Reconnecting an already-installed platform never increases the distinct
  // count — always allow so a grandfathered over-cap workspace can re-auth
  // what it already has.
  if (counts.this_count > 0) {
    return { allowed: true };
  }

  return checkResourceLimit(orgId, "chat_integrations", counts.others);
}

