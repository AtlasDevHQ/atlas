/**
 * Thin Slack Web API client using native fetch.
 *
 * No heavy dependencies — POST to slack.com/api endpoints with JSON body
 * and Bearer token auth. The `oauth.*` namespace is the exception: Slack
 * rejects JSON bodies there and requires application/x-www-form-urlencoded
 * with client_id/client_secret in the body (no Bearer token). Sending
 * JSON makes Slack fail to parse `code` and return `invalid_code`.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { SlackBlock } from "@atlas/api/lib/slack/format";

const log = createLogger("slack-api");

const SLACK_API_BASE = "https://slack.com/api";

export type SlackAPIResponse =
  | { ok: true; ts?: string; channel?: string; [key: string]: unknown }
  | { ok: false; error: string };

/**
 * Call a Slack Web API method.
 */
export async function slackAPI(
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<SlackAPIResponse> {
  const isOauth = method.startsWith("oauth.");
  const headers: Record<string, string> = isOauth
    ? { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" }
    : {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      };
  const requestBody = isOauth
    ? new URLSearchParams(
        Object.entries(body).reduce<Record<string, string>>((acc, [k, v]) => {
          if (v !== undefined && v !== null) acc[k] = String(v as string | number | boolean);
          return acc;
        }, {}),
      ).toString()
    : JSON.stringify(body);

  try {
    const resp = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers,
      body: requestBody,
    });

    if (!resp.ok) {
      log.error({ method, status: resp.status }, "Slack API HTTP error");
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    const data = (await resp.json()) as Record<string, unknown>;
    if (!data.ok) {
      log.warn({ method, error: data.error }, "Slack API returned error");
      return { ok: false, error: String((data.error as string | undefined) ?? "unknown_error") };
    }
    return data as SlackAPIResponse;
  } catch (err) {
    log.error(
      { method, err: err instanceof Error ? err.message : String(err) },
      "Slack API request failed",
    );
    return { ok: false, error: `request_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * One channel row from `conversations.list`, projected down to the
 * fields the admin channel-picker needs. `isMember` matters because a
 * proactive override on a channel the bot isn't in can never fire —
 * the UI surfaces that as a warning instead of letting the admin
 * configure a dead row.
 */
export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

/**
 * Bounded pagination for {@link listChannels}. 5 pages × 200 channels
 * keeps the admin endpoint's worst-case latency at ~5 sequential Slack
 * round-trips while covering workspaces up to 1000 channels; beyond
 * that the picker still works — the admin can type the ID manually for
 * channels past the cap.
 */
const LIST_CHANNELS_MAX_PAGES = 5;

/**
 * Per-page fetch timeout. The listing backs an interactive admin
 * endpoint — a stalled Slack connection should fail the request (the
 * UI soft-degrades to manual entry) rather than pin the handler.
 */
const LIST_CHANNELS_TIMEOUT_MS = 10_000;

/**
 * List the workspace's channels via `conversations.list`.
 *
 * Uses GET with query-string args — unlike `chat.*`, the read methods
 * don't accept JSON bodies, and GET avoids the form-encoding split in
 * {@link slackAPI}. Private channels only appear when the bot has been
 * invited to them (Slack scopes the listing to the token's visibility),
 * so no extra filtering is needed.
 *
 * Scope degradation (#3462): the combined
 * `types=public_channel,private_channel` request fails wholesale with
 * `missing_scope` when the token has `channels:read` but not
 * `groups:read` (e.g. a workspace installed against an older app
 * manifest — new OAuth installs request both). Rather than returning
 * nothing, retry once with `types=public_channel` only and return that
 * listing (private channels simply absent). If even the public-only
 * retry fails, the error propagates — a `missing_scope` there means the
 * token lacks `channels:read` entirely and the caller should surface
 * the reconnect path (#3466).
 */
export async function listChannels(
  token: string,
): Promise<{ ok: true; channels: SlackChannelSummary[] } | { ok: false; error: string }> {
  const combined = await fetchChannelPages(token, "public_channel,private_channel");
  if (!combined.ok && combined.error === "missing_scope") {
    log.warn(
      { method: "conversations.list" },
      "missing_scope on combined channel listing — retrying public-only",
    );
    return fetchChannelPages(token, "public_channel");
  }
  return combined;
}

async function fetchChannelPages(
  token: string,
  types: string,
): Promise<{ ok: true; channels: SlackChannelSummary[] } | { ok: false; error: string }> {
  const channels: SlackChannelSummary[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < LIST_CHANNELS_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      types,
      exclude_archived: "true",
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);

    try {
      const resp = await fetch(`${SLACK_API_BASE}/conversations.list?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(LIST_CHANNELS_TIMEOUT_MS),
      });
      if (!resp.ok) {
        log.error({ method: "conversations.list", status: resp.status }, "Slack API HTTP error");
        return { ok: false, error: `HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as Record<string, unknown>;
      if (!data.ok) {
        log.warn(
          { method: "conversations.list", error: data.error },
          "Slack API returned error",
        );
        return { ok: false, error: String((data.error as string | undefined) ?? "unknown_error") };
      }
      const rawChannels = Array.isArray(data.channels) ? data.channels : [];
      for (const raw of rawChannels) {
        if (!raw || typeof raw !== "object") continue;
        const ch = raw as Record<string, unknown>;
        if (typeof ch.id !== "string" || typeof ch.name !== "string") continue;
        channels.push({
          id: ch.id,
          name: ch.name,
          isPrivate: ch.is_private === true,
          isMember: ch.is_member === true,
        });
      }
      const meta = data.response_metadata as { next_cursor?: unknown } | undefined;
      cursor = typeof meta?.next_cursor === "string" && meta.next_cursor.length > 0
        ? meta.next_cursor
        : undefined;
      if (!cursor) break;
    } catch (err) {
      log.error(
        { method: "conversations.list", err: err instanceof Error ? err.message : String(err) },
        "Slack API request failed",
      );
      return {
        ok: false,
        error: `request_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { ok: true, channels };
}

// ---------------------------------------------------------------------------
// Read methods for the brain chat-history source (#4770)
// ---------------------------------------------------------------------------

/**
 * A read-method failure. `retryAfterSeconds` is Slack's parsed `Retry-After`
 * on a 429 and `null` otherwise.
 *
 * The existing {@link slackAPI} collapses a 429 into `HTTP 429` and DROPS the
 * header, which is fine for the fire-and-forget `chat.*` writes it serves but
 * not for a scheduled crawl: the shared connector engine's bounded backoff is
 * driven by `Retry-After`, and without it every throttled cycle would sleep
 * the default 2s regardless of what Slack asked for. Hence the separate read
 * path rather than a widened `slackAPI` return type — the write callers have
 * no use for the field and would all have to grow a branch for it.
 */
/**
 * The failure codes that CARRY BEHAVIOUR — each one is branched on by the brain
 * client (`brain/ingest/slack/client.ts`) or the install handler to produce a
 * specific, actionable message. Slack's own error vocabulary is open, so the
 * type stays open (`string & {}`); naming these keeps a typo on either side of
 * the branch from silently falling through to the generic arm, which for
 * `"ratelimited"` would turn a backoff into a hard cycle failure.
 */
export type SlackReadErrorCode =
  | "ratelimited"
  | "missing_scope"
  | "not_in_channel"
  | "channel_not_found"
  | "invalid_auth"
  | "token_revoked"
  | "account_inactive"
  | "malformed_channel"
  | "missing_visibility"
  | "malformed_history_page"
  | "malformed_members_page"
  | "malformed_users_page"
  | "malformed_conversations_page";

export interface SlackReadError {
  readonly ok: false;
  // `string & {}` keeps the union open (Slack's vocabulary is) while preserving
  // autocomplete + typo-checking on the arms above that carry behaviour.
  readonly error: SlackReadErrorCode | (string & {});
  readonly retryAfterSeconds: number | null;
}

/** Per-request timeout for the scheduled read methods. */
const READ_TIMEOUT_MS = 15_000;

/** Parse Slack's `Retry-After` (delta-seconds) — null when absent/unusable. */
function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * GET a Slack read method. Unlike `chat.*`, the read namespace takes
 * query-string args (a JSON body is rejected), which is also why this does not
 * route through {@link slackAPI}'s POST path.
 */
async function slackReadGet(
  method: string,
  token: string,
  params: URLSearchParams,
): Promise<{ ok: true; data: Record<string, unknown> } | SlackReadError> {
  try {
    const resp = await fetch(`${SLACK_API_BASE}/${method}?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (resp.status === 429) {
      const retryAfterSeconds = parseRetryAfter(resp.headers);
      log.warn({ method, retryAfterSeconds }, "Slack API rate limited");
      return { ok: false, error: "ratelimited", retryAfterSeconds };
    }
    if (!resp.ok) {
      log.error({ method, status: resp.status }, "Slack API HTTP error");
      return { ok: false, error: `HTTP ${resp.status}`, retryAfterSeconds: null };
    }
    const data = (await resp.json()) as Record<string, unknown>;
    if (!data.ok) {
      const error = String((data.error as string | undefined) ?? "unknown_error");
      log.warn({ method, error }, "Slack API returned error");
      // Slack also signals throttling in-body on some tiers; treat it the same
      // so the engine backs off instead of counting it as a hard failure.
      return {
        ok: false,
        error,
        retryAfterSeconds: error === "ratelimited" ? parseRetryAfter(resp.headers) : null,
      };
    }
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ method, err: message }, "Slack API request failed");
    return { ok: false, error: `request_failed: ${message}`, retryAfterSeconds: null };
  }
}

/** One channel's metadata, projected to what grant derivation needs. */
export interface SlackConversationInfo {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isMember: boolean;
  readonly isArchived: boolean;
}

/**
 * `conversations.info` for one channel.
 *
 * The brain source reads this per configured channel per cycle rather than
 * reusing `listChannels`: the listing is page-capped (1000 channels) and
 * excludes archived conversations, so a channel outside it would come back
 * with UNKNOWN visibility — and unknown visibility has to be treated as
 * private, which would silently hide a public channel's episodes from
 * everyone. One authoritative call per channel removes the ambiguity.
 *
 * `is_private` is REQUIRED to be present: Slack always sends it, and defaulting
 * a missing field to `false` would publish an invite-only channel's contents
 * org-wide on a malformed response.
 */
export async function getConversationInfo(
  token: string,
  channelId: string,
): Promise<{ ok: true; channel: SlackConversationInfo } | SlackReadError> {
  const result = await slackReadGet(
    "conversations.info",
    token,
    new URLSearchParams({ channel: channelId }),
  );
  if (!result.ok) return result;
  const raw = result.data.channel;
  if (raw === null || typeof raw !== "object") {
    // `slackReadGet` logged nothing — `data.ok` was true — so a Slack
    // response-shape change would otherwise surface only as an opaque string in
    // a JSONB state column.
    log.error(
      { method: "conversations.info", channel: channelId },
      "Slack returned ok:true with no channel object — the response shape changed",
    );
    return { ok: false, error: "malformed_channel", retryAfterSeconds: null };
  }
  const channel = raw as Record<string, unknown>;
  if (typeof channel.is_private !== "boolean") {
    log.error(
      { method: "conversations.info", channel: channelId },
      "Slack channel payload carries no is_private flag — refusing to assume the channel is public",
    );
    return { ok: false, error: "missing_visibility", retryAfterSeconds: null };
  }
  return {
    ok: true,
    channel: {
      id: typeof channel.id === "string" ? channel.id : channelId,
      name: typeof channel.name === "string" ? channel.name : channelId,
      isPrivate: channel.is_private,
      isMember: channel.is_member === true,
      isArchived: channel.is_archived === true,
    },
  };
}

/** One raw message from `conversations.history`, narrowed to what we store. */
export interface SlackHistoryMessage {
  /** The per-channel message identity — the episode source-id's second half. */
  readonly ts: string;
  readonly text: string;
  readonly user: string | null;
  /**
   * Present on non-plain messages (`channel_join`, `thread_broadcast`,
   * `file_share`, …). NOT `message_changed` — that is an Events API subtype and
   * `conversations.history` never returns it (history serves the message's
   * current state, with the edit recorded in an `edited` sub-object).
   */
  readonly subtype: string | null;
  /** Set when the message was posted by a bot/app rather than a human. */
  readonly botId: string | null;
}

export interface SlackHistoryPage {
  readonly ok: true;
  readonly messages: readonly SlackHistoryMessage[];
  /** Slack's pagination cursor; null when the page was the last one. */
  readonly nextCursor: string | null;
  /**
   * Entries Slack returned that carry no usable identity (not an object, or no
   * `ts`). Reported rather than swallowed: they occupy the window the caller is
   * about to mark covered, so a caller that cares about gaplessness must treat
   * a non-zero count as incomplete coverage.
   */
  readonly dropped: number;
}

export interface SlackHistoryPageParams {
  readonly channel: string;
  /** Only messages AFTER this Slack ts (exclusive — `inclusive` is not set). */
  readonly oldest?: string;
  /** Only messages up to this Slack ts. */
  readonly latest?: string;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * One page of `conversations.history`.
 *
 * Pagination is Slack's cursor, walking NEWEST → oldest within
 * `[oldest, latest]`. The caller owns the walk (and the budget); this function
 * owns only the request shape and the narrowing.
 *
 * Requires the `channels:history` / `groups:history` scopes — a token without
 * them fails `missing_scope`, which the caller surfaces as an actionable
 * "re-run the Slack consent flow", never a silent empty page.
 */
export async function fetchConversationHistoryPage(
  token: string,
  params: SlackHistoryPageParams,
): Promise<SlackHistoryPage | SlackReadError> {
  const query = new URLSearchParams({
    channel: params.channel,
    limit: String(params.limit),
  });
  if (params.oldest !== undefined) query.set("oldest", params.oldest);
  if (params.latest !== undefined) query.set("latest", params.latest);
  if (params.cursor !== undefined) query.set("cursor", params.cursor);

  const result = await slackReadGet("conversations.history", token, query);
  if (!result.ok) return result;

  // An `ok:true` response whose `messages` is not an array is a PROTOCOL
  // VIOLATION, not an empty channel. Treating it as `[]` would let the caller
  // conclude the window was covered and advance its mark past everything in it
  // — permanent, silent evidence loss in a store where nothing later notices.
  if (!Array.isArray(result.data.messages)) {
    log.error(
      { method: "conversations.history", channel: params.channel },
      "Slack returned ok:true with a non-array `messages` — refusing to read it as an empty page",
    );
    return { ok: false, error: "malformed_history_page", retryAfterSeconds: null };
  }
  const messages: SlackHistoryMessage[] = [];
  let dropped = 0;
  for (const entry of result.data.messages) {
    if (entry === null || typeof entry !== "object") {
      dropped++;
      continue;
    }
    const m = entry as Record<string, unknown>;
    // A message with no `ts` has no identity — it cannot be deduped, so it is
    // skipped rather than stored under a fabricated key. Counted, never silent:
    // the caller must not advance a mark past a message it could not identify.
    if (typeof m.ts !== "string" || m.ts === "") {
      dropped++;
      continue;
    }
    messages.push({
      ts: m.ts,
      text: typeof m.text === "string" ? m.text : "",
      user: typeof m.user === "string" && m.user !== "" ? m.user : null,
      subtype: typeof m.subtype === "string" && m.subtype !== "" ? m.subtype : null,
      botId: typeof m.bot_id === "string" && m.bot_id !== "" ? m.bot_id : null,
    });
  }

  const meta = result.data.response_metadata as { next_cursor?: unknown } | undefined;
  const nextCursor =
    typeof meta?.next_cursor === "string" && meta.next_cursor.length > 0
      ? meta.next_cursor
      : null;
  if (dropped > 0) {
    log.warn(
      { method: "conversations.history", channel: params.channel, dropped },
      "Slack history page contained messages with no usable identity — they cannot be stored",
    );
  }
  return { ok: true, messages, nextCursor, dropped };
}

// ---------------------------------------------------------------------------
// Read method for membership-derived ingest scope (#5203)
// ---------------------------------------------------------------------------

/** One page of `users.conversations` — the channels the BOT is a member of. */
export interface SlackUserConversationsPage {
  readonly ok: true;
  readonly channels: readonly SlackConversationInfo[];
  readonly nextCursor: string | null;
}

/**
 * One page of the calling token's own conversations — i.e. the bot's channel
 * membership, which since #5203 IS the brain's ingest scope (minus the admin
 * exclusion list).
 *
 * ## Why `users.conversations` and not `listChannels`
 *
 * `listChannels` (`conversations.list`) enumerates the WORKSPACE and filters
 * client-side on `is_member`. Two properties make it wrong for scope
 * resolution, and both fail in the silent direction:
 *
 *   - it is page-capped at 5 × 200, so a workspace with more than 1000
 *     conversations would resolve a scope missing whatever fell off the end —
 *     channels the bot IS in, reading as channels it is not, i.e. ingest
 *     quietly narrower than the admin's own invitations. The cap is defensible
 *     for a picker that degrades to manual entry; it is not defensible for the
 *     set that decides what gets read.
 *   - it passes `exclude_archived=true`. An archived channel's history is
 *     still readable and still evidence — the install handler admitted one
 *     with a warning — so excluding it here would drop a channel's history
 *     from scope the moment someone archived it.
 *
 * `users.conversations` returns only the token's own memberships, so the set is
 * bounded by what the bot was actually invited to rather than by workspace
 * size, and there is no client-side membership filter to get wrong.
 *
 * Scopes: `channels:read` + `groups:read`, both already granted at chat-install
 * time (`slack-oauth-handler.ts`). Unlike `listChannels` this does NOT retry
 * public-only on `missing_scope` — a partial scope resolution is the silent
 * narrowing above, and a caller that cannot see private channels must be told
 * rather than handed a set that looks complete.
 *
 * `is_private` is REQUIRED on every entry, for `getConversationInfo`'s reason:
 * defaulting a missing field to `false` publishes an invite-only channel's
 * contents org-wide. A page carrying one unusable entry is refused whole, on
 * `fetchConversationMembersPage`'s reasoning — the caller reconciles the
 * returned set against stored rows and marks absentees out of scope, so an
 * understated page does not merely miss a channel, it RETIRES one.
 */
export async function fetchUserConversationsPage(
  token: string,
  params: { readonly cursor?: string; readonly limit: number },
): Promise<SlackUserConversationsPage | SlackReadError> {
  const query = new URLSearchParams({
    types: "public_channel,private_channel",
    // Archived channels stay IN the listing — see the header. Slack's default
    // is already `false`; it is spelled out because the default is the whole
    // decision and a reader should not have to know it.
    exclude_archived: "false",
    limit: String(params.limit),
  });
  if (params.cursor !== undefined) query.set("cursor", params.cursor);

  const result = await slackReadGet("users.conversations", token, query);
  if (!result.ok) return result;

  if (!Array.isArray(result.data.channels)) {
    log.error(
      { method: "users.conversations" },
      "Slack returned ok:true with a non-array `channels` — refusing to read it as an empty membership",
    );
    return { ok: false, error: "malformed_conversations_page", retryAfterSeconds: null };
  }

  const channels: SlackConversationInfo[] = [];
  for (const raw of result.data.channels) {
    if (raw === null || typeof raw !== "object") continue;
    const ch = raw as Record<string, unknown>;
    if (typeof ch.id !== "string" || ch.id === "") continue;
    if (typeof ch.is_private !== "boolean") continue;
    channels.push({
      id: ch.id,
      name: typeof ch.name === "string" ? ch.name : ch.id,
      isPrivate: ch.is_private,
      // Every entry `users.conversations` returns is one the token is a member
      // of — that is what the method means — so this is not read off the
      // payload. `conversations.list` needs the flag because it enumerates the
      // workspace; here a `false` would contradict the endpoint.
      isMember: true,
      isArchived: ch.is_archived === true,
    });
  }
  if (channels.length !== result.data.channels.length) {
    log.error(
      {
        method: "users.conversations",
        returned: result.data.channels.length,
        usable: channels.length,
      },
      "Slack membership page contained unusable channel entries — refusing a partial page rather than retiring the channels it omits",
    );
    return { ok: false, error: "malformed_conversations_page", retryAfterSeconds: null };
  }

  const meta = result.data.response_metadata as { next_cursor?: unknown } | undefined;
  const nextCursor =
    typeof meta?.next_cursor === "string" && meta.next_cursor.length > 0 ? meta.next_cursor : null;
  return { ok: true, channels, nextCursor };
}

// ---------------------------------------------------------------------------
// Read method for the Coverage Surface's chat denominator (#5213)
// ---------------------------------------------------------------------------

/**
 * One row of the public-channel roster.
 *
 * Its own shape rather than {@link SlackConversationInfo}, for ONE field:
 * `name` is nullable here. That type's `name` is `string` and its two producers
 * fall back to the channel ID when Slack omits it — harmless where the value is
 * a log line or a probe message, and NOT harmless here, because this `name` is
 * the candidate `unit_label` on the Coverage Surface. An id stored in a label
 * column is a row that reads as NAMED while carrying no name, which defeats the
 * counted-never-named split at the one seam that split exists for.
 */
export interface SlackPublicChannel {
  readonly id: string;
  /** `null` when Slack sent no usable name — counted, never named. */
  readonly name: string | null;
  readonly isPrivate: boolean;
  readonly isMember: boolean;
  readonly isArchived: boolean;
}

/** One page of `conversations.list` — the workspace's PUBLIC channel roster. */
export interface SlackConversationsListPage {
  readonly ok: true;
  readonly channels: readonly SlackPublicChannel[];
  readonly nextCursor: string | null;
}

/**
 * One page of the workspace's **public** channel roster — ADR-0041's
 * `chat-channel-roster` denominator.
 *
 * ## Why this exists beside both `listChannels` and `fetchUserConversationsPage`
 *
 * The three answer three different questions and the differences are exactly the
 * ones that fail silently:
 *
 *   - {@link fetchUserConversationsPage} answers *"what is the bot IN?"* — the
 *     ingest perimeter. It cannot see a channel nobody invited the bot to, which
 *     is precisely the population a denominator has to count.
 *   - {@link listChannels} answers *"what can an admin pick?"* and degrades for
 *     that job: it caps at 5 pages and reports the truncation to nobody, it
 *     passes `exclude_archived=true`, and on `missing_scope` it silently retries
 *     public-only and returns the narrower listing as a success. Every one of
 *     those is fine for a picker that falls back to manual entry, and every one
 *     of them understates a denominator without saying so.
 *   - This one answers *"what does this token's workspace CONTAIN?"*, and it
 *     reports incompleteness to the caller instead of absorbing it, because
 *     ADR-0041's map edge is a mark the page has to render rather than a
 *     shortfall it can absorb.
 *
 * **Public channels only** (`types=public_channel`). Private channels the bot is
 * not in are not visible to the token at all, so asking for them would return
 * exactly the private channels the bot IS in — which the perimeter half already
 * has — while risking a whole-request `missing_scope` on a token holding
 * `channels:read` without `groups:read` (#3462's failure). ADR-0041's
 * vendor-public label clause is also scoped to public channels by definition, so
 * the label half and the count half agree.
 *
 * `exclude_archived=false`, matching {@link fetchUserConversationsPage}: an
 * archived channel's history is still readable and still evidence, so dropping
 * it here would shrink the denominator the moment somebody archived a channel —
 * and shrinking a denominator raises a ratio, which is the flattering direction.
 *
 * A page carrying one unusable entry is refused WHOLE, on
 * {@link fetchUserConversationsPage}'s reasoning applied to the denominator: the
 * caller's roster is swept against what this returns, so an understated page
 * does not merely miss a channel, it RETIRES one — the "loud understatement"
 * mutation ADR-0041's fixture charter names.
 */
export async function fetchConversationsListPage(
  token: string,
  params: { readonly cursor?: string; readonly limit: number },
): Promise<SlackConversationsListPage | SlackReadError> {
  const query = new URLSearchParams({
    types: "public_channel",
    exclude_archived: "false",
    limit: String(params.limit),
  });
  if (params.cursor !== undefined) query.set("cursor", params.cursor);

  const result = await slackReadGet("conversations.list", token, query);
  if (!result.ok) return result;

  if (!Array.isArray(result.data.channels)) {
    log.error(
      { method: "conversations.list" },
      "Slack returned ok:true with a non-array `channels` — refusing to read it as an empty roster",
    );
    return { ok: false, error: "malformed_conversations_page", retryAfterSeconds: null };
  }

  const channels: SlackPublicChannel[] = [];
  for (const raw of result.data.channels) {
    if (raw === null || typeof raw !== "object") continue;
    const ch = raw as Record<string, unknown>;
    if (typeof ch.id !== "string" || ch.id === "") continue;
    // `is_private` is REQUIRED even though this request asks for public channels
    // only: the flag is what the Coverage Surface's vendor-public label clause
    // leans on, and inferring `false` from the `types=` parameter would name a
    // channel on the strength of what we ASKED for rather than what Slack said.
    if (typeof ch.is_private !== "boolean") continue;
    channels.push({
      id: ch.id,
      // NULL rather than the id — see {@link SlackPublicChannel}. The caller
      // stores this in a label column, and an id there reads as a name.
      name: typeof ch.name === "string" && ch.name !== "" ? ch.name : null,
      isPrivate: ch.is_private,
      // Read off the payload here, unlike `users.conversations` — this method
      // enumerates the workspace, so membership is a property of the row rather
      // than of the endpoint.
      isMember: ch.is_member === true,
      isArchived: ch.is_archived === true,
    });
  }
  if (channels.length !== result.data.channels.length) {
    log.error(
      {
        method: "conversations.list",
        returned: result.data.channels.length,
        usable: channels.length,
      },
      "Slack public-channel roster page contained unusable entries — refusing a partial page rather than understating the coverage denominator",
    );
    return { ok: false, error: "malformed_conversations_page", retryAfterSeconds: null };
  }

  const meta = result.data.response_metadata as { next_cursor?: unknown } | undefined;
  const nextCursor =
    typeof meta?.next_cursor === "string" && meta.next_cursor.length > 0 ? meta.next_cursor : null;
  return { ok: true, channels, nextCursor };
}

// ---------------------------------------------------------------------------
// Read methods for audience-membership sync (#4801)
// ---------------------------------------------------------------------------

/** One page of `conversations.members` — Slack user ids. */
export interface SlackMembersPage {
  readonly ok: true;
  readonly memberIds: readonly string[];
  readonly nextCursor: string | null;
}

/**
 * One page of a private channel's roster.
 *
 * Gated on `channels:read` / `groups:read` — scopes the workspace ALREADY holds
 * (they power the admin channel picker). So the roster half of #4801 costs no
 * re-consent; only the directory read below does.
 *
 * A non-array `members` on an `ok:true` response is a PROTOCOL VIOLATION, not
 * an empty channel, and is refused for the same reason `conversations.history`
 * refuses one: the caller's completeness check is what licenses it to DELETE
 * membership rows, and "the roster is empty" would license deleting all of
 * them. Every roster fault must reach the caller as a fault.
 */
export async function fetchConversationMembersPage(
  token: string,
  params: { readonly channel: string; readonly cursor?: string; readonly limit: number },
): Promise<SlackMembersPage | SlackReadError> {
  const query = new URLSearchParams({
    channel: params.channel,
    limit: String(params.limit),
  });
  if (params.cursor !== undefined) query.set("cursor", params.cursor);

  const result = await slackReadGet("conversations.members", token, query);
  if (!result.ok) return result;

  if (!Array.isArray(result.data.members)) {
    log.error(
      { method: "conversations.members", channel: params.channel },
      "Slack returned ok:true with a non-array `members` — refusing to read it as an empty roster",
    );
    return { ok: false, error: "malformed_members_page", retryAfterSeconds: null };
  }
  const memberIds: string[] = [];
  for (const entry of result.data.members) {
    if (typeof entry === "string" && entry !== "") memberIds.push(entry);
  }
  // A member id that is not a non-empty string is unusable, and dropping it
  // silently would understate the roster — which, once the caller reconciles,
  // REVOKES someone. Refuse the page instead; the caller aborts the audience.
  if (memberIds.length !== result.data.members.length) {
    log.error(
      {
        method: "conversations.members",
        channel: params.channel,
        returned: result.data.members.length,
        usable: memberIds.length,
      },
      "Slack roster page contained unusable member ids — refusing a partial roster",
    );
    return { ok: false, error: "malformed_members_page", retryAfterSeconds: null };
  }

  const meta = result.data.response_metadata as { next_cursor?: unknown } | undefined;
  const nextCursor =
    typeof meta?.next_cursor === "string" && meta.next_cursor.length > 0 ? meta.next_cursor : null;
  return { ok: true, memberIds, nextCursor };
}

/**
 * One Slack workspace member, projected to what identity resolution needs.
 *
 * `email` is `null` whenever Slack did not supply one — a guest whose profile
 * has none, or, more importantly, a token WITHOUT `users:read.email`, which
 * returns the profile with the field simply absent rather than erroring. The
 * caller must therefore treat "every member has a null email" as a scope
 * problem to surface, never as "nobody matched".
 */
export interface SlackDirectoryUser {
  readonly id: string;
  readonly email: string | null;
  /** Deactivated at Slack. Excluded from audiences — deactivation is revocation. */
  readonly deleted: boolean;
  readonly isBot: boolean;
}

/** One page of `users.list`. */
export interface SlackUsersPage {
  readonly ok: true;
  readonly users: readonly SlackDirectoryUser[];
  readonly nextCursor: string | null;
  /**
   * Entries this page could not identify.
   *
   * Carried rather than merely logged — as `SlackHistoryPage` carries its own —
   * because the caller's completeness judgement is what licenses a DELETE. A
   * directory entry Atlas dropped is a roster member Atlas cannot resolve, and
   * an unresolved member is REVOKED. Without this field the caller cannot tell
   * a small directory from a lossy one, so the loss is structurally invisible
   * exactly where it is most expensive.
   */
  readonly dropped: number;
}

/**
 * One page of the workspace's Slack directory.
 *
 * Requires `users:read`, and `users:read.email` for `profile.email` — BOTH new
 * as of #4801, so this is the read that costs a Slack app manifest change and a
 * re-consent (see `SLACK_SCOPES`). A token holding neither fails
 * `missing_scope`; a token holding `users:read` alone succeeds with every
 * `email` null, which is why the caller checks for that shape explicitly
 * instead of concluding the workspace has no matching users.
 *
 * Read once per workspace per cycle and shared across that workspace's
 * channels: the directory is workspace-scoped, so a per-channel fetch would
 * multiply the same paginated call by the channel count for identical data.
 */
export async function fetchUsersListPage(
  token: string,
  params: { readonly cursor?: string; readonly limit: number },
): Promise<SlackUsersPage | SlackReadError> {
  const query = new URLSearchParams({ limit: String(params.limit) });
  if (params.cursor !== undefined) query.set("cursor", params.cursor);

  const result = await slackReadGet("users.list", token, query);
  if (!result.ok) return result;

  if (!Array.isArray(result.data.members)) {
    log.error(
      { method: "users.list" },
      "Slack returned ok:true with a non-array `members` — refusing to read it as an empty directory",
    );
    return { ok: false, error: "malformed_users_page", retryAfterSeconds: null };
  }
  const users: SlackDirectoryUser[] = [];
  let dropped = 0;
  for (const entry of result.data.members) {
    if (entry === null || typeof entry !== "object") {
      dropped++;
      continue;
    }
    const u = entry as Record<string, unknown>;
    if (typeof u.id !== "string" || u.id === "") {
      dropped++;
      continue;
    }
    const profile = (u.profile ?? null) as Record<string, unknown> | null;
    const rawEmail = profile?.email;
    users.push({
      id: u.id,
      email: typeof rawEmail === "string" && rawEmail !== "" ? rawEmail : null,
      deleted: u.deleted === true,
      isBot: u.is_bot === true,
    });
  }
  // A dropped directory entry has a SMALLER blast radius than a truncated
  // roster — it can only fail to resolve the individuals it dropped, not the
  // whole audience — but it is the same KIND of harm: those individuals are
  // revoked at the next reconcile. So it is reported to the caller (which
  // treats it as a read fault), not just logged. The count also separates
  // "half the directory is malformed" from "half the workspace has no Atlas
  // account", which otherwise produce identical membership.
  if (dropped > 0) {
    log.warn(
      { method: "users.list", dropped },
      "Slack directory page contained entries with no usable identity — they cannot resolve to an Atlas user",
    );
  }

  const meta = result.data.response_metadata as { next_cursor?: unknown } | undefined;
  const nextCursor =
    typeof meta?.next_cursor === "string" && meta.next_cursor.length > 0 ? meta.next_cursor : null;
  return { ok: true, users, nextCursor, dropped };
}

/**
 * Post a message to a Slack channel.
 */
export async function postMessage(
  token: string,
  params: {
    channel: string;
    text: string;
    blocks?: SlackBlock[];
    thread_ts?: string;
  },
): Promise<SlackAPIResponse> {
  return slackAPI("chat.postMessage", token, params as Record<string, unknown>);
}

/**
 * Update an existing Slack message.
 */
export async function updateMessage(
  token: string,
  params: {
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
  },
): Promise<SlackAPIResponse> {
  return slackAPI("chat.update", token, params as Record<string, unknown>);
}

/**
 * Post an ephemeral message visible only to a specific user.
 */
export async function postEphemeral(
  token: string,
  params: {
    channel: string;
    user: string;
    text: string;
    blocks?: SlackBlock[];
    thread_ts?: string;
  },
): Promise<SlackAPIResponse> {
  return slackAPI("chat.postEphemeral", token, params as Record<string, unknown>);
}
