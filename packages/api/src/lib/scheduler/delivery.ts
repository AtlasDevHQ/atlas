/**
 * Delivery dispatcher — routes scheduled task results to the configured channel.
 *
 * Switches on task.deliveryChannel and dispatches to the appropriate formatter
 * and transport (email, Slack, webhook). Returns a delivery summary.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";
import type { EmailRecipient, SlackRecipient, WebhookRecipient } from "@atlas/api/lib/scheduled-task-types";
import { formatEmailReport } from "./format-email";
import { formatSlackReport } from "./format-slack";
import { formatWebhookPayload } from "./format-webhook";

const log = createLogger("scheduler-delivery");

export interface DeliverySummary {
  attempted: number;
  succeeded: number;
  failed: number;
}

const EMPTY_SUMMARY: DeliverySummary = { attempted: 0, succeeded: 0, failed: 0 };

/** RFC 5735 / RFC 4193 private and reserved IP ranges. */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
  /^\[fd/i,
  /^\[fe80:/i,
];

const BLOCKED_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "host",
  "x-forwarded-for",
  "x-real-ip",
]);

/** Returns true if the URL targets a private/internal address. */
function isBlockedUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    // Block non-HTTPS in production
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
      return true;
    }
    const hostname = parsed.hostname;
    return BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return true; // Unparseable URLs are blocked
  }
}

/** Filter out sensitive header names from user-supplied headers. */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!BLOCKED_HEADER_NAMES.has(key.toLowerCase())) {
      safe[key] = value;
    } else {
      log.warn({ header: key }, "Blocked sensitive header in webhook recipient");
    }
  }
  return safe;
}

/**
 * Deliver agent results to the task's configured channel and recipients.
 * Returns a delivery summary with attempted/succeeded/failed counts.
 */
export async function deliverResult(
  task: ScheduledTask,
  result: AgentQueryResult,
): Promise<DeliverySummary> {
  if (task.recipients.length === 0) {
    log.debug({ taskId: task.id }, "No recipients configured — skipping delivery");
    return EMPTY_SUMMARY;
  }

  switch (task.deliveryChannel) {
    case "email":
      return deliverEmail(task, result);
    case "slack":
      return deliverSlack(task, result);
    case "webhook":
      return deliverWebhook(task, result);
    default:
      log.warn({ taskId: task.id, channel: task.deliveryChannel }, "Unknown delivery channel");
      return EMPTY_SUMMARY;
  }
}

async function deliverEmail(task: ScheduledTask, result: AgentQueryResult): Promise<DeliverySummary> {
  const emailRecipients = task.recipients.filter(
    (r): r is EmailRecipient => r.type === "email",
  );
  if (emailRecipients.length === 0) return EMPTY_SUMMARY;

  const { subject, body } = formatEmailReport(task, result);

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    log.warn({ taskId: task.id, count: emailRecipients.length }, "RESEND_API_KEY not set — email delivery skipped");
    return { attempted: emailRecipients.length, succeeded: 0, failed: emailRecipients.length };
  }

  const fromAddress = process.env.ATLAS_EMAIL_FROM ?? "Atlas <noreply@useatlas.dev>";
  let succeeded = 0;
  let failed = 0;

  for (const recipient of emailRecipients) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [recipient.address],
          subject,
          html: body,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        log.error({ taskId: task.id, recipient: recipient.address, status: resp.status, body: text.slice(0, 200) }, "Email delivery failed");
        failed++;
      } else {
        log.info({ taskId: task.id, recipient: recipient.address }, "Email delivered");
        succeeded++;
      }
    } catch (err) {
      log.error({ taskId: task.id, recipient: recipient.address, err: err instanceof Error ? err.message : String(err) }, "Email delivery error");
      failed++;
    }
  }

  return { attempted: emailRecipients.length, succeeded, failed };
}

async function deliverSlack(task: ScheduledTask, result: AgentQueryResult): Promise<DeliverySummary> {
  const slackRecipients = task.recipients.filter(
    (r): r is SlackRecipient => r.type === "slack",
  );
  if (slackRecipients.length === 0) return EMPTY_SUMMARY;

  const { text, blocks } = formatSlackReport(task, result);
  let succeeded = 0;
  let failed = 0;

  for (const recipient of slackRecipients) {
    try {
      let token: string | null = null;

      if (recipient.teamId) {
        const { getBotToken } = await import("@atlas/api/lib/slack/store");
        token = await getBotToken(recipient.teamId);
      }
      if (!token) {
        token = process.env.SLACK_BOT_TOKEN ?? null;
      }

      if (!token) {
        log.warn({ taskId: task.id, channel: recipient.channel }, "No Slack bot token available — delivery skipped");
        failed++;
        continue;
      }

      const { postMessage } = await import("@atlas/api/lib/slack/api");
      const resp = await postMessage(token, {
        channel: recipient.channel,
        text,
        blocks,
      });

      if (!resp.ok) {
        log.error({ taskId: task.id, channel: recipient.channel, error: resp.error }, "Slack delivery failed");
        failed++;
      } else {
        log.info({ taskId: task.id, channel: recipient.channel }, "Slack message delivered");
        succeeded++;
      }
    } catch (err) {
      log.error({ taskId: task.id, channel: recipient.channel, err: err instanceof Error ? err.message : String(err) }, "Slack delivery error");
      failed++;
    }
  }

  return { attempted: slackRecipients.length, succeeded, failed };
}

async function deliverWebhook(task: ScheduledTask, result: AgentQueryResult): Promise<DeliverySummary> {
  const webhookRecipients = task.recipients.filter(
    (r): r is WebhookRecipient => r.type === "webhook",
  );
  if (webhookRecipients.length === 0) return EMPTY_SUMMARY;

  const payload = formatWebhookPayload(task, result);
  let succeeded = 0;
  let failed = 0;

  for (const recipient of webhookRecipients) {
    if (isBlockedUrl(recipient.url)) {
      log.error({ taskId: task.id, url: recipient.url }, "Webhook URL blocked — targets private/internal address");
      failed++;
      continue;
    }

    const safeHeaders = sanitizeHeaders(recipient.headers ?? {});

    try {
      const resp = await fetch(recipient.url, {
        method: "POST",
        headers: {
          ...safeHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        log.error({ taskId: task.id, url: recipient.url, status: resp.status, body: text.slice(0, 200) }, "Webhook delivery failed");
        failed++;
      } else {
        log.info({ taskId: task.id, url: recipient.url }, "Webhook delivered");
        succeeded++;
      }
    } catch (err) {
      log.error({ taskId: task.id, url: recipient.url, err: err instanceof Error ? err.message : String(err) }, "Webhook delivery error");
      failed++;
    }
  }

  return { attempted: webhookRecipients.length, succeeded, failed };
}
