/**
 * Installed-datasource load + secret-config decrypt seam (#4194).
 *
 * "Load an installed datasource row and decrypt its secret config" used to
 * have hand-written answers in five route handlers across
 * `admin-connections.ts`, `admin-marketplace.ts`, `admin-plugins.ts`,
 * `admin.ts`, and `mode.ts`. Each site paired `parseConfigSchema` +
 * `decryptSecretFields`, re-derived its own decrypt-failed → 500 mapping,
 * and restated the `pillar = 'datasource'` / `status != 'archived'`
 * predicates. This module is the single statement of that logic:
 *
 * - {@link loadInstalledConnection} / {@link listInstalledConnections} own
 *   the `workspace_plugins ⋈ plugin_catalog` JOIN, the pillar/status
 *   predicates, schema parsing, and decryption — returning a typed struct
 *   whose `config` is a discriminated union so a row-found-but-unreadable
 *   install can never be confused with a healthy one.
 * - {@link decryptStoredConfig} is the one place a stored config blob is
 *   decrypted on behalf of a route: failures are logged (scrubbed) and
 *   re-thrown as {@link InstalledConfigDecryptError} so routes classify
 *   with `instanceof`, never by string-matching error messages.
 * - {@link applyConfigEdit} encodes the read-modify-write ordering for
 *   config PUTs (decrypt → restore-masked → encrypt → mask) that
 *   previously lived as a comment in `admin-marketplace.ts`: the persisted
 *   blob is always freshly encrypted from plaintext (never a ciphertext
 *   round-trip) and the echoed blob is always masked (never plaintext).
 * - {@link isDemoInstallActive} / {@link demoInstallActiveSql} state the
 *   per-workspace demo-install probe once for `admin.ts` + `mode.ts`.
 *
 * Lives in `lib/` (not `api/routes/`) per the layering rule: routes call
 * down into this module; it must never import from the route layer.
 */

import { internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  parseConfigSchema,
  decryptSecretFields,
  encryptSecretFields,
  maskSecretFields,
  restoreMaskedSecrets,
  type ConfigSchema,
} from "@atlas/api/lib/plugins/secrets";

const log = createLogger("integrations:installed-connection");

/** Content-mode status domain for `workspace_plugins.status`. */
export type InstallStatus = "draft" | "published" | "archived";

/** The per-workspace demo install's reserved connection id. */
export const DEMO_INSTALL_ID = "__demo__";

/** The demo datasource's catalog slug. */
export const DEMO_CATALOG_SLUG = "demo-postgres";

/**
 * Thrown when a stored `secret: true` config field cannot be decrypted
 * (typically an encryption-key rotation or a corrupted ciphertext blob).
 * Routes classify with `instanceof` and map to a 500 — the message is
 * already scrubbed via `errorMessage()` so it is safe to log or attach to
 * audit metadata, but it should still never be echoed to the client
 * verbatim (clients get the route's fixed actionable message + requestId).
 */
export class InstalledConfigDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InstalledConfigDecryptError";
  }
}

/**
 * Decrypt a stored config blob, classifying failure as
 * {@link InstalledConfigDecryptError}. The single decrypt-failure seam for
 * route handlers: logs once (with the caller's correlation fields, message
 * scrubbed) and throws the typed error so the route's only job is mapping
 * `instanceof` → its response envelope. Success returns the decrypted
 * plaintext config — callers must never echo it to a client unmasked.
 */
export function decryptStoredConfig(
  config: unknown,
  schema: ConfigSchema,
  logContext: Record<string, unknown> = {},
): Record<string, unknown> {
  try {
    return decryptSecretFields(config, schema);
  } catch (err) {
    const reason = errorMessage(err);
    log.error(
      {
        ...logContext,
        err: err instanceof Error ? err : new Error(String(err)),
        scrubbed: reason,
      },
      "Failed to decrypt stored config secrets",
    );
    throw new InstalledConfigDecryptError(reason, { cause: err });
  }
}

/**
 * Decrypt outcome for a loaded install row. A discriminated union rather
 * than a throw so list loads degrade per-row and detail loads can render
 * row metadata (managed/groupId) even when the credential blob is
 * unreadable — matching the GET-detail behavior that predates this seam.
 */
/**
 * Config outcome when the caller requested decryption (the default). Either
 * the decrypted plaintext or the per-row decrypt failure — never `not_loaded`.
 */
export type LoadedConnectionConfig =
  | { readonly state: "decrypted"; readonly values: Record<string, unknown> }
  | { readonly state: "decrypt_failed"; readonly reason: string };

/**
 * Config placeholder when the caller opted out of decryption
 * (`decryptConfig: false`) because it only reads row metadata (status /
 * catalogSlug / groupId). The stored ciphertext is never touched, so an
 * un-decryptable row on a config-agnostic path (list decoration, delete,
 * create-conflict check) produces no spurious decrypt-failure log. Reading
 * `config` still forces the caller through the discriminated union, so a
 * metadata-only load can never silently hand back a blank credential.
 */
export type UnloadedConnectionConfig = { readonly state: "not_loaded" };

export type InstalledConnectionConfig = LoadedConnectionConfig | UnloadedConnectionConfig;

/** Typed result of the `workspace_plugins ⋈ plugin_catalog` datasource load. */
export interface InstalledConnection<
  C extends InstalledConnectionConfig = InstalledConnectionConfig,
> {
  /** `workspace_plugins.id` — the row PK (marketplace routes key on this). */
  readonly rowId: string;
  /** `workspace_plugins.catalog_id` — FK into `plugin_catalog`. */
  readonly catalogId: string;
  /** `plugin_catalog.slug` — routes installer calls + dbType derivation. */
  readonly catalogSlug: string;
  /** `workspace_plugins.install_id` — the user-facing connection id. */
  readonly installId: string;
  /** Content-mode status of the install row. */
  readonly status: InstallStatus;
  /** `config->>'group_id'` — the environment/group binding, if any. */
  readonly groupId: string | null;
  /** Parsed catalog `config_schema` (three-state; drives the secret walkers). */
  readonly configSchema: ConfigSchema;
  /** Decrypted config, the per-row decrypt failure, or `not_loaded`. */
  readonly config: C;
}

interface InstalledConnectionRow extends Record<string, unknown> {
  readonly id: string;
  readonly catalog_id: string;
  readonly catalog_slug: string;
  readonly install_id: string;
  readonly status: InstallStatus;
  readonly group_id: string | null;
  readonly config: Record<string, unknown> | null;
  readonly config_schema: unknown;
}

/**
 * Single statement of the datasource-install SELECT — JOIN, projection,
 * and the `pillar = 'datasource'` / `status != 'archived'` predicates that
 * previously drifted per call site.
 */
function installedConnectionSql(where: string): string {
  return `SELECT wp.id,
          wp.catalog_id,
          pc.slug AS catalog_slug,
          wp.install_id,
          wp.status,
          wp.config->>'group_id' AS group_id,
          wp.config,
          pc.config_schema
     FROM workspace_plugins wp
     JOIN plugin_catalog pc ON pc.id = wp.catalog_id
    WHERE wp.workspace_id = $1
      AND wp.pillar = 'datasource'
      ${where}`;
}

/**
 * Map a raw row to the typed struct. Decrypts per-row (never throws) unless
 * `decrypt` is false, in which case the ciphertext is left untouched and
 * `config.state` is `not_loaded` — a config-agnostic caller thus emits no
 * decrypt-failure log for an un-decryptable row it was never going to read.
 */
function toInstalledConnection(
  row: InstalledConnectionRow,
  workspaceId: string,
  decrypt: boolean,
): InstalledConnection {
  const configSchema = parseConfigSchema(row.config_schema);
  let config: InstalledConnectionConfig;
  if (!decrypt) {
    config = { state: "not_loaded" };
  } else {
    try {
      config = {
        state: "decrypted",
        values: decryptStoredConfig(row.config ?? {}, configSchema, {
          workspaceId,
          installId: row.install_id,
          catalogSlug: row.catalog_slug,
        }),
      };
    } catch (err) {
      if (!(err instanceof InstalledConfigDecryptError)) throw err;
      // Already logged (scrubbed) by decryptStoredConfig — carry the reason so
      // callers can attach it to audit metadata without re-deriving.
      config = { state: "decrypt_failed", reason: err.message };
    }
  }
  return {
    rowId: row.id,
    catalogId: row.catalog_id,
    catalogSlug: row.catalog_slug,
    installId: row.install_id,
    status: row.status,
    groupId: row.group_id,
    configSchema,
    config,
  };
}

export interface LoadInstalledConnectionOptions {
  /**
   * Include `status = 'archived'` rows. Default false — archived installs
   * read as "not found" so soft-deleted rows never blank-decrypt into a
   * 500. DELETE/revive flows opt in to see the archived row.
   */
  readonly includeArchived?: boolean;
  /**
   * Decrypt the stored config. Default true. Set false on config-agnostic
   * paths (delete, create-conflict check, list decoration) that read only
   * row metadata — the ciphertext is then never walked, so an
   * un-decryptable row emits no spurious decrypt-failure log and `config`
   * arrives as `{ state: "not_loaded" }`.
   */
  readonly decryptConfig?: boolean;
}

/**
 * Load one installed datasource connection for a workspace by its
 * user-facing `install_id`. Returns `null` when no matching row exists.
 * A decrypt failure does NOT throw — it surfaces as
 * `config.state === "decrypt_failed"` so callers choose their mapping
 * (PUT → 500 `decryption_failed`; GET detail → degraded masked placeholder).
 * DB-level failures (pool down, missing table) propagate to the caller.
 */
export function loadInstalledConnection(
  workspaceId: string,
  installId: string,
  opts?: LoadInstalledConnectionOptions & { decryptConfig?: true },
): Promise<InstalledConnection<LoadedConnectionConfig> | null>;
export function loadInstalledConnection(
  workspaceId: string,
  installId: string,
  opts: LoadInstalledConnectionOptions & { decryptConfig: false },
): Promise<InstalledConnection<UnloadedConnectionConfig> | null>;
export async function loadInstalledConnection(
  workspaceId: string,
  installId: string,
  opts: LoadInstalledConnectionOptions = {},
): Promise<InstalledConnection | null> {
  const rows = await internalQuery<InstalledConnectionRow>(
    installedConnectionSql(
      `AND wp.install_id = $2
      ${opts.includeArchived ? "" : "AND wp.status != 'archived'"}
      LIMIT 1`,
    ),
    [workspaceId, installId],
  );
  if (rows.length === 0) return null;
  return toInstalledConnection(rows[0], workspaceId, opts.decryptConfig !== false);
}

export interface ListInstalledConnectionsOptions extends LoadInstalledConnectionOptions {
  /** Restrict to these `install_id`s (e.g. the visibility-filtered set). */
  readonly installIds?: readonly string[];
}

/**
 * Org-list variant of {@link loadInstalledConnection}: every installed
 * datasource connection for a workspace (optionally narrowed to a set of
 * install ids). Per-row decrypt failures degrade to
 * `config.state === "decrypt_failed"` — one unreadable credential never
 * hides the rest of the list.
 */
export async function listInstalledConnections(
  workspaceId: string,
  opts: ListInstalledConnectionsOptions = {},
): Promise<InstalledConnection[]> {
  const params: unknown[] = [workspaceId];
  let where = opts.includeArchived ? "" : "AND wp.status != 'archived'";
  if (opts.installIds !== undefined) {
    params.push([...opts.installIds]);
    where += `\n      AND wp.install_id = ANY($2::text[])`;
  }
  const rows = await internalQuery<InstalledConnectionRow>(
    installedConnectionSql(`${where}\n    ORDER BY wp.install_id ASC`),
    params,
  );
  const decrypt = opts.decryptConfig !== false;
  return rows.map((row) => toInstalledConnection(row, workspaceId, decrypt));
}

/**
 * Count non-archived datasource installs for a workspace — the plan-limit
 * billing counter. Must stay predicate-identical to the load above so the
 * "billable" signal and the enforcement count can never drift (#2490).
 */
export async function countActiveDatasourceInstalls(workspaceId: string): Promise<number> {
  const rows = await internalQuery<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM workspace_plugins wp
      WHERE wp.workspace_id = $1
        AND wp.pillar = 'datasource'
        AND wp.status != 'archived'`,
    [workspaceId],
  );
  return rows[0]?.count ?? 0;
}

/**
 * True when at least one datasource install in this workspace claims
 * `config->>'group_id' = groupId`. Post-ADR-0007 a "group" is just a
 * string referenced by N install rows, so existence == "some row claims
 * it". Shared by the POST-create and PUT-update cross-checks.
 */
export async function datasourceGroupExists(
  workspaceId: string,
  groupId: string,
): Promise<boolean> {
  const rows = await internalQuery<{ install_id: string }>(
    `SELECT wp.install_id FROM workspace_plugins wp
      WHERE wp.workspace_id = $1
        AND wp.pillar = 'datasource'
        AND wp.config->>'group_id' = $2
      LIMIT 1`,
    [workspaceId, groupId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Read-modify-write config edits
// ---------------------------------------------------------------------------

/** Result of {@link applyConfigEdit} — what to persist vs what to echo. */
export interface ConfigEditResult {
  /**
   * The blob to write to `workspace_plugins.config` (the marketplace
   * config PUT's persistence target): masked placeholders restored to
   * their stored plaintext, then every `secret: true` field freshly
   * encrypted (fresh IV — never a ciphertext round-trip of the previous
   * blob).
   */
  readonly persistConfig: Record<string, unknown>;
  /**
   * The blob to echo to the client: same restored plaintext with every
   * `secret: true` field replaced by the mask placeholder. Plaintext
   * secrets and ciphertext both never leave the server.
   */
  readonly responseConfig: Record<string, unknown>;
}

/**
 * Encode the config-PUT read-modify-write ordering as code (previously a
 * comment in `admin-marketplace.ts`):
 *
 *   1. caller decrypts the stored blob → `existing` (plaintext) —
 *      see {@link decryptStoredConfig};
 *   2. restore: any `MASKED_PLACEHOLDER` echoed back by the admin UI (and
 *      any secret field the UI omitted entirely) is replaced from
 *      `existing`, so an unedited secret round-trips its real value
 *      instead of persisting the bullet sentinel or wiping the credential;
 *   3. encrypt: the restored plaintext is re-encrypted for persistence —
 *      decrypt-then-reencrypt refreshes the IV for every preserved secret
 *      (idempotent-on-ciphertext would keep the old IV);
 *   4. mask: the response echo is masked so the client never sees
 *      plaintext secrets or ciphertext.
 *
 * `existing` and `incoming` are plaintext-side inputs; both outputs are
 * derived from the same restored object so persist and echo can't drift.
 */
export function applyConfigEdit(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  schema: ConfigSchema,
): ConfigEditResult {
  const restored = restoreMaskedSecrets(incoming, existing, schema);
  return {
    persistConfig: encryptSecretFields(restored, schema),
    // `maskSecretFields` only returns null for a null input; `restored` is
    // always an object here.
    responseConfig: maskSecretFields(restored, schema) ?? {},
  };
}

// ---------------------------------------------------------------------------
// Demo-install probe
// ---------------------------------------------------------------------------

/**
 * SQL for "this workspace's demo install is active" — post-0096 cutover
 * every workspace owns its own per-workspace `demo-postgres` row
 * (`install_id='__demo__'`), archived per-workspace to hide, so "active"
 * is "the row exists in one of `statuses`". `$1` = workspace id; returns
 * one row `{ active: boolean }`. Exposed as SQL (not just the promise
 * helper below) so Effect routes can run it through `queryEffect`.
 */
export function demoInstallActiveSql(
  statuses: readonly Exclude<InstallStatus, "archived">[],
): string {
  if (statuses.length === 0) {
    throw new Error("demoInstallActiveSql requires at least one status");
  }
  // Belt-and-braces: statuses is a closed compile-time union, but the
  // literals are interpolated into SQL, so re-validate at runtime.
  for (const status of statuses) {
    if (status !== "published" && status !== "draft") {
      throw new Error(`demoInstallActiveSql: invalid status "${String(status)}"`);
    }
  }
  const statusList = statuses.map((s) => `'${s}'`).join(", ");
  return `
  SELECT EXISTS (
    SELECT 1 FROM workspace_plugins wp
      JOIN plugin_catalog pc ON pc.id = wp.catalog_id
     WHERE wp.workspace_id = $1
       AND wp.pillar = 'datasource'
       AND wp.install_id = '${DEMO_INSTALL_ID}'
       AND pc.slug = '${DEMO_CATALOG_SLUG}'
       AND wp.status IN (${statusList})
  ) AS active
`;
}

/**
 * Promise flavor of {@link demoInstallActiveSql} for non-Effect callers.
 * DB failures propagate — callers decide whether a probe failure fails
 * open or closed for their flow.
 */
export async function isDemoInstallActive(
  workspaceId: string,
  statuses: readonly Exclude<InstallStatus, "archived">[],
): Promise<boolean> {
  const rows = await internalQuery<{ active: boolean }>(
    demoInstallActiveSql(statuses),
    [workspaceId],
  );
  return rows[0]?.active === true;
}
