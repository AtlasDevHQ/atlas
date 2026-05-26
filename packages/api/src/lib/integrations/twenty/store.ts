/**
 * Twenty integration storage — per-workspace credentials for the
 * Twenty CRM plugin (#2732 / Slice 7 of 1.6.0).
 *
 * Wraps the `twenty_integrations` table created in #2727 (migration
 * `0098_twenty_integrations.sql`). One row per workspace; the row
 * carries an encrypted `api_key_encrypted` blob plus a plaintext
 * `base_url` (hostnames aren't secret; the API key is).
 *
 * Encryption uses `db/secret-encryption.ts` per the CLAUDE.md guidance
 * for new integration credential columns. The table is listed in
 * `INTEGRATION_TABLES` so F-47 key rotation + F-42 residue audit cover
 * it automatically.
 *
 * The store sits BETWEEN the form-install handler (write) and the
 * credential resolver's `DbCredentialLookup` callback (read). The
 * separation keeps the plugin portable (`@useatlas/twenty` doesn't
 * import `@atlas/api`) — the resolver accepts a callback, this
 * module supplies the production implementation.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import {
  encryptSecret,
  decryptSecret,
  type OpaqueSecret,
} from "@atlas/api/lib/db/secret-encryption";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("twenty-store");

/**
 * Public shape — what the admin GET endpoint returns. Carries the
 * baseUrl (plaintext, operator-visible) and the row's updated_at as
 * the "last-configured" timestamp. NEVER carries the decrypted apiKey
 * — a separate getter exists for the dispatch path that needs it.
 */
export interface TwentyIntegrationPublic {
  readonly workspaceId: string;
  readonly baseUrl: string | null;
  /** ISO-8601 UTC timestamp. */
  readonly updatedAt: string;
}

/**
 * Internal shape — adds the decrypted apiKey. Reserved for the
 * credential resolver's DB-lookup path. Never logged, never returned
 * over HTTP.
 */
export interface TwentyIntegrationWithSecret extends TwentyIntegrationPublic {
  readonly apiKey: string;
}

const SELECT_PUBLIC_COLS =
  `workspace_id, base_url, ` +
  `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;

const SELECT_WITH_SECRET_COLS = `${SELECT_PUBLIC_COLS}, api_key_encrypted`;

function parsePublicRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): TwentyIntegrationPublic | null {
  const workspaceId = row.workspace_id;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    log.warn(context, "Invalid twenty_integrations row (missing workspace_id)");
    return null;
  }
  return {
    workspaceId,
    baseUrl: typeof row.base_url === "string" ? row.base_url : null,
    updatedAt:
      typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
  };
}

function parseSecretRow(
  row: Record<string, unknown>,
  context: Record<string, unknown>,
): TwentyIntegrationWithSecret | null {
  const pub = parsePublicRow(row, context);
  if (!pub) return null;
  const encrypted = row.api_key_encrypted;
  if (typeof encrypted !== "string" || encrypted.length === 0) {
    log.warn(context, "Invalid twenty_integrations row (missing api_key_encrypted)");
    return null;
  }
  let apiKey: string;
  try {
    apiKey = decryptSecret(encrypted);
  } catch (err) {
    log.error(
      { ...context, err: err instanceof Error ? err.message : String(err) },
      "Failed to decrypt twenty_integrations.api_key_encrypted",
    );
    return null;
  }
  return { ...pub, apiKey };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Look up the per-workspace Twenty integration row WITHOUT the
 * decrypted apiKey. Used by the admin GET endpoint to render
 * "configured" / "not configured".
 */
export async function getTwentyIntegrationPublic(
  workspaceId: string,
): Promise<TwentyIntegrationPublic | null> {
  if (!hasInternalDB()) return null;
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT ${SELECT_PUBLIC_COLS} FROM twenty_integrations WHERE workspace_id = $1`,
      [workspaceId],
    );
    if (rows.length === 0) return null;
    return parsePublicRow(rows[0], { workspaceId });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      "Failed to query twenty_integrations (public)",
    );
    throw err;
  }
}

/**
 * Look up the per-workspace Twenty integration row WITH the decrypted
 * apiKey. Used by `TwentyCredentialResolver`'s DB-lookup callback.
 *
 * Returns `null` on missing row, malformed row, or decrypt failure —
 * the resolver swallows the absence and falls back to env, so we never
 * surface a partial-success here.
 */
export async function getTwentyIntegrationWithSecret(
  workspaceId: string,
): Promise<TwentyIntegrationWithSecret | null> {
  if (!hasInternalDB()) return null;
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT ${SELECT_WITH_SECRET_COLS} FROM twenty_integrations WHERE workspace_id = $1`,
      [workspaceId],
    );
    if (rows.length === 0) return null;
    return parseSecretRow(rows[0], { workspaceId });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      "Failed to query twenty_integrations (with secret)",
    );
    throw err;
  }
}

/**
 * Pick the most-recently-updated `twenty_integrations` row across
 * every workspace, decrypted. Used by the SaaS demo-dispatch path,
 * which has no workspace context on outbox rows today (#2732 / Slice 7
 * of 1.6.0 ships the per-workspace credential table; per-row workspace
 * routing on `crm_outbox` is a follow-up when multi-tenant Twenty
 * dispatch lands).
 *
 * Returns `null` when no row exists OR when the chosen row's
 * ciphertext fails to decrypt. The caller falls back to env in either
 * case.
 *
 * "Latest" is deterministic: `ORDER BY updated_at DESC LIMIT 1`. For
 * the SaaS Atlas deployment, exactly one operator workspace configures
 * Twenty, so the "latest" semantic collapses to "the operator's row."
 * For self-hosted with one workspace, same outcome. The multi-tenant
 * branch (many workspaces, many rows) requires workspace_id on
 * crm_outbox and is intentionally out of scope here.
 */
export async function findLatestTwentyDbCredentials(): Promise<
  TwentyIntegrationWithSecret | null
> {
  if (!hasInternalDB()) return null;
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT ${SELECT_WITH_SECRET_COLS}
       FROM twenty_integrations
       ORDER BY updated_at DESC
       LIMIT 1`,
    );
    if (rows.length === 0) return null;
    return parseSecretRow(rows[0], { latest: true });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to query twenty_integrations (latest)",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Upsert per-workspace Twenty credentials. Returns the public row
 * shape so the caller can echo `updatedAt` back to the admin UI
 * without re-querying.
 *
 * `baseUrl` is required from the form (the operator must point at
 * their own Twenty install — there is NO default baseUrl, per the
 * "no Atlas-SaaS leak in defaults" rule in #2732). The column itself
 * is nullable so a future operator-shared deploy could omit it; the
 * form layer rejects empty baseUrl up-front.
 */
export async function saveTwentyIntegration(
  workspaceId: string,
  opts: { apiKey: string; baseUrl: string },
): Promise<TwentyIntegrationPublic> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Twenty integration — no internal database configured");
  }
  const apiKeyEncrypted: OpaqueSecret = encryptSecret(opts.apiKey);
  const keyVersion = activeKeyVersion();
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `INSERT INTO twenty_integrations
         (workspace_id, base_url, api_key_encrypted, api_key_key_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id) DO UPDATE SET
         base_url = EXCLUDED.base_url,
         api_key_encrypted = EXCLUDED.api_key_encrypted,
         api_key_key_version = EXCLUDED.api_key_key_version,
         updated_at = now()
       RETURNING ${SELECT_PUBLIC_COLS}`,
      [workspaceId, opts.baseUrl, apiKeyEncrypted, keyVersion],
    );
    const parsed = rows[0] ? parsePublicRow(rows[0], { workspaceId }) : null;
    if (!parsed) {
      // RETURNING came back empty / malformed — synthesise a public
      // row from what we know so the caller doesn't have to re-query.
      return {
        workspaceId,
        baseUrl: opts.baseUrl,
        updatedAt: new Date().toISOString(),
      };
    }
    return parsed;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      "Failed to save twenty_integrations",
    );
    throw err;
  }
}

/**
 * Delete the per-workspace Twenty integration row. Returns `true` if
 * a row was removed, `false` if no matching row existed (idempotent
 * delete from the caller's perspective).
 *
 * After delete, the resolver falls back to `TWENTY_API_KEY` env.
 */
export async function deleteTwentyIntegration(workspaceId: string): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Cannot delete Twenty integration — no internal database configured");
  }
  try {
    const rows = await internalQuery<{ workspace_id: string }>(
      `DELETE FROM twenty_integrations WHERE workspace_id = $1 RETURNING workspace_id`,
      [workspaceId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      "Failed to delete twenty_integrations",
    );
    throw err;
  }
}
