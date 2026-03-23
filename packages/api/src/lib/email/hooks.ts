/**
 * Onboarding milestone hooks.
 *
 * Fire-and-forget functions called from key code paths to trigger
 * onboarding emails when milestones are reached. All hooks are no-ops
 * when the feature is disabled, and errors are caught + logged.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { isOnboardingEmailEnabled, onMilestoneReached, sendOnboardingEmail } from "./engine";

const log = createLogger("onboarding-hooks");

interface UserContext {
  userId: string;
  email: string;
  orgId: string;
}

/**
 * Called after a user signs up. Sends the welcome email.
 * Fire-and-forget — errors are logged, not thrown.
 */
export function onUserSignup(user: UserContext): void {
  if (!isOnboardingEmailEnabled()) return;

  void sendOnboardingEmail(
    user.userId,
    user.email,
    user.orgId,
    "welcome",
    "signup_completed",
  ).catch((err) => {
    log.warn(
      { userId: user.userId, err: err instanceof Error ? err.message : String(err) },
      "Failed to send welcome email",
    );
  });
}

/**
 * Called after a database connection is created or completed via onboarding.
 * Fire-and-forget.
 */
export function onDatabaseConnected(user: UserContext): void {
  if (!isOnboardingEmailEnabled()) return;

  void onMilestoneReached("database_connected", user.userId, user.email, user.orgId).catch(
    (err) => {
      log.warn(
        { userId: user.userId, err: err instanceof Error ? err.message : String(err) },
        "Failed to trigger database_connected milestone email",
      );
    },
  );
}

/**
 * Called after a user's first successful chat query.
 * Fire-and-forget.
 */
export function onFirstQueryExecuted(user: UserContext): void {
  if (!isOnboardingEmailEnabled()) return;

  void onMilestoneReached("first_query_executed", user.userId, user.email, user.orgId).catch(
    (err) => {
      log.warn(
        { userId: user.userId, err: err instanceof Error ? err.message : String(err) },
        "Failed to trigger first_query_executed milestone email",
      );
    },
  );
}

/**
 * Called after a team member is invited to the workspace.
 * Fire-and-forget.
 */
export function onTeamMemberInvited(user: UserContext): void {
  if (!isOnboardingEmailEnabled()) return;

  void onMilestoneReached("team_member_invited", user.userId, user.email, user.orgId).catch(
    (err) => {
      log.warn(
        { userId: user.userId, err: err instanceof Error ? err.message : String(err) },
        "Failed to trigger team_member_invited milestone email",
      );
    },
  );
}

/**
 * Called when a user explores a feature (notebook, admin console, etc.).
 * Fire-and-forget.
 */
export function onFeatureExplored(user: UserContext): void {
  if (!isOnboardingEmailEnabled()) return;

  void onMilestoneReached("feature_explored", user.userId, user.email, user.orgId).catch(
    (err) => {
      log.warn(
        { userId: user.userId, err: err instanceof Error ? err.message : String(err) },
        "Failed to trigger feature_explored milestone email",
      );
    },
  );
}
