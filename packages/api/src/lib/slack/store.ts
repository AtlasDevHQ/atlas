/**
 * Slack installation storage.
 *
 * Stores OAuth bot tokens in the internal database when available.
 * Falls back to SLACK_BOT_TOKEN env var for single-workspace mode.
 */

import { hasInternalDB, internalQuery, getInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("slack-store");

export interface SlackInstallation {
  team_id: string;
  bot_token: string;
  org_id: string | null;
  workspace_name: string | null;
  installed_at: string;
}

/** Sentinel team_id for env-var-based installations (no real Slack team). */
export const ENV_TEAM_ID = "env" as const;

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

/**
 * Parse a DB row into a SlackInstallation, validating required fields.
 * Returns null and logs a warning if the row is malformed.
 */
function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): SlackInstallation | null {
  const teamIdVal = row.team_id;
  const botToken = row.bot_token;
  const installedAt = row.installed_at;
  if (typeof teamIdVal !== "string" || typeof botToken !== "string" || !botToken) {
    log.warn(context, "Invalid installation record in database");
    return null;
  }
  return {
    team_id: teamIdVal,
    bot_token: botToken,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    workspace_name: typeof row.workspace_name === "string" ? row.workspace_name : null,
    installed_at: typeof installedAt === "string" ? installedAt : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get the bot token for a team. Checks internal DB first, then falls
 * back to SLACK_BOT_TOKEN env var.
 */
export async function getInstallation(
  teamId: string,
): Promise<SlackInstallation | null> {
  if (hasInternalDB()) {
    try {
      const rows = await internalQuery<Record<string, unknown>>(
        "SELECT team_id, bot_token, org_id, workspace_name, installed_at::text FROM slack_installations WHERE team_id = $1",
        [teamId],
      );
      if (rows.length > 0) {
        return parseInstallationRow(rows[0], { teamId });
      }
      return null;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), teamId },
        "Failed to query slack_installations",
      );
      throw err;
    }
  }

  // Single-workspace mode: no internal DB configured, use env var
  const envToken = process.env.SLACK_BOT_TOKEN;
  if (envToken) {
    return {
      team_id: teamId,
      bot_token: envToken,
      org_id: null,
      workspace_name: null,
      installed_at: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * Get the Slack installation for an org. Returns null if not found or
 * if no internal database is configured (org-scoped lookups require a DB).
 */
export async function getInstallationByOrg(
  orgId: string,
): Promise<SlackInstallation | null> {
  if (!hasInternalDB()) {
    // Org-scoped installations require an internal database.
    // Env-based status is reported separately via envConfigured flag.
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      "SELECT team_id, bot_token, org_id, workspace_name, installed_at::text FROM slack_installations WHERE org_id = $1",
      [orgId],
    );
    if (rows.length > 0) {
      return parseInstallationRow(rows[0], { orgId });
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to query slack_installations by org",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update a Slack installation (OAuth flow).
 * Throws if the database write fails.
 */
export async function saveInstallation(
  teamId: string,
  botToken: string,
  opts?: { orgId?: string; workspaceName?: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Slack installation — no internal database configured");
  }

  const pool = getInternalDB();
  await pool.query(
    `INSERT INTO slack_installations (team_id, bot_token, org_id, workspace_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (team_id) DO UPDATE SET bot_token = $2, org_id = $3, workspace_name = $4, installed_at = now()`,
    [teamId, botToken, opts?.orgId ?? null, opts?.workspaceName ?? null],
  );
}

/**
 * Remove a Slack installation by team ID.
 * Throws if the database delete fails.
 */
export async function deleteInstallation(teamId: string): Promise<void> {
  if (!hasInternalDB()) {
    log.warn({ teamId }, "Cannot delete Slack installation — no internal database configured");
    return;
  }

  const pool = getInternalDB();
  await pool.query("DELETE FROM slack_installations WHERE team_id = $1", [teamId]);
}

/**
 * Remove the Slack installation for an org.
 * Returns true if a row was deleted, false if no matching row found.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteInstallationByOrg(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Slack installation — no internal database configured");
  }

  try {
    const pool = getInternalDB();
    const result = await pool.query(
      "DELETE FROM slack_installations WHERE org_id = $1 RETURNING team_id",
      [orgId],
    );
    return result.rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to delete slack_installations by org",
    );
    throw err;
  }
}

/**
 * Get the bot token for a team — convenience wrapper.
 */
export async function getBotToken(teamId: string): Promise<string | null> {
  const installation = await getInstallation(teamId);
  return installation?.bot_token ?? null;
}
