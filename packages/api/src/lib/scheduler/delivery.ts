/**
 * Delivery dispatcher — routes scheduled task results to the configured channel.
 *
 * Effect migration (P3): sequential for-loops replaced with Effect.forEach.
 * Transient failures get exponential backoff retry (3 attempts, 1s base).
 *
 * One delivery-transport seam (#4198): the load → send → classify → log →
 * DeliveryError skeleton lives once in {@link deliverVia}; each channel
 * supplies a small {@link ChannelTransport} descriptor whose only real policy
 * is permanence classification (email `provider === "log"`, slack missing
 * token, webhook blocked URL / HTTP 4xx).
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
export function isHttpPermanent(status: number): boolean {
  return status >= 400 && status < 500;
}

// ── Delivery transport seam (#4198) ───────────────────────────────

/**
 * A classified delivery failure: the `DeliveryError` fields plus the log line
 * that should accompany it. `permanent` is the channel's permanence policy —
 * it decides whether `deliverResult`'s retry loop retries it (transient) or
 * the run is recorded as `failed_permanent` (misconfiguration; see
 * {@link DeliverySummary}).
 */
export interface DeliveryFailure {
  readonly message: string;
  readonly permanent: boolean;
  readonly log?: {
    /** Defaults to `"error"`. */
    readonly level?: "warn" | "error";
    readonly fields: Record<string, unknown>;
    readonly message: string;
  };
}

/**
 * Channel descriptor consumed by {@link deliverVia}. The shared wrapper owns
 * the skeleton (dynamic import → transport call → response inspection →
 * logging → `DeliveryError` construction); a channel supplies:
 *
 * - `load` — backend acquisition (dynamic import + credential resolution).
 *   A rejection is always a **transient** failure; contextualize the message
 *   inside `load` itself (see {@link rethrowWith}).
 * - `send` — the transport call. May throw a channel sentinel (e.g.
 *   {@link MissingSlackTokenError}) for pre-send preconditions.
 * - `classifyThrown` — the permanence policy for errors thrown by `send`.
 *   Returning `null` falls back to the default: transient, raw message.
 * - `inspect` — the permanence policy for a resolved response. Returning
 *   `null` means the delivery succeeded. Must be total (never reject): the
 *   wrapper maps a rejection to a transient failure, not a defect.
 * - `success` — the fields + message for the success log line.
 */
interface ChannelTransport<Backend, Resp> {
  readonly channel: Recipient["type"];
  /** Recipient identity for `DeliveryError` (address / channel / URL). */
  readonly recipient: string;
  readonly load: () => Promise<Backend>;
  readonly send: (backend: Backend) => Promise<Resp>;
  readonly classifyThrown?: (err: unknown) => DeliveryFailure | null;
  readonly inspect: (resp: Resp) => DeliveryFailure | null | Promise<DeliveryFailure | null>;
  readonly success: (resp: Resp) => { readonly fields: Record<string, unknown>; readonly message: string };
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Rethrow with a contextual prefix so `load` failures keep their historical
 * per-step messages ("Failed to load Slack API: …") without the wrapper
 * needing per-channel knowledge.
 */
const rethrowWith =
  (prefix: string) =>
  (err: unknown): never => {
    throw new Error(`${prefix}: ${errMsg(err)}`);
  };

/**
 * The single transport wrapper: load → send → classify → log → DeliveryError.
 * Every `DeliveryError` a channel can produce is constructed here.
 *
 * Exported for wrapper-policy unit tests (#4198) — the load/inspect
 * failure-to-transient mapping is exercised via a stub transport.
 */
export function deliverVia<Backend, Resp>(
  transport: ChannelTransport<Backend, Resp>,
  shaped: FormattedResult,
): Effect.Effect<void, DeliveryError> {
  const toError = (failure: { message: string; permanent: boolean }) =>
    new DeliveryError({
      message: failure.message,
      channel: transport.channel,
      recipient: transport.recipient,
      permanent: failure.permanent,
    });

  /** Emit the failure's log line (once per attempt) and build its error. */
  const failWith = (failure: DeliveryFailure): DeliveryError => {
    if (failure.log) {
      const fields = { ...failure.log.fields, taskId: shaped.taskId };
      if (failure.log.level === "warn") log.warn(fields, failure.log.message);
      else log.error(fields, failure.log.message);
    }
    return toError(failure);
  };

  return Effect.gen(function* () {
    const backend = yield* Effect.tryPromise({
      try: transport.load,
      catch: (err) => toError({ message: errMsg(err), permanent: false }),
    });

    const resp = yield* Effect.tryPromise({
      try: () => transport.send(backend),
      catch: (err) => {
        const classified = transport.classifyThrown?.(err) ?? null;
        return classified ? failWith(classified) : toError({ message: errMsg(err), permanent: false });
      },
    });

    const failure = yield* Effect.tryPromise({
      try: async () => transport.inspect(resp),
      // A rejecting `inspect` degrades to a transient failure for THIS
      // recipient — consistent with the load/send catches. Using Effect.promise
      // here would turn a rejection into a defect (die) that escapes the
      // per-recipient catchTag and aborts the whole batch (see #4198 review).
      catch: (err) => toError({ message: errMsg(err), permanent: false }),
    });
    if (failure) {
      return yield* Effect.fail(failWith(failure));
    }

    const success = transport.success(resp);
    log.info({ ...success.fields, taskId: shaped.taskId }, success.message);
  });
}

// ── Channel descriptors ───────────────────────────────────────────

type EmailModule = typeof import("@atlas/api/lib/email/delivery");
type EmailOutcome = Awaited<ReturnType<EmailModule["sendEmail"]>>;

/** Exported for permanence-policy unit tests (#4198). */
export function emailTransport(
  recipient: EmailRecipient,
  shaped: FormattedResult,
): ChannelTransport<EmailModule, EmailOutcome> {
  return {
    channel: "email",
    recipient: recipient.address,
    load: () => import("@atlas/api/lib/email/delivery").catch(rethrowWith("Failed to load email delivery")),
    send: async ({ sendEmail }) => {
      const { subject, body } = formatEmailReport(shaped);
      // Threading shaped.orgId keeps the send on the SAME chain link the
      // #3379 preflight resolved (per-org transport first) — without it,
      // an org-transport-only deployment preflights clean and then falls
      // through to platform/env/log at delivery time (#3386).
      return sendEmail({ to: recipient.address, subject, html: body }, shaped.orgId ?? undefined);
    },
    inspect: (outcome) =>
      outcome.success
        ? null
        : {
            message: outcome.error ?? "Email delivery failed",
            // The "log" provider is the configured-nothing fallback — no
            // sender exists, so retrying can never succeed (#3379).
            permanent: outcome.provider === "log",
            log: {
              fields: { recipient: recipient.address, provider: outcome.provider, error: outcome.error },
              message: "Email delivery failed",
            },
          },
    success: (outcome) => ({
      fields: { recipient: recipient.address, provider: outcome.provider },
      message: "Email delivered",
    }),
  };
}

/**
 * Pre-send sentinel: no Slack bot token is resolvable for the recipient's
 * team. Thrown by the slack transport's `send` and classified permanent by
 * its `classifyThrown` — missing credentials never heal on retry.
 */
export class MissingSlackTokenError extends Error {
  constructor() {
    super("No Slack bot token");
    this.name = "MissingSlackTokenError";
  }
}

type SlackModule = typeof import("@atlas/api/lib/slack/api");
interface SlackBackend {
  readonly token: string | null;
  readonly postMessage: SlackModule["postMessage"];
}
type SlackResponse = Awaited<ReturnType<SlackModule["postMessage"]>>;

/** Exported for permanence-policy unit tests (#4198). */
export function slackTransport(
  recipient: SlackRecipient,
  shaped: FormattedResult,
): ChannelTransport<SlackBackend, SlackResponse> {
  return {
    channel: "slack",
    recipient: recipient.channel,
    load: async () => {
      // Per-team token, then SLACK_BOT_TOKEN env — via the shared resolver the
      // sender preflight also uses (#3379), so the two can never disagree.
      const token = await resolveSlackBotToken(recipient.teamId).catch(
        rethrowWith("Failed to resolve Slack bot token"),
      );
      const { postMessage } = await import("@atlas/api/lib/slack/api").catch(
        rethrowWith("Failed to load Slack API"),
      );
      return { token, postMessage };
    },
    send: async ({ token, postMessage }) => {
      if (!token) throw new MissingSlackTokenError();
      const { text, blocks } = formatSlackReport(shaped);
      return postMessage(token, { channel: recipient.channel, text, blocks });
    },
    classifyThrown: (err) =>
      err instanceof MissingSlackTokenError
        ? {
            message: "No Slack bot token",
            permanent: true,
            log: {
              level: "warn",
              fields: { channel: recipient.channel },
              message: "No Slack bot token available — delivery skipped",
            },
          }
        : null,
    inspect: (resp) =>
      resp.ok
        ? null
        : {
            message: resp.error ?? "Slack API error",
            permanent: false,
            log: {
              fields: { channel: recipient.channel, error: resp.error },
              message: "Slack delivery failed",
            },
          },
    success: () => ({ fields: { channel: recipient.channel }, message: "Slack message delivered" }),
  };
}

/**
 * Pre-send sentinel: the webhook URL targets a private/internal address
 * ({@link isBlockedUrl}). Thrown by the webhook transport's `send` and
 * classified permanent by its `classifyThrown`.
 */
export class BlockedWebhookUrlError extends Error {
  constructor() {
    super("Blocked URL");
    this.name = "BlockedWebhookUrlError";
  }
}

/** Exported for permanence-policy unit tests (#4198). */
export function webhookTransport(
  recipient: WebhookRecipient,
  shaped: FormattedResult,
): ChannelTransport<typeof guardedFetch, Response> {
  return {
    channel: "webhook",
    recipient: recipient.url,
    load: async () => guardedFetch,
    send: async (fetchImpl) => {
      if (isBlockedUrl(recipient.url)) throw new BlockedWebhookUrlError();
      const payload = formatWebhookPayload(shaped);
      const safeHeaders = sanitizeHeaders(recipient.headers ?? {});
      // guardedFetch re-validates the target before the request leaves the box
      // and on every redirect hop (manual redirects) — a public recipient that
      // 302-redirects to an internal address is rejected, not followed (#3340).
      return fetchImpl(recipient.url, {
        method: "POST",
        headers: { ...safeHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    classifyThrown: (err) => {
      if (err instanceof BlockedWebhookUrlError) {
        return {
          message: "Blocked URL",
          permanent: true,
          log: {
            fields: { url: recipient.url },
            message: "Webhook URL blocked — targets private/internal address",
          },
        };
      }
      if (err instanceof EgressBlockedError) {
        return {
          message: `Blocked URL (egress guard): ${hostForLog(recipient.url)}`,
          permanent: true,
          log: {
            fields: { host: err.host },
            message: "Webhook delivery blocked by egress guard",
          },
        };
      }
      return null;
    },
    inspect: async (resp) => {
      if (resp.ok) return null;
      // intentionally ignored: the body is best-effort log context only.
      const text = await resp.text().catch(() => "");
      return {
        message: `HTTP ${resp.status}`,
        permanent: isHttpPermanent(resp.status),
        log: {
          fields: { url: recipient.url, status: resp.status, body: text.slice(0, 200) },
          message: "Webhook delivery failed",
        },
      };
    },
    success: () => ({ fields: { url: recipient.url }, message: "Webhook delivered" }),
  };
}

// ── Channel routing ───────────────────────────────────────────────

function deliverySingle(
  recipient: Recipient,
  shaped: FormattedResult,
): Effect.Effect<void, DeliveryError> {
  const inner = (() => {
    switch (recipient.type) {
      case "email":
        return deliverVia(emailTransport(recipient, shaped), shaped);
      case "slack":
        return deliverVia(slackTransport(recipient, shaped), shaped);
      case "webhook":
        return deliverVia(webhookTransport(recipient, shaped), shaped);
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
