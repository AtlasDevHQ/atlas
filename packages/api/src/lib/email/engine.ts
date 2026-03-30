/**
 * Onboarding email engine.
 *
 * Orchestrates the drip campaign: tracks which emails have been sent per user,
 * resolves branding, renders templates, and dispatches via delivery layer.
 * Also handles time-based fallback nudges and unsubscribe.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { OnboardingEmailStep, OnboardingMilestone, OnboardingEmailTrigger, OnboardingEmailStatus } from "@useatlas/types";
import { ONBOARDING_SEQUENCE, MILESTONE_TO_STEP } from "./sequence";
import { renderOnboardingEmail } from "./templates";
import { sendEmail } from "./delivery";

const log = createLogger("onboarding-email");

/** Check whether the onboarding email feature is enabled. */
export function isOnboardingEmailEnabled(): boolean {
  return process.env.ATLAS_ONBOARDING_EMAILS_ENABLED === "true" && hasInternalDB();
}

// ── Branding resolution ─────────────────────────────────────────────

async function getBrandingForOrg(orgId: string) {
  try {
    const rows = await internalQuery<{
      logo_url: string | null;
      logo_text: string | null;
      primary_color: string | null;
      favicon_url: string | null;
      hide_atlas_branding: boolean;
    }>(
      `SELECT logo_url, logo_text, primary_color, favicon_url, hide_atlas_branding
       FROM workspace_branding WHERE org_id = $1 LIMIT 1`,
      [orgId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      logoUrl: r.logo_url,
      logoText: r.logo_text,
      primaryColor: r.primary_color,
      faviconUrl: r.favicon_url,
      hideAtlasBranding: r.hide_atlas_branding,
    };
  } catch (err) {
    log.warn({ orgId, err: err instanceof Error ? err.message : String(err) }, "Failed to fetch branding — using defaults");
    return null;
  }
}

// ── Sent tracking ───────────────────────────────────────────────────

async function getSentSteps(userId: string): Promise<OnboardingEmailStep[]> {
  const rows = await internalQuery<{ step: OnboardingEmailStep }>(
    `SELECT step FROM onboarding_emails WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.step);
}

async function isUnsubscribed(userId: string): Promise<boolean> {
  const rows = await internalQuery<{ onboarding_emails: boolean }>(
    `SELECT onboarding_emails FROM email_preferences WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  if (rows.length === 0) return false;
  return !rows[0].onboarding_emails;
}

async function recordSentEmail(
  userId: string,
  orgId: string,
  step: OnboardingEmailStep,
  triggeredBy: OnboardingEmailTrigger,
): Promise<void> {
  await internalQuery(
    `INSERT INTO onboarding_emails (user_id, org_id, step, triggered_by, sent_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id, step) DO NOTHING`,
    [userId, orgId, step, triggeredBy],
  );
}

// ── Core send logic ─────────────────────────────────────────────────

function getBaseUrl(): string {
  return process.env.BETTER_AUTH_URL
    ?? process.env.NEXT_PUBLIC_ATLAS_API_URL
    ?? "http://localhost:3000";
}

function buildUnsubscribeUrl(userId: string): string {
  const base = getBaseUrl();
  return `${base}/api/v1/onboarding-emails/unsubscribe?userId=${encodeURIComponent(userId)}`;
}

/**
 * Send a specific onboarding email to a user, if not already sent.
 *
 * @returns true if the email was sent, false if skipped (already sent, unsubscribed, etc.)
 */
export async function sendOnboardingEmail(
  userId: string,
  email: string,
  orgId: string,
  step: OnboardingEmailStep,
  triggeredBy: OnboardingEmailTrigger,
): Promise<boolean> {
  if (!isOnboardingEmailEnabled()) {
    log.debug({ userId, step }, "Onboarding emails disabled — skipping");
    return false;
  }

  try {
    // Check unsubscribe
    if (await isUnsubscribed(userId)) {
      log.debug({ userId, step }, "User unsubscribed — skipping");
      return false;
    }

    // Check already sent
    const sent = await getSentSteps(userId);
    if (sent.includes(step)) {
      log.debug({ userId, step }, "Email already sent — skipping");
      return false;
    }

    // Resolve branding
    const branding = await getBrandingForOrg(orgId);
    const baseUrl = getBaseUrl();
    const unsubscribeUrl = buildUnsubscribeUrl(userId);

    // Render and send
    const rendered = renderOnboardingEmail(step, baseUrl, unsubscribeUrl, branding);
    const result = await sendEmail({
      to: email,
      subject: rendered.subject,
      html: rendered.html,
    }, orgId);

    if (result.success) {
      await recordSentEmail(userId, orgId, step, triggeredBy);
      log.info({ userId, step, provider: result.provider }, "Onboarding email sent");
      return true;
    }

    log.error({ userId, step, error: result.error }, "Onboarding email delivery failed");
    return false;
  } catch (err) {
    log.error(
      { userId, step, err: err instanceof Error ? err.message : String(err) },
      "Error sending onboarding email",
    );
    return false;
  }
}

// ── Milestone trigger ───────────────────────────────────────────────

/**
 * Called when a user hits an onboarding milestone.
 * Sends the corresponding email if not already sent.
 */
export async function onMilestoneReached(
  milestone: OnboardingMilestone,
  userId: string,
  email: string,
  orgId: string,
): Promise<void> {
  const step = MILESTONE_TO_STEP.get(milestone);
  if (!step) {
    log.warn({ milestone }, "No email step mapped for milestone");
    return;
  }

  await sendOnboardingEmail(userId, email, orgId, step, milestone);
}

// ── Time-based fallback check ───────────────────────────────────────

/**
 * Check all users for time-based fallback emails.
 * Called periodically by the scheduler tick.
 *
 * For each user in the onboarding window, checks if any sequence step
 * is due based on signup time + fallbackHours, and sends it if so.
 */
export async function checkFallbackEmails(): Promise<{ checked: number; sent: number }> {
  if (!isOnboardingEmailEnabled()) {
    return { checked: 0, sent: 0 };
  }

  try {
    // Find users who signed up in the last 14 days and haven't completed all steps.
    // We use the user table's createdAt to determine signup time.
    const users = await internalQuery<{
      id: string;
      email: string;
      created_at: string;
    }>(
      `SELECT u.id, u.email, u."createdAt" as created_at
       FROM "user" u
       WHERE u."createdAt" > now() - interval '14 days'
         AND NOT EXISTS (
           SELECT 1 FROM email_preferences ep
           WHERE ep.user_id = u.id AND ep.onboarding_emails = false
         )
       LIMIT 100`,
    );

    let sent = 0;

    for (const user of users) {
      // Get user's org (first membership)
      const memberships = await internalQuery<{ organizationId: string }>(
        `SELECT "organizationId" FROM member WHERE "userId" = $1 LIMIT 1`,
        [user.id],
      );
      if (memberships.length === 0) continue;

      const orgId = memberships[0].organizationId;
      const sentSteps = await getSentSteps(user.id);
      const signupTime = new Date(user.created_at).getTime();
      const now = Date.now();

      for (const seqStep of ONBOARDING_SEQUENCE) {
        if (sentSteps.includes(seqStep.step)) continue;
        if (seqStep.fallbackHours === 0) continue; // welcome is immediate, not a fallback

        const dueAt = signupTime + seqStep.fallbackHours * 60 * 60 * 1000;
        if (now >= dueAt) {
          const didSend = await sendOnboardingEmail(
            user.id,
            user.email,
            orgId,
            seqStep.step,
            "time_based",
          );
          if (didSend) sent++;
          // Only send one fallback per user per tick to avoid flooding
          break;
        }
      }
    }

    log.info({ checked: users.length, sent }, "Fallback email check complete");
    return { checked: users.length, sent };
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Error checking fallback emails",
    );
    return { checked: 0, sent: 0 };
  }
}

// ── Unsubscribe ─────────────────────────────────────────────────────

export async function unsubscribeUser(userId: string): Promise<void> {
  await internalQuery(
    `INSERT INTO email_preferences (user_id, onboarding_emails, updated_at)
     VALUES ($1, false, now())
     ON CONFLICT (user_id)
     DO UPDATE SET onboarding_emails = false, updated_at = now()`,
    [userId],
  );
  log.info({ userId }, "User unsubscribed from onboarding emails");
}

export async function resubscribeUser(userId: string): Promise<void> {
  await internalQuery(
    `INSERT INTO email_preferences (user_id, onboarding_emails, updated_at)
     VALUES ($1, true, now())
     ON CONFLICT (user_id)
     DO UPDATE SET onboarding_emails = true, updated_at = now()`,
    [userId],
  );
  log.info({ userId }, "User resubscribed to onboarding emails");
}

// ── Admin query ─────────────────────────────────────────────────────

const ALL_STEPS: OnboardingEmailStep[] = ONBOARDING_SEQUENCE.map((s) => s.step);

/**
 * Get onboarding email status for users in an organization.
 * Used by the admin API.
 */
export async function getOnboardingStatuses(
  orgId: string,
  limit = 50,
  offset = 0,
): Promise<{ statuses: OnboardingEmailStatus[]; total: number }> {
  const countRows = await internalQuery<{ count: string }>(
    `SELECT COUNT(DISTINCT m."userId") as count
     FROM member m WHERE m."organizationId" = $1`,
    [orgId],
  );
  const total = parseInt(countRows[0]?.count ?? "0", 10);

  const users = await internalQuery<{
    user_id: string;
    email: string;
    created_at: string;
  }>(
    `SELECT m."userId" as user_id, u.email, u."createdAt" as created_at
     FROM member m
     JOIN "user" u ON u.id = m."userId"
     WHERE m."organizationId" = $1
     ORDER BY u."createdAt" DESC
     LIMIT $2 OFFSET $3`,
    [orgId, limit, offset],
  );

  const statuses = await Promise.all(
    users.map(async (user) => {
      try {
        const [sentSteps, unsub] = await Promise.all([
          getSentSteps(user.user_id),
          isUnsubscribed(user.user_id),
        ]);
        return {
          userId: user.user_id,
          email: user.email,
          orgId,
          sentSteps,
          pendingSteps: ALL_STEPS.filter((s) => !sentSteps.includes(s)),
          unsubscribed: unsub,
          createdAt: user.created_at,
        };
      } catch (err) {
        log.warn({ userId: user.user_id, err: err instanceof Error ? err.message : String(err) }, "Failed to fetch onboarding status for user — returning defaults");
        return {
          userId: user.user_id,
          email: user.email,
          orgId,
          sentSteps: [] as OnboardingEmailStep[],
          pendingSteps: ALL_STEPS,
          unsubscribed: false,
          createdAt: user.created_at,
        };
      }
    }),
  );

  return { statuses, total };
}
