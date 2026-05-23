/**
 * Generic credential store backing the `integration_credentials` table
 * (#2658). Lazy OAuth integrations (Salesforce ships first; future
 * Jira / etc. ride on the same table) persist refresh-token bundles
 * here rather than embedding them in `workspace_plugins.config` JSONB.
 *
 * Why a sibling table instead of the JSONB pattern used by form-based
 * installs (#2697 — Email):
 *
 *   1. OAuth refresh tokens have an independent lifecycle (rotation on
 *      access-token expiry, "reconnect needed" surface on refresh
 *      failure). A dedicated table lets the rotation write isolate to
 *      one row + bump `updated_at` without touching the install record.
 *   2. The credential lookup is on the hot agent tool-call path. A
 *      dedicated index (`idx_integration_credentials_unique`) is
 *      cheaper than reaching into `workspace_plugins.config` JSONB.
 *   3. ADR-0003's two-store teardown order ("credentials FIRST, install
 *      record SECOND") becomes a clean DELETE in this table followed by
 *      a DELETE in `workspace_plugins` — no JSONB editing in place.
 *
 * Encryption: the full credentials object (access_token, refresh_token,
 * expires_at, instance_url, scope, token_type) is JSON-stringified then
 * encrypted via `encryptSecret` from `db/secret-encryption.ts`. Per
 * CLAUDE.md "new integration credential columns SHOULD default to
 * `db/secret-encryption.ts`" — this is *not* a URL column and doesn't
 * match any of the legacy `db/internal.ts` call sites.
 *
 * @see ADR-0003 two-store chat install metadata + credentials
 * @see packages/api/src/lib/db/migrations/0089_integration_credentials.sql
 */

import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  encryptSecret,
  decryptSecret,
  activeKeyVersion,
} from "@atlas/api/lib/db/secret-encryption";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("integrations.credentials.store");

/**
 * Decrypted credential bundle. The same shape is used for every OAuth
 * integration that writes here — additional per-Platform fields land
 * in a string-keyed extension map (`extra`) so the bundle stays generic
 * without sacrificing typed access to the common OAuth surface.
 *
 * - `accessToken` / `refreshToken` — the bearer pair the platform
 *   returns on the token exchange.
 * - `expiresAt` — milliseconds since epoch. Used by the rotation flow
 *   to decide whether the access token is still good. `null` when the
 *   platform doesn't return an `expires_in` (treated as "non-expiring"
 *   — refresh only on 401).
 * - `tokenType` — usually "Bearer" but preserved verbatim in case a
 *   future platform returns something else.
 * - `scope` — space-separated scope list from the token response.
 *   Useful for the admin UI's "this install has access to …" surface.
 * - `instanceUrl` — Salesforce-specific must-have (per-tenant API
 *   hostname like `https://na139.salesforce.com`). Generic-typed here
 *   because the store stays generic across platforms; consumers cast
 *   it on read. Empty string when the platform doesn't surface one.
 * - `extra` — per-platform extension map. Stored as part of the
 *   encrypted blob so a Salesforce-only field (e.g. `id_token`) lives
 *   alongside the rest of the bundle without a schema change.
 */
export interface CredentialBundle {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number | null;
  readonly tokenType: string;
  readonly scope: string;
  readonly instanceUrl: string;
  readonly extra?: Record<string, unknown>;
}

interface StoredRow extends Record<string, unknown> {
  credentials_encrypted: string;
  credentials_key_version: number | null;
}

/**
 * Upsert a credential bundle for (`workspaceId`, `catalogId`). On
 * conflict the row's `credentials_encrypted` + `credentials_key_version`
 * + `updated_at` are bumped; `created_at` and `id` are preserved so
 * downstream joins by id stay stable across rotations.
 *
 * `updated_at` doubles as the "last refreshed" timestamp surfaced in
 * the admin UI.
 */
export async function saveCredentialBundle(
  workspaceId: string,
  catalogId: string,
  bundle: CredentialBundle,
): Promise<void> {
  const ciphertext = encryptSecret(JSON.stringify(bundle));
  const keyVersion = activeKeyVersion();

  try {
    await internalQuery(
      `INSERT INTO integration_credentials
         (workspace_id, catalog_id, credentials_encrypted, credentials_key_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, catalog_id) DO UPDATE
         SET credentials_encrypted   = EXCLUDED.credentials_encrypted,
             credentials_key_version = EXCLUDED.credentials_key_version,
             updated_at              = NOW()`,
      [workspaceId, catalogId, ciphertext, keyVersion],
    );
  } catch (err) {
    log.error(
      { workspaceId, catalogId, err: err instanceof Error ? err.message : String(err) },
      "Failed to upsert integration_credentials row",
    );
    throw err;
  }
}

/**
 * Read and decrypt the bundle for (`workspaceId`, `catalogId`). Returns
 * `null` when no row exists. Throws on decrypt failure (corruption,
 * dropped key version) — callers should let it propagate so the route
 * surfaces a 500 with a `requestId` rather than silently returning
 * "no credential" (which would mis-route the admin UI into showing
 * "ready to install" on a half-broken install).
 */
export async function readCredentialBundle(
  workspaceId: string,
  catalogId: string,
): Promise<CredentialBundle | null> {
  const rows = await internalQuery<StoredRow>(
    `SELECT credentials_encrypted, credentials_key_version
       FROM integration_credentials
      WHERE workspace_id = $1 AND catalog_id = $2
      LIMIT 1`,
    [workspaceId, catalogId],
  );
  if (rows.length === 0) return null;
  const plaintext = decryptSecret(rows[0].credentials_encrypted);
  return JSON.parse(plaintext) as CredentialBundle;
}

/**
 * Delete the credential row for (`workspaceId`, `catalogId`). Returns
 * `true` if a row was removed, `false` if no row was present.
 *
 * Called FIRST in the two-store teardown order documented in
 * ADR-0003 — credentials must not outlive the install record. See
 * the disconnect handler in `api/routes/integrations.ts` for the
 * full sequence.
 */
export async function deleteCredentialBundle(
  workspaceId: string,
  catalogId: string,
): Promise<boolean> {
  const rows = await internalQuery<{ id: string }>(
    `DELETE FROM integration_credentials
      WHERE workspace_id = $1 AND catalog_id = $2
      RETURNING id`,
    [workspaceId, catalogId],
  );
  return rows.length > 0;
}
