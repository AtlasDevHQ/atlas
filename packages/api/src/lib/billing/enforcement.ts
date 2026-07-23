/**
 * Plan limit enforcement with a metered soft-cap, denominated in dollars
 * (Structure B, #4038).
 *
 * Called before agent execution in chat and query routes.
 * Returns { allowed: true } (with optional warning) when the request
 * should proceed, or { allowed: false, ... } to block it.
 *
 * The included budget is an at-cost usage CREDIT in real dollars, pooled
 * per-seat: total credit = includedUsageDollarsPerSeat ($20) * seatCount. Usage
 * is the summed at-cost provider spend (`usage.costUsd`, #4036), so the gauge is
 * the exact zero-markup dollars Atlas paid — no token-equivalents enter the
 * decision.
 *
 * Metered soft-cap bands (percent of the dollar credit):
 * - **OK (0-79%):** No warning, request proceeds normally.
 * - **Warning (80-99%):** Request proceeds, warning metadata attached.
 * - **Metered (100% → ceiling):** Request proceeds and every dollar past the
 *   credit accrues at provider cost. A warning carrying the accrued "in
 *   overage, $X.XX so far" surface is attached. A paying workspace is metered,
 *   not cut off, for ordinary overage.
 * - **Hard limit (≥ ceiling):** the cutoff. Where it sits depends on the
 *   workspace's spend policy (`ATLAS_SPEND_POLICY`, #4038):
 *     - `continue` (default): the ceiling is the ABUSE ceiling — a conservative
 *       multiple of the credit (default 500% = $100/seat via `ATLAS_ABUSE_CEILING`)
 *       that bounds runaway / abusive spend.
 *     - `cutoff`: the ceiling clamps to 100% of the credit, so any overage past
 *       the included credit instantly hard-blocks.
 *   Requests are blocked with 429 here and ONLY here.
 *
 * Enforcement is skipped entirely when:
 * - No internal DB is configured (self-hosted without managed auth)
 * - No orgId is provided (user not in an org)
 * - The workspace is on the "free" tier
 * - The workspace has BYOT enabled (no metered usage accrues when bringing own keys)
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  getInternalDB,
  getWorkspaceDetails,
  internalQuery,
  type InternalPoolClient,
  type WorkspaceRow,
} from "@atlas/api/lib/db/internal";
import { getCurrentPeriodUsage } from "@atlas/api/lib/metering";
import { getSettingLive } from "@atlas/api/lib/settings";
import { getSeatCount, SeatCountUnavailableError } from "./seat-count";
import { computeUsageDollarBudget, getPlanLimits, isUnlimited } from "./plans";
// Single-homed in a leaf module so the two producers of the same KB 503 can't
// drift; `knowledge-limits.ts` imports THIS file, so it can't own the constant.
import { KNOWLEDGE_CAP_CHECK_FAILED_MSG } from "./knowledge-limits-message";
import {
  effectiveTrialEndsAt,
  isTrialExpiredAt,
  isTrialTier,
  trialDaysRemaining,
} from "./trial-state";
import type { OverageStatus, PlanLimitStatus, PlanTier } from "@useatlas/types";

const log = createLogger("billing:enforcement");

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Usage percent at which a warning is included in the response. */
const WARNING_THRESHOLD = 80;

/**
 * Usage percent at which billable overage begins to accrue (metered band).
 * Also the effective ceiling under the `cutoff` spend policy: clamping the
 * ceiling here makes any overage past the included credit hard-block at once.
 */
const METERED_THRESHOLD = 100;

/**
 * Settings key for the abuse ceiling — the metered soft-cap cutoff under the
 * `continue` spend policy, expressed as a percent of the dollar credit. See the
 * registry entry in `lib/settings.ts`.
 */
const ABUSE_CEILING_KEY = "ATLAS_ABUSE_CEILING";

/**
 * Settings key for the workspace spend policy (#4038): `continue` (default —
 * keep serving at provider cost past the credit, bounded by the abuse ceiling)
 * or `cutoff` (hard-block the moment the credit is spent). Bound to a const so
 * `check-settings-readers` counts {@link resolveSpendPolicy} as the reader
 * (the R2 const-indirected pattern).
 */
const SPEND_POLICY_KEY = "ATLAS_SPEND_POLICY";

/** Workspace spend policy past the included credit. */
export type SpendPolicy = "continue" | "cutoff";

/** Default spend policy: keep serving at provider cost (Structure B, #4038). */
const DEFAULT_SPEND_POLICY: SpendPolicy = "continue";

/**
 * Conservative fallback abuse ceiling (percent of credit) when the setting is
 * unreadable or malformed. Mirrors the registry default (500% = 5× credit =
 * $100/seat): high enough that ordinary metered overage never trips it, low
 * enough to cap runaway / abusive spend at a bounded multiple of the credit.
 * Used only as the in-code belt — the registry default is the real source.
 */
const DEFAULT_ABUSE_CEILING_PERCENT = 500;

/**
 * Resolve the abuse ceiling (percent of the dollar credit) for a workspace.
 *
 * Read live (per request, hot-reloadable) from the workspace-scoped
 * `ATLAS_ABUSE_CEILING` setting so an operator can lift it for a known heavy
 * customer without a redeploy. Returns `null` when the ceiling is DISABLED
 * (value 0 or empty) — pure metering with no cutoff — and the conservative
 * {@link DEFAULT_ABUSE_CEILING_PERCENT} when the value is unreadable or
 * non-numeric (fail-safe: a typo must not silently remove the abuse cap).
 *
 * The ceiling is clamped to be strictly above the metered threshold: a value
 * at or below 100% would make EVERY overage an instant hard block, re-creating
 * the very behaviour #3990 removes, so such a misconfiguration is floored at
 * the default rather than honoured.
 */
export async function resolveAbuseCeilingPercent(orgId: string): Promise<number | null> {
  let raw: string | undefined;
  try {
    raw = await getSettingLive(ABUSE_CEILING_KEY, orgId);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to read abuse-ceiling setting — falling back to conservative default",
    );
    return DEFAULT_ABUSE_CEILING_PERCENT;
  }

  const trimmed = raw?.trim() ?? "";
  // Empty → explicit disable (no cutoff, pure metering).
  if (trimmed === "") return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    log.warn(
      { orgId, value: raw },
      "Abuse-ceiling setting is not a non-negative number — using conservative default",
    );
    return DEFAULT_ABUSE_CEILING_PERCENT;
  }
  // Numeric zero (any spelling: "0", "0.0", "00") → explicit disable. Owning
  // every zero spelling in ONE post-parse branch keeps the security-relevant
  // disable path single — a future "simplify" can't accidentally flip "0.0"
  // from disabled to default.
  if (parsed === 0) return null;

  // A ceiling at or below the metered threshold would hard-block all overage,
  // defeating the metered soft-cap. Floor it at the default rather than honour
  // a self-defeating misconfiguration. (A workspace that genuinely wants to stop
  // AT the credit sets the spend policy to `cutoff` — see {@link resolveSpendPolicy}
  // — which clamps the ceiling to 100% deliberately, bypassing this floor.)
  if (parsed <= METERED_THRESHOLD) {
    log.warn(
      { orgId, value: parsed, floor: DEFAULT_ABUSE_CEILING_PERCENT },
      "Abuse-ceiling setting is at or below 100% (would block all overage) — flooring at default",
    );
    return DEFAULT_ABUSE_CEILING_PERCENT;
  }

  return parsed;
}

/**
 * Resolve the spend policy for a workspace past its included credit (#4038).
 *
 * Read live (per request, hot-reloadable) from the workspace-scoped
 * `ATLAS_SPEND_POLICY` setting so an admin owns their own spend posture without
 * a redeploy. Returns {@link DEFAULT_SPEND_POLICY} (`continue`) when the value
 * is unset, empty, unreadable, or not a recognised policy — the
 * default-ON-but-bounded posture, so a typo never silently converts a paying
 * workspace to a hard cutoff. `cutoff` is honoured only when set explicitly.
 */
export async function resolveSpendPolicy(orgId: string): Promise<SpendPolicy> {
  let raw: string | undefined;
  try {
    raw = await getSettingLive(SPEND_POLICY_KEY, orgId);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to read spend-policy setting — falling back to default (continue)",
    );
    return DEFAULT_SPEND_POLICY;
  }

  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "cutoff") return "cutoff";
  if (value === "continue") return "continue";
  if (value !== "") {
    log.warn(
      { orgId, value: raw },
      "Spend-policy setting is not a recognised policy — using default (continue)",
    );
  }
  return DEFAULT_SPEND_POLICY;
}

/**
 * Resolve a workspace's effective cutoff ceiling (percent of credit) together
 * with its spend policy — the single source of truth the enforcement decision
 * (`checkPlanLimits` → `evaluateUsage`) and the billing-page display both read,
 * so the dollar gauge's `metered` vs `hard_limit` band can never disagree with
 * the 429 the workspace actually hits (#4038).
 *
 *   - `cutoff`   → ceiling = {@link METERED_THRESHOLD} (100% of credit): any
 *                  overage past the included credit hard-blocks. Set directly,
 *                  NOT through {@link resolveAbuseCeilingPercent} (which floors
 *                  <=100% to the default) — cutoff is the deliberate stop-at-credit.
 *   - `continue` → ceiling = {@link resolveAbuseCeilingPercent} (a bounded
 *                  multiple of the credit, or `null` when an operator disabled it).
 *
 * Both reads are live per request (hot-reloadable).
 */
export async function resolveUsageCeiling(
  orgId: string,
): Promise<{ spendPolicy: SpendPolicy; ceilingPercent: number | null }> {
  const spendPolicy = await resolveSpendPolicy(orgId);
  const ceilingPercent =
    spendPolicy === "cutoff" ? METERED_THRESHOLD : await resolveAbuseCeilingPercent(orgId);
  return { spendPolicy, ceilingPercent };
}

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
  | { allowed: false; errorCode: "subscription_required"; errorMessage: string; httpStatus: 403 }
  | { allowed: false; errorCode: "plan_limit_exceeded"; errorMessage: string; httpStatus: 429; usage: { currentUsage: number; limit: number; metric: string } }
  | { allowed: false; errorCode: "billing_check_failed"; errorMessage: string; httpStatus: 503 };

// ---------------------------------------------------------------------------
// Plan limit cache
// ---------------------------------------------------------------------------
//
// PER-REPLICA / IN-MEMORY — documented staleness contract (#3432).
//
// `planCache` is a plain in-process Map: each API replica holds its OWN copy.
// A Stripe webhook handled on replica A calls invalidatePlanCache(orgId) on A
// ONLY — replicas B..N keep serving their cached WorkspaceRow until their own
// PLAN_CACHE_TTL_MS entry expires. So after a tier change (upgrade/downgrade)
// OR a suspension/status flip (checkWorkspaceStatus in lib/workspace.ts reads
// the SAME cache via getCachedWorkspace), replicas that didn't handle the
// webhook can be stale for up to PLAN_CACHE_TTL_MS (60s).
//
// Recorded decision (#3432 triage): we ACCEPT this 60s window as the v1
// staleness SLA rather than build cross-replica pub/sub. Two things make that
// safe:
//   1. The post-checkout UI (#3418, CheckoutReturnBanner in
//      packages/web/src/app/admin/billing/page.tsx) polls /api/v1/billing for
//      25 × 3s = 75s — deliberately longer than this TTL — so a webhook landing
//      against a warm cache on whichever replica the user hits is guaranteed to
//      clear (TTL expiry) before the poll gives up. That closes the
//      user-visible "I paid and it's still blocked" gap: the staleness never
//      outlives the poll window.
//   2. The window is bounded and self-healing (TTL expiry); for a brand-new
//      subscriber the stale direction is fail-OPEN at worst, and only for <60s.
//
// Revisit trigger: if the 60s window ever proves user-visible BEYOND the
// post-checkout poll (e.g. a mid-session suspension that must take effect
// cross-replica in <60s), replace this with Postgres LISTEN/NOTIFY pub-sub
// invalidation (broadcast invalidatePlanCache over a `plan_cache_invalidate`
// channel) rather than shortening the TTL globally.

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
 *
 * NOTE (#3432): this cache is per-replica/in-memory — see the block comment
 * above. A value read here can be up to PLAN_CACHE_TTL_MS (60s) behind a tier
 * or suspension change applied via a Stripe webhook on a DIFFERENT replica.
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

/**
 * Clear cached workspace data. Called after plan tier changes (e.g. Stripe
 * webhook) to force a fresh DB read.
 *
 * PER-REPLICA (#3432): this clears ONLY the calling process's `planCache`. The
 * webhook fires on one replica, so the other replicas are NOT invalidated here
 * — they self-heal on TTL expiry (≤60s). See the block comment on `planCache`
 * for the accepted staleness contract and the PG LISTEN/NOTIFY revisit trigger.
 */
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
 * @param seatCount - Number of seats (members) in the org. When omitted it is
 *   resolved via the shared {@link getSeatCount} source — the SAME `member`
 *   count the billing and usage pages read — so the enforced budget can never
 *   diverge from the advertised one (#3430). A seat-count lookup failure with
 *   no last-known value fails the check closed (503), never silently 1 seat.
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

  // Locked (#3421) — SaaS churn landing tier: the subscription has ended.
  // Blocked BEFORE the BYOT bypass: a churned workspace keeps zero
  // entitlements even with its own keys configured — resubscribing is the
  // only way back in.
  if (tier === "locked") {
    // Defense-in-depth breadcrumb: every current caller logs the block at the
    // seam, but logging the decision here too means a future caller can't
    // accidentally make a billing-block invisible (parity with the spend
    // hard-limit log in evaluateUsage).
    log.warn({ orgId, tier, reason: "subscription_required" }, "Plan enforcement blocked request — workspace locked (subscription ended)");
    return {
      allowed: false,
      errorCode: "subscription_required",
      errorMessage:
        "Your subscription has ended. Resubscribe from the billing page to continue using Atlas.",
      httpStatus: 403,
    };
  }

  // BYOT workspaces skip usage enforcement (no metered usage accrues when bringing own keys)
  if (byot) {
    return { allowed: true };
  }

  // Trial expiry check — the expired/solvent axis, defined in `trial-state`.
  if (isTrialTier(tier)) {
    const trialExpired = isTrialExpiredAt(effectiveTrialEndsAt(workspace));
    if (trialExpired) {
      log.warn({ orgId, tier, reason: "trial_expired" }, "Plan enforcement blocked request — trial expired");
      return {
        allowed: false,
        errorCode: "trial_expired",
        errorMessage:
          "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
        httpStatus: 403,
      };
    }
  }

  // Resolve the seat count the budget scales with — the SAME shared source the
  // billing and usage pages read, so the advertised budget and the actual 429
  // threshold can never disagree (#3430). A seat-count blip does NOT collapse
  // the budget to 1 seat: getSeatCount serves the last-known value when it has
  // one, and throws SeatCountUnavailableError only when it has nothing. In that
  // case we fail the check closed (503 "try again") rather than understate the
  // budget 10× and fire a spurious 429.
  if (seatCount === undefined) {
    try {
      seatCount = await getSeatCount(orgId);
    } catch (err) {
      if (err instanceof SeatCountUnavailableError) {
        log.error(
          { orgId },
          "Seat count unavailable for plan enforcement and no last-known value — blocking as precaution",
        );
        return {
          allowed: false,
          errorCode: "billing_check_failed",
          errorMessage: "Unable to verify billing status. Please try again.",
          httpStatus: 503,
        };
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  // Dollar credit check — the included at-cost usage credit scales with seat
  // count (Structure B, #4038). Reach-here tiers (trial / starter / pro /
  // business) all carry a $20/seat credit; a 0 credit is defensive only
  // (free / locked are short-circuited above) and means there is nothing to
  // meter, so allow rather than block-everything.
  const totalCredit = computeUsageDollarBudget(tier, seatCount);
  if (totalCredit > 0) {
    try {
      // Resolve the spend policy + cutoff ceiling via the shared SSOT so the
      // billing-page gauge and this 429 can never disagree. Read live per
      // request (hot-reloadable) so a policy/ceiling change from Admin →
      // Settings takes effect without a redeploy.
      const { spendPolicy, ceilingPercent } = await resolveUsageCeiling(orgId);
      const usage = await getCurrentPeriodUsage(orgId);
      // COST-BASIS GAP ALERT (#4038): `costUsd` sums `gateway_cost_usd`, which is
      // NULL for non-gateway providers and for token rows predating the at-cost
      // capture (#4036, incl. the current period at cutover). When tokens were
      // recorded but the cost basis summed to $0, the dollar gauge reads ~0% and
      // the workspace runs effectively un-metered — a SILENT enforcement fade-out,
      // the exact false-negative the old token belt (`weightedTokenCount ??
      // tokenCount`) was written to prevent. The #3428 fail-open below only fires
      // when the read THROWS; a successful read returning a legitimately-zero sum
      // is invisible to it. So surface it as an operator-visible alert here —
      // matching the #3428 bypass `log.error` so the same metering-impaired
      // dashboards catch it. Still fail-open: we proceed and meter on the
      // (under-counted) cost, never block on a $0 basis.
      if (usage.tokenCount > 0 && usage.costUsd === 0) {
        log.error(
          { orgId, tier, tokenCount: usage.tokenCount, periodStart: usage.periodStart, reason: "cost_basis_missing" },
          "Dollar enforcement has no cost basis — tokens recorded but gateway_cost_usd summed to $0; " +
            "usage gauge reads ~0% and the workspace is effectively un-metered (non-gateway provider, or token rows predating #4036) (#4038)",
        );
      }
      // Denominate against the summed at-cost provider spend (#4036) — the exact
      // zero-markup dollars Atlas paid the gateway — so the enforced gauge is the
      // real billed amount and no token-equivalent enters the decision.
      return evaluateUsage(orgId, usage.costUsd, totalCredit, ceilingPercent, spendPolicy);
    } catch (err) {
      // DELIBERATE FAIL-OPEN (#3428): if we can't read usage, ALLOW the request
      // — metering is best-effort and we prioritise availability over revenue
      // during an internal-DB degradation. This is intentionally ASYMMETRIC with
      // the fail-CLOSED workspace lookup above (a workspace-lookup error → 503):
      // a missing plan tier means we can't even decide *whether* to enforce,
      // whereas a usage-read failure only means we can't decide *how much* has
      // been spent, so the safer-for-the-customer default is to let them through.
      //
      // The cost is a usage-budget bypass: a sustained outage means unmetered
      // usage for the duration. The triage decision (2026-06-12) ACCEPTS that
      // exposure but requires it to be OPERATOR-VISIBLE — hence the structured
      // `log.error` alert below carries the orgId + the underlying reason so an
      // operator paging on metering failures can scope the bypass. Revisit with
      // a bounded fail-open (allow N requests, then block) if alert volume shows
      // this happening in practice.
      log.error(
        { err: err instanceof Error ? err.message : String(err), orgId, reason: "metering_read_failed" },
        "Usage-budget check BYPASSED — usage read failed; allowing request (metering unavailable, enforcement impaired) (#3428)",
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
// Overage accounting (#3990, dollar-denominated #4038)
// ---------------------------------------------------------------------------

/**
 * At-cost overage in USD: dollars spent BEYOND the included credit (#4038).
 * Structure B bills usage at provider cost (zero markup), so the overage cost
 * IS the excess spend — the former `(overageTokens / 1e6) * rate`
 * `computeOverageCost` collapses to this identity, with no per-token rate. 0
 * when at or under the credit (or the credit is non-positive); never negative.
 */
export function computeOverageDollars(costUsd: number, creditUsd: number): number {
  if (creditUsd <= 0) return 0;
  return Math.max(0, costUsd - creditUsd);
}

// ---------------------------------------------------------------------------
// Usage evaluation (metered soft-cap: ok → warning → metered → ceiling cutoff)
// ---------------------------------------------------------------------------

function evaluateUsage(
  orgId: string,
  costUsd: number,
  creditUsd: number,
  ceilingPercent: number | null,
  spendPolicy: SpendPolicy,
): PlanCheckResult {
  const metric = buildMetricStatus("usd", costUsd, creditUsd, ceilingPercent);

  // Hard limit — the cutoff. Block the request. Under `cutoff` the ceiling sits
  // at the credit (100%); under `continue` it's the abuse ceiling.
  if (metric.status === "hard_limit") {
    const isCutoff = spendPolicy === "cutoff";
    log.warn(
      {
        orgId,
        metric: metric.metric,
        currentUsage: metric.currentUsage,
        limit: metric.limit,
        usagePercent: metric.usagePercent,
        ceilingPercent,
        spendPolicy,
        threshold: isCutoff ? "spend_cutoff" : "abuse_ceiling",
      },
      "Workspace reached its spend cutoff (%d%% of $%s credit, policy %s) — blocking request",
      metric.usagePercent,
      creditUsd.toFixed(2),
      spendPolicy,
    );
    const errorMessage = isCutoff
      ? `You have used your full included usage credit ` +
        `(${formatUsd(metric.currentUsage)} of ${formatUsd(metric.limit)}). ` +
        `Your workspace spend policy is set to stop at the credit. ` +
        `Switch the spend policy to "continue", upgrade, or add seats to keep going.`
      : `You have reached your workspace's spend ceiling ` +
        `(${formatUsd(metric.currentUsage)} of ${formatUsd(metric.limit)} credit, ` +
        `${metric.usagePercent}% of credit). ` +
        `Requests are paused to prevent runaway spend. ` +
        `Upgrade your plan, add seats, or contact support to raise the ceiling.`;
    return {
      allowed: false,
      errorCode: "plan_limit_exceeded",
      errorMessage,
      httpStatus: 429,
      usage: {
        currentUsage: metric.currentUsage,
        limit: metric.limit,
        metric: metric.metric,
      },
    };
  }

  // Metered (100% → ceiling) — allow, accruing at-cost overage.
  if (metric.status === "metered") {
    const overageDollars = computeOverageDollars(metric.currentUsage, metric.limit);
    // OPERATOR ALERT: a workspace metering past the would-be default ceiling
    // WITH its abuse ceiling disabled (null) is accruing unbounded overage with
    // no cutoff — exactly the runaway-loop / compromised-key case the ceiling
    // exists to bound. Elevate to log.error (matching the #3428 fail-open alert
    // pattern) so it's distinguishable from an ordinary 101% metered warning and
    // an operator can scope the uncapped exposure. Capped-ceiling workspaces
    // hard-block before reaching this depth, so this only fires for a
    // deliberately-uncapped one. (Only reachable under `continue` — `cutoff`
    // clamps the ceiling to 100% and never leaves it disabled.)
    if (ceilingPercent === null && metric.usagePercent >= DEFAULT_ABUSE_CEILING_PERCENT) {
      log.error(
        {
          orgId,
          metric: metric.metric,
          currentUsage: metric.currentUsage,
          limit: metric.limit,
          usagePercent: metric.usagePercent,
          overageDollars,
          reason: "abuse_ceiling_disabled_extreme_overage",
        },
        "Workspace at %d%% of credit with abuse ceiling DISABLED — unbounded overage accruing, no cutoff (review ATLAS_ABUSE_CEILING)",
        metric.usagePercent,
      );
    }
    log.warn(
      {
        orgId,
        metric: metric.metric,
        currentUsage: metric.currentUsage,
        limit: metric.limit,
        usagePercent: metric.usagePercent,
        overageDollars,
        threshold: "metered",
      },
      "Workspace in metered overage (%d%% of $%s credit, $%s so far) — allowing and billing at cost",
      metric.usagePercent,
      metric.limit.toFixed(2),
      overageDollars.toFixed(2),
    );
    const costSuffix =
      overageDollars > 0 ? ` You are in overage: ${formatUsd(overageDollars)} so far this period.` : "";
    return {
      allowed: true,
      warning: {
        code: "plan_limit_warning",
        message:
          `You have used your full included usage credit ` +
          `(${formatUsd(metric.currentUsage)} of ${formatUsd(metric.limit)}).` +
          costSuffix +
          ` Usage now bills at provider cost; upgrade or add seats for a larger credit.`,
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
      "Workspace approaching usage credit (%d%%)",
      metric.usagePercent,
    );
    return {
      allowed: true,
      warning: {
        code: "plan_limit_warning",
        message:
          `You are approaching your included usage credit ` +
          `(${metric.usagePercent}% used: ${formatUsd(metric.currentUsage)} of ${formatUsd(metric.limit)}).`,
        metrics: [metric],
      },
    };
  }

  // OK — no warning needed
  return { allowed: true };
}

/** Format a USD amount for user-facing copy, e.g. 12.5 → "$12.50". */
function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a per-metric usage status. The `usd` metric carries dollar amounts
 * (`currentUsage` = at-cost spend, `limit` = the included credit, #4038).
 *
 * `ceilingPercent` is the cutoff (percent of credit): usage at or above it
 * classifies as `hard_limit` (429 cutoff), the 100%→ceiling band is `metered`
 * (served at provider cost). When `null` (ceiling disabled) there is no cutoff —
 * usage past 100% stays `metered` no matter how high. When omitted (billing-page
 * / display callers that don't resolve the per-workspace setting) it defaults to
 * the conservative {@link DEFAULT_ABUSE_CEILING_PERCENT} so a display surface and
 * enforcement agree on the common (continue-policy) case; a `cutoff`-policy caller
 * passes {@link METERED_THRESHOLD} (100) explicitly.
 */
export function buildMetricStatus(
  metric: "usd",
  currentUsage: number,
  limit: number,
  ceilingPercent: number | null = DEFAULT_ABUSE_CEILING_PERCENT,
): PlanLimitStatus {
  if (limit <= 0) {
    // Non-positive credit — the dollar credit is always finite (no unlimited
    // sentinel; free/locked $0 are short-circuited upstream), so this is the
    // defensive 0-credit guard. Fail safe: treat as hard limit so a misconfigured
    // credit doesn't silently allow everything.
    log.error({ metric, limit }, "Invalid plan limit value — treating as hard limit");
    return { metric, currentUsage, limit, usagePercent: 999, status: "hard_limit" };
  }
  const usagePercent = Math.round((currentUsage / limit) * 100);
  return {
    metric,
    currentUsage,
    limit,
    usagePercent,
    status: classifyUsage(usagePercent, ceilingPercent),
  };
}

/**
 * Classify usage into the metered soft-cap bands (#3990).
 *
 * - `>= ceilingPercent` → `hard_limit` (the cutoff — the abuse ceiling under
 *   `continue`, or 100% of credit under `cutoff`). Skipped when `ceilingPercent`
 *   is null (ceiling disabled — pure metering, no cutoff).
 * - `>= 100%` → `metered` (over the credit, served at provider cost).
 * - `>= 80%` → `warning`.
 * - otherwise `ok`.
 *
 * The ceiling is checked first so it always wins over `metered`. A non-positive
 * ceiling is treated as disabled (defensive — `resolveAbuseCeilingPercent`
 * already maps 0 → null, but guarding here means a ceiling of 0 can never
 * classify EVERY usage, including 0%, as `hard_limit`).
 */
function classifyUsage(usagePercent: number, ceilingPercent: number | null): OverageStatus {
  if (ceilingPercent !== null && ceilingPercent > 0 && usagePercent >= ceilingPercent) return "hard_limit";
  if (usagePercent >= METERED_THRESHOLD) return "metered";
  if (usagePercent >= WARNING_THRESHOLD) return "warning";
  return "ok";
}

const SEVERITY_ORDER: Record<OverageStatus, number> = {
  ok: 0,
  warning: 1,
  // `soft_limit` is retained in the wire union for back-compat; the current
  // classifier never returns it, but ordering it between warning and metered
  // keeps any legacy value sortable.
  soft_limit: 2,
  metered: 3,
  hard_limit: 4,
};

/** Exported for tests. */
export function severityOf(status: OverageStatus): number {
  return SEVERITY_ORDER[status];
}

/**
 * Days remaining in a workspace's trial, for surfacing in MCP tool responses
 * (ADR-0018 / #3651). Returns `null` when there is nothing to surface: no
 * internal DB, no org, the workspace is absent, or it isn't on the `trial`
 * tier. Otherwise the `trial-state` countdown — whole days until the
 * effective trial end, floored at 0 (an already-lapsed trial reports 0, not
 * a negative).
 *
 * Never throws — a lookup failure logs and returns `null`, so a caller can
 * attach the line opportunistically without risking the underlying response.
 * Lives here (not in `trial-state`) because it owns the cached-workspace
 * lookup; the derivation itself is `trial-state`'s.
 */
export async function getTrialDaysRemaining(
  orgId: string | undefined,
): Promise<number | null> {
  if (!orgId || !hasInternalDB()) return null;
  let workspace: WorkspaceRow | null;
  try {
    workspace = await getCachedWorkspace(orgId);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to read workspace for trial days-remaining — omitting from response",
    );
    return null;
  }
  if (!workspace || !isTrialTier(workspace.plan_tier)) return null;
  return trialDaysRemaining(workspace);
}

// ---------------------------------------------------------------------------
// Resource limit enforcement — every member of `CappedResource`
// ---------------------------------------------------------------------------

/**
 * Outcome of a resource-limit check.
 *
 * The two `allowed: false` arms are deliberately distinct so callers can
 * map them to different HTTP statuses — mirroring the `plan_limit_exceeded`
 * (429) vs `billing_check_failed` (503) split in {@link checkPlanLimits}:
 *
 *  - `cap_reached` — the workspace is genuinely at/over its plan cap. The
 *    actionable response is "upgrade your plan" — 429 `plan_limit_exceeded`
 *    for chat integrations, 403 `plan_upgrade_required` for knowledge
 *    collections. Carries `limit` (the cap that was hit) and `tier` (the plan
 *    that set it).
 *  - `check_failed` — we could NOT determine the count (DB error, missing
 *    row). Fail-closed: the request is blocked, but the actionable response
 *    is "try again" (503), NOT "upgrade your plan". Carries no `limit`/`tier`
 *    — there is no meaningful cap to report.
 *
 * `tier` rides on the denial so a caller composing an upgrade prompt never has
 * to re-resolve the workspace (#4235): a second `getCachedWorkspace` read can
 * return a DIFFERENT tier (60s per-replica TTL) or fault outright, which would
 * make the prompt name a plan that didn't set the cap it quotes.
 */
export type ResourceLimitResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "cap_reached";
      readonly errorMessage: string;
      readonly limit: number;
      readonly tier: PlanTier;
    }
  | { readonly allowed: false; readonly reason: "check_failed"; readonly errorMessage: string };

/** Plan-capped resources. Each maps to a `PlanLimits` field. */
export type CappedResource =
  | "seats"
  | "connections"
  | "chat_integrations"
  | "knowledge_collections";

/**
 * Check whether adding `pending` more of a {@link CappedResource} would exceed
 * the plan's limit for the given workspace.
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
    knowledge_collections: limits.maxKnowledgeCollections,
  } satisfies Record<CappedResource, number>)[resource];

  if (isUnlimited(cap)) {
    return { allowed: true };
  }

  if (currentCount >= cap) {
    const resourceLabel = ({
      seats: cap === 1 ? "seat" : "seats",
      connections: cap === 1 ? "connection" : "connections",
      chat_integrations: cap === 1 ? "chat integration" : "chat integrations",
      knowledge_collections: cap === 1 ? "knowledge collection" : "knowledge collections",
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
      tier,
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Chat integration cap (#2953, atomic install gate #3001)
// ---------------------------------------------------------------------------

/** Message surfaced when the count can't be determined (fail-closed → 503). */
const CHAT_CAP_CHECK_FAILED_MSG = "Unable to verify plan limits. Please try again.";

/**
 * Numeric namespace for the per-workspace install advisory lock — the
 * `classkey` arg of the two-arg `pg_advisory_xact_lock(int4, int4)`.
 *
 * Postgres keeps the single-arg `pg_advisory_lock(bigint)` and two-arg
 * `(int4, int4)` lock spaces fully disjoint, so this lock can never collide
 * with any single-arg user regardless of value (migrations
 * `hashtext('atlas_migrations')`, `rotate-encryption-key` `0x1f47`,
 * `backfill-plugin-config` `0x1f42`). Its peers in the two-arg space are
 * `lead-outbox` (2870), `last-admin` (3158), `stripe-subscription` (3445),
 * `demo-seed` (3683), and `knowledge-install` (4235) — all pairwise distinct.
 * Value is this issue's number.
 */
const CHAT_INSTALL_LOCK_NAMESPACE = 3001;

/**
 * Counts the workspace's chat-pillar installs, partitioned into the platform
 * being installed (`this_count`) vs. every other chat platform (`others`).
 *
 * Exported so the real-Postgres test (#2999) exercises the EXACT aggregate the
 * cap decision runs on — a typo in the FILTER predicate, an inverted `<>`/`=`,
 * or a dropped `status <> 'archived'` would otherwise pass every mock-based
 * test. `$1` = workspace id, `$2` = catalog id of the platform being installed.
 *
 * The cap counts every `workspace_plugins` row with `pillar = 'chat'`. Six
 * chat handlers write such a row today (Slack, Discord, Telegram, Teams,
 * gchat, WhatsApp), so all six consume a slot in this count. Only Slack and
 * Discord run their INSERT through the atomic gate
 * ({@link checkChatIntegrationLimitAndInstall}); the other four still persist
 * via a direct `internalQuery` UPSERT, so they are *counted* but their own
 * install isn't *serialized* against a concurrent net-new install — they move
 * onto the gate when they adopt the unified install path (#2994).
 */
export const CHAT_INTEGRATION_COUNT_SQL = `SELECT
   COUNT(*) FILTER (WHERE catalog_id <> $2)::int AS others,
   COUNT(*) FILTER (WHERE catalog_id = $2)::int  AS this_count
 FROM workspace_plugins
 WHERE workspace_id = $1
   AND pillar = 'chat'
   AND status <> 'archived'`;

/**
 * What the shared read-only cap precheck ({@link capPrecheck}) needs. Derived
 * from {@link CapGatedInstallSpec} rather than hand-copied, so a field added
 * there can't silently fall out of the precheck: the precheck differs only in
 * dropping `lockNamespace`, because it deliberately takes no lock.
 */
type CapPrecheckSpec = Omit<CapGatedInstallSpec, "lockNamespace">;

/**
 * Read-only resource-cap precheck — the fail-fast gate that runs BEFORE the
 * expensive part of an install (#2998; generalized for Knowledge Base
 * collections in #4235).
 *
 * The atomic {@link capGatedInstall} is the correctness boundary, but by the
 * time it runs the caller may already have completed an entire OAuth dance
 * (Slack has minted a bot token and installed the app) or written a credential
 * — only to be refused. This lets a handler refuse an at-cap workspace before
 * any of that, so an at-cap Starter workspace never starts something it can't
 * finish.
 *
 * It is deliberately NOT serialized against concurrent installs and runs no
 * INSERT: it opens no transaction and takes no advisory lock. The atomic gate
 * remains the TOCTOU guard — a workspace can reach its cap between this
 * precheck and the write. This is a fail-fast precheck, not the correctness
 * boundary. It is also single-key: a handler planning N net-new collections in
 * one install must NOT loop this (every iteration would see the same pre-write
 * count and pass, leaving the atomic gate to refuse the (cap+1)-th mid-fan-out
 * and strand a partial install) — it calls
 * {@link checkKnowledgeCollectionFanOutLimit} once with the whole batch instead.
 *
 * Mirrors the atomic gate's enforcement skips and reconnect carve-out exactly,
 * so the two never disagree on a workspace that isn't racing itself:
 *   - No `orgId` / no internal DB → allowed (no enforcement context).
 *   - Workspace lookup *error* → `check_failed` (fail closed → 503 "try again").
 *   - No `organization` row (pre-migration / Better-Auth-only) → allowed (no
 *     plan, no cap — the same deliberate fail-open the atomic gate makes).
 *   - Reconnect/edit (`this_count > 0`) → allowed: re-installing an existing
 *     key never increases the distinct count, so a grandfathered over-cap
 *     workspace can still re-auth or edit what it owns.
 *   - Otherwise compare the *other* installs to the plan cap via
 *     {@link checkResourceLimit}.
 *
 * Returns a {@link ResourceLimitResult}: `cap_reached` (→ 429 for chat, 403
 * `plan_upgrade_required` for knowledge collections) and `check_failed` (→ 503
 * "try again") map to the same dispositions the atomic path surfaces, so
 * callers translate one set of arms regardless of which gate fired.
 */
async function capPrecheck(spec: CapPrecheckSpec): Promise<ResourceLimitResult> {
  const { orgId, resource, countSql, selfKey, checkFailedMessage, label } = spec;
  // No enforcement context — no cap to apply.
  if (!orgId || !hasInternalDB()) {
    return { allowed: true };
  }

  // Resolve the workspace plan. Fail closed on a lookup *error* (transient DB
  // fault → 503), the same posture as checkResourceLimit / the atomic gate.
  let workspace: WorkspaceRow | null;
  try {
    workspace = await getCachedWorkspace(orgId);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, selfKey, resource },
      `Failed to resolve workspace for ${label} cap precheck — blocking as precaution`,
    );
    return { allowed: false, reason: "check_failed", errorMessage: checkFailedMessage };
  }

  // No `organization` row → no plan → no cap. The ONLY deliberate fail-open
  // here, matching the atomic gate (a lookup *error* fails closed above; a
  // genuine *absence* allows).
  if (!workspace) {
    return { allowed: true };
  }

  // Count installs, partitioned the same way as the atomic gate (this key vs.
  // every other), via the SAME aggregate so the precheck and the write gate
  // never disagree.
  let counts: { others: number; this_count: number } | undefined;
  try {
    const rows = await internalQuery<{ others: number; this_count: number }>(countSql, [
      orgId,
      selfKey,
    ]);
    counts = rows[0];
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, selfKey, resource },
      `Failed to count ${label}s for cap precheck — blocking as precaution`,
    );
    return { allowed: false, reason: "check_failed", errorMessage: checkFailedMessage };
  }
  // The aggregate always returns exactly one row; an empty result means the
  // driver/query contract was violated. Fail closed rather than coerce the
  // absent count to 0 — that would silently breach the cap.
  if (!counts) {
    log.error(
      { orgId, selfKey, resource },
      `Count query for ${label} returned no row for cap precheck — blocking as precaution`,
    );
    return { allowed: false, reason: "check_failed", errorMessage: checkFailedMessage };
  }

  // Reconnect/edit (already installed) is never blocked — it doesn't grow the
  // distinct count, so skip the cap comparison entirely.
  if (counts.this_count > 0) {
    return { allowed: true };
  }

  // Net-new key → compare the *other* installs to the plan cap.
  // getCachedWorkspace warmed the cache above, so this reads from cache.
  return checkResourceLimit(orgId, resource, counts.others);
}

/**
 * Read-only chat-integration cap precheck — the pre-redirect gate (#2998).
 * Thin wrapper over {@link capPrecheck}; see it for the full contract.
 *
 * @param orgId - Workspace id. When absent (or no internal DB) there's no cap.
 * @param catalogId - Catalog row id of the platform being installed (e.g.
 *   `"catalog:slack"`). Excluded from the `others` count so reconnecting the
 *   same platform is never blocked.
 */
export function checkChatIntegrationLimit(
  orgId: string | undefined,
  catalogId: string,
): Promise<ResourceLimitResult> {
  return capPrecheck({
    orgId,
    resource: "chat_integrations",
    countSql: CHAT_INTEGRATION_COUNT_SQL,
    selfKey: catalogId,
    checkFailedMessage: CHAT_CAP_CHECK_FAILED_MSG,
    label: "chat-integration",
  });
}

/**
 * The `workspace_plugins` INSERT the gate runs inside its transaction. Raw
 * SQL + params (rather than a structured descriptor) because each caller owns
 * its own UPSERT shape; the gate stays agnostic and just executes it under the
 * lock. Every caller — the two chat handlers (#3005) and the twelve knowledge
 * collection handlers (#4235) — appends `RETURNING id` so the handler can read
 * back the persisted row id; the knowledge seam
 * (`upsertKnowledgeCollectionRow`) additionally REQUIRES it and rejects SQL
 * without it up front. Callers are trusted in-process code — this is
 * internal-DB write SQL, not user analytics SQL.
 */
export interface WorkspacePluginInsert {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Outcome of {@link capGatedInstall}. Mirrors the {@link ResourceLimitResult}
 * arms, so callers map `cap_reached` to their resource's upgrade disposition
 * (chat → 429 `plan_limit_exceeded`; knowledge collections → 403
 * `plan_upgrade_required`) and `check_failed` → 503 exactly as elsewhere. The
 * success arm additionally carries the INSERT's `RETURNING` rows — the two
 * chat handlers (#3005) and the twelve knowledge handlers (#4235) read the
 * upserted row id from them.
 *
 * `rows` is the INSERT's `RETURNING` output and **may be empty even on
 * success** when the SQL omits a `RETURNING` clause. A caller that reads a
 * column must guard for absence (see the handlers' `rows[0]?.id` check).
 */
export type CapGatedInstallResult<T extends Record<string, unknown> = Record<string, unknown>> =
  | { readonly allowed: true; readonly rows: readonly T[] }
  | {
      readonly allowed: false;
      readonly reason: "cap_reached";
      readonly errorMessage: string;
      readonly limit: number;
      readonly tier: PlanTier;
    }
  | { readonly allowed: false; readonly reason: "check_failed"; readonly errorMessage: string };

/**
 * Everything the shared atomic install gate ({@link capGatedInstall}) needs to
 * enforce ONE {@link CappedResource} — extracted when the Knowledge Base
 * collections cap (#4235) needed the identical advisory-lock → recount →
 * decide → INSERT dance the chat-integration cap already ran (#3001). Both
 * public entries are now thin wrappers, so the two caps cannot drift in their
 * fail-closed arms.
 */
interface CapGatedInstallSpec {
  /** Workspace id. When absent (or no internal DB) the INSERT runs unlocked. */
  readonly orgId: string | undefined;
  /** Which `PlanLimits` cap the recount is compared against. */
  readonly resource: CappedResource;
  /** `classkey` of the two-arg `pg_advisory_xact_lock` — one per resource. */
  readonly lockNamespace: number;
  /**
   * Aggregate returning exactly one row of `{ others, this_count }` for
   * `($1 = orgId, $2 = selfKey)`. `this_count > 0` is the reconnect/edit
   * carve-out (never blocked); `others` is what the cap is compared against.
   */
  readonly countSql: string;
  /** `$2` of {@link countSql} — the identity excluded from the `others` count. */
  readonly selfKey: string;
  /** Message on the fail-closed `check_failed` arm (→ 503 "try again"). */
  readonly checkFailedMessage: string;
  /** Log-facing resource label, e.g. `"chat-integration"`. */
  readonly label: string;
}

/**
 * Atomically enforce ONE resource cap and run the `workspace_plugins` INSERT in
 * a single transaction — the shared engine behind
 * {@link checkChatIntegrationLimitAndInstall} (#3001) and
 * {@link checkKnowledgeCollectionLimitAndInstall} (#4235).
 *
 * The cap used to be a read-only precheck followed by a *separate* INSERT, so
 * two **distinct** net-new resources installing concurrently (e.g. Slack and
 * Discord OAuth callbacks completing in the same window while the workspace is
 * one under its cap) could both pass the precheck and both insert, landing the
 * workspace one over its cap. (The same-key case was already safe — the
 * conflict target collapses a duplicate install into an UPSERT/reconnect, which
 * is always allowed.)
 *
 * This closes that window:
 *   1. Resolve the workspace plan up front (outside the transaction). This
 *      warms the workspace cache so the in-transaction cap check reads from
 *      cache instead of acquiring a *second* pooled connection while we hold
 *      this transaction's client — and lets us fail closed before taking the
 *      lock if the workspace lookup errors. A workspace with no `organization`
 *      row (pre-migration / Better-Auth-only) has no plan and therefore no
 *      cap, so it short-circuits to a direct INSERT with no lock — the one
 *      deliberate fail-open, distinct from the DB-error case which fails closed.
 *   2. `pg_advisory_xact_lock(namespace, hashtext(workspaceId))` — a
 *      transaction-scoped advisory lock keyed on the workspace, released
 *      automatically on COMMIT/ROLLBACK. Concurrent installs for the *same*
 *      workspace and resource serialize on it.
 *   3. Re-count installs INSIDE the lock, on the same client — this is the read
 *      the cap decision is based on, now serialized so a concurrent install
 *      can't slip a row in between the count and our INSERT.
 *   4. If a net-new install would breach the cap, ROLLBACK and return
 *      `cap_reached`. Otherwise run the caller's INSERT and COMMIT.
 *
 * Reconnect/edit is never blocked: re-installing an already-present key
 * (`this_count > 0`) skips the cap comparison, so a grandfathered over-cap
 * workspace can still re-auth or edit what it owns.
 *
 * Returns a denied result for cap / billing-check failures (mapped to 429/403 /
 * 503 by the caller). **Throws** for genuine write-path failures (lock, INSERT,
 * or COMMIT errors) so the caller surfaces a 5xx — identical to the pre-#3001
 * behaviour where a failed INSERT re-threw.
 */
async function capGatedInstall<T extends Record<string, unknown> = Record<string, unknown>>(
  spec: CapGatedInstallSpec,
  insert: WorkspacePluginInsert,
): Promise<CapGatedInstallResult<T>> {
  const { orgId, resource, lockNamespace, countSql, selfKey, checkFailedMessage, label } = spec;
  // No enforcement context — no cap to apply, nothing to serialize, so run the
  // INSERT directly. (workspace_plugins lives in the internal DB, so when
  // !hasInternalDB the INSERT itself can't run — internalQuery throws, matching
  // the pre-#3001 behaviour.)
  if (!orgId || !hasInternalDB()) {
    const rows = await internalQuery<T>(insert.sql, insert.params as unknown[]);
    return { allowed: true, rows };
  }

  // Resolve (and cache-warm) the workspace plan before opening the transaction
  // so the in-transaction cap check below doesn't acquire a second pooled
  // connection while holding this transaction's client. Fail closed if the
  // lookup errors — before taking the lock.
  let workspace: WorkspaceRow | null;
  try {
    workspace = await getCachedWorkspace(orgId);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, selfKey, resource },
      `Failed to resolve workspace for ${label} cap — blocking as precaution`,
    );
    return { allowed: false, reason: "check_failed", errorMessage: checkFailedMessage };
  }

  // No `organization` row → no plan tier → no cap to enforce (pre-migration /
  // Better-Auth-only workspace). This is the ONLY deliberate fail-open in this
  // gate — a workspace lookup *error* fails closed above, a genuine *absence*
  // allows. Run the INSERT directly with no lock; there's nothing to serialize.
  if (!workspace) {
    const rows = await internalQuery<T>(insert.sql, insert.params as unknown[]);
    return { allowed: true, rows };
  }

  let client: InternalPoolClient;
  try {
    client = await getInternalDB().connect();
  } catch (err) {
    // Pool exhausted / DB down at acquire time — a transient infra fault, not a
    // plan breach. Fail closed as check_failed (→ 503 "try again") rather than
    // letting a raw pool error degrade into an unlabeled 500.
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, selfKey, resource },
      `Failed to acquire internal DB client for ${label} install gate — blocking as precaution`,
    );
    return { allowed: false, reason: "check_failed", errorMessage: checkFailedMessage };
  }
  // Destroy the client on a failed ROLLBACK so a dirty socket doesn't poison
  // the next borrower (matches cascadeWorkspaceDelete / hardDeleteWorkspace).
  let rollbackErr: Error | null = null;
  const rollback = async (): Promise<void> => {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { orgId, selfKey, err: rollbackErr.message },
        `ROLLBACK failed during ${label} install gate — client will be destroyed`,
      );
    });
  };

  try {
    await client.query("BEGIN");
    // Transaction-scoped advisory lock keyed on the workspace. hashtext maps
    // the text workspace id to the int4 the lock takes; a cross-workspace hash
    // collision only costs extra serialization, never correctness. Released
    // automatically on COMMIT/ROLLBACK.
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
      lockNamespace,
      orgId,
    ]);

    // Re-count under the lock — transaction-consistent, on the SAME client (not
    // via internalQuery, which may use a different pooled connection).
    let counts: { others: number; this_count: number } | undefined;
    try {
      const res = await client.query(countSql, [orgId, selfKey]);
      counts = res.rows[0] as { others: number; this_count: number } | undefined;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), orgId, selfKey, resource },
        `Failed to count ${label}s under lock — blocking as precaution`,
      );
      await rollback();
      return { allowed: false, reason: "check_failed", errorMessage: checkFailedMessage };
    }
    // The aggregate always returns exactly one row; an empty result means the
    // driver/query contract was violated. Fail closed rather than coerce the
    // absent count to 0 — that would silently breach the cap.
    if (!counts) {
      log.error(
        { orgId, selfKey, resource },
        `Count query for ${label} returned no row under lock — blocking as precaution`,
      );
      await rollback();
      return { allowed: false, reason: "check_failed", errorMessage: checkFailedMessage };
    }

    // Net-new key → compare the *other* installs of this resource to the plan
    // cap. Reconnect/edit (this_count > 0) skips the comparison and is never
    // blocked. getCachedWorkspace was warmed above, so checkResourceLimit reads
    // from cache without a nested pool acquire.
    if (counts.this_count === 0) {
      const decision = await checkResourceLimit(orgId, resource, counts.others);
      if (!decision.allowed) {
        await rollback();
        return decision;
      }
    }

    const result = await client.query(insert.sql, insert.params as unknown[]);
    await client.query("COMMIT");
    return { allowed: true, rows: result.rows as T[] };
  } catch (err) {
    // Write-path failure (lock / INSERT / COMMIT) — log with gate context, roll
    // back, and re-throw so the caller surfaces a 5xx, as the pre-#3001
    // standalone INSERT did. Logging the originating error here means a
    // subsequent "ROLLBACK failed" warning isn't the only breadcrumb when COMMIT
    // was the real cause.
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, selfKey, resource },
      `Install gate write-path failed for ${label} — rolling back`,
    );
    await rollback();
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
}

/**
 * Atomically enforce the chat-integration cap and run the `workspace_plugins`
 * INSERT in one transaction (#3001). Thin wrapper over {@link capGatedInstall}
 * — see that function for the full lock/recount/decide contract.
 *
 * @param orgId - Workspace id. When absent (or no internal DB) there's no cap
 *   to apply, so the INSERT runs directly with no lock.
 * @param catalogId - Catalog row id of the platform being installed (e.g.
 *   `"catalog:slack"`). Excluded from the `others` count so reconnecting the
 *   same platform is never blocked.
 * @param insert - The `workspace_plugins` INSERT to run inside the gate. Its
 *   `RETURNING` rows (if any) come back on the success arm.
 */
export function checkChatIntegrationLimitAndInstall<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  orgId: string | undefined,
  catalogId: string,
  insert: WorkspacePluginInsert,
): Promise<CapGatedInstallResult<T>> {
  return capGatedInstall<T>(
    {
      orgId,
      resource: "chat_integrations",
      lockNamespace: CHAT_INSTALL_LOCK_NAMESPACE,
      countSql: CHAT_INTEGRATION_COUNT_SQL,
      selfKey: catalogId,
      checkFailedMessage: CHAT_CAP_CHECK_FAILED_MSG,
      label: "chat-integration",
    },
    insert,
  );
}

// ---------------------------------------------------------------------------
// Knowledge Base collections cap (#4235)
// ---------------------------------------------------------------------------



/**
 * Namespace for the per-workspace knowledge-collection install advisory lock —
 * the `classkey` arg of the two-arg `pg_advisory_xact_lock(int4, int4)`. Value
 * is this issue's number, and is distinct from every other two-arg user
 * (`lead-outbox` 2870, chat-install 3001, last-admin 3158, stripe-subscription
 * 3445, demo-seed 3683) so knowledge installs never serialize behind them.
 */
const KNOWLEDGE_INSTALL_LOCK_NAMESPACE = 4235;

/**
 * Counts the workspace's knowledge collections, partitioned into the collection
 * being installed (`this_count`) vs. every other collection (`others`).
 *
 * A *collection* is one `pillar = 'knowledge'` `workspace_plugins` row keyed by
 * `install_id` (the collection slug) — so the partition is by `install_id`, NOT
 * by `catalog_id` as the chat aggregate is: knowledge is multi-instance, and a
 * workspace legitimately holds several collections from the same catalog (e.g.
 * one Zendesk collection per brand). Archived collections don't count; their
 * documents stay archived until an explicit re-ingest (ADR-0028 §5).
 *
 * Exported so the real-Postgres test exercises the EXACT aggregate the cap
 * decision runs on — a typo in the FILTER predicate, an inverted `<>`/`=`, or a
 * dropped `status <> 'archived'` would otherwise pass every mock-based test.
 */
export const KNOWLEDGE_COLLECTION_COUNT_SQL = `SELECT
   COUNT(*) FILTER (WHERE install_id <> $2)::int AS others,
   COUNT(*) FILTER (WHERE install_id = $2)::int  AS this_count
 FROM workspace_plugins
 WHERE workspace_id = $1
   AND pillar = 'knowledge'
   AND status <> 'archived'`;

/**
 * Read-only Knowledge Base collections precheck — the pre-write gate every
 * knowledge form handler runs before it validates upstream credentials or
 * writes a `knowledge_sync_credentials` row, so an at-cap workspace is refused
 * before a secret is ever persisted. Thin wrapper over {@link capPrecheck};
 * {@link checkKnowledgeCollectionLimitAndInstall} remains the TOCTOU guard.
 *
 * @param orgId - Workspace id. When absent (or no internal DB) there's no cap.
 * @param collectionSlug - The collection's `install_id`. Excluded from the
 *   `others` count, so editing an existing collection is never blocked.
 */
export function checkKnowledgeCollectionLimit(
  orgId: string | undefined,
  collectionSlug: string,
): Promise<ResourceLimitResult> {
  return capPrecheck({
    orgId,
    resource: "knowledge_collections",
    countSql: KNOWLEDGE_COLLECTION_COUNT_SQL,
    selfKey: collectionSlug,
    checkFailedMessage: KNOWLEDGE_CAP_CHECK_FAILED_MSG,
    label: "knowledge-collection",
  });
}

/**
 * Batch variant of {@link checkKnowledgeCollectionLimit} for the **fan-out**
 * handlers — Zendesk (one collection per brand), Front (per knowledge base),
 * Freshdesk (per category), Help Scout (per site) — which create N collections
 * from one install submit (#4235).
 *
 * Looping the single-key precheck would pass N times against the same pre-write
 * count, so the atomic gate would refuse the (cap+1)-th *after* earlier brands
 * had already written their rows and credentials — a partial install the admin
 * then has to unpick. This compares the whole batch up front.
 *
 * The decision is on NET-NEW growth, not batch size:
 *   - `others` = collections outside the batch; `this_count` = how many of the
 *     batch already exist, so the workspace holds `others + this_count` today.
 *   - `netNew = collectionSlugs.length - this_count`.
 *   - `netNew <= 0` (a pure re-install / edit) is ALWAYS allowed, so a
 *     workspace that dropped a tier can still re-run the install for what it
 *     already owns — the same grandfathering the single-key path applies.
 *   - Otherwise the post-install total is `others + this_count + netNew`, and
 *     `checkResourceLimit` blocks at `>= cap`, so it is handed
 *     `others + this_count + netNew - 1` ("one more would breach").
 *
 * Like every precheck this takes no lock; {@link checkKnowledgeCollectionLimitAndInstall}
 * remains the correctness boundary for each individual row.
 */
export async function checkKnowledgeCollectionFanOutLimit(
  orgId: string | undefined,
  collectionSlugs: readonly string[],
): Promise<ResourceLimitResult> {
  if (!orgId || !hasInternalDB() || collectionSlugs.length === 0) {
    return { allowed: true };
  }

  let counts: { others: number; this_count: number } | undefined;
  try {
    const rows = await internalQuery<{ others: number; this_count: number }>(
      KNOWLEDGE_COLLECTION_FANOUT_COUNT_SQL,
      [orgId, [...collectionSlugs]],
    );
    counts = rows[0];
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, planned: collectionSlugs.length },
      "Failed to count knowledge collections for the fan-out cap precheck — blocking as precaution",
    );
    return {
      allowed: false,
      reason: "check_failed",
      errorMessage: KNOWLEDGE_CAP_CHECK_FAILED_MSG,
    };
  }
  // The aggregate always returns exactly one row; an empty result means the
  // driver/query contract was violated. Fail closed rather than coerce the
  // absent count to 0 — that would silently breach the cap.
  if (!counts) {
    log.error(
      { orgId, planned: collectionSlugs.length },
      "Fan-out knowledge-collection count query returned no row — blocking as precaution",
    );
    return {
      allowed: false,
      reason: "check_failed",
      errorMessage: KNOWLEDGE_CAP_CHECK_FAILED_MSG,
    };
  }

  // A pure re-install adds nothing, so it is never measured against the cap.
  const netNew = collectionSlugs.length - counts.this_count;
  if (netNew <= 0) return { allowed: true };

  const existingTotal = counts.others + counts.this_count;
  return checkResourceLimit(
    orgId,
    "knowledge_collections",
    existingTotal + netNew - 1,
  );
}

/**
 * Partitions the workspace's knowledge collections against the batch being
 * installed: `others` are outside it, `this_count` are members of it that
 * already exist (the re-install carve-out). Exported so the real-Postgres test
 * executes this exact aggregate — an inverted `<> ALL` / `= ANY` would pass
 * every mock test while either refusing a plain re-install or ignoring the
 * workspace's existing collections entirely.
 */
export const KNOWLEDGE_COLLECTION_FANOUT_COUNT_SQL = `SELECT
   COUNT(*) FILTER (WHERE install_id <> ALL($2::text[]))::int AS others,
   COUNT(*) FILTER (WHERE install_id = ANY($2::text[]))::int  AS this_count
 FROM workspace_plugins
 WHERE workspace_id = $1
   AND pillar = 'knowledge'
   AND status <> 'archived'`;

/**
 * Atomically enforce the per-tier Knowledge Base **collections** cap
 * (`PlanLimits.maxKnowledgeCollections`, #4235) and run the collection UPSERT
 * in one transaction. Thin wrapper over {@link capGatedInstall} — same
 * lock/recount/decide contract the chat-integration cap uses, so two knowledge
 * collections created concurrently can't both slip past a shared last slot.
 *
 * Editing / re-installing an existing collection slug (`this_count > 0`) is
 * never blocked, so a workspace that dropped a tier keeps what it has and is
 * simply unable to add more — the same grandfathering the sibling caps apply.
 *
 * @param orgId - Workspace id. When absent (or no internal DB) there's no cap.
 * @param collectionSlug - The collection's `install_id`. Excluded from the
 *   `others` count.
 * @param insert - The collection UPSERT to run inside the gate.
 */
export function checkKnowledgeCollectionLimitAndInstall<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  orgId: string | undefined,
  collectionSlug: string,
  insert: WorkspacePluginInsert,
): Promise<CapGatedInstallResult<T>> {
  return capGatedInstall<T>(
    {
      orgId,
      resource: "knowledge_collections",
      lockNamespace: KNOWLEDGE_INSTALL_LOCK_NAMESPACE,
      countSql: KNOWLEDGE_COLLECTION_COUNT_SQL,
      selfKey: collectionSlug,
      checkFailedMessage: KNOWLEDGE_CAP_CHECK_FAILED_MSG,
      label: "knowledge-collection",
    },
    insert,
  );
}

