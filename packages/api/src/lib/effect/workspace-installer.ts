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

import { Context, Data, Effect, Layer } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { encryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import type {
  CatalogRowForDispatch,
  CredentialResult,
  PlatformInstallHandler,
} from "@atlas/api/lib/integrations/install/types";
import type { CatalogInstallModel } from "@atlas/api/lib/config";
import type { WorkspaceId } from "@useatlas/types";

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
// Tagged errors
// ---------------------------------------------------------------------------

/**
 * Pillar-singleton violation — a `chat` / `action` install already exists
 * for `(workspaceId, catalogSlug)`. Maps to HTTP 409 in `mapTaggedError`.
 *
 * Friendlier than relying on the DB partial-unique-index violation: the
 * pre-check produces an actionable error message and avoids a wasted
 * round-trip through the per-handler write path before the constraint
 * fires. The index remains the defensive backstop against races.
 */
export class AlreadyInstalledError extends Data.TaggedError("AlreadyInstalledError")<{
  readonly message: string;
  readonly workspaceId: string;
  readonly catalogSlug: string;
  readonly pillar: "chat" | "action";
}> {}

/**
 * `config` failed validation against `plugin_catalog.config_schema`. Maps
 * to HTTP 400 in `mapTaggedError`. `fieldErrors` carries per-field issues
 * shaped for the admin UI's per-field message rendering; `formErrors`
 * collects top-level issues (unknown fields, schema-level rejections).
 *
 * Per-handler Zod validation (e.g. Email's strict shape) layers richer
 * checks on top — this error is the catalog-level contract violation
 * (missing required field, wrong type) that fires before the handler
 * runs.
 */
export class ConfigSchemaError extends Data.TaggedError("ConfigSchemaError")<{
  readonly message: string;
  readonly catalogSlug: string;
  readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
  readonly formErrors: readonly string[];
}> {}

/**
 * Catalog row not found, kill-switched, or carries an unknown
 * `install_model`. Maps to HTTP 404 in `mapTaggedError` (the catalog
 * lookup is the closest analogue to "resource doesn't exist").
 */
export class CatalogNotFoundError extends Data.TaggedError("CatalogNotFoundError")<{
  readonly message: string;
  readonly catalogSlug: string;
}> {}

/**
 * Install row not found for `(workspaceId, catalogSlug)`. Surfaces from
 * `uninstall` and `updateConfig` when the target row is gone. Maps to
 * HTTP 404 in `mapTaggedError`.
 */
export class InstallNotFoundError extends Data.TaggedError("InstallNotFoundError")<{
  readonly message: string;
  readonly workspaceId: string;
  readonly catalogSlug: string;
}> {}

/** Discriminated union of every error the facade emits in its E channel. */
export type InstallError =
  | AlreadyInstalledError
  | ConfigSchemaError
  | CatalogNotFoundError
  | InstallNotFoundError;

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
  readonly pillar: "chat" | "action";
  readonly installId: string;
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
}

export class WorkspaceInstaller extends Context.Tag("WorkspaceInstaller")<
  WorkspaceInstaller,
  WorkspaceInstallerShape
>() {}

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

      // Pillar guard — facade only handles chat / action (slice 6 owns
      // datasource).
      if (catalog.pillar === "datasource") {
        return yield* Effect.fail(
          new CatalogNotFoundError({
            message: `Datasource installs are not handled by WorkspaceInstaller (see slice 6 / issue #2744). Slug: "${catalogSlug}".`,
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
            message: `Datasource uninstalls are not handled by WorkspaceInstaller (see slice 6 / issue #2744). Slug: "${catalogSlug}".`,
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
            message: `Datasource updateConfig is not handled by WorkspaceInstaller (see slice 6 / issue #2744). Slug: "${catalogSlug}".`,
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
                SET config = $1::jsonb
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

  return {
    install: installImpl,
    uninstall: uninstallImpl,
    updateConfig: updateConfigImpl,
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
  // Form-based: no separate credential store; the DELETE on
  // workspace_plugins (step 2) is the credential teardown. No-op here.
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
} as const;
