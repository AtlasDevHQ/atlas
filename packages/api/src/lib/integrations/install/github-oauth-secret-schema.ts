/**
 * Shared `workspace_plugins.config` shape + selective-encryption field
 * map for the GitHub App OAuth install modes (#2751).
 *
 * Two catalog slugs reuse this module:
 *
 *   - `github` — multi-tenant App OAuth. Workspace admins install the
 *     operator's GitHub App against their own GitHub organization;
 *     GitHub returns an `installation_id` that persists here.
 *   - `github-single-tenant` — operator-baked installation. The
 *     operator installs the App in their one GitHub org once and bakes
 *     the resulting `installation_id` into env. Per-workspace "install"
 *     is a no-op acknowledgement persisted to the same shape.
 *
 * Per ADR-0007 (unified install pipeline), the credential lives inline
 * in `workspace_plugins.config` JSONB encrypted via
 * {@link encryptSecretFields} — NOT in `integration_credentials` (that
 * table is the pre-cutover lazy-OAuth store; Salesforce / Jira / Linear
 * still ride it for refresh-token rotation, but new integrations land in
 * the ADR-0007 inline-JSONB shape).
 *
 * Centralising the `secret: true` flag set in one module mirrors the
 * github-pat / linear-apikey siblings — a write that encrypts more than
 * the read decrypts corrupts the stored value silently (F-42 audit's
 * exact failure mode). Both write (handler) and read (future lazy
 * builder shipping in a follow-up PR) import the same schema constant.
 *
 * `installation_id` is marked `secret: true` even though it isn't a
 * bearer credential on its own — minting installation tokens requires
 * the App's private key alongside it. Defense in depth: the App
 * private key never reaches `workspace_plugins.config` (it lives in
 * env), but a leaked installation_id with even a single misconfigured
 * deploy that exposes the private key would yield full repo access. We
 * encrypt at rest to match every other integration credential field's
 * posture.
 */

import { z } from "zod";
import type { ConfigSchema } from "@atlas/api/lib/plugins/secrets";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";

export const GITHUB_CATALOG_ID = "catalog:github";
export const GITHUB_SINGLE_TENANT_CATALOG_ID = "catalog:github-single-tenant";

/**
 * GitHub installation IDs are positive integers in the v3 / GraphQL APIs.
 * The regex allows up to 19 digits — bf64 limit headroom against the
 * theoretical INT8 ceiling without imposing a hard cap that could
 * surprise us if GitHub widens the namespace. We keep them as strings
 * end-to-end (avoiding JS number coercion) but reject anything that
 * isn't a positive integer outright.
 */
export const GITHUB_INSTALLATION_ID_RE = /^[1-9][0-9]{0,18}$/;

// `account_login` / `account_type` are declared on the schema but NOT
// populated by the install handler today — the OAuth callback only
// carries `installation_id`. Both fields are reserved for a future
// post-install enrichment hop (GET `/app/installations/<id>` to fetch
// the owning org's login + type) so admin-UI cards can render
// "Connected to <org_name>" without a per-render API round-trip. The
// schema declares them now so the `encryptSecretFields` /
// `decryptSecretFields` walkers stay in lockstep when the enrichment
// lands — adding a field to the schema later is the F-42 audit's
// canonical failure mode (write-side and read-side schemas diverging
// across PRs).
export const GitHubInstallationConfigSchema = z
  .object({
    installation_id: z
      .string()
      .min(1, "installation_id is required")
      .regex(
        GITHUB_INSTALLATION_ID_RE,
        "installation_id must be a positive integer — GitHub returned an unexpected shape",
      ),
    /** Reserved — populated by future post-install enrichment. */
    account_login: z.string().max(255).optional(),
    /** Reserved — populated by future post-install enrichment. */
    account_type: z.string().max(64).optional(),
    status: z.string().max(64).optional(),
  })
  .strict();

export type GitHubInstallationConfig = z.infer<typeof GitHubInstallationConfigSchema>;

/**
 * `encryptSecretFields` / `decryptSecretFields` schema for the GitHub
 * App OAuth handlers. The `fields[].key` element is constrained to
 * `keyof GitHubInstallationConfig` so a Zod rename without a matching
 * update here surfaces as a TS error rather than a silent encryption
 * regression at runtime — same trick the github-pat / linear-apikey
 * sibling schemas use.
 */
export const GITHUB_APP_SECRET_FIELDS_SCHEMA: ConfigSchema & {
  state: "parsed";
  fields: ReadonlyArray<ConfigSchemaField & { key: keyof GitHubInstallationConfig }>;
} = {
  state: "parsed",
  fields: [
    { key: "installation_id", type: "string", secret: true },
    { key: "account_login", type: "string" },
    { key: "account_type", type: "string" },
    { key: "status", type: "string" },
  ],
};
