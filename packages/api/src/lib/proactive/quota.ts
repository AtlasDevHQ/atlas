/**
 * Proactive chat monthly quota cap (#2301, PRD #2291).
 *
 * Workspace-level cap on classifier calls (`event_type = 'classify'`) per
 * calendar month, UTC. When the cap is reached the listener short-circuits
 * BEFORE running the classifier — paying only a DB read + a meter row to
 * record the skip — until the next month rolls over.
 *
 * Source of truth:
 *   - cap value     →  `workspace_proactive_config.monthly_classifier_cap`
 *                      (added by #2294) when set — an operator/admin
 *                      **override**. When NULL, the cap derives from the
 *                      workspace's plan tier
 *                      (`plans.ts:monthlyProactiveClassifierCap`, #3436) —
 *                      previously NULL meant unlimited, which left a
 *                      Starter workspace's classifier spend unbounded
 *                      unless an operator hand-set the column. Self-hosted
 *                      (`free` tier) and BYOT workspaces stay unlimited.
 *   - usage count   →  `proactive_meter_events` rows with
 *                      `event_type = 'classify'` and
 *                      `created_at >= start_of_current_month_utc`.
 *                      Hits the `(workspace_id, event_type, created_at desc)`
 *                      index from migration 0078, so the COUNT(*) over a
 *                      typical month's rows is a small bounded scan even
 *                      at MVP — no materialized view required until usage
 *                      patterns demand it.
 *
 * The pure `isOverQuota` + `startOfMonthUTC` functions are exported so unit
 * tests can pin the math without a DB round-trip. The cap reader sits
 * behind `hasInternalDB()` so the path is a no-op (returns "no cap, 0
 * usage, not exhausted") in mock-pool tests + zero-config dev.
 *
 * Note on `lib/` discipline: this module lives in `lib/`, never imports
 * from `api/routes/`, so the listener wiring + the analytics route can
 * both consume it without circular imports.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getCachedWorkspace } from "@atlas/api/lib/billing/enforcement";
import { getPlanLimits, isUnlimited } from "@atlas/api/lib/billing/plans";
import { createLogger } from "@atlas/api/lib/logger";
import type { ProactiveQuotaStatus } from "@useatlas/types";

const log = createLogger("proactive:quota");

/**
 * Local alias. The canonical wire shape lives in
 * `@useatlas/types/proactive` as `ProactiveQuotaStatus`; this name is
 * the existing API-side alias preserved for back-compat. Both sides
 * now reference the same type so plugin↔API can't drift.
 */
export type WorkspaceQuotaStatus = ProactiveQuotaStatus;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Return the UTC `Date` for the start of the calendar month containing
 * `now`. Caller passes `now` (rather than us reading `Date.now()`) so
 * unit tests can pin the rollover boundary deterministically — bug
 * fixed in flight: the alternative "compute on call" version made
 * the month-rollover test impossible to write without faking
 * `Date.now()` globally.
 *
 * UTC by design: a workspace-local timezone column lives in a future
 * 1.5.x slice. For 1.5.0 we ship UTC so the cap is well-defined the
 * second the meter is wired across SaaS regions; the visible drift
 * (an admin in PST sees the cap reset at 16:00 local on the last day
 * of the month) is fine for a quota-not-billing surface.
 */
export function startOfMonthUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Pure cap check.
 *
 * `cap = null` (or `undefined`) means "unlimited" — never exhausts.
 * `cap = 0` means "stop immediately" — even the first classify is over.
 * Negative caps are coerced to 0 so a misconfigured row fails closed
 * rather than letting a "−5" cap leak unlimited classifies.
 */
export function isOverQuota(count: number, cap: number | null | undefined): boolean {
  if (cap === null || cap === undefined) return false;
  const normalized = cap < 0 ? 0 : cap;
  return count >= normalized;
}

// ---------------------------------------------------------------------------
// DB-backed reads
// ---------------------------------------------------------------------------

// The canonical `WorkspaceQuotaStatus` shape lives in
// `@useatlas/types/proactive` (as `ProactiveQuotaStatus`) and is
// aliased at the top of this file. The local interface declaration
// was removed in the post-1.5.0 polish so plugin + API can't drift.

/**
 * Read the workspace's raw **override** cap column. Returns `null` when
 * the workspace has never had its proactive config materialised or the
 * column is NULL — meaning "no override; the plan-tier default applies"
 * (see {@link getEffectiveMonthlyClassifierCap}).
 */
export async function getMonthlyClassifierCap(
  workspaceId: string,
): Promise<number | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<{ monthly_classifier_cap: number | null }>(
    `SELECT monthly_classifier_cap
       FROM workspace_proactive_config
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (rows.length === 0) return null;
  return rows[0]!.monthly_classifier_cap;
}

/**
 * Resolve the cap the quota gate actually enforces (#3436):
 *
 *   1. `workspace_proactive_config.monthly_classifier_cap` when set —
 *      the operator/admin override wins in either direction (a Starter
 *      workspace can be granted more, a Business one clamped down).
 *      Deliberately checked BEFORE the BYOT bypass: the column applied
 *      to every workspace (BYOT included) before #3436, and an
 *      explicitly-set cap is a deliberate admin decision — BYOT only
 *      changes what an *unset* column defaults to.
 *   2. Otherwise the workspace's plan-tier default
 *      (`plans.ts:monthlyProactiveClassifierCap`); `-1` → `null`
 *      (unlimited — the `free`/self-hosted tier).
 *   3. BYOT workspaces default to unlimited — classifier calls run on
 *      their own key, mirroring the token-budget bypass.
 *   4. No workspace row (org id unknown to billing — e.g. managed-auth
 *      table not present) → `null`, preserving the pre-#3436 behavior
 *      for deployments without the billing surface.
 *
 * The plan read goes through `getCachedWorkspace` (60s TTL), so the
 * per-message listener path costs at most one extra cached lookup.
 */
export async function getEffectiveMonthlyClassifierCap(
  workspaceId: string,
): Promise<number | null> {
  const override = await getMonthlyClassifierCap(workspaceId);
  if (override !== null) return override;
  if (!hasInternalDB()) return null;

  const workspace = await getCachedWorkspace(workspaceId);
  if (!workspace) return null;
  if (workspace.byot) return null;

  const tierCap = getPlanLimits(workspace.plan_tier).monthlyProactiveClassifierCap;
  return isUnlimited(tierCap) ? null : tierCap;
}

/**
 * COUNT classify rows since `startOfMonthUTC(now)`. Uses the
 * `(workspace_id, event_type, created_at DESC)` index from 0078 so
 * the scan is bounded by the month's classify volume.
 *
 * `now` defaults to `new Date()` so production callers don't have to
 * thread a clock through every layer; tests inject the boundary.
 */
export async function getClassifyCountThisMonth(
  workspaceId: string,
  now: Date = new Date(),
): Promise<number> {
  if (!hasInternalDB()) return 0;
  const cutoff = startOfMonthUTC(now).toISOString();
  const rows = await internalQuery<{ count: string | number }>(
    `SELECT COUNT(*)::bigint AS count
       FROM proactive_meter_events
      WHERE workspace_id = $1
        AND event_type = 'classify'
        AND created_at >= $2`,
    [workspaceId, cutoff],
  );
  if (rows.length === 0) return 0;
  // `pg` returns BIGINT as a string — coerce defensively.
  const raw = rows[0]!.count;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(n) ? n : 0;
}

/**
 * One-shot read of `{ monthlyClassifierCap, classifyCountThisMonth,
 * capReached }`. The listener calls this on every channel message
 * BEFORE classification; the admin analytics endpoint calls it on
 * every render. Both are cheap thanks to the 0078 index.
 *
 * Fails open on read errors — `capReached: false` keeps Atlas
 * answering when the meter table hiccups. Reviewed and kept in #3436:
 * the failure window is one request, the `error`-level log is the
 * operator alert (plain pino — log-scrape dashboards, no
 * Sentry/PagerDuty on this path), and the listener stamps
 * `metadata.quotaReadFailed: true` on the post-classification meter
 * row so the per-workspace analytics rollup shows the per-message
 * bypass count too. A fail-closed alternative would turn an internal
 * DB blip into a silent product outage for every proactive workspace,
 * which is the worse trade for a quota-not-billing gate.
 */
export async function getWorkspaceQuotaStatus(
  workspaceId: string,
  now: Date = new Date(),
): Promise<WorkspaceQuotaStatus> {
  try {
    // Two queries instead of one JOIN: the cap row is tiny (1 row) and
    // the count is index-scanned. Splitting keeps the SQL readable +
    // lets `getMonthlyClassifierCap` be reused for the workspace-config
    // view in `admin-proactive.ts` later without re-deriving the cap.
    // The cap is the *effective* one (override-or-plan-tier, #3436), so
    // `monthlyClassifierCap` on the wire now reflects what the gate
    // enforces — admin usage bars show the plan default, not blank.
    const [cap, count] = await Promise.all([
      getEffectiveMonthlyClassifierCap(workspaceId),
      getClassifyCountThisMonth(workspaceId, now),
    ]);
    return {
      monthlyClassifierCap: cap,
      classifyCountThisMonth: count,
      capReached: isOverQuota(count, cap),
    };
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        workspaceId,
      },
      "Proactive quota read failed — failing open (Atlas keeps answering, monthly cap NOT enforced this request)",
    );
    return {
      monthlyClassifierCap: null,
      classifyCountThisMonth: 0,
      capReached: false,
      readFailed: true,
    };
  }
}
