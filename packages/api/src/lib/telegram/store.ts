/**
 * Telegram installation storage.
 *
 * Stores per-bot authorization records in the internal database.
 * Unlike Discord/Teams, Telegram requires no platform-level env vars.
 * Each workspace admin enters their own bot token from @BotFather (BYOT).
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("telegram-store");

export interface TelegramInstallation {
  bot_id: string;
  bot_token: string;
  bot_username: string | null;
  org_id: string | null;
  installed_at: string;
}

// ---------------------------------------------------------------------------
// Shared row parser
// ---------------------------------------------------------------------------

/**
 * Parse a DB row into a TelegramInstallation, validating required fields.
 * Returns null and logs a warning if the row is malformed.
 */
function parseInstallationRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): TelegramInstallation | null {
  const botIdVal = row.bot_id;
  const botTokenVal = row.bot_token;
  if (typeof botIdVal !== "string" || !botIdVal || typeof botTokenVal !== "string" || !botTokenVal) {
    log.warn(context, "Invalid Telegram installation record in database");
    return null;
  }
  return {
    bot_id: botIdVal,
    bot_token: botTokenVal,
    bot_username: typeof row.bot_username === "string" ? row.bot_username : null,
    org_id: typeof row.org_id === "string" ? row.org_id : null,
    installed_at: typeof row.installed_at === "string" ? row.installed_at : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get the Telegram installation for a bot ID.
 */
export async function getTelegramInstallation(
  botId: string,
): Promise<TelegramInstallation | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      "SELECT bot_id, bot_token, bot_username, org_id, installed_at::text FROM telegram_installations WHERE bot_id = $1",
      [botId],
    );
    if (rows.length > 0) {
      return parseInstallationRow(rows[0], { botId });
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), botId },
      "Failed to query telegram_installations",
    );
    throw err;
  }
}

/**
 * Get the Telegram installation for an org. Returns null if not found or
 * if no internal database is configured (org-scoped lookups require a DB).
 */
export async function getTelegramInstallationByOrg(
  orgId: string,
): Promise<TelegramInstallation | null> {
  if (!hasInternalDB()) {
    return null;
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      "SELECT bot_id, bot_token, bot_username, org_id, installed_at::text FROM telegram_installations WHERE org_id = $1",
      [orgId],
    );
    if (rows.length > 0) {
      return parseInstallationRow(rows[0], { orgId });
    }
    return null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to query telegram_installations by org",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update a Telegram installation (bot token submission).
 * Throws if the bot is already bound to a different organization (hijack protection).
 * Throws if the database write fails.
 */
export async function saveTelegramInstallation(
  botId: string,
  opts: { orgId?: string; botUsername?: string; botToken: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Telegram installation — no internal database configured");
  }

  const orgId = opts.orgId ?? null;
  const botUsername = opts.botUsername ?? null;

  try {
    // Reject if the bot is already bound to a different org (prevents hijacking).
    const existing = await internalQuery<Record<string, unknown>>(
      "SELECT org_id FROM telegram_installations WHERE bot_id = $1",
      [botId],
    );

    if (existing.length > 0) {
      const existingOrgId = existing[0].org_id;
      if (existingOrgId && orgId && existingOrgId !== orgId) {
        throw new Error(
          `Bot ${botId} is already bound to a different organization. ` +
          `Disconnect the existing installation first.`,
        );
      }
    }

    await internalQuery(
      `INSERT INTO telegram_installations (bot_id, bot_token, bot_username, org_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (bot_id) DO UPDATE SET
         bot_token = $2,
         bot_username = COALESCE($3, telegram_installations.bot_username),
         org_id = COALESCE($4, telegram_installations.org_id),
         installed_at = now()`,
      [botId, opts.botToken, botUsername, orgId],
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), botId },
      "Failed to save telegram_installations",
    );
    throw err;
  }
}

/**
 * Remove a Telegram installation by bot ID.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteTelegramInstallation(botId: string): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Telegram installation — no internal database configured");
  }

  try {
    await internalQuery("DELETE FROM telegram_installations WHERE bot_id = $1", [botId]);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), botId },
      "Failed to delete telegram_installations",
    );
    throw err;
  }
}

/**
 * Remove the Telegram installation for an org.
 * Returns true if a row was deleted, false if no matching row found.
 * Throws if no internal DB or if the query fails.
 */
export async function deleteTelegramInstallationByOrg(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Telegram installation — no internal database configured");
  }

  try {
    const rows = await internalQuery<{ bot_id: string }>(
      "DELETE FROM telegram_installations WHERE org_id = $1 RETURNING bot_id",
      [orgId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to delete telegram_installations by org",
    );
    throw err;
  }
}
