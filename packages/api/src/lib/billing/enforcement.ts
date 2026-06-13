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
  getInternalDB,
  getWorkspaceDetails,
  internalQuery,
  type InternalPoolClient,
  type WorkspaceRow,
} from "@atlas/api/lib/db/internal";
import { getCurrentPeriodUsage } from "@atlas/api/lib/metering";
import { getSeatCount, SeatCountUnavailableError } from "./seat-count";
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
  | { allowed: false; errorCode: "subscription_required"; errorMessage: string; httpStatus: 403 }
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
    return {
      allowed: false,
      errorCode: "subscription_required",
      errorMessage:
        "Your subscription has ended. Resubscribe from the billing page to continue using Atlas.",
      httpStatus: 403,
    };
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

  // Token budget check — budget scales with seat count
  const totalBudget = computeTokenBudget(tier, seatCount);
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
 * `backfill-plugin-config` `0x1f42`). The only peer in the two-arg space is
 * `lead-outbox` (`2870`), and `3001 ≠ 2870` keeps them disjoint there too.
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
 * Read-only chat-integration cap precheck — the pre-redirect gate (#2998).
 *
 * {@link checkChatIntegrationLimitAndInstall} is the *atomic* check-and-INSERT
 * the chat handlers run at OAuth callback time. But by callback time the
 * customer has already completed the entire OAuth dance — Slack has minted a
 * bot token and installed the app — only to be refused. This function lets a
 * handler refuse an at-cap workspace BEFORE it mints the provider redirect, so
 * an at-cap Starter workspace never starts a dance it can't finish.
 *
 * It is deliberately NOT serialized against concurrent installs and runs no
 * INSERT: it opens no transaction and takes no advisory lock. The callback's
 * atomic gate remains the TOCTOU guard — a workspace can reach its cap between
 * this precheck and the callback. This is a fail-fast precheck, not the
 * correctness boundary.
 *
 * Mirrors the atomic gate's enforcement skips and reconnect carve-out exactly,
 * so the two never disagree on a workspace that isn't racing itself:
 *   - No `orgId` / no internal DB → allowed (no enforcement context).
 *   - Workspace lookup *error* → `check_failed` (fail closed → 503 "try again").
 *   - No `organization` row (pre-migration / Better-Auth-only) → allowed (no
 *     plan, no cap — the same deliberate fail-open the atomic gate makes).
 *   - Reconnect (`this_count > 0`) → allowed: re-auth of an already-installed
 *     platform never increases the distinct count, so a grandfathered over-cap
 *     workspace can still re-auth what it owns.
 *   - Otherwise compare the *other* chat platforms to the plan cap via
 *     {@link checkResourceLimit}.
 *
 * Returns a {@link ResourceLimitResult}: `cap_reached` (→ 429 "upgrade") and
 * `check_failed` (→ 503 "try again") map to the same HTTP statuses the callback
 * path surfaces, so callers translate one set of arms regardless of which gate
 * fired.
 *
 * @param orgId - Workspace id. When absent (or no internal DB) there's no cap.
 * @param catalogId - Catalog row id of the platform being installed (e.g.
 *   `"catalog:slack"`). Excluded from the `others` count so reconnecting the
 *   same platform is never blocked.
 */
export async function checkChatIntegrationLimit(
  orgId: string | undefined,
  catalogId: string,
): Promise<ResourceLimitResult> {
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
      { err: err instanceof Error ? err.message : String(err), orgId, catalogId },
      "Failed to resolve workspace for chat-integration cap precheck — blocking as precaution",
    );
    return { allowed: false, reason: "check_failed", errorMessage: CHAT_CAP_CHECK_FAILED_MSG };
  }

  // No `organization` row → no plan → no cap. The ONLY deliberate fail-open
  // here, matching the atomic gate (a lookup *error* fails closed above; a
  // genuine *absence* allows).
  if (!workspace) {
    return { allowed: true };
  }

  // Count chat-pillar installs, partitioned the same way as the atomic gate
  // (this platform vs. every other), via the SAME aggregate so the precheck and
  // the callback gate never disagree.
  let counts: { others: number; this_count: number } | undefined;
  try {
    const rows = await internalQuery<{ others: number; this_count: number }>(
      CHAT_INTEGRATION_COUNT_SQL,
      [orgId, catalogId],
    );
    counts = rows[0];
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, catalogId },
      "Failed to count chat integrations for cap precheck — blocking as precaution",
    );
    return { allowed: false, reason: "check_failed", errorMessage: CHAT_CAP_CHECK_FAILED_MSG };
  }
  // The aggregate always returns exactly one row; an empty result means the
  // driver/query contract was violated. Fail closed rather than coerce the
  // absent count to 0 — that would silently breach the cap.
  if (!counts) {
    log.error(
      { orgId, catalogId },
      "Chat-integration count query returned no row for cap precheck — blocking as precaution",
    );
    return { allowed: false, reason: "check_failed", errorMessage: CHAT_CAP_CHECK_FAILED_MSG };
  }

  // Reconnect (already installed) is never blocked — re-auth doesn't grow the
  // distinct count, so skip the cap comparison entirely.
  if (counts.this_count > 0) {
    return { allowed: true };
  }

  // Net-new platform → compare the *other* chat platforms to the plan cap.
  // getCachedWorkspace warmed the cache above, so this reads from cache.
  return checkResourceLimit(orgId, "chat_integrations", counts.others);
}

/**
 * The `workspace_plugins` INSERT the gate runs inside its transaction. Raw
 * SQL + params (rather than a structured descriptor) because each caller owns
 * its own UPSERT shape; the gate stays agnostic and just executes it under the
 * lock. Both current callers (Slack and Discord) append `RETURNING id` so the
 * handler can read back the persisted row id (#3005). Callers are trusted
 * in-process code — this is internal-DB write SQL, not user analytics SQL.
 */
export interface WorkspacePluginInsert {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Outcome of {@link checkChatIntegrationLimitAndInstall}. Mirrors the
 * {@link ResourceLimitResult} arms (so callers map `cap_reached` → 429 and
 * `check_failed` → 503 exactly as elsewhere), but the success arm carries the
 * INSERT's `RETURNING` rows — the Slack and Discord handlers read the upserted
 * row id from them (#3005).
 *
 * `rows` is the INSERT's `RETURNING` output and **may be empty even on
 * success** when the SQL omits a `RETURNING` clause. A caller that reads a
 * column must guard for absence (see the handlers' `rows[0]?.id` check).
 */
export type ChatIntegrationInstallResult<T extends Record<string, unknown> = Record<string, unknown>> =
  | { allowed: true; readonly rows: readonly T[] }
  | { allowed: false; reason: "cap_reached"; errorMessage: string; limit: number }
  | { allowed: false; reason: "check_failed"; errorMessage: string };

/**
 * Atomically enforce the chat-integration cap and run the `workspace_plugins`
 * INSERT in a single transaction (#3001).
 *
 * The cap used to be a read-only precheck followed by a *separate* INSERT, so
 * two **distinct** net-new chat platforms installing concurrently (e.g. Slack
 * and Discord OAuth callbacks completing in the same window while the workspace
 * is one under its cap) could both pass the precheck and both insert, landing
 * the workspace one over its cap. (The same-platform case was already safe —
 * the `workspace_plugins_singleton` partial unique index collapses a duplicate
 * install into an UPSERT/reconnect, which is always allowed.)
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
 *      workspace serialize on it.
 *   3. Re-count chat installs INSIDE the lock, on the same client — this is
 *      the read the cap decision is based on, now serialized so a concurrent
 *      install can't slip a row in between the count and our INSERT.
 *   4. If a net-new platform would breach the cap, ROLLBACK and return
 *      `cap_reached`. Otherwise run the caller's INSERT and COMMIT.
 *
 * Reconnect is never blocked: re-auth of an already-installed platform
 * (`this_count > 0`) skips the cap comparison, so a grandfathered over-cap
 * workspace can still re-auth what it owns.
 *
 * Returns a denied result for cap / billing-check failures (mapped to 429 /
 * 503 by the caller). **Throws** for genuine write-path failures (lock, INSERT,
 * or COMMIT errors) so the caller surfaces a 5xx — identical to the pre-#3001
 * behaviour where a failed INSERT re-threw.
 *
 * @param orgId - Workspace id. When absent (or no internal DB) there's no cap
 *   to apply, so the INSERT runs directly with no lock.
 * @param catalogId - Catalog row id of the platform being installed (e.g.
 *   `"catalog:slack"`). Excluded from the `others` count.
 * @param insert - The `workspace_plugins` INSERT to run inside the gate. Its
 *   `RETURNING` rows (if any) come back on the success arm.
 */
export async function checkChatIntegrationLimitAndInstall<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  orgId: string | undefined,
  catalogId: string,
  insert: WorkspacePluginInsert,
): Promise<ChatIntegrationInstallResult<T>> {
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
      { err: err instanceof Error ? err.message : String(err), orgId, catalogId },
      "Failed to resolve workspace for chat-integration cap — blocking as precaution",
    );
    return { allowed: false, reason: "check_failed", errorMessage: CHAT_CAP_CHECK_FAILED_MSG };
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
      { err: err instanceof Error ? err.message : String(err), orgId, catalogId },
      "Failed to acquire internal DB client for chat-integration install gate — blocking as precaution",
    );
    return { allowed: false, reason: "check_failed", errorMessage: CHAT_CAP_CHECK_FAILED_MSG };
  }
  // Destroy the client on a failed ROLLBACK so a dirty socket doesn't poison
  // the next borrower (matches cascadeWorkspaceDelete / hardDeleteWorkspace).
  let rollbackErr: Error | null = null;
  const rollback = async (): Promise<void> => {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { orgId, catalogId, err: rollbackErr.message },
        "ROLLBACK failed during chat-integration install gate — client will be destroyed",
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
      CHAT_INSTALL_LOCK_NAMESPACE,
      orgId,
    ]);

    // Re-count under the lock — transaction-consistent, on the SAME client (not
    // via internalQuery, which may use a different pooled connection).
    let counts: { others: number; this_count: number } | undefined;
    try {
      const res = await client.query(CHAT_INTEGRATION_COUNT_SQL, [orgId, catalogId]);
      counts = res.rows[0] as { others: number; this_count: number } | undefined;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), orgId, catalogId },
        "Failed to count chat integrations under lock — blocking as precaution",
      );
      await rollback();
      return { allowed: false, reason: "check_failed", errorMessage: CHAT_CAP_CHECK_FAILED_MSG };
    }
    // The aggregate always returns exactly one row; an empty result means the
    // driver/query contract was violated. Fail closed rather than coerce the
    // absent count to 0 — that would silently breach the cap.
    if (!counts) {
      log.error(
        { orgId, catalogId },
        "Chat-integration count query returned no row under lock — blocking as precaution",
      );
      await rollback();
      return { allowed: false, reason: "check_failed", errorMessage: CHAT_CAP_CHECK_FAILED_MSG };
    }

    // Net-new platform → compare the *other* chat platforms to the plan cap.
    // Reconnect (this_count > 0) skips the comparison and is never blocked.
    // getCachedWorkspace was warmed above, so checkResourceLimit reads from
    // cache without a nested pool acquire.
    if (counts.this_count === 0) {
      const decision = await checkResourceLimit(orgId, "chat_integrations", counts.others);
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
      { err: err instanceof Error ? err.message : String(err), orgId, catalogId },
      "Chat-integration install gate write-path failed — rolling back",
    );
    await rollback();
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
}

