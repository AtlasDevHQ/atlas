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
 *       // Written by Atlas's saveInstallation:
 *       botToken:    string | { iv, data, tag },  // adapter contract
 *       teamName?:   string,
 *       orgId?:      string,                       // Atlas extension
 *       workspaceName?: string,                    // Atlas extension
 *       installedAt: ISO-8601 string               // Atlas extension
 *
 *       // Optionally merged in by the chat-adapter after auth.test:
 *       botUserId?:  string,
 *     }
 *
 * Atlas's writer never sets `botUserId`; the JSONB merge
 * (`chat_cache.value || EXCLUDED.value` in the upsert) preserves any
 * field the adapter has stamped on a previous read.
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
 * the same PR; see migration #0085. Any back-fill bandage between the
 * two stores (referenced in the #2634 issue body) is no longer
 * relevant — there's only one store to fill now.
 *
 * @see installation-encryption.ts — encrypt/decrypt helpers.
 */

import { internalQuery, getInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  SlackInstallation,
  SlackInstallationWithSecret,
} from "@atlas/api/lib/integrations/types";
import {
  PlatformInstallationStore,
  decryptOrHide,
  type InstallationBackend,
} from "@atlas/api/lib/integrations/platform-installation-store";
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

/**
 * Key prefix shared with `@chat-adapter/slack`. Do not change without
 * coordinating with the adapter's `installationKeyPrefix` AND with
 * migration `0086`'s partial expression index predicate
 * (`WHERE key LIKE 'slack:installation:%'`), which is a LITERAL in
 * both the index and the queries that hit it. A rename here without a
 * matching migration would silently bypass the index.
 */
export const KEY_PREFIX = "slack:installation:" as const;

/**
 * Chat plugin cache table. Matches the chat plugin's
 * `state.tablePrefix` default (`"chat_"`) — `chat_` + `cache` =
 * `chat_cache`. If a self-hosted deploy sets a non-default
 * `state.tablePrefix` (e.g. `myorg_` → `myorg_cache`), it MUST also
 * set `ATLAS_SLACK_INSTALL_TABLE=myorg_cache` so OAuth installs land
 * in the same physical table the chat-adapter reads from. The
 * partial expression index in migration `0086` targets `chat_cache`;
 * non-default prefixes also need their own equivalent index.
 *
 * SaaS pins the default (`chat_cache`) — no override needed.
 */
const INSTALL_TABLE = (() => {
  const raw = process.env.ATLAS_SLACK_INSTALL_TABLE;
  if (!raw) return "chat_cache";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw)) {
    throw new Error(
      `ATLAS_SLACK_INSTALL_TABLE must be a valid SQL identifier (got '${raw}')`,
    );
  }
  return raw;
})();

/**
 * JSONB field names in `chat_cache.value`. Centralised so a rename
 * propagates as a TS error to every SQL builder that references the
 * field via `${FIELD.x}` template substitution. Without this, the
 * literal `'orgId'` string was hardcoded in ~5 places — a rename
 * would silently miss any one of them.
 */
export const FIELD = {
  botToken: "botToken",
  botUserId: "botUserId",
  teamName: "teamName",
  orgId: "orgId",
  workspaceName: "workspaceName",
  installedAt: "installedAt",
} as const;

/** Build the `chat_cache.key` for a given Slack team. */
function keyFor(teamId: string): string {
  return `${KEY_PREFIX}${teamId}`;
}

/**
 * Shape persisted in `chat_cache.value`. `botToken` carries the
 * chat-adapter's expected field name so the adapter can read the same
 * row directly. The rest are Atlas extensions (chat-adapter ignores
 * unknown fields). Exported so the org-purge helper and any future
 * cross-cutting reader (e.g. SCIM dedupe) share one type.
 */
export interface StoredInstallation {
  botToken: StoredSlackBotToken;
  botUserId?: string;
  teamName?: string;
  orgId?: string | null;
  workspaceName?: string | null;
  installedAt?: string;
}

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
  // decrypt-or-hide-row: an undecryptable token hides the whole row
  // (shared policy — see platform-installation-store.decryptOrHide).
  const decrypted = decryptOrHide(
    v.botToken as StoredSlackBotToken,
    decryptSlackInstallationToken,
    (message) =>
      log.error({ teamId, err: message }, "Failed to decrypt chat_cache slack bot token"),
  );
  if (!decrypted.ok) return null;
  const plaintext = decrypted.value;
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

// ---------------------------------------------------------------------------
// Backend adapter + seam
// ---------------------------------------------------------------------------

/** Save payload for a Slack installation (OAuth flow). */
interface SlackSaveInput {
  botToken: string;
  orgId?: string;
  workspaceName?: string;
}

/**
 * The `chat_cache`-backed adapter. Owns the JSONB SQL + the
 * chat-adapter-compatible cipher; the {@link PlatformInstallationStore}
 * seam owns the control flow and the shared invariants. The SQL is
 * carried over unchanged from the pre-seam store; its exact literals are
 * load-bearing — the partial expression index and `@chat-adapter/slack`
 * interop depend on them.
 */
const slackBackend: InstallationBackend<
  SlackInstallationWithSecret,
  SlackInstallation,
  SlackSaveInput
> = {
  name: "Slack",
  routingNoun: "Slack workspace",
  // Slack's delete is best-effort without a DB — warn + no-op (a
  // single-workspace deploy has nothing to delete).
  deleteRequiresInternalDb: false,

  async selectByRouting(teamId) {
    const rows = await internalQuery<{
      value: unknown;
      installed_at: string | null;
    }>(
      `SELECT value, to_char((value->>'${FIELD.installedAt}')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS installed_at
         FROM ${INSTALL_TABLE}
        WHERE key = $1
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [keyFor(teamId)],
    );
    if (rows.length === 0) return null;
    return parseStoredInstallation(teamId, rows[0].value, rows[0].installed_at);
  },

  async selectByOrg(orgId) {
    // NOTE: the `key LIKE 'slack:installation:%'` predicate is a LITERAL
    // (not a `$1` parameter) so the planner can match it against the
    // partial expression index `idx_chat_cache_slack_org_id`'s WHERE
    // clause. A parameterized LIKE blocks the index match because
    // Postgres can't prove `$1 = 'slack:installation:%'` statically.
    // Same pattern in this backend's `deleteByOrg` and the org-purge
    // DELETE in `lib/db/internal.ts`.
    const rows = await internalQuery<{
      key: string;
      value: unknown;
      installed_at: string | null;
    }>(
      `SELECT key, value, to_char((value->>'${FIELD.installedAt}')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS installed_at
         FROM ${INSTALL_TABLE}
        WHERE key LIKE 'slack:installation:%'
          AND value->>'${FIELD.orgId}' = $1
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`,
      [orgId],
    );
    if (rows.length === 0) return null;
    const teamId = rows[0].key.slice(KEY_PREFIX.length);
    return parseStoredInstallation(teamId, rows[0].value, rows[0].installed_at);
  },

  async upsert(teamId, input) {
    const orgId = input.orgId ?? null;
    const workspaceName = input.workspaceName ?? null;

    const value: StoredInstallation = {
      botToken: encryptSlackInstallationToken(input.botToken),
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
      `INSERT INTO ${INSTALL_TABLE} (key, value, expires_at)
     VALUES ($1, $2::jsonb, NULL)
     ON CONFLICT (key) DO UPDATE
       SET value = chat_cache.value || EXCLUDED.value,
           expires_at = NULL
       WHERE chat_cache.value->>'${FIELD.orgId}' IS NULL
          OR chat_cache.value->>'${FIELD.orgId}' = $3
     RETURNING key`,
      [keyFor(teamId), JSON.stringify(value), orgId],
    );
    return result.rows.length > 0;
  },

  async deleteByRouting(teamId) {
    const pool = getInternalDB();
    await pool.query(`DELETE FROM ${INSTALL_TABLE} WHERE key = $1`, [keyFor(teamId)]);
  },

  async deleteByOrg(orgId) {
    const pool = getInternalDB();
    // Literal LIKE for partial-index match — see this backend's
    // `selectByOrg` for the planner-rationale comment.
    const result = await pool.query(
      `DELETE FROM ${INSTALL_TABLE}
        WHERE key LIKE 'slack:installation:%'
          AND value->>'${FIELD.orgId}' = $1
        RETURNING key`,
      [orgId],
    );
    return result.rows.length > 0;
  },

  envFallback(teamId) {
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
  },

  toPublic(full) {
    const { bot_token: _drop, ...pub } = full;
    return pub;
  },
};

const store = new PlatformInstallationStore(slackBackend, log);

// ---------------------------------------------------------------------------
// Public API — thin wrappers over the seam (signatures unchanged)
// ---------------------------------------------------------------------------

/**
 * Get the bot token for a team. Checks internal DB (chat_cache) first,
 * then falls back to `SLACK_BOT_TOKEN` env var.
 */
export function getInstallation(
  teamId: string,
): Promise<SlackInstallationWithSecret | null> {
  return store.get(teamId);
}

/**
 * Get the Slack installation for an org. Returns null if not found or
 * if no internal database is configured (org-scoped lookups require a
 * DB). Backed by the partial expression index on
 * `chat_cache.value->>'orgId'` filtered by the `slack:installation:`
 * key prefix.
 */
export function getInstallationByOrg(
  orgId: string,
): Promise<SlackInstallation | null> {
  return store.getByOrg(orgId);
}

/**
 * Save or update a Slack installation (OAuth flow). Single atomic
 * upsert. Throws if the database write fails or if the team is
 * already bound to a different org.
 */
export function saveInstallation(
  teamId: string,
  botToken: string,
  opts?: { orgId?: string; workspaceName?: string },
): Promise<void> {
  return store.save(teamId, {
    botToken,
    orgId: opts?.orgId,
    workspaceName: opts?.workspaceName,
  });
}

/**
 * Remove a Slack installation by team ID. No-op (with warning) when no
 * internal DB is configured.
 */
export function deleteInstallation(teamId: string): Promise<void> {
  return store.delete(teamId);
}

/**
 * Remove the Slack installation for an org. Returns true if a row was
 * deleted, false if no matching row found. Throws if no internal DB
 * or if the query fails.
 */
export function deleteInstallationByOrg(orgId: string): Promise<boolean> {
  return store.deleteByOrg(orgId);
}

/** Get the bot token for a team — convenience wrapper. */
export async function getBotToken(teamId: string): Promise<string | null> {
  const installation = await getInstallation(teamId);
  return installation?.bot_token ?? null;
}
