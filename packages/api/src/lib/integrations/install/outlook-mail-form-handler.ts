/**
 * `OutlookMailFormInstallHandler` — the {@link FormBasedInstallHandler} for the
 * built-in `outlook-mail` brain-source catalog row (#4966, ADR-0036 §Ingestion
 * & connectors).
 *
 * Installing it creates one `pillar='knowledge'` install scoped to a Microsoft
 * tenant and an explicit mailbox list; the Scheduler dispatches the registered
 * brain source per install on the SAME cadence as the knowledge connectors
 * (`lib/knowledge/sync.ts` routes it to `lib/brain/ingest/episode-sync.ts` on
 * its ingest target), and every message lands as an immutable tier-3 episode.
 *
 * ## Credentials: TWO fields, ONE stored secret
 *
 * The same shape as `zoom-transcripts`: an Entra app registration's client id
 * and client secret are written as one JSON blob to
 * `knowledge_sync_credentials` (encrypted via `db/secret-encryption.ts`), while
 * the non-secret `tenantId` and mailbox scope go to `workspace_plugins.config`
 * where the connector and the audience re-verifier read them without decrypting
 * anything. `outlook/connector.ts`'s header carries the argument for keeping the
 * pair together rather than splitting the id into the config.
 *
 * The credential write and the install-row upsert are PAIRED with a rollback,
 * the same block the GitBook/Notion/Intercom/Zoom handlers carry: a secret must
 * never outlive a failed install, because the install row it would be cleaned up
 * by never landed.
 *
 * ## Loud pre-write verification — THREE probes, not two
 *
 * Zoom needs two (a token exchange, then a scoped read). Outlook needs three,
 * because Graph splits the permissions this connector uses across two grants
 * that fail in different consoles:
 *
 *   1. **the token exchange** proves the tenant id / client id / client secret
 *      triple. A token mints fine for an app with no permissions at all, so it
 *      proves nothing else;
 *   2. **a directory read per mailbox** proves `User.ReadBasic.All` AND that every
 *      configured mailbox actually exists. Run for EVERY mailbox, in parallel,
 *      because a typo in the seventh entry would otherwise become a per-cycle
 *      sync warning nobody reads;
 *   3. **a message read on the first mailbox** proves `Mail.Read` has admin
 *      consent, which the directory read cannot see.
 *
 * ⚠️ What probe 3 deliberately does NOT prove: that every OTHER mailbox is
 * readable. An Exchange ApplicationAccessPolicy narrows `Mail.Read` per mailbox
 * and does not narrow the directory permission, so a mailbox can pass probe 2 and still
 * be refused at sync time. Probing all of them would double a 50-mailbox
 * install's round trips to prove something an admin can change five minutes
 * later anyway; the honest position is that per-mailbox mail access is verified
 * at SYNC time, where `mailbox_denied` names the policy and the mailbox.
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
  fetchGraphAccessToken,
  fetchMailbox,
  fetchMailboxMessagesPage,
} from "@atlas/api/lib/brain/ingest/outlook/api";
import {
  OUTLOOK_MAIL_CATALOG_ID,
  OUTLOOK_MAIL_SLUG,
  OUTLOOK_MAX_MAILBOXES,
  type OutlookMailInstallConfig,
} from "@atlas/api/lib/brain/ingest/outlook/config";
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
export { OUTLOOK_MAIL_SLUG, OUTLOOK_MAIL_CATALOG_ID };

/**
 * The brain-source install upsert. Identical shape to `zoom-transcripts`'s and
 * `slack-history`'s: `status='published'` because the install CONTAINER is live
 * immediately — the review gate is on the FACTS drawn from the episodes (#4769),
 * never on the episodes themselves, which are evidence and are deliberately not
 * content-mode registered. Exported so a caller can execute this exact string;
 * NOTE there is no `-pg` test behind it yet, matching its siblings.
 */
export const OUTLOOK_MAIL_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export interface OutlookMailFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the Graph probes. */
  readonly fetchGraphAccessToken?: typeof fetchGraphAccessToken;
  readonly fetchMailbox?: typeof fetchMailbox;
  readonly fetchMailboxMessagesPage?: typeof fetchMailboxMessagesPage;
}

export class OutlookMailFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly exchangeToken: typeof fetchGraphAccessToken;
  private readonly probeMailbox: typeof fetchMailbox;
  private readonly probeMessages: typeof fetchMailboxMessagesPage;
  private readonly log = createLogger("integrations.install.outlook-mail");

  constructor(options: OutlookMailFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
    this.exchangeToken = options.fetchGraphAccessToken ?? fetchGraphAccessToken;
    this.probeMailbox = options.fetchMailbox ?? fetchMailbox;
    this.probeMessages = options.fetchMailboxMessagesPage ?? fetchMailboxMessagesPage;
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

    const slug = resolveCollectionSlug(rawForm[KNOWLEDGE_INSTALL_ID_FIELD], OUTLOOK_MAIL_SLUG);
    const tenantId = requiredField(rawForm.tenantId, "tenantId", "Directory (tenant) ID");
    const clientId = requiredField(rawForm.clientId, "clientId", "Application (client) ID");
    const clientSecret = requiredField(rawForm.clientSecret, "clientSecret", "client secret");
    const mailboxes = validateMailboxes(rawForm.mailboxes);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [OUTLOOK_MAIL_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "outlook-mail catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${OUTLOOK_MAIL_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    await assertCollectionInstallable(workspaceId, slug, catalogId, this.log);

    // ── Verify the credential loudly BEFORE persisting anything ─────────────
    await this.verifyConnection({ tenantId, clientId, clientSecret, mailboxes });

    // ── Credential first (mirrors the GitBook/Notion/Intercom/Zoom order) ───
    assertSaasEncryptionKeyset(this.log, workspaceId, "outlook_graph_app");
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
    const config: OutlookMailInstallConfig = {
      tenantId,
      mailboxes,
      ...(description !== null ? { description } : {}),
    };
    const candidateId = this.newId();
    let persistedId: string;
    try {
      persistedId = await upsertKnowledgeCollectionRow({
        workspaceId,
        collectionSlug: slug,
        sql: OUTLOOK_MAIL_INSTALL_UPSERT_SQL,
        params: [candidateId, workspaceId, catalogId, slug, JSON.stringify(config)],
        candidateId,
        log: this.log,
      });
    } catch (err) {
      // Roll back the just-written credential so a secret can't outlive a failed
      // install (its install row never landed, so uninstall would never reach
      // it). Best-effort — a re-install overwrites it either way; a cleanup
      // failure is logged, never masks the original error. Same block as the
      // GitBook/Notion/Intercom/Zoom handlers — keep them in step.
      this.log.error(
        { workspaceId, collectionSlug: slug, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist outlook-mail collection install — rolling back the orphaned credential (retrying the install is safe)",
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
      { workspaceId, installId: slug, mailboxes: mailboxes.length },
      "Outlook mail brain source install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: OUTLOOK_MAIL_SLUG },
      credentialWritten: true,
    };
  }

  /**
   * Exchange the credential, resolve every mailbox, then read one message.
   *
   * See the module header for why there are three probes and what the third one
   * deliberately does not cover. Every message blames a field and names the
   * repair; none of them echoes the secret back.
   */
  private async verifyConnection(input: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    mailboxes: readonly string[];
  }): Promise<void> {
    const token = await this.exchangeToken({
      tenantId: input.tenantId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    });
    if (!token.ok) {
      throw new FormInstallValidationError({
        fieldErrors:
          token.error === "invalid_auth"
            ? {
                clientSecret: [
                  "Microsoft rejected these credentials — check the Application (client) ID, client secret and Directory (tenant) ID from your Entra app registration, and confirm the secret has not expired.",
                ],
              }
            : {},
        formErrors:
          token.error === "invalid_auth"
            ? []
            : [
                `Could not reach Microsoft to verify these credentials (${token.error}). Try again in a moment.`,
              ],
      });
    }

    // Every mailbox, CONCURRENTLY. Sequential awaits here would be an async
    // waterfall (CLAUDE.md) and would make a 50-mailbox install as slow as its
    // slowest fifty round trips; resolving them together costs one.
    const resolved = await Promise.all(
      input.mailboxes.map(async (mailbox) => ({
        mailbox,
        result: await this.probeMailbox(token.token, mailbox),
      })),
    );
    const unresolved = resolved.filter((entry) => !entry.result.ok);
    if (unresolved.length > 0) {
      const first = unresolved[0];
      // Narrowed by the filter above, but TypeScript cannot see through
      // `.filter`, so the check is re-stated rather than asserted away with a
      // non-null. `missing_scope` is the whole-app condition and outranks a
      // per-mailbox one in the message, because re-typing a mailbox will not
      // fix a permission that was never consented.
      const failure = first.result.ok ? null : first.result.error;
      const anyMissingScope = unresolved.some(
        (entry) => !entry.result.ok && entry.result.error === "missing_scope",
      );
      const message = anyMissingScope
        ? "This app registration cannot read the directory — add the User.ReadBasic.All application permission in Entra and grant admin consent, then install again. (Atlas needs it to record mailboxes by their stable object ID rather than by email address. User.Read.All also works if the app already has it.)"
        : failure === "not_found"
          ? `Microsoft does not recognise the mailbox "${first.mailbox}" — check the address or object ID. ${unresolved.length > 1 ? `${unresolved.length} of the listed mailboxes could not be found.` : ""}`.trim()
          : failure === "mailbox_unavailable"
            ? `"${first.mailbox}" exists in the directory but has no Exchange Online mailbox — it is not licensed for mail.`
            : `Microsoft refused the directory lookup for "${first.mailbox}" (${failure}). Check the app's permissions and try again.`;
      throw new FormInstallValidationError({
        fieldErrors: anyMissingScope ? { clientId: [message] } : { mailboxes: [message] },
        formErrors: [],
      });
    }

    // Probe 3 — the mail permission itself, on the first mailbox. `resolved` is
    // non-empty because `validateMailboxes` refuses an empty list.
    const firstMailbox = resolved[0];
    if (!firstMailbox.result.ok) {
      // Unreachable: the `unresolved.length > 0` throw above has already fired
      // for any failed identity read. It THROWS rather than returning, because a
      // bare `return` here is a fail-OPEN — verification would silently pass and
      // the install would land unverified. CLAUDE.md's "prefer errors over
      // silent fallbacks" points at exactly this shape, and the guard above is
      // one narrowing edit away from making it reachable.
      throw new Error(
        "Outlook install verification reached the mail probe with an unresolved mailbox — this is a bug in the install handler's guard order, not a configuration problem.",
      );
    }
    const probe = await this.probeMessages(token.token, {
      mailboxId: firstMailbox.result.mailbox.id,
      // A one-day window with a single-record page: enough to exercise the
      // permission and the filter grammar, cheap enough that an empty mailbox
      // still answers instantly.
      since: new Date(Date.now() - 86_400_000).toISOString(),
      pageSize: 1,
    });
    if (!probe.ok) {
      const message =
        probe.error === "missing_scope"
          ? "This app registration is missing the Mail.Read application permission — add it in Entra and grant admin consent, then install again."
          : probe.error === "mailbox_denied"
            ? `Microsoft refused to read mail from "${firstMailbox.mailbox}" even though the app is consented — an Exchange ApplicationAccessPolicy is excluding it. Add the mailbox to the policy's security group, then install again.`
            : probe.error === "mailbox_unavailable"
              ? `"${firstMailbox.mailbox}" has no Exchange Online mailbox — it is not licensed for mail.`
              : `Microsoft refused the mail read (${probe.error}). Check the app's permissions and try again.`;
      throw new FormInstallValidationError({
        fieldErrors:
          probe.error === "missing_scope" ? { clientId: [message] } : { mailboxes: [message] },
        formErrors: [],
      });
    }
  }
}

function fieldError(field: string, message: string): FormInstallValidationError {
  return new FormInstallValidationError({ fieldErrors: { [field]: [message] }, formErrors: [] });
}

function requiredField(raw: unknown, field: string, label: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fieldError(field, `Enter the ${label} from your Entra app registration.`);
  }
  return raw.trim();
}

/**
 * Parse the mailbox scope. Accepts the comma-separated form the catalog's config
 * schema renders, and an array for API callers.
 *
 * REQUIRED and non-empty, which is the inverse of the Zoom handler's optional
 * `hosts`. `outlook/config.ts`'s header carries the argument: Graph's
 * application `Mail.Read` is tenant-wide with no narrower scope, so a blank
 * field defaulting to "everything" would silently ingest every mailbox in the
 * company — and a blank field is exactly what a half-finished form submits.
 */
function validateMailboxes(raw: unknown): readonly string[] {
  const entries = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (entries === null) {
    throw fieldError(
      "mailboxes",
      "Enter a comma-separated list of the mailboxes to ingest (email addresses or object IDs). There is deliberately no setting for every mailbox in the tenant.",
    );
  }
  const mailboxes: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw fieldError("mailboxes", "Every mailbox must be an email address or an object ID.");
    }
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    // Case-insensitive dedupe: an address is case-insensitive to a mail system,
    // so two spellings of one mailbox would be walked twice — doubling the
    // vendor spend and the audience writes for no extra coverage.
    if (!mailboxes.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      mailboxes.push(trimmed);
    }
  }
  if (mailboxes.length === 0) {
    throw fieldError(
      "mailboxes",
      "List at least one mailbox to ingest. Atlas will not read a tenant's whole mail by default.",
    );
  }
  if (mailboxes.length > OUTLOOK_MAX_MAILBOXES) {
    throw fieldError(
      "mailboxes",
      `At most ${OUTLOOK_MAX_MAILBOXES} mailboxes can be configured on one install.`,
    );
  }
  return mailboxes;
}

function validateDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw fieldError("description", "Description must be text.");
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed.slice(0, 500);
}
