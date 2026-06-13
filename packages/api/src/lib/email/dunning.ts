/**
 * Dunning (payment-failure) email dispatch (#3424).
 *
 * Event-driven sibling of the trial-expiry engine (`trial-expiry-engine.ts`):
 * the Stripe webhook (`lib/auth/server.ts`) calls {@link dispatchDunningEmail}
 * with the org and the dunning rung the workspace just reached. We resolve the
 * workspace's owners/admins and send each the rendered notice, recording the
 * send per recipient in the shared `onboarding_emails` table under the
 * disjoint `dunning_` prefix so the `(user_id, step)` unique index makes every
 * rung once-per-customer.
 *
 * CONTRACT: never throws. Dunning is the best-effort branch of the webhook
 * (the payment-failure / status sync is already durably recorded by the time
 * we get here, and a throw would force Stripe to redeliver an already-applied
 * event). Failures are logged, not propagated.
 *
 * Recovery handling: {@link clearDunningSteps} wipes the delinquency steps for
 * an org's recipients so a future fail→recover→fail cycle re-sends the ladder
 * rather than being permanently suppressed by the once-per-customer index.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { isOnboardingEmailEnabled, getBrandingForOrg, getBaseUrl } from "./engine";
import { renderDunningEmail } from "./templates";
import { sendEmail } from "./delivery";
import {
  DUNNING_DELINQUENCY_STEPS,
  type DunningEmailStep,
} from "./dunning-sequence";

const log = createLogger("dunning-email");

/** Recipients per workspace cap (owners + admins; defensive bound). */
const MAX_RECIPIENTS_PER_ORG = 25;

type RecipientRow = Record<string, unknown> & {
  user_id: string;
  email: string;
};

async function getDunningRecipients(orgId: string): Promise<RecipientRow[]> {
  return internalQuery<RecipientRow>(
    `SELECT m."userId" AS user_id, u.email
     FROM member m
     JOIN "user" u ON u.id = m."userId"
     WHERE m."organizationId" = $1 AND m.role IN ('owner', 'admin')
     LIMIT ${MAX_RECIPIENTS_PER_ORG}`,
    [orgId],
  );
}

async function recordDunningEmail(
  userId: string,
  orgId: string,
  step: DunningEmailStep,
): Promise<void> {
  await internalQuery(
    `INSERT INTO onboarding_emails (user_id, org_id, step, triggered_by, sent_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id, step) DO NOTHING`,
    [userId, orgId, step, "payment_failure"],
  );
}

/** Has this recipient already received this dunning step? (Stripe redelivers.) */
async function alreadySent(userId: string, step: DunningEmailStep): Promise<boolean> {
  const rows = await internalQuery<{ step: string }>(
    `SELECT step FROM onboarding_emails WHERE user_id = $1 AND step = $2 LIMIT 1`,
    [userId, step],
  );
  return rows.length > 0;
}

/**
 * Dispatch a single dunning rung to a workspace's owners/admins.
 *
 * @param orgId - The Atlas organization the delinquent subscription belongs to.
 * @param step  - Which dunning rung to send.
 * @returns the number of emails actually sent (0 when disabled, no recipients,
 *   or already sent). Never throws.
 */
export async function dispatchDunningEmail(
  orgId: string,
  step: DunningEmailStep,
): Promise<number> {
  // Same gate as the trial-expiry engine: a disabled profile (staging/dev) or
  // a missing internal DB makes this a no-op.
  if (!isOnboardingEmailEnabled()) {
    log.debug({ orgId, step }, "Onboarding/dunning emails disabled — skipping");
    return 0;
  }

  let sent = 0;
  try {
    const recipients = await getDunningRecipients(orgId);
    if (recipients.length === 0) {
      log.warn({ orgId, step }, "No owner/admin recipients for dunning email — skipping");
      return 0;
    }

    const branding = await getBrandingForOrg(orgId);
    const rendered = renderDunningEmail(step, { baseUrl: getBaseUrl(), branding });

    for (const recipient of recipients) {
      try {
        if (await alreadySent(recipient.user_id, step)) continue;

        const result = await sendEmail(
          { to: recipient.email, subject: rendered.subject, html: rendered.html },
          orgId,
        );

        if (result.success) {
          await recordDunningEmail(recipient.user_id, orgId, step);
          sent++;
          log.info(
            { orgId, userId: recipient.user_id, step, provider: result.provider },
            "Dunning email sent",
          );
        } else {
          log.error(
            { orgId, userId: recipient.user_id, step, error: result.error },
            "Dunning email delivery failed",
          );
        }
      } catch (err) {
        // Per-recipient isolation — one bad row must not drop the rest.
        log.error(
          { orgId, userId: recipient.user_id, step, err: err instanceof Error ? err.message : String(err) },
          "Error sending dunning email to recipient — continuing with the rest",
        );
      }
    }
  } catch (err) {
    log.error(
      { orgId, step, err: err instanceof Error ? err.message : String(err) },
      "Failed to dispatch dunning emails — payment-failure sync already recorded, not re-throwing",
    );
  }
  return sent;
}

/**
 * Clear the delinquency dunning steps for a workspace's recipients so a
 * subsequent fail→recover→fail cycle re-sends the ladder (the recovery email
 * itself, `dunning_recovered`, is intentionally NOT cleared here — it is sent
 * exactly once per recovery and re-armed by the next delinquency step).
 *
 * CONTRACT: never throws (best-effort, called from the recovery branch).
 */
export async function clearDunningSteps(orgId: string): Promise<void> {
  if (!isOnboardingEmailEnabled()) return;
  try {
    await internalQuery(
      `DELETE FROM onboarding_emails
       WHERE org_id = $1 AND step = ANY($2::text[])`,
      [orgId, [...DUNNING_DELINQUENCY_STEPS]],
    );
  } catch (err) {
    log.error(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "Failed to clear dunning steps on recovery — a future failure may not re-send the ladder",
    );
  }
}
