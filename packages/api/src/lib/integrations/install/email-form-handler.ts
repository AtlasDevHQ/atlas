/**
 * `EmailFormInstallHandler` — first {@link FormBasedInstallHandler}
 * implementation. SMTP credentials submitted by a workspace admin
 * persist into `workspace_plugins.config` with `password` encrypted
 * at rest via {@link encryptSecretFields}; operational fields
 * (host / port / username / fromAddress / secure) stay plaintext so
 * admin-UI reads don't need a decrypt.
 *
 * Two-store note (#2658): the dedicated `integration_credentials`
 * table lands with the Salesforce slice. Until then form-based
 * credentials live inside `workspace_plugins.config` via selective-
 * field encryption — ADR-0003's dual-store contract collapses to
 * "one row, two keyspaces inside one JSONB" for form-based installs.
 *
 * Connection liveness: we do NOT probe SMTP at install time. SMTP
 * handshakes are slow and surface misleading firewall / transient
 * failures at the worst moment. The first send-email tool call
 * surfaces real errors with the full path intact.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ../../plugins/secrets.ts — {@link encryptSecretFields}
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecretFields } from "@atlas/api/lib/plugins/secrets";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import type { WorkspaceId } from "@useatlas/types";
import {
  EMAIL_CATALOG_ID,
  EMAIL_SECRET_FIELDS_SCHEMA,
  EmailFormDataSchema,
} from "./email-secret-schema";
import type {
  CatalogId,
  FormBasedInstallHandler,
  InstallRecord,
} from "./types";

// Re-export so existing call sites that imported from this module
// (admin route, tests, install/index.ts barrel) keep compiling. The
// canonical home is `./email-secret-schema` — new code should import
// from there.
export { EmailFormDataSchema };
export type { EmailFormData } from "./email-secret-schema";

const log = createLogger("integrations.install.email");

/** Catalog slug — the dispatch key in {@link registerFormHandler}. */
const EMAIL_SLUG: CatalogId = "email";

/** Test-only injection of the install id generator. */
export interface EmailFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
}

export class EmailFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;

  constructor(options: EmailFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }> {
    // ── 1. Validate the form against the SMTP schema ───────────────
    const parsed = EmailFormDataSchema.safeParse(formData);
    if (!parsed.success) {
      throw FormInstallValidationError.fromZodFlatten(parsed.error.flatten());
    }
    const config = parsed.data;

    // ── 2. SaaS keyset gate ─────────────────────────────────────────
    // `encryptSecret` falls back to plaintext when no key is
    // configured (dev convenience). Boot logs a one-shot warning,
    // but a missed log in SaaS would leak the password plaintext.
    // Refuse the install per-call so a misconfigured deploy fails
    // closed at the credential boundary.
    if (
      process.env.ATLAS_DEPLOY_MODE === "saas" &&
      !getEncryptionKeyset()
    ) {
      log.error(
        { workspaceId },
        "Refusing form install: SaaS mode + no encryption keyset (would persist plaintext password)",
      );
      throw new Error(
        "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. Set ATLAS_ENCRYPTION_KEYS and retry.",
      );
    }

    if (config.secure === false) {
      log.warn(
        { workspaceId, host: config.host, port: config.port },
        "Email install with TLS disabled — admin opted out of secure SMTP",
      );
    }

    // ── 3. Encrypt secret fields (password) at rest ─────────────────
    const encryptedConfig = encryptSecretFields(config, EMAIL_SECRET_FIELDS_SCHEMA);

    // ── 4. Upsert workspace_plugins ─────────────────────────────────
    // ON CONFLICT updates config + flips enabled back to true so a
    // re-install after disconnect lands cleanly. `installed_at` is
    // NOT bumped on conflict (matches the Slack OAuth handler) — the
    // column tracks the first install, not the most recent edit.
    //
    // `RETURNING id` returns the persisted id — on a fresh INSERT
    // it's the one we generated, on a CONFLICT it's the row's
    // existing id (NOT the freshly-generated one). Callers that
    // treat `installId` as a stable identifier for the saved row
    // would otherwise read a phantom id on re-installs.
    const candidateId = this.newId();
    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
         VALUES ($1, $2, $3, $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true
         RETURNING id`,
        [candidateId, workspaceId, EMAIL_CATALOG_ID, JSON.stringify(encryptedConfig)],
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
        "Failed to persist Email install record — aborting install",
      );
      throw err;
    }

    // Evict any cached PluginLike for this (workspace, catalog) so the
    // next tool dispatch rebuilds the transport against the freshly-
    // persisted config. Without this, a re-install that rotates SMTP
    // credentials (host / port / user / password / fromAddress) keeps
    // the stale in-memory transport from before the upsert. Fire-and-
    // forget — `evict` swallows teardown errors internally.
    try {
      await lazyPluginLoader.evict(workspaceId, EMAIL_CATALOG_ID);
    } catch (err) {
      log.warn(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "LazyPluginLoader.evict threw after Email install upsert — DB row is persisted anyway",
      );
    }

    log.info(
      { workspaceId, installId: persistedId, host: config.host, port: config.port },
      "Email install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: EMAIL_SLUG },
      credentialWritten: true,
    };
  }
}

/**
 * Validation failure surface for every form-based install handler.
 * `kind` is the catalog `install_model` value so future handlers
 * (Webhook / Obsidian per #2661) can throw the same class — the
 * route's catch is a single `instanceof FormInstallValidationError`
 * check rather than a growing list of per-Platform error types.
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

/**
 * @deprecated Use {@link FormInstallValidationError}. Kept as a
 * named alias so test callers that still spell out the Email-specific
 * symbol compile, and so a future Webhook / Obsidian handler doesn't
 * have to invent its own subclass. New code should import the shared
 * name directly.
 */
export const EmailFormValidationError = FormInstallValidationError;
export type EmailFormValidationError = FormInstallValidationError;
