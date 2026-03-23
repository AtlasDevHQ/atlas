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

/** Trigger source for an onboarding email — either a milestone or a time-based fallback. */
export type OnboardingEmailTrigger = OnboardingMilestone | "time_based";

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
  /** Steps that have been sent. Together with pendingSteps, partitions all OnboardingEmailStep values. */
  sentSteps: OnboardingEmailStep[];
  /** Steps remaining. Complement of sentSteps against the full sequence. */
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
