/**
 * Email integration storage.
 *
 * Stores per-workspace email delivery configuration in the internal database.
 * Supports multiple providers: SMTP, SendGrid, Postmark, SES.
 * Each workspace admin configures their own email delivery settings (BYOT).
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { EmailInstallationWithSecret, EmailProvider, ProviderConfig } from "@atlas/api/lib/integrations/types";

export { EMAIL_PROVIDERS } from "@atlas/api/lib/integrations/types";
export type {
  EmailInstallation,
  EmailInstallationWithSecret,
  EmailProvider,
  ProviderConfig,
  SmtpConfig,
  SendGridConfig,
  PostmarkConfig,
  SesConfig,
  ResendConfig,
} from "@atlas/api/lib/integrations/types";

const log = createLogger("email-store");

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

/**
 * Parse a DB row into an `EmailInstallationWithSecret`.
 *
 * Post-#1542 `ProviderConfig` is a discriminated union keyed on `provider`,
 * but the JSONB `config` column still stores the provider-specific payload
 * WITHOUT the discriminator (SMTP host/port/etc, API key, etc.). The
 * sibling `provider` column is the authoritative source, so the parser
 * injects it into the config at read time. Downstream consumers (delivery,
 * admin handlers) can then `switch (install.config.provider)` and have
 * TypeScript narrow without `as` casts.
 */
function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): EmailInstallationWithSecret | null {
  const configId = row.config_id;
  const provider = row.provider;
  const senderAddress = row.sender_address;
  const rawConfig = row.config;
  if (
    typeof configId !== "string" || !configId ||
    typeof provider !== "string" || !provider ||
    typeof senderAddress !== "string" || !senderAddress ||
    !rawConfig || typeof rawConfig !== "object"
  ) {
    log.warn(context, "Invalid email installation record in database");
    return null;
  }
  // Inject the provider discriminator into the JSONB payload. The cast
  // through `unknown` is deliberate — `rawConfig` was validated at save
  // time by `validateProviderConfig` against the matching schema, so the
  // combined `{ provider, ...fields }` structurally matches exactly one
  // `ProviderConfig` variant.
  const taggedConfig = { provider, ...(rawConfig as Record<string, unknown>) } as unknown as ProviderConfig;
  return {
    config_id: configId,
    provider: provider as EmailProvider,
    sender_address: senderAddress,
    config: taggedConfig,
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
 *
 * Returns the full WithSecret type because email delivery (delivery.ts)
 * needs the provider credentials to send. The status endpoint only uses
 * public fields from the result.
 */
export async function getEmailInstallationByOrg(
  orgId: string,
): Promise<EmailInstallationWithSecret | null> {
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
    //
    // Strip the `provider` discriminator from the JSONB payload: it lives
    // on the sibling `provider` column (#1542 keeps both in lockstep via
    // the parser in `parseInstallationRow`). Persisting the tag twice
    // would cause round-trip duplication + drift risk if the columns ever
    // diverged.
    const { provider: _provider, ...configJson } = opts.config;
    await internalQuery(
      `INSERT INTO email_installations (provider, sender_address, config, org_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id) DO UPDATE SET
         provider = $1,
         sender_address = $2,
         config = $3,
         installed_at = now()`,
      [opts.provider, opts.senderAddress, JSON.stringify(configJson), orgId],
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
