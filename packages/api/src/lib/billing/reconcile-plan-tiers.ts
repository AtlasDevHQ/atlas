/**
 * Plan-tier reconciliation sweep (#3423) — the safety net under the
 * webhook path.
 *
 * The webhook `onEvent` sync (lib/auth/server.ts) is durable against
 * transient failures (throws → Stripe redelivers), but not against
 * permanent loss: a webhook secret rotation, an endpoint outage past
 * Stripe's ~3-week retry horizon, or an event class we don't handle can
 * still leave `organization.plan_tier` divergent from the subscription
 * the plugin's own table says the org is paying for. This sweep heals
 * that drift from the same source of truth the webhooks write
 * (`subscription`, owned by @better-auth/stripe) through the same write
 * path (`updateWorkspacePlanTier` + plan-cache invalidation).
 *
 * Two deliberate asymmetries:
 *
 *  - Org HAS an active/trialing subscription but the tier disagrees →
 *    HEAL (the subscription row is webhook-fed ground truth; this also
 *    un-locks an org whose resubscribe webhook was lost).
 *  - Org sits on a PAID tier with NO active/trialing subscription →
 *    FLAG ONLY (log, never write). This shape is ambiguous: it can be a
 *    lost `customer.subscription.deleted` (should lock) or a deliberate
 *    operator grant via the admin plan endpoint. Until the billing
 *    override flag lands (#3427) there is no way to tell them apart, so
 *    the sweep refuses to guess — locking a comped design partner is
 *    worse than a stale entitlement.
 *
 * `trial`, `free`, and `locked` orgs without a subscription are normal
 * states (pre-checkout trial, legacy/self-hosted rows, churned) and are
 * left alone. Runs from the scheduler fiber in `lib/effect/layers.ts`;
 * also prunes the webhook event ledger past retention.
 */

import {
  hasInternalDB,
  internalQuery,
  isPlanOverrideActive,
  updateWorkspacePlanTier,
} from "@atlas/api/lib/db/internal";
import { invalidatePlanCache } from "@atlas/api/lib/billing/enforcement";
import {
  pruneStripeEventLedger,
  pruneStripePurgedSubscriptions,
} from "@atlas/api/lib/billing/stripe-event-ledger";
import { parsePlanTier } from "@atlas/api/lib/integrations/install/plan-rank";
import { createLogger } from "@atlas/api/lib/logger";
import type { PlanTier } from "@useatlas/types";

const log = createLogger("billing:reconcile");

/** Tiers that imply a live Stripe subscription should exist. */
const PAID_TIERS: ReadonlySet<PlanTier> = new Set(["starter", "pro", "business"]);

export interface PlanTierReconcileResult {
  /** Orgs whose plan_tier was rewritten to match their subscription. */
  healed: number;
  /** Paid-tier orgs with no live subscription — logged, not changed. */
  flagged: number;
  /** Webhook-ledger rows pruned past retention. */
  prunedLedger: number;
  /** GDPR purge tombstones pruned past retention (#3468). */
  prunedTombstones: number;
}

// Type alias, not interface: internalQuery's generic is constrained to
// Record<string, unknown>, which only object-literal type aliases satisfy
// via their implicit index signature.
type ReconcileRow = {
  org_id: string;
  plan_tier: string | null;
  subscription_plan: string | null;
  /** Newest non-null `applied_plan_tier` from the webhook ledger. */
  ledger_tier: string | null;
  /** Operator plan-override window (#3427); when in the future, the sweep
   *  must not heal over the operator's grant. */
  plan_override_until: string | null;
};

/**
 * One reconciliation pass. Idempotent; safe to run concurrently across
 * instances (the heal write is a plain idempotent UPDATE). Throws on
 * internal-DB failure so the scheduler tick logs it and retries next
 * interval.
 */
export async function reconcilePlanTiers(): Promise<PlanTierReconcileResult> {
  if (!hasInternalDB()) return { healed: 0, flagged: 0, prunedLedger: 0, prunedTombstones: 0 };

  // Newest live subscription per org, joined against the org's current
  // tier AND the ledger's newest APPLIED tier for that subscription.
  // `subscription.plan` stores the plan NAME, which is the tier
  // vocabulary (plans.ts names plans after tiers); parsePlanTier guards
  // the trust boundary anyway.
  //
  // The plugin writes its subscription row last-DELIVERED-wins, so a
  // stale older delivery can regress the row even though the webhook
  // ledger correctly skipped the Atlas-side sync (Codex review on
  // #3444). Two defenses, one per failure shape:
  //  - The NOT EXISTS guard: any sub with a recorded deletion event is
  //    ended regardless of what the row claims (Stripe never resurrects
  //    a subscription id) — without it, a stale `updated` flipping the
  //    row back to "active" would heal a locked workspace back to paid.
  //  - `led.applied_plan_tier` (preferred over `sub.plan` when present):
  //    the tier the ORDERING-CORRECT sync last wrote. A stale older
  //    `updated` (plan=starter) delivered after a newer one (plan=pro)
  //    regresses the row to starter, but the ledger-latest applied tier
  //    stays pro — healing from the row would undo the ledger's
  //    protection. The row remains the fallback for rows that predate
  //    the ledger or whose entries aged past the 30-day retention (by
  //    then Stripe's own ~3-week retry/redelivery window has closed, so
  //    a stale delivery storm can no longer be in flight).
  const rows = await internalQuery<ReconcileRow>(
    `SELECT o.id AS org_id, o.plan_tier, o.plan_override_until, sub.plan AS subscription_plan,
            led.applied_plan_tier AS ledger_tier
       FROM organization o
       LEFT JOIN LATERAL (
         SELECT s.plan, s."stripeSubscriptionId" FROM subscription s
          WHERE s."referenceId" = o.id AND s.status IN ('active', 'trialing')
            AND NOT EXISTS (
              SELECT 1 FROM stripe_webhook_events w
               WHERE w.stripe_subscription_id = s."stripeSubscriptionId"
                 AND w.event_type = 'customer.subscription.deleted')
          ORDER BY s."createdAt" DESC
          LIMIT 1
       ) sub ON true
       LEFT JOIN LATERAL (
         SELECT w.applied_plan_tier FROM stripe_webhook_events w
          WHERE w.stripe_subscription_id = sub."stripeSubscriptionId"
            AND w.applied_plan_tier IS NOT NULL
          ORDER BY w.event_created DESC
          LIMIT 1
       ) led ON true`,
  );

  let healed = 0;
  let flagged = 0;

  // Sequential on purpose, not Promise.all: this is a 6-hour background
  // sweep and heals are expected to be rare — serializing the writes
  // keeps the sweep from bursting the internal pool alongside live
  // request traffic for no latency benefit anyone observes.
  for (const row of rows) {
    const currentTier = parsePlanTier(row.plan_tier);

    if (row.subscription_plan != null) {
      const expectedTier = parsePlanTier(row.ledger_tier ?? row.subscription_plan);
      if (expectedTier === null) {
        log.warn(
          { orgId: row.org_id, subscriptionPlan: row.subscription_plan, ledgerTier: row.ledger_tier },
          "Subscription row carries a plan name outside the tier vocabulary — cannot reconcile",
        );
        continue;
      }
      if (expectedTier !== currentTier) {
        // #3427 precedence — honor the operator plan-override window here too.
        // The webhook path (`applyWorkspaceTier` in lib/auth/server.ts) already
        // skips a tier write while `plan_override_until` is in the future; this
        // background sweep is the OTHER Stripe-derived tier-write path, so it
        // must obey the same rule or it would silently revert an operator grant
        // within one interval (~6h) — defeating the guarantee. Skip the heal
        // while the override is active; the org is left on the operator's tier
        // and re-converges naturally once the window lapses.
        if (isPlanOverrideActive(row.plan_override_until)) {
          log.info(
            { orgId: row.org_id, planTier: currentTier, expectedTier, planOverrideUntil: row.plan_override_until },
            "Skipping plan-tier heal — operator override window is active (#3427)",
          );
          continue;
        }
        const updated = await updateWorkspacePlanTier(row.org_id, expectedTier);
        if (updated) {
          invalidatePlanCache(row.org_id);
          healed += 1;
          log.warn(
            { orgId: row.org_id, from: row.plan_tier, to: expectedTier },
            "Healed plan-tier drift from the subscription table (lost webhook?)",
          );
        }
      }
      continue;
    }

    // No live subscription. Paid tier → flag-don't-heal (see module doc:
    // indistinguishable from an operator grant until #3427).
    if (currentTier !== null && PAID_TIERS.has(currentTier)) {
      flagged += 1;
      log.warn(
        { orgId: row.org_id, planTier: currentTier },
        "Paid-tier org has no active subscription — possible lost deletion webhook or operator grant; NOT changing (see #3427)",
      );
    }
  }

  const prunedLedger = await pruneStripeEventLedger();
  const prunedTombstones = await pruneStripePurgedSubscriptions();

  if (healed > 0 || flagged > 0 || prunedLedger > 0 || prunedTombstones > 0) {
    log.info({ healed, flagged, prunedLedger, prunedTombstones, orgsScanned: rows.length }, "Plan-tier reconciliation pass complete");
  }
  return { healed, flagged, prunedLedger, prunedTombstones };
}
