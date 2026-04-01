/**
 * WhatsApp installation storage.
 *
 * Stores per-workspace WhatsApp Cloud API credentials in the internal database.
 * Each workspace admin enters their phone number ID and access token from Meta
 * Business Suite (BYOT).
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { WhatsAppInstallation, WhatsAppInstallationWithSecret } from "@atlas/api/lib/integrations/types";

export type { WhatsAppInstallation, WhatsAppInstallationWithSecret } from "@atlas/api/lib/integrations/types";

const log = createLogger("whatsapp-store");

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): WhatsAppInstallationWithSecret | null {
  const phoneNumberId = row.phone_number_id;
  const accessToken = row.access_token;
  if (typeof phoneNumberId !== "string" || !phoneNumberId || typeof accessToken !== "string" || !accessToken) {
    log.warn(context, "Invalid WhatsApp installation record in database");
    return null;
  }
  return {
    phone_number_id: phoneNumberId,
    access_token: accessToken,
    display_phone: typeof row.display_phone === "string" ? row.display_phone : null,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    installed_at: typeof row.installed_at === "string" ? row.installed_at : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get the WhatsApp installation for a phone number ID.
 */
export async function getWhatsAppInstallation(
  phoneNumberId: string,
): Promise<WhatsAppInstallationWithSecret | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      "SELECT phone_number_id, access_token, display_phone, org_id, installed_at::text FROM whatsapp_installations WHERE phone_number_id = $1",
      [phoneNumberId],
    );
    if (rows.length > 0) {
      return parseInstallationRow(rows[0], { phoneNumberId });
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), phoneNumberId },
      "Failed to query whatsapp_installations",
    );
    throw err;
  }
}

/**
 * Get the WhatsApp installation for an org. Returns null if not found or
 * if no internal database is configured.
 */
export async function getWhatsAppInstallationByOrg(
  orgId: string,
): Promise<WhatsAppInstallation | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      "SELECT phone_number_id, access_token, display_phone, org_id, installed_at::text FROM whatsapp_installations WHERE org_id = $1",
      [orgId],
    );
    if (rows.length > 0) {
      const full = parseInstallationRow(rows[0], { orgId });
      if (!full) return null;
      const { access_token: _, ...pub } = full;
      return pub;
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to query whatsapp_installations by org",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update a WhatsApp installation (Cloud API credential submission).
 * Throws if the phone number is already bound to a different organization (hijack protection).
 * Throws if the database write fails.
 */
export async function saveWhatsAppInstallation(
  phoneNumberId: string,
  opts: { orgId?: string; displayPhone?: string; accessToken: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save WhatsApp installation — no internal database configured");
  }

  const orgId = opts.orgId ?? null;
  const displayPhone = opts.displayPhone ?? null;

  try {
    // Atomic upsert with hijack protection — the WHERE clause rejects rows
    // bound to a different org in one statement (no TOCTOU race).
    const rows = await internalQuery<{ phone_number_id: string }>(
      `INSERT INTO whatsapp_installations (phone_number_id, access_token, display_phone, org_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone_number_id) DO UPDATE SET
         access_token = $2,
         display_phone = COALESCE($3, whatsapp_installations.display_phone),
         org_id = COALESCE($4, whatsapp_installations.org_id),
         installed_at = now()
       WHERE whatsapp_installations.org_id IS NULL OR whatsapp_installations.org_id = $4
       RETURNING phone_number_id`,
      [phoneNumberId, opts.accessToken, displayPhone, orgId],
    );

    if (rows.length === 0) {
      throw new Error(
        `WhatsApp phone number ${phoneNumberId} is already bound to a different organization. ` +
        `Disconnect the existing installation first.`,
      );
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), phoneNumberId },
      "Failed to save whatsapp_installations",
    );
    throw err;
  }
}

/**
 * Remove a WhatsApp installation by phone number ID.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteWhatsAppInstallation(phoneNumberId: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete WhatsApp installation — no internal database configured");
  }

  try {
    await internalQuery("DELETE FROM whatsapp_installations WHERE phone_number_id = $1", [phoneNumberId]);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), phoneNumberId },
      "Failed to delete whatsapp_installations",
    );
    throw err;
  }
}

/**
 * Remove the WhatsApp installation for an org.
 * Returns true if a row was deleted, false if no matching row found.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteWhatsAppInstallationByOrg(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete WhatsApp installation — no internal database configured");
  }

  try {
    const rows = await internalQuery<{ phone_number_id: string }>(
      "DELETE FROM whatsapp_installations WHERE org_id = $1 RETURNING phone_number_id",
      [orgId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to delete whatsapp_installations by org",
    );
    throw err;
  }
}
