/**
 * `ObsidianFormInstallHandler` — Obsidian vault form-based install.
 *
 * Backs an admin form that captures the Obsidian Local REST API
 * endpoint and the per-vault API key. The defaults target the plugin
 * (`coddingtonbear/obsidian-local-rest-api`) listening on the user's
 * local machine — `http://127.0.0.1:27123` — but a remote tunnel
 * (https) is also accepted so SaaS workspaces can reach a hosted vault.
 *
 * URL validation is intentionally loose-scheme: the canonical install
 * uses plain http on loopback (the Obsidian plugin's default), so a
 * strict https refine would reject the safe-by-default install. The
 * field is parsed as a well-formed URL; tighter validation lives in
 * the docs.
 *
 * Persistence lives on the shared spine — see {@link persistFormInstall}.
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

const log = createLogger("integrations.install.obsidian");

const OBSIDIAN_SLUG: CatalogId = "obsidian";

/** Default Obsidian Local REST API endpoint (loopback, the plugin's stock binding). */
const OBSIDIAN_DEFAULT_URL = "http://127.0.0.1:27123";

const API_KEY_MAX = 4096;

const ApiUrlSchema = z
  .string()
  .min(1, "api_url is required")
  .refine(
    (raw) => {
      try {
        new URL(raw);
        return true;
      } catch {
        // intentionally ignored: URL constructor throw is the negative
        // validation signal — the user sees the .refine message.
        return false;
      }
    },
    "api_url must be a well-formed URL",
  );

export const ObsidianFormDataSchema = z
  .object({
    api_url: ApiUrlSchema.optional().default(OBSIDIAN_DEFAULT_URL),
    api_key: z
      .string()
      .min(1, "api_key is required")
      .max(API_KEY_MAX, `api_key must be ${API_KEY_MAX} characters or fewer`),
  })
  .strict();

export type ObsidianFormData = z.infer<typeof ObsidianFormDataSchema>;

/**
 * Exported (unlike the original module-local const) so decrypt-side
 * consumers and cross-schema-agreement tests can pin the secret-field
 * routing against {@link ObsidianFormDataSchema}.
 */
export const OBSIDIAN_SECRET_FIELDS_SCHEMA: ConfigSchema & {
  state: "parsed";
  fields: ReadonlyArray<ConfigSchemaField & { key: keyof ObsidianFormData }>;
} = {
  state: "parsed",
  fields: [
    { key: "api_url", type: "string" },
    { key: "api_key", type: "string", secret: true },
  ],
};

/** Test-only injection of the install id generator. */
export interface ObsidianFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
}

export class ObsidianFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;

  constructor(options: ObsidianFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }> {
    const config = parseFormInstall(ObsidianFormDataSchema, formData);

    const installRecord = await persistFormInstall({
      workspaceId,
      catalogSlug: OBSIDIAN_SLUG,
      displayName: "Obsidian",
      log,
      config,
      secretFieldsSchema: OBSIDIAN_SECRET_FIELDS_SCHEMA,
      newId: () => this.newId(),
    });

    log.info(
      { workspaceId, installId: installRecord.id, host: safeHost(config.api_url) },
      "Obsidian install completed",
    );
    return { installRecord, credentialWritten: true };
  }
}
