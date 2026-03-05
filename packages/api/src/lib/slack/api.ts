/**
 * Thin Slack Web API client using native fetch.
 *
 * No heavy dependencies — POST to slack.com/api endpoints with JSON body
 * and Bearer token auth. For oauth.v2.access, pass an empty token — Slack
 * uses client_id/client_secret from the body instead.
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
  try {
    const resp = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      log.error({ method, status: resp.status }, "Slack API HTTP error");
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    const data = (await resp.json()) as Record<string, unknown>;
    if (!data.ok) {
      log.warn({ method, error: data.error }, "Slack API returned error");
      return { ok: false, error: String(data.error ?? "unknown_error") };
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
