/**
 * Stripe teardown outbox sweep (#3679) — the symmetric counterpart to the
 * plan-tier reconcile sweep (`reconcile-plan-tiers.ts`).
 *
 * Workspace delete/purge cancels the org's Stripe subscriptions (and, on a
 * GDPR purge, deletes the Stripe customer) BEFORE the DB cascade runs. Those
 * Stripe calls used to be "total" — a transient Stripe 5xx/timeout at that
 * instant folded into a free-text warnings string and the cascade proceeded
 * regardless, leaving a live subscription invoicing a workspace that no longer
 * exists (and, for a purge, a billable customer/PII linkage surviving a
 * "hard delete"). `workspace-teardown.ts` now persists every failed (or
 * drift-detected) op into the `stripe_teardown_pending` outbox; this sweep is
 * the durable retry that drains it.
 *
 * Each tick reads a batch of pending rows and retries the op:
 *  - `cancel_subscription` → `subscriptions.cancel`
 *  - `delete_customer`     → `customers.del`
 * On success OR `resource_missing` (Stripe never resurrects an id, so a
 * missing target IS the desired end state) the row is removed. On any other
 * failure the row's `attempts`/`last_error` are bumped and it is left for the
 * next tick — retrying until success or `resource_missing`, per the issue.
 *
 * Gating: needs `STRIPE_SECRET_KEY` (to act on Stripe) + an internal DB (to
 * hold the outbox). No-ops cleanly otherwise — self-hosted deployments without
 * Stripe never accrue outbox rows. Forked as a periodic fiber in
 * `lib/effect/layers.ts`, alongside the plan-tier reconcile.
 *
 * Internal-DB failures propagate so the scheduler tick logs and retries next
 * interval (same contract as `reconcilePlanTiers`); per-row Stripe failures
 * are caught and recorded, never thrown.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getStripeClient } from "@atlas/api/lib/billing/stripe-client";
import { isStripeResourceMissing } from "@atlas/api/lib/billing/workspace-teardown";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("billing:teardown-sweep");

/**
 * How often the teardown sweep ticks. A stranded subscription keeps invoicing
 * a deleted customer, so this is more urgent than the 6-hour plan-tier sweep —
 * but Stripe outages resolve in minutes, the table is normally empty, and the
 * scan is a cheap indexed read, so 15 minutes balances promptness against load.
 * Exported so `layers.ts` references the same value the fiber is documented
 * around. `Effect.repeat(Schedule.spaced)` runs the tick once eagerly on boot,
 * so a deploy also drains any backlog immediately.
 */
export const STRIPE_TEARDOWN_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Per-tick batch cap. The table is normally empty; a bound keeps a large
 * backlog (mass-delete during a long Stripe outage) from monopolizing one
 * tick — the remainder drains on the next. Ordered by `attempts` so the
 * least-tried rows are processed first and a single stuck row can't starve
 * fresh ones.
 */
const SWEEP_BATCH_SIZE = 100;

export interface StripeTeardownSweepResult {
  /** Rows examined this tick. */
  readonly scanned: number;
  /** Rows whose Stripe op succeeded or was already gone — removed. */
  readonly resolved: number;
  /** Rows still failing — `attempts`/`last_error` bumped, kept for retry. */
  readonly failed: number;
}

// Type alias (not interface): internalQuery's generic is constrained to
// Record<string, unknown>, satisfied by an object-literal alias's implicit
// index signature.
type PendingRow = {
  id: string;
  workspace_id: string;
  stripe_sub_id: string | null;
  stripe_customer_id: string | null;
  op: string;
  attempts: number;
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deletePendingRow(id: string): Promise<void> {
  await internalQuery(`DELETE FROM stripe_teardown_pending WHERE id = $1`, [id]);
}

async function bumpAttempt(id: string, lastError: string): Promise<void> {
  await internalQuery(
    `UPDATE stripe_teardown_pending
        SET attempts = attempts + 1, last_error = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, lastError],
  );
}

/**
 * Retry one outbox row. Returns whether it was resolved (removed) or left for
 * the next tick. The Stripe call is the ONLY thing wrapped in the try — the
 * subsequent DB write runs outside it, so an internal-DB error propagates to
 * the sweep (and the scheduler retries) instead of being misread as a Stripe
 * failure that bumps `attempts` for an op that actually succeeded.
 */
async function processPendingRow(
  stripe: NonNullable<ReturnType<typeof getStripeClient>>,
  row: PendingRow,
): Promise<"resolved" | "failed"> {
  // Drop structurally-invalid rows rather than retry a no-op forever. The
  // CHECK constraint makes these unreachable in practice, but a defensive
  // drop keeps a malformed row from pinning the sweep.
  if (row.op === "cancel_subscription" && !row.stripe_sub_id) {
    await deletePendingRow(row.id);
    log.warn({ id: row.id }, "Dropped malformed teardown row: cancel_subscription with no stripe_sub_id");
    return "resolved";
  }
  if (row.op === "delete_customer" && !row.stripe_customer_id) {
    await deletePendingRow(row.id);
    log.warn({ id: row.id }, "Dropped malformed teardown row: delete_customer with no stripe_customer_id");
    return "resolved";
  }
  if (row.op !== "cancel_subscription" && row.op !== "delete_customer") {
    await deletePendingRow(row.id);
    log.warn({ id: row.id, op: row.op }, "Dropped teardown row with unknown op");
    return "resolved";
  }

  let opError: unknown = null;
  try {
    if (row.op === "cancel_subscription") {
      await stripe.subscriptions.cancel(row.stripe_sub_id as string);
    } else {
      await stripe.customers.del(row.stripe_customer_id as string);
    }
  } catch (err) {
    opError = err;
  }

  if (opError !== null && !isStripeResourceMissing(opError)) {
    const msg = errMessage(opError);
    await bumpAttempt(row.id, msg);
    log.warn(
      {
        id: row.id,
        workspaceId: row.workspace_id,
        op: row.op,
        attempts: row.attempts + 1,
        err: msg,
      },
      "Stripe teardown op still failing — will retry next sweep",
    );
    return "failed";
  }

  await deletePendingRow(row.id);
  log.info(
    {
      id: row.id,
      workspaceId: row.workspace_id,
      op: row.op,
      alreadyGone: opError !== null,
    },
    opError !== null
      ? "Stripe teardown target already absent — outbox row resolved"
      : "Completed stranded Stripe teardown op via outbox sweep",
  );
  return "resolved";
}

/**
 * One sweep pass. Idempotent; safe to run concurrently across pods — each row
 * is claimed-and-removed by id, and a row processed by another pod between the
 * SELECT and the per-row op simply no-ops (the Stripe call hits
 * `resource_missing`, the DELETE matches zero rows). No-ops without Stripe or
 * an internal DB. Throws on internal-DB failure so the scheduler tick logs and
 * retries.
 */
export async function sweepStripeTeardownPending(): Promise<StripeTeardownSweepResult> {
  if (!hasInternalDB()) return { scanned: 0, resolved: 0, failed: 0 };
  const stripe = getStripeClient();
  if (!stripe) return { scanned: 0, resolved: 0, failed: 0 };

  const rows = await internalQuery<PendingRow>(
    `SELECT id, workspace_id, stripe_sub_id, stripe_customer_id, op, attempts
       FROM stripe_teardown_pending
      ORDER BY attempts ASC, created_at ASC
      LIMIT $1`,
    [SWEEP_BATCH_SIZE],
  );

  let resolved = 0;
  let failed = 0;
  // Sequential, not Promise.all: a background sweep over a normally-empty
  // table — serializing the per-row Stripe calls + DB writes keeps the sweep
  // from bursting either the internal pool or the Stripe rate limit.
  for (const row of rows) {
    const outcome = await processPendingRow(stripe, row);
    if (outcome === "resolved") resolved += 1;
    else failed += 1;
  }

  if (resolved > 0 || failed > 0) {
    log.info(
      { scanned: rows.length, resolved, failed },
      "Stripe teardown outbox sweep pass complete",
    );
  }
  return { scanned: rows.length, resolved, failed };
}
