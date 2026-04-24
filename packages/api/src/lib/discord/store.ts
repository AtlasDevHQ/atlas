/**
 * Discord installation storage.
 *
 * Stores per-guild authorization records in the internal database.
 * In the platform OAuth flow, app credentials (DISCORD_CLIENT_ID, etc.) are
 * platform-level env vars. In BYOT mode, bot credentials (token, application
 * ID, public key) are stored per-guild so workspace admins can connect without
 * platform-level env vars.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecret, pickDecryptedSecret } from "@atlas/api/lib/db/secret-encryption";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { createLogger } from "@atlas/api/lib/logger";
import type { DiscordInstallation, DiscordInstallationWithSecret } from "@atlas/api/lib/integrations/types";

export type { DiscordInstallation, DiscordInstallationWithSecret } from "@atlas/api/lib/integrations/types";

const log = createLogger("discord-store");

const SELECT_COLS = "guild_id, org_id, guild_name, bot_token, bot_token_encrypted, application_id, public_key, installed_at::text";

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

/**
 * Parse a DB row into a DiscordInstallationWithSecret, validating required fields.
 * Returns null and logs a warning if the row is malformed.
 */
function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): DiscordInstallationWithSecret | null {
  const guildIdVal = row.guild_id;
  if (typeof guildIdVal !== "string") {
    log.warn(context, "Invalid Discord installation record in database");
    return null;
  }
  return {
    guild_id: guildIdVal,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    guild_name: typeof row.guild_name === "string" ? row.guild_name : null,
    bot_token: pickDecryptedSecret(row.bot_token_encrypted, row.bot_token),
    application_id: typeof row.application_id === "string" ? row.application_id : null,
    public_key: typeof row.public_key === "string" ? row.public_key : null,
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
): Promise<DiscordInstallationWithSecret | null> {
  if (hasInternalDB()) {
    try {
      const rows = await internalQuery<Record<string, unknown>>(
        `SELECT ${SELECT_COLS} FROM discord_installations WHERE guild_id = $1`,
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
      bot_token: null,
      application_id: null,
      public_key: null,
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
      `SELECT ${SELECT_COLS} FROM discord_installations WHERE org_id = $1`,
      [orgId],
    );
    if (rows.length > 0) {
      const full = parseInstallationRow(rows[0], { orgId });
      if (!full) return null;
      const { bot_token: _, ...pub } = full;
      return pub;
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
 * Save or update a Discord installation (OAuth2 callback or BYOT credential submission).
 * Throws if the guild is already bound to a different organization (hijack protection).
 * Throws if the database write fails.
 */
export async function saveDiscordInstallation(
  guildId: string,
  opts?: { orgId?: string; guildName?: string; botToken?: string; applicationId?: string; publicKey?: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Discord installation — no internal database configured");
  }

  const orgId = opts?.orgId ?? null;
  const guildName = opts?.guildName ?? null;
  const botToken = opts?.botToken ?? null;
  const botTokenEncrypted = botToken !== null ? encryptSecret(botToken) : null;
  // Only stamp the key version when we actually wrote a ciphertext — a
  // connect call that doesn't provide a token (BYOT-less OAuth path)
  // leaves the existing column alone via COALESCE.
  const botTokenKeyVersion = botTokenEncrypted !== null ? activeKeyVersion() : null;
  const applicationId = opts?.applicationId ?? null;
  const publicKey = opts?.publicKey ?? null;

  try {
    // Atomic upsert with hijack protection — the WHERE clause rejects rows
    // bound to a different org in one statement (no TOCTOU race).
    const rows = await internalQuery<{ guild_id: string }>(
      `INSERT INTO discord_installations (guild_id, org_id, guild_name, bot_token, bot_token_encrypted, bot_token_key_version, application_id, public_key)
       VALUES ($1, $2, $3, $4, $5, COALESCE($8, 1), $6, $7)
       ON CONFLICT (guild_id) DO UPDATE SET
         org_id = COALESCE($2, discord_installations.org_id),
         guild_name = COALESCE($3, discord_installations.guild_name),
         bot_token = COALESCE($4, discord_installations.bot_token),
         bot_token_encrypted = COALESCE($5, discord_installations.bot_token_encrypted),
         bot_token_key_version = COALESCE($8, discord_installations.bot_token_key_version),
         application_id = COALESCE($6, discord_installations.application_id),
         public_key = COALESCE($7, discord_installations.public_key),
         installed_at = now()
       WHERE discord_installations.org_id IS NULL OR discord_installations.org_id = $2
       RETURNING guild_id`,
      [guildId, orgId, guildName, botToken, botTokenEncrypted, applicationId, publicKey, botTokenKeyVersion],
    );

    if (rows.length === 0) {
      throw new Error(
        `Guild ${guildId} is already bound to a different organization. ` +
        `Disconnect the existing installation first.`,
      );
    }
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
