/**
 * `NotionKnowledgeFormInstallHandler` — the {@link FormBasedInstallHandler} for
 * the built-in `notion-knowledge` catalog row (#4378, PRD #4375). Installing it
 * creates a **synced knowledge collection** whose content comes from Notion via
 * an internal-integration token.
 *
 * ONE COLLECTION PER AUTHORIZATION: the pages a customer shares with the
 * integration ARE the scope — there is no space/endpoint field to configure
 * (unlike bundle-sync). Install is therefore just a token + optional
 * description. The token is the load-bearing artefact: it routes to the shared
 * `knowledge_sync_credentials` table (encrypted via `db/secret-encryption.ts`,
 * an `INTEGRATION_TABLES` participant), NEVER to `workspace_plugins.config`.
 * Write order mirrors the Confluence handler: verify → SaaS keyset gate →
 * credential row → install row (re-running the install heals a half-completed
 * pair; a failed install row rolls the just-written credential back).
 *
 * There is no SSRF surface here (the API host is a fixed Notion constant, not a
 * customer-supplied URL), so no egress guard — field validation is a non-empty,
 * bounded, whitespace-free token, then one LOUD verification request
 * (`GET /users/me` through `NotionHttpClient`) BEFORE anything persists: a
 * typo'd or revoked token fails the install with actionable guidance instead of
 * silently creating a collection that never syncs. Re-installing an existing
 * slug edits the description in place and re-stores the token (secrets are
 * never echoed back, so a token is required on every save — same posture as
 * bundle-sync's required secret).
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import {
  saveSyncCredential,
  deleteSyncCredential,
} from "@atlas/api/lib/knowledge/sync-credentials";
import {
  NotionHttpClient,
  type NotionHttpClientOptions,
} from "@atlas/api/lib/knowledge/notion/http";
import { NOTION_KNOWLEDGE_SLUG } from "@atlas/api/lib/knowledge/notion/connector";
import {
  assertSaasEncryptionKeyset,
  FormInstallValidationError,
} from "./persist-form-install";
import {
  assertCollectionInstallable,
  upsertKnowledgeCollectionRow,
} from "./knowledge-collection-install";
import { isPlanDenial } from "./retryable-install-error";
import {
  KNOWLEDGE_INSTALL_ID_FIELD,
  resolveCollectionSlug,
} from "./knowledge-collection-slug";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

/** Defensive upper bound — a Notion token is ~50 chars; guard against a paste. */
const TOKEN_MAX = 512;

/** The non-secret config persisted on the `workspace_plugins` row (no token). */
export interface NotionKnowledgeCollectionConfig {
  readonly description?: string;
}

/**
 * The multi-instance synced-collection upsert (identical shape to the
 * okf-upload / bundle-sync knowledge upserts): `status='published'` because the
 * COLLECTION container is live immediately — the review gate is on the
 * DOCUMENTS, which always sync in as `draft`. Exported so the real-Postgres
 * test executes this exact string against the live schema.
 */
export const NOTION_KNOWLEDGE_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export interface NotionKnowledgeFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the verification fetch/clock (no real Notion call). */
  readonly clientOptions?: Omit<NotionHttpClientOptions, "token">;
}

export class NotionKnowledgeFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly clientOptions: Omit<NotionHttpClientOptions, "token">;
  private readonly log = createLogger("integrations.install.notion-knowledge");

  constructor(options: NotionKnowledgeFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
    this.clientOptions = options.clientOptions ?? {};
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

    const collectionSlug = resolveCollectionSlug(
      rawForm[KNOWLEDGE_INSTALL_ID_FIELD],
      NOTION_KNOWLEDGE_SLUG,
    );

    const token = validateToken(rawForm.integration_token);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled so a seed misconfig surfaces
    // as a clear 500 rather than an opaque FK error on the INSERT below.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [NOTION_KNOWLEDGE_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "notion-knowledge catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${NOTION_KNOWLEDGE_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    // Slug not taken by another knowledge catalog (#4211), and the workspace's
    // plan tier has room for another collection (#4235) — both before the write.
    await assertCollectionInstallable(workspaceId, collectionSlug, catalogId, this.log);

    // ── Verify the token loudly BEFORE persisting anything ─────────────────────
    await this.verifyToken(workspaceId, collectionSlug, token);

    // ── Credential first (mirrors the bundle-sync / Twenty write order) ────────
    // SaaS keyset gate BEFORE any credential byte is persisted — a misconfigured
    // SaaS deploy must fail closed, never store plaintext.
    assertSaasEncryptionKeyset(this.log, workspaceId, "integration_token");
    try {
      await saveSyncCredential(workspaceId, collectionSlug, token);
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist knowledge_sync_credentials row — aborting install",
      );
      throw err;
    }

    // ── Upsert the collection container (never carries the token) ──────────────
    const config: NotionKnowledgeCollectionConfig = {
      ...(description !== null ? { description } : {}),
    };

    const candidateId = this.newId();
    let persistedId: string;
    try {
      const returned = await upsertKnowledgeCollectionRow({
        workspaceId,
        collectionSlug: collectionSlug,
        sql: NOTION_KNOWLEDGE_INSTALL_UPSERT_SQL,
        params: [candidateId, workspaceId, catalogId, collectionSlug, JSON.stringify(config)],
        candidateId,
        log: this.log,
      });
      persistedId = returned;
    } catch (err) {
      // Roll back the just-written credential so a secret can't outlive a failed
      // install (its install row never landed, so uninstall would never reach
      // it). Best-effort — a re-install overwrites it either way; a cleanup
      // failure is logged, never masks the original error. Same block as the
      // Confluence handler (confluence-form-handler.ts) — keep them in step.
      this.log.error(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        isPlanDenial(err)
          ? "Failed to persist notion-knowledge collection install — rolling back the orphaned credential (the workspace is at a plan limit — retrying will not help)"
          : "Failed to persist notion-knowledge collection install — rolling back the orphaned credential (retrying the install is safe)",
      );
      try {
        await deleteSyncCredential(workspaceId, collectionSlug);
      } catch (cleanupErr) {
        this.log.error(
          { workspaceId, collectionSlug, err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
          "Failed to roll back the orphaned credential after an install-row failure — a re-install overwrites it",
        );
      }
      throw err;
    }

    this.log.info(
      { workspaceId, collectionSlug, rowId: persistedId },
      "Notion knowledge collection install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: NOTION_KNOWLEDGE_SLUG },
      credentialWritten: true,
    };
  }

  /**
   * Verify the token with ONE cheap Notion request (`GET /users/me` — the bot
   * user the token belongs to) BEFORE anything persists, mirroring
   * `verifyConfluenceAccess`'s posture: a credential rejection is a field-level
   * 400 on `integration_token`; a non-credential failure (rate limit,
   * DNS/timeout transport) is a form-level 400 — blaming the token field would
   * send the admin re-entering a token that may be fine. `NotionHttpClient`
   * errors are already actionable and secret-free (the token is never echoed;
   * the host is a fixed Notion constant, so there is nothing to redact).
   */
  private async verifyToken(
    workspaceId: WorkspaceId,
    collectionSlug: string,
    token: string,
  ): Promise<void> {
    const client = new NotionHttpClient({ token, ...this.clientOptions });
    try {
      await client.get("/users/me");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { workspaceId, collectionSlug, err: message },
        "Notion token verification failed — rejecting the install (nothing persisted)",
      );
      // A 401/403 is Notion rejecting the CREDENTIAL (`unauthorized` /
      // `restricted_resource`) — the client folds the vendor envelope into the
      // message, so match the status it embeds (the client is the one seam that
      // shapes these errors; it exposes no typed auth error to `instanceof`).
      if (/\(HTTP 40[13]\)/.test(message)) {
        throw new FormInstallValidationError({
          fieldErrors: {
            integration_token: [
              `Notion rejected the integration token — re-copy it from notion.so/my-integrations and try again. (${message})`,
            ],
          },
          formErrors: [],
        });
      }
      // Rate limit / transport / unexpected vendor response — form-level.
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: [message],
      });
    }
  }
}

/**
 * Validate the internal-integration token: required, bounded, no internal
 * whitespace (a Notion token is a single opaque string — an embedded space is a
 * paste error). The token is never echoed, so it is required on every save.
 */
function validateToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new FormInstallValidationError({
      fieldErrors: {
        integration_token: [
          "A Notion internal-integration token is required. Create one at notion.so/my-integrations and share your pages with it.",
        ],
      },
      formErrors: [],
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length > TOKEN_MAX) {
    throw new FormInstallValidationError({
      fieldErrors: { integration_token: [`Token must be ${TOKEN_MAX} characters or fewer.`] },
      formErrors: [],
    });
  }
  if (/\s/.test(trimmed)) {
    throw new FormInstallValidationError({
      fieldErrors: {
        integration_token: ["Token must not contain spaces — paste the token exactly as Notion shows it."],
      },
      formErrors: [],
    });
  }
  return trimmed;
}

/** Optional human description — same rule as the bundle-sync handler. */
function validateDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new FormInstallValidationError({
      fieldErrors: { description: ["Description must be a string."] },
      formErrors: [],
    });
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}
