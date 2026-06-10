/**
 * `TwentyFormInstallHandler` — admin UI override flow for the Twenty
 * CRM integration.
 *
 * The admin submits a baseUrl + apiKey via the standard
 * `FormInstallModal`; this handler validates, encrypts the apiKey
 * (via `db/secret-encryption.ts` per the CLAUDE.md guidance for new
 * integration credential columns), and writes BOTH stores in one
 * transaction-equivalent sequence:
 *
 *   1. `twenty_integrations` — the dedicated credential table from
 *     #2727. `saveTwentyIntegration` upserts by `workspace_id`. This
 *     is what the SaaS dispatcher consults at flush time.
 *   2. `workspace_plugins` — the catalog install record (ADR-0003 dual
 *     store). Enables the catalog UI's "Installed" state + the
 *     standard catalog DELETE teardown path. Persisted via the shared
 *     spine ({@link persistFormInstall}) with an empty config stub —
 *     the credential is never duplicated into `config`, and a conflict
 *     re-install keeps the existing row's config untouched.
 *
 * **No Atlas-SaaS leak in defaults.** The form requires `baseUrl` —
 * there is no default `https://crm.useatlas.dev`. That URL is Atlas's
 * own Twenty instance; defaulting to it would silently route a
 * self-hosted operator's integration at Atlas's CRM. The Atlas SaaS
 * deployment carries `crm.useatlas.dev` separately via
 * `ATLAS_TWENTY_BASE_URL` / `TWENTY_BASE_URL`.
 *
 * **SaaS-mode keyset gate.** Checked explicitly BEFORE the
 * `twenty_integrations` write (the spine re-checks before the catalog
 * upsert, but by then the credential row would already exist) — a
 * misconfigured SaaS deploy must fail closed before any credential
 * byte is persisted. See {@link assertSaasEncryptionKeyset}.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ./persist-form-install.ts — {@link persistFormInstall}
 * @see ../twenty/store.ts — `saveTwentyIntegration` (credential table)
 */

import crypto from "crypto";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import type { WorkspaceId } from "@useatlas/types";
import { saveTwentyIntegration } from "@atlas/api/lib/integrations/twenty/store";
import {
  assertSaasEncryptionKeyset,
  parseFormInstall,
  persistFormInstall,
} from "./persist-form-install";
import { safeHost } from "./safe-host";
import type {
  CatalogId,
  FormBasedInstallHandler,
  InstallRecord,
} from "./types";

const log = createLogger("integrations.install.twenty");

/** Catalog slug — the dispatch key in {@link registerFormHandler}. */
export const TWENTY_SLUG: CatalogId = "twenty";

/**
 * Stable `plugin_catalog.id` for Twenty. The seeder derives row ids
 * as `catalog:${slug}` (see `catalog-seeder.ts::upsertEntry`), so the
 * FK target in `workspace_plugins.catalog_id` is `catalog:twenty`.
 * (The spine derives the same id from {@link TWENTY_SLUG}; this export
 * remains for the dispatcher/store call sites that key on it.)
 */
export const TWENTY_CATALOG_ID = "catalog:twenty";

/** Defensive upper bound on the apiKey — guards against pathological pastes. */
const API_KEY_MAX = 4096;

/**
 * Twenty REST base URL — required, no default. The admin MUST type
 * their own Twenty hostname; we never silently route at
 * `crm.useatlas.dev` (see header comment for the threat model).
 *
 * Native URL parsing rejects whitespace-only / control-char inputs;
 * the post-parse refine pins http/https (Twenty instances live on
 * customer-controlled DNS, sometimes behind dev-only http — accept
 * both rather than gate the form on a TLS requirement we don't need
 * for an outbound bearer-auth REST call).
 */
const TwentyBaseUrlSchema = z
  .string()
  .min(1, "baseUrl is required (enter your Twenty hostname)")
  .transform((raw) => raw.trim())
  .refine(
    (raw) => {
      try {
        const u = new URL(raw);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        // intentionally ignored: URL constructor throw is the negative
        // validation signal — the user sees the .refine message below.
        return false;
      }
    },
    "baseUrl must be a well-formed URL (e.g. https://crm.example.com)",
  );

export const TwentyFormDataSchema = z
  .object({
    baseUrl: TwentyBaseUrlSchema,
    apiKey: z
      .string()
      .min(1, "apiKey is required")
      .max(API_KEY_MAX, `apiKey must be ${API_KEY_MAX} characters or fewer`)
      .transform((raw) => raw.trim())
      .refine((raw) => raw.length > 0, "apiKey is required"),
  })
  .strict();

export type TwentyFormData = z.infer<typeof TwentyFormDataSchema>;

/** Test-only injection of the install id generator. */
export interface TwentyFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
}

export class TwentyFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;

  constructor(options: TwentyFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }> {
    // ── 1. Validate the form against the Twenty schema ──────────────
    const { apiKey, baseUrl } = parseFormInstall(TwentyFormDataSchema, formData);

    // ── 2. SaaS keyset gate — BEFORE the credential write ────────────
    assertSaasEncryptionKeyset(log, workspaceId, "api_key");

    // ── 3. Write the credential row in twenty_integrations ──────────
    // Encryption happens inside the store; we never see ciphertext at
    // this layer. The store throws if the internal DB is unconfigured,
    // or if a different workspace already has a row under SaaS (the
    // multi-tenant guard pending #2849).
    try {
      await saveTwentyIntegration(workspaceId, { apiKey, baseUrl });
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist twenty_integrations row — aborting install",
      );
      throw err;
    }

    // ── 4. Upsert workspace_plugins (catalog install record) ────────
    // Empty config — credentials live in twenty_integrations; the
    // workspace_plugins row carries only catalog binding state. On
    // the spine's failure path the twenty_integrations row is NOT
    // rolled back — the credential is the load-bearing artefact; the
    // catalog row is a UI mirror, and re-running the install heals it
    // (the failure log below says so).
    const installRecord = await persistFormInstall({
      workspaceId,
      catalogSlug: TWENTY_SLUG,
      displayName: "Twenty",
      log,
      config: {},
      plaintextSecretLabel: "api_key",
      newId: () => this.newId(),
      updateConfigOnConflict: false,
      persistFailureMessage:
        "Failed to persist Twenty install record — twenty_integrations row is persisted (retrying the install is safe; the credential write is idempotent)",
    });

    log.info(
      {
        workspaceId,
        installId: installRecord.id,
        baseUrlHost: safeHost(baseUrl),
      },
      "Twenty admin-UI install completed",
    );
    return { installRecord, credentialWritten: true };
  }
}
