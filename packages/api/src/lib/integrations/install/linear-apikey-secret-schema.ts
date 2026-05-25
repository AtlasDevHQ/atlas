/**
 * Shared form schema + secret-field map for the Linear API-key install
 * mode (#2750).
 *
 * Mirrors {@link ./email-secret-schema.ts} — both the form install
 * handler ({@link LinearApiKeyFormInstallHandler}) and the lazy builder
 * ({@link createLinearApiKeyLazyBuilder}) need to know:
 *
 *   1. The Zod shape of the install form (api_key, workspace_name) so
 *      stored configs can be re-validated on read without re-deriving
 *      the schema in two places.
 *   2. Which fields in `workspace_plugins.config` are `secret: true` so
 *      the write path encrypts and the read path decrypts the same set.
 *
 * Duplicating the `secret: true` flag set in two modules is the F-42
 * audit's exact failure mode — a write that encrypts more than the read
 * decrypts corrupts the stored value silently. Centralizing keeps both
 * sides in lockstep.
 */

import { z } from "zod";
import type { ConfigSchema } from "@atlas/api/lib/plugins/secrets";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";

/** Stable `plugin_catalog.id` for the Linear API-key install mode. */
export const LINEAR_APIKEY_CATALOG_ID = "catalog:linear-apikey";

/** Defensive upper bound on the API-key field — JSONB rows shouldn't carry 50MB strings. */
const API_KEY_MAX = 4096;

/**
 * Linear Personal API keys are prefixed `lin_api_` followed by an
 * opaque alphanumeric secret (Linear documents the format at
 * https://developers.linear.app/docs/graphql/working-with-the-graphql-api#personal-api-keys).
 * The regex is permissive — we accept any length within the JSONB
 * defensive cap and don't enforce the prefix here, because a key
 * mis-typed without the prefix is better surfaced as a clean "Linear
 * rejected the key" error from the first GraphQL call than as a vague
 * form-validation error that doesn't explain WHY the input shape
 * matters.
 */
const LINEAR_API_KEY_RE = /^[A-Za-z0-9_-]+$/;

export const LinearApiKeyFormDataSchema = z.object({
  api_key: z
    .string()
    .min(1, "api_key is required")
    .max(API_KEY_MAX, `api_key must be ${API_KEY_MAX} characters or fewer`)
    .regex(
      LINEAR_API_KEY_RE,
      "api_key contains characters Linear keys never use — copy the value directly from Linear's settings page",
    ),
  /**
   * Optional admin-friendly label. The field exists so admins managing
   * multiple Linear workspaces can disambiguate at a glance; if missing
   * the lazy builder backfills the workspace name from the `viewer`
   * GraphQL query on first use.
   */
  workspace_name: z.string().min(1).max(255).optional(),
}).strict();

export type LinearApiKeyFormData = z.infer<typeof LinearApiKeyFormDataSchema>;

/**
 * `encryptSecretFields` / `decryptSecretFields` schema for the Linear
 * API-key handler. The `fields[].key` element is constrained to
 * `keyof LinearApiKeyFormData` so a Zod rename without a matching
 * update here surfaces as a TS error rather than a silent encryption
 * regression at runtime.
 */
export const LINEAR_APIKEY_SECRET_FIELDS_SCHEMA: ConfigSchema & {
  state: "parsed";
  fields: ReadonlyArray<ConfigSchemaField & { key: keyof LinearApiKeyFormData }>;
} = {
  state: "parsed",
  fields: [
    { key: "api_key", type: "string", secret: true },
    { key: "workspace_name", type: "string" },
  ],
};
