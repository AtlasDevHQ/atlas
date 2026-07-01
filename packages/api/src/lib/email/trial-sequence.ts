/**
 * Trial-expiry email sequence definition (#3434).
 *
 * Three billing notices sent to trial-workspace owners/admins relative to
 * the workspace's *effective* trial end (`lib/billing/trial-state.ts` —
 * the same date enforcement cuts the workspace off at):
 *
 *   T-3d  → "your trial ends in 3 days"
 *   T-1d  → "your trial ends tomorrow"
 *   T+0   → "your trial has expired"
 *
 * Deliberately separate from the onboarding drip in `sequence.ts`: trial
 * notices are transactional billing communications (no unsubscribe gate,
 * recipients are the workspace's billing-capable roles, the trigger is a
 * date — not a milestone), and their step names live outside the published
 * `OnboardingEmailStep` union in `@useatlas/types` so this feature doesn't
 * force an npm publish. Sends are recorded in the same `onboarding_emails`
 * table (TEXT step column, unique on user_id+step) under the disjoint
 * `trial_` prefix.
 *
 * Dunning (payment-failure) emails are out of scope here — tracked in #3424.
 */

const MS_PER_DAY = 86_400_000;

export const TRIAL_EMAIL_STEPS = [
  "trial_ending_3d",
  "trial_ending_1d",
  "trial_expired",
] as const;

export type TrialEmailStep = (typeof TRIAL_EMAIL_STEPS)[number];

export interface TrialSequenceStep {
  step: TrialEmailStep;
  /** Days before the effective trial end at which this email becomes due. 0 = at expiry. */
  daysBeforeExpiry: number;
  /** Subject template — `{{appName}}` is replaced at render time. */
  subject: string;
  description: string;
}

/** Ordered by increasing urgency — the LAST due entry wins. */
export const TRIAL_EMAIL_SEQUENCE: readonly TrialSequenceStep[] = [
  {
    step: "trial_ending_3d",
    daysBeforeExpiry: 3,
    subject: "Your {{appName}} trial ends in 3 days",
    description: "T-3 days warning with upgrade CTA",
  },
  {
    step: "trial_ending_1d",
    daysBeforeExpiry: 1,
    subject: "Your {{appName}} trial ends tomorrow",
    description: "T-1 day warning with upgrade CTA",
  },
  {
    step: "trial_expired",
    daysBeforeExpiry: 0,
    subject: "Your {{appName}} trial has expired",
    description: "Expiry notice with upgrade CTA",
  },
] as const;

/**
 * Don't send the expiry notice for trials that ended longer ago than this —
 * the first deploy of this feature must not email every long-churned trial
 * workspace, and a scheduler outage shouldn't flush week-old notices.
 */
export const TRIAL_EXPIRED_EMAIL_MAX_AGE_MS = 7 * MS_PER_DAY;

/** Get the sequence step definition by step name. */
export function getTrialStepDef(step: TrialEmailStep): TrialSequenceStep | undefined {
  return TRIAL_EMAIL_SEQUENCE.find((s) => s.step === step);
}

/**
 * The single trial email due for a recipient, or null.
 *
 * Policy (pinned by trial-sequence.test.ts):
 *  - Only the MOST URGENT due step is considered — crossing several
 *    thresholds between ticks yields one email, never a backlog flush, and
 *    earlier steps are never back-filled.
 *  - If that step (or any later one) was already sent, nothing is due.
 *  - The expiry notice is suppressed once the trial has been over for more
 *    than {@link TRIAL_EXPIRED_EMAIL_MAX_AGE_MS}.
 *  - An unparseable end (`NaN`) is never due — mirrors enforcement, which
 *    treats unparseable dates as not expired.
 *
 * @param effectiveEndMs - Effective trial end (epoch ms) from
 *   `effectiveTrialEndsAt`.
 * @param nowMs - Current time (epoch ms); injectable for tests.
 * @param sentSteps - Step names already recorded for this recipient. Typed
 *   `readonly string[]` because they come straight from a TEXT column.
 */
export function nextDueTrialStep(
  effectiveEndMs: number,
  nowMs: number,
  sentSteps: readonly string[],
): TrialEmailStep | null {
  if (!Number.isFinite(effectiveEndMs)) return null;

  // Stale-expiry guard: long-dead trials get nothing.
  if (nowMs - effectiveEndMs > TRIAL_EXPIRED_EMAIL_MAX_AGE_MS) return null;

  // Most urgent due step = the last sequence entry whose window has opened.
  let due: TrialEmailStep | null = null;
  let dueIndex = -1;
  for (let i = 0; i < TRIAL_EMAIL_SEQUENCE.length; i++) {
    const s = TRIAL_EMAIL_SEQUENCE[i];
    if (nowMs >= effectiveEndMs - s.daysBeforeExpiry * MS_PER_DAY) {
      due = s.step;
      dueIndex = i;
    }
  }
  if (due === null) return null;

  // Already sent — or a later step was somehow sent first — nothing due.
  const sent = new Set(sentSteps);
  for (let i = dueIndex; i < TRIAL_EMAIL_SEQUENCE.length; i++) {
    if (sent.has(TRIAL_EMAIL_SEQUENCE[i].step)) return null;
  }
  return due;
}
