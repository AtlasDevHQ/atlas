/**
 * Stripe billing teardown for platform-admin workspace lifecycle ops (#3425).
 *
 * Platform-admin suspend/unsuspend/delete/purge historically performed no
 * Stripe interaction at all — a deleted (or GDPR-purged) org left its Stripe
 * subscription live and invoicing. This module is the single seam between
 * those lifecycle operations and Stripe:
 *
 * - **Delete** → {@link cancelStripeSubscriptionsForWorkspace}: cancel every
 *   live Stripe subscription for the org. Runs BEFORE the DB cascade — the
 *   @better-auth/stripe plugin (org mode, #3416) blocks better-auth org
 *   deletion while subscriptions exist, and platform-admin's direct-DB
 *   cascade must honor the same ordering rather than bypass it.
 * - **Purge (GDPR)** → {@link purgeStripeBillingForWorkspace}: cancel any
 *   remaining subscriptions AND permanently delete the Stripe customer —
 *   no billable Stripe linkage may survive a GDPR purge.
 * - **Suspend / unsuspend** → {@link pauseStripeCollectionForWorkspace} /
 *   {@link resumeStripeCollectionForWorkspace}: see the policy note on the
 *   pause function.
 *
 * Failure semantics: Stripe API failures must never strand the admin
 * operation silently. Every helper is total — it catches each Stripe error,
 * logs it with context, and returns it as an operator-facing `warnings`
 * entry that the route surfaces in the admin response for manual follow-up.
 * The lifecycle operation itself always proceeds.
 *
 * No-Stripe deployments (self-hosted, no `STRIPE_SECRET_KEY`) and
 * deployments without an internal DB no-op cleanly (`attempted: false`).
 *
 * Repo seam rule: this is `lib/` code — it must never import from
 * `api/routes/`. Routes call down into it.
 */
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getStripeClient } from "./stripe-client";

const log = createLogger("billing:workspace-teardown");

/** Outcome of one Stripe teardown helper invocation. */
export interface StripeTeardownOutcome {
  /**
   * `false` when nothing was attempted — Stripe isn't configured
   * (`STRIPE_SECRET_KEY` unset) or there is no internal DB. The caller can
   * treat this as a clean no-op.
   */
  attempted: boolean;
  /** Human-readable notes about each Stripe action taken (for audit metadata). */
  actions: string[];
  /**
   * Operator-facing failure messages. Non-empty means at least one Stripe
   * call failed and needs manual follow-up in the Stripe dashboard —
   * surface these in the admin response, never swallow them.
   */
  warnings: string[];
}

/** Fresh no-op outcome — Stripe not configured / no internal DB. */
function noopOutcome(): StripeTeardownOutcome {
  return { attempted: false, actions: [], warnings: [] };
}

/**
 * Audit-metadata fragment recording the Stripe teardown outcome on the
 * admin action row — empty when nothing was attempted (self-hosted /
 * no-Stripe), so no-op deployments don't grow a misleading `stripe` key.
 * Shared by the platform-admin and admin-orgs lifecycle routes (#3459).
 */
export function stripeAuditMetadata(billing: StripeTeardownOutcome): Record<string, unknown> {
  return billing.attempted
    ? { stripe: { actions: billing.actions, warnings: billing.warnings } }
    : {};
}

/**
 * Response fragment surfacing Stripe teardown failures to the operator —
 * a Stripe API failure must never strand the operation silently (#3425).
 * Shared by the platform-admin and admin-orgs lifecycle routes (#3459).
 */
export function withWarnings(billing: StripeTeardownOutcome): { warnings?: string[] } {
  return billing.warnings.length > 0 ? { warnings: billing.warnings } : {};
}

/**
 * Subscription statuses that need no remote action — Stripe already
 * considers them terminated.
 */
const TERMINAL_STATUSES = new Set(["canceled", "incomplete_expired"]);

interface SubscriptionRow {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  status: string | null;
  [key: string]: unknown;
}

/**
 * Stripe "the object no longer exists" — treat as already torn down.
 * Exported so the durable-outbox sweep (`reconcile-stripe-teardown.ts`) shares
 * the exact same terminal-success predicate as the inline teardown path.
 */
export function isStripeResourceMissing(err: unknown): boolean {
  return (
    typeof err === "object"
    && err !== null
    && (err as { code?: unknown }).code === "resource_missing"
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A Stripe teardown op that outlived its inline attempt — durably retried. */
export type StripeTeardownOp = "cancel_subscription" | "delete_customer";

/**
 * One row to persist into the `stripe_teardown_pending` outbox. The operative
 * id depends on `op` (subscription id for a cancel, customer id for a delete);
 * the migration's CHECK enforces the right one is present.
 */
export interface PendingTeardownOp {
  workspaceId: string;
  op: StripeTeardownOp;
  stripeSubId: string | null;
  stripeCustomerId: string | null;
  lastError: string | null;
}

/**
 * Persist failed/drift-detected Stripe teardown ops into the durable outbox so
 * the scheduler sweep can retry them until success or `resource_missing`.
 * Idempotent: a Stripe id can only be pending once per op (partial unique
 * indexes), so re-running a teardown refreshes `last_error` instead of growing
 * duplicate rows. Returns the number of ops written. No-ops without an internal
 * DB. Throws on internal-DB failure — callers wrap it so the teardown helper
 * stays total (see {@link persistPendingTeardown}).
 */
export async function enqueueStripeTeardownOps(ops: PendingTeardownOp[]): Promise<number> {
  if (ops.length === 0 || !hasInternalDB()) return 0;

  let enqueued = 0;
  for (const op of ops) {
    if (op.op === "cancel_subscription") {
      if (!op.stripeSubId) continue;
      await internalQuery(
        `INSERT INTO stripe_teardown_pending (workspace_id, stripe_sub_id, stripe_customer_id, op, last_error)
         VALUES ($1, $2, $3, 'cancel_subscription', $4)
         ON CONFLICT (stripe_sub_id) WHERE op = 'cancel_subscription'
         DO UPDATE SET
           last_error = EXCLUDED.last_error,
           stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, stripe_teardown_pending.stripe_customer_id),
           updated_at = NOW()`,
        [op.workspaceId, op.stripeSubId, op.stripeCustomerId, op.lastError],
      );
    } else {
      if (!op.stripeCustomerId) continue;
      await internalQuery(
        `INSERT INTO stripe_teardown_pending (workspace_id, stripe_customer_id, op, last_error)
         VALUES ($1, $2, 'delete_customer', $3)
         ON CONFLICT (stripe_customer_id) WHERE op = 'delete_customer'
         DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = NOW()`,
        [op.workspaceId, op.stripeCustomerId, op.lastError],
      );
    }
    enqueued += 1;
  }
  return enqueued;
}

/**
 * Flush collected pending ops to the durable outbox without breaking the
 * teardown helper's total contract: an internal-DB failure here is logged and
 * surfaced as a warning (the legacy manual-follow-up fallback) rather than
 * thrown — the lifecycle op must still proceed.
 */
async function persistPendingTeardown(
  orgId: string,
  pending: PendingTeardownOp[],
  warnings: string[],
): Promise<void> {
  if (pending.length === 0) return;
  try {
    const enqueued = await enqueueStripeTeardownOps(pending);
    log.info(
      { orgId, enqueued },
      "Persisted Stripe teardown ops to durable outbox for automatic retry",
    );
  } catch (err) {
    const msg = errMessage(err);
    log.error(
      { orgId, err: msg },
      "Failed to persist Stripe teardown ops to durable outbox — falling back to manual-follow-up warnings",
    );
    warnings.push(
      `Could not record failed Stripe teardown operations for automatic retry (${msg}). `
      + "Follow up manually in the Stripe dashboard using the ids above.",
    );
  }
}

/**
 * Page through a customer's Stripe subscriptions and return the ones still
 * live (non-terminal). Used for drift detection — when teardown finds zero
 * LOCAL subscription rows but the org carries a `stripeCustomerId`, a drifted
 * local table (manual row delete, sync gap) could otherwise hide a live
 * subscription that keeps invoicing a deleted workspace.
 */
async function listLiveStripeSubscriptionsForCustomer(
  stripe: NonNullable<ReturnType<typeof getStripeClient>>,
  stripeCustomerId: string,
): Promise<{ id: string; customerId: string | null }[]> {
  const live: { id: string; customerId: string | null }[] = [];
  let startingAfter: string | undefined;
  // Cap the page walk defensively (mirrors the open-invoice walk) so a
  // mis-paging Stripe response can't spin forever; a customer realistically
  // carries a handful of subscriptions, so this rarely loops more than once.
  for (let page = 0; page < 1000; page++) {
    const res = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const sub of res.data) {
      if (typeof sub.id !== "string") continue;
      const status = typeof sub.status === "string" ? sub.status : null;
      if (status && TERMINAL_STATUSES.has(status)) continue;
      const customerId = typeof sub.customer === "string" ? sub.customer : stripeCustomerId;
      live.push({ id: sub.id, customerId });
    }
    if (!res.has_more || res.data.length === 0) break;
    const lastId = res.data[res.data.length - 1]?.id;
    if (typeof lastId !== "string") break;
    startingAfter = lastId;
  }
  return live;
}

/**
 * Drift detection (#3679, audit Part A #7/#8): teardown found NO local
 * subscription rows, but the org has a `stripeCustomerId`. Query Stripe
 * directly; any live subscription found is enqueued for durable cancellation
 * and surfaced as a warning, rather than silently no-op'ing. A Stripe read
 * failure here is logged + warned, never thrown (the helper stays total).
 */
async function detectCustomerSubscriptionDrift(
  orgId: string,
  stripeCustomerId: string,
  actions: string[],
  warnings: string[],
  pending: PendingTeardownOp[],
): Promise<void> {
  const stripe = getStripeClient();
  if (!stripe) return; // callers gate before reaching here

  let liveSubs: { id: string; customerId: string | null }[];
  try {
    liveSubs = await listLiveStripeSubscriptionsForCustomer(stripe, stripeCustomerId);
  } catch (err) {
    const msg = errMessage(err);
    log.error(
      { orgId, stripeCustomerId, err: msg },
      "Failed to query Stripe for live subscriptions during teardown drift detection",
    );
    warnings.push(
      `Could not check Stripe for live subscriptions on customer ${stripeCustomerId} (${msg}). `
      + "Check the Stripe dashboard manually for subscriptions that should be canceled.",
    );
    return;
  }

  if (liveSubs.length === 0) return;

  for (const sub of liveSubs) {
    pending.push({
      workspaceId: orgId,
      op: "cancel_subscription",
      stripeSubId: sub.id,
      stripeCustomerId: sub.customerId ?? stripeCustomerId,
      lastError: "drift: live in Stripe with no local subscription row at teardown",
    });
    actions.push(
      `detected live Stripe subscription ${sub.id} with no local record — enqueued for cancellation`,
    );
    log.warn(
      { orgId, stripeSubscriptionId: sub.id, stripeCustomerId },
      "Drift detected: live Stripe subscription with no local subscription row — enqueued for durable cancellation",
    );
  }
  warnings.push(
    `Found ${liveSubs.length} live Stripe subscription(s) on customer ${stripeCustomerId} with no local record — `
    + "enqueued for automatic cancellation.",
  );
}

/**
 * Read the org's subscription rows from the @better-auth/stripe plugin's
 * `subscription` table. The table only exists once the plugin has run its
 * migrations, so `undefined_table` (42P01) means "no subscriptions", while
 * any other DB error is surfaced as a warning — silently returning an empty
 * list on a real failure would strand live subscriptions invisibly.
 */
async function listStripeSubscriptions(
  orgId: string,
): Promise<{ rows: SubscriptionRow[]; warning: string | null }> {
  try {
    const rows = await internalQuery<SubscriptionRow>(
      `SELECT "stripeSubscriptionId", "stripeCustomerId", status
         FROM subscription
        WHERE "referenceId" = $1 AND "stripeSubscriptionId" IS NOT NULL`,
      [orgId],
    );
    return { rows, warning: null };
  } catch (err) {
    if ((err as { code?: unknown }).code === "42P01") {
      log.debug(
        { orgId },
        "subscription table does not exist — no Stripe subscriptions to tear down",
      );
      return { rows: [], warning: null };
    }
    const msg = errMessage(err);
    log.error(
      { orgId, err: msg },
      "Failed to read subscription rows for Stripe teardown — live subscriptions may remain",
    );
    return {
      rows: [],
      warning:
        `Could not read this workspace's subscription records (${msg}). `
        + "Check the Stripe dashboard for live subscriptions belonging to this workspace.",
    };
  }
}

/**
 * Cancel one Stripe subscription, folding the result into actions/warnings.
 * On a (non-`resource_missing`) failure the op is ALSO appended to `pending`
 * so the caller can persist it to the durable outbox — the warning is the
 * legacy manual-follow-up fallback, the outbox is the retry mechanism (#3679).
 */
async function cancelOneSubscription(
  orgId: string,
  stripeSubscriptionId: string,
  stripeCustomerId: string | null,
  actions: string[],
  warnings: string[],
  pending: PendingTeardownOp[],
): Promise<void> {
  const stripe = getStripeClient();
  if (!stripe) return; // callers gate before reaching here
  try {
    await stripe.subscriptions.cancel(stripeSubscriptionId);
    actions.push(`canceled Stripe subscription ${stripeSubscriptionId}`);
    log.info(
      { orgId, stripeSubscriptionId },
      "Canceled Stripe subscription during workspace teardown",
    );
  } catch (err) {
    if (isStripeResourceMissing(err)) {
      actions.push(`Stripe subscription ${stripeSubscriptionId} already absent in Stripe`);
      log.info(
        { orgId, stripeSubscriptionId },
        "Stripe subscription already absent during workspace teardown",
      );
      return;
    }
    const msg = errMessage(err);
    log.error(
      { orgId, stripeSubscriptionId, err: msg },
      "Failed to cancel Stripe subscription during workspace teardown",
    );
    pending.push({
      workspaceId: orgId,
      op: "cancel_subscription",
      stripeSubId: stripeSubscriptionId,
      stripeCustomerId,
      lastError: msg,
    });
    warnings.push(
      `Failed to cancel Stripe subscription ${stripeSubscriptionId}: ${msg}. `
      + "It has been queued for automatic retry; cancel it manually in the Stripe dashboard if it persists.",
    );
  }
}

/**
 * Workspace delete: cancel every non-terminal Stripe subscription for the
 * org. Call BEFORE the DB cascade (see module doc for the ordering
 * rationale). Total — never throws; failures land in `warnings` AND are
 * persisted to the durable outbox for retry (#3679).
 *
 * `stripeCustomerId` (the org's `organization."stripeCustomerId"`, read by the
 * caller before the cascade) enables drift detection: when there are no local
 * subscription rows but the org has a customer, Stripe is queried directly so
 * a drifted local table can't leave a live subscription invoicing.
 */
export async function cancelStripeSubscriptionsForWorkspace(
  orgId: string,
  stripeCustomerId: string | null = null,
): Promise<StripeTeardownOutcome> {
  if (!hasInternalDB() || !getStripeClient()) return noopOutcome();

  const actions: string[] = [];
  const warnings: string[] = [];
  const pending: PendingTeardownOp[] = [];
  const { rows, warning } = await listStripeSubscriptions(orgId);
  if (warning) warnings.push(warning);

  for (const row of rows) {
    if (row.status && TERMINAL_STATUSES.has(row.status)) continue;
    await cancelOneSubscription(
      orgId,
      row.stripeSubscriptionId,
      row.stripeCustomerId ?? stripeCustomerId,
      actions,
      warnings,
      pending,
    );
  }

  // Drift: no local rows but a live Stripe customer — query Stripe directly.
  if (rows.length === 0 && stripeCustomerId) {
    await detectCustomerSubscriptionDrift(orgId, stripeCustomerId, actions, warnings, pending);
  }

  await persistPendingTeardown(orgId, pending, warnings);

  return { attempted: true, actions, warnings };
}

/**
 * GDPR purge: cancel any remaining subscriptions, then permanently delete
 * the Stripe customer(s) linked to the org — a purged workspace must retain
 * no billable Stripe linkage.
 *
 * `stripeCustomerId` is the plugin-owned `organization."stripeCustomerId"`
 * value (#3417) read by the caller BEFORE the purge cascade destroys the
 * organization row. Customer ids found on subscription rows are unioned in
 * defensively, so a drifted org column can't leave a customer behind.
 *
 * Total — never throws; failures land in `warnings`.
 */
export async function purgeStripeBillingForWorkspace(
  orgId: string,
  stripeCustomerId: string | null,
): Promise<StripeTeardownOutcome> {
  if (!hasInternalDB()) return noopOutcome();
  const stripe = getStripeClient();
  if (!stripe) return noopOutcome();

  const actions: string[] = [];
  const warnings: string[] = [];
  const pending: PendingTeardownOp[] = [];
  const { rows, warning } = await listStripeSubscriptions(orgId);
  if (warning) warnings.push(warning);

  // Cancel subscriptions first, then delete the customer — mirrors the
  // ordering the @better-auth/stripe plugin enforces for user-initiated
  // org deletion (#3425 plugin-review note).
  for (const row of rows) {
    if (row.status && TERMINAL_STATUSES.has(row.status)) continue;
    await cancelOneSubscription(
      orgId,
      row.stripeSubscriptionId,
      row.stripeCustomerId ?? stripeCustomerId,
      actions,
      warnings,
      pending,
    );
  }

  // Drift: no local rows but a live Stripe customer — query Stripe directly so
  // a purge can't leave a live subscription the drifted local table hid.
  if (rows.length === 0 && stripeCustomerId) {
    await detectCustomerSubscriptionDrift(orgId, stripeCustomerId, actions, warnings, pending);
  }

  const customerIds = new Set<string>();
  if (stripeCustomerId) customerIds.add(stripeCustomerId);
  for (const row of rows) {
    if (row.stripeCustomerId) customerIds.add(row.stripeCustomerId);
  }

  for (const customerId of customerIds) {
    try {
      await stripe.customers.del(customerId);
      actions.push(`deleted Stripe customer ${customerId}`);
      log.info(
        { orgId, stripeCustomerId: customerId },
        "Deleted Stripe customer during GDPR purge",
      );
    } catch (err) {
      if (isStripeResourceMissing(err)) {
        actions.push(`Stripe customer ${customerId} already absent in Stripe`);
        log.info(
          { orgId, stripeCustomerId: customerId },
          "Stripe customer already absent during GDPR purge",
        );
        continue;
      }
      const msg = errMessage(err);
      log.error(
        { orgId, stripeCustomerId: customerId, err: msg },
        "Failed to delete Stripe customer during GDPR purge",
      );
      pending.push({
        workspaceId: orgId,
        op: "delete_customer",
        stripeSubId: null,
        stripeCustomerId: customerId,
        lastError: msg,
      });
      warnings.push(
        `Failed to delete Stripe customer ${customerId}: ${msg}. `
        + "It has been queued for automatic retry; delete it manually in the Stripe dashboard if it persists — a GDPR purge must not leave a billable customer record.",
      );
    }
  }

  await persistPendingTeardown(orgId, pending, warnings);

  return { attempted: true, actions, warnings };
}

/**
 * Void the invoices already open (incl. past-due) on a subscription at
 * pause time (#3467). `pause_collection: { behavior: "void" }` only
 * affects invoices generated AFTER the pause — Stripe keeps retrying
 * invoices that were open before it, so a workspace suspended mid-dunning
 * would still get charged. Policy decision (recorded on #3467): VOID them
 * — suspension means "stop invoicing/dunning for the suspension window",
 * and we don't intend to retroactively collect (same rationale as
 * `behavior: "void"` itself). Voiding is terminal in Stripe, so resume
 * never resurrects these; the next cycle bills normally.
 *
 * Total — failures (list or per-invoice void) land in `warnings`.
 */
async function voidOpenInvoicesForSubscription(
  orgId: string,
  stripeSubscriptionId: string,
  actions: string[],
  warnings: string[],
): Promise<void> {
  const stripe = getStripeClient();
  if (!stripe) return; // callers gate before reaching here

  const openInvoiceIds: string[] = [];
  try {
    // Page through ALL open invoices, not just the first 100 — a
    // long-delinquent or manually-invoiced subscription can carry more
    // than one page, and any unvoided page keeps dunning the suspended
    // workspace (#3467 review). Cap the page walk defensively so a
    // mis-paging Stripe response can't spin forever.
    let startingAfter: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const invoices = await stripe.invoices.list({
        subscription: stripeSubscriptionId,
        status: "open",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const inv of invoices.data) {
        if (typeof inv.id === "string") openInvoiceIds.push(inv.id);
      }
      if (!invoices.has_more || invoices.data.length === 0) break;
      const lastId = invoices.data[invoices.data.length - 1]?.id;
      if (typeof lastId !== "string") break;
      startingAfter = lastId;
    }
  } catch (err) {
    const msg = errMessage(err);
    log.error(
      { orgId, stripeSubscriptionId, err: msg },
      "Failed to list open invoices during workspace suspend",
    );
    warnings.push(
      `Failed to list open invoices on Stripe subscription ${stripeSubscriptionId}: ${msg}. `
      + "Check the Stripe dashboard and void any open invoices manually so the suspended workspace isn't charged.",
    );
    return;
  }

  for (const invoiceId of openInvoiceIds) {
    try {
      await stripe.invoices.voidInvoice(invoiceId);
      actions.push(`voided open invoice ${invoiceId} on Stripe subscription ${stripeSubscriptionId}`);
      log.info(
        { orgId, stripeSubscriptionId, invoiceId },
        "Voided open invoice during workspace suspend",
      );
    } catch (err) {
      if (isStripeResourceMissing(err)) {
        actions.push(`invoice ${invoiceId} already absent in Stripe`);
        log.info(
          { orgId, stripeSubscriptionId, invoiceId },
          "Invoice already absent during workspace suspend",
        );
        continue;
      }
      const msg = errMessage(err);
      log.error(
        { orgId, stripeSubscriptionId, invoiceId, err: msg },
        "Failed to void open invoice during workspace suspend",
      );
      warnings.push(
        `Failed to void open invoice ${invoiceId} on Stripe subscription ${stripeSubscriptionId}: ${msg}. `
        + "Void it manually in the Stripe dashboard so the suspended workspace isn't charged.",
      );
    }
  }
}

/**
 * Shared pause/resume implementation — both flip `pause_collection` on the
 * org's non-terminal subscriptions.
 */
async function updateCollectionForWorkspace(
  orgId: string,
  mode: "pause" | "resume",
): Promise<StripeTeardownOutcome> {
  if (!hasInternalDB()) return noopOutcome();
  const stripe = getStripeClient();
  if (!stripe) return noopOutcome();

  const actions: string[] = [];
  const warnings: string[] = [];
  const { rows, warning } = await listStripeSubscriptions(orgId);
  if (warning) warnings.push(warning);

  for (const row of rows) {
    if (row.status && TERMINAL_STATUSES.has(row.status)) continue;
    const id = row.stripeSubscriptionId;
    try {
      await stripe.subscriptions.update(
        id,
        // "" is Stripe's typed Emptyable — clears pause_collection entirely.
        mode === "pause"
          ? { pause_collection: { behavior: "void" } }
          : { pause_collection: "" },
      );
      actions.push(
        mode === "pause"
          ? `paused collection on Stripe subscription ${id}`
          : `resumed collection on Stripe subscription ${id}`,
      );
      log.info(
        { orgId, stripeSubscriptionId: id, mode },
        "Updated Stripe pause_collection during workspace suspend/unsuspend",
      );
      // Pause only stops FUTURE invoices — invoices already open keep
      // dunning, so void them too (#3467). Resume deliberately does not
      // touch invoices: voiding is terminal, the next cycle bills fresh.
      if (mode === "pause") {
        await voidOpenInvoicesForSubscription(orgId, id, actions, warnings);
      }
    } catch (err) {
      if (isStripeResourceMissing(err)) {
        actions.push(`Stripe subscription ${id} already absent in Stripe`);
        log.info(
          { orgId, stripeSubscriptionId: id, mode },
          "Stripe subscription already absent during suspend/unsuspend",
        );
        continue;
      }
      const msg = errMessage(err);
      log.error(
        { orgId, stripeSubscriptionId: id, mode, err: msg },
        "Failed to update Stripe pause_collection during workspace suspend/unsuspend",
      );
      warnings.push(
        mode === "pause"
          ? `Failed to pause collection on Stripe subscription ${id}: ${msg}. `
            + "Pause it manually in the Stripe dashboard so the suspended workspace isn't invoiced."
          : `Failed to resume collection on Stripe subscription ${id}: ${msg}. `
            + "Resume it manually in the Stripe dashboard or the workspace won't be invoiced.",
      );
    }
  }

  return { attempted: true, actions, warnings };
}

/**
 * Suspension billing policy (#3425, recorded in the issue triage note):
 * **pause payment collection** (`pause_collection: { behavior: "void" }`)
 * rather than cancel the subscription or let dunning continue — a suspended
 * workspace can't use the product, so invoices generated while suspended
 * are voided. The subscription itself stays alive, so unsuspending restores
 * billing without a new checkout. `behavior: "void"` (not `"keep_as_draft"`)
 * because we don't intend to retroactively collect for the suspension
 * window.
 *
 * Invoices already open at pause time keep dunning despite the pause
 * (Stripe pauses future invoice GENERATION only), so they are voided as
 * part of the same operation — see
 * {@link voidOpenInvoicesForSubscription} (#3467). The
 * `invoice.payment_failed` auto-suspension ladder does NOT go through
 * this helper — it intentionally keeps dunning so payment can recover.
 */
export async function pauseStripeCollectionForWorkspace(
  orgId: string,
): Promise<StripeTeardownOutcome> {
  return updateCollectionForWorkspace(orgId, "pause");
}

/**
 * Unsuspend: clear `pause_collection` so normal invoicing resumes. See
 * {@link pauseStripeCollectionForWorkspace} for the policy rationale.
 */
export async function resumeStripeCollectionForWorkspace(
  orgId: string,
): Promise<StripeTeardownOutcome> {
  return updateCollectionForWorkspace(orgId, "resume");
}
