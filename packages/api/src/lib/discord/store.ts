/**
 * Discord installation storage.
 *
 * Stores per-guild authorization records in the internal database.
 * In the platform OAuth flow, app credentials (DISCORD_CLIENT_ID, etc.) are
 * platform-level env vars. In BYOT mode, bot credentials (token, application
 * ID, public key) are stored per-guild so workspace admins can connect without
 * platform-level env vars.
 */

import { internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecret, decryptSecret, type OpaqueSecret } from "@atlas/api/lib/db/secret-encryption";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { createLogger } from "@atlas/api/lib/logger";
import type { DiscordInstallation, DiscordInstallationWithSecret } from "@atlas/api/lib/integrations/types";
import {
  PlatformInstallationStore,
  decryptOrHide,
  type InstallationBackend,
} from "@atlas/api/lib/integrations/platform-installation-store";

export type { DiscordInstallation, DiscordInstallationWithSecret } from "@atlas/api/lib/integrations/types";

const log = createLogger("discord-store");

const SELECT_COLS = "guild_id, org_id, guild_name, bot_token_encrypted, application_id, public_key, to_char(installed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS installed_at";

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
  // bot_token_encrypted stays nullable — OAuth installs leave it NULL
  // until BYOT supplies one. Three cases:
  //
  //   • encrypted column NULL/empty   → OAuth-only install. Return row
  //                                     with `bot_token: null`.
  //   • encrypted column has data,
  //     decryptSecret succeeds        → BYOT install. Return row with
  //                                     decrypted token.
  //   • encrypted column has data,
  //     decryptSecret throws          → return null for the whole row
  //                                     (matches Slack/Telegram). Letting
  //                                     `bot_token: null` flow through
  //                                     would be indistinguishable from
  //                                     a healthy OAuth-only install and
  //                                     the caller would treat the
  //                                     broken row as connected.
  const encrypted = row.bot_token_encrypted;
  let botToken: string | null = null;
  if (typeof encrypted === "string" && encrypted.length > 0) {
    // decrypt-or-hide-row: a present-but-undecryptable token hides the
    // whole row (shared policy — see platform-installation-store).
    // A NULL/empty column is the healthy OAuth-only case above and
    // keeps `bot_token: null`.
    const decrypted = decryptOrHide(encrypted, decryptSecret, (message) =>
      log.error(
        { ...context, err: message },
        "Failed to decrypt discord_installations.bot_token_encrypted — row hidden from API; F-42 audit script catches residue",
      ),
    );
    if (!decrypted.ok) return null;
    botToken = decrypted.value;
  }
  return {
    guild_id: guildIdVal,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    guild_name: typeof row.guild_name === "string" ? row.guild_name : null,
    bot_token: botToken,
    application_id: typeof row.application_id === "string" ? row.application_id : null,
    public_key: typeof row.public_key === "string" ? row.public_key : null,
    installed_at: typeof row.installed_at === "string" ? row.installed_at : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Backend adapter + seam
// ---------------------------------------------------------------------------

/** Save payload for a Discord installation (OAuth2 callback or BYOT). */
interface DiscordSaveInput {
  orgId?: string;
  guildName?: string;
  botToken?: string;
  applicationId?: string;
  publicKey?: string;
}

/**
 * The `discord_installations`-backed adapter. Owns the typed-column SQL
 * + the versioned-keyset cipher; the {@link PlatformInstallationStore}
 * seam owns the control flow and the shared invariants. The SQL is
 * carried over unchanged from the pre-seam store — notably the
 * hijack-guard (`WHERE discord_installations.org_id IS NULL OR
 * discord_installations.org_id = $2`) and the `COALESCE`-per-column
 * merge.
 */
const discordBackend: InstallationBackend<
  DiscordInstallationWithSecret,
  DiscordInstallation,
  DiscordSaveInput,
  "bot_token"
> = {
  name: "Discord",
  routingNoun: "Guild",
  // Unlike Slack, Discord's delete requires a DB — there is no
  // single-guild env-only delete path, so a missing DB is an error.
  deleteRequiresInternalDb: true,

  async selectByRouting(guildId) {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT ${SELECT_COLS} FROM discord_installations WHERE guild_id = $1`,
      [guildId],
    );
    if (rows.length === 0) return null;
    return parseInstallationRow(rows[0], { guildId });
  },

  async selectByOrg(orgId) {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT ${SELECT_COLS} FROM discord_installations WHERE org_id = $1`,
      [orgId],
    );
    if (rows.length === 0) return null;
    return parseInstallationRow(rows[0], { orgId });
  },

  async upsert(guildId, input) {
    const orgId = input.orgId ?? null;
    const guildName = input.guildName ?? null;
    const botToken = input.botToken ?? null;
    const botTokenEncrypted: OpaqueSecret | null = botToken !== null ? encryptSecret(botToken) : null;
    // Only stamp the key version when we actually wrote a ciphertext — a
    // connect call that doesn't provide a token (BYOT-less OAuth path)
    // leaves the existing column alone via COALESCE.
    const botTokenKeyVersion = botTokenEncrypted !== null ? activeKeyVersion() : null;
    const applicationId = input.applicationId ?? null;
    const publicKey = input.publicKey ?? null;

    // Atomic upsert with hijack protection — the WHERE clause rejects rows
    // bound to a different org in one statement (no TOCTOU race).
    const rows = await internalQuery<{ guild_id: string }>(
      `INSERT INTO discord_installations (guild_id, org_id, guild_name, bot_token_encrypted, bot_token_key_version, application_id, public_key)
       VALUES ($1, $2, $3, $4, COALESCE($7, 1), $5, $6)
       ON CONFLICT (guild_id) DO UPDATE SET
         org_id = COALESCE($2, discord_installations.org_id),
         guild_name = COALESCE($3, discord_installations.guild_name),
         bot_token_encrypted = COALESCE($4, discord_installations.bot_token_encrypted),
         bot_token_key_version = COALESCE($7, discord_installations.bot_token_key_version),
         application_id = COALESCE($5, discord_installations.application_id),
         public_key = COALESCE($6, discord_installations.public_key),
         installed_at = now()
       WHERE discord_installations.org_id IS NULL OR discord_installations.org_id = $2
       RETURNING guild_id`,
      [guildId, orgId, guildName, botTokenEncrypted, applicationId, publicKey, botTokenKeyVersion],
    );
    return rows.length > 0;
  },

  async deleteByRouting(guildId) {
    await internalQuery("DELETE FROM discord_installations WHERE guild_id = $1", [guildId]);
  },

  async deleteByOrg(orgId) {
    const rows = await internalQuery<{ guild_id: string }>(
      "DELETE FROM discord_installations WHERE org_id = $1 RETURNING guild_id",
      [orgId],
    );
    return rows.length > 0;
  },

  envFallback(guildId) {
    // Single-guild mode: no internal DB configured, use env var presence.
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
  },

  toPublic(full) {
    const { bot_token: _drop, ...pub } = full;
    return pub;
  },
};

const store = new PlatformInstallationStore(discordBackend, log);

// ---------------------------------------------------------------------------
// Public API — thin wrappers over the seam (signatures unchanged)
// ---------------------------------------------------------------------------

/**
 * Get the Discord installation for a guild. Checks internal DB first, then
 * falls back to env-based detection (DISCORD_CLIENT_ID set = single-guild mode).
 */
export function getDiscordInstallation(
  guildId: string,
): Promise<DiscordInstallationWithSecret | null> {
  return store.get(guildId);
}

/**
 * Get the Discord installation for an org. Returns null if not found or
 * if no internal database is configured (org-scoped lookups require a DB).
 */
export function getDiscordInstallationByOrg(
  orgId: string,
): Promise<DiscordInstallation | null> {
  return store.getByOrg(orgId);
}

/**
 * Save or update a Discord installation (OAuth2 callback or BYOT credential submission).
 * Throws if the guild is already bound to a different organization (hijack protection).
 * Throws if the database write fails.
 */
export function saveDiscordInstallation(
  guildId: string,
  opts?: { orgId?: string; guildName?: string; botToken?: string; applicationId?: string; publicKey?: string },
): Promise<void> {
  return store.save(guildId, opts ?? {});
}

/**
 * Remove a Discord installation by guild ID.
 * Throws if no internal DB or if the query fails.
 */
export function deleteDiscordInstallation(guildId: string): Promise<void> {
  return store.delete(guildId);
}

/**
 * Remove the Discord installation for an org.
 * Returns true if a row was deleted, false if no matching row found.
 * Throws if no internal DB or if the query fails.
 */
export function deleteDiscordInstallationByOrg(orgId: string): Promise<boolean> {
  return store.deleteByOrg(orgId);
}
