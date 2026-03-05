/**
 * Email action — send reports via Resend.
 *
 * Exports:
 * - executeEmailSend(params) — raw Resend SDK call
 * - sendEmailReport — AtlasAction for the agent tool registry
 */

import { tool } from "ai";
import { z } from "zod";
import type { AtlasAction } from "@atlas/api/lib/action-types";
import { buildActionRequest, handleAction } from "./handler";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("action:email");

// ---------------------------------------------------------------------------
// Domain allowlist validation
// ---------------------------------------------------------------------------

/** Extract the domain from an email address, handling display-name format. */
function extractEmailDomain(addr: string): string | undefined {
  // Handle display-name format: "User <user@company.com>"
  const angleMatch = addr.match(/<([^>]+)>/);
  const email = angleMatch ? angleMatch[1] : addr;
  return email.split("@")[1]?.toLowerCase();
}

function validateAllowedDomains(
  recipients: string[],
): { valid: boolean; blocked: string[] } {
  const raw = process.env.ATLAS_EMAIL_ALLOWED_DOMAINS;
  if (!raw) return { valid: true, blocked: [] };

  const allowed = raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  if (allowed.length === 0) return { valid: true, blocked: [] };

  const blocked: string[] = [];
  for (const addr of recipients) {
    const domain = extractEmailDomain(addr);
    if (!domain || !allowed.includes(domain)) {
      blocked.push(addr);
    }
  }

  if (blocked.length > 0) {
    log.warn({ blocked, allowed }, "Domain allowlist rejected recipients");
  }

  return { valid: blocked.length === 0, blocked };
}

// ---------------------------------------------------------------------------
// Raw Resend API call
// ---------------------------------------------------------------------------

export interface EmailSendParams {
  to: string | string[];
  subject: string;
  body: string;
}

export interface EmailSendResult {
  id: string;
}

export async function executeEmailSend(
  params: EmailSendParams,
): Promise<EmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.error("Missing RESEND_API_KEY");
    throw new Error("Missing RESEND_API_KEY. Set it to send emails via Resend.");
  }

  const fromAddress =
    process.env.ATLAS_EMAIL_FROM ?? "Atlas <atlas@notifications.useatlas.dev>";
  const recipients = Array.isArray(params.to) ? params.to : [params.to];

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: recipients,
      subject: params.subject,
      html: params.body,
    }),
  });

  if (!response.ok) {
    let detail: string;
    try {
      const errorBody = (await response.json()) as { message?: string };
      detail = errorBody.message ?? `HTTP ${response.status}`;
    } catch {
      try {
        const text = await response.text();
        detail = text ? `HTTP ${response.status}: ${text.slice(0, 200)}` : `HTTP ${response.status}`;
      } catch {
        detail = `HTTP ${response.status}`;
      }
    }
    log.error({ status: response.status, detail }, "Resend API request failed");
    throw new Error(`Resend API error: ${detail}`);
  }

  let data: { id?: string };
  try {
    data = (await response.json()) as { id?: string };
  } catch (err) {
    log.error({ err }, "Failed to parse Resend API success response");
    throw new Error("Resend API returned unparseable response after success status", { cause: err });
  }

  if (!data.id) {
    log.warn("Resend API returned success but no email ID — email may have been sent");
  }
  return { id: data.id ?? "unknown" };
}

// ---------------------------------------------------------------------------
// Agent tool (AtlasAction)
// ---------------------------------------------------------------------------

const SEND_EMAIL_DESCRIPTION = `### Send Email Report
Use sendEmailReport to email analysis results to stakeholders:
- Provide recipient email addresses
- Include a clear subject line
- Format the body as HTML for rich formatting
- Domain restrictions may apply (ATLAS_EMAIL_ALLOWED_DOMAINS)
- Emails require admin approval before sending`;

export const sendEmailReport: AtlasAction = {
  name: "sendEmailReport",
  description: SEND_EMAIL_DESCRIPTION,
  actionType: "email:send",
  reversible: false,
  defaultApproval: "admin-only",
  requiredCredentials: ["RESEND_API_KEY"],

  tool: tool({
    description:
      "Send an email report. Requires admin approval before the email is sent.",
    inputSchema: z.object({
      to: z
        .union([z.string(), z.array(z.string()).min(1)])
        .describe("Recipient email address(es)"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body (HTML)"),
    }),
    execute: async ({ to, subject, body }) => {
      const recipients = Array.isArray(to) ? to : [to];
      log.info(
        { to: recipients, subject },
        "sendEmailReport invoked",
      );

      // Domain allowlist check — runs pre-approval
      const domainCheck = validateAllowedDomains(recipients);
      if (!domainCheck.valid) {
        return {
          status: "error" as const,
          error: `Recipient domain not allowed: ${domainCheck.blocked.join(", ")}. Allowed domains: ${process.env.ATLAS_EMAIL_ALLOWED_DOMAINS}`,
        };
      }

      const request = buildActionRequest({
        actionType: "email:send",
        target: recipients.join(", "),
        summary: `Send email: "${subject}" to ${recipients.join(", ")}`,
        payload: { to: recipients, subject, body },
        reversible: false,
      });

      return handleAction(request, async (payload) => {
        const result = await executeEmailSend(
          payload as unknown as EmailSendParams,
        );
        return result;
      });
    },
  }),
};
