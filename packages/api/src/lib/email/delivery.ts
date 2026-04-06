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
import { EMAIL_PROVIDERS, type EmailProvider } from "@atlas/api/lib/integrations/types";

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
  config: Record<string, unknown>;
}

function isEmailProvider(s: string): s is EmailProvider {
  return (EMAIL_PROVIDERS as readonly string[]).includes(s);
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
        config: install.config as unknown as Record<string, unknown>,
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

  const fromAddress = getSetting("ATLAS_EMAIL_FROM") ?? "Atlas <noreply@useatlas.dev>";

  switch (provider) {
    case "resend": {
      const apiKey = getSetting("RESEND_API_KEY");
      if (!apiKey) {
        log.warn({ provider }, "Platform email provider is resend but RESEND_API_KEY is not set — falling through");
        return null;
      }
      return { provider: "resend", senderAddress: fromAddress, config: { apiKey } };
    }
    case "sendgrid": {
      const apiKey = getSetting("SENDGRID_API_KEY");
      if (!apiKey) {
        log.warn({ provider }, "Platform email provider is sendgrid but SENDGRID_API_KEY is not set — falling through");
        return null;
      }
      return { provider: "sendgrid", senderAddress: fromAddress, config: { apiKey } };
    }
    case "postmark": {
      const serverToken = getSetting("POSTMARK_SERVER_TOKEN");
      if (!serverToken) {
        log.warn({ provider }, "Platform email provider is postmark but POSTMARK_SERVER_TOKEN is not set — falling through");
        return null;
      }
      return { provider: "postmark", senderAddress: fromAddress, config: { serverToken } };
    }
    case "smtp":
    case "ses":
      // SMTP/SES at platform level still require the ATLAS_SMTP_URL bridge
      if (!process.env.ATLAS_SMTP_URL) {
        log.warn({ provider }, "Platform email provider requires ATLAS_SMTP_URL bridge — falling through");
        return null;
      }
      return { provider, senderAddress: fromAddress, config: {} };
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

  const fromAddress = process.env.ATLAS_EMAIL_FROM ?? "Atlas <noreply@useatlas.dev>";

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

/**
 * Deliver an email using a transport config (DB-stored or platform settings).
 */
async function deliverViaTransport(
  message: EmailMessage,
  transport: EmailTransport,
): Promise<DeliveryResult> {
  const from = transport.senderAddress;

  switch (transport.provider) {
    case "resend": {
      const apiKey = transport.config.apiKey;
      if (typeof apiKey !== "string") return { success: false, provider: "resend", error: "Missing Resend API key in config" };
      return deliverResend(message, from, apiKey);
    }

    case "sendgrid": {
      const apiKey = transport.config.apiKey;
      if (typeof apiKey !== "string") return { success: false, provider: "sendgrid", error: "Missing SendGrid API key in stored config" };
      return deliverSendGrid(message, from, apiKey);
    }

    case "postmark": {
      const serverToken = transport.config.serverToken;
      if (typeof serverToken !== "string") return { success: false, provider: "postmark", error: "Missing Postmark token in stored config" };
      return deliverPostmark(message, from, serverToken);
    }

    default:
      // For smtp/ses, delegate to ATLAS_SMTP_URL webhook if available
      if (process.env.ATLAS_SMTP_URL) {
        return deliverWebhook(message, from);
      }
      log.warn({ to: message.to, provider: transport.provider }, "DB email config found but provider requires ATLAS_SMTP_URL bridge");
      return { success: false, provider: "log", error: `${transport.provider} provider requires ATLAS_SMTP_URL bridge` };
  }
}

/**
 * Webhook delivery — POST JSON payload to ATLAS_SMTP_URL.
 * Compatible with any email service that accepts JSON webhooks.
 */
async function deliverWebhook(message: EmailMessage, from: string): Promise<DeliveryResult> {
  const url = process.env.ATLAS_SMTP_URL!;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
      }),
      signal: AbortSignal.timeout(15_000),
    });

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
    const resp = await fetch("https://api.resend.com/emails", {
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
      signal: AbortSignal.timeout(15_000),
    });

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
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: from },
        subject: message.subject,
        content: [{ type: "text/html", value: message.html }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
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
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Postmark-Server-Token": serverToken },
      body: JSON.stringify({ From: from, To: message.to, Subject: message.subject, HtmlBody: message.html }),
      signal: AbortSignal.timeout(15_000),
    });
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
