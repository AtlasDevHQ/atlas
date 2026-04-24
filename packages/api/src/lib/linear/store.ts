/**
 * Linear installation storage.
 *
 * Stores per-workspace Linear API keys in the internal database.
 * Each workspace admin enters their own API key (BYOT).
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecret, pickDecryptedSecret } from "@atlas/api/lib/db/secret-encryption";
import { createLogger } from "@atlas/api/lib/logger";
import type { LinearInstallation, LinearInstallationWithSecret } from "@atlas/api/lib/integrations/types";

export type { LinearInstallation, LinearInstallationWithSecret } from "@atlas/api/lib/integrations/types";

const log = createLogger("linear-store");

const SELECT_COLS = "user_id, api_key, api_key_encrypted, user_name, user_email, org_id, installed_at::text";

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): LinearInstallationWithSecret | null {
  const userId = row.user_id;
  const apiKey = pickDecryptedSecret(row.api_key_encrypted, row.api_key);
  if (typeof userId !== "string" || !userId || !apiKey) {
    log.warn(context, "Invalid Linear installation record in database");
    return null;
  }
  return {
    user_id: userId,
    api_key: apiKey,
    user_name: typeof row.user_name === "string" ? row.user_name : null,
    user_email: typeof row.user_email === "string" ? row.user_email : null,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    installed_at: typeof row.installed_at === "string" ? row.installed_at : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get the Linear installation for a user ID (Linear viewer ID).
 */
export async function getLinearInstallation(
  userId: string,
): Promise<LinearInstallationWithSecret | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT ${SELECT_COLS} FROM linear_installations WHERE user_id = $1`,
      [userId],
    );
    if (rows.length > 0) {
      return parseInstallationRow(rows[0], { userId });
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), userId },
      "Failed to query linear_installations",
    );
    throw err;
  }
}

/**
 * Get the Linear installation for an org. Returns null if not found or
 * if no internal database is configured.
 */
export async function getLinearInstallationByOrg(
  orgId: string,
): Promise<LinearInstallation | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT ${SELECT_COLS} FROM linear_installations WHERE org_id = $1`,
      [orgId],
    );
    if (rows.length > 0) {
      const full = parseInstallationRow(rows[0], { orgId });
      if (!full) return null;
      const { api_key: _, ...pub } = full;
      return pub;
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to query linear_installations by org",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update a Linear installation (API key submission).
 * Throws if the Linear user is already bound to a different organization (hijack protection).
 * Throws if the database write fails.
 */
export async function saveLinearInstallation(
  userId: string,
  opts: { orgId?: string; userName?: string; userEmail?: string; apiKey: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Linear installation — no internal database configured");
  }

  const orgId = opts.orgId ?? null;
  const userName = opts.userName ?? null;
  const userEmail = opts.userEmail ?? null;
  const apiKeyEncrypted = encryptSecret(opts.apiKey);

  try {
    // Atomic upsert with hijack protection — the WHERE clause rejects rows
    // bound to a different org in one statement (no TOCTOU race).
    const rows = await internalQuery<{ user_id: string }>(
      `INSERT INTO linear_installations (user_id, api_key, api_key_encrypted, user_name, user_email, org_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         api_key = $2,
         api_key_encrypted = $3,
         user_name = COALESCE($4, linear_installations.user_name),
         user_email = COALESCE($5, linear_installations.user_email),
         org_id = COALESCE($6, linear_installations.org_id),
         installed_at = now()
       WHERE linear_installations.org_id IS NULL OR linear_installations.org_id = $6
       RETURNING user_id`,
      [userId, opts.apiKey, apiKeyEncrypted, userName, userEmail, orgId],
    );

    if (rows.length === 0) {
      throw new Error(
        `Linear user ${userId} is already bound to a different organization. ` +
        `Disconnect the existing installation first.`,
      );
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), userId },
      "Failed to save linear_installations",
    );
    throw err;
  }
}

/**
 * Remove a Linear installation by user ID.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteLinearInstallation(userId: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Linear installation — no internal database configured");
  }

  try {
    await internalQuery("DELETE FROM linear_installations WHERE user_id = $1", [userId]);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), userId },
      "Failed to delete linear_installations",
    );
    throw err;
  }
}

/**
 * Remove the Linear installation for an org.
 * Returns true if a row was deleted, false if no matching row found.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteLinearInstallationByOrg(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Linear installation — no internal database configured");
  }

  try {
    const rows = await internalQuery<{ user_id: string }>(
      "DELETE FROM linear_installations WHERE org_id = $1 RETURNING user_id",
      [orgId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to delete linear_installations by org",
    );
    throw err;
  }
}
