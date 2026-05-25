/**
 * Shared form schema + secret-field map for the GitHub Personal Access
 * Token install mode (#2751).
 *
 * Mirrors {@link ./linear-apikey-secret-schema.ts} — both the form
 * install handler ({@link GitHubPatFormInstallHandler}) and any future
 * lazy builder for GitHub need to know:
 *
 *   1. The Zod shape of the install form (pat, default_owner) so stored
 *      configs can be re-validated on read without re-deriving the
 *      schema in two places.
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

export const GITHUB_PAT_CATALOG_ID = "catalog:github-pat";

/**
 * Defensive upper bound on the PAT field. Real GitHub tokens are
 * well under 200 chars (classic: 40 hex chars; fine-grained:
 * `github_pat_` + ~80 chars). 4096 is the same belt-and-braces cap
 * Linear API-key uses — JSONB rows shouldn't carry 50MB strings.
 */
const PAT_MAX = 4096;

/**
 * GitHub PATs come in two shapes that we accept:
 *   - Classic: `ghp_` followed by 36 base62 chars (older format).
 *   - Fine-grained: `github_pat_` followed by ~82 chars (`A-Za-z0-9_`).
 *
 * The regex is permissive — we accept the union of "alphanumeric +
 * underscore" but DON'T enforce the prefix. A token mis-typed without
 * the prefix is better surfaced as a clean GitHub-side 401 from the
 * first API call than as a vague form-validation error that doesn't
 * explain WHY the input shape matters. Same rationale as the Linear
 * API-key handler.
 */
const GITHUB_PAT_RE = /^[A-Za-z0-9_]+$/;

/**
 * GitHub owner names (users + organizations) are constrained to
 * 1–39 chars of alphanumerics and single hyphens. We enforce the
 * length ceiling locally so a typo'd 40+ char value surfaces as a
 * deterministic form error instead of a confusing GitHub-side 404
 * later when the agent tries to create an issue. We don't enforce the
 * hyphen rules here (no leading/trailing/double hyphens) — that's a
 * GitHub-side 404 the agent surfaces clearly.
 */
const GITHUB_OWNER_MAX = 39;
const GITHUB_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export const GitHubPatFormDataSchema = z.object({
  pat: z
    .string()
    .min(1, "pat is required")
    .max(PAT_MAX, `pat must be ${PAT_MAX} characters or fewer`)
    .regex(
      GITHUB_PAT_RE,
      "pat contains characters GitHub tokens never use — copy the value directly from https://github.com/settings/tokens",
    ),
  /**
   * Optional default owner (user or organization) the agent falls back
   * to when an `issueCreate`-style call doesn't specify one. The
   * preprocess step normalizes the admin form's empty-string default
   * (`buildDefaultValues` in form-install-modal initializes optional
   * string fields to `""`) to `undefined` so leaving the field blank
   * round-trips as "no default" instead of failing validation.
   */
  default_owner: z
    .preprocess(
      (v) => (v === "" ? undefined : v),
      z
        .string()
        .min(1)
        .max(GITHUB_OWNER_MAX, `default_owner must be ${GITHUB_OWNER_MAX} characters or fewer (GitHub's user/org name limit)`)
        .regex(
          GITHUB_OWNER_RE,
          "default_owner must start with an alphanumeric and contain only alphanumerics and hyphens (GitHub user/org name rules)",
        )
        .optional(),
    ),
}).strict();

export type GitHubPatFormData = z.infer<typeof GitHubPatFormDataSchema>;

/**
 * `encryptSecretFields` / `decryptSecretFields` schema for the GitHub
 * PAT handler. The `fields[].key` element is constrained to
 * `keyof GitHubPatFormData` so a Zod rename without a matching update
 * here surfaces as a TS error rather than a silent encryption regression
 * at runtime.
 */
export const GITHUB_PAT_SECRET_FIELDS_SCHEMA: ConfigSchema & {
  state: "parsed";
  fields: ReadonlyArray<ConfigSchemaField & { key: keyof GitHubPatFormData }>;
} = {
  state: "parsed",
  fields: [
    { key: "pat", type: "string", secret: true },
    { key: "default_owner", type: "string" },
  ],
};
