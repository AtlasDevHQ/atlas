/**
 * Amendments-pending proactive notice — EE delivery (#4520).
 *
 * When the autonomous-improvement scheduler queues new pending Amendments
 * for a workspace, its admins get one batched proactive message: "N new
 * semantic-layer improvements are pending your review." This is the EE
 * side of the `ProactiveService.notifyAmendmentsPending` seam; the core
 * scheduler reaches it via `lib/proactive/notify-amendments.ts`.
 *
 * Delivery reuses the proactive-chat announcement channel
 * (`workspace_proactive_config.announcement_channel_id`) via the shared
 * `ChatAnnouncer` port — no bespoke notification channel (#4520). A
 * workspace that never configured a proactive channel simply has nowhere
 * to receive the notice, which resolves as a clean skip rather than an
 * error.
 *
 * Unlike the one-shot activation announcement, this notice is NOT
 * idempotency-stamped: it fires on each tick that produces net-new
 * pending Amendments, and the caller has already batched the tick's rows
 * into a single `count`. Posting is best-effort — every failure resolves
 * to a `{ posted: false }` outcome; nothing here throws.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  ChatAnnouncer,
  AmendmentNoticeInput,
  AmendmentNoticeOutcome,
} from "@atlas/api/lib/proactive/types";

const log = createLogger("proactive-amendment-notification");

/**
 * Render the amendments-pending notice. Pure — exported so the unit test
 * pins the wording (the "pending your review" phrasing is the contract
 * the PRD's user story 25 names) without a DB. Plain markdown, mirroring
 * `buildAnnouncementMessage`; rich cards are a later cross-cutting slice.
 */
export function buildAmendmentsPendingMessage(count: number): string {
  const isOne = count === 1;
  const noun = isOne ? "improvement" : "improvements";
  const verb = isOne ? "is" : "are";
  return [
    `*${count} new semantic-layer ${noun} ${verb} pending your review.*`,
    "",
    `Atlas's autonomous improvement queued ${isOne ? "a change" : `${count} changes`} to`,
    "your semantic layer. Approve or reject them in the Semantic Layer",
    "Improvement console — nothing applies until you review it.",
  ].join("\n");
}

/** Raw shape of the config probe. Index signature satisfies `internalQuery`. */
interface RawConfigRow {
  announcement_channel_id: string | null;
  [key: string]: unknown;
}

/**
 * Post the amendments-pending notice for a workspace, if a proactive
 * announcement channel is configured.
 *
 * @param input.workspaceId  Atlas workspace id (== org id).
 * @param input.count        Batched count of net-new pending Amendments.
 * @param input.announcer    Chat-platform port (host-resolved).
 */
export async function notifyAmendmentsPending(
  input: AmendmentNoticeInput & { announcer: ChatAnnouncer },
): Promise<AmendmentNoticeOutcome> {
  const { workspaceId, count, announcer } = input;

  // Self-guarding: the core bridge already guards, but a direct EE caller
  // must never render "0 new improvements".
  if (count <= 0) {
    return { posted: false, reason: "nothing_to_notify" };
  }

  if (!hasInternalDB()) {
    return { posted: false, reason: "no_internal_db" };
  }

  let rows: RawConfigRow[];
  try {
    rows = await internalQuery<RawConfigRow>(
      `SELECT announcement_channel_id
         FROM workspace_proactive_config
        WHERE workspace_id = $1
        LIMIT 1`,
      [workspaceId],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { workspaceId, err: message },
      "Amendments-pending notice: workspace_proactive_config read failed",
    );
    return { posted: false, reason: "error", message };
  }

  const [row] = rows;
  if (!row) {
    // Workspace never engaged proactive chat — nothing to key a channel on.
    return { posted: false, reason: "no_config_row" };
  }
  const channelId = row.announcement_channel_id;
  if (!channelId) {
    // Proactive config exists but no announcement channel to post to.
    return { posted: false, reason: "no_channel" };
  }

  const markdown = buildAmendmentsPendingMessage(count);
  let result: Awaited<ReturnType<ChatAnnouncer["postChannelAnnouncement"]>>;
  try {
    result = await announcer.postChannelAnnouncement({
      workspaceId,
      channelId,
      markdown,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { workspaceId, channelId, err: message },
      "Amendments-pending notice: announcer threw",
    );
    return { posted: false, reason: "announcer_threw", message };
  }

  if (!result.ok) {
    if (result.reason === "no_announcer_configured") {
      return { posted: false, reason: "no_announcer_configured" };
    }
    log.warn(
      { workspaceId, channelId, reason: result.reason },
      "Amendments-pending notice: announcer rejected the post",
    );
    return { posted: false, reason: "announcer_rejected", message: result.reason };
  }

  log.info(
    { workspaceId, channelId, count, messageId: result.messageId ?? null },
    "Posted amendments-pending proactive notice",
  );
  return { posted: true, messageId: result.messageId };
}
