/**
 * Email delivery abstraction.
 *
 * Supports delivery backends (checked in order):
 * 1. DB-stored email config per org (when orgId is provided).
 *    SendGrid, Postmark, and Resend are called directly via their APIs.
 *    SMTP and SES require ATLAS_SMTP_URL as an HTTP bridge.
 * 2. Platform email provider (from settings registry).
 * 3. Webhook via ATLAS_SMTP_URL (POST JSON to any email API endpoint)
 * 4. Resend API via RESEND_API_KEY (existing env-var fallback)
 * 5. Logging fallback when nothing is configured (dev mode).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getSetting } from "@atlas/api/lib/settings";
import {
  EMAIL_PROVIDERS,
  type EmailProvider,
  type ProviderConfig,
} from "@atlas/api/lib/integrations/types";

const log = createLogger("email-delivery");

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export type DeliveryProvider = EmailProvider | "webhook" | "log";

export interface DeliveryResult {
  success: boolean;
  provider: DeliveryProvider;
  messageId?: string;
  error?: string;
}

interface EmailTransport {
  provider: EmailProvider;
  senderAddress: string;
  /**
   * Provider-specific credentials, tagged with `provider` (#1542). The
   * discriminator is redundant with the sibling field above but keeps
   * `switch (config.provider)` narrowing inside `deliverViaTransport`
   * without having to pass both.
   */
  config: ProviderConfig;
}

function isEmailProvider(s: string): s is EmailProvider {
  return (EMAIL_PROVIDERS as readonly string[]).includes(s);
}

/**
 * Whether the deployment can deliver auth emails (password reset, etc.)
 * without per-org config. Used by the public `/api/v1/onboarding/password-reset-status`
 * endpoint as a UI hint — the auth endpoints are always live, but this
 * decides whether the /login page renders a "Forgot password?" link.
 *
 * Returns true when ANY platform-level transport is configured:
 *   - Platform settings (`ATLAS_EMAIL_PROVIDER` + the matching key)
 *   - `ATLAS_SMTP_URL` webhook bridge
 *   - `RESEND_API_KEY` env-var fallback
 *
 * Per-org `email_installations` overrides are not consulted here — the
 * password-reset flow runs without a session and has no org scope to
 * key on, so an org-only configuration cannot satisfy the request.
 */
export function isAuthEmailDeliveryConfigured(): boolean {
  if (getPlatformEmailConfig() !== null) return true;
  if (process.env.ATLAS_SMTP_URL) return true;
  if (process.env.RESEND_API_KEY) return true;
  return false;
}

/**
 * Get the email transport config for an org from the internal database.
 * Returns null if no DB config exists, if the internal DB is not available,
 * or on any error during lookup (errors are logged at warn level to allow
 * env-var fallback).
 */
export async function getEmailTransport(
  orgId: string,
): Promise<EmailTransport | null> {
  try {
    const { getEmailInstallationByOrg } = await import("@atlas/api/lib/email/store");
    const install = await getEmailInstallationByOrg(orgId);
    if (install) {
      return {
        provider: install.provider,
        senderAddress: install.sender_address,
        config: install.config,
      };
    }
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "Failed to load email transport from DB — falling back to env vars",
    );
  }
  return null;
}

/**
 * Resolve the platform-level email provider from the settings registry.
 * Returns a transport-compatible object or null when no API key is available.
 */
function getPlatformEmailConfig(): EmailTransport | null {
  const raw = getSetting("ATLAS_EMAIL_PROVIDER");
  if (!raw) return null;
  if (!isEmailProvider(raw)) {
    log.warn({ provider: raw }, "Unrecognized platform email provider — falling through to env-var chain");
    return null;
  }
  const provider = raw;

  const fromAddress = getSetting("ATLAS_EMAIL_FROM") ?? "Atlas <noreply@ship.useatlas.dev>";

  switch (provider) {
    case "resend": {
      const apiKey = getSetting("RESEND_API_KEY");
      if (!apiKey) {
        log.warn({ provider }, "Platform email provider is resend but RESEND_API_KEY is not set — falling through");
        return null;
      }
      return { provider: "resend", senderAddress: fromAddress, config: { provider: "resend", apiKey } };
    }
    case "sendgrid": {
      const apiKey = getSetting("SENDGRID_API_KEY");
      if (!apiKey) {
        log.warn({ provider }, "Platform email provider is sendgrid but SENDGRID_API_KEY is not set — falling through");
        return null;
      }
      return { provider: "sendgrid", senderAddress: fromAddress, config: { provider: "sendgrid", apiKey } };
    }
    case "postmark": {
      const serverToken = getSetting("POSTMARK_SERVER_TOKEN");
      if (!serverToken) {
        log.warn({ provider }, "Platform email provider is postmark but POSTMARK_SERVER_TOKEN is not set — falling through");
        return null;
      }
      return { provider: "postmark", senderAddress: fromAddress, config: { provider: "postmark", serverToken } };
    }
    case "smtp":
    case "ses": {
      // SMTP/SES at platform level still require the ATLAS_SMTP_URL bridge.
      // The bridge carries credentials out of band, so we emit a synthetic
      // minimal config tagged with the provider; deliverViaTransport only
      // reads it for the `provider` discriminator before delegating to
      // the webhook.
      if (!process.env.ATLAS_SMTP_URL) {
        log.warn({ provider }, "Platform email provider requires ATLAS_SMTP_URL bridge — falling through");
        return null;
      }
      const placeholder: ProviderConfig = provider === "smtp"
        ? { provider: "smtp", host: "", port: 0, username: "", password: "", tls: false }
        : { provider: "ses", region: "", accessKeyId: "", secretAccessKey: "" };
      return { provider, senderAddress: fromAddress, config: placeholder };
    }
    default:
      return null; // unreachable — isEmailProvider guard above
  }
}

/**
 * Send an email using the configured delivery backend.
 *
 * Priority: DB config (per-org) → platform email settings → ATLAS_SMTP_URL (webhook) → RESEND_API_KEY → console log (dev fallback).
 *
 * Pass `orgId` to enable DB-backed email config lookup. When omitted, falls back to platform/env settings.
 */
export async function sendEmail(message: EmailMessage, orgId?: string): Promise<DeliveryResult> {
  // 1. Try DB-stored config for the org
  if (orgId) {
    const transport = await getEmailTransport(orgId);
    if (transport) {
      return deliverViaTransport(message, transport);
    }
  }

  // 2. Platform email provider (settings registry)
  const platformConfig = getPlatformEmailConfig();
  if (platformConfig) {
    return deliverViaTransport(message, platformConfig);
  }

  const fromAddress = process.env.ATLAS_EMAIL_FROM ?? "Atlas <noreply@ship.useatlas.dev>";

  // 3. Webhook delivery (generic email API)
  if (process.env.ATLAS_SMTP_URL) {
    return deliverWebhook(message, fromAddress);
  }

  // 4. Resend API delivery (env-var fallback for backward compat)
  if (process.env.RESEND_API_KEY) {
    return deliverResend(message, fromAddress);
  }

  // 5. Dev fallback — log instead of sending. Returns success: false so the email
  // is not recorded as sent, allowing retry when a provider is configured.
  log.warn(
    { to: message.to, subject: message.subject },
    "Email delivery skipped — no email provider configured",
  );
  return { success: false, provider: "log", error: "No email delivery backend configured (configure a platform email provider or set RESEND_API_KEY)" };
}

/**
 * Send an email using explicit transport credentials.
 * Used by the admin test endpoint to validate credentials before saving.
 */
export async function sendEmailWithTransport(
  message: EmailMessage,
  transport: EmailTransport,
): Promise<DeliveryResult> {
  return deliverViaTransport(message, transport);
}

// ---------------------------------------------------------------------------
// Durable transactional email (#2942)
// ---------------------------------------------------------------------------

export interface TransactionalEmailOptions {
  /**
   * Send classification stamped on the outbox row for observability
   * (e.g. "password-reset", "verification-otp"). Never used for routing.
   */
  emailType: string;
  /** Optional org scope, threaded to `sendEmail` and the outbox row. */
  orgId?: string;
  /**
   * Time-to-live (ms) for the embedded token/OTP, used to stamp the
   * outbox row's `expires_at`. The flusher dead-letters (does NOT send) a
   * row past its deadline so a sustained outage can't deliver a dead reset
   * link / expired code (#2942 codex review). Pass the SAME value the
   * email body states (reset link 1h, OTP 10m). Omit for non-expiring
   * sends.
   */
  ttlMs?: number;
}

/**
 * Should a failed send be enqueued to the durable outbox? Pure so the
 * decision is unit-testable in isolation.
 *
 * `provider === "log"` means NO transport is configured — the send went
 * to the dev/log fallback, so there is nowhere to deliver and a durable
 * queue would just dead-letter the row after exhausting the budget.
 * Only enqueue when a REAL transport was attempted and failed (the
 * in-process `fetchWithRetry` retry path, #2949, is already exhausted by
 * the time we see `success: false`).
 */
export function shouldEnqueueFailedSend(result: DeliveryResult): boolean {
  return !result.success && result.provider !== "log";
}

/**
 * Derive the outbox row's absolute `expires_at` from a per-type TTL.
 * Returns `null` (no deadline) when `ttlMs` is absent or non-finite — a
 * `NaN`/`Infinity` slip must NOT produce an `Invalid Date` row. Pure +
 * exported so the date math is unit-testable in isolation (a sign flip
 * or unit slip here would silently stamp a PAST deadline and the flusher
 * would dead-letter the send without delivering — #2942 regression risk).
 */
export function computeExpiresAt(ttlMs: number | undefined): Date | null {
  return ttlMs != null && Number.isFinite(ttlMs) ? new Date(Date.now() + ttlMs) : null;
}

/**
 * Enqueue a failed transactional send to `email_outbox` for durable
 * at-least-once retry. CONTRACT: never throws — the caller's response
 * must stay 200 to preserve signup-enumeration protection (F-09). Skips
 * silently (with a warn) when no internal DB is configured (nowhere to
 * queue). Dynamic imports keep delivery.ts's static module graph
 * unchanged (no cycle with email-outbox, which the flusher's dispatcher
 * wires back to `sendEmail`).
 *
 * @internal — exported for testing.
 */
export async function enqueueFailedTransactionalEmail(
  message: EmailMessage,
  opts: TransactionalEmailOptions,
): Promise<void> {
  try {
    const { hasInternalDB, internalQuery } = await import("@atlas/api/lib/db/internal");
    if (!hasInternalDB()) {
      log.warn(
        { to: message.to, emailType: opts.emailType },
        "Failed transactional email NOT enqueued — no internal DB configured for the durable outbox; send is lost",
      );
      return;
    }
    const { enqueue } = await import("@atlas/api/lib/email-outbox");
    const expiresAt = computeExpiresAt(opts.ttlMs);
    const outboxId = await enqueue(
      { query: internalQuery },
      { emailType: opts.emailType, message, orgId: opts.orgId ?? null, expiresAt },
    );
    log.info(
      { to: message.to, emailType: opts.emailType, outboxId },
      "Transactional email send failed — enqueued to email_outbox for durable retry",
    );
  } catch (err) {
    // Never rethrow — a failure to even queue the row must not break the
    // enumeration-safe 200. Loud error so the lost send is observable.
    log.error(
      {
        to: message.to,
        emailType: opts.emailType,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to enqueue transactional email to the outbox — send is lost",
    );
  }
}

/** Injection seam for {@link sendTransactionalEmail} — test-only. */
export interface TransactionalEmailDeps {
  send?: (message: EmailMessage, orgId?: string) => Promise<DeliveryResult>;
  enqueueFailed?: (message: EmailMessage, opts: TransactionalEmailOptions) => Promise<void>;
}

/**
 * Send a transactional email (password reset, signup verification OTP)
 * with DURABLE at-least-once delivery.
 *
 * Calls {@link sendEmail}; if the in-process retry path (#2949) is
 * exhausted and a real transport failed, the rendered message is
 * enqueued to `email_outbox` so a SUSTAINED provider outage no longer
 * permanently drops the send — the Scheduler-backed flusher
 * (`lib/email-outbox/`) re-sends it on a later tick.
 *
 * This is the opt-in wrapper for transactional auth emails. Bulk /
 * agent / admin-test callers keep using the raw {@link sendEmail} so
 * they don't accidentally fan failures into the outbox. The flusher's
 * dispatcher also re-sends via raw `sendEmail`, so a re-send failure
 * does NOT re-enqueue (no duplication loop).
 *
 * Enumeration safety (F-09): never throws and always returns the
 * original `DeliveryResult`. The caller's response stays 200 whether the
 * send succeeded, failed-then-queued, or failed-then-couldn't-queue.
 */
export async function sendTransactionalEmail(
  message: EmailMessage,
  opts: TransactionalEmailOptions,
  deps: TransactionalEmailDeps = {},
): Promise<DeliveryResult> {
  const send = deps.send ?? sendEmail;
  const enqueueFailed = deps.enqueueFailed ?? enqueueFailedTransactionalEmail;
  // Enforce the F-09 never-throw contract LOCALLY rather than depending on
  // `sendEmail`'s leaf functions all catching internally (true today, but
  // a future refactor of delivery.ts could regress it). A throw here is
  // treated as a failed send so the caller's response still stays 200.
  let result: DeliveryResult;
  try {
    result = await send(message, opts.orgId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(
      { to: message.to, emailType: opts.emailType, err: error },
      "Transactional email send threw — treating as a failed send; response stays 200 (F-09)",
    );
    result = { success: false, provider: "log", error };
  }
  if (shouldEnqueueFailedSend(result)) {
    try {
      await enqueueFailed(message, opts);
    } catch (err) {
      // `enqueueFailed` already swallows; this is defense-in-depth so a
      // future refactor that drops its try/catch can't break the 200.
      log.error(
        {
          to: message.to,
          emailType: opts.emailType,
          err: err instanceof Error ? err.message : String(err),
        },
        "Transactional email outbox enqueue threw — send is lost but response stays 200",
      );
    }
  }
  return result;
}

/**
 * Deliver an email using a transport config (DB-stored or platform settings).
 */
async function deliverViaTransport(
  message: EmailMessage,
  transport: EmailTransport,
): Promise<DeliveryResult> {
  const from = transport.senderAddress;

  // `transport.config` is a tagged union keyed on `provider` (#1542); the
  // switch narrows each case to the matching `ProviderConfig` variant so
  // `apiKey` / `serverToken` accesses are structurally guaranteed.
  //
  // Defense-in-depth against a discriminator that slipped past the store
  // layer's `isEmailProvider` guard (e.g. a plugin registering a new
  // EmailProvider value, a direct mock in tests): the exhaustive switch
  // below has a `default` arm that surfaces the unknown tag as a
  // structured DeliveryResult instead of letting the async function
  // resolve to `undefined` and crashing downstream `result.success`.
  switch (transport.config.provider) {
    case "resend":
      return deliverResend(message, from, transport.config.apiKey);

    case "sendgrid":
      return deliverSendGrid(message, from, transport.config.apiKey);

    case "postmark":
      return deliverPostmark(message, from, transport.config.serverToken);

    case "smtp":
    case "ses":
      if (process.env.ATLAS_SMTP_URL) {
        return deliverWebhook(message, from);
      }
      log.warn({ to: message.to, provider: transport.provider }, "DB email config found but provider requires ATLAS_SMTP_URL bridge");
      return { success: false, provider: "log", error: `${transport.provider} provider requires ATLAS_SMTP_URL bridge` };

    default: {
      // `never` at the type layer — if this arm fires, the store/wire
      // guards missed a discriminator that compile-time thought was
      // impossible.
      const unknownProvider: string = (transport.config as { provider: string }).provider;
      log.error(
        { to: message.to, unknownProvider },
        "deliverViaTransport received unknown provider discriminator — refusing to deliver",
      );
      return {
        success: false,
        provider: "log",
        error: `Unknown email provider discriminator: ${unknownProvider}`,
      };
    }
  }
}

/**
 * `fetch` with bounded exponential-backoff retry on transient failures
 * (network throw, HTTP 429, or 5xx). Permanent 4xx responses (bad key,
 * malformed payload) are returned immediately without retry. A fresh
 * timeout signal is built per attempt because `AbortSignal.timeout()` is
 * one-shot and can't be reused across fetches.
 *
 * Without this, a single upstream blip permanently dropped a transactional
 * email (notably the password-reset, the sole self-serve recovery path —
 * #2942). Transactional sends are low-volume, so a few retries are cheap.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { label: string; attempts?: number; timeoutMs?: number },
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      // 250ms, 500ms, … exponential backoff between attempts.
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 2)));
    }
    try {
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if ((resp.status === 429 || resp.status >= 500) && attempt < attempts) {
        log.warn(
          { label: opts.label, status: resp.status, attempt },
          "Email transport transient failure — retrying",
        );
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        log.warn(
          { label: opts.label, attempt, err: err instanceof Error ? err.message : String(err) },
          "Email transport network error — retrying",
        );
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop always returns or throws — but TS needs a terminator.
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Webhook delivery — POST JSON payload to ATLAS_SMTP_URL.
 * Compatible with any email service that accepts JSON webhooks.
 */
async function deliverWebhook(message: EmailMessage, from: string): Promise<DeliveryResult> {
  const url = process.env.ATLAS_SMTP_URL!;
  try {
    const resp = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
      }),
    }, { label: "webhook" });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const error = `Webhook returned ${resp.status}: ${text.slice(0, 200)}`;
      log.error({ to: message.to, status: resp.status }, "Webhook email delivery failed");
      return { success: false, provider: "webhook", error };
    }

    log.info({ to: message.to, subject: message.subject }, "Email sent via webhook");
    return { success: true, provider: "webhook" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ to: message.to, err: error }, "Webhook email delivery error");
    return { success: false, provider: "webhook", error };
  }
}

async function deliverResend(message: EmailMessage, from: string, apiKey?: string): Promise<DeliveryResult> {
  const key = apiKey ?? process.env.RESEND_API_KEY;
  try {
    const resp = await fetchWithRetry("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
      }),
    }, { label: "resend" });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const error = `Resend API returned ${resp.status}: ${text.slice(0, 200)}`;
      log.error({ to: message.to, status: resp.status, body: text.slice(0, 200) }, "Resend delivery failed");
      return { success: false, provider: "resend", error };
    }

    const data = await resp.json().catch(() => ({})) as { id?: string };
    log.info({ to: message.to, subject: message.subject, messageId: data.id }, "Email sent via Resend");
    return { success: true, provider: "resend", messageId: data.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ to: message.to, err: error }, "Resend delivery error");
    return { success: false, provider: "resend", error };
  }
}

async function deliverSendGrid(message: EmailMessage, from: string, apiKey: string): Promise<DeliveryResult> {
  try {
    const res = await fetchWithRetry("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: from },
        subject: message.subject,
        content: [{ type: "text/html", value: message.html }],
      }),
    }, { label: "sendgrid" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error({ to: message.to, status: res.status }, "SendGrid delivery failed");
      return { success: false, provider: "sendgrid", error: `SendGrid error (${res.status}): ${text.slice(0, 200)}` };
    }
    log.info({ to: message.to, subject: message.subject }, "Email sent via SendGrid");
    return { success: true, provider: "sendgrid" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ to: message.to, err: error }, "SendGrid delivery error");
    return { success: false, provider: "sendgrid", error };
  }
}

async function deliverPostmark(message: EmailMessage, from: string, serverToken: string): Promise<DeliveryResult> {
  try {
    const res = await fetchWithRetry("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Postmark-Server-Token": serverToken },
      body: JSON.stringify({ From: from, To: message.to, Subject: message.subject, HtmlBody: message.html }),
    }, { label: "postmark" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error({ to: message.to, status: res.status }, "Postmark delivery failed");
      return { success: false, provider: "postmark", error: `Postmark error (${res.status}): ${text.slice(0, 200)}` };
    }
    log.info({ to: message.to, subject: message.subject }, "Email sent via Postmark");
    return { success: true, provider: "postmark" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ to: message.to, err: error }, "Postmark delivery error");
    return { success: false, provider: "postmark", error };
  }
}
