/**
 * Onboarding email sequence definition.
 *
 * Defines the 5-step drip campaign, milestone triggers, and
 * time-based fallback schedule for new workspace owners.
 */

import type { OnboardingEmailStep, OnboardingMilestone } from "@useatlas/types";

export interface SequenceStep {
  step: OnboardingEmailStep;
  /** Milestone that triggers this email immediately. */
  trigger: OnboardingMilestone;
  /** Hours after signup to send a nudge if milestone not yet hit. */
  fallbackHours: number;
  subject: string;
  /** Short description for admin UI. */
  description: string;
}

/**
 * The ordered onboarding email sequence.
 *
 * Each step is triggered either by hitting a milestone or by a time-based
 * fallback (nudge) if the milestone hasn't been reached.
 */
export const ONBOARDING_SEQUENCE: readonly SequenceStep[] = [
  {
    step: "welcome",
    trigger: "signup_completed",
    fallbackHours: 0, // sent immediately on signup
    subject: "Welcome to {{appName}} — let's get started",
    description: "Welcome email with quick-start guide",
  },
  {
    step: "connect_database",
    trigger: "database_connected",
    fallbackHours: 24,
    subject: "Connect your database to {{appName}}",
    description: "Guide to connecting a data source",
  },
  {
    step: "first_query",
    trigger: "first_query_executed",
    fallbackHours: 72,
    subject: "Ask your first question in {{appName}}",
    description: "Prompt to run first natural-language query",
  },
  {
    step: "invite_team",
    trigger: "team_member_invited",
    fallbackHours: 168, // 7 days
    subject: "Invite your team to {{appName}}",
    description: "Encourage inviting team members",
  },
  {
    step: "explore_features",
    trigger: "feature_explored",
    fallbackHours: 168, // 7 days
    subject: "Explore what {{appName}} can do",
    description: "Highlight notebooks, admin console, and advanced features",
  },
] as const;

/** Map from milestone to the step it triggers. */
export const MILESTONE_TO_STEP = new Map<OnboardingMilestone, OnboardingEmailStep>(
  ONBOARDING_SEQUENCE.map((s) => [s.trigger, s.step]),
);

/** Get the sequence step definition by step name. */
export function getStepDef(step: OnboardingEmailStep): SequenceStep | undefined {
  return ONBOARDING_SEQUENCE.find((s) => s.step === step);
}
