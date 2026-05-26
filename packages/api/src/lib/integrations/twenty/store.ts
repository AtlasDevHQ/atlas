/**
 * Twenty integration storage — per-workspace credentials for the
 * Twenty CRM plugin.
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
 *
 * Multi-tenant safety: under `ATLAS_DEPLOY_MODE=saas`, the dispatch
 * path uses `findLatestTwentyDbCredentials` (single-row across all
 * workspaces) until per-row routing lands via #2849. To prevent a
 * second tenant from silently hijacking the first's dispatch, this
 * module REFUSES `saveTwentyIntegration` when the table already
 * contains a row for a DIFFERENT workspace.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import {
  encryptSecret,
  decryptSecret,
  type OpaqueSecret,
} from "@atlas/api/lib/db/secret-encryption";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { createLogger } from "@atlas/api/lib/logger";
import { TwentyDecryptError } from "@useatlas/twenty";

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

// SECURITY INVARIANT: never add `api_key_encrypted` to SELECT_PUBLIC_COLS.
// This constant feeds the admin GET endpoint AND the public envelope of
// `saveTwentyIntegration`'s RETURNING clause — both must NOT expose the
// secret. Add new public-safe columns here; if you need the secret-
// bearing column, extend SELECT_WITH_SECRET_COLS below.
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
  // Refuse malformed rows symmetrically with the workspace_id branch —
  // synthesising a "now" timestamp would echo back to the admin UI as
  // "last configured: now" for a row whose real timestamp was corrupted.
  if (typeof row.updated_at !== "string") {
    log.warn(context, "Invalid twenty_integrations row (missing updated_at)");
    return null;
  }
  return {
    workspaceId,
    baseUrl: typeof row.base_url === "string" ? row.base_url : null,
    updatedAt: row.updated_at,
  };
}

/**
 * Parse a row that SHOULD carry the decrypted apiKey.
 *
 * @throws TwentyDecryptError when `decryptSecret` fails on a row whose
 *   ciphertext is present — this is a deterministic misconfiguration
 *   (key rotation, missing key version, corrupt ciphertext) and the
 *   resolver/dispatcher must NOT silently fall back to env.
 *
 * Returns `null` for "row malformed / missing ciphertext column" —
 * structurally different from "decrypt threw on present ciphertext".
 */
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
    throw new TwentyDecryptError(
      `Failed to decrypt twenty_integrations.api_key_encrypted for ${JSON.stringify(context)} — ` +
        `check that ATLAS_ENCRYPTION_KEYS contains the key version that encrypted the row.`,
      { cause: err },
    );
  }
  return { ...pub, apiKey };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Look up the per-workspace Twenty integration row WITHOUT the
 * decrypted apiKey. Intended for an admin GET endpoint that wants to
 * render "configured" / "not configured".
 *
 * @internal Not yet consumed in production — admin UI currently
 *   surfaces install state via the catalog status endpoint.
 *   Wiring tracked in #2849 (per-workspace dispatch).
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
 * Returns `null` when no row exists OR when the row is structurally
 * malformed (missing workspace_id / updated_at / ciphertext column).
 *
 * @throws TwentyDecryptError when the row exists with ciphertext but
 *   `decryptSecret` fails — operator-visible misconfiguration.
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
    if (err instanceof TwentyDecryptError) throw err;
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
 * which has no workspace context on outbox rows today — per-row
 * routing tracked in #2849.
 *
 * The companion {@link saveTwentyIntegration} guard refuses multi-row
 * SaaS state, so on SaaS this resolves to the single configured
 * operator workspace's row.
 *
 * @throws TwentyDecryptError when the chosen row's ciphertext fails to
 *   decrypt — the caller fails closed (boot: unavailable; dispatch:
 *   dead-letter the row) rather than silently routing to env.
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
    if (err instanceof TwentyDecryptError) throw err;
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
 * Refuse multi-tenant SaaS state until #2849 lands per-row routing on
 * `crm_outbox`. Without that, the SaaS dispatcher picks the most-
 * recently-updated row across ALL workspaces — a second tenant
 * configuring Twenty would silently hijack the first's dispatch.
 *
 * Self-hosted is unaffected: this guard is keyed on
 * `ATLAS_DEPLOY_MODE=saas`. Self-hosted operators can configure as
 * many workspaces as they want.
 */
async function assertNoConflictingSaasRow(workspaceId: string): Promise<void> {
  if (process.env.ATLAS_DEPLOY_MODE !== "saas") return;
  try {
    const rows = await internalQuery<{ workspace_id: string }>(
      `SELECT workspace_id FROM twenty_integrations WHERE workspace_id <> $1 LIMIT 1`,
      [workspaceId],
    );
    if (rows.length > 0) {
      const existing = rows[0]?.workspace_id ?? "<unknown>";
      log.error(
        {
          requestedWorkspace: workspaceId,
          existingWorkspace: existing,
          event: "twenty_store.saas_multi_row_refused",
        },
        "Refusing twenty_integrations write: another workspace already has a row in SaaS mode.",
      );
      throw new Error(
        `Refusing Twenty install: ATLAS_DEPLOY_MODE=saas allows exactly one workspace to ` +
          `configure Twenty until per-row dispatch routing lands (#2849). Workspace ` +
          `'${existing}' already has a row. Either delete that row first, or wait for ` +
          `the per-workspace routing follow-up.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Refusing Twenty install")) {
      throw err;
    }
    log.error(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      "twenty_integrations SaaS multi-row guard query failed — refusing the write to fail closed",
    );
    throw err;
  }
}

/**
 * Upsert per-workspace Twenty credentials. Returns the public row
 * shape so the caller can echo `updatedAt` back to the admin UI
 * without re-querying.
 *
 * `baseUrl` is required from the form (the operator must point at
 * their own Twenty install — there is NO default baseUrl; defaulting
 * to `https://crm.useatlas.dev` would silently route a self-hosted
 * operator at Atlas's own internal CRM). The column itself is nullable
 * so a future operator-shared deploy could omit it; the form layer
 * rejects empty baseUrl up-front.
 *
 * @throws when SaaS mode already has a row for a different workspace
 *   (see {@link assertNoConflictingSaasRow}).
 */
export async function saveTwentyIntegration(
  workspaceId: string,
  opts: { apiKey: string; baseUrl: string },
): Promise<TwentyIntegrationPublic> {
  if (!hasInternalDB()) {
    throw new Error("Cannot save Twenty integration — no internal database configured");
  }
  await assertNoConflictingSaasRow(workspaceId);
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
