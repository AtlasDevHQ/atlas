/**
 * `knowledge_sync_credentials` store (#4211) — the endpoint auth secret for a
 * bundle-sync knowledge collection, encrypted at rest.
 *
 * The FIRST Knowledge Base credential (the seam ADR-0028 §5 deferred out of
 * #4206). One optional row per synced collection, keyed on
 * `(workspace_id, collection_id)`; "no auth" is "no row", never a NULL — the
 * encrypted column is NOT NULL so the table stays in
 * `NON_NULL_ENCRYPTED_TABLES` (F-42 residue audit asserts it per-row).
 *
 * Encryption is the CLAUDE.md-sanctioned pair from `db/secret-encryption.ts`
 * (versioned AES-256-GCM); the table is registered in `INTEGRATION_TABLES`
 * (`db/integration-tables.ts`) so F-47 key rotation walks it automatically.
 * Callers never see ciphertext: `saveSyncCredential` takes plaintext,
 * `readSyncCredential` returns plaintext (or null when the collection has no
 * credential).
 */

import { encryptSecret, decryptSecret, activeKeyVersion } from "@atlas/api/lib/db/secret-encryption";
import type { OpaqueSecret } from "@atlas/api/lib/db/secret-encryption";
import { internalQuery } from "@atlas/api/lib/db/internal";

/**
 * The credential upsert, keyed on the migration-0164 unique constraint.
 * Exported so the real-Postgres test executes this exact string against the
 * live schema — the drift class mock tests miss (same convention as
 * `KNOWLEDGE_INSTALL_UPSERT_SQL`).
 */
export const SYNC_CREDENTIAL_UPSERT_SQL = `INSERT INTO knowledge_sync_credentials
       (workspace_id, collection_id, auth_secret_encrypted, auth_secret_key_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (workspace_id, collection_id) DO UPDATE
       SET auth_secret_encrypted = EXCLUDED.auth_secret_encrypted,
           auth_secret_key_version = EXCLUDED.auth_secret_key_version,
           updated_at = NOW()`;

/**
 * Upsert the auth secret for one synced collection. Encrypts before the row
 * leaves this function; the key version rides along for F-47 rotation.
 */
export async function saveSyncCredential(
  workspaceId: string,
  collectionId: string,
  plaintextSecret: string,
): Promise<void> {
  const ciphertext = encryptSecret(plaintextSecret);
  await internalQuery(SYNC_CREDENTIAL_UPSERT_SQL, [
    workspaceId,
    collectionId,
    ciphertext,
    activeKeyVersion(),
  ]);
}

/**
 * Read + decrypt the auth secret for one synced collection, or null when the
 * collection has no credential (a public endpoint). A decrypt failure (rotated
 * key without re-encryption, corrupt ciphertext) THROWS — the sync must fail
 * loudly with an actionable error, never silently fetch unauthenticated
 * against a private endpoint (a 401 would mask the real misconfig).
 */
export async function readSyncCredential(
  workspaceId: string,
  collectionId: string,
): Promise<string | null> {
  const rows = await internalQuery<{ auth_secret_encrypted: string }>(
    `SELECT auth_secret_encrypted
       FROM knowledge_sync_credentials
      WHERE workspace_id = $1 AND collection_id = $2
      LIMIT 1`,
    [workspaceId, collectionId],
  );
  const stored = rows[0]?.auth_secret_encrypted;
  if (stored === undefined) return null;
  return decryptSecret(stored as OpaqueSecret);
}

/**
 * Hard-delete a collection's credential (uninstall, or an edit that switches
 * auth to `none`). Secrets never outlive their install — unlike documents,
 * which are archived, a credential row is removed outright (ADR-0028 §5's
 * "never hard-delete" applies to content, not credentials).
 */
export async function deleteSyncCredential(
  workspaceId: string,
  collectionId: string,
): Promise<void> {
  await internalQuery(
    `DELETE FROM knowledge_sync_credentials
      WHERE workspace_id = $1 AND collection_id = $2`,
    [workspaceId, collectionId],
  );
}
