/**
 * Onboarding email sequence types shared across API and frontend.
 *
 * Defines the email steps, milestone triggers, and tracking state for
 * the automated drip campaign sent to new users.
 */

// ── Email step identifiers ──────────────────────────────────────────

export const ONBOARDING_EMAIL_STEPS = [
  "welcome",
  "connect_database",
  "first_query",
  "invite_team",
  "explore_features",
] as const;

export type OnboardingEmailStep = (typeof ONBOARDING_EMAIL_STEPS)[number];

// ── Milestone triggers ──────────────────────────────────────────────

export const ONBOARDING_MILESTONES = [
  "signup_completed",
  "database_connected",
  "first_query_executed",
  "team_member_invited",
  "feature_explored",
] as const;

export type OnboardingMilestone = (typeof ONBOARDING_MILESTONES)[number];

/**
 * Trigger source for an onboarding email record. Splits into two classes —
 * triggers under which an email was *dispatched*, and *satisfaction markers*
 * under which the step is recorded complete but no message was sent:
 *
 * Dispatched:
 * - `"signup_completed"` — the welcome email (sent immediately on signup). The
 *   only milestone that mails proactively.
 * - `"time_based"` — a fallback nudge sent because the step's milestone wasn't
 *   hit within its `fallbackHours` window.
 *
 * Satisfaction markers (NO email — see api/lib/email/engine.ts `getSuppressedSteps`):
 * - an *action* {@link OnboardingMilestone} (`database_connected`,
 *   `first_query_executed`, `team_member_invited`, `feature_explored`) — recorded
 *   when the user does the thing the step nudges toward. Mailing the nudge in the
 *   same breath is backwards (a demo-only signup got "ask your first question" the
 *   instant they asked — #3962), so reaching the milestone *suppresses* the nudge
 *   instead: it marks the step done (the time-based fallback then skips it) without
 *   sending. Recorded via `onMilestoneReached`.
 * - `"demo_activated"` — the demo-only analogue for `connect_database`: a demo
 *   signup activates the bundled demo, satisfying the step without the misleading
 *   "connect your *own* database" copy (#3949). Never a key in the milestone→step
 *   map (`MILESTONE_TO_STEP`, api/lib/email/sequence.ts) — it only ever appears in
 *   a persisted record's `triggeredBy`.
 */
export type OnboardingEmailTrigger = OnboardingMilestone | "time_based" | "demo_activated";

// ── Email record (persisted in onboarding_emails table) ─────────────

export interface OnboardingEmailRecord {
  id: string;
  userId: string;
  orgId: string;
  step: OnboardingEmailStep;
  sentAt: string;
  /** The milestone that triggered this email, or "time_based" for fallback nudges. */
  triggeredBy: OnboardingEmailTrigger;
}

// ── Sequence status (admin view) ────────────────────────────────────

export interface OnboardingEmailStatus {
  userId: string;
  email: string;
  orgId: string;
  /**
   * Steps whose email was actually dispatched. Excludes steps satisfied without
   * a send (see `suppressedSteps`). `sentSteps ∪ suppressedSteps` are the
   * completed steps, and together with `pendingSteps` they partition the full
   * sequence.
   */
  sentSteps: OnboardingEmailStep[];
  /**
   * Steps marked complete WITHOUT an email being sent — e.g. `connect_database`
   * satisfied by activating the demo (#3949). Completed for drip-progression
   * purposes (so they are not in `pendingSteps`) but no message went out.
   */
  suppressedSteps: OnboardingEmailStep[];
  /** Steps remaining. Complement of the completed steps (sent + suppressed) against the full sequence. */
  pendingSteps: OnboardingEmailStep[];
  /** Whether the user has unsubscribed from onboarding emails. */
  unsubscribed: boolean;
  createdAt: string;
}

// ── Email preferences ───────────────────────────────────────────────

export interface OnboardingEmailPreferences {
  userId: string;
  onboardingEmails: boolean;
  updatedAt: string;
}

/** @deprecated Use OnboardingEmailPreferences instead. */
export type EmailPreferences = OnboardingEmailPreferences;
