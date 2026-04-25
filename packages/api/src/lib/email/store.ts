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
 * Decode the provider-config payload from `config_encrypted`. Two
 * branches:
 *
 *   • encrypted column NULL/empty   → row is in a transitional state
 *                                     (e.g. mid-install) — return null
 *                                     and the caller surfaces "no
 *                                     provider configured".
 *   • encrypted column has data,
 *     decrypt or JSON.parse throws  → THROW. The caller (route handler)
 *                                     surfaces a 500 with `requestId`
 *                                     and the admin sees an actionable
 *                                     error.
 *
 * The throw-on-decrypt-failure semantic prevents the silent footgun
 * where "decrypt failed" looks like "no provider configured" — under
 * the old null-return semantics an operator could click Save on a
 * row that's actually unreadable, overwriting evidence of corruption
 * (or a botched key rotation) with a fresh ciphertext under the active
 * key. Forcing the 500 makes the underlying problem visible.
 */
function decodeEncryptedConfig(
  encrypted: unknown,
  context: Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof encrypted !== "string" || encrypted.length === 0) {
    log.warn(context, "Email installation config_encrypted column is missing");
    return null;
  }
  // Let decrypt + JSON.parse failures propagate — the route layer maps
  // them to 500 with a scrubbed message and the admin UI surfaces the
  // error rather than silently inviting an overwrite.
  const decoded = decryptSecret(encrypted);
  const parsed = JSON.parse(decoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.error({ ...context }, "Decrypted email config is not an object");
    throw new Error("Decrypted email config is not an object");
  }
  return parsed as Record<string, unknown>;
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
  // The plaintext JSONB column was dropped in 0040; reads come from
  // `config_encrypted` only. A decrypt/parse failure returns null and
  // the caller surfaces "no provider configured" so the operator can
  // re-enter the config.
  const rawConfigRecord = decodeEncryptedConfig(row.config_encrypted, context);
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
      "SELECT config_id, provider, sender_address, config_encrypted, org_id, installed_at::text FROM email_installations WHERE org_id = $1",
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
    const configEncrypted = encryptSecret(configSerialized);
    const keyVersion = activeKeyVersion();
    await internalQuery(
      `INSERT INTO email_installations (provider, sender_address, config_encrypted, config_key_version, org_id)
       VALUES ($1, $2, $3, $5, $4)
       ON CONFLICT (org_id) DO UPDATE SET
         provider = $1,
         sender_address = $2,
         config_encrypted = $3,
         config_key_version = $5,
         installed_at = now()`,
      [opts.provider, opts.senderAddress, configEncrypted, orgId, keyVersion],
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
