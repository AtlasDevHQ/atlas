/**
 * Workspace-tier action-target credential store (#3766).
 *
 * Backs the `workspace_action_credentials` table (migration 0213). Stores a
 * TENANT's own credentials for an action target — their Jira, their Linear —
 * encrypted at rest, one row per `(workspace_id, target)`. Set from the
 * workspace Admin surface without operator involvement or a redeploy.
 *
 * This is deliberately a SIBLING of the operator-tier store
 * (`lib/integrations/operator-credentials/store.ts`), and the two tiers must
 * never read from each other's table:
 *
 *   - Operator tier — Atlas's OWN app registrations, operator-shared across
 *     every workspace, keyed by `platform`. Env is its self-host fallback.
 *   - Workspace tier (this file) — a tenant's own external system, keyed by
 *     `(workspace_id, target)`. Env is a fallback ONLY on self-hosted, where
 *     the operator owns both the deploy env and the only workspace.
 *
 * There is no operator rung for action targets at all: a "platform default
 * Jira" serving several tenants is exactly the multi-tenant confusion #3766
 * exists to eliminate. The isolation is structural (no shared table, no
 * shared resolver) and pinned by
 * `__tests__/action-credential-isolation.test.ts`.
 *
 * Encryption: the credential map (`{ <ENV_VAR_NAME>: <value>, … }`) is
 * JSON-stringified then encrypted via `encryptSecret` from
 * `db/secret-encryption.ts` (versioned AES-256-GCM). The table is registered
 * in `INTEGRATION_TABLES` so F-47 key rotation + the F-42 residue audit pick
 * it up automatically.
 *
 * @see ADR-0046 — per-workspace action credentials
 * @see packages/api/src/lib/db/migrations/0213_workspace_action_credentials.sql
 */

import { z } from "zod";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  encryptSecret,
  decryptSecret,
  activeKeyVersion,
} from "@atlas/api/lib/db/secret-encryption";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("actions.credentials.store");

/**
 * Validates the decrypted bundle at the trust boundary: a string→string map.
 * `parseBundle` runs this on every read so a corrupt / hand-edited row whose
 * plaintext decrypts cleanly but isn't `{ <ENV_VAR>: <string> }` fails loudly
 * rather than flowing downstream as a mistyped value the resolver's `typeof`
 * guards then silently drop. Keeps the "decrypt/corruption fails loud, never
 * degrade" contract — degrading here would mean falling through to the
 * self-host env rung and firing a tenant's action at the operator's Jira.
 */
const ActionCredentialBundleSchema: z.ZodType<Record<string, string>> = z.record(
  z.string(),
  z.string(),
);

/**
 * A decrypted workspace action credential bundle: a map of env-var name →
 * value. Env-var names are the keys so one {@link ActionCredentialField} spec
 * reads both the DB rung and the self-host env rung, with no per-target
 * mapping table. Values are always raw secret strings — callers mask before
 * logging or returning to a UI.
 */
export type ActionCredentialBundle = Readonly<Record<string, string>>;

// `type` (not `interface`) so these satisfy the `Record<string, unknown>`
// constraint on `internalQuery<T>` — interfaces don't structurally satisfy an
// index signature in TS, type aliases of object literals do.
type StoredRow = {
  credentials_encrypted: string;
  credentials_key_version: number | null;
};

/**
 * Upsert the credential bundle for (`workspaceId`, `target`), encrypting the
 * whole map. `created_at` (and the row `id`) are preserved on conflict so F-47
 * rotation / audit joins by id stay stable; `updated_at` bumps on every write
 * and doubles as the Admin UI's "last updated" timestamp.
 *
 * Empty-string values are dropped before persisting so a partially-filled form
 * never overwrites a real secret with `""` (the Admin route also merges
 * against the stored bundle, but this is the floor).
 */
export async function saveActionCredentials(
  workspaceId: string,
  target: string,
  bundle: ActionCredentialBundle,
): Promise<void> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(bundle)) {
    if (typeof value === "string" && value.length > 0) cleaned[key] = value;
  }

  const ciphertext = encryptSecret(JSON.stringify(cleaned));
  const keyVersion = activeKeyVersion();

  try {
    await internalQuery(
      `INSERT INTO workspace_action_credentials
         (workspace_id, target, credentials_encrypted, credentials_key_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, target) DO UPDATE
         SET credentials_encrypted   = EXCLUDED.credentials_encrypted,
             credentials_key_version = EXCLUDED.credentials_key_version,
             updated_at              = NOW()`,
      [workspaceId, target, ciphertext, keyVersion],
    );
  } catch (err) {
    log.error(
      { workspaceId, target, err: err instanceof Error ? err.message : String(err) },
      "Failed to upsert workspace_action_credentials row",
    );
    throw err;
  }
}

/**
 * Read + decrypt the bundle for (`workspaceId`, `target`). Returns `null` when
 * no row exists — the resolver then falls through to the self-host env rung,
 * or throws on SaaS.
 *
 * Throws on decrypt failure (corruption, dropped key version) — callers let it
 * propagate. A decrypt failure must NOT masquerade as "no workspace row",
 * because that would silently drop a tenant onto the operator's env-configured
 * target (ADR-0046).
 */
export async function readActionCredentials(
  workspaceId: string,
  target: string,
): Promise<ActionCredentialBundle | null> {
  const rows = await internalQuery<StoredRow>(
    `SELECT credentials_encrypted, credentials_key_version
       FROM workspace_action_credentials
      WHERE workspace_id = $1 AND target = $2
      LIMIT 1`,
    [workspaceId, target],
  );
  if (rows.length === 0) return null;
  return parseBundle(workspaceId, target, rows[0].credentials_encrypted);
}

/**
 * Delete the credential row for (`workspaceId`, `target`). Returns `true` if a
 * row was removed, `false` if none existed. On self-hosted this reverts to the
 * env fallback; on SaaS it leaves the target unconfigured for that workspace.
 */
export async function deleteActionCredentials(
  workspaceId: string,
  target: string,
): Promise<boolean> {
  const rows = await internalQuery<{ id: string }>(
    `DELETE FROM workspace_action_credentials
      WHERE workspace_id = $1 AND target = $2
      RETURNING id`,
    [workspaceId, target],
  );
  return rows.length > 0;
}

function parseBundle(
  workspaceId: string,
  target: string,
  ciphertext: string,
): ActionCredentialBundle {
  const plaintext = decryptSecret(ciphertext);
  // The JSON parse and the SHAPE validation are split into two catches on
  // purpose, because only one of them can echo a secret (#4984).
  //
  // `JSON.parse`'s error message embeds its input — `JSON.parse("s3cr3t")`
  // throws `JSON Parse error: Unexpected identifier "s3cr3t"` — and the input
  // here is the DECRYPTED tenant bundle. So this arm logs the workspace and
  // target and nothing derived from the plaintext, and omits `cause` rather
  // than trusting that no current log serializer or 500 renderer walks a cause
  // chain.
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    log.error(
      { workspaceId, target },
      "Decrypted workspace_action_credentials payload did not parse as JSON — the row is corrupt; re-save this target's credentials from workspace Admin to repair it",
    );
    throw new Error(
      `workspace_action_credentials JSON.parse failed for target=${target}`,
    );
  }
  try {
    // Validate the shape (string→string map), not just "is an object" — a
    // mistyped value is corruption and must fail loud here, not silently get
    // dropped by a downstream `typeof` guard and demote the row to "absent".
    return ActionCredentialBundleSchema.parse(parsed);
  } catch (err) {
    // This arm CAN keep a diagnostic, because the schema is
    // `z.record(z.string(), z.string())`: a Zod issue on it carries the PATH
    // (the env-var name, which is not a secret) and an `invalid_type` code
    // naming the received TYPE — never the received value. The issue list is
    // lifted explicitly rather than logging `err.message`, so that stays true
    // if the schema later grows a refinement whose message would echo a value.
    const issues =
      err instanceof z.ZodError
        ? err.issues.map((i) => ({ path: i.path.join("."), code: i.code }))
        : undefined;
    log.error(
      { workspaceId, target, issues },
      "Decrypted workspace_action_credentials payload is not a string→string map",
    );
    throw new Error(
      `workspace_action_credentials payload validation failed for target=${target}`,
    );
  }
}
