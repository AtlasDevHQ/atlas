/**
 * Email tool — sends emails via the Resend API.
 *
 * Adapted from packages/api/src/lib/tools/actions/email.ts as a standalone
 * plugin tool. Uses config-provided credentials instead of environment variables.
 */

import { tool } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config type — canonical interface used by both tool.ts and index.ts.
// index.ts imports this type and validates it via Zod at factory call time.
// ---------------------------------------------------------------------------

export interface EmailPluginConfig {
  resendApiKey: string;
  allowedDomains?: string[];
  fromAddress?: string;
  approvalMode?: "auto" | "manual" | "admin-only";
}

// ---------------------------------------------------------------------------
// Domain allowlist validation
// ---------------------------------------------------------------------------

/** Extract the domain from an email address, handling display-name format. */
export function extractEmailDomain(addr: string): string | undefined {
  // Handle display-name format: "User <user@company.com>"
  const angleMatch = addr.match(/<([^>]+)>/);
  const email = angleMatch ? angleMatch[1] : addr;
  return email.split("@")[1]?.toLowerCase();
}

export function validateAllowedDomains(
  recipients: string[],
  allowedDomains?: string[],
): { valid: boolean; blocked: string[] } {
  if (!allowedDomains || allowedDomains.length === 0) {
    return { valid: true, blocked: [] };
  }

  const allowed = allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) return { valid: true, blocked: [] };

  const blocked: string[] = [];
  for (const addr of recipients) {
    const domain = extractEmailDomain(addr);
    if (!domain || !allowed.includes(domain)) {
      blocked.push(addr);
    }
  }

  return { valid: blocked.length === 0, blocked };
}

// ---------------------------------------------------------------------------
// Raw Resend API call (config-driven, no env vars)
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
  config: EmailPluginConfig,
  params: EmailSendParams,
): Promise<EmailSendResult> {
  const fromAddress = config.fromAddress ?? "Atlas <atlas@notifications.useatlas.dev>";
  const recipients = Array.isArray(params.to) ? params.to : [params.to];

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: recipients,
      subject: params.subject,
      html: params.body,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    let detail: string;
    try {
      const errorBody = (await response.json()) as { message?: string };
      detail = errorBody.message ?? `HTTP ${response.status}`;
    } catch {
      let rawText = "";
      try {
        rawText = await response.text();
      } catch (textErr) {
        rawText = `[body unreadable: ${textErr instanceof Error ? textErr.message : String(textErr)}]`;
      }
      detail = rawText
        ? `HTTP ${response.status}: ${rawText.slice(0, 200)}`
        : `HTTP ${response.status}`;
    }
    throw new Error(`Resend API error: ${detail}`);
  }

  let data: { id?: string };
  try {
    data = (await response.json()) as { id?: string };
  } catch (err) {
    throw new Error("Resend API returned unparseable response after success status", { cause: err });
  }

  if (!data.id) {
    throw new Error("Email may have been sent but Resend response did not include an ID");
  }

  return { id: data.id };
}

// ---------------------------------------------------------------------------
// AI SDK tool factory
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = `Send an email report to specified recipients.`;

export function createEmailTool(config: EmailPluginConfig) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: z.object({
      to: z
        .union([z.string(), z.array(z.string()).min(1)])
        .describe("Recipient email address(es)"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body (HTML)"),
    }),
    execute: async ({ to, subject, body }) => {
      const recipients = Array.isArray(to) ? to : [to];

      // Domain allowlist check
      const domainCheck = validateAllowedDomains(recipients, config.allowedDomains);
      if (!domainCheck.valid) {
        throw new Error(
          `Recipient domain not allowed: ${domainCheck.blocked.join(", ")}. Allowed domains: ${config.allowedDomains?.join(", ")}`,
        );
      }

      return executeEmailSend(config, { to: recipients, subject, body });
    },
  });
}
