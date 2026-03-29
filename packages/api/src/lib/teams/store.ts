/**
 * Teams installation storage.
 *
 * Stores per-tenant authorization records in the internal database.
 * Unlike Slack, Teams app credentials (appId, appPassword) are platform-level
 * env vars — what changes per-org is the Azure AD tenant authorization
 * (proof that a workspace admin consented to the bot).
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("teams-store");

export interface TeamsInstallation {
  tenant_id: string;
  org_id: string | null;
  tenant_name: string | null;
  installed_at: string;
}

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

/**
 * Parse a DB row into a TeamsInstallation, validating required fields.
 * Returns null and logs a warning if the row is malformed.
 */
function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): TeamsInstallation | null {
  const tenantIdVal = row.tenant_id;
  if (typeof tenantIdVal !== "string") {
    log.warn(context, "Invalid Teams installation record in database");
    return null;
  }
  return {
    tenant_id: tenantIdVal,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    tenant_name: typeof row.tenant_name === "string" ? row.tenant_name : null,
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
): Promise<TeamsInstallation | null> {
  if (hasInternalDB()) {
    try {
      const rows = await internalQuery<Record<string, unknown>>(
        "SELECT tenant_id, org_id, tenant_name, installed_at::text FROM teams_installations WHERE tenant_id = $1",
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
      "SELECT tenant_id, org_id, tenant_name, installed_at::text FROM teams_installations WHERE org_id = $1",
      [orgId],
    );
    if (rows.length > 0) {
      return parseInstallationRow(rows[0], { orgId });
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
 * Save or update a Teams installation (admin consent flow).
 * Throws if the database write fails.
 */
export async function saveTeamsInstallation(
  tenantId: string,
  opts?: { orgId?: string; tenantName?: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Teams installation — no internal database configured");
  }

  const orgId = opts?.orgId ?? null;
  const tenantName = opts?.tenantName ?? null;

  try {
    // Reject if the tenant is already bound to a different org (prevents hijacking).
    // Only update if the existing org_id matches OR is NULL (unbound).
    const existing = await internalQuery<Record<string, unknown>>(
      "SELECT org_id FROM teams_installations WHERE tenant_id = $1",
      [tenantId],
    );

    if (existing.length > 0) {
      const existingOrgId = existing[0].org_id;
      if (existingOrgId && orgId && existingOrgId !== orgId) {
        throw new Error(
          `Tenant ${tenantId} is already bound to a different organization. ` +
          `Disconnect the existing installation first.`,
        );
      }
    }

    await internalQuery(
      `INSERT INTO teams_installations (tenant_id, org_id, tenant_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET
         org_id = COALESCE($2, teams_installations.org_id),
         tenant_name = COALESCE($3, teams_installations.tenant_name),
         installed_at = now()`,
      [tenantId, orgId, tenantName],
    );
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
