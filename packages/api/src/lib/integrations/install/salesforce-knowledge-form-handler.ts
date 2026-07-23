/**
 * `SalesforceKnowledgeFormInstallHandler` — the {@link FormBasedInstallHandler}
 * for the built-in `salesforce-knowledge` Knowledge Base catalog row (#4397,
 * PRD #4395).
 *
 * Installing `salesforce-knowledge` creates one synced collection scoped to an
 * article-version object + optional channel; the Scheduler dispatches the
 * registered Salesforce Knowledge connector per collection on a cadence
 * (`lib/knowledge/connector-sync.ts`), and every synced article lands `draft`.
 *
 * The tier's one credential-model departure: this handler collects NO secret.
 * The connector reuses the workspace's EXISTING Salesforce OAuth install
 * (`catalog:salesforce`, ADR-0014, #3302) through the lazy plugin loader, so
 * there is no `knowledge_sync_credentials` write, no rollback pairing, and no
 * new connected-app registration. What replaces the credential check is the
 * same loud pre-write verification the tier demands: the handler resolves the
 * live Salesforce instance (surfacing "connect Salesforce first" /
 * "Reconnect" as actionable 400s) and `describe`s the configured article
 * object (surfacing "Lightning Knowledge is not enabled" / a bad channel
 * scope as field-level 400s) BEFORE persisting anything.
 *
 * Multi-instance by design: a workspace installs one collection per
 * channel/object scope (distinct `install_id`s), e.g. a public `pkb`
 * collection next to an internal all-channels one.
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import type { SalesforcePluginInstance } from "@atlas/api/lib/integrations/salesforce/lazy-builder";
import {
  instanceUrlOf,
  resolveSalesforceKnowledgeInstance,
  type SalesforceInstanceLoader,
} from "@atlas/api/lib/knowledge/salesforce/connector";
import {
  ARTICLE_OBJECT_PATTERN,
  DEFAULT_ARTICLE_OBJECT,
  SALESFORCE_KNOWLEDGE_CHANNEL_FIELDS,
  SALESFORCE_KNOWLEDGE_SLUG,
  SALESFORCE_KNOWLEDGE_CATALOG_ID,
  isSalesforceKnowledgeChannel,
  type SalesforceKnowledgeChannel,
  type SalesforceKnowledgeCollectionConfig,
} from "@atlas/api/lib/knowledge/salesforce/config";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import { hostForLog } from "@atlas/api/lib/openapi/egress-guard";
import { FormInstallValidationError } from "./persist-form-install";
import {
  assertCollectionInstallable,
  upsertKnowledgeCollectionRow,
} from "./knowledge-collection-install";
import {
  KNOWLEDGE_INSTALL_ID_FIELD,
  resolveCollectionSlug,
} from "./knowledge-collection-slug";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

// Re-exported for the register.ts boot wiring; both are single-homed in config.ts.
export { SALESFORCE_KNOWLEDGE_SLUG, SALESFORCE_KNOWLEDGE_CATALOG_ID };

/** Defensive upper bound — guard against pathological pastes. */
const ARTICLE_OBJECT_MAX = 120;

export interface SalesforceKnowledgeFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the lazy loader (no real Salesforce call). */
  readonly loader?: SalesforceInstanceLoader;
}

/**
 * The synced-collection upsert. Identical shape to
 * `ZENDESK_INSTALL_UPSERT_SQL`: `status='published'` because the COLLECTION
 * container is live immediately — the review gate is on the DOCUMENTS, which
 * always sync in as `draft`. Exported so the real-Postgres test executes this
 * exact string against the live schema.
 */
export const SALESFORCE_KNOWLEDGE_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export class SalesforceKnowledgeFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly loader: SalesforceInstanceLoader;
  private readonly log = createLogger("integrations.install.salesforce-knowledge");

  constructor(options: SalesforceKnowledgeFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
    this.loader = options.loader ?? lazyPluginLoader;
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

    const slug = resolveCollectionSlug(
      rawForm[KNOWLEDGE_INSTALL_ID_FIELD],
      SALESFORCE_KNOWLEDGE_SLUG,
    );

    // ── Validate fields ────────────────────────────────────────────────────
    const articleObject = validateArticleObject(rawForm.article_object);
    const channel = validateChannel(rawForm.channel);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [SALESFORCE_KNOWLEDGE_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "salesforce-knowledge catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${SALESFORCE_KNOWLEDGE_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    await assertCollectionInstallable(workspaceId, slug, catalogId, this.log);

    // ── Verify the reused Salesforce connection loudly BEFORE persisting ────
    const instance = await this.resolveInstance(workspaceId);
    // Resolve the org URL pre-write too: a builder without one must be an
    // actionable 400 here, not a 500 after the row already landed.
    let instanceHost: string;
    try {
      instanceHost = hostForLog(instanceUrlOf(instance));
    } catch (err) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [err instanceof Error ? err.message : String(err)],
      });
    }
    await this.verifyArticleObject(instance, articleObject, channel);

    // ── Persist the collection row (no credential — the OAuth install owns it) ─
    const config: SalesforceKnowledgeCollectionConfig = {
      article_object: articleObject,
      ...(channel !== null ? { channel } : {}),
      ...(description !== null ? { description } : {}),
    };
    const candidateId = this.newId();
    const returned = await upsertKnowledgeCollectionRow({
      workspaceId,
      collectionSlug: slug,
      sql: SALESFORCE_KNOWLEDGE_INSTALL_UPSERT_SQL,
      params: [candidateId, workspaceId, catalogId, slug, JSON.stringify(config)],
      candidateId,
      log: this.log,
    });

    this.log.info(
      { workspaceId, collectionSlug: slug, articleObject, channel, host: instanceHost },
      "Salesforce Knowledge collection install completed",
    );
    return {
      installRecord: { id: returned, workspaceId, catalogId: SALESFORCE_KNOWLEDGE_SLUG },
      credentialWritten: false,
    };
  }

  /**
   * Resolve the workspace's live Salesforce OAuth instance, mapping every
   * failure to an actionable form-level 400 (there is no credential field to
   * blame — the fix is on the Integrations page or the operator's deploy).
   */
  private async resolveInstance(workspaceId: WorkspaceId): Promise<SalesforcePluginInstance> {
    try {
      return await resolveSalesforceKnowledgeInstance(this.loader, workspaceId);
    } catch (err) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  /**
   * Describe the configured article object — the install-time connection +
   * scope check. A failed describe blames the `article_object` field (wrong
   * object / Knowledge not enabled); a channel whose visibility field the
   * object lacks blames `channel`.
   */
  private async verifyArticleObject(
    instance: SalesforcePluginInstance,
    articleObject: string,
    channel: SalesforceKnowledgeChannel | null,
  ): Promise<void> {
    let fields: readonly Record<string, unknown>[];
    try {
      fields = (await instance.describeObject(articleObject)).fields;
    } catch (err) {
      throw new FormInstallValidationError({
        fieldErrors: {
          article_object: [
            `Salesforce could not describe ${articleObject}: ${err instanceof Error ? err.message : String(err)}. Check that Lightning Knowledge is enabled and the connected user can read the object.`,
          ],
        },
        formErrors: [],
      });
    }
    const names = new Set(fields.map((f) => (typeof f.name === "string" ? f.name : "")));
    if (channel !== null) {
      const visibilityField = SALESFORCE_KNOWLEDGE_CHANNEL_FIELDS[channel];
      if (!names.has(visibilityField)) {
        throw new FormInstallValidationError({
          fieldErrors: {
            channel: [
              `${articleObject} has no ${visibilityField} field — the "${channel}" channel scope cannot be applied to it.`,
            ],
          },
          formErrors: [],
        });
      }
    }
    const bodyFieldCount = fields.filter(
      (f) => f.custom === true && f.type === "textarea",
    ).length;
    if (bodyFieldCount === 0) {
      // Not fatal (Title/Summary can carry prose) — but never silent.
      this.log.warn(
        { articleObject },
        "Salesforce article object has no custom textarea body fields — synced documents will carry only title/summary prose",
      );
    }
  }
}

/** Validate the article-version object API name (optional; defaulted). */
function validateArticleObject(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_ARTICLE_OBJECT;
  if (typeof raw !== "string") {
    throw fieldError("article_object", "The article object must be a string.");
  }
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_ARTICLE_OBJECT;
  if (trimmed.length > ARTICLE_OBJECT_MAX || !ARTICLE_OBJECT_PATTERN.test(trimmed)) {
    throw fieldError(
      "article_object",
      `Enter an article-version object API name ending in __kav (default: ${DEFAULT_ARTICLE_OBJECT}).`,
    );
  }
  return trimmed;
}

/** Validate the optional channel scope. */
function validateChannel(raw: unknown): SalesforceKnowledgeChannel | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw fieldError("channel", "The channel must be a string.");
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null;
  if (!isSalesforceKnowledgeChannel(trimmed)) {
    throw fieldError(
      "channel",
      'Enter one of "app", "pkb", "csp", or "prm" — or leave the channel empty to mirror every published article.',
    );
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
