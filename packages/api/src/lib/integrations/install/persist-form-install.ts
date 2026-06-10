/**
 * `persistFormInstall` — the shared persistence spine for every
 * single-instance (chat/action-pillar) {@link FormBasedInstallHandler}.
 *
 * Email / Webhook / Obsidian / Linear API-key / GitHub PAT / Twenty all
 * repeated the same sequence after their per-Platform Zod parse: SaaS
 * keyset gate → `encryptSecretFields` → `workspace_plugins` upsert →
 * returned-id invariant check → optional lazy-loader evict. Five-plus
 * copies of that spine meant five places for the Workspace Install
 * write path to be wrong — and three of them WERE wrong: the Email /
 * Webhook / Obsidian copies still carried the pre-0092 INSERT shape
 * (no `install_id` / `pillar`, bare `ON CONFLICT (workspace_id,
 * catalog_id)`), which fails against the post-0096 schema with 42P10
 * ("no unique or exclusion constraint matching the ON CONFLICT
 * specification") because 0096 dropped both the column-filling BEFORE
 * INSERT trigger and the non-partial unique index that shape relied
 * on. The spine writes the one canonical post-0092 shape (explicit
 * `install_id` + `pillar='action'`, partial-index conflict target),
 * pinned against real Postgres in `db/__tests__/migrate-pg.test.ts`.
 *
 * Intentionally NOT on this spine (different persistence shapes):
 *   - `DatasourceFormInstallHandler` — `pillar='datasource'`,
 *     `status='draft'`, fixed per-workspace `install_id`, catalog-
 *     schema-driven mask/restore. The ADR-0013 `createFromConfig`
 *     bridge owns that flow.
 *   - `persistOpenApiDatasourceInstall` — multi-instance (fresh
 *     `install_id` per submit), probe-on-install, `status='draft'`.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ../../plugins/secrets.ts — {@link encryptSecretFields}
 */

import type { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecretFields, type ConfigSchema } from "@atlas/api/lib/plugins/secrets";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import type { WorkspaceId } from "@useatlas/types";
import type { CatalogId, InstallRecord } from "./types";

type InstallLogger = ReturnType<typeof createLogger>;

/**
 * The canonical single-instance form-install upsert (post-0092 shape,
 * #2739). `install_id` is named explicitly (= the candidate row id,
 * matching the Linear / GitHub PAT / Twenty convention) and
 * `pillar='action'` is denormalized so the partial unique index
 * `workspace_plugins_singleton` — the only `(workspace_id, catalog_id)`
 * unique gate left after 0096 — can arbitrate the conflict. The WHERE
 * clause on the conflict target is load-bearing: Postgres only infers a
 * partial index as the arbiter when the predicate is spelled out.
 *
 * `RETURNING id` returns the persisted id — on a fresh INSERT it's the
 * one we generated, on a CONFLICT it's the row's existing id (NOT the
 * freshly-generated one). Callers that treat `installId` as a stable
 * identifier for the saved row would otherwise read a phantom id on
 * re-installs.
 *
 * `installed_at` is NOT bumped on conflict (matches the Slack OAuth
 * handler) — the column tracks the first install, not the most recent
 * edit.
 *
 * Exported so the real-Postgres migration smoke executes this exact
 * string against the live schema — the drift class that broke the
 * pre-spine Email/Webhook/Obsidian copies (mock-based handler tests
 * can't see plan-time SQL errors).
 */
export function buildFormInstallUpsertSql(updateConfigOnConflict: boolean): string {
  // Twenty keeps the existing row's config on re-install — its config
  // is a catalog-binding stub (credential lives in twenty_integrations).
  const conflictSet = updateConfigOnConflict
    ? `SET config = EXCLUDED.config,
               enabled = true`
    : `SET enabled = true`;
  return `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'action', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE
           ${conflictSet}
         RETURNING id`;
}

/**
 * SaaS keyset gate. `encryptSecret` falls back to plaintext when no key
 * is configured (dev convenience). Boot logs a one-shot warning, but a
 * missed log in SaaS would leak the credential plaintext. Refuse the
 * install per-call so a misconfigured deploy fails closed at the
 * credential boundary.
 *
 * Runs inside {@link persistFormInstall}; exported for handlers that
 * write a credential store BEFORE the workspace_plugins upsert (Twenty's
 * `twenty_integrations` row) and must gate that earlier write too.
 *
 * @param plaintextSecretLabel - the credential field named in the
 *   refusal log line ("password", "api_key", "pat", …). Log breadcrumb
 *   only — never the secret value itself.
 */
export function assertSaasEncryptionKeyset(
  log: InstallLogger,
  workspaceId: WorkspaceId,
  plaintextSecretLabel: string,
): void {
  if (process.env.ATLAS_DEPLOY_MODE === "saas" && !getEncryptionKeyset()) {
    log.error(
      { workspaceId },
      `Refusing form install: SaaS mode + no encryption keyset (would persist plaintext ${plaintextSecretLabel})`,
    );
    throw new Error(
      "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. Set ATLAS_ENCRYPTION_KEYS and retry.",
    );
  }
}

export interface PersistFormInstallParams {
  readonly workspaceId: WorkspaceId;
  /** `plugin_catalog.id` FK — `catalog:<slug>` per the seeder. */
  readonly catalogId: string;
  /** Bare catalog slug — becomes {@link InstallRecord.catalogId}. */
  readonly catalogSlug: CatalogId;
  /** Human-readable Platform name composed into log lines ("Email", "GitHub PAT"). */
  readonly displayName: string;
  /** The handler's own logger so install lines stay attributable per slug. */
  readonly log: InstallLogger;
  /** Validated plaintext config destined for `workspace_plugins.config`. */
  readonly config: Record<string, unknown>;
  /**
   * When present, fields flagged `secret: true` encrypt at rest via
   * {@link encryptSecretFields}. Omit only when the config carries no
   * credential (Twenty: the apiKey lives in its dedicated
   * `twenty_integrations` table, the config here is a `{}` stub).
   */
  readonly secretFieldsSchema?: ConfigSchema;
  /** Credential field named in the SaaS keyset-gate refusal log. */
  readonly plaintextSecretLabel: string;
  /** Candidate row-id generator (handlers inject a fixed one in tests). */
  readonly newId: () => string;
  /**
   * Default `true`. Twenty sets `false`: a re-install must keep the
   * existing row's config rather than overwrite it with the stub.
   */
  readonly updateConfigOnConflict?: boolean;
  /**
   * Evict the cached PluginLike for this (workspace, catalog) after the
   * upsert so the next tool dispatch rebuilds against the freshly-
   * persisted config. Without this, a re-install that rotates
   * credentials keeps the stale in-memory instance from before the
   * upsert. Fire-and-forget — a failed evict warns but never fails the
   * install (the DB row is already persisted).
   */
  readonly evictAfterPersist?: boolean;
  /**
   * Override for the persist-failure log line. Twenty uses it to
   * document partial-write recovery (its credential row lands first and
   * is intentionally not rolled back — re-running the install heals the
   * catalog row).
   */
  readonly persistFailureMessage?: string;
}

/**
 * The shared spine: SaaS keyset gate → encrypt secret fields →
 * `workspace_plugins` upsert → returned-id invariant → optional
 * lazy-loader evict. Handlers shrink to parse-and-validate + one call;
 * the per-Platform completion `log.info` (host/port/owner breadcrumbs)
 * stays with the handler.
 */
export async function persistFormInstall(
  params: PersistFormInstallParams,
): Promise<InstallRecord> {
  const {
    workspaceId,
    catalogId,
    catalogSlug,
    displayName,
    log,
    config,
    secretFieldsSchema,
    plaintextSecretLabel,
    newId,
    updateConfigOnConflict = true,
    evictAfterPersist = false,
    persistFailureMessage = `Failed to persist ${displayName} install record — aborting install`,
  } = params;

  // ── 1. SaaS keyset gate ─────────────────────────────────────────────
  assertSaasEncryptionKeyset(log, workspaceId, plaintextSecretLabel);

  // ── 2. Encrypt secret fields at rest ────────────────────────────────
  const persistedConfig = secretFieldsSchema
    ? encryptSecretFields(config, secretFieldsSchema)
    : config;

  // ── 3. Upsert workspace_plugins ─────────────────────────────────────
  // ON CONFLICT updates config (unless the handler opted out) + flips
  // enabled back to true so a re-install after disconnect lands cleanly.
  const candidateId = newId();
  let persistedId: string;
  try {
    const rows = await internalQuery<{ id: string }>(
      buildFormInstallUpsertSql(updateConfigOnConflict),
      [candidateId, workspaceId, catalogId, JSON.stringify(persistedConfig)],
    );
    const returned = rows[0]?.id;
    if (typeof returned !== "string" || returned.length === 0) {
      // INSERT ... ON CONFLICT ... DO UPDATE RETURNING is guaranteed
      // by Postgres to emit exactly one row on both paths. Reaching
      // here means a structural anomaly (driver rewrite, RLS hiding
      // the result, partial-index miss). Falling back to candidateId
      // would silently return a WRONG id on the DO UPDATE path
      // (persisted row keeps its existing id, not the candidate),
      // and downstream lookups would create phantom updates. Fail
      // loud so the operator sees the invariant break with a 500.
      log.error(
        { workspaceId, candidateId },
        "workspace_plugins upsert returned no id — Postgres invariant violation",
      );
      throw new Error(
        "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
      );
    }
    persistedId = returned;
  } catch (err) {
    log.error(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      persistFailureMessage,
    );
    throw err;
  }

  // ── 4. Optional post-persist evict ──────────────────────────────────
  if (evictAfterPersist) {
    try {
      await lazyPluginLoader.evict(workspaceId, catalogId);
    } catch (err) {
      log.warn(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        `LazyPluginLoader.evict threw after ${displayName} install upsert — DB row is persisted anyway`,
      );
    }
  }

  return { id: persistedId, workspaceId, catalogId: catalogSlug };
}
