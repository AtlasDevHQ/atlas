/**
 * Stripe webhook event ledger (#3423) — idempotency + ordering for the
 * must-not-be-lost sync that lives in the Stripe plugin's `onEvent`.
 *
 * Protocol (the caller is `onEvent` in `lib/auth/server.ts`):
 *   1. {@link classifyStripeEvent} BEFORE processing — `duplicate` and
 *      `stale` deliveries are skipped without side effects.
 *   2. Process the sync (plan-tier write, CRM stamp enqueue).
 *   3. {@link recordStripeEvent} AFTER the sync succeeds.
 *
 * The classify→process→record order is deliberate: recording first would
 * make a failed sync unrecoverable (Stripe's retry of the same event id
 * would hit the duplicate guard and be skipped). Recording last means a
 * crash between steps 2 and 3 causes one extra retry that re-runs an
 * idempotent tier write — the safe direction. Concurrent deliveries for
 * the same subscription are serialized around the whole sequence by
 * `withStripeSubscriptionLock` (`db/internal.ts`, #3445) — without it,
 * two parallel deliveries could both classify `fresh` and the older
 * event's sync could finish last, regressing tier/lock state. The lock
 * serializes; it does not claim — record-last stays the contract.
 *
 * Every function THROWS on ledger/DB failure. `onEvent` throws are the
 * only ones the plugin propagates (→ 400 `STRIPE_WEBHOOK_ERROR` → Stripe
 * retries), so failing loudly here is what makes the sync durable —
 * swallowing would re-create the exact silent-loss bug this fixes.
 */

import type { PlanTier } from "@useatlas/types";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("billing:event-ledger");

/** Ledger retention — past Stripe's ~3-week retry horizon. */
export const STRIPE_EVENT_LEDGER_RETENTION_DAYS = 30;

export interface StripeLedgerEvent {
  /** Stripe event id (`evt_…`). */
  id: string;
  type: string;
  /** Stripe `event.created` — unix seconds. */
  created: number;
  /**
   * Stripe subscription id the event concerns, or null for events with
   * no subscription scope. Drives the per-subscription ordering guard.
   */
  stripeSubscriptionId: string | null;
}

export type StripeEventDisposition = "fresh" | "duplicate" | "stale";

/**
 * The event types whose relative order determines the workspace tier.
 * ONLY these participate in the per-subscription ordering guard — both
 * as the incoming side and as recorded blockers. Non-lifecycle events
 * that still carry a subscription id (e.g. `invoice.payment_failed`)
 * are deduped by event id but must never make a lifecycle event look
 * stale: a payment failure recorded first would otherwise suppress a
 * delayed `updated`/`deleted` sync entirely (Codex review on #3444).
 */
export const TIER_LIFECYCLE_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

export function isTierLifecycleEventType(type: string): boolean {
  return (TIER_LIFECYCLE_EVENT_TYPES as readonly string[]).includes(type);
}

// Static, compile-time list — safe to inline into SQL.
const LIFECYCLE_LIST_SQL = TIER_LIFECYCLE_EVENT_TYPES.map((t) => `'${t}'`).join(", ");

/**
 * Classify a delivery before processing it.
 *
 *  - `duplicate` — this exact event id was already processed (replay).
 *  - `stale` — a strictly NEWER lifecycle event for the same
 *    subscription was already applied; applying this one would regress
 *    status/plan (the plugin itself writes last-DELIVERED-wins, so the
 *    guard is the only out-of-order protection). Stripe `created` has
 *    1-second granularity, so ties are broken conservatively: a
 *    recorded `customer.subscription.deleted` also blocks SAME-second
 *    events — deletion is terminal (Stripe never resurrects a
 *    subscription id), so nothing sharing its second may run after it
 *    and write a paid tier back onto a locked workspace.
 *  - `fresh` — process it.
 */
export async function classifyStripeEvent(
  event: StripeLedgerEvent,
): Promise<StripeEventDisposition> {
  if (!hasInternalDB()) return "fresh"; // no ledger without an internal DB

  const dup = await internalQuery<{ event_id: string }>(
    `SELECT event_id FROM stripe_webhook_events WHERE event_id = $1 LIMIT 1`,
    [event.id],
  );
  if (dup.length > 0) return "duplicate";

  if (event.stripeSubscriptionId && isTierLifecycleEventType(event.type)) {
    const newer = await internalQuery<{ event_id: string }>(
      `SELECT event_id FROM stripe_webhook_events
        WHERE stripe_subscription_id = $1
          AND event_type IN (${LIFECYCLE_LIST_SQL})
          AND (event_created > $2
               OR (event_created = $2 AND event_type = 'customer.subscription.deleted'))
        LIMIT 1`,
      [event.stripeSubscriptionId, new Date(event.created * 1000).toISOString()],
    );
    if (newer.length > 0) return "stale";
  }

  return "fresh";
}

/**
 * Record a processed event. Idempotent (`ON CONFLICT DO NOTHING`).
 *
 * `appliedPlanTier` is the tier the sync actually WROTE for this event
 * (null when it applied none). The reconciliation sweep prefers the
 * newest non-null value per subscription over the plugin's
 * last-delivered-wins `subscription.plan` column — see the sweep's
 * module doc for the stale-row scenario this guards.
 */
export async function recordStripeEvent(
  event: StripeLedgerEvent,
  appliedPlanTier: PlanTier | null,
): Promise<void> {
  if (!hasInternalDB()) return;
  await internalQuery(
    `INSERT INTO stripe_webhook_events (event_id, event_type, event_created, stripe_subscription_id, applied_plan_tier)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      event.id,
      event.type,
      new Date(event.created * 1000).toISOString(),
      event.stripeSubscriptionId,
      appliedPlanTier,
    ],
  );
}

/**
 * Drop ledger rows past retention. Returns the number pruned. Called by
 * the reconciliation sweep, not on the webhook path.
 */
export async function pruneStripeEventLedger(
  retentionDays: number = STRIPE_EVENT_LEDGER_RETENTION_DAYS,
): Promise<number> {
  // A negative value would invert the cutoff into `< now() + interval`
  // and wipe the live ledger (CodeRabbit on #3444).
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(`Invalid stripe event ledger retentionDays: ${retentionDays}`);
  }
  if (!hasInternalDB()) return 0;
  const rows = await internalQuery<{ event_id: string }>(
    `DELETE FROM stripe_webhook_events
      WHERE processed_at < now() - ($1 || ' days')::interval
      RETURNING event_id`,
    [String(retentionDays)],
  );
  if (rows.length > 0) {
    log.info({ pruned: rows.length, retentionDays }, "Pruned Stripe webhook event ledger");
  }
  return rows.length;
}
