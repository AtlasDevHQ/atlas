/**
 * GitHub installation storage.
 *
 * Stores per-workspace personal access tokens in the internal database.
 * Each workspace admin enters their own PAT (BYOT).
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { GitHubInstallation, GitHubInstallationWithSecret } from "@atlas/api/lib/integrations/types";

export type { GitHubInstallation, GitHubInstallationWithSecret } from "@atlas/api/lib/integrations/types";

const log = createLogger("github-store");

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): GitHubInstallationWithSecret | null {
  const userId = row.user_id;
  const accessToken = row.access_token;
  if (typeof userId !== "string" || !userId || typeof accessToken !== "string" || !accessToken) {
    log.warn(context, "Invalid GitHub installation record in database");
    return null;
  }
  return {
    user_id: userId,
    access_token: accessToken,
    username: typeof row.username === "string" ? row.username : null,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    installed_at: typeof row.installed_at === "string" ? row.installed_at : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get the GitHub installation for a user ID (GitHub numeric user ID).
 */
export async function getGitHubInstallation(
  userId: string,
): Promise<GitHubInstallationWithSecret | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      "SELECT user_id, access_token, username, org_id, installed_at::text FROM github_installations WHERE user_id = $1",
      [userId],
    );
    if (rows.length > 0) {
      return parseInstallationRow(rows[0], { userId });
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), userId },
      "Failed to query github_installations",
    );
    throw err;
  }
}

/**
 * Get the GitHub installation for an org. Returns null if not found or
 * if no internal database is configured.
 */
export async function getGitHubInstallationByOrg(
  orgId: string,
): Promise<GitHubInstallation | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      "SELECT user_id, access_token, username, org_id, installed_at::text FROM github_installations WHERE org_id = $1",
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
      "Failed to query github_installations by org",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update a GitHub installation (PAT submission).
 * Throws if the GitHub user is already bound to a different organization (hijack protection).
 * Throws if the database write fails.
 */
export async function saveGitHubInstallation(
  userId: string,
  opts: { orgId?: string; username?: string; accessToken: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save GitHub installation — no internal database configured");
  }

  const orgId = opts.orgId ?? null;
  const username = opts.username ?? null;

  try {
    // Atomic upsert with hijack protection — the WHERE clause rejects rows
    // bound to a different org in one statement (no TOCTOU race).
    const rows = await internalQuery<{ user_id: string }>(
      `INSERT INTO github_installations (user_id, access_token, username, org_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         access_token = $2,
         username = COALESCE($3, github_installations.username),
         org_id = COALESCE($4, github_installations.org_id),
         installed_at = now()
       WHERE github_installations.org_id IS NULL OR github_installations.org_id = $4
       RETURNING user_id`,
      [userId, opts.accessToken, username, orgId],
    );

    if (rows.length === 0) {
      throw new Error(
        `GitHub user ${userId} is already bound to a different organization. ` +
        `Disconnect the existing installation first.`,
      );
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), userId },
      "Failed to save github_installations",
    );
    throw err;
  }
}

/**
 * Remove a GitHub installation by user ID.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteGitHubInstallation(userId: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete GitHub installation — no internal database configured");
  }

  try {
    await internalQuery("DELETE FROM github_installations WHERE user_id = $1", [userId]);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), userId },
      "Failed to delete github_installations",
    );
    throw err;
  }
}

/**
 * Remove the GitHub installation for an org.
 * Returns true if a row was deleted, false if no matching row found.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteGitHubInstallationByOrg(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete GitHub installation — no internal database configured");
  }

  try {
    const rows = await internalQuery<{ user_id: string }>(
      "DELETE FROM github_installations WHERE org_id = $1 RETURNING user_id",
      [orgId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to delete github_installations by org",
    );
    throw err;
  }
}
