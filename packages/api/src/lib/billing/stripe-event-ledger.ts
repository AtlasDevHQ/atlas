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
 * idempotent tier write — the safe direction. The residual race (two
 * concurrent deliveries of the same event both passing step 1) has the
 * same idempotent-rewrite outcome.
 *
 * Every function THROWS on ledger/DB failure. `onEvent` throws are the
 * only ones the plugin propagates (→ 400 `STRIPE_WEBHOOK_ERROR` → Stripe
 * retries), so failing loudly here is what makes the sync durable —
 * swallowing would re-create the exact silent-loss bug this fixes.
 */

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
 * Classify a delivery before processing it.
 *
 *  - `duplicate` — this exact event id was already processed (replay).
 *  - `stale` — a strictly NEWER event for the same subscription was
 *    already applied; applying this one would regress status/plan
 *    (the plugin itself writes last-DELIVERED-wins, so the guard is the
 *    only out-of-order protection).
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

  if (event.stripeSubscriptionId) {
    const newer = await internalQuery<{ event_id: string }>(
      `SELECT event_id FROM stripe_webhook_events
        WHERE stripe_subscription_id = $1 AND event_created > $2
        LIMIT 1`,
      [event.stripeSubscriptionId, new Date(event.created * 1000).toISOString()],
    );
    if (newer.length > 0) return "stale";
  }

  return "fresh";
}

/** Record a processed event. Idempotent (`ON CONFLICT DO NOTHING`). */
export async function recordStripeEvent(event: StripeLedgerEvent): Promise<void> {
  if (!hasInternalDB()) return;
  await internalQuery(
    `INSERT INTO stripe_webhook_events (event_id, event_type, event_created, stripe_subscription_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id) DO NOTHING`,
    [event.id, event.type, new Date(event.created * 1000).toISOString(), event.stripeSubscriptionId],
  );
}

/**
 * Drop ledger rows past retention. Returns the number pruned. Called by
 * the reconciliation sweep, not on the webhook path.
 */
export async function pruneStripeEventLedger(
  retentionDays: number = STRIPE_EVENT_LEDGER_RETENTION_DAYS,
): Promise<number> {
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
