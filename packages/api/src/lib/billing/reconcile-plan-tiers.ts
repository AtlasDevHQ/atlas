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
  updateWorkspacePlanTier,
} from "@atlas/api/lib/db/internal";
import { invalidatePlanCache } from "@atlas/api/lib/billing/enforcement";
import { pruneStripeEventLedger } from "@atlas/api/lib/billing/stripe-event-ledger";
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
}

// Type alias, not interface: internalQuery's generic is constrained to
// Record<string, unknown>, which only object-literal type aliases satisfy
// via their implicit index signature.
type ReconcileRow = {
  org_id: string;
  plan_tier: string | null;
  subscription_plan: string | null;
};

/**
 * One reconciliation pass. Idempotent; safe to run concurrently across
 * instances (the heal write is a plain idempotent UPDATE). Throws on
 * internal-DB failure so the scheduler tick logs it and retries next
 * interval.
 */
export async function reconcilePlanTiers(): Promise<PlanTierReconcileResult> {
  if (!hasInternalDB()) return { healed: 0, flagged: 0, prunedLedger: 0 };

  // Newest live subscription per org, joined against the org's current
  // tier. `subscription.plan` stores the plan NAME, which is the tier
  // vocabulary (plans.ts names plans after tiers); parsePlanTier guards
  // the trust boundary anyway.
  const rows = await internalQuery<ReconcileRow>(
    `SELECT o.id AS org_id, o.plan_tier, sub.plan AS subscription_plan
       FROM organization o
       LEFT JOIN LATERAL (
         SELECT s.plan FROM subscription s
          WHERE s."referenceId" = o.id AND s.status IN ('active', 'trialing')
          ORDER BY s."createdAt" DESC
          LIMIT 1
       ) sub ON true`,
  );

  let healed = 0;
  let flagged = 0;

  for (const row of rows) {
    const currentTier = parsePlanTier(row.plan_tier);

    if (row.subscription_plan != null) {
      const expectedTier = parsePlanTier(row.subscription_plan);
      if (expectedTier === null) {
        log.warn(
          { orgId: row.org_id, subscriptionPlan: row.subscription_plan },
          "Subscription row carries a plan name outside the tier vocabulary — cannot reconcile",
        );
        continue;
      }
      if (expectedTier !== currentTier) {
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

  if (healed > 0 || flagged > 0 || prunedLedger > 0) {
    log.info({ healed, flagged, prunedLedger, orgsScanned: rows.length }, "Plan-tier reconciliation pass complete");
  }
  return { healed, flagged, prunedLedger };
}
