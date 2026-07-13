/**
 * Billing-period resolution (#3431).
 *
 * The token meter windows usage over a billing period. Two distinct
 * clocks were drifting apart before this module existed:
 *
 *   - `metering.ts:getCurrentPeriodUsage` used the **server-local**
 *     calendar month (`new Date(y, m, 1)`) — wrong on any non-UTC host,
 *     and never aligned to the customer's Stripe invoice anchor. A
 *     customer who subscribes on the 25th saw their token budget reset
 *     on the 1st, mid-invoice-cycle.
 *   - `proactive/quota.ts` deliberately used a **UTC** calendar month.
 *
 * This module is the single source of truth for both:
 *
 *   - `startOfMonthUTC` / `endOfMonthUTC` — the UTC calendar-month
 *     boundary (the fallback window for trial / unsubscribed orgs).
 *     `proactive/quota.ts` re-exports `startOfMonthUTC` from here so the
 *     two subsystems can never disagree on where a month starts.
 *   - `resolveBillingPeriod` — anchors on the Stripe subscription's
 *     `periodStart` / `periodEnd` when the org has an **active**
 *     subscription row, falling back to the UTC calendar month
 *     otherwise (trial, past_due, canceled, unsubscribed, or no
 *     internal DB).
 *
 * `lib/` discipline: this module lives in `lib/` and never imports from
 * `api/routes/`. It reads the Better-Auth `subscription` table directly
 * via `internalQuery` rather than through `billing/enforcement.ts`, so
 * `metering.ts` can consume it without pulling enforcement (and its
 * `getCurrentPeriodUsage` import) into a cycle.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("billing:period");

// ---------------------------------------------------------------------------
// Pure UTC calendar-month helpers
// ---------------------------------------------------------------------------

/**
 * UTC `Date` for the start of the calendar month containing `now`.
 * Caller passes `now` so tests can pin the rollover boundary without
 * faking `Date.now()` globally.
 *
 * UTC by design — a non-UTC server must not shift the month boundary by
 * its local offset. `proactive/quota.ts` re-exports this so the proactive
 * cap and the token meter agree to the millisecond.
 */
export function startOfMonthUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * UTC `Date` for the start of the month AFTER the one containing `now`
 * (i.e. the exclusive end of the current calendar month). `getUTCMonth()
 * + 1` rolls December → January of the next year correctly because
 * `Date.UTC` normalizes the overflow.
 */
export function endOfMonthUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

// ---------------------------------------------------------------------------
// Resolved period
// ---------------------------------------------------------------------------

export interface BillingPeriod {
  /** Inclusive start of the metering window. */
  start: Date;
  /** Exclusive end of the metering window — the moment usage resets. */
  end: Date;
  /**
   * Where the window came from:
   *   - `"stripe"` — anchored on an active subscription's period.
   *   - `"utc-month"` — UTC calendar-month fallback (trial / unsubscribed).
   */
  source: "stripe" | "utc-month";
}

/** Coerce a `pg` timestamptz (Date or ISO string) to a `Date`, or null. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve the billing period to meter `workspaceId` over.
 *
 * Anchors on the Stripe subscription's `periodStart` / `periodEnd` when
 * an **active** subscription row exists (the row the Better-Auth Stripe
 * plugin populates from `current_period_start` / `current_period_end`).
 * Only `status = 'active'` anchors — `trialing`, `past_due`, `unpaid`,
 * `canceled`, etc. fall back to the UTC calendar month so a trialing or
 * delinquent org meters on the same well-defined window as an
 * unsubscribed one.
 *
 * Fallback (UTC calendar month) applies when:
 *   - no internal DB is configured,
 *   - the `subscription` table doesn't exist yet (plugin not migrated),
 *   - no active row exists for the org, or
 *   - an active row exists but is missing period bounds.
 *
 * Read failures fall back rather than throw: metering is best-effort and
 * a UTC month is always a safe, well-defined window.
 *
 * @param workspaceId - The org / workspace id (Stripe `referenceId`).
 * @param now - Current time; injected so tests can pin boundaries.
 */
export async function resolveBillingPeriod(
  workspaceId: string,
  now: Date = new Date(),
): Promise<BillingPeriod> {
  const fallback: BillingPeriod = {
    start: startOfMonthUTC(now),
    end: endOfMonthUTC(now),
    source: "utc-month",
  };

  if (!hasInternalDB()) return fallback;

  let rows: Array<{ periodStart: Date | string | null; periodEnd: Date | string | null }>;
  try {
    rows = await internalQuery<{
      periodStart: Date | string | null;
      periodEnd: Date | string | null;
    }>(
      // Better Auth's subscription table has NO updatedAt/createdAt column;
      // periodStart (newest current-period start) is the right "most recent
      // subscription" proxy when a workspace carries more than one active row.
      // Ordering by a non-existent updatedAt threw "column updatedAt does not
      // exist" (42703) on every call, so this best-effort read ALWAYS hit the
      // catch and silently fell back to the UTC month. Same fix as
      // reconcile-plan-tiers.ts.
      `SELECT "periodStart", "periodEnd"
         FROM subscription
        WHERE "referenceId" = $1
          AND status = 'active'
        ORDER BY "periodStart" DESC NULLS LAST
        LIMIT 1`,
      [workspaceId],
    );
  } catch (err) {
    // Subscription table may not exist (Stripe plugin not migrated) or the
    // read may have hiccupped — fall back to the UTC month rather than fail
    // a best-effort meter read.
    log.debug(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      "Subscription period lookup failed — falling back to UTC calendar month",
    );
    return fallback;
  }

  const row = rows[0];
  if (!row) return fallback;

  const start = toDate(row.periodStart);
  const end = toDate(row.periodEnd);
  // An active row with missing/invalid bounds is treated as un-anchored —
  // the UTC month is a safe window until the next webhook fills them in.
  if (!start || !end) return fallback;

  // A present-but-STALE period must not anchor the meter. At renewal there is
  // a window where the stored bounds still describe the *previous* cycle —
  // the `customer.subscription.updated` webhook that advances
  // `current_period_start`/`_end` can lag (retries span hours/days). If `now`
  // is outside `[start, end)`, windowing usage over that dead range would
  // exclude the entire current cycle: `getCurrentPeriodUsage` returns 0, the
  // UI shows no usage, and `enforcement.ts` under-counts the budget (unlimited
  // spend until the webhook lands). Fall back to the UTC month, which always
  // contains `now`, until the bounds are refreshed. (Rolling the window
  // forward by a month would mis-handle annual subscriptions, whose period is
  // a year — the UTC month is the safe, cadence-agnostic choice.)
  if (now < start || now >= end) {
    log.debug(
      {
        workspaceId,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        now: now.toISOString(),
      },
      "Active subscription period does not contain now (stale bounds) — falling back to UTC calendar month",
    );
    return fallback;
  }

  return { start, end, source: "stripe" };
}
