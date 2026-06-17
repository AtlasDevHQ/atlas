/**
 * Operator-tier integration credential store (#3704).
 *
 * Backs the `operator_integration_credentials` table (migration 0140).
 * Stores Atlas's OWN integration app registrations — the operator/platform
 * tier — encrypted at rest, one row per platform slug. Set + rotated from
 * the Admin console without a redeploy (see `api/routes/admin-operator-integrations.ts`).
 *
 * This is deliberately a SIBLING of the workspace-tier credential store
 * (`lib/integrations/credentials/store.ts`). The two tiers must never read
 * from each other's store:
 *
 *   - Operator tier (this file) — Atlas's app registrations, operator-shared
 *     across every workspace, keyed by `platform`. Fallback source is the
 *     operator env (`SLACK_CLIENT_ID`, …) for self-host.
 *   - Workspace tier (`credentials/store.ts`) — a tenant's per-install
 *     secrets, keyed by `(workspace_id, catalog_id)`, DB-only (never env).
 *
 * The isolation is enforced structurally (no shared table, no shared
 * resolver) and pinned by `__tests__/operator-credential-isolation.test.ts`.
 * See the CLAUDE.md rule "Per-tenant plugin creds never fall back to operator
 * env vars" — this store keeps the inverse honest too.
 *
 * Encryption: the credential map (`{ <ENV_VAR_NAME>: <value>, … }`) is
 * JSON-stringified then encrypted via `encryptSecret` from
 * `db/secret-encryption.ts` (versioned AES-256-GCM). The table is registered
 * in `INTEGRATION_TABLES` so F-47 key rotation + the F-42 residue audit pick
 * it up automatically.
 *
 * @see ADR-0005 — dedicated credentials table pattern this mirrors
 * @see packages/api/src/lib/db/migrations/0140_operator_integration_credentials.sql
 */

import { z } from "zod";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  encryptSecret,
  decryptSecret,
  activeKeyVersion,
} from "@atlas/api/lib/db/secret-encryption";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("integrations.operator-credentials.store");

/**
 * Validates the decrypted bundle at the trust boundary: a string→string map.
 * `parseBundle` runs this on every read so a corrupt / hand-edited row whose
 * plaintext decrypts cleanly but isn't `{ <ENV_VAR>: <string> }` (e.g. a
 * numeric value, or a nested object) fails loudly rather than flowing
 * downstream as a mistyped value the resolver's `typeof` guards then silently
 * drop. Keeps the "decrypt/corruption fails loud, never degrade" contract.
 */
const OperatorCredentialBundleSchema: z.ZodType<Record<string, string>> = z.record(
  z.string(),
  z.string(),
);

/**
 * A decrypted operator credential bundle: a map of env-var name → value.
 * Env-var names are the keys so the resolver can overlay the decrypted
 * bundle straight onto the `process.env`-shaped object the chat adapter
 * builders already read (e.g. `{ SLACK_CLIENT_ID, SLACK_CLIENT_SECRET,
 * SLACK_SIGNING_SECRET, SLACK_ENCRYPTION_KEY }`). Values are always the
 * raw secret strings — callers mask before logging or returning to a UI.
 */
export type OperatorCredentialBundle = Readonly<Record<string, string>>;

// `type` (not `interface`) so these satisfy the `Record<string, unknown>`
// constraint on `internalQuery<T>` — interfaces don't structurally satisfy
// an index signature in TS, type aliases of object literals do.
type StoredRow = {
  credentials_encrypted: string;
  credentials_key_version: number | null;
};

type StoredMetaRow = StoredRow & {
  updated_at: string | Date;
};

/**
 * Upsert the operator credential bundle for `platform`, encrypting the
 * whole map. `created_at` (and the row `id`) are preserved on conflict so
 * F-47 rotation / audit joins by id stay stable; `updated_at` bumps on
 * every write and doubles as the Admin UI's "last rotated" timestamp.
 *
 * Empty-string values are dropped before persisting so a partially-filled
 * form never overwrites a real secret with `""` (the Admin route also
 * merges against the stored bundle, but this is the floor).
 */
export async function saveOperatorCredentials(
  platform: string,
  bundle: OperatorCredentialBundle,
): Promise<void> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(bundle)) {
    if (typeof value === "string" && value.length > 0) cleaned[key] = value;
  }

  const ciphertext = encryptSecret(JSON.stringify(cleaned));
  const keyVersion = activeKeyVersion();

  try {
    await internalQuery(
      `INSERT INTO operator_integration_credentials
         (platform, credentials_encrypted, credentials_key_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (platform) DO UPDATE
         SET credentials_encrypted   = EXCLUDED.credentials_encrypted,
             credentials_key_version = EXCLUDED.credentials_key_version,
             updated_at              = NOW()`,
      [platform, ciphertext, keyVersion],
    );
  } catch (err) {
    log.error(
      { platform, err: err instanceof Error ? err.message : String(err) },
      "Failed to upsert operator_integration_credentials row",
    );
    throw err;
  }
}

/**
 * Read + decrypt the operator credential bundle for `platform`. Returns
 * `null` when no row exists (the resolver then falls back to env).
 *
 * Throws on decrypt failure (corruption, dropped key version) — callers let
 * it propagate so the route surfaces a 500 with a `requestId` rather than
 * silently masquerading as "no operator credentials" (which would mis-route
 * the boot guard + Admin UI into "set it up" on a half-broken row).
 */
export async function readOperatorCredentials(
  platform: string,
): Promise<OperatorCredentialBundle | null> {
  const rows = await internalQuery<StoredRow>(
    `SELECT credentials_encrypted, credentials_key_version
       FROM operator_integration_credentials
      WHERE platform = $1
      LIMIT 1`,
    [platform],
  );
  if (rows.length === 0) return null;
  return parseBundle(platform, rows[0].credentials_encrypted);
}

/** Read result carrying the bundle plus the "last rotated" timestamp for the Admin UI. */
export interface OperatorCredentialRecord {
  readonly bundle: OperatorCredentialBundle;
  readonly updatedAt: Date;
}

/**
 * Like {@link readOperatorCredentials} but also returns `updated_at` for the
 * Admin "last rotated" surface. Separate function so the hot-path resolver
 * (boot guard, adapter build) doesn't pay for the extra column it ignores.
 */
export async function readOperatorCredentialRecord(
  platform: string,
): Promise<OperatorCredentialRecord | null> {
  const rows = await internalQuery<StoredMetaRow>(
    `SELECT credentials_encrypted, credentials_key_version, updated_at
       FROM operator_integration_credentials
      WHERE platform = $1
      LIMIT 1`,
    [platform],
  );
  if (rows.length === 0) return null;
  const bundle = parseBundle(platform, rows[0].credentials_encrypted);
  return { bundle, updatedAt: new Date(rows[0].updated_at) };
}

/**
 * Delete the operator credential row for `platform` (reverts to the env
 * fallback). Returns `true` if a row was removed, `false` if none existed.
 */
export async function deleteOperatorCredentials(platform: string): Promise<boolean> {
  const rows = await internalQuery<{ id: string }>(
    `DELETE FROM operator_integration_credentials
      WHERE platform = $1
      RETURNING id`,
    [platform],
  );
  return rows.length > 0;
}

function parseBundle(platform: string, ciphertext: string): OperatorCredentialBundle {
  const plaintext = decryptSecret(ciphertext);
  try {
    const parsed = JSON.parse(plaintext) as unknown;
    // Validate the shape (string→string map), not just "is an object" — a
    // mistyped value is corruption and must fail loud here, not silently get
    // dropped by a downstream `typeof` guard.
    return OperatorCredentialBundleSchema.parse(parsed);
  } catch (err) {
    // AES-GCM auth-tag verification makes "decrypted to garbage" highly
    // unlikely; a parse/shape failure on a row that decrypted cleanly is data
    // corruption (or key-version drift producing wrong-but-plausible bytes).
    log.error(
      { platform, err: err instanceof Error ? err.message : String(err) },
      "Decrypted operator_integration_credentials payload did not parse as a string→string map",
    );
    throw new Error(
      `operator_integration_credentials payload validation failed for platform=${platform}`,
      { cause: err },
    );
  }
}
