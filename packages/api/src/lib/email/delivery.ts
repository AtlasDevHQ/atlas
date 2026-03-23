/**
 * Email delivery abstraction.
 *
 * Supports two delivery backends:
 * - Webhook via ATLAS_SMTP_URL (POST JSON to any email API endpoint)
 * - Resend API via RESEND_API_KEY (existing scheduler integration)
 *
 * Falls back to logging when neither is configured (dev mode).
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("email-delivery");

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface DeliveryResult {
  success: boolean;
  provider: "webhook" | "resend" | "log";
  error?: string;
}

/**
 * Send an email using the configured delivery backend.
 *
 * Priority: ATLAS_SMTP_URL (webhook) → RESEND_API_KEY → console log (dev fallback).
 */
export async function sendEmail(message: EmailMessage): Promise<DeliveryResult> {
  const fromAddress = process.env.ATLAS_EMAIL_FROM ?? "Atlas <noreply@useatlas.dev>";

  // Webhook delivery (generic email API)
  if (process.env.ATLAS_SMTP_URL) {
    return deliverWebhook(message, fromAddress);
  }

  // Resend API delivery (same provider as scheduler)
  if (process.env.RESEND_API_KEY) {
    return deliverResend(message, fromAddress);
  }

  // Dev fallback — log instead of sending. Returns success: false so the email
  // is not recorded as sent, allowing retry when a provider is configured.
  log.warn(
    { to: message.to, subject: message.subject },
    "Email delivery skipped — no ATLAS_SMTP_URL or RESEND_API_KEY configured",
  );
  return { success: false, provider: "log", error: "No email delivery backend configured (set ATLAS_SMTP_URL or RESEND_API_KEY)" };
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

async function deliverResend(message: EmailMessage, from: string): Promise<DeliveryResult> {
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const error = `Resend API returned ${resp.status}: ${text.slice(0, 200)}`;
      log.error({ to: message.to, status: resp.status, body: text.slice(0, 200) }, "Resend delivery failed");
      return { success: false, provider: "resend", error };
    }

    log.info({ to: message.to, subject: message.subject }, "Email sent via Resend");
    return { success: true, provider: "resend" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ to: message.to, err: error }, "Resend delivery error");
    return { success: false, provider: "resend", error };
  }
}
