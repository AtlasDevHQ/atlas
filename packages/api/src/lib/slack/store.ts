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
  installed_at: string;
}

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
        "SELECT team_id, bot_token, installed_at::text FROM slack_installations WHERE team_id = $1",
        [teamId],
      );
      if (rows.length > 0) {
        const teamIdVal = rows[0].team_id;
        const botToken = rows[0].bot_token;
        const installedAt = rows[0].installed_at;
        if (typeof teamIdVal !== "string" || typeof botToken !== "string" || !botToken) {
          log.warn({ teamId }, "Invalid installation record in database");
          return null;
        }
        return {
          team_id: teamIdVal,
          bot_token: botToken,
          installed_at: typeof installedAt === "string" ? installedAt : new Date().toISOString(),
        };
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
      installed_at: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * Save or update a Slack installation (OAuth flow).
 * Throws if the database write fails.
 */
export async function saveInstallation(teamId: string, botToken: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Slack installation — no internal database configured");
  }

  const pool = getInternalDB();
  await pool.query(
    `INSERT INTO slack_installations (team_id, bot_token)
     VALUES ($1, $2)
     ON CONFLICT (team_id) DO UPDATE SET bot_token = $2, installed_at = now()`,
    [teamId, botToken],
  );
}

/**
 * Remove a Slack installation.
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
 * Get the bot token for a team — convenience wrapper.
 */
export async function getBotToken(teamId: string): Promise<string | null> {
  const installation = await getInstallation(teamId);
  return installation?.bot_token ?? null;
}
