/**
 * `EmailFormInstallHandler` — first {@link FormBasedInstallHandler}
 * implementation. SMTP credentials submitted by a workspace admin
 * persist into `workspace_plugins.config` with `password` encrypted
 * at rest via `encryptSecretFields`; operational fields
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
 * Persistence (keyset gate → encrypt → upsert → id invariant → lazy-
 * loader evict) lives on the shared spine — see
 * {@link persistFormInstall}. The evict matters here: a re-install
 * that rotates SMTP credentials must not keep the stale in-memory
 * transport from before the upsert.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ./persist-form-install.ts — {@link persistFormInstall}
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import type { WorkspaceId } from "@useatlas/types";
import {
  EMAIL_CATALOG_ID,
  EMAIL_SECRET_FIELDS_SCHEMA,
  EmailFormDataSchema,
} from "./email-secret-schema";
import { persistFormInstall } from "./persist-form-install";
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
    const parsed = EmailFormDataSchema.safeParse(formData);
    if (!parsed.success) {
      throw FormInstallValidationError.fromZodFlatten(parsed.error.flatten());
    }
    const config = parsed.data;

    if (config.secure === false) {
      log.warn(
        { workspaceId, host: config.host, port: config.port },
        "Email install with TLS disabled — admin opted out of secure SMTP",
      );
    }

    const installRecord = await persistFormInstall({
      workspaceId,
      catalogId: EMAIL_CATALOG_ID,
      catalogSlug: EMAIL_SLUG,
      displayName: "Email",
      log,
      config,
      secretFieldsSchema: EMAIL_SECRET_FIELDS_SCHEMA,
      plaintextSecretLabel: "password",
      newId: this.newId,
      evictAfterPersist: true,
    });

    log.info(
      { workspaceId, installId: installRecord.id, host: config.host, port: config.port },
      "Email install completed",
    );
    return { installRecord, credentialWritten: true };
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
