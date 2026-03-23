/**
 * Onboarding email scheduled check.
 *
 * Runs periodically to send time-based fallback emails for users
 * who haven't hit milestones within the expected timeframes.
 *
 * Designed to be called from the existing scheduler tick or a
 * dedicated setInterval. Default interval: 1 hour.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { checkFallbackEmails, isOnboardingEmailEnabled } from "./engine";

const log = createLogger("onboarding-email-scheduler");

let _timer: ReturnType<typeof setInterval> | null = null;

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Start the onboarding email fallback scheduler.
 * Runs checkFallbackEmails on a fixed interval.
 */
export function startOnboardingEmailScheduler(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (_timer) {
    log.debug("Onboarding email scheduler already running");
    return;
  }

  if (!isOnboardingEmailEnabled()) {
    log.debug("Onboarding emails disabled — scheduler not started");
    return;
  }

  log.info({ intervalMs }, "Starting onboarding email fallback scheduler");

  // Run immediately on start
  void runTick();

  _timer = setInterval(() => {
    void runTick();
  }, intervalMs);
  _timer.unref();
}

/**
 * Stop the onboarding email fallback scheduler.
 */
export function stopOnboardingEmailScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    log.info("Onboarding email fallback scheduler stopped");
  }
}

async function runTick(): Promise<void> {
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
