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

/** Stripe "the object no longer exists" — treat as already torn down. */
function isResourceMissing(err: unknown): boolean {
  return (
    typeof err === "object"
    && err !== null
    && (err as { code?: unknown }).code === "resource_missing"
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** Cancel one Stripe subscription, folding the result into actions/warnings. */
async function cancelOneSubscription(
  orgId: string,
  stripeSubscriptionId: string,
  actions: string[],
  warnings: string[],
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
    if (isResourceMissing(err)) {
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
    warnings.push(
      `Failed to cancel Stripe subscription ${stripeSubscriptionId}: ${msg}. `
      + "Cancel it manually in the Stripe dashboard.",
    );
  }
}

/**
 * Workspace delete: cancel every non-terminal Stripe subscription for the
 * org. Call BEFORE the DB cascade (see module doc for the ordering
 * rationale). Total — never throws; failures land in `warnings`.
 */
export async function cancelStripeSubscriptionsForWorkspace(
  orgId: string,
): Promise<StripeTeardownOutcome> {
  if (!hasInternalDB() || !getStripeClient()) return noopOutcome();

  const actions: string[] = [];
  const warnings: string[] = [];
  const { rows, warning } = await listStripeSubscriptions(orgId);
  if (warning) warnings.push(warning);

  for (const row of rows) {
    if (row.status && TERMINAL_STATUSES.has(row.status)) continue;
    await cancelOneSubscription(orgId, row.stripeSubscriptionId, actions, warnings);
  }

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
  const { rows, warning } = await listStripeSubscriptions(orgId);
  if (warning) warnings.push(warning);

  // Cancel subscriptions first, then delete the customer — mirrors the
  // ordering the @better-auth/stripe plugin enforces for user-initiated
  // org deletion (#3425 plugin-review note).
  for (const row of rows) {
    if (row.status && TERMINAL_STATUSES.has(row.status)) continue;
    await cancelOneSubscription(orgId, row.stripeSubscriptionId, actions, warnings);
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
      if (isResourceMissing(err)) {
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
      warnings.push(
        `Failed to delete Stripe customer ${customerId}: ${msg}. `
        + "Delete it manually in the Stripe dashboard — a GDPR purge must not leave a billable customer record.",
      );
    }
  }

  return { attempted: true, actions, warnings };
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
    } catch (err) {
      if (isResourceMissing(err)) {
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
