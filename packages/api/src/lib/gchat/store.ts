/**
 * Google Chat installation storage.
 *
 * Stores per-workspace service account credentials in the internal database.
 * Google Chat uses service accounts (not OAuth). Each workspace admin
 * pastes their service account JSON key (BYOT).
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecret, pickDecryptedSecret } from "@atlas/api/lib/db/secret-encryption";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { createLogger } from "@atlas/api/lib/logger";
import type { GChatInstallation, GChatInstallationWithSecret } from "@atlas/api/lib/integrations/types";

export type { GChatInstallation, GChatInstallationWithSecret } from "@atlas/api/lib/integrations/types";

const log = createLogger("gchat-store");

const SELECT_COLS = "project_id, service_account_email, credentials_json, credentials_json_encrypted, org_id, installed_at::text";

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): GChatInstallationWithSecret | null {
  const projectId = row.project_id;
  const serviceAccountEmail = row.service_account_email;
  const credentialsJson = pickDecryptedSecret(row.credentials_json_encrypted, row.credentials_json);
  if (
    typeof projectId !== "string" || !projectId ||
    typeof serviceAccountEmail !== "string" || !serviceAccountEmail ||
    !credentialsJson
  ) {
    log.warn(context, "Invalid Google Chat installation record in database");
    return null;
  }
  return {
    project_id: projectId,
    service_account_email: serviceAccountEmail,
    credentials_json: credentialsJson,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    installed_at: typeof row.installed_at === "string" ? row.installed_at : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get the Google Chat installation for a project ID.
 */
export async function getGChatInstallation(
  projectId: string,
): Promise<GChatInstallationWithSecret | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT ${SELECT_COLS} FROM gchat_installations WHERE project_id = $1`,
      [projectId],
    );
    if (rows.length > 0) {
      return parseInstallationRow(rows[0], { projectId });
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), projectId },
      "Failed to query gchat_installations",
    );
    throw err;
  }
}

/**
 * Get the Google Chat installation for an org. Returns null if not found or
 * if no internal database is configured.
 */
export async function getGChatInstallationByOrg(
  orgId: string,
): Promise<GChatInstallation | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT ${SELECT_COLS} FROM gchat_installations WHERE org_id = $1`,
      [orgId],
    );
    if (rows.length > 0) {
      const full = parseInstallationRow(rows[0], { orgId });
      if (!full) return null;
      const { credentials_json: _, ...pub } = full;
      return pub;
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to query gchat_installations by org",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update a Google Chat installation (service account submission).
 * Throws if the service account is already bound to a different organization (hijack protection).
 * Throws if the database write fails.
 */
export async function saveGChatInstallation(
  projectId: string,
  opts: { orgId?: string; serviceAccountEmail: string; credentialsJson: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Google Chat installation — no internal database configured");
  }

  const orgId = opts.orgId ?? null;
  const credentialsJsonEncrypted = encryptSecret(opts.credentialsJson);
  const keyVersion = activeKeyVersion();

  try {
    // Atomic upsert with hijack protection — the WHERE clause rejects rows
    // bound to a different org in one statement (no TOCTOU race).
    const rows = await internalQuery<{ project_id: string }>(
      `INSERT INTO gchat_installations (project_id, service_account_email, credentials_json, credentials_json_encrypted, credentials_json_key_version, org_id)
       VALUES ($1, $2, $3, $4, $6, $5)
       ON CONFLICT (project_id) DO UPDATE SET
         service_account_email = $2,
         credentials_json = $3,
         credentials_json_encrypted = $4,
         credentials_json_key_version = $6,
         org_id = COALESCE($5, gchat_installations.org_id),
         installed_at = now()
       WHERE gchat_installations.org_id IS NULL OR gchat_installations.org_id = $5
       RETURNING project_id`,
      [projectId, opts.serviceAccountEmail, opts.credentialsJson, credentialsJsonEncrypted, orgId, keyVersion],
    );

    if (rows.length === 0) {
      throw new Error(
        `Service account ${projectId} is already bound to a different organization. ` +
        `Disconnect the existing installation first.`,
      );
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), projectId },
      "Failed to save gchat_installations",
    );
    throw err;
  }
}

/**
 * Remove a Google Chat installation by project ID.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteGChatInstallation(projectId: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Google Chat installation — no internal database configured");
  }

  try {
    await internalQuery("DELETE FROM gchat_installations WHERE project_id = $1", [projectId]);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), projectId },
      "Failed to delete gchat_installations",
    );
    throw err;
  }
}

/**
 * Remove the Google Chat installation for an org.
 * Returns true if a row was deleted, false if no matching row found.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteGChatInstallationByOrg(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Google Chat installation — no internal database configured");
  }

  try {
    const rows = await internalQuery<{ project_id: string }>(
      "DELETE FROM gchat_installations WHERE org_id = $1 RETURNING project_id",
      [orgId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to delete gchat_installations by org",
    );
    throw err;
  }
}
