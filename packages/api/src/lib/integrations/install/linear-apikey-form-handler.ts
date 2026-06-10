/**
 * `LinearApiKeyFormInstallHandler` — Linear API-key install (#2750).
 *
 * Second {@link FormBasedInstallHandler} implementation after Email
 * (#2697). The admin pastes a Linear Personal API Key from their
 * Linear settings page; the key encrypts inline via
 * `encryptSecretFields` into `workspace_plugins.config.api_key`.
 *
 * Trade-off vs the OAuth mode (`linear` slug — see
 * {@link LinearOAuthInstallHandler}):
 *
 *   - **API-key mode** is the simplest install: no OAuth App
 *     registration, no callback URL plumbing, no refresh-token
 *     lifecycle. Drawback: the key is tied to one Linear user — if
 *     that user is deactivated, Atlas's access dies and the workspace
 *     admin has to issue a new key. Also, API keys don't carry per-
 *     workspace scoping, so a deactivated user's key is useless for
 *     any of their workspaces.
 *   - **OAuth mode** rotates access tokens automatically and survives
 *     the granting user being deactivated (the refresh-token flow re-
 *     issues an access token tied to the OAuth grant, not the user
 *     session).
 *
 * SaaS-eligible at the entry plan tier per the catalog declaration —
 * API-key mode is mostly a self-host convenience but acceptable on SaaS
 * for entry-tier workspaces where the OAuth dance feels like overkill.
 *
 * Connection liveness: NOT probed at install time. A failed Linear API
 * round-trip at install would surface as a misleading "couldn't reach
 * Linear" error even when the user's key is correct; the first
 * agent-issued `createLinearIssue` call surfaces real auth errors with
 * the full path intact (HTTP 401 vs API rate-limit vs network).
 *
 * Persistence (keyset gate → encrypt → upsert → id invariant → lazy-
 * loader evict so a rotated key never serves a stale in-memory
 * instance) lives on the shared spine — see {@link persistFormInstall}.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ./linear-apikey-secret-schema.ts — shared form + secret schema
 * @see ./persist-form-install.ts — {@link persistFormInstall}
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import type { WorkspaceId } from "@useatlas/types";
import {
  LINEAR_APIKEY_SECRET_FIELDS_SCHEMA,
  LinearApiKeyFormDataSchema,
} from "./linear-apikey-secret-schema";
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

const log = createLogger("integrations.install.linear-apikey");

/** Catalog slug — the dispatch key in {@link registerFormHandler}. */
const LINEAR_APIKEY_SLUG: CatalogId = "linear-apikey";

/** Test-only injection of the install id generator. */
export interface LinearApiKeyFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
}

export class LinearApiKeyFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;

  constructor(options: LinearApiKeyFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }> {
    const config = parseFormInstall(LinearApiKeyFormDataSchema, formData);

    const installRecord = await persistFormInstall({
      workspaceId,
      catalogSlug: LINEAR_APIKEY_SLUG,
      displayName: "Linear API-key",
      log,
      config,
      secretFieldsSchema: LINEAR_APIKEY_SECRET_FIELDS_SCHEMA,
      newId: () => this.newId(),
    });

    log.info(
      {
        workspaceId,
        installId: installRecord.id,
        workspaceName: config.workspace_name ?? null,
      },
      "Linear API-key install completed",
    );
    return { installRecord, credentialWritten: true };
  }
}
