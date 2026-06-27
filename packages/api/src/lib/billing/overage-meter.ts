/**
 * OverageMeter — idempotent, reconcilable Stripe Billing Meters reporter (#3992).
 *
 * Each billing period a paid workspace can run past its included token budget
 * (the metered soft-cap band in `enforcement.ts`, #3990). This module flushes
 * that overage to Stripe's Billing Meters API (`meter_events`) on a scheduler
 * tick so the customer is actually invoiced for it, and adds the per-tier
 * metered price as a SECOND subscription item so the meter has a price to bill
 * against.
 *
 * ## What is reported
 *
 * Overage is denominated in **output-equivalent tokens** (#3989) — the same
 * weighted unit `enforcement.ts` meters the budget in, so the value reported is
 * the real billed quantity. The shared `atlas_token_overage` meter (#3991) is
 * priced at $1 / 1M output-equivalent tokens (`plans.ts`
 * `overagePerMillionTokens = 1.0`).
 *
 * ## Idempotency + reconciliation (ledger-backed)
 *
 * `overage_meter_reports` records, per (org, billing period), the CUMULATIVE
 * overage already reported to Stripe (`reported_tokens`). Each tick:
 *
 *   1. compute the period's current overage (weighted usage − budget),
 *   2. delta = currentOverage − reported_tokens (floored at 0),
 *   3. if delta > 0, send ONE `meter_event` carrying `payload.value = delta`
 *      and `payload.stripe_customer_id`, then advance `reported_tokens` to the
 *      new cumulative.
 *
 * So the **same delta reported twice bills once**: the second tick sees the
 * advanced cumulative and computes a zero delta. The ledger is the primary
 * idempotency mechanism.
 *
 * Report-BEFORE-record is deliberate: a Stripe failure (the common case — a
 * transient 429 / timeout) leaves the ledger un-advanced and the delta is
 * retried next tick, so overage is never silently lost. The remaining hazard is
 * a crash in the sub-second window AFTER Stripe accepts the event but BEFORE the
 * ledger advances. The deterministic `meter_event` identifier closes it: it is
 * keyed on the **baseline** (`reported_tokens` BEFORE this report), NOT the new
 * cumulative — so a retry from the same un-advanced ledger reuses the SAME
 * identifier even if usage grew in between, and Stripe (which keeps the first
 * value per identifier within its rolling 24h window) never double-counts the
 * overlap. A baseline key fails toward a bounded, safe-direction under-bill in
 * that rare window — never a double-bill. (Keying on the cumulative would change
 * the identifier whenever usage grew between ticks and double-bill the overlap.)
 * Successive reports advance the baseline monotonically (the cumulative is
 * upserted with GREATEST, so a late/retried tick can never regress it), so each
 * identifier covers a distinct `[baseline, …)` range.
 *
 * ## Never reported
 *
 * BYOT workspaces accrue no metered usage (they bring their own keys and bypass
 * token enforcement entirely) and are excluded by the sweep scan; non-paid tiers
 * (free / trial / locked) are excluded by tier membership; and an unlimited- or
 * zero-budget workspace is skipped by the per-workspace budget check. All bail
 * before any meter event.
 *
 * ## Gating
 *
 * Needs `STRIPE_SECRET_KEY` (to call Stripe) + an internal DB (to hold the
 * ledger + read usage). No-ops cleanly otherwise (self-hosted never accrues
 * rows). Forked as a periodic fiber in `lib/effect/layers.ts`; the metered-item
 * seam runs on the Stripe webhook path in `lib/auth/server.ts`.
 */

import type Stripe from "stripe";

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getStripeClient } from "@atlas/api/lib/billing/stripe-client";
import { getCurrentPeriodUsage, type UsageCurrentPeriod } from "@atlas/api/lib/metering";
import { getSeatCount } from "@atlas/api/lib/billing/seat-count";
import {
  computeTokenBudget,
  isUnlimited,
  resolvePlanTierFromPriceId,
  type PaidPlanTier,
} from "@atlas/api/lib/billing/plans";
import { computeOverageTokens } from "@atlas/api/lib/billing/enforcement";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  OVERAGE_PRICE_ID_ENV_VAR_BY_TIER,
  type OveragePriceIdEnvVar,
} from "@atlas/api/lib/billing/config-validation";
import { createLogger } from "@atlas/api/lib/logger";
import { PLAN_TIERS, type PlanTier } from "@useatlas/types";

const log = createLogger("billing:overage-meter");

/** Stripe Billing Meter `event_name` for token overage (#3991). */
export const OVERAGE_METER_EVENT_NAME = "atlas_token_overage";

/**
 * The paid tiers that accrue billable token overage — DERIVED from the
 * drift-proof tier→price map so a new {@link PaidPlanTier} (which the map's
 * `satisfies` forces to be added there) automatically appears here too, rather
 * than being silently never-billed by a hand-maintained parallel list.
 */
const PAID_TIERS: readonly PaidPlanTier[] = Object.keys(
  OVERAGE_PRICE_ID_ENV_VAR_BY_TIER,
) as PaidPlanTier[];

/** `'starter', 'pro', 'business'` for the sweep scan's `IN (...)` — same SSOT. */
const PAID_TIERS_SQL_LIST = PAID_TIERS.map((t) => `'${t}'`).join(", ");

function isPaidTier(tier: PlanTier): tier is PaidPlanTier {
  return (PAID_TIERS as readonly string[]).includes(tier);
}

/**
 * How often the overage reporter ticks. Hourly: frequent enough that metered
 * usage lands well inside the period and Stripe's 35-day `meter_event`
 * acceptance window, infrequent enough to add no meaningful load (one indexed
 * org scan + a meter event only for workspaces actually in overage). Exported
 * so `layers.ts` references the same value the fiber is documented around;
 * `Effect.repeat(Schedule.spaced)` runs the tick once eagerly on boot.
 */
export const OVERAGE_REPORT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Resolve a paid tier's metered-overage Stripe Price ID. Reads the
 * platform-scoped setting (registry → env), hot-reloadable like the seat price
 * IDs. `resolve` is injected (defaulting to `getSettingAuto`) so the mapping is
 * unit-testable with a stub, mirroring `findMissingOveragePriceIds`.
 */
export function getOveragePriceIdForTier(
  tier: PaidPlanTier,
  resolve: (key: OveragePriceIdEnvVar) => string | undefined = getSettingAuto,
): string | undefined {
  const value = resolve(OVERAGE_PRICE_ID_ENV_VAR_BY_TIER[tier]);
  return value && value.length > 0 ? value : undefined;
}

/**
 * The reportable overage delta: how many output-equivalent tokens past what's
 * already been reported the workspace has now consumed. Floored at 0 — a
 * downward correction (usage re-counted lower, or a stale ledger ahead of
 * current) must never produce a NEGATIVE meter event (which would credit the
 * customer for usage they actually had). Pure.
 */
export function computeReportableDelta(
  currentOverageTokens: number,
  alreadyReportedTokens: number,
): number {
  if (!Number.isFinite(currentOverageTokens) || !Number.isFinite(alreadyReportedTokens)) {
    return 0;
  }
  return Math.max(0, Math.trunc(currentOverageTokens) - Math.trunc(alreadyReportedTokens));
}

/**
 * Deterministic Stripe `meter_event` identifier for a report. Keyed on the
 * BASELINE — the `reported_tokens` cumulative BEFORE this report — NOT the new
 * cumulative or the delta. The baseline is read from the ledger, which only
 * advances on a successful record, so a crash-before-record (or a concurrent
 * pod) retries from the SAME baseline and reuses the SAME identifier even if
 * usage grew in between. Stripe keeps the first value per identifier within its
 * rolling 24h window, so the overlap is never double-counted (it fails toward a
 * bounded under-bill, the safe direction — see the module doc). Successive
 * reports use strictly increasing baselines, so each identifier covers a
 * distinct `[baseline, …)` range.
 */
export function buildOverageEventIdentifier(
  orgId: string,
  periodStartISO: string,
  baselineTokens: number,
): string {
  const periodKey = Date.parse(periodStartISO);
  const period = Number.isFinite(periodKey) ? periodKey : periodStartISO;
  return `atlas-overage-${orgId}-${period}-${baselineTokens}`;
}

// ---------------------------------------------------------------------------
// Ledger access
// ---------------------------------------------------------------------------

/**
 * The cumulative overage tokens already reported to Stripe for `(orgId,
 * periodStart)`, or 0 when no row exists yet. Postgres returns `BIGINT` as a
 * string via `pg`, so coerce + validate rather than trust the wire type.
 */
export async function getReportedOverageTokens(
  orgId: string,
  periodStartISO: string,
): Promise<number> {
  if (!hasInternalDB()) return 0;
  const rows = await internalQuery<{ reported_tokens: number | string | null }>(
    `SELECT reported_tokens FROM overage_meter_reports
      WHERE org_id = $1 AND period_start = $2
      LIMIT 1`,
    [orgId, periodStartISO],
  );
  const raw = rows[0]?.reported_tokens;
  if (raw == null) return 0; // no row / NULL — fresh period
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    // Fail CLOSED (throw, never return 0). The NOT NULL + CHECK(>= 0) column
    // makes this unreachable, but a present-yet-uncoercible cumulative read as 0
    // would re-key the identifier on baseline 0 and re-report (double-bill) the
    // whole cumulative — the exact direction this module is built to avoid.
    // Throwing routes to the per-workspace sweep guard (warn + count failed +
    // skip + retry next tick): loud AND a safe under-bill, never a double-bill.
    throw new Error(
      `overage_meter_reports.reported_tokens is not a non-negative number for org ${orgId} period ${periodStartISO}: ${String(raw)}`,
    );
  }
  return parsed;
}

export interface OverageReportRecord {
  readonly orgId: string;
  readonly periodStartISO: string;
  readonly stripeCustomerId: string;
  /** New cumulative reported total for the period (NOT the delta). */
  readonly reportedTokens: number;
  readonly eventIdentifier: string;
}

/**
 * Upsert the ledger to the new cumulative reported total. `GREATEST` keeps
 * `reported_tokens` monotonic within a period — a late/retried tick carrying an
 * older cumulative can never regress it, which would re-report already-billed
 * tokens. `ON CONFLICT` keys on the composite PK `(org_id, period_start)`.
 */
export async function recordOverageReport(record: OverageReportRecord): Promise<void> {
  if (!hasInternalDB()) return;
  await internalQuery(
    `INSERT INTO overage_meter_reports
       (org_id, period_start, stripe_customer_id, reported_tokens, last_event_identifier, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (org_id, period_start) DO UPDATE SET
       reported_tokens = GREATEST(overage_meter_reports.reported_tokens, EXCLUDED.reported_tokens),
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       last_event_identifier = EXCLUDED.last_event_identifier,
       updated_at = now()`,
    [
      record.orgId,
      record.periodStartISO,
      record.stripeCustomerId,
      record.reportedTokens,
      record.eventIdentifier,
    ],
  );
}

// ---------------------------------------------------------------------------
// Per-workspace reporting
// ---------------------------------------------------------------------------

/**
 * A workspace row the period-overage sweep iterates over. Type alias (not
 * interface) so it satisfies `internalQuery`'s `Record<string, unknown>`
 * generic constraint via the implicit index signature (same reason the
 * reconcile/teardown row types are aliases).
 */
export type OverageWorkspaceRow = {
  readonly org_id: string;
  readonly plan_tier: string | null;
  readonly byot: boolean | null;
  readonly stripe_customer_id: string | null;
};

export type OverageReportOutcome = "reported" | "skipped";

/**
 * I/O dependencies of {@link reportWorkspaceOverage}, injected so the
 * orchestration (delta math, BYOT/unlimited skips, report-then-record ordering)
 * is unit-testable without `mock.module` — the Effect-style preference over
 * module mocking (CLAUDE.md). Defaults wire the real functions.
 */
export interface WorkspaceOverageDeps {
  readonly getSeatCount: (orgId: string) => Promise<number>;
  readonly getCurrentPeriodUsage: (orgId: string, now: Date) => Promise<UsageCurrentPeriod>;
  readonly getReportedOverageTokens: (orgId: string, periodStartISO: string) => Promise<number>;
  readonly recordOverageReport: (record: OverageReportRecord) => Promise<void>;
}

const defaultWorkspaceOverageDeps: WorkspaceOverageDeps = {
  getSeatCount,
  getCurrentPeriodUsage,
  getReportedOverageTokens,
  recordOverageReport,
};

/**
 * Report one workspace's current-period overage delta to the Stripe meter,
 * idempotently. Returns `"reported"` when a positive delta was sent, else
 * `"skipped"` (BYOT, non-paid/unlimited tier, no Stripe customer, or zero
 * delta). THROWS on a Stripe / DB failure so the caller's per-org guard logs it
 * and the un-advanced ledger retries next tick — overage is never silently lost.
 */
export async function reportWorkspaceOverage(
  stripe: Stripe,
  row: OverageWorkspaceRow,
  now: Date = new Date(),
  deps: WorkspaceOverageDeps = defaultWorkspaceOverageDeps,
): Promise<OverageReportOutcome> {
  // BYOT never accrues metered usage — they bring their own keys and bypass
  // token enforcement entirely (#3990). Checked first, defensively: the sweep's
  // scan already excludes BYOT, but this keeps the function boundary honest so
  // a direct caller can never report a BYOT workspace.
  if (row.byot === true) return "skipped";

  const tier = parseTier(row.plan_tier);
  if (!tier || !isPaidTier(tier)) return "skipped";
  if (!row.stripe_customer_id) return "skipped";

  const seatCount = await deps.getSeatCount(row.org_id);
  const budget = computeTokenBudget(tier, seatCount);
  // Unlimited budget → there is no "over budget", so nothing to meter.
  if (isUnlimited(budget) || budget <= 0) return "skipped";

  const usage = await deps.getCurrentPeriodUsage(row.org_id, now);
  // Denominate in output-equivalent tokens (#3989) — the same weighted unit the
  // budget is enforced in. `getCurrentPeriodUsage` already COALESCEs
  // `weighted_quantity` to the raw `quantity` for token rows predating
  // migration 0152 in its SQL aggregate, so `weightedTokenCount` is never under
  // raw for un-backfilled history. The `?? tokenCount` is a defensive belt
  // (matching `enforcement.ts`): if a future shape change made the field arrive
  // undefined, denominate on raw rather than silently treat usage as zero.
  const weightedUsage = usage.weightedTokenCount ?? usage.tokenCount;
  const currentOverage = computeOverageTokens(weightedUsage, budget);
  if (currentOverage <= 0) return "skipped";

  const reportedSoFar = await deps.getReportedOverageTokens(row.org_id, usage.periodStart);
  const delta = computeReportableDelta(currentOverage, reportedSoFar);
  if (delta <= 0) return "skipped";

  // Identifier is keyed on the BASELINE (reportedSoFar) — see
  // buildOverageEventIdentifier + the module doc for why this (not the new
  // cumulative) is what makes the crash-window backstop never double-bill.
  const identifier = buildOverageEventIdentifier(row.org_id, usage.periodStart, reportedSoFar);

  // Report to Stripe FIRST, then advance the ledger — see the module doc for
  // why this ordering (with the baseline-keyed identifier) never double-bills
  // and never silently loses overage on a transient Stripe failure.
  await stripe.billing.meterEvents.create({
    event_name: OVERAGE_METER_EVENT_NAME,
    payload: {
      stripe_customer_id: row.stripe_customer_id,
      value: String(delta),
    },
    identifier,
  });

  try {
    await deps.recordOverageReport({
      orgId: row.org_id,
      periodStartISO: usage.periodStart,
      stripeCustomerId: row.stripe_customer_id,
      reportedTokens: currentOverage,
      eventIdentifier: identifier,
    });
  } catch (err) {
    // Stripe HAS been billed by this point; only the ledger write failed. This
    // is a reconciliation hazard (the ledger lags what Stripe was told), NOT a
    // lost report — surface it distinctly so it isn't masked by the generic
    // "report failed" line in reportPeriodOverages, then re-throw so the tick
    // retries. The baseline-keyed identifier makes the retry safe: it reuses
    // the same identifier from the un-advanced ledger, so Stripe dedupes the
    // overlap rather than double-billing.
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        orgId: row.org_id,
        periodStart: usage.periodStart,
        cumulative: currentOverage,
        identifier,
      },
      "Stripe meter billed but ledger record failed — reconciliation required (will retry; dedup prevents double-bill)",
    );
    throw err instanceof Error ? err : new Error(String(err));
  }

  log.info(
    {
      orgId: row.org_id,
      tier,
      periodStart: usage.periodStart,
      delta,
      cumulative: currentOverage,
    },
    "Reported token overage delta to Stripe meter",
  );
  return "reported";
}

// ---------------------------------------------------------------------------
// Period sweep (scheduler tick)
// ---------------------------------------------------------------------------

export interface OverageReportSweepResult {
  /** Paid, non-BYOT, Stripe-customer workspaces examined this tick. */
  readonly scanned: number;
  /** Workspaces for which a positive overage delta was reported. */
  readonly reported: number;
  /** Workspaces with no reportable delta (no overage / already reported). */
  readonly skipped: number;
  /** Workspaces whose report failed — logged, left for the next tick. */
  readonly failed: number;
}

const EMPTY_SWEEP: OverageReportSweepResult = { scanned: 0, reported: 0, skipped: 0, failed: 0 };

/** The per-workspace reporter the sweep fans out to. Injectable for tests. */
export type ReportOneWorkspace = (
  stripe: Stripe,
  row: OverageWorkspaceRow,
  now: Date,
) => Promise<OverageReportOutcome>;

/**
 * One overage-reporting pass over every paid, non-BYOT workspace with a Stripe
 * customer and an active subscription. Idempotent and safe to run concurrently
 * across pods — each report is ledger-gated by the per-(org, period) cumulative
 * and a deterministic meter identifier. No-ops without Stripe or an internal DB.
 * Throws on the org-scan failure so the scheduler tick logs it and retries;
 * per-workspace failures are caught and counted, never abort the sweep.
 *
 * `reportOne` is injected (defaulting to {@link reportWorkspaceOverage}) so the
 * scan + fan-out is unit-testable without driving real usage/seat-count I/O.
 */
export async function reportPeriodOverages(
  now: Date = new Date(),
  reportOne: ReportOneWorkspace = reportWorkspaceOverage,
): Promise<OverageReportSweepResult> {
  if (!hasInternalDB()) return EMPTY_SWEEP;
  const stripe = getStripeClient();
  if (!stripe) return EMPTY_SWEEP;

  // Paid, non-BYOT, has a Stripe customer, and currently subscribed. BYOT is
  // excluded here (and re-checked in reportWorkspaceOverage); `byot IS NOT TRUE`
  // also covers a NULL byot (not BYOT). Only `status = 'active'` subscriptions
  // are metered — trialing/past_due/canceled don't invoice overage.
  const rows = await internalQuery<OverageWorkspaceRow>(
    `SELECT o.id AS org_id, o.plan_tier, o.byot, o."stripeCustomerId" AS stripe_customer_id
       FROM organization o
      WHERE o.plan_tier IN (${PAID_TIERS_SQL_LIST})
        AND o.byot IS NOT TRUE
        AND o."stripeCustomerId" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM subscription s
           WHERE s."referenceId" = o.id AND s.status = 'active'
        )`,
  );

  let reported = 0;
  let skipped = 0;
  let failed = 0;
  // Sequential, not Promise.all: a background sweep over a normally-small set —
  // serializing the per-org Stripe calls keeps the sweep from bursting the
  // Stripe rate limit or the internal pool alongside live traffic.
  for (const row of rows) {
    try {
      const outcome = await reportOne(stripe, row, now);
      if (outcome === "reported") reported += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      log.warn(
        { err: err instanceof Error ? err.message : String(err), orgId: row.org_id },
        "Overage report failed for workspace — will retry next tick",
      );
    }
  }

  if (reported > 0 || failed > 0) {
    log.info(
      { scanned: rows.length, reported, skipped, failed },
      "Overage-meter reporting pass complete",
    );
  }
  return { scanned: rows.length, reported, skipped, failed };
}

// ---------------------------------------------------------------------------
// Metered subscription item (billing-plugin seam)
// ---------------------------------------------------------------------------

export type EnsureOverageItemOutcome = "added" | "present" | "skipped";

/**
 * Dependencies of {@link ensureOverageSubscriptionItem}, injected so the seam
 * is testable without mocking the settings/plans modules. Defaults wire the
 * real resolvers.
 */
export interface EnsureOverageItemDeps {
  readonly resolveTier: (priceId: string) => PlanTier | null;
  readonly getOveragePriceId: (tier: PaidPlanTier) => string | undefined;
}

const defaultEnsureOverageItemDeps: EnsureOverageItemDeps = {
  resolveTier: resolvePlanTierFromPriceId,
  getOveragePriceId: (tier) => getOveragePriceIdForTier(tier),
};

/**
 * Ensure a paid subscription carries its tier's metered-overage price as a
 * SECOND subscription item (#3992) — the price the `atlas_token_overage` meter
 * bills against. Idempotent: a no-op when the item is already present, and
 * runs on every `customer.subscription.{created,updated}` webhook so it is
 * path-agnostic (checkout, upgrade, downgrade all converge here).
 *
 * BEST-EFFORT by construction: it runs as a side branch of the durable Stripe
 * sync (`onEvent` in `lib/auth/server.ts`), so a transient Stripe failure here
 * must NOT throw and force a redelivery of the already-applied tier write. The
 * Stripe call is caught + logged; the scheduler's overage reporter will still
 * record meter events (customer-scoped) which Stripe bills once the item lands
 * on a later sync. Returns the outcome for observability/testing.
 */
export async function ensureOverageSubscriptionItem(
  subscription: Stripe.Subscription,
  stripe: Stripe,
  deps: EnsureOverageItemDeps = defaultEnsureOverageItemDeps,
): Promise<EnsureOverageItemOutcome> {
  const items = subscription.items?.data ?? [];
  const seatPriceId = items[0]?.price?.id;
  const tier = seatPriceId ? deps.resolveTier(seatPriceId) : null;
  if (!tier || !isPaidTier(tier)) return "skipped";

  const overagePriceId = deps.getOveragePriceId(tier);
  if (!overagePriceId) {
    log.warn(
      { subscriptionId: subscription.id, tier },
      "No metered-overage price ID configured for tier — skipping metered subscription item",
    );
    return "skipped";
  }

  if (items.some((item) => item.price?.id === overagePriceId)) {
    return "present";
  }

  try {
    await stripe.subscriptionItems.create({
      subscription: subscription.id,
      price: overagePriceId,
    });
  } catch (err) {
    // Best-effort: log, never throw (would force a webhook redelivery of the
    // durable tier sync). The next subscription.updated sync re-attempts.
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        subscriptionId: subscription.id,
        tier,
      },
      "Failed to add metered-overage subscription item — will retry on next subscription sync",
    );
    return "skipped";
  }

  log.info(
    { subscriptionId: subscription.id, tier, overagePriceId },
    "Added metered-overage subscription item",
  );
  return "added";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow a raw `plan_tier` string to a known {@link PlanTier}, or null. */
function parseTier(raw: string | null | undefined): PlanTier | null {
  if (!raw) return null;
  return (PLAN_TIERS as readonly string[]).includes(raw) ? (raw as PlanTier) : null;
}
