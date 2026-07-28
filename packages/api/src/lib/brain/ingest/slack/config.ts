/**
 * Slack chat-history brain source identity + stored-config contract (#4770,
 * ADR-0036 §Ingestion & connectors).
 *
 * A leaf module: the catalog id / slug / source constants and the non-secret
 * install config shape live here so the install handler (writes the config),
 * the connector (reads it back in `createClient`), and the catalog seed share
 * ONE definition.
 *
 * Like `salesforce-knowledge` (ADR-0030 amendment #4397), this source stores
 * NO credential of its own. It reuses the workspace's EXISTING Slack OAuth
 * install (`chat_cache`, `lib/slack/store.ts`), so installing it registers no
 * new Slack app and opens no new secret path. The config is pure scope: which
 * channels to read.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ██  THE SOURCE-ID CONTRACT
 * ══════════════════════════════════════════════════════════════════════
 *
 *     source_id = `<channelId>:<ts>`      (see {@link slackEpisodeSourceId})
 *
 * ADR-0036 §Ingestion makes a stable source-id a per-connector OBLIGATION,
 * not a nicety: freshness is "poll + reconcile universally, PLUS a webhook
 * fast-path for event-native chat" (M3), and the fast-path is *an alternate
 * writer into the same idempotent episode store*. Two writers that disagree
 * about the id duplicate every message they race on — and because episodes are
 * append-only there is no upsert to converge them afterwards.
 *
 * Why THIS id satisfies the contract:
 *
 *   - Slack's `ts` is the message's identity within a channel, and is what
 *     every Slack surface uses as the message key.
 *   - It is CHANNEL-SCOPED, so the same `ts` value in two channels is two
 *     episodes. Slack's `ts` is NOT globally unique; without the channel
 *     prefix two channels' messages could collide and one would be silently
 *     dropped by the dedupe.
 *   - Thread replies carry their OWN `ts`, so a reply WOULD be its own episode
 *     rather than a mutation of its parent. (M1's poll path does not fetch
 *     replies — `conversations.history` returns only top-level messages and
 *     `thread_broadcast` copies. The id rule is stated here so the writer that
 *     does fetch them agrees with this one.)
 *   - It survives an edit: `conversations.history` returns the message's
 *     ORIGINAL `ts` with the edit recorded in an `edited` sub-object. So an
 *     edited message re-ingests as a no-op — right for evidence, since the
 *     episode records what was said when Atlas saw it and 0180 keeps the row
 *     immutable. A future slice that wants the revision as NEW evidence must
 *     mint a different id from `edited.ts`, deliberately.
 *
 * ⚠️ WHERE THE WEBHOOK WRITER MUST READ IT FROM (the trap this section exists
 * for). The two writers read `ts` from DIFFERENT FIELD PATHS, so "just use
 * `ts`" is wrong:
 *
 *   - poll (`conversations.history`)        → `message.ts`
 *   - webhook, plain `message` event        → `event.ts`
 *   - webhook, `subtype: "message_changed"` → **`event.message.ts`**
 *     (top-level `event.ts` is the EVENT's timestamp, and `event.message.edited.ts`
 *     is the edit's — using either mints a new id for a message already stored
 *     and duplicates every edited message)
 *
 * Note `message_changed` never appears on the poll path: `conversations.history`
 * serves a message's current state, not its edit events.
 *
 * The one thing that must never change is the FORMAT. It is a stored key; a
 * reformat re-ingests every message in every workspace as a new episode, and
 * #4771 would then re-extract facts from all of them.
 */

/** The built-in catalog slug + row id for the Slack chat-history brain source. */
export const SLACK_HISTORY_SLUG = "slack-history";
export const SLACK_HISTORY_CATALOG_ID = "catalog:slack-history";

/**
 * The value stamped into `brain_episodes.source`. ADR-0036 orders SOURCES
 * class-major, vendor-minor (chat → transcripts → email → docs); the column
 * stores the VENDOR within that class, so the chat class will hold `slack`
 * today and `teams`/`discord`/… as M3 adds them.
 */
export const SLACK_HISTORY_SOURCE = "slack";

/**
 * Slack channel ids are `[A-Z0-9]` after a leading letter (`C…` public, `G…`
 * legacy private / multi-person DM, `D…` 1:1 DM). Validated because the id is
 * interpolated into a `source_id` and into an `audience:` grant token — both
 * stored keys — and because a typo'd id should be a form error at install time
 * rather than a per-cycle Slack `channel_not_found`.
 *
 * 1:1 DMs (`D…`) are deliberately NOT admitted: their audience is two people,
 * and ADR-0036 puts source-principal-resolution failure on the BLOCK side. M1
 * ingests channels the bot was invited to; DM ingestion needs the membership
 * work #4771 owns. NOTE this does not exclude every kind of DM — legacy
 * multi-person DMs (mpim) carry `G…` ids and are admitted, ingested as private
 * channels with a channel-scoped `audience:` grant. That is fail-closed and
 * correct, just broader than "no DMs" would suggest.
 */
export const SLACK_CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{2,}$/;

/** Defensive bound on the configured channel set (one install, one scope). */
export const SLACK_HISTORY_MAX_CHANNELS = 50;

/** Build the episode `source_id`. THE contract — see the module header. */
export function slackEpisodeSourceId(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

/** The non-secret config persisted on the install's `workspace_plugins` row. */
export interface SlackHistoryInstallConfig {
  /** Channel ids to read history from. Non-empty. */
  readonly channels: readonly string[];
  readonly description?: string;
}

export type ParsedSlackHistoryConfig =
  | { readonly ok: true; readonly channels: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * or invalid field means someone edited the row out of band; re-installing
 * repairs it.
 */
export function parseSlackHistoryConfig(
  config: Record<string, unknown> | null,
): ParsedSlackHistoryConfig {
  const raw = config?.channels;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error:
        "This Slack history source has no channel list configured — re-install it and pick at least one channel.",
    };
  }
  const channels: string[] = [];
  for (const entry of raw) {
    // A non-string entry is refused, not skipped: silently narrowing the
    // configured scope produces a source that reports success while never
    // reading a channel the admin believes is connected.
    if (typeof entry !== "string") {
      return {
        ok: false,
        error:
          "This Slack history source has a malformed channel list configured — re-install it and pick channels from the list.",
      };
    }
    const trimmed = entry.trim().toUpperCase();
    if (!SLACK_CHANNEL_ID_PATTERN.test(trimmed)) {
      return {
        ok: false,
        error: `This Slack history source has an invalid channel id configured ("${String(entry).slice(0, 40)}") — re-install it and pick channels from the list.`,
      };
    }
    if (!channels.includes(trimmed)) channels.push(trimmed);
  }
  if (channels.length === 0) {
    return {
      ok: false,
      error:
        "This Slack history source has no usable channel ids configured — re-install it and pick at least one channel.",
    };
  }
  if (channels.length > SLACK_HISTORY_MAX_CHANNELS) {
    return {
      ok: false,
      error: `This Slack history source has ${channels.length} channels configured, over the ${SLACK_HISTORY_MAX_CHANNELS}-channel limit — re-install it with a narrower scope.`,
    };
  }
  return { ok: true, channels };
}
