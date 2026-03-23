/**
 * Onboarding email module.
 *
 * Automated drip campaign for new workspace owners:
 * welcome → connect database → first query → invite team → explore features.
 */

export { isOnboardingEmailEnabled, sendOnboardingEmail, onMilestoneReached, checkFallbackEmails, unsubscribeUser, resubscribeUser, getOnboardingStatuses } from "./engine";
export { ONBOARDING_SEQUENCE, MILESTONE_TO_STEP, getStepDef } from "./sequence";
export { renderOnboardingEmail } from "./templates";
export { sendEmail } from "./delivery";
export type { EmailMessage, DeliveryResult } from "./delivery";
export type { RenderedEmail } from "./templates";
export type { SequenceStep } from "./sequence";
export { onUserSignup, onDatabaseConnected, onFirstQueryExecuted, onTeamMemberInvited, onFeatureExplored } from "./hooks";
export { startOnboardingEmailScheduler, stopOnboardingEmailScheduler } from "./scheduler";
