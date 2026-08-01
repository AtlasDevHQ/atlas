/**
 * `ZoomTranscriptsFormInstallHandler` — the {@link FormBasedInstallHandler} for
 * the built-in `zoom-transcripts` brain-source catalog row (#4965, ADR-0036
 * §Ingestion & connectors).
 *
 * Installing it creates one `pillar='knowledge'` install scoped to a Zoom
 * account; the Scheduler dispatches the registered brain source per install on
 * the SAME cadence as the knowledge connectors (`lib/knowledge/sync.ts` routes
 * it to `lib/brain/ingest/episode-sync.ts` on its ingest target), and every
 * meeting transcript lands as an immutable tier-3 episode.
 *
 * ## Credentials: TWO fields, ONE stored secret
 *
 * Unlike `slack-history` — which reuses an existing OAuth install and writes no
 * credential at all — this handler collects a Zoom **Server-to-Server OAuth**
 * app's client id and client secret and writes them, as one JSON blob, to
 * `knowledge_sync_credentials` (encrypted via `db/secret-encryption.ts`). The
 * `accountId` is non-secret scope and goes to `workspace_plugins.config`, where
 * the connector and the audience re-verifier read it without decrypting
 * anything. `connector.ts`'s header carries the argument for keeping the pair
 * together rather than splitting the id into the config.
 *
 * The credential write and the install-row upsert are PAIRED with a rollback,
 * the same block the GitBook/Notion/Intercom handlers carry: a secret must
 * never outlive a failed install, because the install row it would be cleaned
 * up by never landed.
 *
 * ## Loud pre-write verification
 *
 * The credential is exercised BEFORE anything is persisted — a token exchange
 * plus a one-page recordings read. Those two probe different things and both
 * are needed: the exchange proves the client id/secret/account id triple is
 * valid, and the recordings read proves the app carries
 * `cloud_recording:read:admin`, which the exchange structurally cannot see (a
 * token mints fine for an app with no scopes at all). Discovering a missing
 * scope a cycle later, as a sync error nobody reads, is discovering it in the
 * wrong place.
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import {
  deleteSyncCredential,
  saveSyncCredential,
} from "@atlas/api/lib/knowledge/sync-credentials";
import {
  fetchAccountRecordingsPage,
  fetchZoomAccessToken,
} from "@atlas/api/lib/brain/ingest/zoom/api";
import {
  ZOOM_MAX_HOSTS,
  ZOOM_TRANSCRIPTS_CATALOG_ID,
  ZOOM_TRANSCRIPTS_SLUG,
  type ZoomTranscriptsInstallConfig,
} from "@atlas/api/lib/brain/ingest/zoom/config";
import { toZoomDate } from "@atlas/api/lib/brain/ingest/zoom/client";
import { assertSaasEncryptionKeyset, FormInstallValidationError } from "./persist-form-install";
import {
  assertCollectionInstallable,
  upsertKnowledgeCollectionRow,
} from "./knowledge-collection-install";
import { KNOWLEDGE_INSTALL_ID_FIELD, resolveCollectionSlug } from "./knowledge-collection-slug";
import type { FormBasedInstallHandler, InstallRecord } from "./types";

// Re-exported for callers that want the slug/id without importing the brain
// module directly; both are single-homed in config.ts. (`register.ts` uses only
// the slug.)
export { ZOOM_TRANSCRIPTS_SLUG, ZOOM_TRANSCRIPTS_CATALOG_ID };

/**
 * The brain-source install upsert. Identical shape to `slack-history`'s:
 * `status='published'` because the install CONTAINER is live immediately — the
 * review gate is on the FACTS drawn from the episodes (#4769), never on the
 * episodes themselves, which are evidence and are deliberately not content-mode
 * registered. Exported so a caller can execute this exact string; NOTE there is
 * no `-pg` test behind it yet, unlike the Notion/GitBook upserts in
 * `knowledge-lifecycle-pg.test.ts`.
 */
export const ZOOM_TRANSCRIPTS_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export interface ZoomTranscriptsFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the Zoom probes. */
  readonly fetchZoomAccessToken?: typeof fetchZoomAccessToken;
  readonly fetchAccountRecordingsPage?: typeof fetchAccountRecordingsPage;
}

export class ZoomTranscriptsFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly exchangeToken: typeof fetchZoomAccessToken;
  private readonly probeRecordings: typeof fetchAccountRecordingsPage;
  private readonly log = createLogger("integrations.install.zoom-transcripts");

  constructor(options: ZoomTranscriptsFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
    this.exchangeToken = options.fetchZoomAccessToken ?? fetchZoomAccessToken;
    this.probeRecordings = options.fetchAccountRecordingsPage ?? fetchAccountRecordingsPage;
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

    const slug = resolveCollectionSlug(rawForm[KNOWLEDGE_INSTALL_ID_FIELD], ZOOM_TRANSCRIPTS_SLUG);
    const accountId = requiredField(rawForm.accountId, "accountId", "Zoom account ID");
    const clientId = requiredField(rawForm.clientId, "clientId", "client ID");
    const clientSecret = requiredField(rawForm.clientSecret, "clientSecret", "client secret");
    const hosts = validateHosts(rawForm.hosts);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [ZOOM_TRANSCRIPTS_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "zoom-transcripts catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${ZOOM_TRANSCRIPTS_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    await assertCollectionInstallable(workspaceId, slug, catalogId, this.log);

    // ── Verify the credential loudly BEFORE persisting anything ─────────────
    await this.verifyConnection({ accountId, clientId, clientSecret });

    // ── Credential first (mirrors the GitBook/Notion/Intercom write order) ──
    assertSaasEncryptionKeyset(this.log, workspaceId, "zoom_s2s_app");
    try {
      await saveSyncCredential(workspaceId, slug, JSON.stringify({ clientId, clientSecret }));
    } catch (err) {
      this.log.error(
        { workspaceId, collectionSlug: slug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist knowledge_sync_credentials row — aborting install",
      );
      throw err;
    }

    // ── Upsert the collection container (never carries the secret) ──────────
    const config: ZoomTranscriptsInstallConfig = {
      accountId,
      ...(hosts.length > 0 ? { hosts } : {}),
      ...(description !== null ? { description } : {}),
    };
    const candidateId = this.newId();
    let persistedId: string;
    try {
      persistedId = await upsertKnowledgeCollectionRow({
        workspaceId,
        collectionSlug: slug,
        sql: ZOOM_TRANSCRIPTS_INSTALL_UPSERT_SQL,
        params: [candidateId, workspaceId, catalogId, slug, JSON.stringify(config)],
        candidateId,
        log: this.log,
      });
    } catch (err) {
      // Roll back the just-written credential so a secret can't outlive a
      // failed install (its install row never landed, so uninstall would never
      // reach it). Best-effort — a re-install overwrites it either way; a
      // cleanup failure is logged, never masks the original error. Same block
      // as the GitBook/Notion/Intercom handlers — keep them in step.
      this.log.error(
        { workspaceId, collectionSlug: slug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist zoom-transcripts collection install — rolling back the orphaned credential (retrying the install is safe)",
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
      throw err;
    }

    this.log.info(
      { workspaceId, installId: slug, hosts: hosts.length },
      "Zoom transcript brain source install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: ZOOM_TRANSCRIPTS_SLUG },
      credentialWritten: true,
    };
  }

  /**
   * Exchange the credential, then read one page of recordings.
   *
   * Both probes, because they fail differently and an admin needs to know
   * which: the exchange failing means the id/secret/account triple is wrong,
   * and the recordings read failing on a VALID token means the app is missing
   * `cloud_recording:read:admin`. Every message blames a field and names the
   * repair; none of them echoes the secret back.
   */
  private async verifyConnection(input: {
    accountId: string;
    clientId: string;
    clientSecret: string;
  }): Promise<void> {
    const token = await this.exchangeToken(input);
    if (!token.ok) {
      throw new FormInstallValidationError({
        fieldErrors:
          token.error === "invalid_auth"
            ? {
                clientSecret: [
                  "Zoom rejected these credentials — check the client ID, client secret, and account ID from your Server-to-Server OAuth app, and confirm the app is activated.",
                ],
              }
            : {},
        formErrors:
          token.error === "invalid_auth"
            ? []
            : [
                `Could not reach Zoom to verify these credentials (${token.error}). Try again in a moment.`,
              ],
      });
    }

    const today = toZoomDate(new Date());
    const probe = await this.probeRecordings(token.token, {
      accountId: input.accountId,
      from: today,
      to: today,
      pageSize: 1,
    });
    if (!probe.ok) {
      // A 404 here means the account id is not one this app can read — it is
      // the accountId field's fault, not the secret's, and blaming the secret
      // would send the admin to regenerate a credential that was fine.
      const field =
        probe.error === "not_found" ? "accountId" : probe.error === "missing_scope" ? "clientId" : null;
      const message =
        probe.error === "missing_scope"
          ? "This Server-to-Server OAuth app is missing the cloud_recording:read:admin and meeting:read:admin scopes — add them in the Zoom App Marketplace, reactivate the app, then install again."
          : probe.error === "plan_required"
            ? "This Zoom account's plan does not include the cloud-recording API this source needs."
            : probe.error === "not_found"
              ? "Zoom does not recognise this account ID for this app — copy the Account ID from the app's credentials page."
              : `Zoom refused the recordings read (${probe.error}). Check the app's scopes and try again.`;
      throw new FormInstallValidationError({
        fieldErrors: field === null ? {} : { [field]: [message] },
        formErrors: field === null ? [message] : [],
      });
    }
  }
}

function fieldError(field: string, message: string): FormInstallValidationError {
  return new FormInstallValidationError({ fieldErrors: { [field]: [message] }, formErrors: [] });
}

function requiredField(raw: unknown, field: string, label: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError(field, `Enter the ${label} from your Zoom Server-to-Server OAuth app.`);
  }
  return raw.trim();
}

/**
 * Parse the optional host scope. Accepts the comma-separated form the catalog's
 * config schema renders, and an array for API callers.
 *
 * An ABSENT or blank field means the whole account, which is the documented
 * default. A field that is PRESENT but unparseable is refused rather than
 * silently widened to the whole account — quietly ingesting every meeting in a
 * company because a scope field was malformed is the wrong direction to fail.
 */
function validateHosts(raw: unknown): readonly string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : null;
  if (entries === null) {
    throw fieldError("hosts", "Enter a comma-separated list of Zoom host user IDs, or leave blank for the whole account.");
  }
  const hosts: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw fieldError("hosts", "Every host must be a Zoom user ID.");
    }
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    if (!hosts.includes(trimmed)) hosts.push(trimmed);
  }
  if (hosts.length > ZOOM_MAX_HOSTS) {
    throw fieldError("hosts", `At most ${ZOOM_MAX_HOSTS} hosts can be configured on one install.`);
  }
  return hosts;
}

function validateDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw fieldError("description", "Description must be text.");
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed.slice(0, 500);
}
