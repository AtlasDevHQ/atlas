/**
 * Onboarding email sequence types shared across API and frontend.
 *
 * Defines the email steps, milestone triggers, and tracking state for
 * the automated drip campaign sent to new workspace owners.
 */

// ── Email step identifiers ──────────────────────────────────────────

export type OnboardingEmailStep =
  | "welcome"
  | "connect_database"
  | "first_query"
  | "invite_team"
  | "explore_features";

/** Milestone events that can trigger the next email in the sequence. */
export type OnboardingMilestone =
  | "signup_completed"
  | "database_connected"
  | "first_query_executed"
  | "team_member_invited"
  | "feature_explored";

// ── Email record (persisted in onboarding_emails table) ─────────────

export interface OnboardingEmailRecord {
  id: string;
  userId: string;
  orgId: string;
  step: OnboardingEmailStep;
  sentAt: string;
  /** The milestone that triggered this email, or "time_based" for fallback nudges. */
  triggeredBy: OnboardingMilestone | "time_based";
}

// ── Sequence status (admin view) ────────────────────────────────────

export interface OnboardingEmailStatus {
  userId: string;
  email: string;
  orgId: string;
  /** Steps that have been sent. */
  sentSteps: OnboardingEmailStep[];
  /** Steps remaining. */
  pendingSteps: OnboardingEmailStep[];
  /** Whether the user has unsubscribed from onboarding emails. */
  unsubscribed: boolean;
  createdAt: string;
}

// ── Email preferences ───────────────────────────────────────────────

export interface EmailPreferences {
  userId: string;
  onboardingEmails: boolean;
  updatedAt: string;
}
