/**
 * `persistFormInstall` — the shared persistence spine for every
 * single-instance (chat/action-pillar) {@link FormBasedInstallHandler}.
 *
 * Email / Webhook / Obsidian / Linear API-key / GitHub PAT / Twenty all
 * repeated the same sequence after their per-Platform Zod parse: SaaS
 * keyset gate → `encryptSecretFields` → `workspace_plugins` upsert →
 * returned-id invariant check → lazy-loader evict. Five-plus
 * copies of that spine meant five places for the Workspace Install
 * write path to be wrong — and three of them WERE wrong: the Email /
 * Webhook / Obsidian copies still carried the pre-0092 INSERT shape
 * (no `install_id` / `pillar`, bare `ON CONFLICT (workspace_id,
 * catalog_id)`), which fails against the post-0096 schema with 42P10
 * ("no unique or exclusion constraint matching the ON CONFLICT
 * specification") because 0096 dropped both the column-filling BEFORE
 * INSERT trigger and the non-partial unique index that shape relied
 * on. The spine writes the one canonical post-0092 shape (explicit
 * `install_id` + denormalized `pillar`, partial-index conflict
 * target), pinned against real Postgres in
 * `__tests__/persist-form-install-pg.test.ts`.
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

/**
 * The spine only writes log lines — narrow to exactly the levels it
 * uses so test loggers and lightweight scoped loggers satisfy the type
 * without casting (precedent: `_shared/oauth-retry.ts`'s RetryLogger).
 */
type InstallLogger = Pick<ReturnType<typeof createLogger>, "error" | "warn">;

/**
 * The canonical single-instance form-install upsert (post-0092 shape,
 * #2739). `install_id` is named explicitly (= the candidate row id,
 * matching the convention of every working writer — Slack, Telegram,
 * Linear, GitHub PAT, Twenty; pre-0096 rows backfilled by 0092 carry
 * the older `install_id = catalog_id` sentinel and are healed to the
 * existing row id never being touched on conflict) and `pillar` is
 * denormalized so the partial unique index `workspace_plugins_singleton`
 * — the only `(workspace_id, catalog_id)` unique gate left after 0096 —
 * can arbitrate the conflict. The WHERE clause on the conflict target
 * is load-bearing: Postgres only infers a partial index as the arbiter
 * when the predicate is spelled out.
 *
 * `pillar` is a parameter (defaulting to `'action'`, the only value the
 * form spine writes today) so the five static-bot chat handlers and the
 * #3357 Salesforce/Jira fix can converge on this single tested artifact
 * instead of hand-rolling an eleventh copy.
 *
 * `RETURNING id` returns the persisted id — on a fresh INSERT it's the
 * one we generated, on a CONFLICT it's the row's existing id (NOT the
 * freshly-generated one). Callers that treat `installId` as a stable
 * identifier for the saved row would otherwise read a phantom id on
 * re-installs.
 *
 * `installed_at` is NOT bumped on conflict (matches the Slack OAuth
 * handler) — the column tracks the first install, not the most recent
 * edit. `installed_by` ($5, nullable) follows the same rule: it
 * attributes the FIRST installer and is never rewritten on a
 * re-install. The form handlers have no acting-user id at their seam
 * and pass null; the marketplace `/install` route (#4186) passes the
 * authenticated admin's id.
 *
 * Exported so the real-Postgres smoke executes this exact string
 * against the live schema — the drift class that broke the pre-spine
 * Email/Webhook/Obsidian copies (mock-based handler tests can't see
 * plan-time SQL errors).
 */
export function buildFormInstallUpsertSql(
  updateConfigOnConflict: boolean,
  pillar: "chat" | "action" = "action",
): string {
  // Twenty keeps the existing row's config on re-install — its config
  // is a catalog-binding stub (credential lives in twenty_integrations).
  const conflictSet = updateConfigOnConflict
    ? `SET config = EXCLUDED.config,
               enabled = true`
    : `SET enabled = true`;
  return `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at, installed_by)
         VALUES ($1, $2, $3, $1, '${pillar}', $4::jsonb, true, NOW(), $5)
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE
           ${conflictSet}
         RETURNING id`;
}

/**
 * Read-back for the marketplace install response (#4186): the spine's
 * upsert only RETURNs the id, and the route's 201 body needs the full
 * `workspace_plugins` row plus the joined catalog display fields. Lives
 * next to {@link buildFormInstallUpsertSql} for the same reason that
 * builder is exported: the real-Postgres smoke executes this exact
 * string against the live schema, closing the plan-time-SQL-drift class
 * that broke the pre-spine hand-rolled INSERT.
 */
export const MARKETPLACE_INSTALL_READBACK_SQL = `SELECT wp.*, pc.name, pc.slug, pc.type, pc.description
           FROM workspace_plugins wp
           JOIN plugin_catalog pc ON pc.id = wp.catalog_id
          WHERE wp.id = $1 AND wp.workspace_id = $2`;

/**
 * The keyset gate's refusal, as an identifiable class so route-level
 * catches can narrow to exactly this failure (`instanceof`) and rethrow
 * anything else — a broad `catch` around the gate would otherwise
 * mislabel unrelated throws (e.g. `getEncryptionKeyset`'s malformed-
 * config parse errors) as "keyset unavailable" and echo their raw
 * messages to the client (#4186 review). Tagged class rather than
 * `Data.TaggedError` for the same reason as
 * {@link FormInstallValidationError}: it throws synchronously out
 * through legacy Hono handlers that catch via `instanceof`.
 */
export class EncryptionKeysetUnavailableError extends Error {
  readonly _tag = "EncryptionKeysetUnavailableError" as const;
  constructor() {
    super(
      "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. Set ATLAS_ENCRYPTION_KEYS and retry.",
    );
    this.name = "EncryptionKeysetUnavailableError";
  }
}

/**
 * SaaS keyset gate. `encryptSecret` falls back to plaintext when no key
 * is configured (dev convenience). Boot logs a one-shot warning, but a
 * missed log in SaaS would leak the credential plaintext. Refuse the
 * install per-call so a misconfigured deploy fails closed at the
 * credential boundary.
 *
 * Runs inside {@link persistFormInstall}; exported for handlers that
 * must gate an EARLIER write — Twenty's `twenty_integrations` credential
 * row lands before the catalog upsert, and Email's TLS-disabled warn
 * must not fire for an install the gate refuses.
 *
 * @param plaintextSecretLabel - the credential field named in the
 *   refusal log line ("password", "api_key", "pat", …). Log breadcrumb
 *   only — never the secret value itself. Sanitized to a word-ish token
 *   because it lands in the log MESSAGE: this is an exported seam, and
 *   a future caller passing a config-derived label must not be able to
 *   splice newlines/control chars into the alertable refusal string.
 * @param extraLogFields - additional structured fields for the refusal
 *   log (the shared OpenAPI install core attributes per-candidate slugs).
 */
export function assertSaasEncryptionKeyset(
  log: InstallLogger,
  workspaceId: WorkspaceId,
  plaintextSecretLabel: string,
  extraLogFields: Record<string, unknown> = {},
): void {
  if (process.env.ATLAS_DEPLOY_MODE === "saas" && !getEncryptionKeyset()) {
    const label = plaintextSecretLabel.replace(/[^\w./-]/g, "_");
    log.error(
      { workspaceId, ...extraLogFields },
      `Refusing form install: SaaS mode + no encryption keyset (would persist plaintext ${label})`,
    );
    throw new EncryptionKeysetUnavailableError();
  }
}

/**
 * Structural subset of a Zod schema's `safeParse` — kept structural so
 * the spine doesn't pin a zod version, and so `.strict()` / `.refine()`
 * / `.transform()` wrappers all satisfy it.
 */
interface ParseableFormSchema<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          flatten(): {
            fieldErrors: Record<string, string[] | undefined>;
            formErrors: string[];
          };
        };
      };
}

/**
 * The canonical parse-or-throw step every form handler starts with:
 * validate `formData` against the handler's Zod schema and throw
 * {@link FormInstallValidationError} (the single error type the route's
 * `instanceof` catch maps to a field-level 400) on failure.
 */
export function parseFormInstall<T>(schema: ParseableFormSchema<T>, formData: unknown): T {
  const parsed = schema.safeParse(formData);
  if (!parsed.success) {
    throw FormInstallValidationError.fromZodFlatten(parsed.error.flatten());
  }
  return parsed.data;
}

export interface PersistInstallRecordParams {
  readonly workspaceId: WorkspaceId;
  /** Full `plugin_catalog.id` row key ("catalog:salesforce"). */
  readonly catalogId: string;
  /** Human-readable Platform name composed into log lines ("Salesforce", "GitHub App"). */
  readonly displayName: string;
  /** The caller's own logger so install lines stay attributable per slug. */
  readonly log: InstallLogger;
  /**
   * Config exactly as persisted to `workspace_plugins.config` — already
   * encrypted where applicable. Encryption stays with the caller
   * ({@link persistFormInstall} runs the keyset gate + field encryption;
   * the OAuth handlers persist operator-visible metadata only, their
   * credentials live in `integration_credentials` per ADR-0005).
   */
  readonly config: Record<string, unknown>;
  /** Candidate row-id generator (handlers inject a fixed one in tests). */
  readonly newId?: () => string;
  /** Default `true` — see {@link buildFormInstallUpsertSql}. */
  readonly updateConfigOnConflict?: boolean;
  /** Default `'action'` — see {@link buildFormInstallUpsertSql}. */
  readonly pillar?: "chat" | "action";
  /**
   * Acting user attributed as `installed_by` (first install only —
   * never rewritten on conflict, mirroring `installed_at`). Default
   * `null`: the form/OAuth handlers run below the auth seam and have
   * no user id; the marketplace `/install` route passes the
   * authenticated admin's id (#4186).
   */
  readonly installedBy?: string | null;
  /** Override for the persist-failure log line. */
  readonly persistFailureMessage?: string;
  /**
   * Extra structured fields merged into the persist-failure log
   * (per-Platform breadcrumbs like `instanceUrl` / `cloudid`). Never
   * secrets.
   */
  readonly failureLogFields?: Record<string, unknown>;
}

/**
 * The `workspace_plugins` upsert the spine hands to a {@link SingletonInstallCapGate}
 * — raw SQL + bound params, structurally the billing gate's `WorkspacePluginInsert`
 * (kept local so the generic spine doesn't depend on the billing module).
 */
export interface SingletonInstallInsert {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The outcome of a {@link SingletonInstallCapGate}: `ok` carries the upsert's
 * `RETURNING` rows; the denied arm carries the already-built (and already
 * logged) 429/503 error to throw. A cap denial is RETURNED, never thrown, so
 * the generic spine can distinguish it from a raw write-path throw — the
 * denial passes straight through (no persist-failure log), while a throw
 * (routing-id `23505`, driver fault) is routed through
 * {@link RoutingConflictClassifier} / the persist-failure log.
 */
export type SingletonInstallCapResult =
  | { readonly ok: true; readonly rows: readonly { id: string }[] }
  | { readonly ok: false; readonly error: Error };

/**
 * The atomic chat-integration cap gate, bound to `(workspaceId, catalogId)`
 * by the caller. When supplied to {@link persistSingletonInstall} the
 * singleton upsert runs THROUGH the gate — inside its advisory-locked
 * transaction — instead of a bare {@link internalQuery}, so a net-new chat
 * platform can't slip past the plan cap under concurrency (#3001).
 *
 * The hook OWNS the cap decision: it runs `checkChatIntegrationLimitAndInstall`
 * and maps a denied result to the platform's 429/503 error (returned via the
 * `{ ok: false }` arm) — so the generic spine stays free of billing/chat error
 * types. It returns the upsert's `RETURNING` rows on success. A raw write-path
 * throw (routing-id `23505`, driver fault) propagates OUT to the spine, which
 * routes it through {@link RoutingConflictClassifier} / its persist-failure
 * log. The five static-bot handlers and the Slack OAuth handler supply this;
 * the action-pillar OAuth handlers + the form spine omit it (no chat cap).
 */
export type SingletonInstallCapGate = (
  insert: SingletonInstallInsert,
) => Promise<SingletonInstallCapResult>;

/**
 * Classifies a write-path error as a platform-specific routing-id conflict,
 * returning the actionable error to throw (or `null` when the error is
 * something else and should propagate as a 5xx). The five static-bot
 * handlers pass an adapter over {@link import("./routing-id-conflict").isRoutingIdUniqueViolation}
 * that also logs the platform's own warn line, so the specific routing-id
 * noun ("chat_id" / "guild_id" / "tenant_id" / …) stays with the platform.
 * Returning `null` lets {@link persistSingletonInstall} fall through to its
 * generic persist-failure log + rethrow.
 */
export type RoutingConflictClassifier = (err: unknown) => Error | null;

export interface PersistSingletonInstallParams {
  readonly workspaceId: WorkspaceId;
  /** Full `plugin_catalog.id` row key ("catalog:telegram"). */
  readonly catalogId: string;
  /**
   * Human-readable Platform name composed into log lines + the invariant
   * error ("Telegram", "Slack", "Linear").
   */
  readonly displayName: string;
  /** The caller's own logger so install lines stay attributable per platform. */
  readonly log: InstallLogger;
  /**
   * Config exactly as persisted to `workspace_plugins.config` — already
   * encrypted where applicable.
   */
  readonly config: Record<string, unknown>;
  /** Candidate row-id generator (handlers inject a fixed one in tests). */
  readonly newId?: () => string;
  /** Default `true` — see {@link buildFormInstallUpsertSql}. */
  readonly updateConfigOnConflict?: boolean;
  /** Default `'action'` — chat handlers pass `'chat'`. See {@link buildFormInstallUpsertSql}. */
  readonly pillar?: "chat" | "action";
  /**
   * Acting user attributed as `installed_by` (first install only — never
   * rewritten on conflict). Default `null`: the form/OAuth/static-bot
   * handlers run below the auth seam and have no user id.
   */
  readonly installedBy?: string | null;
  /**
   * When present, the upsert runs atomically through the chat-integration
   * cap gate (which owns the denied → 429/503 mapping and returns the
   * `RETURNING` rows). When absent, the upsert runs via a bare
   * {@link internalQuery} — the action-pillar OAuth handlers (Linear) + the
   * form spine, which have no chat cap. See {@link SingletonInstallCapGate}.
   *
   * NOTE: `pillar` and `capGate` are independent — a `chat`-pillar caller that
   * omits `capGate` deliberately skips the chat-integration cap (there is no
   * such caller today; all six chat handlers pass it).
   */
  readonly capGate?: SingletonInstallCapGate;
  /** See {@link RoutingConflictClassifier}. */
  readonly routingConflictClassifier?: RoutingConflictClassifier;
  /** Override for the persist-failure log line. */
  readonly persistFailureMessage?: string;
  /**
   * Extra structured fields merged into the persist-failure log
   * (per-Platform breadcrumbs like `teamId` / `instanceUrl`). Never
   * secrets.
   */
  readonly failureLogFields?: Record<string, unknown>;
}

/**
 * The single write path for every SINGLETON (chat/action-pillar)
 * `workspace_plugins` install (issue #4352). Builds the one canonical
 * upsert via {@link buildFormInstallUpsertSql}, runs it either through the
 * chat-integration cap gate (`capGate`) or a bare {@link internalQuery},
 * classifies a concurrent routing-id conflict, and enforces the single
 * returned-id invariant — the block that used to be hand-copied across the
 * five static-bot handlers, the Slack + Linear OAuth handlers, and this
 * spine (each copy a place for the write path to drift, the exact class
 * that produced #3357 / the pre-spine 42P10). Returns the PERSISTED row id:
 * on a re-install the upsert's RETURNING yields the EXISTING row's id, not
 * the fresh candidate, so callers must use this value (not their own UUID)
 * for {@link InstallRecord.id}.
 *
 * Does NOT evict the lazy-loader cache — that stays with
 * {@link persistInstallRecord} / {@link persistFormInstall}, which layer it
 * on top. The OAuth + static-bot handlers never evicted, and this
 * convergence preserves that (their credentials/config are re-read on the
 * next lazy build, and adding an evict here would be a behavioural change
 * outside this refactor's scope).
 */
export async function persistSingletonInstall(
  params: PersistSingletonInstallParams,
): Promise<string> {
  const {
    workspaceId,
    catalogId,
    displayName,
    log,
    config,
    newId = () => crypto.randomUUID(),
    updateConfigOnConflict = true,
    pillar = "action",
    installedBy = null,
    capGate,
    routingConflictClassifier,
    persistFailureMessage = `Failed to persist ${displayName} install record — aborting install`,
    failureLogFields = {},
  } = params;

  const candidateId = newId();
  const insert: SingletonInstallInsert = {
    sql: buildFormInstallUpsertSql(updateConfigOnConflict, pillar),
    params: [candidateId, workspaceId, catalogId, JSON.stringify(config), installedBy],
  };

  // A raw write-path throw (lock/INSERT/COMMIT/driver error, or a routing-id
  // `23505` bubbling up from the cap gate) is either the platform's routing-id
  // conflict — re-surfaced as its actionable error — or a genuine 5xx that we
  // log with the caller's breadcrumbs and rethrow. A cap denial is NOT a throw:
  // the `capGate` hook returns it via `{ ok: false }`, so it never reaches here.
  const raiseWriteError = (err: unknown): never => {
    const routingConflict = routingConflictClassifier?.(err) ?? null;
    if (routingConflict) throw routingConflict;
    // Log the Error object (not `.message`) so Pino's `err` serializer keeps
    // the type + stack of a genuine driver fault — the frame you actually need
    // to debug the write. The serializer scrubs secrets from the stack.
    log.error(
      { workspaceId, ...failureLogFields, err: err instanceof Error ? err : new Error(String(err)) },
      persistFailureMessage,
    );
    throw err instanceof Error ? err : new Error(String(err));
  };

  let rows: readonly { id: string }[];
  if (capGate) {
    const capResult = await capGate(insert).catch(raiseWriteError);
    // Cap denial (429/503) — already built + logged by the hook. Throw it as
    // is, without the persist-failure breadcrumb a genuine write error gets.
    if (!capResult.ok) throw capResult.error;
    rows = capResult.rows;
  } else {
    rows = await internalQuery<{ id: string }>(insert.sql, insert.params as unknown[]).catch(
      raiseWriteError,
    );
  }

  const returned = rows[0]?.id;
  if (typeof returned !== "string" || returned.length === 0) {
    // INSERT ... ON CONFLICT ... DO UPDATE RETURNING is guaranteed by
    // Postgres (≥9.5) to emit exactly one row on both the insert and the
    // update path. Reaching here means a structural anomaly (driver
    // rewrite, RLS hiding the result, partial-index miss). Falling back to
    // candidateId would silently return the WRONG id on the DO UPDATE path
    // (the persisted row keeps its existing id, not the candidate), and
    // downstream lookups would strand — so fail loud with a 500.
    log.error(
      { workspaceId, candidateId },
      "workspace_plugins upsert returned no id — Postgres invariant violation",
    );
    throw new Error(
      `workspace_plugins upsert returned no id for ${displayName} install (workspaceId=${workspaceId}). ` +
        `RETURNING must always populate on PG ≥9.5; this indicates a driver/RLS/query-rewrite regression. Aborting install.`,
    );
  }
  return returned;
}

/**
 * The persistence core shared by the form spine and the OAuth install
 * handlers: {@link persistSingletonInstall} (the `workspace_plugins` upsert
 * + returned-id invariant) → unconditional lazy-loader evict. Returns the
 * PERSISTED row id — on a re-install the upsert's RETURNING yields the
 * existing row's id, not the freshly-generated candidate, so callers must
 * use this value (not their own UUID) for {@link InstallRecord.id}.
 *
 * Extracted from {@link persistFormInstall} (#3362 review) so the four
 * OAuth handlers (GitHub App, GitHub single-tenant, Salesforce, Jira)
 * stop carrying their own copies of the upsert + invariant — the drift
 * class that produced #3357 in the first place. The marketplace
 * `POST /install` route (#4186) also persists through here: it takes
 * the full `plugin_catalog.id` (which for platform-admin-CRUD rows is
 * a bare UUID, NOT `catalog:<slug>`), so it enters at this seam rather
 * than through {@link persistFormInstall}'s slug-derived FK.
 *
 * The evict is unconditional: a re-install that rotates credentials
 * must never keep serving a stale cached PluginLike built from the
 * pre-upsert config, and `lazyPluginLoader.evict` is a free no-op when
 * nothing is cached. Fire-and-forget: a failed evict warns but never
 * fails the install (the DB row is already persisted).
 */
export async function persistInstallRecord(params: PersistInstallRecordParams): Promise<string> {
  const {
    workspaceId,
    catalogId,
    displayName,
    log,
    config,
    newId = () => crypto.randomUUID(),
    updateConfigOnConflict = true,
    pillar = "action",
    installedBy = null,
    persistFailureMessage = `Failed to persist ${displayName} install record — aborting install`,
    failureLogFields = {},
  } = params;

  const persistedId = await persistSingletonInstall({
    workspaceId,
    catalogId,
    displayName,
    log,
    config,
    newId,
    updateConfigOnConflict,
    pillar,
    installedBy,
    persistFailureMessage,
    failureLogFields,
  });

  try {
    await lazyPluginLoader.evict(workspaceId, catalogId);
  } catch (err) {
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      `LazyPluginLoader.evict threw after ${displayName} install upsert — DB row is persisted anyway`,
    );
  }

  return persistedId;
}

export interface PersistFormInstallParams {
  readonly workspaceId: WorkspaceId;
  /**
   * Bare catalog slug — the dispatch key and {@link InstallRecord.catalogId}.
   * The `plugin_catalog.id` FK is derived as `catalog:<slug>` (the
   * seeder's invariant, `catalog-seeder.ts::upsertEntry`) so a handler
   * can never pass a mismatched id/slug pair.
   */
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
  /**
   * Credential field named in the SaaS keyset-gate refusal log. Derived
   * from the schema's `secret: true` field keys when omitted; required
   * in spirit for schema-less callers (falls back to "credential").
   */
  readonly plaintextSecretLabel?: string;
  /** Candidate row-id generator (handlers inject a fixed one in tests). */
  readonly newId: () => string;
  /**
   * Default `true`. Twenty sets `false`: a re-install must keep the
   * existing row's config rather than overwrite it with the stub.
   */
  readonly updateConfigOnConflict?: boolean;
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
 * `workspace_plugins` upsert → returned-id invariant → lazy-loader
 * evict. Handlers shrink to parse-and-validate + one call; the
 * per-Platform completion `log.info` (host/port/owner breadcrumbs)
 * stays with the handler.
 *
 * The evict is unconditional: a re-install that rotates credentials
 * must never keep serving a stale cached PluginLike built from the
 * pre-upsert config, and `lazyPluginLoader.evict` is a free no-op when
 * nothing is cached — so there is no consumer for which skipping it
 * would be right (the pre-spine Webhook/Obsidian copies skipped it and
 * carried exactly that stale-instance bug, latent until their lazy
 * builders register). Fire-and-forget: a failed evict warns but never
 * fails the install (the DB row is already persisted).
 */
export async function persistFormInstall(
  params: PersistFormInstallParams,
): Promise<InstallRecord> {
  const {
    workspaceId,
    catalogSlug,
    displayName,
    log,
    config,
    secretFieldsSchema,
    plaintextSecretLabel,
    newId,
    updateConfigOnConflict = true,
    persistFailureMessage = `Failed to persist ${displayName} install record — aborting install`,
  } = params;

  // The seeder derives every catalog row id as `catalog:${slug}` — one
  // param, so a mismatched id/slug pair is unrepresentable at the seam.
  const catalogId = `catalog:${catalogSlug}`;

  // ── 1. SaaS keyset gate ─────────────────────────────────────────────
  assertSaasEncryptionKeyset(
    log,
    workspaceId,
    plaintextSecretLabel ?? deriveSecretLabel(secretFieldsSchema),
  );

  // ── 2. Encrypt secret fields at rest ────────────────────────────────
  const persistedConfig = secretFieldsSchema
    ? encryptSecretFields(config, secretFieldsSchema)
    : config;

  // ── 3+4. Upsert workspace_plugins + lazy-loader evict ───────────────
  // ON CONFLICT updates config (unless the handler opted out) + flips
  // enabled back to true so a re-install after disconnect lands cleanly.
  const persistedId = await persistInstallRecord({
    workspaceId,
    catalogId,
    displayName,
    log,
    config: persistedConfig,
    newId,
    updateConfigOnConflict,
    persistFailureMessage,
  });

  return { id: persistedId, workspaceId, catalogId: catalogSlug };
}

/**
 * The `secret: true` field keys of a parsed schema — the gate-log
 * breadcrumb for {@link assertSaasEncryptionKeyset}. Exported for
 * callers that run the keyset gate themselves because their persist
 * enters at {@link persistInstallRecord} (the marketplace `/install`
 * route, #4186).
 */
export function deriveSecretLabel(schema: ConfigSchema | undefined): string {
  if (schema?.state === "parsed") {
    const keys = schema.fields.filter((f) => f.secret === true).map((f) => f.key);
    if (keys.length > 0) return keys.join("/");
  }
  return "credential";
}

/**
 * Validation failure surface for every form-based install handler.
 * `kind` is the catalog `install_model` value so every handler throws
 * the same class — the route's catch is a single
 * `instanceof FormInstallValidationError` check rather than a growing
 * list of per-Platform error types. (Declared in the Email module first
 * per #2697; moved here with the spine so {@link parseFormInstall} can
 * throw it without an email-handler import cycle. `email-form-handler`
 * re-exports it, so existing import sites keep compiling.)
 *
 * `fieldErrors` is normalized at construction: only fields with
 * actual issues land in the map (Zod's `flatten().fieldErrors`
 * carries `string[] | undefined` values; we drop the undefineds so
 * the public contract is clean).
 *
 * `formErrors` carries top-level issues — `.strict()` "unrecognized
 * key" reports, schema-level `.refine` failures — that don't bind to
 * any single field. The route surfaces both so the admin UI can
 * render a generic banner alongside per-field messages.
 *
 * Tagged class rather than `Data.TaggedError` because this throws out
 * through the legacy Hono handler — `runHandler`'s typed-error mapper
 * doesn't currently know about install-handler-internal tagged
 * errors; the route catches via `instanceof` and emits the 400
 * directly. Promoting to a tagged Effect error is a follow-up once
 * the dispatch grows.
 */
export class FormInstallValidationError extends Error {
  readonly _tag = "FormInstallValidationError" as const;
  readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
  readonly formErrors: readonly string[];

  constructor(input: {
    fieldErrors: Record<string, string[] | undefined>;
    formErrors?: readonly string[];
  }) {
    super("Form install validation failed");
    this.name = "FormInstallValidationError";
    const cleaned: Record<string, readonly string[]> = {};
    for (const [k, v] of Object.entries(input.fieldErrors)) {
      if (v && v.length > 0) cleaned[k] = v;
    }
    this.fieldErrors = cleaned;
    this.formErrors = input.formErrors ?? [];
  }

  /** Build from `parsed.error.flatten()` — the canonical Zod adapter. */
  static fromZodFlatten(flat: {
    fieldErrors: Record<string, string[] | undefined>;
    formErrors: string[];
  }): FormInstallValidationError {
    return new FormInstallValidationError({
      fieldErrors: flat.fieldErrors,
      formErrors: flat.formErrors,
    });
  }
}
