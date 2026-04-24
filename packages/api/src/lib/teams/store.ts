/**
 * Teams installation storage.
 *
 * Stores per-tenant authorization records in the internal database.
 * In the platform OAuth flow, app credentials (TEAMS_APP_ID, TEAMS_APP_PASSWORD)
 * come from env vars. In BYOT mode, the app password is stored per-tenant so
 * workspace admins can connect without platform-level env vars.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecret, pickDecryptedSecret } from "@atlas/api/lib/db/secret-encryption";
import { createLogger } from "@atlas/api/lib/logger";
import type { TeamsInstallation, TeamsInstallationWithSecret } from "@atlas/api/lib/integrations/types";

export type { TeamsInstallation, TeamsInstallationWithSecret } from "@atlas/api/lib/integrations/types";

const log = createLogger("teams-store");

const SELECT_COLS = "tenant_id, org_id, tenant_name, app_password, app_password_encrypted, installed_at::text";

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

/**
 * Parse a DB row into a TeamsInstallationWithSecret, validating required fields.
 * Returns null and logs a warning if the row is malformed.
 */
function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): TeamsInstallationWithSecret | null {
  const tenantIdVal = row.tenant_id;
  if (typeof tenantIdVal !== "string") {
    log.warn(context, "Invalid Teams installation record in database");
    return null;
  }
  // app_password is nullable (admin-consent mode stores no password;
  // only BYOT writes one). pickDecryptedSecret returns null when both
  // columns are empty, which is the expected state for OAuth installs.
  const appPassword = pickDecryptedSecret(row.app_password_encrypted, row.app_password);
  return {
    tenant_id: tenantIdVal,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    tenant_name: typeof row.tenant_name === "string" ? row.tenant_name : null,
    app_password: appPassword,
    installed_at: typeof row.installed_at === "string" ? row.installed_at : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get the Teams installation for a tenant. Checks internal DB first, then
 * falls back to env-based detection (TEAMS_APP_ID set = single-tenant mode).
 */
export async function getTeamsInstallation(
  tenantId: string,
): Promise<TeamsInstallationWithSecret | null> {
  if (hasInternalDB()) {
    try {
      const rows = await internalQuery<Record<string, unknown>>(
        `SELECT ${SELECT_COLS} FROM teams_installations WHERE tenant_id = $1`,
        [tenantId],
      );
      if (rows.length > 0) {
        return parseInstallationRow(rows[0], { tenantId });
      }
      return null;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), tenantId },
        "Failed to query teams_installations",
      );
      throw err;
    }
  }

  // Single-tenant mode: no internal DB configured, use env var presence
  const envAppId = process.env.TEAMS_APP_ID;
  if (envAppId) {
    return {
      tenant_id: tenantId,
      org_id: null,
      tenant_name: null,
      app_password: null,
      installed_at: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * Get the Teams installation for an org. Returns null if not found or
 * if no internal database is configured (org-scoped lookups require a DB).
 */
export async function getTeamsInstallationByOrg(
  orgId: string,
): Promise<TeamsInstallation | null> {
  if (!hasInternalDB()) {
    // Org-scoped installations require an internal database.
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT ${SELECT_COLS} FROM teams_installations WHERE org_id = $1`,
      [orgId],
    );
    if (rows.length > 0) {
      const full = parseInstallationRow(rows[0], { orgId });
      if (!full) return null;
      const { app_password: _, ...pub } = full;
      return pub;
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to query teams_installations by org",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update a Teams installation (admin consent flow or BYOT credential submission).
 * Throws if the database write fails.
 */
export async function saveTeamsInstallation(
  tenantId: string,
  opts?: { orgId?: string; tenantName?: string; appPassword?: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Teams installation — no internal database configured");
  }

  const orgId = opts?.orgId ?? null;
  const tenantName = opts?.tenantName ?? null;
  const appPassword = opts?.appPassword ?? null;
  // Encrypt only when we actually have a password to store; admin-consent
  // installs pass undefined and should leave both columns NULL.
  const appPasswordEncrypted = appPassword !== null ? encryptSecret(appPassword) : null;

  try {
    // Atomic upsert with hijack protection — the WHERE clause rejects rows
    // bound to a different org in one statement (no TOCTOU race).
    const rows = await internalQuery<{ tenant_id: string }>(
      `INSERT INTO teams_installations (tenant_id, org_id, tenant_name, app_password, app_password_encrypted)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE SET
         org_id = COALESCE($2, teams_installations.org_id),
         tenant_name = COALESCE($3, teams_installations.tenant_name),
         app_password = COALESCE($4, teams_installations.app_password),
         app_password_encrypted = COALESCE($5, teams_installations.app_password_encrypted),
         installed_at = now()
       WHERE teams_installations.org_id IS NULL OR teams_installations.org_id = $2
       RETURNING tenant_id`,
      [tenantId, orgId, tenantName, appPassword, appPasswordEncrypted],
    );

    if (rows.length === 0) {
      throw new Error(
        `Tenant ${tenantId} is already bound to a different organization. ` +
        `Disconnect the existing installation first.`,
      );
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), tenantId },
      "Failed to save teams_installations",
    );
    throw err;
  }
}

/**
 * Remove a Teams installation by tenant ID.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteTeamsInstallation(tenantId: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Teams installation — no internal database configured");
  }

  try {
    await internalQuery("DELETE FROM teams_installations WHERE tenant_id = $1", [tenantId]);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), tenantId },
      "Failed to delete teams_installations",
    );
    throw err;
  }
}

/**
 * Remove the Teams installation for an org.
 * Returns true if a row was deleted, false if no matching row found.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteTeamsInstallationByOrg(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Teams installation — no internal database configured");
  }

  try {
    const rows = await internalQuery<{ tenant_id: string }>(
      "DELETE FROM teams_installations WHERE org_id = $1 RETURNING tenant_id",
      [orgId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to delete teams_installations by org",
    );
    throw err;
  }
}
