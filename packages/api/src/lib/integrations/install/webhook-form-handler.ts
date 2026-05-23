/**
 * `WebhookFormInstallHandler` — second {@link FormBasedInstallHandler}
 * implementation (Email shipped in #2697; this handler lands under
 * #2661 alongside Obsidian).
 *
 * Mirrors the Email shape exactly: an admin submits a destination
 * URL + HMAC signing secret + retry policy, the handler validates,
 * encrypts the secret via {@link encryptSecretFields}, and upserts
 * `workspace_plugins.config`. The plugin code (under
 * `plugins/webhook-action/`) reads the same JSONB at lazy-load time
 * and decrypts via `decryptSecretFields`.
 *
 * URL validation pins https — webhooks routinely carry sensitive
 * analysis output, and http destinations would leak that traffic in
 * the clear. An operator who genuinely needs http (private network,
 * dev sandbox) can fork the schema; the production safe default is
 * tls-only.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ./email-form-handler.ts — first form handler, shape canon
 * @see ../../plugins/secrets.ts — {@link encryptSecretFields}
 */

import crypto from "crypto";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { encryptSecretFields, type ConfigSchema } from "@atlas/api/lib/plugins/secrets";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import type { WorkspaceId } from "@useatlas/types";
import { FormInstallValidationError } from "./email-form-handler";
import type {
  CatalogId,
  FormBasedInstallHandler,
  InstallRecord,
} from "./types";

const log = createLogger("integrations.install.webhook");

/** Stable `plugin_catalog.id` for Webhook — `catalog:${slug}` per the seeder. */
const WEBHOOK_CATALOG_ID = "catalog:webhook";

/** Catalog slug — the dispatch key in {@link registerFormHandler}. */
const WEBHOOK_SLUG: CatalogId = "webhook";

/** Defensive upper bound on the signing secret — JSONB rows shouldn't carry 50MB strings. */
const SIGNING_SECRET_MAX = 4096;

/**
 * Destination URL must parse and use https. Plain `z.url()` allows
 * any scheme; the post-parse refine narrows it. Native URL parsing
 * also rejects whitespace-only / control-char inputs.
 */
const HttpsUrlSchema = z
  .string()
  .min(1, "url is required")
  .refine(
    (raw) => {
      try {
        const u = new URL(raw);
        return u.protocol === "https:";
      } catch {
        return false;
      }
    },
    "url must be a well-formed https:// URL",
  );

export const WebhookFormDataSchema = z
  .object({
    url: HttpsUrlSchema,
    signing_secret: z
      .string()
      .min(1, "signing_secret is required")
      .max(SIGNING_SECRET_MAX, `signing_secret must be ${SIGNING_SECRET_MAX} characters or fewer`),
    /**
     * Retry behavior when the destination returns 5xx / connect
     * failure. Defaults to `exponential`; `none` is for callers that
     * want strict one-shot semantics (e.g. notification fan-out where
     * a stale retry would be noisy).
     */
    retry_policy: z.enum(["none", "exponential"]).optional().default("exponential"),
  })
  .strict();

export type WebhookFormData = z.infer<typeof WebhookFormDataSchema>;

const WEBHOOK_SECRET_FIELDS_SCHEMA: ConfigSchema & {
  state: "parsed";
  fields: ReadonlyArray<ConfigSchemaField & { key: keyof WebhookFormData }>;
} = {
  state: "parsed",
  fields: [
    { key: "url", type: "string" },
    { key: "signing_secret", type: "string", secret: true },
    { key: "retry_policy", type: "string" },
  ],
};

/** Test-only injection of the install id generator. */
export interface WebhookFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
}

export class WebhookFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;

  constructor(options: WebhookFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }> {
    const parsed = WebhookFormDataSchema.safeParse(formData);
    if (!parsed.success) {
      throw FormInstallValidationError.fromZodFlatten(parsed.error.flatten());
    }
    const config = parsed.data;

    if (
      process.env.ATLAS_DEPLOY_MODE === "saas" &&
      !getEncryptionKeyset()
    ) {
      log.error(
        { workspaceId },
        "Refusing form install: SaaS mode + no encryption keyset (would persist plaintext signing_secret)",
      );
      throw new Error(
        "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. Set ATLAS_ENCRYPTION_KEYS and retry.",
      );
    }

    const encryptedConfig = encryptSecretFields(config, WEBHOOK_SECRET_FIELDS_SCHEMA);

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
        [candidateId, workspaceId, WEBHOOK_CATALOG_ID, JSON.stringify(encryptedConfig)],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        log.warn(
          { workspaceId, candidateId },
          "workspace_plugins upsert returned no id — falling back to candidate",
        );
        persistedId = candidateId;
      } else {
        persistedId = returned;
      }
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist Webhook install record — aborting install",
      );
      throw err;
    }

    log.info(
      { workspaceId, installId: persistedId, host: safeHost(config.url) },
      "Webhook install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: WEBHOOK_SLUG },
      credentialWritten: true,
    };
  }
}

/** Best-effort host extraction for log breadcrumbs — never throws. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable>";
  }
}
