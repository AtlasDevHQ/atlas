/**
 * Discord installation storage.
 *
 * Stores per-guild authorization records in the internal database.
 * App credentials (DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET) are platform-level
 * env vars — what changes per-org is which Discord guild authorized the bot.
 * Like Teams, the bot token itself is a platform-level credential, not stored
 * per-guild.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("discord-store");

export interface DiscordInstallation {
  guild_id: string;
  org_id: string | null;
  guild_name: string | null;
  installed_at: string;
}

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

/**
 * Parse a DB row into a DiscordInstallation, validating required fields.
 * Returns null and logs a warning if the row is malformed.
 */
function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): DiscordInstallation | null {
  const guildIdVal = row.guild_id;
  if (typeof guildIdVal !== "string") {
    log.warn(context, "Invalid Discord installation record in database");
    return null;
  }
  return {
    guild_id: guildIdVal,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    guild_name: typeof row.guild_name === "string" ? row.guild_name : null,
    installed_at: typeof row.installed_at === "string" ? row.installed_at : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get the Discord installation for a guild. Checks internal DB first, then
 * falls back to env-based detection (DISCORD_CLIENT_ID set = single-guild mode).
 */
export async function getDiscordInstallation(
  guildId: string,
): Promise<DiscordInstallation | null> {
  if (hasInternalDB()) {
    try {
      const rows = await internalQuery<Record<string, unknown>>(
        "SELECT guild_id, org_id, guild_name, installed_at::text FROM discord_installations WHERE guild_id = $1",
        [guildId],
      );
      if (rows.length > 0) {
        return parseInstallationRow(rows[0], { guildId });
      }
      return null;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), guildId },
        "Failed to query discord_installations",
      );
      throw err;
    }
  }

  // Single-guild mode: no internal DB configured, use env var presence
  const envClientId = process.env.DISCORD_CLIENT_ID;
  if (envClientId) {
    return {
      guild_id: guildId,
      org_id: null,
      guild_name: null,
      installed_at: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * Get the Discord installation for an org. Returns null if not found or
 * if no internal database is configured (org-scoped lookups require a DB).
 */
export async function getDiscordInstallationByOrg(
  orgId: string,
): Promise<DiscordInstallation | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      "SELECT guild_id, org_id, guild_name, installed_at::text FROM discord_installations WHERE org_id = $1",
      [orgId],
    );
    if (rows.length > 0) {
      return parseInstallationRow(rows[0], { orgId });
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to query discord_installations by org",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update a Discord installation (OAuth2 callback).
 * Throws if the guild is already bound to a different organization (hijack protection).
 * Throws if the database write fails.
 */
export async function saveDiscordInstallation(
  guildId: string,
  opts?: { orgId?: string; guildName?: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Discord installation — no internal database configured");
  }

  const orgId = opts?.orgId ?? null;
  const guildName = opts?.guildName ?? null;

  try {
    // Reject if the guild is already bound to a different org (prevents hijacking).
    const existing = await internalQuery<Record<string, unknown>>(
      "SELECT org_id FROM discord_installations WHERE guild_id = $1",
      [guildId],
    );

    if (existing.length > 0) {
      const existingOrgId = existing[0].org_id;
      if (existingOrgId && orgId && existingOrgId !== orgId) {
        throw new Error(
          `Guild ${guildId} is already bound to a different organization. ` +
          `Disconnect the existing installation first.`,
        );
      }
    }

    await internalQuery(
      `INSERT INTO discord_installations (guild_id, org_id, guild_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id) DO UPDATE SET
         org_id = COALESCE($2, discord_installations.org_id),
         guild_name = COALESCE($3, discord_installations.guild_name),
         installed_at = now()`,
      [guildId, orgId, guildName],
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), guildId },
      "Failed to save discord_installations",
    );
    throw err;
  }
}

/**
 * Remove a Discord installation by guild ID.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteDiscordInstallation(guildId: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Discord installation — no internal database configured");
  }

  try {
    await internalQuery("DELETE FROM discord_installations WHERE guild_id = $1", [guildId]);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), guildId },
      "Failed to delete discord_installations",
    );
    throw err;
  }
}

/**
 * Remove the Discord installation for an org.
 * Returns true if a row was deleted, false if no matching row found.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteDiscordInstallationByOrg(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Discord installation — no internal database configured");
  }

  try {
    const rows = await internalQuery<{ guild_id: string }>(
      "DELETE FROM discord_installations WHERE org_id = $1 RETURNING guild_id",
      [orgId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to delete discord_installations by org",
    );
    throw err;
  }
}
