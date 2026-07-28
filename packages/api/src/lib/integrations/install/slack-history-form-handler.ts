/**
 * `SlackHistoryFormInstallHandler` — the {@link FormBasedInstallHandler} for
 * the built-in `slack-history` brain-source catalog row (#4770, ADR-0036
 * §Ingestion & connectors).
 *
 * Installing it creates one `pillar='knowledge'` install scoped to a set of
 * Slack channels; the Scheduler dispatches the registered brain source per
 * install on the SAME cadence as the knowledge connectors
 * (`lib/knowledge/sync.ts` routes it to `lib/brain/ingest/episode-sync.ts` on
 * its ingest target), and every message lands as an immutable tier-3 episode.
 *
 * Credentials: this handler collects NO secret. The connector reuses the
 * workspace's EXISTING Slack OAuth install, so there is no
 * `knowledge_sync_credentials` write, no rollback pairing, and no new Slack
 * app registration — the same posture `salesforce-knowledge` takes toward the
 * Salesforce OAuth install (ADR-0030 amendment #4397). What replaces the
 * credential check is the loud pre-write verification that tier demands: the
 * handler resolves the live Slack token, then probes every configured channel
 * TWICE — `conversations.info` for existence/membership/visibility, and a
 * one-message `conversations.history` read for the history scopes, which
 * `conversations.info` structurally CANNOT see (it is gated on
 * `channels:read`/`groups:read`, which the chat adapter's token already has, so
 * it returns fine for a token that cannot read a single message). All of it
 * happens BEFORE anything is persisted, so "the bot isn't in that channel",
 * "that channel id doesn't exist", and "the token can't read history" are
 * field-level 400s at install time rather than a per-cycle error nobody
 * reads.
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import {
  resolveSlackHistoryToken,
  type SlackInstallationReader,
} from "@atlas/api/lib/brain/ingest/slack/connector";
import {
  SLACK_CHANNEL_ID_PATTERN,
  SLACK_HISTORY_CATALOG_ID,
  SLACK_HISTORY_MAX_CHANNELS,
  SLACK_HISTORY_SLUG,
  type SlackHistoryInstallConfig,
} from "@atlas/api/lib/brain/ingest/slack/config";
import { fetchConversationHistoryPage, getConversationInfo } from "@atlas/api/lib/slack/api";
import { getBotToken, getInstallationByOrg } from "@atlas/api/lib/slack/store";
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
export { SLACK_HISTORY_SLUG, SLACK_HISTORY_CATALOG_ID };

/**
 * The brain-source install upsert. Identical shape to the knowledge
 * connectors': `status='published'` because the install CONTAINER is live
 * immediately — the review gate is on the FACTS drawn from the episodes
 * (#4769), never on the episodes themselves, which are evidence and are
 * deliberately not content-mode registered. Exported so the real-Postgres test
 * executes this exact string against the live schema.
 */
export const SLACK_HISTORY_INSTALL_UPSERT_SQL = `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'knowledge', $5::jsonb, true, 'published', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               status = 'published',
               updated_at = NOW()
         RETURNING id`;

export interface SlackHistoryFormInstallHandlerOptions {
  /** Test-only injection of the row-id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the installation store (no real Slack call). */
  readonly store?: SlackInstallationReader;
  /** Test-only injection of the channel probes. */
  readonly getConversationInfo?: typeof getConversationInfo;
  readonly fetchConversationHistoryPage?: typeof fetchConversationHistoryPage;
}

export class SlackHistoryFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;
  private readonly store: SlackInstallationReader;
  private readonly probeChannel: typeof getConversationInfo;
  private readonly probeHistory: typeof fetchConversationHistoryPage;
  private readonly log = createLogger("integrations.install.slack-history");

  constructor(options: SlackHistoryFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
    this.store = options.store ?? { getInstallationByOrg, getBotToken };
    this.probeChannel = options.getConversationInfo ?? getConversationInfo;
    this.probeHistory = options.fetchConversationHistoryPage ?? fetchConversationHistoryPage;
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

    const slug = resolveCollectionSlug(rawForm[KNOWLEDGE_INSTALL_ID_FIELD], SLACK_HISTORY_SLUG);
    const channels = validateChannels(rawForm.channels);
    const description = validateDescription(rawForm.description);

    // Confirm the catalog row exists + is enabled.
    const catalogRows = await internalQuery<{ id: string }>(
      `SELECT id FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
      [SLACK_HISTORY_SLUG],
    );
    if (catalogRows.length === 0) {
      this.log.error(
        { workspaceId },
        "slack-history catalog row missing or disabled — cannot install (built-in knowledge catalog seed has not run)",
      );
      throw new Error(
        `Catalog row "${SLACK_HISTORY_SLUG}" not found or disabled — the built-in Knowledge Base catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;

    await assertCollectionInstallable(workspaceId, slug, catalogId, this.log);

    // ── Verify the reused Slack connection loudly BEFORE persisting ─────────
    let token: string;
    try {
      token = await resolveSlackHistoryToken(this.store, workspaceId);
    } catch (err) {
      // Surfaced to the admin AND logged. "The install keeps failing" is a
      // support question, and the decrypt-failure arm in particular is an
      // operator-relevant event that would otherwise exist only in an HTTP
      // response body nobody keeps.
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { workspaceId, err: message },
        "Slack history install blocked — no usable Slack connection for this workspace",
      );
      throw new FormInstallValidationError({ fieldErrors: {}, formErrors: [message] });
    }
    await this.verifyChannels(token, channels);

    // ── Persist (no credential — the Slack OAuth install owns it) ───────────
    const config: SlackHistoryInstallConfig = {
      channels,
      ...(description !== null ? { description } : {}),
    };
    const candidateId = this.newId();
    const returned = await upsertKnowledgeCollectionRow({
      workspaceId,
      collectionSlug: slug,
      sql: SLACK_HISTORY_INSTALL_UPSERT_SQL,
      params: [candidateId, workspaceId, catalogId, slug, JSON.stringify(config)],
      candidateId,
      log: this.log,
    });

    this.log.info(
      { workspaceId, installId: slug, channels: channels.length },
      "Slack chat-history brain source install completed",
    );
    return {
      installRecord: { id: returned, workspaceId, catalogId: SLACK_HISTORY_SLUG },
      credentialWritten: false,
    };
  }

  /**
   * Probe every configured channel TWICE — `conversations.info` for existence,
   * membership and visibility, then a one-message `conversations.history` read
   * for the history scopes. Each failure blames the `channels` field and names
   * the fix: a channel the bot was never invited to, and a token without the
   * history scopes, are the two most likely install mistakes, and discovering
   * either a cycle later (as a sync error) is discovering it in the wrong
   * place.
   *
   * An ARCHIVED channel is admitted with a warning rather than refused: its
   * history is still readable and still evidence, it just will not grow.
   */
  private async verifyChannels(token: string, channels: readonly string[]): Promise<void> {
    for (const channelId of channels) {
      const info = await this.probeChannel(token, channelId);
      if (!info.ok) {
        throw fieldError("channels", channelProbeMessage(channelId, info.error));
      }
      if (!info.channel.isMember) {
        throw fieldError(
          "channels",
          `Atlas is not a member of #${info.channel.name} (${channelId}) — invite the Atlas bot to the channel, then install again.`,
        );
      }
      if (info.channel.isArchived) {
        this.log.warn(
          { channelId, name: info.channel.name },
          "Slack history source configured with an archived channel — its history is read once and never grows",
        );
      }
      // A ONE-MESSAGE history read, and it is not redundant with the check
      // above. `conversations.info` is gated on `channels:read`/`groups:read`,
      // which the chat adapter's existing token already has — so without this
      // probe a token missing `channels:history`/`groups:history` passes every
      // install check and then fails `missing_scope` on the first sync, which
      // is exactly the "per-cycle error nobody reads" this handler exists to
      // prevent. Cheap: `limit: 1`, once per channel, at install only.
      const history = await this.probeHistory(token, { channel: channelId, limit: 1 });
      if (!history.ok) {
        throw fieldError("channels", historyProbeMessage(channelId, history.error));
      }
    }
  }
}

/** Map a `conversations.history` probe error to an actionable install message. */
function historyProbeMessage(channelId: string, error: string): string {
  switch (error) {
    case "missing_scope":
      return `The workspace's Slack connection cannot read message history — reconnect Slack under Admin → Integrations to grant the channels:history and groups:history scopes, then install again.`;
    case "not_in_channel":
      return `Atlas is not a member of ${channelId} — invite the Atlas bot to the channel, then install again.`;
    case "ratelimited":
      return `Slack is rate limiting this workspace right now — wait a minute and install again.`;
    default:
      return `Slack refused to return history for ${channelId}: ${error}.`;
  }
}

/** Map a `conversations.info` error to an actionable install-time message. */
function channelProbeMessage(channelId: string, error: string): string {
  switch (error) {
    case "channel_not_found":
      return `Slack does not recognise the channel id ${channelId} — copy it from the channel's "View channel details" panel.`;
    case "missing_scope":
      return `The workspace's Slack connection cannot look this channel up — reconnect Slack under Admin → Integrations to grant the channels:read and groups:read scopes, then install again.`;
    case "ratelimited":
      return `Slack is rate limiting this workspace right now — wait a minute and install again.`;
    default:
      return `Slack rejected the check for channel ${channelId}: ${error}.`;
  }
}

/**
 * Validate the channel list. Accepts the comma/whitespace-separated string the
 * form field produces, and an array (an API caller posting JSON directly).
 */
function validateChannels(raw: unknown): readonly string[] {
  if (typeof raw !== "string" && !Array.isArray(raw)) {
    throw fieldError("channels", "Enter one or more Slack channel IDs, separated by commas.");
  }
  // A non-string entry is a LOUD error, not a silent skip. Every other
  // malformed input here is a field error, and quietly narrowing the requested
  // scope is invisible until someone wonders why a channel never appears.
  const parts: string[] = Array.isArray(raw)
    ? raw.map((entry) => {
        if (typeof entry !== "string") {
          throw fieldError("channels", "Every channel must be a Slack channel ID string.");
        }
        return entry;
      })
    : raw.split(/[,\s]+/);

  const channels: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim().toUpperCase();
    if (trimmed === "") continue;
    if (!SLACK_CHANNEL_ID_PATTERN.test(trimmed)) {
      throw fieldError(
        "channels",
        `"${part.trim().slice(0, 40)}" is not a Slack channel ID — IDs start with C or G (e.g. C01ABCDEF). Direct messages cannot be ingested.`,
      );
    }
    if (!channels.includes(trimmed)) channels.push(trimmed);
  }
  if (channels.length === 0) {
    throw fieldError("channels", "Enter at least one Slack channel ID (e.g. C01ABCDEF).");
  }
  if (channels.length > SLACK_HISTORY_MAX_CHANNELS) {
    throw fieldError(
      "channels",
      `Enter at most ${SLACK_HISTORY_MAX_CHANNELS} channels — split a wider scope across several sources.`,
    );
  }
  return channels;
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
