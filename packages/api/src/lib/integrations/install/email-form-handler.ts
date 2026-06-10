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
 * {@link persistFormInstall}. The keyset gate is ALSO called explicitly
 * before the TLS-disabled warn so a refused install never logs a
 * phantom "admin opted out of secure SMTP" event.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ./persist-form-install.ts — {@link persistFormInstall}
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import type { WorkspaceId } from "@useatlas/types";
import {
  EMAIL_SECRET_FIELDS_SCHEMA,
  EmailFormDataSchema,
} from "./email-secret-schema";
import {
  assertSaasEncryptionKeyset,
  FormInstallValidationError,
  parseFormInstall,
  persistFormInstall,
} from "./persist-form-install";
import type {
  CatalogId,
  FormBasedInstallHandler,
  InstallRecord,
} from "./types";

// Re-export so existing call sites that imported from this module
// (admin route, tests, install/index.ts barrel, every sibling handler)
// keep compiling. The canonical homes are `./email-secret-schema` and
// `./persist-form-install` — new code should import from there.
export { EmailFormDataSchema };
export type { EmailFormData } from "./email-secret-schema";
export { FormInstallValidationError };

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
    const config = parseFormInstall(EmailFormDataSchema, formData);

    // Gate BEFORE the TLS warn (the spine re-checks, harmlessly): a
    // SaaS deploy with no keyset must refuse without logging a phantom
    // TLS-opt-out event for an install that never happened.
    assertSaasEncryptionKeyset(log, workspaceId, "password");

    if (config.secure === false) {
      log.warn(
        { workspaceId, host: config.host, port: config.port },
        "Email install with TLS disabled — admin opted out of secure SMTP",
      );
    }

    const installRecord = await persistFormInstall({
      workspaceId,
      catalogSlug: EMAIL_SLUG,
      displayName: "Email",
      log,
      config,
      secretFieldsSchema: EMAIL_SECRET_FIELDS_SCHEMA,
      newId: () => this.newId(),
    });

    log.info(
      { workspaceId, installId: installRecord.id, host: config.host, port: config.port },
      "Email install completed",
    );
    return { installRecord, credentialWritten: true };
  }
}
