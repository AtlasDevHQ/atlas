/**
 * Dunning (payment-failure) email sequence definition (#3424).
 *
 * Unlike the trial-expiry notices (`trial-sequence.ts`), dunning emails are
 * NOT date-scheduled — they are dispatched event-driven straight from the
 * Stripe webhook (`invoice.payment_failed` per attempt, the delinquency
 * status ladder, and the recovery signal). The step the workspace is in is
 * therefore derived from the Stripe event, not from a clock.
 *
 * The four-step ladder (triage decision on #3424):
 *   1. `dunning_past_due`  → first failed invoice / `past_due` status. The
 *      card needs attention; entitlements are RETAINED. Warning only.
 *   2. `dunning_unpaid`    → `unpaid` status. Chat/query are now BLOCKED
 *      (workspace soft-suspended) until payment is fixed.
 *   3. `dunning_suspended` → 3+ failed retries. The workspace is suspended
 *      (same blocking state as `unpaid`; final notice before Stripe gives up).
 *   4. `dunning_recovered` → the failed invoice was paid (or the subscription
 *      returned to `active`). Access is restored; confirmation notice.
 *
 * These are transactional billing communications: they do NOT consult the
 * onboarding-drip unsubscribe preference and carry no unsubscribe link
 * (mirrors trial-expiry). Their step names live outside the published
 * `OnboardingEmailStep` union in `@useatlas/types` so this feature doesn't
 * force an npm publish, and sends are recorded in the same `onboarding_emails`
 * table under the disjoint `dunning_` prefix.
 *
 * Why a step namespace at all (vs. firing blindly per webhook): Stripe can
 * redeliver the same `invoice.payment_failed` event, and the status ladder
 * can re-emit the same status. Recording each step per recipient (unique on
 * `user_id + step`) makes every rung once-per-customer — except the
 * recover→fail→recover cycle, which is handled by clearing the dunning steps
 * on recovery (see `clearDunningSteps` in `dunning.ts`).
 */

export const DUNNING_EMAIL_STEPS = [
  "dunning_past_due",
  "dunning_unpaid",
  "dunning_suspended",
  "dunning_recovered",
] as const;

export type DunningEmailStep = (typeof DUNNING_EMAIL_STEPS)[number];

export interface DunningSequenceStep {
  step: DunningEmailStep;
  /** Subject template — `{{appName}}` is replaced at render time. */
  subject: string;
  description: string;
}

export const DUNNING_EMAIL_SEQUENCE: readonly DunningSequenceStep[] = [
  {
    step: "dunning_past_due",
    subject: "Action needed: your {{appName}} payment didn't go through",
    description: "First failed payment — update card, entitlements retained",
  },
  {
    step: "dunning_unpaid",
    subject: "Your {{appName}} workspace is paused — update your payment method",
    description: "Subscription unpaid — chat/query blocked until payment is fixed",
  },
  {
    step: "dunning_suspended",
    subject: "Final notice: your {{appName}} workspace has been suspended",
    description: "3+ failed retries — workspace suspended, final notice",
  },
  {
    step: "dunning_recovered",
    subject: "You're all set — {{appName}} access restored",
    description: "Payment recovered — access restored confirmation",
  },
] as const;

/** Get the sequence step definition by step name. */
export function getDunningStepDef(step: DunningEmailStep): DunningSequenceStep | undefined {
  return DUNNING_EMAIL_SEQUENCE.find((s) => s.step === step);
}

/** The dunning steps that signal an ACTIVE delinquency (cleared on recovery). */
export const DUNNING_DELINQUENCY_STEPS: readonly DunningEmailStep[] = [
  "dunning_past_due",
  "dunning_unpaid",
  "dunning_suspended",
] as const;
