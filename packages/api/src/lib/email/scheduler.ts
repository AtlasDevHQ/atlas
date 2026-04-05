/**
 * Onboarding email scheduled check.
 *
 * Runs periodically to send time-based fallback emails for users
 * who haven't hit milestones within the expected timeframes.
 *
 * The periodic timer is managed by the SchedulerLayer fiber in
 * lib/effect/layers.ts, not a module-level setInterval.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { checkFallbackEmails, isOnboardingEmailEnabled } from "./engine";

const log = createLogger("onboarding-email-scheduler");

/** Default interval: 1 hour. */
export const DEFAULT_EMAIL_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;

/** Check whether the email scheduler should run. */
export function isEmailSchedulerEnabled(): boolean {
  return isOnboardingEmailEnabled();
}

/**
 * Single tick of the onboarding email scheduler.
 * Called by the SchedulerLayer fiber.
 */
export async function runTick(): Promise<void> {
  try {
    const result = await checkFallbackEmails();
    if (result.sent > 0) {
      log.info({ checked: result.checked, sent: result.sent }, "Onboarding fallback tick complete");
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Onboarding email fallback tick failed",
    );
  }
}

/** Expose for testing. */
export { runTick as _runTick };
