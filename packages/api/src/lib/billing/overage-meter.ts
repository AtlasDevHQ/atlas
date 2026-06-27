/**
 * OverageMeter — idempotent, reconcilable Stripe Billing Meters reporter
 * (#3992; re-denominated to at-cost dollars/cents #4039, Structure B).
 *
 * Each billing period a paid workspace can run past its included at-cost usage
 * credit (the metered soft-cap band in `enforcement.ts`, #3990/#4038). This
 * module flushes that overage to Stripe's Billing Meters API (`meter_events`)
 * on a scheduler tick so the customer is actually invoiced for it, and adds the
 * per-tier metered price as a SECOND subscription item so the meter has a price
 * to bill against.
 *
 * ## What is reported — at-cost CENTS
 *
 * Structure B (#4034) bills usage overage at provider COST (zero markup), so
 * the overage is denominated in real dollars: `costUsd − includedCredit`
 * (#4038's `computeOverageDollars`, where `costUsd` is the summed at-cost Vercel
 * AI Gateway spend, #4036, and the credit is `$20/seat`). The reported quantity
 * is that overage converted to **integer cents** (`dollarsToCents`), sent to the
 * shared at-cost {@link OVERAGE_METER_EVENT_NAME} meter. Its overage price is
 * `unit_amount = 1` (1 cent / metered unit), so `cents × $0.01 = the at-cost
 * dollars` — billed 1:1, at cost.
 *
 * Cents (not fractional dollars) so the meter's summed total and the
 * baseline-keyed dedup stay integer-exact (no float drift / rounding seam). The
 * ledger column is `reported_cost_cents` — see migration 0156 for the full unit
 * rationale.
 *
 * ## Idempotency + reconciliation (ledger-backed)
 *
 * `overage_meter_reports` records, per (org, billing period), the CUMULATIVE
 * overage cents already reported to Stripe (`reported_cost_cents`). Each tick:
 *
 *   1. compute the period's current overage cents (at-cost spend − credit),
 *   2. delta = currentOverageCents − reported_cost_cents (floored at 0),
 *   3. if delta > 0, send ONE `meter_event` carrying `payload.value = delta`
 *      and `payload.stripe_customer_id`, then advance `reported_cost_cents` to
 *      the new cumulative.
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
 * keyed on the **baseline** (`reported_cost_cents` BEFORE this report), NOT the
 * new cumulative — so a retry from the same un-advanced ledger reuses the SAME
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
 * usage enforcement entirely) and are excluded by the sweep scan; non-paid tiers
 * (free / trial / locked) are excluded by tier membership; and a zero-credit
 * workspace is skipped by the per-workspace credit check. A workspace whose
 * at-cost basis sums to $0 (non-gateway provider, or token rows predating #4036)
 * reads zero overage and is likewise skipped — a safe under-bill, never an
 * over-bill — but it is surfaced as an operator `log.error` alert first (the
 * loud cost-basis-gap posture mirrored from enforcement.ts, #4038), so a
 * fleet-wide capture regression that silently zeros overage revenue can't hide.
 * All bail before any meter event.
 *
 * ## Gating
 *
 * Needs `STRIPE_SECRET_KEY` (to call Stripe) + an internal DB (to hold the
 * ledger + read usage). No-ops cleanly otherwise (self-hosted never accrues
 * rows). Forked as a periodic fiber in `lib/effect/layers.ts`; the metered-item
 * seam runs on the Stripe webhook path in `lib/auth/server.ts`.
 */

import { createHash } from "node:crypto";

import type Stripe from "stripe";

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getStripeClient } from "@atlas/api/lib/billing/stripe-client";
import { getCurrentPeriodUsage, type UsageCurrentPeriod } from "@atlas/api/lib/metering";
import { getSeatCount } from "@atlas/api/lib/billing/seat-count";
import {
  computeUsageDollarBudget,
  resolvePlanTierFromPriceId,
  type PaidPlanTier,
} from "@atlas/api/lib/billing/plans";
import { computeOverageDollars } from "@atlas/api/lib/billing/enforcement";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  OVERAGE_PRICE_ID_ENV_VAR_BY_TIER,
  type OveragePriceIdEnvVar,
} from "@atlas/api/lib/billing/config-validation";
import { createLogger } from "@atlas/api/lib/logger";
import { PLAN_TIERS, type PlanTier } from "@useatlas/types";

const log = createLogger("billing:overage-meter");

/**
 * Stripe Billing Meter `event_name` for at-cost usage overage (#4039). Distinct
 * from the superseded token meter (`atlas_token_overage`, #3991) — a meter sums
 * every event under its `event_name` regardless of unit, so the cents
 * re-denomination REQUIRES a fresh meter rather than reusing the token one. The
 * value carried is integer cents (see {@link dollarsToCents}); the sandbox/live
 * meter is created with this exact `event_name`.
 */
export const OVERAGE_METER_EVENT_NAME = "atlas_usage_overage_cents";

/**
 * The paid tiers that accrue billable usage overage — DERIVED from the
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
 * Convert an at-cost overage in USD to the integer cents the meter is reported
 * in (and the ledger stores). Rounded to the nearest cent — the at-cost dollars
 * are fractions of a cent precise (`gateway.cost`), but Stripe bills in whole
 * cents, so reporting whole cents is what the customer is actually charged.
 * Floored at 0 and finite-guarded: a non-finite or negative input (downward
 * correction) yields 0, never a negative meter quantity. Pure.
 */
export function dollarsToCents(overageDollars: number): number {
  if (!Number.isFinite(overageDollars) || overageDollars <= 0) return 0;
  return Math.round(overageDollars * 100);
}

/**
 * The reportable overage delta: how many at-cost CENTS past what's already been
 * reported the workspace has now consumed. Floored at 0 — a downward correction
 * (cost re-counted lower, or a stale ledger ahead of current) must never produce
 * a NEGATIVE meter event (which would credit the customer for usage they
 * actually had). Pure.
 */
export function computeReportableDelta(
  currentOverageCents: number,
  alreadyReportedCents: number,
): number {
  if (!Number.isFinite(currentOverageCents) || !Number.isFinite(alreadyReportedCents)) {
    return 0;
  }
  return Math.max(0, Math.trunc(currentOverageCents) - Math.trunc(alreadyReportedCents));
}

/**
 * Deterministic Stripe `meter_event` identifier for a report. Keyed on the
 * BASELINE — the `reported_cost_cents` cumulative BEFORE this report — NOT the
 * new cumulative or the delta. The baseline is read from the ledger, which only
 * advances on a successful record, so a crash-before-record (or a concurrent
 * pod) retries from the SAME baseline and reuses the SAME identifier even if
 * usage grew in between. Stripe keeps the first value per identifier within its
 * rolling 24h window, so the overlap is never double-counted (it fails toward a
 * bounded under-bill, the safe direction — see the module doc). Successive
 * reports use strictly increasing baselines, so each identifier covers a
 * distinct `[baseline, …)` range.
 *
 * OBS-1 (#4039): the determinism tuple `(orgId, period, baseline)` is hashed
 * (SHA-256, first 32 hex chars) rather than concatenated raw. Stripe rejects a
 * `meter_event` identifier over 100 chars, and the old
 * `atlas-overage-${orgId}-…` spelling overflowed that cap for a long org id
 * (Better-Auth org ids are unbounded TEXT) — stranding that org's overage,
 * never billed. The hash is fixed-width (`atlas-overage-` + 32 = 46 chars), so
 * the identifier is ≤100 chars for ANY org id while preserving the exact same
 * baseline-keyed crash-window dedup (same tuple → same hash → same identifier).
 */
export function buildOverageEventIdentifier(
  orgId: string,
  periodStartISO: string,
  baselineCents: number,
): string {
  const periodKey = Date.parse(periodStartISO);
  const period = Number.isFinite(periodKey) ? periodKey : periodStartISO;
  const digest = createHash("sha256")
    .update(`${orgId}|${period}|${baselineCents}`)
    .digest("hex")
    .slice(0, 32);
  return `atlas-overage-${digest}`;
}

// ---------------------------------------------------------------------------
// Ledger access
// ---------------------------------------------------------------------------

/**
 * The cumulative overage CENTS already reported to Stripe for `(orgId,
 * periodStart)`, or 0 when no row exists yet. Postgres returns `BIGINT` as a
 * string via `pg`, so coerce + validate rather than trust the wire type.
 */
export async function getReportedOverageCents(
  orgId: string,
  periodStartISO: string,
): Promise<number> {
  if (!hasInternalDB()) return 0;
  const rows = await internalQuery<{ reported_cost_cents: number | string | null }>(
    `SELECT reported_cost_cents FROM overage_meter_reports
      WHERE org_id = $1 AND period_start = $2
      LIMIT 1`,
    [orgId, periodStartISO],
  );
  const raw = rows[0]?.reported_cost_cents;
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
      `overage_meter_reports.reported_cost_cents is not a non-negative number for org ${orgId} period ${periodStartISO}: ${String(raw)}`,
    );
  }
  return parsed;
}

export interface OverageReportRecord {
  readonly orgId: string;
  readonly periodStartISO: string;
  readonly stripeCustomerId: string;
  /** New cumulative reported cents for the period (NOT the delta). */
  readonly reportedCents: number;
  readonly eventIdentifier: string;
}

/**
 * Upsert the ledger to the new cumulative reported total. `GREATEST` keeps
 * `reported_cost_cents` monotonic within a period — a late/retried tick carrying
 * an older cumulative can never regress it, which would re-report already-billed
 * overage. `ON CONFLICT` keys on the composite PK `(org_id, period_start)`. The
 * superseded `reported_tokens` column is left untouched (its `NOT NULL DEFAULT
 * 0` satisfies the omitted insert) until the N+1 contract drop (the #4039 follow-up).
 */
export async function recordOverageReport(record: OverageReportRecord): Promise<void> {
  if (!hasInternalDB()) return;
  await internalQuery(
    `INSERT INTO overage_meter_reports
       (org_id, period_start, stripe_customer_id, reported_cost_cents, last_event_identifier, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (org_id, period_start) DO UPDATE SET
       reported_cost_cents = GREATEST(overage_meter_reports.reported_cost_cents, EXCLUDED.reported_cost_cents),
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       last_event_identifier = EXCLUDED.last_event_identifier,
       updated_at = now()`,
    [
      record.orgId,
      record.periodStartISO,
      record.stripeCustomerId,
      record.reportedCents,
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
  readonly getReportedOverageCents: (orgId: string, periodStartISO: string) => Promise<number>;
  readonly recordOverageReport: (record: OverageReportRecord) => Promise<void>;
}

const defaultWorkspaceOverageDeps: WorkspaceOverageDeps = {
  getSeatCount,
  getCurrentPeriodUsage,
  getReportedOverageCents,
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
  // usage enforcement entirely (#3990). Checked first, defensively: the sweep's
  // scan already excludes BYOT, but this keeps the function boundary honest so
  // a direct caller can never report a BYOT workspace.
  if (row.byot === true) return "skipped";

  const tier = parseTier(row.plan_tier);
  if (!tier || !isPaidTier(tier)) return "skipped";
  if (!row.stripe_customer_id) return "skipped";

  const seatCount = await deps.getSeatCount(row.org_id);
  // The included at-cost usage credit ($20/seat, Structure B #4038). There is no
  // "unlimited" dollar credit; a non-positive credit means nothing to meter.
  const creditUsd = computeUsageDollarBudget(tier, seatCount);
  if (creditUsd <= 0) return "skipped";

  const usage = await deps.getCurrentPeriodUsage(row.org_id, now);
  // COST-BASIS GAP ALERT (#4039): the meter denominates on `usage.costUsd`, which
  // sums `gateway_cost_usd` — NULL for non-gateway providers and for token rows
  // predating #4036, and $0 if the at-cost capture pipeline breaks fleet-wide.
  // When tokens were recorded but the basis summed to $0, the overage reads $0
  // and this workspace is silently NOT billed for overage. That is a safe
  // under-bill (never an over-bill), but a SILENT one — and a fleet-wide capture
  // regression would zero ALL overage revenue while `reportPeriodOverages` logs
  // look identical to a quiet period. Surface it as an operator-visible alert
  // here, matching the sibling `log.error` in enforcement.ts (#4038) so the same
  // metering-impaired dashboards fire on both the enforce and the bill paths.
  // Still proceed (skip on $0 overage below) — loud, never blocking.
  if (usage.tokenCount > 0 && usage.costUsd === 0) {
    log.error(
      {
        orgId: row.org_id,
        tier,
        tokenCount: usage.tokenCount,
        periodStart: usage.periodStart,
        reason: "cost_basis_missing",
      },
      "Overage meter has no cost basis — tokens recorded but gateway_cost_usd summed to $0; " +
        "workspace will not be billed for overage (non-gateway provider, token rows predating #4036, or broken capture) (#4039)",
    );
  }
  // Denominate against the summed at-cost provider spend (`usage.costUsd`, #4036)
  // — the EXACT zero-markup dollars Atlas paid — minus the credit (#4038's
  // `computeOverageDollars`), the SAME numerator enforcement reads, then convert
  // to integer cents for the meter.
  const overageDollars = computeOverageDollars(usage.costUsd, creditUsd);
  const currentOverageCents = dollarsToCents(overageDollars);
  if (currentOverageCents <= 0) return "skipped";

  const reportedSoFar = await deps.getReportedOverageCents(row.org_id, usage.periodStart);
  const delta = computeReportableDelta(currentOverageCents, reportedSoFar);
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
      reportedCents: currentOverageCents,
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
        cumulativeCents: currentOverageCents,
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
      deltaCents: delta,
      cumulativeCents: currentOverageCents,
    },
    "Reported at-cost overage delta (cents) to Stripe meter",
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
 * SECOND subscription item (#3992) — the price the at-cost
 * {@link OVERAGE_METER_EVENT_NAME} meter bills against. Idempotent: a no-op when
 * the item is already present, and
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
