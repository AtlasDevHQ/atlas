/**
 * `EmailFormInstallHandler` — slice 7 of #2649 (issue #2660).
 *
 * Implements {@link FormBasedInstallHandler} for the Email integration.
 * Form-based installs persist a single workspace_plugins row whose
 * `config` JSONB carries both install metadata (host / port / from
 * address) AND the encrypted SMTP password — secret-field encryption
 * via {@link encryptSecretFields} routes only `password` through
 * `db/secret-encryption.ts`, leaving the operational fields plaintext
 * so admin UI reads can render them without a decrypt.
 *
 * Two-store note (#2658): the dedicated `integration_credentials` table
 * lands with the Salesforce slice. Until then, form-based credentials
 * live inside `workspace_plugins.config` via selective-field encryption
 * — the dual-store contract from ADR-0003 collapses to "one store, two
 * keyspaces inside one JSONB" for form-based installs. The migration
 * to the dedicated table is mechanical: copy the `password` ciphertext
 * out of `config` into the new table, drop the inline key.
 *
 * Connection liveness: we do NOT ping the SMTP server at install time.
 * SMTP probes are slow (multi-second TCP+TLS handshake) and surface
 * misleading failures (firewalls, transient outages) at exactly the
 * worst moment — the first install. The first send-email tool call
 * surfaces real errors with the full error path intact.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ../../plugins/secrets.ts — {@link encryptSecretFields}
 */

import crypto from "crypto";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecretFields, type ConfigSchema } from "@atlas/api/lib/plugins/secrets";
import type { WorkspaceId } from "@useatlas/types";
import type {
  CatalogId,
  FormBasedInstallHandler,
  InstallRecord,
} from "./types";

const log = createLogger("integrations.install.email");

/**
 * Stable `plugin_catalog.id` for the Email entry — derived as
 * `catalog:${slug}` to match the seeder's id-derivation rule.
 */
const EMAIL_CATALOG_ID = "catalog:email";

/** Catalog slug — the dispatch key in {@link registerFormHandler}. */
const EMAIL_SLUG: CatalogId = "email";

/**
 * Zod validation for SMTP form input. Mirrors the `configSchema`
 * declared in the catalog entry — the catalog schema drives the admin
 * UI's field list; this Zod object drives server-side validation.
 *
 * Keeping the two definitions side-by-side (and unit-tested for
 * structural agreement in `email-form-handler.test.ts`) keeps drift
 * surfaceable: a UI field that never validates here, or a Zod field
 * the UI doesn't render, both fail in obvious ways.
 *
 * Sender-address validation uses RFC-5321-compatible parsing rather
 * than `.email()`: SMTP `from` values commonly carry a display-name
 * portion (`"Atlas <reports@example.com>"`) that bare `.email()`
 * rejects. The regex accepts both bare-email and display-name forms;
 * the actual delivery is nodemailer's responsibility.
 */
const SMTP_FROM_RE =
  /^(?:[^<>]*<\s*[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+\s*>|[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+)$/;

export const EmailFormDataSchema = z.object({
  host: z.string().min(1, "host is required").max(253),
  port: z.coerce.number().int().min(1).max(65_535),
  username: z.string().min(1, "username is required").max(320),
  password: z.string().min(1, "password is required"),
  fromAddress: z
    .string()
    .min(3, "fromAddress is required")
    .regex(SMTP_FROM_RE, "fromAddress must be a valid email or display-name form"),
  /**
   * Whether to use STARTTLS / TLS. Defaults to `true` — the safe choice
   * for any public SMTP relay. Operators on internal-only relays can
   * opt out by submitting `secure: false`.
   */
  secure: z.boolean().optional().default(true),
}).strict();

export type EmailFormData = z.infer<typeof EmailFormDataSchema>;

/**
 * Catalog schema shape used by `encryptSecretFields` — declares which
 * `EmailFormData` fields are credentials and must land encrypted in
 * `workspace_plugins.config`. Kept inline rather than read from the
 * catalog row so the handler is testable without a DB round-trip and
 * so the encryption decision can't drift if a catalog row is hand-
 * edited to drop the `secret: true` flag.
 */
const EMAIL_SECRET_FIELDS_SCHEMA: ConfigSchema = {
  state: "parsed",
  fields: [
    { key: "host", type: "string" },
    { key: "port", type: "number" },
    { key: "username", type: "string" },
    { key: "password", type: "string", secret: true },
    { key: "fromAddress", type: "string" },
    { key: "secure", type: "boolean" },
  ],
};

/**
 * Build a fresh Email install handler. The factory exists so tests can
 * inject a stable `idGenerator` (default `crypto.randomUUID()`) — every
 * install row id is the deterministic-equivalent of "the first one ever
 * inserted" under the test, which keeps assertions terse.
 */
export interface EmailFormInstallHandlerOptions {
  /** Override the default `crypto.randomUUID()` install id generator. Tests only. */
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
      // Throw a tagged validation error the route layer can surface
      // as a 400 with field-level detail. We construct the message
      // verbatim from Zod's `format()` output to keep field paths
      // intact for the UI to highlight; secrets aren't reflected
      // back because Zod's failure message points at the field
      // path, not the value.
      const issues = parsed.error.flatten().fieldErrors;
      throw new EmailFormValidationError(issues);
    }
    const config = parsed.data;

    // ── 2. Encrypt secret fields (password) at rest ────────────────
    // `encryptSecretFields` is idempotent on already-prefixed values,
    // but the input here is always fresh-from-form plaintext.
    const encryptedConfig = encryptSecretFields(
      config as Record<string, unknown>,
      EMAIL_SECRET_FIELDS_SCHEMA,
    );

    // ── 3. Upsert workspace_plugins ────────────────────────────────
    // Stable id per row (`this.newId()`); ON CONFLICT updates the
    // config + flips enabled back to true so a re-install after
    // disconnect lands cleanly without resurrecting a stale id.
    const installId = this.newId();
    try {
      await internalQuery(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
         VALUES ($1, $2, $3, $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               installed_at = NOW()`,
        [installId, workspaceId, EMAIL_CATALOG_ID, JSON.stringify(encryptedConfig)],
      );
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist Email install record — aborting install",
      );
      throw err;
    }

    log.info(
      { workspaceId, host: config.host, port: config.port },
      "Email install completed",
    );
    return {
      installRecord: {
        id: installId,
        workspaceId,
        catalogId: EMAIL_SLUG,
      },
      // For form-based installs the credential lives inside the same
      // row's `config` JSONB (selective-field encrypted), so a
      // successful UPSERT means both stores landed.
      credentialWritten: true,
    };
  }
}

/**
 * Tagged validation error — bubbled out of `validateConfig` so the
 * `POST /install-form` route can map it to a 400 with the per-field
 * `fieldErrors` shape the admin UI's modal uses to highlight inputs.
 *
 * Tagged class rather than `Data.TaggedError` because this throws out
 * through the legacy Hono handler — `runHandler`'s typed-error mapper
 * doesn't currently know about install-handler-internal tagged errors;
 * the route catches `instanceof EmailFormValidationError` and emits the
 * 400 directly. Promoting to a tagged Effect error is a follow-up once
 * other form-based handlers (Webhook, Obsidian per #2661) repeat the
 * pattern.
 */
export class EmailFormValidationError extends Error {
  readonly _tag = "EmailFormValidationError" as const;
  readonly fieldErrors: Record<string, string[] | undefined>;
  constructor(fieldErrors: Record<string, string[] | undefined>) {
    super("Email install form failed validation");
    this.name = "EmailFormValidationError";
    this.fieldErrors = fieldErrors;
  }
}
