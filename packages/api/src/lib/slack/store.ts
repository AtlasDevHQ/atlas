/**
 * Slack installation storage — single store via `chat_cache` (#2634).
 *
 * Workspace install data lives in one place: `chat_cache` rows keyed
 * `slack:installation:<teamId>`. The chat plugin's
 * `@chat-adapter/slack` resolves per-tenant bot tokens by reading the
 * same rows — so this module is the canonical read/write path on the
 * Atlas side and the adapter agrees on the value shape transparently.
 *
 * Stored shape (in `chat_cache.value`):
 *
 *     {
 *       botToken:    string | { iv, data, tag },  // adapter contract
 *       botUserId?:  string,
 *       teamName?:   string,
 *       orgId?:      string,                       // Atlas extension
 *       workspaceName?: string,                    // Atlas extension
 *       installedAt: ISO-8601 string               // Atlas extension
 *     }
 *
 * `botToken` may be plaintext OR the chat-adapter's AES-256-GCM
 * envelope. {@link installation-encryption.encryptSlackInstallationToken}
 * picks the right form based on `SLACK_ENCRYPTION_KEY` — both Atlas
 * and the adapter read the same env var so writes and reads stay in
 * lockstep.
 *
 * Falls back to `SLACK_BOT_TOKEN` env var for single-workspace mode
 * when no internal DB is configured.
 *
 * The historical `slack_installations` Postgres table was dropped in
 * the same PR; see migration #0085. The pre-consolidation back-fill
 * script (`internal/backfill-chat-installations.ts`) is no longer
 * relevant — there's only one store to fill now.
 *
 * @see installation-encryption.ts — encrypt/decrypt helpers.
 */

import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  SlackInstallation,
  SlackInstallationWithSecret,
} from "@atlas/api/lib/integrations/types";
import {
  encryptSlackInstallationToken,
  decryptSlackInstallationToken,
  type StoredSlackBotToken,
} from "./installation-encryption";

export type {
  SlackInstallation,
  SlackInstallationWithSecret,
} from "@atlas/api/lib/integrations/types";

const log = createLogger("slack-store");

/** Sentinel team_id for env-var-based installations (no real Slack team). */
export const ENV_TEAM_ID = "env" as const;

/** Key prefix shared with `@chat-adapter/slack`. Do not change without coordinating with the adapter's `installationKeyPrefix`. */
const KEY_PREFIX = "slack:installation:" as const;

/** Build the `chat_cache.key` for a given Slack team. */
function keyFor(teamId: string): string {
  return `${KEY_PREFIX}${teamId}`;
}

/**
 * Shape persisted in `chat_cache.value`. `botToken` carries the
 * chat-adapter's expected field name so the adapter can read the same
 * row directly. The rest are Atlas extensions (chat-adapter ignores
 * unknown fields).
 */
interface StoredInstallation {
  botToken: StoredSlackBotToken;
  botUserId?: string;
  teamName?: string;
  orgId?: string | null;
  workspaceName?: string | null;
  installedAt?: string;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Parse a chat_cache row → SlackInstallationWithSecret. Returns null
 * (and logs a warning) for any structurally invalid value.
 */
function parseStoredInstallation(
  teamId: string,
  rawValue: unknown,
  installedAtRow: unknown,
): SlackInstallationWithSecret | null {
  if (!rawValue || typeof rawValue !== "object") {
    log.warn({ teamId }, "chat_cache slack installation has non-object value");
    return null;
  }
  const v = rawValue as Partial<StoredInstallation>;
  if (v.botToken === undefined || v.botToken === null) {
    log.warn({ teamId }, "chat_cache slack installation missing botToken field");
    return null;
  }
  let plaintext: string;
  try {
    plaintext = decryptSlackInstallationToken(v.botToken as StoredSlackBotToken);
  } catch (err) {
    log.error(
      { teamId, err: err instanceof Error ? err.message : String(err) },
      "Failed to decrypt chat_cache slack bot token",
    );
    return null;
  }
  // Prefer the row's persisted `installedAt` (when present), fall back
  // to the cache row's stored timestamp. A fresh `Date.now()` would
  // mask reads of legacy entries written before this field existed.
  const installedAt =
    typeof v.installedAt === "string"
      ? v.installedAt
      : typeof installedAtRow === "string"
        ? installedAtRow
        : new Date().toISOString();
  return {
    team_id: teamId,
    bot_token: plaintext,
    org_id: typeof v.orgId === "string" ? v.orgId : null,
    workspace_name:
      typeof v.workspaceName === "string"
        ? v.workspaceName
        : typeof v.teamName === "string"
          ? v.teamName
          : null,
    installed_at: installedAt,
  };
}

/**
 * Get the bot token for a team. Checks internal DB (chat_cache) first,
 * then falls back to `SLACK_BOT_TOKEN` env var.
 */
export async function getInstallation(
  teamId: string,
): Promise<SlackInstallationWithSecret | null> {
  if (hasInternalDB()) {
    try {
      const rows = await internalQuery<{
        value: unknown;
        installed_at: string | null;
      }>(
        `SELECT value, to_char((value->>'installedAt')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS installed_at
           FROM chat_cache
          WHERE key = $1
            AND (expires_at IS NULL OR expires_at > NOW())`,
        [keyFor(teamId)],
      );
      if (rows.length === 0) return null;
      return parseStoredInstallation(teamId, rows[0].value, rows[0].installed_at);
    } catch (err) {
      log.error(
        { teamId, err: err instanceof Error ? err.message : String(err) },
        "Failed to query chat_cache for Slack installation",
      );
      throw err;
    }
  }

  // Single-workspace mode: no internal DB configured, use env var.
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
 * if no internal database is configured (org-scoped lookups require a
 * DB). Backed by the partial expression index on
 * `chat_cache.value->>'orgId'` filtered by the `slack:installation:`
 * key prefix.
 */
export async function getInstallationByOrg(
  orgId: string,
): Promise<SlackInstallation | null> {
  if (!hasInternalDB()) return null;

  try {
    const rows = await internalQuery<{
      key: string;
      value: unknown;
      installed_at: string | null;
    }>(
      `SELECT key, value, to_char((value->>'installedAt')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS installed_at
         FROM chat_cache
        WHERE key LIKE $1
          AND value->>'orgId' = $2
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`,
      [`${KEY_PREFIX}%`, orgId],
    );
    if (rows.length === 0) return null;
    const teamId = rows[0].key.slice(KEY_PREFIX.length);
    const full = parseStoredInstallation(teamId, rows[0].value, rows[0].installed_at);
    if (!full) return null;
    const { bot_token: _drop, ...pub } = full;
    return pub;
  } catch (err) {
    log.error(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "Failed to query chat_cache for Slack installation by org",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Save or update a Slack installation (OAuth flow). Single atomic
 * upsert. Throws if the database write fails or if the team is
 * already bound to a different org.
 */
export async function saveInstallation(
  teamId: string,
  botToken: string,
  opts?: { orgId?: string; workspaceName?: string },
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Slack installation — no internal database configured");
  }
  const orgId = opts?.orgId ?? null;
  const workspaceName = opts?.workspaceName ?? null;

  const value: StoredInstallation = {
    botToken: encryptSlackInstallationToken(botToken),
    ...(workspaceName ? { teamName: workspaceName, workspaceName } : {}),
    ...(orgId ? { orgId } : {}),
    installedAt: new Date().toISOString(),
  };

  const pool = getInternalDB();
  // Atomic upsert with hijack protection — the WHERE clause rejects
  // a row already bound to a different org in one statement (no TOCTOU
  // race). Merges `value` so the chat-adapter's own writes (e.g.
  // `botUserId` set by a future `auth.test` round-trip) aren't clobbered.
  const result = await pool.query(
    `INSERT INTO chat_cache (key, value, expires_at)
     VALUES ($1, $2::jsonb, NULL)
     ON CONFLICT (key) DO UPDATE
       SET value = chat_cache.value || EXCLUDED.value,
           expires_at = NULL
       WHERE chat_cache.value->>'orgId' IS NULL
          OR chat_cache.value->>'orgId' = $3
     RETURNING key`,
    [keyFor(teamId), JSON.stringify(value), orgId],
  );

  if (result.rows.length === 0) {
    throw new Error(
      `Slack workspace ${teamId} is already bound to a different organization. ` +
        "Disconnect the existing installation first.",
    );
  }
}

/**
 * Remove a Slack installation by team ID. No-op (with warning) when no
 * internal DB is configured.
 */
export async function deleteInstallation(teamId: string): Promise<void> {
  if (!hasInternalDB()) {
    log.warn({ teamId }, "Cannot delete Slack installation — no internal database configured");
    return;
  }
  const pool = getInternalDB();
  await pool.query("DELETE FROM chat_cache WHERE key = $1", [keyFor(teamId)]);
}

/**
 * Remove the Slack installation for an org. Returns true if a row was
 * deleted, false if no matching row found. Throws if no internal DB
 * or if the query fails.
 */
export async function deleteInstallationByOrg(orgId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Slack installation — no internal database configured");
  }
  try {
    const pool = getInternalDB();
    const result = await pool.query(
      `DELETE FROM chat_cache
        WHERE key LIKE $1
          AND value->>'orgId' = $2
        RETURNING key`,
      [`${KEY_PREFIX}%`, orgId],
    );
    return result.rows.length > 0;
  } catch (err) {
    log.error(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "Failed to delete chat_cache Slack installation by org",
    );
    throw err;
  }
}

/** Get the bot token for a team — convenience wrapper. */
export async function getBotToken(teamId: string): Promise<string | null> {
  const installation = await getInstallation(teamId);
  return installation?.bot_token ?? null;
}
