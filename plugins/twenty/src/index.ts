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
import {
  probeTwentyHealth,
  stampStripeCustomerId,
  upsertPerson,
  type TwentyClientConfig,
} from "./client";

// ─────────────────────────────────────────────────────────────────────
//  Public re-exports — consumed by ee/src/saas-crm/ and tests
// ─────────────────────────────────────────────────────────────────────

export {
  upsertPerson,
  stampStripeCustomerId,
  getPersonMetadata,
  getPersonRestSchema,
  probeTwentyHealth,
  createNote,
  TwentyClientError,
  type TwentyHealthResult,
  type TwentyOperation,
  type TwentyClientConfig,
  type UpsertPersonInput,
  type StampStripeCustomerIdInput,
  type TwentyPerson,
  type AtlasPersonCustomFields,
  type PersonMetadata,
  type PersonMetadataField,
  type CreateNoteInput,
  type TwentyNote,
} from "./client";

export {
  normalizeDemoLead,
  normalizeSalesFormLead,
  normalizeSignupLead,
  normalizeConversionLead,
  normalizeLead,
  LeadEventSchema,
  type DemoLeadEvent,
  type SalesFormLeadEvent,
  type SignupLeadEvent,
  type ConversionLeadEvent,
  type AtlasEventSource,
  type LeadEvent,
  type NormalizedLead,
  type NormalizedNote,
} from "./lead-normalizer";

export {
  // New (post-#2850) — explicit actor split. Use these in new code.
  resolveOperatorCredentials,
  tryResolveOperatorCredentials,
  resolveWorkspaceCredentials,
  // Legacy aliases (back-compat, @deprecated).
  resolveCredentialsFromEnv,
  resolveCredentialsForWorkspace,
  tryResolveCredentialsFromEnv,
  TwentyCredentialError,
  TwentyDecryptError,
  isTwentyDecryptError,
  assertTwentyApiKey,
  assertTwentyBaseUrl,
  type DbCredentialLookup,
  type DbCredentialLookupResult,
  type ResolvedTwentyCredentials,
  type ResolveOptions,
  type ResolveWorkspaceOptions,
  type ResolveForWorkspaceOptions,
  type DeployMode,
  type TwentyApiKey,
  type TwentyBaseUrl,
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
          .enum(["DEMO", "SIGNUP", "SALES_FORM", "CONVERSION", "OTHER"])
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

    const stampStripeCustomerIdTool = tool({
      description:
        "Stamp the Stripe customer ID on the Twenty Person matching email. Sets atlasLastSource=CONVERSION; creates the Person if absent with atlasFirstSource=CONVERSION.",
      inputSchema: z.object({
        email: z.string().email().describe("Primary email of the Person"),
        stripeCustomerId: z
          .string()
          .min(1)
          .describe("Stripe customer id (cus_…)"),
      }),
      execute: async ({ email, stripeCustomerId }) => {
        const result = await stampStripeCustomerId(clientConfig, {
          email,
          stripeCustomerId,
        });
        return { id: result.id, email: result.emails?.primaryEmail };
      },
    });

    const upsertAction: PluginAction = {
      name: "upsertTwentyPerson",
      description: PLUGIN_DESCRIPTION,
      tool: upsertPersonTool,
      actionType: "crm:upsert-person",
      reversible: false,
      defaultApproval: "admin-only",
      requiredCredentials: ["apiKey"],
    };

    const stampAction: PluginAction = {
      name: "stampStripeCustomerId",
      description:
        "Stamp atlasStripeCustomerId on a Twenty Person by email (CONVERSION source). Use from a Stripe webhook handler.",
      tool: stampStripeCustomerIdTool,
      actionType: "crm:stamp-stripe-customer-id",
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

      actions: [upsertAction, stampAction],

      async initialize(ctx) {
        ctx.logger.info(
          `Twenty plugin initialized (baseUrl: ${clientConfig.baseUrl})`,
        );
      },

      // Periodic liveness probe (#3179). Without it, PluginRegistry falls back
      // to the last post-init status and reports `healthy` forever — so a
      // revoked/expired Twenty key (which backs Atlas's lead-capture pipeline)
      // never surfaces as unhealthy. Reuses the client's `/rest/open-api/core`
      // probe; a 401/403 from a dead key resolves to `{ healthy: false }`.
      async healthCheck() {
        return probeTwentyHealth(clientConfig);
      },
    };
  },
});

export default twentyPlugin;
