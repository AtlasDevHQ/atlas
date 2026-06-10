/**
 * `WebhookFormInstallHandler` — outbound webhook form-based install.
 *
 * Mirrors the Email shape exactly: an admin submits a destination
 * URL + HMAC signing secret + retry policy, the handler validates,
 * encrypts the secret via `encryptSecretFields`, and upserts
 * `workspace_plugins.config`. The plugin code (under
 * `plugins/webhook-action/`) reads the same JSONB at lazy-load time
 * and decrypts via `decryptSecretFields`. Persistence lives on the
 * shared spine — see {@link persistFormInstall}.
 *
 * URL validation pins https — webhooks routinely carry sensitive
 * analysis output, and http destinations would leak that traffic in
 * the clear. An operator who genuinely needs http (private network,
 * dev sandbox) can fork the schema; the production safe default is
 * tls-only.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ./email-form-handler.ts — first form handler, shape canon
 * @see ./persist-form-install.ts — {@link persistFormInstall}
 */

import crypto from "crypto";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { type ConfigSchema } from "@atlas/api/lib/plugins/secrets";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import type { WorkspaceId } from "@useatlas/types";
import { parseFormInstall, persistFormInstall } from "./persist-form-install";
import { safeHost } from "./safe-host";
import type {
  CatalogId,
  FormBasedInstallHandler,
  InstallRecord,
} from "./types";

const log = createLogger("integrations.install.webhook");

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
        // intentionally ignored: URL constructor throw is the negative
        // validation signal — the user sees the .refine message.
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

/**
 * Exported (unlike the original module-local const) so decrypt-side
 * consumers and cross-schema-agreement tests can pin the secret-field
 * routing against {@link WebhookFormDataSchema} — the email family's
 * Zod↔secret-schema drift test needs both halves importable.
 */
export const WEBHOOK_SECRET_FIELDS_SCHEMA: ConfigSchema & {
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
    const config = parseFormInstall(WebhookFormDataSchema, formData);

    const installRecord = await persistFormInstall({
      workspaceId,
      catalogSlug: WEBHOOK_SLUG,
      displayName: "Webhook",
      log,
      config,
      secretFieldsSchema: WEBHOOK_SECRET_FIELDS_SCHEMA,
      newId: () => this.newId(),
    });

    log.info(
      { workspaceId, installId: installRecord.id, host: safeHost(config.url) },
      "Webhook install completed",
    );
    return { installRecord, credentialWritten: true };
  }
}
