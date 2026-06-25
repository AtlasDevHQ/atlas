/**
 * Onboarding milestone hooks.
 *
 * Fire-and-forget functions called from key code paths to trigger
 * onboarding emails when milestones are reached. All hooks are no-ops
 * when the feature is disabled, and errors are caught + logged.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  isOnboardingEmailEnabled,
  markStepSatisfied,
  onMilestoneReached,
  sendOnboardingEmail,
} from "./engine";

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
 *
 * Marks the `connect_database` step satisfied (the user just connected, so the
 * "connect your database" nudge is moot) without sending an email — see
 * {@link onMilestoneReached}. Fire-and-forget.
 */
export function onDatabaseConnected(user: UserContext): void {
  if (!isOnboardingEmailEnabled()) return;

  void onMilestoneReached("database_connected", user.userId, user.orgId).catch(
    (err) => {
      log.warn(
        { userId: user.userId, err: err instanceof Error ? err.message : String(err) },
        "Failed to trigger database_connected milestone email",
      );
    },
  );
}

/**
 * Called after a demo-only signup activates the bundled demo (`/use-demo`).
 *
 * A demo user never connects their *own* database, so the `connect_database`
 * step has two bad outcomes if left to the normal flow: firing the
 * `database_connected` milestone would *send* the misleading "Connect your
 * database" email, and conversely leaving the step unrecorded would let the 24h
 * fallback nudge fire later. Marking the step satisfied (no email) avoids both
 * and advances the drip cleanly. The rest of the sequence (first_query,
 * invite_team, …) is unaffected.
 *
 * Fire-and-forget — errors are logged, not thrown.
 */
export function onDemoActivated(user: UserContext): void {
  if (!isOnboardingEmailEnabled()) return;

  void markStepSatisfied(user.userId, user.orgId, "connect_database", "demo_activated").catch(
    (err) => {
      log.warn(
        { userId: user.userId, err: err instanceof Error ? err.message : String(err) },
        "Failed to mark connect_database step satisfied for demo activation",
      );
    },
  );
}

/**
 * Called after a user's first successful chat query (the caller gates on an
 * actually-answered query — see `turnAnsweredQuery` in activation-metrics.ts).
 *
 * Marks the `first_query` step satisfied so the 72h fallback nudge is
 * suppressed, WITHOUT mailing the "ask your first question" prompt back in the
 * same turn the user asked it (#3962) — see {@link onMilestoneReached}.
 * Fire-and-forget.
 */
export function onFirstQueryExecuted(user: UserContext): void {
  if (!isOnboardingEmailEnabled()) return;

  void onMilestoneReached("first_query_executed", user.userId, user.orgId).catch(
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
 *
 * Marks the `invite_team` step satisfied (no email) — see
 * {@link onMilestoneReached}. Fire-and-forget.
 */
export function onTeamMemberInvited(user: UserContext): void {
  if (!isOnboardingEmailEnabled()) return;

  void onMilestoneReached("team_member_invited", user.userId, user.orgId).catch(
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
 *
 * Marks the `explore_features` step satisfied (no email) — see
 * {@link onMilestoneReached}. Fire-and-forget.
 */
export function onFeatureExplored(user: UserContext): void {
  if (!isOnboardingEmailEnabled()) return;

  void onMilestoneReached("feature_explored", user.userId, user.orgId).catch(
    (err) => {
      log.warn(
        { userId: user.userId, err: err instanceof Error ? err.message : String(err) },
        "Failed to trigger feature_explored milestone email",
      );
    },
  );
}
