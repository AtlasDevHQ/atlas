/**
 * Delivery dispatcher — routes scheduled task results to the configured channel.
 *
 * Effect migration (P3): sequential for-loops replaced with Effect.forEach.
 * Transient failures get exponential backoff retry (3 attempts, 1s base).
 * Channel-specific logic is parameterized via a handler map.
 */

import { Effect, Schedule, Duration } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { DeliveryError } from "@atlas/api/lib/effect/errors";
import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";
import type { EmailRecipient, SlackRecipient, WebhookRecipient, Recipient } from "@atlas/api/lib/scheduled-task-types";
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
    // intentionally treated as blocked: unparseable URLs cannot be validated
    log.warn({ url: urlString.slice(0, 100) }, "Unparseable webhook URL — blocked");
    return true;
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

// ── Retry policy ──────────────────────────────────────────────────

/** Exponential backoff: 1s → 2s → 4s, max 3 retries. */
const retryPolicy = Schedule.intersect(
  Schedule.exponential(Duration.seconds(1)),
  Schedule.recurs(3),
);

/** HTTP 4xx errors are client errors that will never succeed on retry. */
function isHttpPermanent(status: number): boolean {
  return status >= 400 && status < 500;
}

// ── Per-recipient delivery Effects ────────────────────────────────

function deliverToEmail(
  recipient: EmailRecipient,
  task: ScheduledTask,
  result: AgentQueryResult,
): Effect.Effect<void, DeliveryError> {
  return Effect.gen(function* () {
    const { subject, body } = formatEmailReport(task, result);

    const { sendEmail } = yield* Effect.tryPromise({
      try: () => import("@atlas/api/lib/email/delivery"),
      catch: (err) =>
        new DeliveryError({
          message: `Failed to load email delivery: ${err instanceof Error ? err.message : String(err)}`,
          channel: "email",
          recipient: recipient.address,
          permanent: false,
        }),
    });

    const deliveryResult = yield* Effect.tryPromise({
      try: () => sendEmail({ to: recipient.address, subject, html: body }),
      catch: (err) =>
        new DeliveryError({
          message: err instanceof Error ? err.message : String(err),
          channel: "email",
          recipient: recipient.address,
          permanent: false,
        }),
    });

    if (!deliveryResult.success) {
      log.error(
        { taskId: task.id, recipient: recipient.address, provider: deliveryResult.provider, error: deliveryResult.error },
        "Email delivery failed",
      );
      return yield* Effect.fail(
        new DeliveryError({
          message: deliveryResult.error ?? "Email delivery failed",
          channel: "email",
          recipient: recipient.address,
          permanent: deliveryResult.provider === "log",
        }),
      );
    }

    log.info({ taskId: task.id, recipient: recipient.address, provider: deliveryResult.provider }, "Email delivered");
  });
}

function deliverToSlack(
  recipient: SlackRecipient,
  task: ScheduledTask,
  result: AgentQueryResult,
): Effect.Effect<void, DeliveryError> {
  return Effect.gen(function* () {
    const { text, blocks } = formatSlackReport(task, result);

    let token: string | null = null;
    if (recipient.teamId) {
      const { getBotToken } = yield* Effect.tryPromise({
        try: () => import("@atlas/api/lib/slack/store"),
        catch: (err) =>
          new DeliveryError({
            message: `Failed to load Slack store: ${err instanceof Error ? err.message : String(err)}`,
            channel: "slack",
            recipient: recipient.channel,
            permanent: false,
          }),
      });
      token = yield* Effect.tryPromise({
        try: () => getBotToken(recipient.teamId!),
        catch: (err) =>
          new DeliveryError({
            message: `Failed to get bot token: ${err instanceof Error ? err.message : String(err)}`,
            channel: "slack",
            recipient: recipient.channel,
            permanent: false,
          }),
      });
    }
    if (!token) {
      token = process.env.SLACK_BOT_TOKEN ?? null;
    }
    if (!token) {
      log.warn({ taskId: task.id, channel: recipient.channel }, "No Slack bot token available — delivery skipped");
      return yield* Effect.fail(
        new DeliveryError({ message: "No Slack bot token", channel: "slack", recipient: recipient.channel, permanent: true }),
      );
    }

    const { postMessage } = yield* Effect.tryPromise({
      try: () => import("@atlas/api/lib/slack/api"),
      catch: (err) =>
        new DeliveryError({
          message: `Failed to load Slack API: ${err instanceof Error ? err.message : String(err)}`,
          channel: "slack",
          recipient: recipient.channel,
          permanent: false,
        }),
    });
    const resp = yield* Effect.tryPromise({
      try: () => postMessage(token, { channel: recipient.channel, text, blocks }),
      catch: (err) =>
        new DeliveryError({
          message: err instanceof Error ? err.message : String(err),
          channel: "slack",
          recipient: recipient.channel,
          permanent: false,
        }),
    });

    if (!resp.ok) {
      log.error({ taskId: task.id, channel: recipient.channel, error: resp.error }, "Slack delivery failed");
      return yield* Effect.fail(
        new DeliveryError({ message: resp.error ?? "Slack API error", channel: "slack", recipient: recipient.channel, permanent: false }),
      );
    }

    log.info({ taskId: task.id, channel: recipient.channel }, "Slack message delivered");
  });
}

function deliverToWebhook(
  recipient: WebhookRecipient,
  task: ScheduledTask,
  result: AgentQueryResult,
): Effect.Effect<void, DeliveryError> {
  return Effect.gen(function* () {
    if (isBlockedUrl(recipient.url)) {
      log.error({ taskId: task.id, url: recipient.url }, "Webhook URL blocked — targets private/internal address");
      return yield* Effect.fail(
        new DeliveryError({ message: "Blocked URL", channel: "webhook", recipient: recipient.url, permanent: true }),
      );
    }

    const payload = formatWebhookPayload(task, result);
    const safeHeaders = sanitizeHeaders(recipient.headers ?? {});

    const resp = yield* Effect.tryPromise({
      try: () =>
        fetch(recipient.url, {
          method: "POST",
          headers: { ...safeHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      catch: (err) =>
        new DeliveryError({
          message: err instanceof Error ? err.message : String(err),
          channel: "webhook",
          recipient: recipient.url,
          permanent: false,
        }),
    });

    if (!resp.ok) {
      const text = yield* Effect.promise(() => resp.text().catch(() => ""));
      log.error(
        { taskId: task.id, url: recipient.url, status: resp.status, body: text.slice(0, 200) },
        "Webhook delivery failed",
      );
      return yield* Effect.fail(
        new DeliveryError({
          message: `HTTP ${resp.status}`,
          channel: "webhook",
          recipient: recipient.url,
          permanent: isHttpPermanent(resp.status),
        }),
      );
    }

    log.info({ taskId: task.id, url: recipient.url }, "Webhook delivered");
  });
}

// ── Channel routing ───────────────────────────────────────────────

function deliverySingle(
  recipient: Recipient,
  task: ScheduledTask,
  result: AgentQueryResult,
): Effect.Effect<void, DeliveryError> {
  switch (recipient.type) {
    case "email":
      return deliverToEmail(recipient, task, result);
    case "slack":
      return deliverToSlack(recipient, task, result);
    case "webhook":
      return deliverToWebhook(recipient, task, result);
  }
}

/**
 * Deliver agent results to the task's configured channel and recipients.
 * Returns a delivery summary with attempted/succeeded/failed counts.
 *
 * Each recipient gets exponential-backoff retry (3 attempts) for transient
 * failures. Permanent errors (blocked URLs, missing credentials, HTTP 4xx)
 * fail immediately without retry.
 */
export async function deliverResult(
  task: ScheduledTask,
  result: AgentQueryResult,
): Promise<DeliverySummary> {
  if (task.recipients.length === 0) {
    log.debug({ taskId: task.id }, "No recipients configured — skipping delivery");
    return EMPTY_SUMMARY;
  }

  // Filter recipients to only those matching the delivery channel
  const channelRecipients = task.recipients.filter((r) => r.type === task.deliveryChannel);
  if (channelRecipients.length === 0) {
    log.debug({ taskId: task.id, channel: task.deliveryChannel }, "No matching recipients for channel");
    return EMPTY_SUMMARY;
  }

  // Deliver to all recipients concurrently, with per-recipient retry.
  // Permanent errors (blocked URL, missing credentials, HTTP 4xx) fail immediately.
  // Transient errors (network, HTTP 5xx) get exponential backoff retry.
  const outcomes = await Effect.runPromise(
    Effect.forEach(
      channelRecipients,
      (recipient) =>
        deliverySingle(recipient, task, result).pipe(
          Effect.retry({
            schedule: retryPolicy,
            while: (err) => !err.permanent,
          }),
          Effect.map(() => "succeeded" as const),
          Effect.catchTag("DeliveryError", (err) => {
            log.warn({ taskId: task.id, channel: err.channel, recipient: err.recipient, message: err.message }, "Delivery failed after retries exhausted");
            return Effect.succeed("failed" as const);
          }),
        ),
      { concurrency: 5 },
    ),
  );

  let succeeded = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome === "succeeded") succeeded++;
    else failed++;
  }

  return { attempted: channelRecipients.length, succeeded, failed };
}
