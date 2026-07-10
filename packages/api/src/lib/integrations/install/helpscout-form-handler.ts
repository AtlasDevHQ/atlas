/**
 * `HelpScoutFormInstallHandler` — the {@link FormBasedInstallHandler} for the
 * built-in `helpscout` Knowledge Base catalog row (#4398, PRD #4395). The
 * simplest install in the support tier: a single Docs API key over HTTP Basic
 * auth, no OAuth, no customer-supplied host.
 *
 * Installing `helpscout` creates one synced collection PER Docs SITE (the PRD's
 * "one collection per Site"): the handler enumerates the account's sites with
 * the supplied key and upserts one `pillar='knowledge'` `workspace_plugins` row
 * per site, each config pinned to that site's id. A single site (the common
 * case) gets exactly the chosen collection slug; multiple sites fan out to
 * `<slug>-<site>`. The Scheduler dispatches the registered Help Scout connector
 * per collection on a cadence (`lib/knowledge/connector-sync.ts`), and every
 * synced article lands `draft`.
 *
 * Beyond the GitBook precedent it inherits (fixed vendor host — no install-time
 * SSRF gate, the connector still routes every fetch through the egress guard;
 * loud credential verification; key routed to `knowledge_sync_credentials`,
 * never `workspace_plugins.config`), it follows Zendesk's multi-instance
 * discipline: every per-site slug is availability-checked BEFORE any write;
 * writes then run per site (credential → row). A mid-fan-out failure leaves
 * earlier sites fully installed and working; the thrown error says retrying is
 * safe (all writes are idempotent upserts converging on the same slugs). The
 * one transition caveat: a single-site install that later becomes multi-site
 * re-fans-out under suffixed slugs — the old base-slug collection stays behind
 * and should be uninstalled by the admin.
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import { EgressBlockedError } from "@atlas/api/lib/openapi/egress-guard";
import {
  saveSyncCredential,
  deleteSyncCredential,
} from "@atlas/api/lib/knowledge/sync-credentials";
import {
  listHelpScoutSites,
  HelpScoutAuthError,
  type HelpScoutSite,
  type HelpScoutClientDeps,
} from "@atlas/api/lib/knowledge/helpscout/client";
import {
  HELPSCOUT_SLUG,
  HELPSCOUT_CATALOG_ID,
  type HelpScoutCollectionConfig,
} from "@atlas/api/lib/knowledge/helpscout/config";
import {
  assertSaasEncryptionKeyset,
  FormInstallValidationError,
} from "./persist-form-install";
import {
  assertCollectionSlugAvailable,
  resolveCollectionSlug,
  COLLECTION_SLUG_MAX,
  KNOWLEDGE_INSTALL_ID_FIELD,
} from "./okf-upload-form-handler";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

// Re-exported for the register.ts boot wiring; both are single-homed in config.ts.
export { HELPSCOUT_SLUG, HELPSCOUT_CATALOG_ID };

/** Defensive upper bounds — guard against pathological pastes. */
const API_KEY_MAX = 4096;
/** A slug-safe suffix label (the per-site fan-out suffix). */
const SLUG_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface HelpScoutFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the site-enumeration fetch (no real Help Scout call). */
  readonly clientDeps?: HelpScoutClientDeps;
}

/**
 * The multi-instance synced-collection upsert. Identical shape to the Zendesk /
 * GitBook knowledge upserts: `status='published'` because the COLLECTION
 * container is live immediately — the review gate is on the DOCUMENTS, which
 * always sync in as `draft`. Exported so the real-Postgres test executes this
 * exact string against the live schema.
 */
export const HELPSCOUT_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export class HelpScoutFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly clientDeps: HelpScoutClientDeps;
  private readonly log = createLogger("integrations.install.helpscout");

  constructor(options: HelpScoutFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
    this.clientDeps = options.clientDeps ?? {};
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{ readonly installRecord: InstallRecord; readonly credentialWritten: boolean }> {
    if (formData === null || typeof formData !== "object" || Array.isArray(formData)) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: ["Request body must be a JSON object of config fields."],
      });
    }
    const rawForm = formData as Record<string, unknown>;

    const baseSlug = resolveCollectionSlug(rawForm[KNOWLEDGE_INSTALL_ID_FIELD], HELPSCOUT_SLUG);

    // ── Validate fields ────────────────────────────────────────────────────
    const apiKey = validateApiKey(rawForm.api_key);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [HELPSCOUT_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "helpscout catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${HELPSCOUT_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    // ── Enumerate sites = verify the connection loudly BEFORE persisting ─────
    const sites = await this.enumerateSites(apiKey);
    if (sites.length === 0) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [
          "This Help Scout account has no Docs sites — create a Docs site in Help Scout, then re-install.",
        ],
      });
    }

    // ── Compute + validate every per-site slug BEFORE any write ──────────────
    const planned = sites.map((site) => ({
      site,
      slug: sites.length === 1 ? baseSlug : `${baseSlug}-${siteSlugSuffix(site)}`,
    }));
    for (const { slug } of planned) {
      if (slug.length > COLLECTION_SLUG_MAX) {
        throw new FormInstallValidationError({
          fieldErrors: {
            [KNOWLEDGE_INSTALL_ID_FIELD]: [
              `Collection id "${slug}" (the per-site fan-out of "${baseSlug}") exceeds ${COLLECTION_SLUG_MAX} characters — choose a shorter collection id.`,
            ],
          },
          formErrors: [],
        });
      }
      await assertCollectionSlugAvailable(workspaceId, slug, catalogId);
    }

    // ── Per-site writes: credential first, then the collection row ───────────
    assertSaasEncryptionKeyset(this.log, workspaceId, "api_key");
    let firstRecord: InstallRecord | null = null;
    for (const { site, slug } of planned) {
      const record = await this.installSiteCollection({
        workspaceId,
        catalogId,
        slug,
        site,
        config: {
          site_id: site.id,
          site_name: site.name,
          ...(site.subdomain !== null ? { subdomain: site.subdomain } : {}),
          ...(description !== null ? { description } : {}),
        },
        apiKey,
      });
      firstRecord ??= record;
    }

    this.log.info(
      {
        workspaceId,
        collections: planned.map((p) => p.slug),
        sites: planned.length,
      },
      "Help Scout collection install completed",
    );
    // `firstRecord` is set on the first loop iteration (planned is non-empty).
    if (firstRecord === null) {
      throw new Error("Help Scout install produced no collection record — invariant violation");
    }
    return { installRecord: firstRecord, credentialWritten: true };
  }

  /** Write one site's credential + collection row, GitBook/Zendesk rollback posture. */
  private async installSiteCollection(input: {
    workspaceId: WorkspaceId;
    catalogId: string;
    slug: string;
    site: HelpScoutSite;
    config: HelpScoutCollectionConfig;
    apiKey: string;
  }): Promise<InstallRecord> {
    const { workspaceId, catalogId, slug, site, config, apiKey } = input;
    try {
      await saveSyncCredential(workspaceId, slug, apiKey);
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug: slug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist knowledge_sync_credentials row — aborting install (retrying is safe; completed site collections stay installed)",
      );
      throw retryableInstallError(slug, err);
    }

    const candidateId = this.newId();
    try {
      const rows = await internalQuery<{ id: string }>(HELPSCOUT_INSTALL_UPSERT_SQL, [
        candidateId,
        workspaceId,
        catalogId,
        slug,
        JSON.stringify(config),
      ]);
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        this.log.error(
          { workspaceId, candidateId, collectionSlug: slug },
          "workspace_plugins upsert returned no id — Postgres invariant violation",
        );
        throw new Error(
          "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
        );
      }
      return { id: returned, workspaceId, catalogId: HELPSCOUT_SLUG };
    } catch (err) {
      // Roll back the just-written credential so a secret can't outlive a failed
      // install (this site's install row never landed, so uninstall would never
      // reach it). Best-effort — a re-install overwrites it either way; a
      // cleanup failure is logged, never masks the original error.
      this.log.error(
        {
          workspaceId,
          collectionSlug: slug,
          siteId: site.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to persist helpscout collection install — rolling back the orphaned credential (retrying the install is safe)",
      );
      try {
        await deleteSyncCredential(workspaceId, slug);
      } catch (cleanupErr) {
        this.log.error(
          {
            workspaceId,
            collectionSlug: slug,
            err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          },
          "Failed to roll back the orphaned credential after an install-row failure — a re-install overwrites it",
        );
      }
      throw retryableInstallError(slug, err);
    }
  }

  /**
   * Enumerate Docs sites with the supplied key; map every failure to a 400.
   * Classification is POSITIVE, by `instanceof` on the client's typed errors —
   * never by message text or `cause`-presence sniffing — so only a failure the
   * client KNOWS is credential-shaped blames the api_key field; a Help Scout
   * outage or transport error stays form-level (re-entering a fine key would be
   * the wrong guidance). All messages host-redacted by the client.
   */
  private async enumerateSites(apiKey: string): Promise<HelpScoutSite[]> {
    try {
      return await listHelpScoutSites({ apiKey }, this.clientDeps);
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        // Defence-in-depth: the fixed Help Scout host should never be blocked,
        // but if a deploy's egress policy blocks it, surface it as form-level.
        throw new FormInstallValidationError({ fieldErrors: {}, formErrors: [err.message] });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof HelpScoutAuthError) {
        throw new FormInstallValidationError({
          fieldErrors: { api_key: [message] },
          formErrors: [],
        });
      }
      // Everything else — 429 (ConnectorRateLimitError), a 404 (unexpected on
      // /v1/sites), vendor 5xx, transport/DNS/non-JSON — is form-level: the key
      // may be fine, so blaming the field would send the admin re-entering a
      // good value. All host-redacted by the client.
      throw new FormInstallValidationError({ fieldErrors: {}, formErrors: [message] });
    }
  }
}

/**
 * Derive a slug-safe fan-out suffix for a site: prefer its `*.helpscoutdocs.com`
 * subdomain label (clean + stable), else its immutable id — both sanitized to
 * `[a-z0-9-]`. The id is the deterministic fallback so two sites never collide.
 */
function siteSlugSuffix(site: HelpScoutSite): string {
  const preferred =
    site.subdomain !== null && SLUG_LABEL_PATTERN.test(site.subdomain) ? site.subdomain : site.id;
  const sanitized = preferred
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized === "" ? "site" : sanitized;
}

function validateApiKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError(
      "api_key",
      "A Help Scout Docs API key is required. Create one in Help Scout → Your Profile → Authentication → API Keys.",
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length > API_KEY_MAX) {
    throw fieldError("api_key", `The API key must be ${API_KEY_MAX} characters or fewer.`);
  }
  if (/\s/.test(trimmed)) {
    throw fieldError("api_key", "Key must not contain spaces — paste it exactly as Help Scout shows it.");
  }
  return trimmed;
}

function validateDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw fieldError("description", "Description must be a string.");
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function fieldError(field: string, message: string): FormInstallValidationError {
  return new FormInstallValidationError({ fieldErrors: { [field]: [message] }, formErrors: [] });
}

/**
 * Wrap a mid-fan-out persistence failure with the retry guidance the admin
 * needs: all writes are idempotent upserts converging on the same slugs, so
 * re-running the install is always safe. The original failure rides as cause.
 */
function retryableInstallError(slug: string, err: unknown): Error {
  return new Error(
    `Failed to install the "${slug}" collection: ${err instanceof Error ? err.message : String(err)}. Retrying the install is safe — already-installed site collections are simply updated in place.`,
    { cause: err },
  );
}
