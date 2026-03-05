/**
 * Slack installation storage.
 *
 * Stores OAuth bot tokens in the internal database (via AtlasPluginContext.db)
 * when available. Falls back to config botToken for single-workspace mode.
 */

import type { PluginLogger } from "@useatlas/plugin-sdk";

export interface SlackInstallation {
  team_id: string;
  bot_token: string;
  installed_at: string;
}

/** DB handle matching AtlasPluginContext.db shape. */
export type PluginDB = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  execute(sql: string, params?: unknown[]): Promise<void>;
};

/**
 * Get the installation record for a team. Checks internal DB first, then
 * falls back to the config botToken.
 */
export async function getInstallation(
  teamId: string,
  db: PluginDB | null,
  fallbackToken: string | undefined,
  log?: PluginLogger,
): Promise<SlackInstallation | null> {
  if (db) {
    try {
      const result = await db.query(
        "SELECT team_id, bot_token, installed_at::text FROM slack_installations WHERE team_id = $1",
        [teamId],
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        const teamIdVal = row.team_id;
        const botToken = row.bot_token;
        const installedAt = row.installed_at;
        if (typeof teamIdVal !== "string" || typeof botToken !== "string" || !botToken) {
          log?.warn({ teamId }, "Invalid installation record in database");
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
      log?.error(
        { err: err instanceof Error ? err.message : String(err), teamId },
        "Failed to query slack_installations",
      );
      throw err;
    }
  }

  // Single-workspace mode: no internal DB, use config token
  if (fallbackToken) {
    return {
      team_id: teamId,
      bot_token: fallbackToken,
      installed_at: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * Save or update a Slack installation (OAuth flow).
 * Throws if the database write fails or no DB is available.
 */
export async function saveInstallation(
  teamId: string,
  botToken: string,
  db: PluginDB | null,
): Promise<void> {
  if (!db) {
    throw new Error("Cannot save Slack installation — no internal database configured");
  }

  await db.execute(
    `INSERT INTO slack_installations (team_id, bot_token)
     VALUES ($1, $2)
     ON CONFLICT (team_id) DO UPDATE SET bot_token = $2, installed_at = now()`,
    [teamId, botToken],
  );
}

/**
 * Get the bot token for a team — convenience wrapper.
 */
export async function getBotToken(
  teamId: string,
  db: PluginDB | null,
  fallbackToken: string | undefined,
  log?: PluginLogger,
): Promise<string | null> {
  const installation = await getInstallation(teamId, db, fallbackToken, log);
  return installation?.bot_token ?? null;
}
