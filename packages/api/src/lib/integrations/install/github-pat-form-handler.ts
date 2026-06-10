/**
 * `GitHubPatFormInstallHandler` — GitHub Personal Access Token install
 * (#2751, Phase D PAT mode).
 *
 * Form-based install mirroring {@link LinearApiKeyFormInstallHandler}.
 * The admin pastes a PAT from https://github.com/settings/tokens; the
 * token encrypts inline via `encryptSecretFields` into
 * `workspace_plugins.config.pat`.
 *
 * Self-host only: the matching catalog row carries `saas_eligible:
 * false`. Failure mode is too sharp for SaaS — a PAT is tied to one
 * GitHub user and dies if that user leaves the org or rotates the
 * token. The integrations-catalog route filters this row out on SaaS
 * deploys. The spine's SaaS keyset gate stays as defense-in-depth: if
 * a SaaS deploy somehow surfaces the install path, it refuses to
 * persist plaintext.
 *
 * Connection liveness: NOT probed at install time. A failed GitHub API
 * round-trip at install would surface as a misleading "couldn't reach
 * GitHub" error even when the user's token is correct; the first
 * agent-issued GitHub call surfaces real auth errors with the full
 * path intact (HTTP 401 vs API rate-limit vs network).
 *
 * Persistence lives on the shared spine — see {@link persistFormInstall}.
 * The spine's unconditional evict means re-installs that rotate the PAT
 * never leave a stale in-memory instance behind once the GitHub action
 * tool (follow-up PR) lands its lazy builder.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ./github-pat-secret-schema.ts — shared form + secret schema
 * @see ./linear-apikey-form-handler.ts — sibling form-handler reference
 * @see ./persist-form-install.ts — {@link persistFormInstall}
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import type { WorkspaceId } from "@useatlas/types";
import {
  GITHUB_PAT_SECRET_FIELDS_SCHEMA,
  GitHubPatFormDataSchema,
} from "./github-pat-secret-schema";
import {
  FormInstallValidationError,
  parseFormInstall,
  persistFormInstall,
} from "./persist-form-install";
import type {
  CatalogId,
  FormBasedInstallHandler,
  InstallRecord,
} from "./types";

// Re-export the validation error class for callers that catch with
// `instanceof`. {@link FormInstallValidationError} is the canonical
// throw type for every form-based install handler.
export { FormInstallValidationError };

const log = createLogger("integrations.install.github-pat");

const GITHUB_PAT_SLUG: CatalogId = "github-pat";

export interface GitHubPatFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
}

export class GitHubPatFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;

  constructor(options: GitHubPatFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }> {
    const config = parseFormInstall(GitHubPatFormDataSchema, formData);

    const installRecord = await persistFormInstall({
      workspaceId,
      catalogSlug: GITHUB_PAT_SLUG,
      displayName: "GitHub PAT",
      log,
      config,
      secretFieldsSchema: GITHUB_PAT_SECRET_FIELDS_SCHEMA,
      newId: () => this.newId(),
    });

    log.info(
      {
        workspaceId,
        installId: installRecord.id,
        defaultOwner: config.default_owner ?? null,
      },
      "GitHub PAT install completed",
    );
    return { installRecord, credentialWritten: true };
  }
}
