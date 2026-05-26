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
 *     standard catalog DELETE teardown path.
 *
 * **No Atlas-SaaS leak in defaults.** The form requires `baseUrl` —
 * there is no default `https://crm.useatlas.dev`. That URL is Atlas's
 * own Twenty instance; defaulting to it would silently route a
 * self-hosted operator's integration at Atlas's CRM. The Atlas SaaS
 * deployment carries `crm.useatlas.dev` separately via
 * `ATLAS_TWENTY_BASE_URL` / `TWENTY_BASE_URL`.
 *
 * **SaaS-mode keyset gate.** When `ATLAS_DEPLOY_MODE=saas` and no
 * encryption keyset is configured, `encryptSecret` falls back to
 * plaintext (dev convenience). Boot logs a one-shot warning, but a
 * missed log in SaaS would leak the apiKey plaintext. Refuse the
 * install per-call so a misconfigured SaaS deploy fails closed at the
 * credential boundary. Mirrors the EmailFormInstallHandler posture.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ../twenty/store.ts — `saveTwentyIntegration` (credential table)
 */

import crypto from "crypto";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import type { WorkspaceId } from "@useatlas/types";
import { saveTwentyIntegration } from "@atlas/api/lib/integrations/twenty/store";
import { FormInstallValidationError } from "./email-form-handler";
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
    const parsed = TwentyFormDataSchema.safeParse(formData);
    if (!parsed.success) {
      throw FormInstallValidationError.fromZodFlatten(parsed.error.flatten());
    }
    const { apiKey, baseUrl } = parsed.data;

    // ── 2. SaaS keyset gate ─────────────────────────────────────────
    // Refuse the install when SaaS mode + no keyset — encryptSecret
    // would otherwise silently persist plaintext. Mirrors the Email +
    // Linear API-key handler posture.
    if (process.env.ATLAS_DEPLOY_MODE === "saas" && !getEncryptionKeyset()) {
      log.error(
        { workspaceId },
        "Refusing form install: SaaS mode + no encryption keyset (would persist plaintext api_key)",
      );
      throw new Error(
        "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. " +
          "Set ATLAS_ENCRYPTION_KEYS and retry.",
      );
    }

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
    // The credential is NOT duplicated here — it lives in the
    // dedicated `twenty_integrations` table. The workspace_plugins
    // row carries only catalog binding state so the admin UI's
    // catalog card reflects "Installed" and the standard catalog
    // DELETE path (which removes the workspace_plugins row) flows
    // through.
    //
    // Pillar='action' + install_id named explicitly per the
    // `workspace_plugins` partial unique index on
    // `(workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')`.
    // `RETURNING id` lets us pick up the existing id rather than a
    // phantom freshly-generated one on conflict.
    const candidateId = this.newId();
    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'action', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE
           SET enabled = true
         RETURNING id`,
        [
          candidateId,
          workspaceId,
          TWENTY_CATALOG_ID,
          // Empty config — credentials live in twenty_integrations.
          JSON.stringify({}),
        ],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        log.warn(
          { workspaceId, candidateId },
          "workspace_plugins upsert returned no id — falling back to candidate",
        );
        persistedId = candidateId;
      } else {
        persistedId = returned;
      }
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist Twenty install record — twenty_integrations row is persisted (retrying the install is safe; the credential write is idempotent)",
      );
      // Don't roll back the twenty_integrations row — the credential
      // is the load-bearing artefact; the catalog row is a UI mirror.
      // Re-running the install heals the catalog row.
      throw err;
    }

    log.info(
      {
        workspaceId,
        installId: persistedId,
        baseUrlHost: safeHost(baseUrl),
      },
      "Twenty admin-UI install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: TWENTY_SLUG },
      credentialWritten: true,
    };
  }
}

/** Best-effort host extraction for log breadcrumbs — never throws. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // intentionally ignored: log breadcrumb only — URL was already
    // validated by zod refine above, so reaching this branch implies
    // a malformed log entry, not a malformed user input.
    return "<unparseable>";
  }
}
