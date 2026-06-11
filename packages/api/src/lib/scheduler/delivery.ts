/**
 * Delivery dispatcher — routes scheduled task results to the configured channel.
 *
 * Effect migration (P3): sequential for-loops replaced with Effect.forEach.
 * Transient failures get exponential backoff retry (3 attempts, 1s base).
 * Channel-specific logic is parameterized via a handler map.
 */

import { Effect, Schedule, Duration } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { withEffectSpan } from "@atlas/api/lib/tracing";
import { DeliveryError } from "@atlas/api/lib/effect/errors";
import { isSafeExternalUrl } from "@atlas/api/lib/sandbox/validate";
import {
  guardedFetch,
  isInternalEgressAllowed,
  EgressBlockedError,
  hostForLog,
} from "@atlas/api/lib/openapi/egress-guard";
import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";
import type { EmailRecipient, SlackRecipient, WebhookRecipient, Recipient } from "@atlas/api/lib/scheduled-task-types";
import { resolveSlackBotToken } from "./slack-token";
import { shapeResult, type FormattedResult } from "./shape-result";
import { formatEmailReport } from "./format-email";
import { formatSlackReport } from "./format-slack";
import { formatWebhookPayload } from "./format-webhook";

const log = createLogger("scheduler-delivery");

export interface DeliverySummary {
  attempted: number;
  succeeded: number;
  failed: number;
  /**
   * How many of `failed` were permanent (`DeliveryError.permanent` — missing
   * credentials, blocked URL, HTTP 4xx) rather than transient. When ALL
   * failures are permanent the executor records the run's delivery status as
   * `"failed_permanent"` so misconfiguration is distinguishable from a
   * transient outage in the run history (#3379).
   */
  permanentFailures: number;
  /**
   * The first permanent failure's message (e.g. "No email delivery backend
   * configured…"), surfaced on the run row so the admin sees WHAT to fix —
   * not just that delivery failed. Null when no permanent failures occurred.
   */
  firstPermanentError: string | null;
}

const EMPTY_SUMMARY: DeliverySummary = {
  attempted: 0,
  succeeded: 0,
  failed: 0,
  permanentFailures: 0,
  firstPermanentError: null,
};

const BLOCKED_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "host",
  "x-forwarded-for",
  "x-real-ip",
]);

/**
 * Returns true if the URL targets a private/internal address (#3340).
 *
 * Routed through the canonical {@link isSafeExternalUrl} primitive — the old
 * regex denylist missed CGNAT/IPv4-mapped/`*.internal` forms and only matched
 * the literal hostname. Delivery itself goes through {@link guardedFetch},
 * which re-validates every redirect hop, so a public URL 302-ing to an
 * internal address is also blocked. Self-hosted operators that legitimately
 * deliver to internal endpoints opt out via
 * `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true` (the shared egress opt-out).
 */
export function isBlockedUrl(urlString: string): boolean {
  // Parse/scheme validation applies even under the operator opt-out — the
  // opt-out relaxes the internal-host policy, not "is this a fetchable URL".
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  } catch {
    // intentionally ignored: an unparseable URL cannot be delivered to.
    return true;
  }
  if (isInternalEgressAllowed()) return false;
  return !isSafeExternalUrl(urlString);
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
  shaped: FormattedResult,
): Effect.Effect<void, DeliveryError> {
  return Effect.gen(function* () {
    const { subject, body } = formatEmailReport(shaped);

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
      // Threading shaped.orgId keeps the send on the SAME chain link the
      // #3379 preflight resolved (per-org transport first) — without it,
      // an org-transport-only deployment preflights clean and then falls
      // through to platform/env/log at delivery time (#3386).
      try: () => sendEmail({ to: recipient.address, subject, html: body }, shaped.orgId ?? undefined),
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
        { taskId: shaped.taskId, recipient: recipient.address, provider: deliveryResult.provider, error: deliveryResult.error },
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

    log.info({ taskId: shaped.taskId, recipient: recipient.address, provider: deliveryResult.provider }, "Email delivered");
  });
}

function deliverToSlack(
  recipient: SlackRecipient,
  shaped: FormattedResult,
): Effect.Effect<void, DeliveryError> {
  return Effect.gen(function* () {
    const { text, blocks } = formatSlackReport(shaped);

    // Per-team token, then SLACK_BOT_TOKEN env — via the shared resolver the
    // sender preflight also uses (#3379), so the two can never disagree.
    const token = yield* Effect.tryPromise({
      try: () => resolveSlackBotToken(recipient.teamId),
      catch: (err) =>
        new DeliveryError({
          message: `Failed to resolve Slack bot token: ${err instanceof Error ? err.message : String(err)}`,
          channel: "slack",
          recipient: recipient.channel,
          permanent: false,
        }),
    });
    if (!token) {
      log.warn({ taskId: shaped.taskId, channel: recipient.channel }, "No Slack bot token available — delivery skipped");
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
      log.error({ taskId: shaped.taskId, channel: recipient.channel, error: resp.error }, "Slack delivery failed");
      return yield* Effect.fail(
        new DeliveryError({ message: resp.error ?? "Slack API error", channel: "slack", recipient: recipient.channel, permanent: false }),
      );
    }

    log.info({ taskId: shaped.taskId, channel: recipient.channel }, "Slack message delivered");
  });
}

function deliverToWebhook(
  recipient: WebhookRecipient,
  shaped: FormattedResult,
): Effect.Effect<void, DeliveryError> {
  return Effect.gen(function* () {
    if (isBlockedUrl(recipient.url)) {
      log.error({ taskId: shaped.taskId, url: recipient.url }, "Webhook URL blocked — targets private/internal address");
      return yield* Effect.fail(
        new DeliveryError({ message: "Blocked URL", channel: "webhook", recipient: recipient.url, permanent: true }),
      );
    }

    const payload = formatWebhookPayload(shaped);
    const safeHeaders = sanitizeHeaders(recipient.headers ?? {});

    // guardedFetch re-validates the target before the request leaves the box
    // and on every redirect hop (manual redirects) — a public recipient that
    // 302-redirects to an internal address is rejected, not followed (#3340).
    const resp = yield* Effect.tryPromise({
      try: () =>
        guardedFetch(recipient.url, {
          method: "POST",
          headers: { ...safeHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      catch: (err) => {
        if (err instanceof EgressBlockedError) {
          log.error(
            { taskId: shaped.taskId, host: err.host },
            "Webhook delivery blocked by egress guard",
          );
          return new DeliveryError({
            message: `Blocked URL (egress guard): ${hostForLog(recipient.url)}`,
            channel: "webhook",
            recipient: recipient.url,
            permanent: true,
          });
        }
        return new DeliveryError({
          message: err instanceof Error ? err.message : String(err),
          channel: "webhook",
          recipient: recipient.url,
          permanent: false,
        });
      },
    });

    if (!resp.ok) {
      const text = yield* Effect.promise(() => resp.text().catch(() => ""));
      log.error(
        { taskId: shaped.taskId, url: recipient.url, status: resp.status, body: text.slice(0, 200) },
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

    log.info({ taskId: shaped.taskId, url: recipient.url }, "Webhook delivered");
  });
}

// ── Channel routing ───────────────────────────────────────────────

function deliverySingle(
  recipient: Recipient,
  shaped: FormattedResult,
): Effect.Effect<void, DeliveryError> {
  const inner = (() => {
    switch (recipient.type) {
      case "email":
        return deliverToEmail(recipient, shaped);
      case "slack":
        return deliverToSlack(recipient, shaped);
      case "webhook":
        return deliverToWebhook(recipient, shaped);
    }
  })();
  return withEffectSpan(
    "atlas.scheduler.delivery",
    {
      "atlas.task_id": shaped.taskId,
      "atlas.channel": recipient.type,
    },
    inner,
  );
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

  // Shape once — truncation and report metadata are decided here, then the
  // per-channel renderers only lay out the shared FormattedResult.
  const shaped = shapeResult(task, result);

  // Deliver to all recipients concurrently, with per-recipient retry.
  // Permanent errors (blocked URL, missing credentials, HTTP 4xx) fail immediately.
  // Transient errors (network, HTTP 5xx) get exponential backoff retry.
  type Outcome =
    | { kind: "succeeded" }
    | { kind: "failed"; permanent: boolean; message: string };
  const outcomes = await Effect.runPromise(
    Effect.forEach(
      channelRecipients,
      (recipient) =>
        deliverySingle(recipient, shaped).pipe(
          Effect.retry({
            schedule: retryPolicy,
            while: (err) => !err.permanent,
          }),
          Effect.map((): Outcome => ({ kind: "succeeded" })),
          Effect.catchTag("DeliveryError", (err) => {
            log.warn({ taskId: task.id, channel: err.channel, recipient: err.recipient, message: err.message, permanent: err.permanent }, "Delivery failed after retries exhausted");
            return Effect.succeed<Outcome>({ kind: "failed", permanent: err.permanent, message: err.message });
          }),
        ),
      { concurrency: 5 },
    ),
  );

  let succeeded = 0;
  let failed = 0;
  let permanentFailures = 0;
  let firstPermanentError: string | null = null;
  for (const outcome of outcomes) {
    if (outcome.kind === "succeeded") {
      succeeded++;
    } else {
      failed++;
      if (outcome.permanent) {
        permanentFailures++;
        firstPermanentError ??= outcome.message;
      }
    }
  }

  return { attempted: channelRecipients.length, succeeded, failed, permanentFailures, firstPermanentError };
}
