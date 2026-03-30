/**
 * Email integration storage.
 *
 * Stores per-workspace email delivery configuration in the internal database.
 * Supports multiple providers: SMTP, SendGrid, Postmark, SES.
 * Each workspace admin configures their own email delivery settings (BYOT).
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("email-store");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailProvider = "smtp" | "sendgrid" | "postmark" | "ses";

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
}

export interface SendGridConfig {
  apiKey: string;
}

export interface PostmarkConfig {
  serverToken: string;
}

export interface SesConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type ProviderConfig = SmtpConfig | SendGridConfig | PostmarkConfig | SesConfig;

export interface EmailInstallation {
  config_id: string;
  provider: EmailProvider;
  sender_address: string;
  config: ProviderConfig;
  org_id: string | null;
  installed_at: string;
}

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): EmailInstallation | null {
  const configId = row.config_id;
  const provider = row.provider;
  const senderAddress = row.sender_address;
  const config = row.config;
  if (
    typeof configId !== "string" || !configId ||
    typeof provider !== "string" || !provider ||
    typeof senderAddress !== "string" || !senderAddress ||
    !config || typeof config !== "object"
  ) {
    log.warn(context, "Invalid email installation record in database");
    return null;
  }
  return {
    config_id: configId,
    provider: provider as EmailProvider,
    sender_address: senderAddress,
    config: config as ProviderConfig,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    installed_at: typeof row.installed_at === "string" ? row.installed_at : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get the email installation for an org. Returns null if not found or
 * if no internal database is configured.
 */
export async function getEmailInstallationByOrg(
  orgId: string,
): Promise<EmailInstallation | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      "SELECT config_id, provider, sender_address, config, org_id, installed_at::text FROM email_installations WHERE org_id = $1",
      [orgId],
    );
    if (rows.length > 0) {
      return parseInstallationRow(rows[0], { orgId });
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to query email_installations by org",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update an email installation for an org.
 * Atomic upsert on org_id (UNIQUE index) — each org gets exactly one email config.
 * Throws if the database write fails.
 */
export async function saveEmailInstallation(
  orgId: string,
  opts: {
    provider: EmailProvider;
    senderAddress: string;
    config: ProviderConfig;
  },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save email installation — no internal database configured");
  }

  try {
    // Atomic upsert — the UNIQUE index on org_id ensures one config per org.
    await internalQuery(
      `INSERT INTO email_installations (provider, sender_address, config, org_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id) DO UPDATE SET
         provider = $1,
         sender_address = $2,
         config = $3,
         installed_at = now()`,
      [opts.provider, opts.senderAddress, JSON.stringify(opts.config), orgId],
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to save email_installations",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Delete operations
// ---------------------------------------------------------------------------

/**
 * Remove the email installation for an org.
 * Returns true if a row was deleted, false if no matching row found.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteEmailInstallationByOrg(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete email installation — no internal database configured");
  }

  try {
    const rows = await internalQuery<{ config_id: string }>(
      "DELETE FROM email_installations WHERE org_id = $1 RETURNING config_id",
      [orgId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to delete email_installations by org",
    );
    throw err;
  }
}
