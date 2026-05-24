/**
 * Twenty CRM plugin — scaffolds the `upsertTwentyPerson` action and
 * exposes the lower-level `TwentyClient`, `LeadNormalizer`, and
 * credential resolver for use by `ee/src/saas-crm/`.
 *
 * Self-hosters wire the plugin through `atlas.config.ts`; Atlas SaaS
 * consumes `TwentyClient` directly through the `SaasCrm` Effect Tag so
 * the SaaS wiring stays gated under the enterprise license without
 * forcing self-hosters to install `@useatlas/twenty` to use the rest
 * of Atlas.
 *
 * @example Self-hoster wiring
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { twentyPlugin } from "@useatlas/twenty";
 *
 * export default defineConfig({
 *   plugins: [
 *     twentyPlugin({
 *       apiKey: process.env.TWENTY_API_KEY!,
 *       baseUrl: "https://crm.example.com",
 *     }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { tool } from "ai";
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasActionPlugin, PluginAction } from "@useatlas/plugin-sdk";
import { upsertPerson, type TwentyClientConfig } from "./client";

// ─────────────────────────────────────────────────────────────────────
//  Public re-exports — consumed by ee/src/saas-crm/ and tests
// ─────────────────────────────────────────────────────────────────────

export {
  upsertPerson,
  getPersonMetadata,
  TwentyClientError,
  type TwentyOperation,
  type TwentyClientConfig,
  type UpsertPersonInput,
  type TwentyPerson,
  type AtlasPersonCustomFields,
  type PersonMetadata,
  type PersonMetadataField,
} from "./client";

export {
  normalizeDemoLead,
  normalizeLead,
  type AtlasDemoLeadEvent,
  type AtlasEventSource,
  type AtlasLeadEvent,
  type NormalizedLead,
} from "./lead-normalizer";

export {
  resolveCredentialsFromEnv,
  tryResolveCredentialsFromEnv,
  TwentyCredentialError,
  type ResolvedTwentyCredentials,
  type ResolveOptions,
} from "./credential-resolver";

// ─────────────────────────────────────────────────────────────────────
//  Config schema
// ─────────────────────────────────────────────────────────────────────

const twentyConfigSchema = z.object({
  /** Bearer API key from Twenty Settings → API & Webhooks. Marked secret. */
  apiKey: z.string().min(1, "Twenty apiKey must not be empty"),
  /**
   * Twenty REST base URL. Required — operators must point at their own
   * Twenty install (e.g. `https://crm.example.com`). No default: a
   * built-in URL would silently route every self-hoster at Atlas's
   * internal CRM.
   */
  baseUrl: z.string().url("Twenty baseUrl must be a valid URL"),
  /** Per-request timeout in ms. */
  timeoutMs: z.number().int().positive().optional(),
});

export type TwentyPluginConfig = z.infer<typeof twentyConfigSchema>;

/** Schema metadata for selective-field encryption (F-41). */
export const TWENTY_CONFIG_SCHEMA_META = {
  fields: {
    apiKey: { secret: true as const },
    baseUrl: { secret: false as const },
    timeoutMs: { secret: false as const },
  },
} as const;

const PLUGIN_DESCRIPTION = `### Upsert Twenty CRM Person
Use upsertTwentyPerson to upsert a Person record in Twenty CRM by email.
Atlas-side stamping rules (first/last source) are handled inside the action.`;

// ─────────────────────────────────────────────────────────────────────
//  Plugin factory
// ─────────────────────────────────────────────────────────────────────

export const twentyPlugin = createPlugin<
  TwentyPluginConfig,
  AtlasActionPlugin<TwentyPluginConfig>
>({
  configSchema: twentyConfigSchema,

  create(config) {
    const clientConfig: TwentyClientConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    };

    const upsertPersonTool = tool({
      description:
        "Upsert a Person in Twenty CRM by email. Stamps atlasFirstSource (sticky) and atlasLastSource (always).",
      inputSchema: z.object({
        email: z.string().email().describe("Primary email of the Person"),
        eventSource: z
          .enum(["DEMO", "SIGNUP", "SALES_FORM", "OTHER"])
          .describe("Source label."),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        atlasIp: z.string().optional(),
      }),
      execute: async ({ email, eventSource, firstName, lastName, atlasIp }) => {
        const customFields: { atlasIp?: string } = {};
        if (atlasIp) customFields.atlasIp = atlasIp;
        const name =
          firstName || lastName ? { firstName, lastName } : undefined;
        const result = await upsertPerson(clientConfig, {
          email,
          eventSource,
          name,
          customFields,
        });
        return { id: result.id, email: result.emails?.primaryEmail };
      },
    });

    const action: PluginAction = {
      name: "upsertTwentyPerson",
      description: PLUGIN_DESCRIPTION,
      tool: upsertPersonTool,
      actionType: "crm:upsert-person",
      reversible: false,
      defaultApproval: "admin-only",
      requiredCredentials: ["apiKey"],
    };

    return {
      id: "twenty-action",
      types: ["action"] as const,
      version: "0.1.0",
      name: "Twenty CRM Action",
      config,

      actions: [action],

      async initialize(ctx) {
        ctx.logger.info(
          `Twenty plugin initialized (baseUrl: ${clientConfig.baseUrl})`,
        );
      },
    };
  },
});

export default twentyPlugin;
