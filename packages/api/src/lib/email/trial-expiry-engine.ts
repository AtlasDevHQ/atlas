/**
 * Trial-expiry email engine (#3434).
 *
 * Each scheduler tick scans trial workspaces, computes the *effective*
 * trial end (`lib/billing/trial-state.ts` — `trial_ends_at`, falling back
 * to `createdAt + TRIAL_DAYS`, the same date enforcement cuts the
 * workspace off at), and sends the due T-3d / T-1d / expiry notice to the
 * workspace's owners and admins.
 *
 * Design notes:
 *  - Sends are recorded per recipient in the shared `onboarding_emails`
 *    table under the disjoint `trial_*` step namespace; the table's
 *    `(user_id, step)` unique index makes every notice once-per-user.
 *  - These are transactional billing notices: they do NOT consult the
 *    onboarding-drip unsubscribe preference and carry no unsubscribe link.
 *    (Dunning emails for payment failures are separate — #3424.)
 *  - Gated on the same enablement as the onboarding scheduler
 *    ({@link isOnboardingEmailEnabled}) so staging/dev profiles stay quiet
 *    and a missing internal DB no-ops.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { effectiveTrialEndsAt } from "@atlas/api/lib/billing/trial-state";
import { isOnboardingEmailEnabled, getBrandingForOrg, getBaseUrl } from "./engine";
import { nextDueTrialStep, TRIAL_EMAIL_STEPS, type TrialEmailStep } from "./trial-sequence";
import { renderTrialExpiryEmail } from "./templates";
import { sendEmail } from "./delivery";

const log = createLogger("trial-expiry-email");

/** Per-tick scan cap — trial workspaces beyond this wait for the next tick. */
const MAX_ORGS_PER_TICK = 200;

/** Recipients per workspace cap (owners + admins; defensive bound). */
const MAX_RECIPIENTS_PER_ORG = 25;

// internalQuery rows must extend Record<string, unknown>.
type TrialOrgRow = Record<string, unknown> & {
  id: string;
  trial_ends_at: string | null;
  createdAt: string;
};

type RecipientRow = Record<string, unknown> & {
  user_id: string;
  email: string;
};

async function getSentTrialSteps(userId: string): Promise<string[]> {
  const rows = await internalQuery<{ step: string }>(
    `SELECT step FROM onboarding_emails WHERE user_id = $1 AND step = ANY($2::text[])`,
    [userId, [...TRIAL_EMAIL_STEPS]],
  );
  return rows.map((r) => r.step);
}

async function recordTrialEmail(
  userId: string,
  orgId: string,
  step: TrialEmailStep,
): Promise<void> {
  await internalQuery(
    `INSERT INTO onboarding_emails (user_id, org_id, step, triggered_by, sent_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id, step) DO NOTHING`,
    [userId, orgId, step, "time_based"],
  );
}

/**
 * Scan trial workspaces and dispatch any due trial-expiry notices.
 * Called by the email scheduler tick (`scheduler.ts`).
 *
 * @param now - Injectable clock for tests.
 * @returns counts of workspaces checked and emails sent.
 */
export async function checkTrialExpiryEmails(
  now: Date = new Date(),
): Promise<{ checked: number; sent: number }> {
  if (!isOnboardingEmailEnabled()) {
    return { checked: 0, sent: 0 };
  }

  let orgs: TrialOrgRow[];
  try {
    orgs = await internalQuery<TrialOrgRow>(
      `SELECT id, trial_ends_at, "createdAt"
       FROM organization
       WHERE plan_tier = 'trial' AND deleted_at IS NULL AND suspended_at IS NULL
       LIMIT ${MAX_ORGS_PER_TICK}`,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to query trial workspaces for expiry emails",
    );
    return { checked: 0, sent: 0 };
  }

  let sent = 0;
  const baseUrl = getBaseUrl();

  for (const org of orgs) {
    try {
      const effectiveEnd = effectiveTrialEndsAt(org);
      if (!effectiveEnd) {
        log.warn(
          { orgId: org.id, trialEndsAt: org.trial_ends_at, createdAt: org.createdAt },
          "Trial workspace has no parseable effective trial end — skipping expiry emails",
        );
        continue;
      }

      // Cheap pre-filter: nothing can be due before the T-3d window opens,
      // so skip the recipient queries entirely for young trials.
      if (nextDueTrialStep(effectiveEnd.getTime(), now.getTime(), []) === null) {
        continue;
      }

      const recipients = await internalQuery<RecipientRow>(
        `SELECT m."userId" AS user_id, u.email
         FROM member m
         JOIN "user" u ON u.id = m."userId"
         WHERE m."organizationId" = $1 AND m.role IN ('owner', 'admin')
         LIMIT ${MAX_RECIPIENTS_PER_ORG}`,
        [org.id],
      );
      if (recipients.length === 0) continue;

      const branding = await getBrandingForOrg(org.id);

      for (const recipient of recipients) {
        const sentSteps = await getSentTrialSteps(recipient.user_id);
        const step = nextDueTrialStep(effectiveEnd.getTime(), now.getTime(), sentSteps);
        if (step === null) continue;

        const rendered = renderTrialExpiryEmail(step, {
          baseUrl,
          trialEndsAt: effectiveEnd,
          branding,
        });
        const result = await sendEmail(
          { to: recipient.email, subject: rendered.subject, html: rendered.html },
          org.id,
        );

        if (result.success) {
          await recordTrialEmail(recipient.user_id, org.id, step);
          sent++;
          log.info(
            { orgId: org.id, userId: recipient.user_id, step, provider: result.provider },
            "Trial-expiry email sent",
          );
        } else {
          log.error(
            { orgId: org.id, userId: recipient.user_id, step, error: result.error },
            "Trial-expiry email delivery failed",
          );
        }
      }
    } catch (err) {
      log.error(
        { orgId: org.id, err: err instanceof Error ? err.message : String(err) },
        "Error processing trial-expiry emails for workspace — continuing with remaining workspaces",
      );
    }
  }

  if (sent > 0) {
    log.info({ checked: orgs.length, sent }, "Trial-expiry email check complete");
  }
  return { checked: orgs.length, sent };
}
