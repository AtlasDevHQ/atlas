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
