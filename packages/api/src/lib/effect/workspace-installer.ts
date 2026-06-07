/**
 * `WorkspaceInstaller` — slice 4 of #2742 (PRD #2738).
 *
 * Write-side facade owning the universal install / uninstall / update-config
 * surface for integration `pillar IN ('chat', 'action')`. Per ADR-0007 the
 * facade orchestrates the existing per-Platform handlers; it does NOT unify
 * credential stores (that's deferred). The handlers themselves continue to
 * own the per-Platform write semantics:
 *
 *   - Chat OAuth (Slack) → `workspace_plugins` + `chat_cache` (ADR-0003).
 *   - Action OAuth (Salesforce, Jira) → `workspace_plugins` +
 *     `integration_credentials` (ADR-0005).
 *   - Form-based (Email, Webhook, Obsidian) → `workspace_plugins` with
 *     `secret: true` fields inside `config` JSONB encrypted via
 *     `encryptSecretFields` (per `db/secret-encryption.ts`).
 *   - Static-bot (Teams, Discord, …) — handler stub in 1.5.2; the facade
 *     dispatch wiring is in place so 1.5.3 can swap in the real handler
 *     without route churn.
 *
 * `/admin/connections` (`pillar = 'datasource'`) is intentionally NOT pivoted
 * through this facade — the `connections` table is still source-of-truth
 * pre-cutover. Slice 6 (#2744) handles that pivot.
 *
 * The facade enforces three invariants the per-handler dispatch can't see:
 *
 *   1. **Pillar singleton.** For `chat` and `action` pillars, only one install
 *      row per (workspace, catalog) is allowed. Backed by
 *      `workspace_plugins_singleton` partial unique index (slice 1, #2739).
 *      The facade pre-checks; the unique violation is the defensive backstop.
 *   2. **Catalog `config_schema` validation.** Every `config` payload is
 *      validated against `plugin_catalog.config_schema` before it reaches
 *      persist. Per-handler Zod schemas (Email's SMTP shape, etc.) remain
 *      authoritative for shape — this layer enforces the
 *      catalog-declared `secret: true` / required / type contract that
 *      drives admin UI form rendering AND the at-rest encryption walker.
 *   3. **Tagged errors.** `AlreadyInstalledError` (singleton violation) →
 *      HTTP 409; `ConfigSchemaError` (field-level validation failures) →
 *      HTTP 400. Both flow through `mapTaggedError` in `errors.ts`.
 *
 * The OAuth callback path stays handler-owned: `OAuthPlatformInstallHandler`
 * already does its own state-token verification, code-for-token exchange,
 * and dual-store write. The facade's `install()` accepts either a "form" or
 * "callback" mode via `options.kind` and delegates accordingly — for OAuth
 * the singleton check is the only pre-write gate the facade adds, because
 * the catalog config_schema doesn't bind to OAuth callback payloads.
 *
 * @see docs/adr/0007-unified-install-pipeline.md
 * @see docs/adr/0003-two-store-chat-install-metadata-credentials.md
 * @see docs/adr/0005-integration-credentials-table.md
 */

import { Context, Effect, Layer } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import {
  decryptSecretFields,
  encryptSecretFields,
  parseConfigSchema,
} from "@atlas/api/lib/plugins/secrets";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import type {
  CatalogRowForDispatch,
  CredentialResult,
  PlatformInstallHandler,
} from "@atlas/api/lib/integrations/install/types";
import type { CatalogInstallModel } from "@atlas/api/lib/config";
import type { WorkspaceId } from "@useatlas/types";
import {
  type BuiltinDatasourceDbType,
  catalogSlugToDbType,
  resolveDatasourcePoolConfig,
} from "@atlas/api/lib/db/datasource-pool-resolver";
import { maskConnectionUrl } from "@atlas/api/lib/security";
import {
  AlreadyInstalledError,
  CatalogNotFoundError,
  ConfigSchemaError,
  InstallNotFoundError,
  InvalidInstallIdError,
} from "@atlas/api/lib/effect/errors";

// Re-export so existing consumers that import these tags from
// `workspace-installer.ts` keep working — the canonical definitions live
// in `errors.ts` so they participate in the `AtlasError` union and
// `mapTaggedError` exhaustive switch. Re-exporting (instead of declaring
// local classes) closes a latent `instanceof` footgun: two classes
// sharing the same `_tag` would pass tag-string matching in `hono.ts`
// but fail `instanceof errorsModule.AlreadyInstalledError` checks in
// tests that hold both references.
export {
  AlreadyInstalledError,
  CatalogNotFoundError,
  ConfigSchemaError,
  InstallNotFoundError,
  InvalidInstallIdError,
};

// The registry bridge transitively imports `db/connection.ts` →
// `enterprise-layer.ts`. Static-importing here closes a cycle through
// `lib/effect/hono.ts` (which imports this module's `_tag` constants for
// `mapTaggedError`), so `enterprise-layer.ts:NoopEnterpriseDefaultsLayer`
// hits TDZ on test imports. Lazy-`require` mirrors the same pattern used
// for `lazyInternalQuery` / `lazyGetInstallHandler` above. The runtime
// resolution cost is one cached resolver hit per install call.
type DatasourceRegistryBridge = typeof import("@atlas/api/lib/db/datasource-registry-bridge");
function lazyDatasourceBridge(): DatasourceRegistryBridge {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@atlas/api/lib/db/datasource-registry-bridge") as DatasourceRegistryBridge;
}

// Type-only import for `InternalDB` so admin-approval-style tests that
// partial-mock `db/internal` don't trip bun's loader on services.ts ->
// hono.ts re-export chain. The value-level `internalQuery` is lazy-
// `require`'d inside the helpers below — same pattern PillarCatalogQuery
// uses for the same reason (#2741).
type InternalQueryFn = <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
function lazyInternalQuery(): InternalQueryFn {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@atlas/api/lib/db/internal") as {
    internalQuery: InternalQueryFn;
  };
  return mod.internalQuery;
}

function lazyGetInstallHandler(): (row: CatalogRowForDispatch) => PlatformInstallHandler {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@atlas/api/lib/integrations/install/dispatch") as {
    getInstallHandler: (row: CatalogRowForDispatch) => PlatformInstallHandler;
  };
  return mod.getInstallHandler;
}

const log = createLogger("workspace-installer");

// ---------------------------------------------------------------------------
// Tagged errors — canonical classes live in `lib/effect/errors.ts` and are
// re-exported above for back-compat. Defining them here would produce two
// classes sharing the same `_tag`: tag-string matching in `hono.ts` would
// still work but `instanceof errorsModule.AlreadyInstalledError` checks in
// tests holding both references would silently fail.
// ---------------------------------------------------------------------------

/** Discriminated union of every error the facade emits in its E channel. */
export type InstallError =
  | AlreadyInstalledError
  | ConfigSchemaError
  | CatalogNotFoundError
  | InstallNotFoundError
  | InvalidInstallIdError;

/** Route-renderable mapping for a single {@link InstallError}. */
export interface InstallErrorMapping {
  readonly status: 400 | 404 | 409;
  readonly code: string;
  readonly message: string;
  /** Tag-specific fields the route spreads into the JSON body. */
  readonly body?: Readonly<Record<string, unknown>>;
}

/**
 * Map a tagged {@link InstallError} to its HTTP status + body envelope.
 *
 * Exhaustive `switch (e._tag)` — adding a new `InstallError` variant
 * fails at compile time here, replacing the runtime "unknown status"
 * defect previously thrown in `runInstaller`. Mirrors the shape of
 * `mapTaggedError` in `hono.ts` but with the status narrowed to
 * `400 | 404 | 409` so route handlers can use `c.json(body, status)`
 * without a `ContentfulStatusCode` widening cast.
 *
 * Pillar/reason/fieldErrors carry into `body` so the admin UI can
 * render per-tag UX without parsing strings.
 */
export function mapInstallError(e: InstallError): InstallErrorMapping {
  // Body shapes mirror the corresponding `case` branches in
  // `lib/effect/hono.ts:mapTaggedError` so the wire payload stays
  // identical regardless of whether the route reached this map via
  // `runHandler` (full-Effect) or `runInstaller` (this PR's bridge).
  switch (e._tag) {
    case "InvalidInstallIdError":
      return {
        status: 400,
        code: "bad_request",
        message: e.message,
        body: { installId: e.installId, reason: e.reason },
      };
    case "ConfigSchemaError":
      return {
        status: 400,
        code: "bad_request",
        message: e.message,
        body: {
          catalogSlug: e.catalogSlug,
          fieldErrors: Object.fromEntries(
            Object.entries(e.fieldErrors).map(([k, v]) => [k, [...v]]),
          ),
          formErrors: [...e.formErrors],
        },
      };
    case "CatalogNotFoundError":
      return {
        status: 404,
        code: "not_found",
        message: e.message,
        body: { catalogSlug: e.catalogSlug },
      };
    case "InstallNotFoundError":
      return {
        status: 404,
        code: "not_found",
        message: e.message,
        body: { workspaceId: e.workspaceId, catalogSlug: e.catalogSlug },
      };
    case "AlreadyInstalledError":
      return {
        status: 409,
        code: "conflict",
        message: e.message,
        body: { catalogSlug: e.catalogSlug, pillar: e.pillar },
      };
    default: {
      // Compile-time exhaustiveness check — a new `InstallError` tag must
      // add a case above. Runtime guard is unreachable today.
      const _exhaustive: never = e;
      throw new Error(
        `mapInstallError: unhandled tag ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Row returned by `install` / `updateConfig`. Mirrors the subset of
 * `workspace_plugins` columns admin UI cards need; secrets stay
 * encrypted in DB (admin GET masks them per `maskSecretFields`).
 */
export interface WorkspaceInstallRow {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly catalogSlug: string;
  readonly catalogId: string;
  readonly pillar: "chat" | "action" | "datasource";
  readonly installId: string;
}

/**
 * Row returned by the datasource variants (#2744). Extends
 * {@link WorkspaceInstallRow} with the additional admin-UI fields the
 * `/admin/connections` list / detail endpoints surface: derived `dbType`,
 * masked URL (never the ciphertext), status, description, schema, and
 * group binding. The facade owns masking so the route can spread the row
 * verbatim — no chance of leaking a decrypted URL.
 */
export interface DatasourceInstallRow extends WorkspaceInstallRow {
  readonly pillar: "datasource";
  /** Derived from `catalogSlug` via {@link catalogSlugToDbType}. */
  readonly dbType: BuiltinDatasourceDbType;
  readonly status: "draft" | "published" | "archived";
  /** Masked URL for native dbTypes; `null` when no URL applies (Salesforce, BigQuery service-account, …). */
  readonly maskedUrl: string | null;
  readonly description: string | null;
  readonly schema: string | null;
  readonly groupId: string | null;
}

/**
 * Input to `installDatasource`. The caller (`/admin/connections` POST)
 * collects the per-`db_type` form fields and atlasMode from the request,
 * and supplies them here as opaque `formData`. The facade encrypts
 * `secret: true` fields according to the catalog row's `config_schema`,
 * resolves the pool config as a dry-run validator, and writes the row
 * with `status` derived from `atlasMode` (draft when editing in
 * developer mode, published in published mode).
 *
 * `installId` is the user-facing per-instance identifier (`prod-us`,
 * `warehouse`, etc.). Validated against `^[a-z][a-z0-9_-]*$`; `default`
 * is reserved; the historical `__demo__` sentinel is exempted because
 * migration 0094 backfilled it verbatim.
 */
export interface DatasourceInstallInput {
  readonly installId: string;
  /** Raw form payload — `url`, `schema?`, `description?`, plus per-dbType fields. */
  readonly formData: Record<string, unknown>;
  /** When `undefined`, the install lands ungrouped. When a string, written verbatim into `config.group_id`. */
  readonly groupId?: string | null;
  /** Caller's resolved Atlas mode; the facade maps `draft` → `status='draft'`, `published` → `status='published'`. */
  readonly atlasMode: "draft" | "published";
}

/**
 * Partial-update input for `updateDatasourceConfig`. Each field is
 * independently optional so the route can express the three legacy
 * shapes (config edit, group reassignment, status patch) without
 * sending the whole row.
 *
 * `partialConfig` is merged onto the existing decrypted config and
 * validated against the catalog `config_schema`. `groupId === null`
 * removes the group binding; `groupId === undefined` leaves it
 * untouched. `status` is the demo hide/show path (`archived` ↔
 * `published`); when omitted the existing status is preserved.
 */
export interface DatasourceUpdateInput {
  readonly partialConfig?: Record<string, unknown>;
  readonly groupId?: string | null;
  readonly status?: "draft" | "published" | "archived";
  /**
   * When `partialConfig` is non-empty AND `atlasMode === "draft"`, the
   * facade downgrades `status` to `draft` (matching the legacy
   * `/admin/connections` PUT behavior — see #2177). Omit to preserve
   * the existing status regardless of mode.
   */
  readonly atlasMode?: "draft" | "published";
}

/**
 * Discriminated input to `install`. Three install models, three input
 * shapes — the handler dispatch already encodes this taxonomy so the
 * facade mirrors it rather than inventing a wider envelope.
 */
export type InstallInput =
  | {
      readonly kind: "form";
      /** Raw form body — per-handler Zod schema does the real validation. */
      readonly formData: Record<string, unknown>;
    }
  | {
      readonly kind: "oauth-start";
    }
  | {
      readonly kind: "oauth-callback";
      readonly code: string;
      readonly stateToken: string;
    }
  | {
      readonly kind: "static-bot";
      readonly routingIdentifier: string;
      readonly verificationProof?: string;
      /**
       * Optional extra config fields beyond the routing identifier.
       * Maps to the per-Platform `config_schema` declared in the catalog
       * row (e.g. Telegram's `display_name`). The handler interprets
       * the shape; the facade just forwards.
       */
      readonly extras?: Record<string, unknown>;
    };

export type InstallResult =
  | {
      readonly kind: "form";
      readonly row: WorkspaceInstallRow;
      readonly credentialWritten: boolean;
    }
  | {
      readonly kind: "oauth-start";
      readonly redirectUrl: string;
      readonly stateToken: string;
    }
  | {
      readonly kind: "oauth-callback";
      readonly row: WorkspaceInstallRow | null;
      readonly credentialResult: CredentialResult | null;
    }
  | {
      readonly kind: "static-bot";
      readonly row: WorkspaceInstallRow;
    };

// ---------------------------------------------------------------------------
// Catalog helpers (DB I/O — kept as plain async functions; the Effect
// wrappers in the Live layer normalize errors)
// ---------------------------------------------------------------------------

/**
 * Slugs whose credentials live in `integration_credentials` keyed by
 * (workspace_id, catalog_id). Salesforce shipped first (#2658); Jira
 * (#2659) is the second consumer that proves the abstraction.
 *
 * Moved from `api/routes/integrations.ts` so the facade owns the
 * dispatch table for action-OAuth teardown. Per ADR-0005, adding a new
 * lazy OAuth integration is one line here + a `*-oauth-handler.ts`
 * pair + registration in `lib/integrations/install/register.ts`.
 *
 * @see docs/adr/0005-integration-credentials-table.md
 */
export const INTEGRATION_CREDENTIALS_SLUGS: ReadonlySet<string> = new Set<string>([
  "salesforce",
  "jira",
  // #2750 — Linear OAuth mode. The API-key mode (`linear-apikey`)
  // intentionally is NOT in this set: its credentials live inline in
  // `workspace_plugins.config` via selective-field encryption, so the
  // standard `workspace_plugins` DELETE teardown is sufficient. Only
  // OAuth installs that hydrate `integration_credentials` need
  // dual-store teardown.
  "linear",
]);

interface CatalogRow {
  readonly id: string;
  readonly slug: string;
  readonly install_model: CatalogInstallModel;
  readonly pillar: "chat" | "action" | "datasource";
  readonly config_schema: unknown;
  readonly enabled: boolean;
}

interface CatalogRowFromDb extends Record<string, unknown> {
  readonly id: string;
  readonly slug: string;
  readonly install_model: string;
  readonly pillar: string;
  readonly config_schema: unknown;
  readonly enabled: boolean;
}

function isValidInstallModel(value: string): value is CatalogInstallModel {
  return value === "oauth" || value === "form" || value === "static-bot";
}

function isValidPillar(value: string): value is "chat" | "action" | "datasource" {
  return value === "chat" || value === "action" || value === "datasource";
}

/**
 * Catalog lookup for the install path — requires `enabled = true`. The
 * caller may opt to read disabled rows (for disconnect of a kill-switched
 * row) via {@link loadCatalogRowForDisconnect}.
 */
async function loadCatalogRowForInstall(slug: string): Promise<CatalogRow | null> {
  const rows = await lazyInternalQuery()<CatalogRowFromDb>(
    `SELECT id, slug, install_model, pillar, config_schema, enabled
       FROM plugin_catalog
      WHERE slug = $1 AND enabled = true
      LIMIT 1`,
    [slug],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!isValidInstallModel(row.install_model)) {
    log.warn(
      { slug, install_model: row.install_model },
      "Catalog row has unknown install_model — refusing install",
    );
    return null;
  }
  if (!isValidPillar(row.pillar)) {
    log.warn({ slug, pillar: row.pillar }, "Catalog row has unknown pillar — refusing install");
    return null;
  }
  return {
    id: row.id,
    slug: row.slug,
    install_model: row.install_model,
    pillar: row.pillar,
    config_schema: row.config_schema,
    enabled: row.enabled,
  };
}

/**
 * Catalog lookup for uninstall — accepts disabled rows. Disconnect must
 * succeed even when ops has kill-switched a Platform; otherwise the kill
 * switch strands existing installs with no admin-visible UI.
 */
async function loadCatalogRowForDisconnect(slug: string): Promise<CatalogRow | null> {
  const rows = await lazyInternalQuery()<CatalogRowFromDb>(
    `SELECT id, slug, install_model, pillar, config_schema, enabled
       FROM plugin_catalog
      WHERE slug = $1
      LIMIT 1`,
    [slug],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!isValidInstallModel(row.install_model)) return null;
  if (!isValidPillar(row.pillar)) return null;
  return {
    id: row.id,
    slug: row.slug,
    install_model: row.install_model,
    pillar: row.pillar,
    config_schema: row.config_schema,
    enabled: row.enabled,
  };
}

/**
 * Find an install row by (workspace, catalog). Returns null when none
 * exists. For chat/action pillars at most one row is expected (singleton
 * partial unique index from slice 1, #2739); datasource installs are
 * out of scope for the facade.
 */
async function findInstallRow(
  workspaceId: string,
  catalogId: string,
): Promise<{ id: string; installId: string; teamId: string | null } | null> {
  const rows = await lazyInternalQuery()<{
    id: string;
    install_id: string;
    team_id: string | null;
  }>(
    `SELECT id, install_id, config->>'team_id' AS team_id
       FROM workspace_plugins
      WHERE workspace_id = $1 AND catalog_id = $2
      LIMIT 1`,
    [workspaceId, catalogId],
  );
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    installId: rows[0].install_id,
    teamId: rows[0].team_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Config-schema validation
// ---------------------------------------------------------------------------

/**
 * Validate `config` against the catalog's `config_schema`. Returns a
 * tagged error on missing-required / wrong-type. Per-handler Zod
 * validation is the source of truth for richer shape rules; this layer
 * catches catalog-contract violations the handler would otherwise see
 * as opaque "unrecognized field" / "missing field" errors.
 *
 * Three-state schema handling matches `parseConfigSchema`:
 *   - `absent` / empty fields → pass through (catalog hasn't declared
 *     a schema; per-handler validation is the only gate).
 *   - `corrupt` → log + pass through. The encryption walker already
 *     fail-closes by encrypting every string; surfacing 400 here would
 *     break installs on a transient catalog drift, which is the wrong
 *     posture for a misconfigured operator.
 *   - `parsed` → enforce required + basic type checks.
 */
function validateAgainstConfigSchema(
  catalogSlug: string,
  rawConfigSchema: unknown,
  config: Record<string, unknown>,
): ConfigSchemaError | null {
  const schema = parseConfigSchema(rawConfigSchema);
  if (schema.state === "absent") return null;
  if (schema.state === "corrupt") {
    log.warn(
      { catalogSlug, reason: schema.reason },
      "Catalog config_schema is corrupt — skipping facade-level validation (per-handler validation still runs)",
    );
    return null;
  }
  if (schema.fields.length === 0) return null;

  const fieldErrors: Record<string, string[]> = {};
  const formErrors: string[] = [];

  for (const field of schema.fields) {
    const value = config[field.key];
    const present = value !== undefined && value !== null && value !== "";
    if (field.required === true && !present) {
      (fieldErrors[field.key] ??= []).push(`${field.key} is required`);
      continue;
    }
    if (!present) continue;
    switch (field.type) {
      case "string":
      case "select":
        if (typeof value !== "string") {
          (fieldErrors[field.key] ??= []).push(`${field.key} must be a string`);
        }
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) {
          (fieldErrors[field.key] ??= []).push(`${field.key} must be a number`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          (fieldErrors[field.key] ??= []).push(`${field.key} must be a boolean`);
        }
        break;
      default: {
        // Unknown type in catalog — log and skip; treat as pass.
        log.warn(
          { catalogSlug, field: field.key, type: field.type },
          "Catalog config_schema field has unknown type — skipping facade-level type check",
        );
      }
    }
  }

  if (Object.keys(fieldErrors).length === 0 && formErrors.length === 0) return null;

  const readonlyFieldErrors: Record<string, readonly string[]> = {};
  for (const [k, v] of Object.entries(fieldErrors)) readonlyFieldErrors[k] = v;

  return new ConfigSchemaError({
    message: `Config for "${catalogSlug}" failed validation against plugin_catalog.config_schema.`,
    catalogSlug,
    fieldErrors: readonlyFieldErrors,
    formErrors,
  });
}

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

export interface WorkspaceInstallerShape {
  /**
   * Install a Platform for the given workspace. Dispatches by
   * `catalog.install_model` and the discriminant on `input.kind`. The
   * pillar-singleton check fires first; the catalog-schema validation
   * fires for `kind: "form"` only (OAuth callback payloads aren't
   * config-shaped, and `oauth-start` is a redirect-mint, not a write).
   *
   * Note: `oauth-callback` may return `row: null` when the state token
   * is forged / expired — the handler returns `null` and the route
   * layer surfaces the standard `invalid_state` toast.
   */
  readonly install: (
    workspaceId: WorkspaceId,
    catalogSlug: string,
    input: InstallInput,
  ) => Effect.Effect<InstallResult, InstallError>;

  /**
   * Disconnect a Platform install. Tears down both stores in the order
   * mandated by ADR-0003 / ADR-0005: credentials FIRST, install row
   * SECOND. The credential store is selected by slug:
   *   - `slack` → `chat_cache` (ADR-0003)
   *   - {@link INTEGRATION_CREDENTIALS_SLUGS} → `integration_credentials`
   *     (ADR-0005)
   *   - form-based slugs → no separate credential store; the secrets
   *     are inside `workspace_plugins.config` JSONB and disappear with
   *     the row.
   *
   * `installId` is optional — chat/action pillars are singleton per
   * (workspace, catalog), so the row is unambiguous without it. Reserved
   * for slice 6 (#2744) when datasource installs land with N rows per
   * (workspace, catalog).
   */
  readonly uninstall: (
    workspaceId: WorkspaceId,
    catalogSlug: string,
    installId?: string,
  ) => Effect.Effect<void, InstallError>;

  /**
   * Update `config` on an existing install row. Validates the merged
   * (existing + partial) config against the catalog's `config_schema`,
   * encrypts `secret: true` fields, and writes through. Per ADR-0005,
   * OAuth-managed credential fields stay in their store-of-record —
   * `updateConfig` only mutates `workspace_plugins.config`.
   */
  readonly updateConfig: (
    workspaceId: WorkspaceId,
    catalogSlug: string,
    installId: string,
    partialConfig: Record<string, unknown>,
  ) => Effect.Effect<WorkspaceInstallRow, InstallError>;

  // ── Datasource pillar (#2744 / ADR-0007) ─────────────────────────
  //
  // Datasource installs have a fundamentally different contract from
  // chat/action: `installId` is caller-provided (user-facing slug like
  // `prod-us`), multi-instance per `(workspace, catalog)`, no OAuth
  // dance for the native form-installed dbTypes, and participates in
  // the content-mode system via `workspace_plugins.status`. The three
  // methods below are the unified-pipeline replacement for the legacy
  // `/admin/connections` route's direct `connections` INSERT/UPDATE/
  // DELETE SQL.

  /**
   * Create a datasource install for the given workspace. Validates the
   * `installId` slug (`^[a-z][a-z0-9_-]*$`; `default` reserved), encrypts
   * `secret: true` fields per the catalog `config_schema`, resolves the
   * decrypted config as a dry-run to surface required-field errors with
   * per-`db_type` accuracy, writes the `workspace_plugins` row with
   * `status` derived from `input.atlasMode`, and registers the resulting
   * native pool with the `ConnectionRegistry` via
   * `registerDatasourceInstall` (for plugin-managed dbTypes this builds the
   * connection from the registered plugin's `createFromConfig` — #3253 seam).
   *
   * Route ownership of `connection.healthCheck()` is preserved: the
   * route does its pre-flight test against a freshly-registered pool,
   * THEN calls this method. The bridge's `has()` guard means the
   * post-install register is a no-op when the route pre-registered.
   *
   * Returns the persisted row with `maskedUrl` already shaped — callers
   * never see decrypted secrets.
   */
  readonly installDatasource: (
    workspaceId: WorkspaceId,
    catalogSlug: string,
    input: DatasourceInstallInput,
  ) => Effect.Effect<DatasourceInstallRow, InstallError>;

  /**
   * Archive (default) or hard-delete a datasource install. `status` →
   * `'archived'` is the soft path — the row stays so the admin can
   * unarchive later via `updateDatasourceConfig({ status: 'published' })`.
   * The hard path (`options.hard = true`) DELETEs and is reserved for
   * tooling / migration scripts; the admin UI uses soft archive
   * exclusively.
   *
   * Both paths call `unregisterDatasourceInstall(workspaceId, installId)` so
   * live queries against the install fail-closed immediately, matching the
   * legacy route's `connections.unregister` side-effect.
   */
  readonly uninstallDatasource: (
    workspaceId: WorkspaceId,
    catalogSlug: string,
    installId: string,
    options?: { readonly hard?: boolean },
  ) => Effect.Effect<void, InstallError>;

  /**
   * Patch an existing datasource install. Each `patch` field is
   * independent: `partialConfig` merges + re-encrypts, `groupId` is set
   * verbatim into `config.group_id` (or removed when `null`), `status`
   * drives the content-mode column. When `partialConfig` is non-empty
   * and `patch.atlasMode === 'draft'`, status is downgraded to `'draft'`
   * — matching the legacy PUT behavior that #2177 documented.
   *
   * URL changes are NOT registered automatically; the route owns the
   * test-connect-then-update dance. After a successful write the
   * facade does call `unregisterDatasourceInstall(workspaceId, installId)` to
   * evict the now-stale pool — the next query rebuilds from the new config.
   */
  readonly updateDatasourceConfig: (
    workspaceId: WorkspaceId,
    catalogSlug: string,
    installId: string,
    patch: DatasourceUpdateInput,
  ) => Effect.Effect<DatasourceInstallRow, InstallError>;
}

export class WorkspaceInstaller extends Context.Tag("WorkspaceInstaller")<
  WorkspaceInstaller,
  WorkspaceInstallerShape
>() {}

// ---------------------------------------------------------------------------
// Datasource helpers (#2744)
// ---------------------------------------------------------------------------

/**
 * Slug pattern enforced for caller-provided `installId` on the datasource
 * pillar. Matches the legacy `/admin/connections` POST regex (lowercase
 * leading char + letters/digits/`_`/`-`). `__demo__` was backfilled by
 * migration 0094 and bypasses the pattern check — it's the one historical
 * sentinel preserved across the cutover.
 */
const DATASOURCE_INSTALL_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Reserved ids the facade rejects unconditionally. */
const RESERVED_INSTALL_IDS: ReadonlySet<string> = new Set<string>(["default"]);

/**
 * Validate a caller-provided install_id. Returns an `InvalidInstallIdError`
 * on the E channel when the slug is empty, fails the pattern, or hits the
 * reserved list. `__demo__` is permitted (pattern bypass) so per-workspace
 * demo backfills round-trip through updateDatasourceConfig cleanly.
 */
function validateInstallId(installId: string): InvalidInstallIdError | null {
  if (installId === "__demo__") return null;
  if (RESERVED_INSTALL_IDS.has(installId)) {
    return new InvalidInstallIdError({
      message: `install_id "${installId}" is reserved — pick a different name.`,
      installId,
      reason: "reserved",
    });
  }
  if (!DATASOURCE_INSTALL_ID_PATTERN.test(installId)) {
    return new InvalidInstallIdError({
      message: `install_id "${installId}" must match ${DATASOURCE_INSTALL_ID_PATTERN.source} (lowercase letter, then letters/digits/underscores/hyphens).`,
      installId,
      reason: "pattern",
    });
  }
  return null;
}

/**
 * The resolver throws plain `Error` with messages like
 * `DatasourcePoolResolver(postgres): missing required field \`url\``. Wrap
 * those as `ConfigSchemaError` so the admin UI gets a consistent
 * `fieldErrors` / `formErrors` envelope — extract the field name from the
 * message when possible.
 *
 * The format is `DatasourcePoolResolver(<dbtype>): <reason>` where reason
 * is one of `missing required field \`<field>\``, `invalid schema "..."`,
 * etc. We grep for the backticked field, falling back to formErrors.
 */
function resolverErrorToConfigSchemaError(
  catalogSlug: string,
  err: Error,
): ConfigSchemaError {
  const msg = err.message;
  const fieldMatch = msg.match(/`([^`]+)`/);
  if (fieldMatch && fieldMatch[1]) {
    return new ConfigSchemaError({
      message: `Datasource config for "${catalogSlug}" failed resolver validation.`,
      catalogSlug,
      fieldErrors: { [fieldMatch[1]]: [msg] },
      formErrors: [],
    });
  }
  return new ConfigSchemaError({
    message: `Datasource config for "${catalogSlug}" failed resolver validation.`,
    catalogSlug,
    fieldErrors: {},
    formErrors: [msg],
  });
}

/**
 * Shape a `DatasourceInstallRow` from the persisted row data plus the
 * decrypted config. Masking happens here — the route never sees
 * decrypted secrets. `maskedUrl` is `null` for dbTypes that don't carry a
 * URL (Salesforce, BigQuery service-account).
 *
 * Pure: same inputs always produce the same output. Resolver re-runs to
 * pick the `dbType` discriminant since the row only carries
 * `catalogSlug`.
 */
function shapeDatasourceRow(args: {
  rowId: string;
  workspaceId: WorkspaceId;
  catalogId: string;
  catalogSlug: string;
  installId: string;
  status: "draft" | "published" | "archived";
  decryptedConfig: Readonly<Record<string, unknown>>;
}): DatasourceInstallRow {
  const dbType = catalogSlugToDbType(args.catalogSlug);
  const cfg = args.decryptedConfig;

  const urlValue =
    typeof cfg.url === "string" && cfg.url.length > 0 ? cfg.url : null;
  const maskedUrl =
    urlValue !== null &&
    (dbType === "postgres" || dbType === "mysql" || dbType === "snowflake" ||
      dbType === "clickhouse")
      ? maskConnectionUrl(urlValue)
      : null;

  const description =
    typeof cfg.description === "string" && cfg.description.length > 0
      ? cfg.description
      : null;
  const schema =
    typeof cfg.schema === "string" && cfg.schema.length > 0 ? cfg.schema : null;
  const groupId =
    typeof cfg.group_id === "string" && cfg.group_id.length > 0
      ? cfg.group_id
      : null;

  return {
    id: args.rowId,
    workspaceId: args.workspaceId,
    catalogSlug: args.catalogSlug,
    catalogId: args.catalogId,
    pillar: "datasource",
    installId: args.installId,
    dbType,
    status: args.status,
    maskedUrl,
    description,
    schema,
    groupId,
  };
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

/**
 * Build the Live `WorkspaceInstaller` service. `Layer.effect` (not
 * `Layer.scoped`) — there's no per-service finalizer; every DB call is
 * via the shared `internalQuery` pool which lives on its own scope.
 */
export const WorkspaceInstallerLive: Layer.Layer<WorkspaceInstaller> = Layer.effect(
  WorkspaceInstaller,
  Effect.sync(() => makeWorkspaceInstallerService()),
);

function makeWorkspaceInstallerService(): WorkspaceInstallerShape {
  const installImpl: WorkspaceInstallerShape["install"] = (workspaceId, catalogSlug, input) =>
    Effect.gen(function* () {
      const catalog = yield* Effect.tryPromise({
        try: () => loadCatalogRowForInstall(catalogSlug),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => Effect.die(err)),
      );
      if (catalog === null) {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Unknown or disabled catalog slug "${catalogSlug}".`,
            catalogSlug,
          }),
        );
      }

      // Pillar guard — datasource installs flow through `installDatasource`
      // (multi-instance per `(workspace, catalog)`; user-supplied
      // `install_id`). Falling into this method with a datasource catalog
      // is a route-layer regression, not a runtime case to handle.
      if (catalog.pillar === "datasource") {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Catalog "${catalogSlug}" is pillar 'datasource' — route through WorkspaceInstaller.installDatasource instead.`,
            catalogSlug,
          }),
        );
      }
      const pillar: "chat" | "action" = catalog.pillar;

      // ── Pillar singleton check ───────────────────────────────────
      // OAuth-start is a redirect-mint with no DB write, so the check
      // is mostly defensive there — but doing it up-front spares the
      // user a doomed redirect → callback round-trip. Form / OAuth-
      // callback / static-bot all write, so the check is load-bearing.
      const existing = yield* Effect.tryPromise({
        try: () => findInstallRow(workspaceId, catalog.id),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => Effect.die(err)),
      );
      // For OAuth callback we DO allow re-install (the handler's UPSERT
      // on `(workspace_id, catalog_id)` is the documented Reconnect
      // path). The singleton invariant is "at most one row", not "first
      // install wins" — re-issuing the OAuth dance for the same Platform
      // is the canonical recovery path per ADR-0003.
      if (existing && input.kind !== "oauth-callback") {
        return yield* Effect.fail(
          new AlreadyInstalledError({
            message: `${pillar === "chat" ? "Chat" : "Action"} platform "${catalogSlug}" is already installed for this workspace. Disconnect first to reinstall.`,
            workspaceId,
            catalogSlug,
            pillar,
          }),
        );
      }

      // Dispatch to handler.
      const handler = yield* Effect.try({
        try: () =>
          lazyGetInstallHandler()({
            slug: catalog.slug,
            install_model: catalog.install_model,
          } satisfies CatalogRowForDispatch),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        // No-handler-registered is a route-level concern (501) — surface
        // as a defect so `classifyError` falls through to the generic
        // 500. Route handlers can pre-check via `try { getInstallHandler }`
        // when they want a 501 instead.
        Effect.catchAll((err) => Effect.die(err)),
      );

      switch (input.kind) {
        case "form": {
          if (handler.kind !== "form") {
            // Catalog and dispatch agree on `install_model: "form"`, so
            // this is a config drift the route layer should have caught.
            return yield* Effect.die(
              new Error(
                `Catalog "${catalogSlug}" install_model is "${catalog.install_model}" — refusing form install via WorkspaceInstaller.`,
              ),
            );
          }
          // Catalog-schema validation (chat/action) — fires before the
          // per-handler Zod schema so the admin UI gets a consistent
          // 400-with-fieldErrors envelope regardless of handler.
          const schemaErr = validateAgainstConfigSchema(
            catalogSlug,
            catalog.config_schema,
            input.formData,
          );
          if (schemaErr) return yield* Effect.fail(schemaErr);

          // Delegate to the form handler — it owns Zod validation +
          // selective-field encryption + the `workspace_plugins` upsert.
          // Schema-driven `encryptSecretFields` is invoked inside the
          // handler today (see Email's handler for the canonical
          // shape); the facade does NOT re-encrypt to avoid the
          // `enc:v1:enc:v1:` double-encryption hazard. Idempotence
          // guards in `encryptSecretFields` would catch a double-call
          // anyway, but the right answer is to not call twice.
          const result = yield* Effect.tryPromise({
            try: () => handler.validateConfig(workspaceId, input.formData),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            // Handler-tagged validation errors (e.g.
            // `FormInstallValidationError`) bubble up as defects so the
            // route's existing `instanceof` catch still runs. Promoting
            // those into the facade's E channel would require teaching
            // `mapTaggedError` about the legacy class — out of scope for
            // slice 4 per the issue's "behavior-preserving refactor" bar.
            Effect.catchAll((err) => Effect.die(err)),
          );
          return {
            kind: "form" as const,
            row: {
              id: result.installRecord.id,
              workspaceId,
              catalogSlug: result.installRecord.catalogId,
              catalogId: catalog.id,
              pillar,
              installId: result.installRecord.id,
            },
            credentialWritten: result.credentialWritten,
          } satisfies InstallResult;
        }
        case "oauth-start": {
          if (handler.kind !== "oauth") {
            return yield* Effect.die(
              new Error(
                `Catalog "${catalogSlug}" install_model is "${catalog.install_model}" — refusing OAuth start via WorkspaceInstaller.`,
              ),
            );
          }
          const { redirectUrl, stateToken } = yield* Effect.tryPromise({
            try: () => handler.startInstall(workspaceId),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(Effect.catchAll((err) => Effect.die(err)));
          return { kind: "oauth-start" as const, redirectUrl, stateToken } satisfies InstallResult;
        }
        case "oauth-callback": {
          if (handler.kind !== "oauth") {
            return yield* Effect.die(
              new Error(
                `Catalog "${catalogSlug}" install_model is "${catalog.install_model}" — refusing OAuth callback via WorkspaceInstaller.`,
              ),
            );
          }
          const callbackResult = yield* Effect.tryPromise({
            try: () => handler.handleCallback(input.code, input.stateToken),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            // `PlatformOAuthExchangeError` and other tagged errors
            // bubble through as defects → `classifyError` maps them. The
            // route's `prefersHtml` redirect path runs in the route
            // wrapper, not here.
            Effect.catchAll((err) => Effect.die(err)),
          );
          if (callbackResult === null) {
            return {
              kind: "oauth-callback" as const,
              row: null,
              credentialResult: null,
            } satisfies InstallResult;
          }
          return {
            kind: "oauth-callback" as const,
            row: {
              id: callbackResult.installRecord.id,
              workspaceId: callbackResult.workspaceId,
              catalogSlug: callbackResult.catalogId,
              catalogId: catalog.id,
              pillar,
              installId: callbackResult.installRecord.id,
            },
            credentialResult: callbackResult.credentialResult,
          } satisfies InstallResult;
        }
        case "static-bot": {
          if (handler.kind !== "static-bot") {
            return yield* Effect.die(
              new Error(
                `Catalog "${catalogSlug}" install_model is "${catalog.install_model}" — refusing static-bot install via WorkspaceInstaller.`,
              ),
            );
          }
          const result = yield* Effect.tryPromise({
            try: () =>
              handler.confirmInstall(
                workspaceId,
                input.routingIdentifier,
                input.verificationProof,
                input.extras,
              ),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(Effect.catchAll((err) => Effect.die(err)));
          return {
            kind: "static-bot" as const,
            row: {
              id: result.installRecord.id,
              workspaceId,
              catalogSlug: result.installRecord.catalogId,
              catalogId: catalog.id,
              pillar,
              installId: result.installRecord.id,
            },
          } satisfies InstallResult;
        }
        default: {
          const _exhaustive: never = input;
          return yield* Effect.die(
            new Error(`Unknown InstallInput kind: ${String(_exhaustive)}`),
          );
        }
      }
    });

  const uninstallImpl: WorkspaceInstallerShape["uninstall"] = (
    workspaceId,
    catalogSlug,
    // installId reserved for slice 6 datasource multi-instance disconnect;
    // chat/action pillars are singleton so the slug alone identifies the row.
    _installId,
  ) =>
    Effect.gen(function* () {
      const catalog = yield* Effect.tryPromise({
        try: () => loadCatalogRowForDisconnect(catalogSlug),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));
      if (catalog === null) {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Unknown catalog slug "${catalogSlug}".`,
            catalogSlug,
          }),
        );
      }
      if (catalog.pillar === "datasource") {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Catalog "${catalogSlug}" is pillar 'datasource' — route through WorkspaceInstaller.uninstallDatasource instead.`,
            catalogSlug,
          }),
        );
      }

      const row = yield* Effect.tryPromise({
        try: () => findInstallRow(workspaceId, catalog.id),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));
      if (row === null) {
        return yield* Effect.fail(
          new InstallNotFoundError({
            message: `No ${catalogSlug} install found for this workspace.`,
            workspaceId,
            catalogSlug,
          }),
        );
      }

      // ── Two-store teardown (ADR-0003 order is load-bearing) ──────
      // 1) Credential row FIRST — credentials must not outlive the
      //    install record. A failure here propagates and the
      //    workspace_plugins row is preserved so the admin can retry.
      // 2) workspace_plugins SECOND. A failure here leaves the install
      //    row dangling but credentials are already gone (recoverable).
      yield* Effect.tryPromise({
        try: () => deleteCredentialStoreForSlug(catalogSlug, workspaceId, catalog.id, row.teamId),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));

      yield* Effect.tryPromise({
        try: () =>
          lazyInternalQuery()(
            `DELETE FROM workspace_plugins
              WHERE workspace_id = $1 AND catalog_id = $2`,
            [workspaceId, catalog.id],
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));

      // #3180 — clean up plugin-owned scheduled tasks so the scheduler doesn't
      // keep firing them after disconnect, mirroring the marketplace DELETE
      // path (admin-marketplace.ts). Scoped by (plugin_id = catalog_id,
      // org_id = workspace_id) — exactly the pair the orphan guard in
      // getTasksDueForExecution and the orphan-reconcile sweep use. Without
      // this, WorkspaceInstaller disconnects were asymmetric with the
      // marketplace path and left tasks behind. Best-effort (matches the
      // marketplace posture): the install row is already gone, so a transient
      // internal-DB hiccup must not strand the uninstall — and the
      // execution-time guard skips the orphan + the reconcile fiber sweeps it.
      yield* Effect.tryPromise({
        try: () =>
          lazyInternalQuery()(
            `DELETE FROM scheduled_tasks
              WHERE plugin_id = $1 AND org_id = $2`,
            [catalog.id, workspaceId],
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => {
          log.warn(
            {
              workspaceId,
              catalogSlug,
              catalogId: catalog.id,
              err: err instanceof Error ? err.message : String(err),
            },
            "WorkspaceInstaller.uninstall: scheduled-task cleanup failed — orphan tasks are skipped by the execution-time guard and swept by the reconcile fiber",
          );
          return Effect.succeed(undefined);
        }),
      );

      // Evict the LazyPluginLoader cache for this (workspace, catalog).
      // Without this, a hot workspace whose tool dispatch warmed the
      // cache before disconnect keeps the stale `PluginLike` (and its
      // socket-holding nodemailer / jsforce / fetch transports) until
      // process restart — sends would continue after uninstall. Evict
      // teardown errors are swallowed inside the loader, so this is
      // fire-and-forget safe on the success path.
      yield* Effect.tryPromise({
        try: () => lazyPluginLoader.evict(workspaceId, catalog.id),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => {
          log.warn(
            { workspaceId, catalogSlug, err: err instanceof Error ? err.message : String(err) },
            "LazyPluginLoader.evict threw during uninstall — DB rows are cleared anyway",
          );
          return Effect.succeed(false);
        }),
      );

      log.info(
        { workspaceId, catalogSlug, pillar: catalog.pillar, teamId: row.teamId },
        "WorkspaceInstaller.uninstall completed (both stores cleared)",
      );
    });

  const updateConfigImpl: WorkspaceInstallerShape["updateConfig"] = (
    workspaceId,
    catalogSlug,
    installId,
    partialConfig,
  ) =>
    Effect.gen(function* () {
      const catalog = yield* Effect.tryPromise({
        try: () => loadCatalogRowForInstall(catalogSlug),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));
      if (catalog === null) {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Unknown or disabled catalog slug "${catalogSlug}".`,
            catalogSlug,
          }),
        );
      }
      if (catalog.pillar === "datasource") {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Catalog "${catalogSlug}" is pillar 'datasource' — route through WorkspaceInstaller.updateDatasourceConfig instead.`,
            catalogSlug,
          }),
        );
      }
      const pillar: "chat" | "action" = catalog.pillar;

      // Read existing config so the partial overlay can be schema-
      // validated against the merged shape (catalog `required` rules
      // apply to the post-merge config, not just the patch payload).
      const rows = yield* Effect.tryPromise({
        try: () =>
          lazyInternalQuery()<{
            id: string;
            install_id: string;
            config: Record<string, unknown> | null;
          }>(
            `SELECT id, install_id, config
               FROM workspace_plugins
              WHERE workspace_id = $1 AND catalog_id = $2 AND install_id = $3
              LIMIT 1`,
            [workspaceId, catalog.id, installId],
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));
      if (rows.length === 0) {
        return yield* Effect.fail(
          new InstallNotFoundError({
            message: `No ${catalogSlug} install found for installId "${installId}".`,
            workspaceId,
            catalogSlug,
          }),
        );
      }
      const existingConfig = rows[0].config ?? {};
      const mergedConfig: Record<string, unknown> = {
        ...existingConfig,
        ...partialConfig,
      };

      // Catalog-schema validation against the merged config.
      const schemaErr = validateAgainstConfigSchema(
        catalogSlug,
        catalog.config_schema,
        mergedConfig,
      );
      if (schemaErr) return yield* Effect.fail(schemaErr);

      // Encrypt secrets. `encryptSecretFields` is idempotent against
      // already-`enc:v1:` ciphertext, so re-encrypting the existing
      // (already-encrypted) values on a partial update is a no-op.
      const schema = parseConfigSchema(catalog.config_schema);
      const encryptedConfig = encryptSecretFields(mergedConfig, schema);

      yield* Effect.tryPromise({
        try: () =>
          lazyInternalQuery()(
            `UPDATE workspace_plugins
                SET config = $1::jsonb,
                    updated_at = NOW()
              WHERE workspace_id = $2 AND catalog_id = $3 AND install_id = $4`,
            [JSON.stringify(encryptedConfig), workspaceId, catalog.id, installId],
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));

      // Evict the LazyPluginLoader cache so the next tool dispatch reads
      // the freshly-updated config (e.g. rotated SMTP password) instead
      // of the stale in-memory transport built from the previous row.
      yield* Effect.tryPromise({
        try: () => lazyPluginLoader.evict(workspaceId, catalog.id),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => {
          log.warn(
            { workspaceId, catalogSlug, installId, err: err instanceof Error ? err.message : String(err) },
            "LazyPluginLoader.evict threw during updateConfig — DB row updated anyway",
          );
          return Effect.succeed(false);
        }),
      );

      log.info(
        { workspaceId, catalogSlug, installId, pillar },
        "WorkspaceInstaller.updateConfig completed",
      );

      return {
        id: rows[0].id,
        workspaceId,
        catalogSlug,
        catalogId: catalog.id,
        pillar,
        installId: rows[0].install_id,
      } satisfies WorkspaceInstallRow;
    });

  // ── Datasource pillar (#2744 / ADR-0007) ─────────────────────────

  const installDatasourceImpl: WorkspaceInstallerShape["installDatasource"] = (
    workspaceId,
    catalogSlug,
    input,
  ) =>
    Effect.gen(function* () {
      const installIdErr = validateInstallId(input.installId);
      if (installIdErr) return yield* Effect.fail(installIdErr);

      const catalog = yield* Effect.tryPromise({
        try: () => loadCatalogRowForInstall(catalogSlug),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));
      if (catalog === null) {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Unknown or disabled catalog slug "${catalogSlug}".`,
            catalogSlug,
          }),
        );
      }
      if (catalog.pillar !== "datasource") {
        // Symmetric to the rejection in `install` — route through the
        // pillar-correct method.
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Catalog "${catalogSlug}" is pillar '${catalog.pillar}' — route through WorkspaceInstaller.install instead.`,
            catalogSlug,
          }),
        );
      }

      // Catalog `config_schema` validation — required-field + type-shape.
      // Per-`db_type` required-field rules (e.g. bigquery needing
      // `project_id` + `service_account_json`) are enforced by the
      // resolver dry-run below; this layer catches missing fields the
      // catalog declared.
      const schemaErr = validateAgainstConfigSchema(
        catalogSlug,
        catalog.config_schema,
        input.formData,
      );
      if (schemaErr) return yield* Effect.fail(schemaErr);

      // Resolver dry-run — surface per-`db_type` required-field violations
      // (e.g. invalid Postgres schema identifier) as a catalog-schema
      // error so the admin UI can render the message in-context. Convert
      // any Error from the resolver into a ConfigSchemaError keyed by
      // the field name when we can extract it; otherwise dump to
      // formErrors. Wrapped in `Effect.try` so the throw is folded into
      // the E channel rather than killed as a defect.
      const dryRun = yield* Effect.try({
        try: () =>
          resolveDatasourcePoolConfig(
            {
              workspaceId,
              catalogId: catalog.id,
              installId: input.installId,
              pillar: "datasource",
              catalogSlug,
            },
            input.formData,
          ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.matchEffect({
          onFailure: (err) =>
            Effect.fail(resolverErrorToConfigSchemaError(catalogSlug, err)),
          onSuccess: (cfg) => Effect.succeed(cfg),
        }),
      );

      // Singleton pre-check — collision on `(workspace, catalog, install_id)`.
      // The composite PK is the DB backstop; this pre-check produces a
      // friendlier 409 with `pillar: 'datasource'`.
      const existing = yield* Effect.tryPromise({
        try: () =>
          lazyInternalQuery()<{ install_id: string }>(
            `SELECT install_id
               FROM workspace_plugins
              WHERE workspace_id = $1 AND catalog_id = $2 AND install_id = $3
              LIMIT 1`,
            [workspaceId, catalog.id, input.installId],
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));
      if (existing.length > 0) {
        return yield* Effect.fail(
          new AlreadyInstalledError({
            message: `Datasource "${catalogSlug}" with install_id "${input.installId}" already exists in this workspace.`,
            workspaceId,
            catalogSlug,
            pillar: "datasource",
          }),
        );
      }

      // Build the config: form data (validated) + groupId. Encrypt
      // `secret: true` fields per the catalog schema. `encryptSecretFields`
      // is idempotent against already-`enc:v1:` ciphertext.
      const configBeforeEncrypt: Record<string, unknown> = {
        ...input.formData,
        ...(input.groupId !== undefined && input.groupId !== null
          ? { group_id: input.groupId }
          : {}),
      };
      const schema = parseConfigSchema(catalog.config_schema);
      const encryptedConfig = encryptSecretFields(configBeforeEncrypt, schema);

      const status: "draft" | "published" =
        input.atlasMode === "draft" ? "draft" : "published";
      const rowId = `cn_${workspaceId.slice(0, 16)}_${input.installId}`;

      yield* Effect.tryPromise({
        try: () =>
          lazyInternalQuery()(
            `INSERT INTO workspace_plugins
               (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at, status)
             VALUES ($1, $2, $3, $4, 'datasource', $5::jsonb, true, NOW(), $6)`,
            [
              rowId,
              workspaceId,
              catalog.id,
              input.installId,
              JSON.stringify(encryptedConfig),
              status,
            ],
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));

      // Register the native pool, or (for plugin dbTypes) build the live
      // per-(workspace, install_id) plugin connection via the registered
      // plugin's createFromConfig. Idempotent for route-pre-registered pools.
      // `registerDatasourceInstall` is async (the plugin path builds a
      // connection), so it's bridged into the Effect generator here.
      yield* Effect.tryPromise({
        try: () =>
          lazyDatasourceBridge().registerDatasourceInstall(
            {
              workspaceId,
              catalogId: catalog.id,
              installId: input.installId,
              pillar: "datasource",
              catalogSlug,
            },
            input.formData,
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          // Registry rejection is best-effort post-write: the DB row landed, so
          // subsequent boots' `loadSavedConnections` will pick it up. Surface
          // the warning rather than rolling back the install — the route's
          // pre-flight test-connect would have caught a real connectivity issue.
          Effect.sync(() => {
            log.warn(
              {
                workspaceId,
                installId: input.installId,
                catalogSlug,
                err: err instanceof Error ? err.message : String(err),
              },
              "registerDatasourceInstall threw post-install — row persisted; next boot will reload",
            );
          }),
        ),
      );

      log.info(
        { workspaceId, catalogSlug, installId: input.installId, dbType: dryRun.dbType, status },
        "WorkspaceInstaller.installDatasource completed",
      );

      return shapeDatasourceRow({
        rowId,
        workspaceId,
        catalogId: catalog.id,
        catalogSlug,
        installId: input.installId,
        status,
        // configBeforeEncrypt carries the merged form + groupId, both in
        // plaintext — what the route needs to render the response row.
        // Never pass encryptedConfig here: shapeDatasourceRow would mask
        // an `enc:v1:…` ciphertext as if it were a URL.
        decryptedConfig: configBeforeEncrypt,
      });
    });

  const uninstallDatasourceImpl: WorkspaceInstallerShape["uninstallDatasource"] = (
    workspaceId,
    catalogSlug,
    installId,
    options,
  ) =>
    Effect.gen(function* () {
      const catalog = yield* Effect.tryPromise({
        try: () => loadCatalogRowForDisconnect(catalogSlug),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));
      if (catalog === null) {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Unknown catalog slug "${catalogSlug}".`,
            catalogSlug,
          }),
        );
      }
      if (catalog.pillar !== "datasource") {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Catalog "${catalogSlug}" is pillar '${catalog.pillar}' — route through WorkspaceInstaller.uninstall instead.`,
            catalogSlug,
          }),
        );
      }

      const hard = options?.hard === true;

      if (hard) {
        const result = yield* Effect.tryPromise({
          try: () =>
            lazyInternalQuery()<{ id: string }>(
              `DELETE FROM workspace_plugins
                WHERE workspace_id = $1 AND catalog_id = $2 AND install_id = $3
                RETURNING id`,
              [workspaceId, catalog.id, installId],
            ),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(Effect.catchAll((err) => Effect.die(err)));
        if (result.length === 0) {
          return yield* Effect.fail(
            new InstallNotFoundError({
              message: `No ${catalogSlug} install found for installId "${installId}".`,
              workspaceId,
              catalogSlug,
            }),
          );
        }
      } else {
        const result = yield* Effect.tryPromise({
          try: () =>
            lazyInternalQuery()<{ id: string }>(
              `UPDATE workspace_plugins
                  SET status = 'archived', enabled = false, updated_at = NOW()
                WHERE workspace_id = $1 AND catalog_id = $2 AND install_id = $3
                RETURNING id`,
              [workspaceId, catalog.id, installId],
            ),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(Effect.catchAll((err) => Effect.die(err)));
        if (result.length === 0) {
          return yield* Effect.fail(
            new InstallNotFoundError({
              message: `No ${catalogSlug} install found for installId "${installId}".`,
              workspaceId,
              catalogSlug,
            }),
          );
        }
      }

      // Tear the pool down whichever path we took — live queries against
      // the archived install fail-closed immediately rather than at TTL.
      try {
        lazyDatasourceBridge().unregisterDatasourceInstall(workspaceId, installId);
      } catch (err) {
        log.warn(
          {
            workspaceId,
            installId,
            catalogSlug,
            err: err instanceof Error ? err.message : String(err),
          },
          "unregisterDatasourceInstall threw — DB row archived anyway",
        );
      }

      log.info(
        { workspaceId, catalogSlug, installId, hard },
        "WorkspaceInstaller.uninstallDatasource completed",
      );
    });

  const updateDatasourceConfigImpl: WorkspaceInstallerShape["updateDatasourceConfig"] = (
    workspaceId,
    catalogSlug,
    installId,
    patch,
  ) =>
    Effect.gen(function* () {
      const catalog = yield* Effect.tryPromise({
        try: () => loadCatalogRowForInstall(catalogSlug),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));
      if (catalog === null) {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Unknown or disabled catalog slug "${catalogSlug}".`,
            catalogSlug,
          }),
        );
      }
      if (catalog.pillar !== "datasource") {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Catalog "${catalogSlug}" is pillar '${catalog.pillar}' — route through WorkspaceInstaller.updateConfig instead.`,
            catalogSlug,
          }),
        );
      }

      // Load the existing row so partials merge against the current
      // decrypted config (catalog `required` rules apply to the merged
      // shape, not just the patch).
      const rows = yield* Effect.tryPromise({
        try: () =>
          lazyInternalQuery()<{
            id: string;
            install_id: string;
            config: Record<string, unknown> | null;
            status: string;
          }>(
            `SELECT id, install_id, config, status
               FROM workspace_plugins
              WHERE workspace_id = $1 AND catalog_id = $2 AND install_id = $3
              LIMIT 1`,
            [workspaceId, catalog.id, installId],
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));
      if (rows.length === 0) {
        return yield* Effect.fail(
          new InstallNotFoundError({
            message: `No ${catalogSlug} install found for installId "${installId}".`,
            workspaceId,
            catalogSlug,
          }),
        );
      }
      const schema = parseConfigSchema(catalog.config_schema);
      const existingDecrypted = decryptSecretFields(rows[0].config ?? {}, schema);

      // Merge config patches.
      const hasConfigPatch =
        patch.partialConfig !== undefined && Object.keys(patch.partialConfig).length > 0;
      const merged: Record<string, unknown> = hasConfigPatch
        ? { ...existingDecrypted, ...patch.partialConfig }
        : { ...existingDecrypted };

      // groupId: undefined = leave alone, null = remove, string = set.
      if (patch.groupId === null) {
        delete merged.group_id;
      } else if (typeof patch.groupId === "string") {
        merged.group_id = patch.groupId;
      }

      // Catalog schema validation on the merged shape.
      const schemaErr = validateAgainstConfigSchema(catalogSlug, catalog.config_schema, merged);
      if (schemaErr) return yield* Effect.fail(schemaErr);

      // Resolver dry-run for per-`db_type` required-field rules.
      const dryRun = yield* Effect.try({
        try: () =>
          resolveDatasourcePoolConfig(
            {
              workspaceId,
              catalogId: catalog.id,
              installId,
              pillar: "datasource",
              catalogSlug,
            },
            merged,
          ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.matchEffect({
          onFailure: (err) =>
            Effect.fail(resolverErrorToConfigSchemaError(catalogSlug, err)),
          onSuccess: (cfg) => Effect.succeed(cfg),
        }),
      );

      // Status resolution:
      //   - explicit `status` on the patch wins
      //   - else: if config changed AND atlasMode === 'draft', downgrade to draft
      //   - else: preserve existing
      let nextStatus = rows[0].status;
      if (patch.status !== undefined) {
        nextStatus = patch.status;
      } else if (hasConfigPatch && patch.atlasMode === "draft") {
        nextStatus = "draft";
      }

      const encryptedConfig = encryptSecretFields(merged, schema);

      yield* Effect.tryPromise({
        try: () =>
          lazyInternalQuery()(
            // `updated_at` must be set explicitly — `simplePromoteSql` and
            // `DRAFT_ACTIVITY_SQL` read `MAX(updated_at)` post-cutover to
            // compute "last edited" recency in mode/publish UX; leaving it
            // at the row's `installed_at` value would silently hide draft
            // edits from the pending-changes pill (codex P2, #2784).
            `UPDATE workspace_plugins
                SET config = $1::jsonb,
                    status = $2,
                    enabled = ($2 != 'archived'),
                    updated_at = NOW()
              WHERE workspace_id = $3 AND catalog_id = $4 AND install_id = $5`,
            [JSON.stringify(encryptedConfig), nextStatus, workspaceId, catalog.id, installId],
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.catchAll((err) => Effect.die(err)));

      // Evict the existing pool so its open connections drain. Then —
      // unless the row is archived — re-register with the merged config
      // so subsequent queries find a live pool. `ConnectionRegistry.getForOrg`
      // does NOT lazy-load from `workspace_plugins`; a post-update query
      // against an unregistered install throws `ConnectionNotRegisteredError`
      // until next boot (codex P1, #2784).
      try {
        lazyDatasourceBridge().unregisterDatasourceInstall(workspaceId, installId);
      } catch (err) {
        log.warn(
          {
            workspaceId,
            installId,
            catalogSlug,
            err: err instanceof Error ? err.message : String(err),
          },
          "unregisterDatasourceInstall threw during updateDatasourceConfig — DB row updated anyway",
        );
      }
      if (nextStatus !== "archived") {
        yield* Effect.tryPromise({
          try: () =>
            lazyDatasourceBridge().registerDatasourceInstall(
              {
                workspaceId,
                catalogId: catalog.id,
                installId,
                pillar: "datasource",
                catalogSlug,
              },
              merged,
            ),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              log.warn(
                {
                  workspaceId,
                  installId,
                  catalogSlug,
                  err: err instanceof Error ? err.message : String(err),
                },
                "registerDatasourceInstall threw during updateDatasourceConfig — DB row updated; next query may surface ConnectionNotRegisteredError until restart",
              );
            }),
          ),
        );
      }

      log.info(
        {
          workspaceId,
          catalogSlug,
          installId,
          dbType: dryRun.dbType,
          status: nextStatus,
          configChanged: hasConfigPatch,
        },
        "WorkspaceInstaller.updateDatasourceConfig completed",
      );

      return shapeDatasourceRow({
        rowId: rows[0].id,
        workspaceId,
        catalogId: catalog.id,
        catalogSlug,
        installId: rows[0].install_id,
        status: nextStatus as "draft" | "published" | "archived",
        decryptedConfig: merged,
      });
    });

  return {
    install: installImpl,
    uninstall: uninstallImpl,
    updateConfig: updateConfigImpl,
    installDatasource: installDatasourceImpl,
    uninstallDatasource: uninstallDatasourceImpl,
    updateDatasourceConfig: updateDatasourceConfigImpl,
  } satisfies WorkspaceInstallerShape;
}

/**
 * Slug-keyed credential teardown. Dispatched off the per-Platform
 * convention rather than the catalog's `install_model`:
 *   - chat OAuth (Slack) writes to `chat_cache` keyed by `team_id`.
 *   - action OAuth (Salesforce, Jira, …) writes to `integration_credentials`
 *     keyed by (workspace, catalog).
 *   - form-based installs have no separate credential row — secrets are
 *     inside `workspace_plugins.config` and disappear with the row.
 *
 * Throws on unknown slugs whose pillar would imply a credential store
 * but no dispatch is wired — defensive backstop; the route layer should
 * surface 501 before this fires.
 */
async function deleteCredentialStoreForSlug(
  slug: string,
  workspaceId: string,
  catalogId: string,
  teamId: string | null,
): Promise<void> {
  if (slug === "slack") {
    if (!teamId) {
      // Defensive — a Slack install row should always carry team_id.
      // If it doesn't, the row is corrupted; surface as a hard error
      // so the admin disconnect attempt isn't silently a no-op.
      throw new Error(
        `Slack disconnect requires team_id from workspace_plugins.config for workspace=${workspaceId}`,
      );
    }
    // Lazy import — keeps `slack/store` and
    // `integrations/credentials/store` out of the static import graph
    // so partial `mock.module()` setups elsewhere (which intentionally
    // omit `deleteInstallation` / `deleteCredentialBundle` because
    // those tests don't exercise the disconnect path) don't trip
    // bun's "Export named 'X' not found" loader error. Production
    // perf cost is one resolver hit per disconnect call.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteInstallation } = require("@atlas/api/lib/slack/store") as {
      deleteInstallation: (teamId: string) => Promise<void>;
    };
    await deleteInstallation(teamId);
    return;
  }
  if (INTEGRATION_CREDENTIALS_SLUGS.has(slug)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteCredentialBundle } = require("@atlas/api/lib/integrations/credentials/store") as {
      deleteCredentialBundle: (workspaceId: string, catalogId: string) => Promise<boolean>;
    };
    await deleteCredentialBundle(workspaceId, catalogId);
    return;
  }
  if (slug === "twenty") {
    // Twenty CRM — credentials live in the dedicated
    // `twenty_integrations` table, not `workspace_plugins.config`. The
    // catalog DELETE removes the workspace_plugins row (step 2 of the
    // disconnect dance); this step removes the credential row so the
    // dispatcher falls back to env var (or surfaces the actionable
    // "configure under Admin → Integrations → Twenty" error).
    //
    // Lazy import for the same reason as the Slack branch above — keeps
    // the Twenty store off the static graph of test files that mock
    // `db/internal` partially.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteTwentyIntegration } = require("@atlas/api/lib/integrations/twenty/store") as {
      deleteTwentyIntegration: (workspaceId: string) => Promise<boolean>;
    };
    await deleteTwentyIntegration(workspaceId);
    return;
  }
  if (slug === "discord") {
    // Discord is dual-store: the static-bot install writes only
    // `workspace_plugins` (routing), but a self-hosted BYOT install also
    // persists a bot token to `discord_installations` (#3161 keeps that
    // table). When a workspace has both, a unified disconnect must clear the
    // BYOT credential too — otherwise `discord_installations.bot_token_encrypted`
    // is stranded and the admin has to disconnect a second time through the
    // legacy endpoint (Codex #3163). `deleteDiscordInstallationByOrg` is a no-op
    // (returns false) for a static-bot-only install with no BYOT row, so this
    // is safe in both cases. Lazy `require` mirrors the Slack/Twenty branches —
    // keeps the discord store off the static graph of partial-mock test files.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteDiscordInstallationByOrg } = require("@atlas/api/lib/discord/store") as {
      deleteDiscordInstallationByOrg: (orgId: string) => Promise<boolean>;
    };
    await deleteDiscordInstallationByOrg(workspaceId);
    return;
  }
  // Form-based / static-bot (telegram/gchat/whatsapp/teams): no separate
  // credential store; the DELETE on workspace_plugins (step 2) is the
  // credential teardown. No-op here.
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Create a test Layer for `WorkspaceInstaller` backed by a partial impl.
 * Mirrors the Proxy-stub pattern used by `createConnectionTestLayer` etc.
 * — unspecified methods throw with a descriptive error rather than
 * silently returning undefined.
 */
export function createWorkspaceInstallerTestLayer(
  partial: Partial<WorkspaceInstallerShape>,
): Layer.Layer<WorkspaceInstaller> {
  const handler: ProxyHandler<WorkspaceInstallerShape> = {
    get(_target, prop: string | symbol) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then" || prop === "toJSON") return undefined;
      if (prop in partial) {
        return (partial as Record<string, unknown>)[prop];
      }
      return (..._args: unknown[]) => {
        throw new Error(
          `WorkspaceInstaller test stub: "${String(prop)}" was called but not provided in createWorkspaceInstallerTestLayer()`,
        );
      };
    },
  };
  const stubService = new Proxy({} as WorkspaceInstallerShape, handler);
  return Layer.succeed(WorkspaceInstaller, stubService);
}

// ---------------------------------------------------------------------------
// Schema validation export (test surface)
// ---------------------------------------------------------------------------

export const _testing = {
  validateAgainstConfigSchema,
  validateInstallId,
  resolverErrorToConfigSchemaError,
  shapeDatasourceRow,
} as const;
