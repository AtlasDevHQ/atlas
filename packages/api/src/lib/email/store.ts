/**
 * Email integration storage.
 *
 * Stores per-workspace email delivery configuration in the internal database.
 * Supports multiple providers: SMTP, SendGrid, Postmark, SES.
 * Each workspace admin configures their own email delivery settings (BYOT).
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecret, decryptSecret } from "@atlas/api/lib/db/secret-encryption";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { createLogger } from "@atlas/api/lib/logger";
import {
  EMAIL_PROVIDERS,
  type EmailInstallationWithSecret,
  type EmailProvider,
  type ProviderConfig,
} from "@atlas/api/lib/integrations/types";

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

function isEmailProvider(value: string): value is EmailProvider {
  return (EMAIL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Decode the provider-config payload. Prefer `config_encrypted` and fall
 * back to the plaintext `config` JSONB when the encrypted column is
 * missing *or* fails to decrypt. The decrypt-failure fallback is
 * load-bearing during the F-41 soak — a single bad ciphertext must not
 * hide a working plaintext copy (which would cause the admin UI to show
 * "no provider configured" and invite an overwrite that loses the
 * working config). Post-#1832 (plaintext drop), decrypt failure becomes
 * terminal naturally.
 */
function pickEncryptedConfig(
  encrypted: unknown,
  plaintext: unknown,
  context: Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof encrypted === "string" && encrypted.length > 0) {
    try {
      const decoded = decryptSecret(encrypted);
      const parsed = JSON.parse(decoded) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      log.warn({ ...context }, "Decrypted email config is not an object — falling back to plaintext");
    } catch (err) {
      log.warn(
        { ...context, parseError: err instanceof Error ? err.message : String(err) },
        "Failed to decrypt/parse email config — falling back to plaintext (F-41 soak)",
      );
    }
  }
  if (plaintext && typeof plaintext === "object") {
    return plaintext as Record<string, unknown>;
  }
  if (typeof plaintext === "string") {
    try {
      const parsed = JSON.parse(plaintext) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // fall through to the warn log
    }
  }
  log.warn(context, "Email installation config column is missing or unreadable");
  return null;
}

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
 *
 * Two guards protect the cast:
 *
 * 1. `isEmailProvider(provider)` — the sibling column must name a
 *    recognized provider. A row with `provider = 'mailgun'` (legacy
 *    column, manual SQL patch, future-not-yet-enum'd value) returns null
 *    with a warn log rather than shipping an unrepresentable config
 *    variant to the caller (CLAUDE.md: no silent coercion of unknown
 *    enums).
 *
 * 2. **Sibling-spread-last ordering** — `{ ...rawConfig, provider }`
 *    means the sibling column always wins over whatever lives inside
 *    the JSONB. Legacy rows (written before the save-path strip-on-write
 *    was added) or rows touched by out-of-band SQL can carry a stale
 *    `config.provider` that disagrees with the authoritative column; we
 *    overwrite it here and emit a warn breadcrumb so operators can
 *    reconcile the drift.
 */
function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): EmailInstallationWithSecret | null {
  const configId = row.config_id;
  const provider = row.provider;
  const senderAddress = row.sender_address;
  if (
    typeof configId !== "string" || !configId ||
    typeof provider !== "string" || !provider ||
    typeof senderAddress !== "string" || !senderAddress
  ) {
    log.warn(context, "Invalid email installation record in database");
    return null;
  }
  if (!isEmailProvider(provider)) {
    log.warn(
      { ...context, provider },
      "Email installation row references unknown provider — skipping",
    );
    return null;
  }
  // F-41: prefer the encrypted blob when present; fall back to the
  // plaintext JSONB column for rows not yet migrated by the backfill.
  const rawConfigRecord = pickEncryptedConfig(row.config_encrypted, row.config, context);
  if (!rawConfigRecord) return null;
  if (
    typeof rawConfigRecord.provider === "string" &&
    rawConfigRecord.provider !== provider
  ) {
    log.warn(
      { ...context, columnProvider: provider, jsonbProvider: rawConfigRecord.provider },
      "Email installation JSONB config.provider disagrees with sibling provider column — sibling wins",
    );
  }
  // Sibling-last: overwrites any stale `provider` carried by legacy rows.
  const taggedConfig = { ...rawConfigRecord, provider } as unknown as ProviderConfig;
  return {
    config_id: configId,
    provider,
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
      "SELECT config_id, provider, sender_address, config, config_encrypted, org_id, installed_at::text FROM email_installations WHERE org_id = $1",
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
    const configSerialized = JSON.stringify(configJson);
    // F-41 dual-write: plaintext JSONB for back-compat readers + encrypted
    // TEXT blob for at-rest protection. Follow-up PR drops plaintext.
    const configEncrypted = encryptSecret(configSerialized);
    const keyVersion = activeKeyVersion();
    await internalQuery(
      `INSERT INTO email_installations (provider, sender_address, config, config_encrypted, config_key_version, org_id)
       VALUES ($1, $2, $3, $4, $6, $5)
       ON CONFLICT (org_id) DO UPDATE SET
         provider = $1,
         sender_address = $2,
         config = $3,
         config_encrypted = $4,
         config_key_version = $6,
         installed_at = now()`,
      [opts.provider, opts.senderAddress, configSerialized, configEncrypted, orgId, keyVersion],
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
