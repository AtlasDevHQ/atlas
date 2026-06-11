/**
 * Sender preflight for scheduled-task delivery channels (#3379).
 *
 * On default self-hosted installs, scheduled-task creation accepts `email`
 * and `slack` recipients on a pure schema basis while the runtime sender is
 * unconfigured — every run then fails `permanent: true` at delivery time and
 * the admin only sees generic failed runs. This module checks, at task
 * create/update time, whether the deployment actually has a working sender
 * for the chosen channels and returns human-readable warnings when it does
 * not.
 *
 * WARN, DON'T BLOCK (deliberate): creation/update still succeeds — an admin
 * may configure the sender right after creating the task, and SaaS / properly
 * configured self-hosted deployments must be unaffected. The warnings ride on
 * the create/update responses as `warnings: string[]` (empty when no issues).
 *
 * - Email: reuses {@link resolveEmailSender} — the SAME provider-chain walk
 *   `sendEmail` dispatches on — so the preflight and the actual send can
 *   never disagree. A `log` resolution (nothing configured) warns.
 * - Slack: warns only when BOTH the per-team token (`chat_cache` via
 *   `getBotToken` for the recipient's teamId) AND `SLACK_BOT_TOKEN` are
 *   absent — resolved through the SAME `resolveSlackBotToken` helper
 *   `deliverToSlack` dispatches on (`slack-token.ts`).
 * - Webhook: no preflight (the URL is already SSRF-validated by the route
 *   schema; reachability is only knowable at delivery time).
 *
 * A preflight that cannot determine the answer (e.g. the Slack token lookup
 * throws because the internal DB is unavailable) logs and emits NO warning —
 * a false "not configured" claim on a working deployment would be worse than
 * staying quiet, and the delivery path itself still surfaces real failures.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { Recipient, SlackRecipient } from "@atlas/api/lib/scheduled-task-types";
import type { ResolvedEmailSender } from "@atlas/api/lib/email/delivery";
import { resolveSlackBotToken } from "@atlas/api/lib/scheduler/slack-token";

const log = createLogger("scheduler-sender-preflight");

export const EMAIL_NO_SENDER_WARNING =
  "This deployment has no email sender configured — email reports will only be written to the server log and every delivery will fail. " +
  "Configure a platform email provider (Admin → Integrations → Email), or set ATLAS_SMTP_URL or RESEND_API_KEY.";

export const EMAIL_BRIDGE_WARNING =
  "This workspace's email integration (SMTP/SES) requires the ATLAS_SMTP_URL bridge, which is not set — email deliveries will fail. " +
  "Set ATLAS_SMTP_URL, or switch the email integration to an API-based provider (Resend, SendGrid, Postmark).";

export const SLACK_NO_SENDER_WARNING =
  "This deployment has no Slack bot token for the configured recipient — Slack deliveries will fail. " +
  "Install the Atlas Slack app for the workspace (so a per-team token exists), or set SLACK_BOT_TOKEN.";

/**
 * Injection seam for tests — mirrors the `TransactionalEmailDeps` pattern in
 * `lib/email/delivery.ts`. Production callers omit it; the defaults
 * dynamic-import the real modules so this file adds nothing heavy to the
 * route module graph.
 */
export interface SenderPreflightDeps {
  resolveEmailSender?: (orgId?: string) => Promise<ResolvedEmailSender>;
  getBotToken?: (teamId: string) => Promise<string | null>;
}

/**
 * Check whether the deployment has a working sender for each delivery
 * channel present in `recipients`. Returns warnings (possibly empty) —
 * NEVER throws and NEVER blocks; callers attach the result to the
 * create/update response.
 *
 * Callers should pass only the recipients that match the task's
 * `deliveryChannel` (the same filter `deliverResult` applies), so a stale
 * recipient of a different channel can't produce a spurious warning.
 */
export async function checkDeliverySenders(
  recipients: Recipient[],
  orgId?: string,
  deps: SenderPreflightDeps = {},
): Promise<string[]> {
  const hasEmail = recipients.some((r) => r.type === "email");
  const slackRecipients = recipients.filter((r): r is SlackRecipient => r.type === "slack");

  const [emailWarning, slackWarning] = await Promise.all([
    hasEmail ? checkEmailSender(orgId, deps) : Promise.resolve(null),
    slackRecipients.length > 0 ? checkSlackSender(slackRecipients, deps) : Promise.resolve(null),
  ]);

  const warnings: string[] = [];
  if (emailWarning) warnings.push(emailWarning);
  if (slackWarning) warnings.push(slackWarning);
  return warnings;
}

async function checkEmailSender(
  orgId: string | undefined,
  deps: SenderPreflightDeps,
): Promise<string | null> {
  try {
    const resolveEmailSender =
      deps.resolveEmailSender ??
      (await import("@atlas/api/lib/email/delivery")).resolveEmailSender;
    const resolved = await resolveEmailSender(orgId);
    if (resolved.kind === "log") return EMAIL_NO_SENDER_WARNING;
    // An org smtp/ses transport without the ATLAS_SMTP_URL bridge resolves
    // as org-transport but deliverViaTransport refuses the send (#3385
    // review) — configured-in-name-only, so it warns too.
    if (resolved.kind === "org-transport" && resolved.bridgeMissing) return EMAIL_BRIDGE_WARNING;
    return null;
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "Email sender preflight failed — skipping warning (delivery-time errors still surface on the run)",
    );
    return null;
  }
}

async function checkSlackSender(
  recipients: SlackRecipient[],
  deps: SenderPreflightDeps,
): Promise<string | null> {
  try {
    // One resolution per distinct teamId through the SAME resolver
    // `deliverToSlack` uses (a teamId-less recipient collapses to one
    // `undefined` probe of the env fallback), so the preflight and the
    // delivery path can never disagree on the rule.
    const teamIds = [...new Set(recipients.map((r) => (r.teamId ? r.teamId : undefined)))];
    const tokens = await Promise.all(
      teamIds.map((teamId) => resolveSlackBotToken(teamId, deps.getBotToken)),
    );
    return tokens.some((token) => !token) ? SLACK_NO_SENDER_WARNING : null;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Slack sender preflight failed — skipping warning (delivery-time errors still surface on the run)",
    );
    return null;
  }
}
