/**
 * Slack thread → Atlas conversation ID mapping.
 *
 * Maps Slack thread_ts values to Atlas conversation IDs so follow-up
 * messages in a thread continue the same conversation context.
 */

import type { PluginLogger } from "@useatlas/plugin-sdk";
import type { PluginDB } from "./store";

/**
 * Get the Atlas conversation ID for a Slack thread.
 * Returns null if no mapping exists or no DB is available.
 */
export async function getConversationId(
  channelId: string,
  threadTs: string,
  db: PluginDB | null,
  log?: PluginLogger,
): Promise<string | null> {
  if (!db) {
    log?.debug("No internal DB — skipping thread mapping lookup");
    return null;
  }

  try {
    const result = await db.query(
      "SELECT conversation_id FROM slack_threads WHERE channel_id = $1 AND thread_ts = $2",
      [channelId, threadTs],
    );
    const row = result.rows[0];
    return typeof row?.conversation_id === "string" ? row.conversation_id : null;
  } catch (err) {
    log?.error(
      { err: err instanceof Error ? err.message : String(err), channelId, threadTs },
      "Failed to look up thread mapping",
    );
    return null;
  }
}

/**
 * Store a mapping from Slack thread to Atlas conversation ID.
 */
export async function setConversationId(
  channelId: string,
  threadTs: string,
  conversationId: string,
  db: PluginDB | null,
  log?: PluginLogger,
): Promise<void> {
  if (!db) {
    log?.debug("No internal DB — skipping thread mapping storage");
    return;
  }

  try {
    await db.execute(
      `INSERT INTO slack_threads (channel_id, thread_ts, conversation_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (thread_ts, channel_id) DO UPDATE SET conversation_id = $3`,
      [channelId, threadTs, conversationId],
    );
  } catch (err) {
    log?.error(
      { err: err instanceof Error ? err.message : String(err), channelId, threadTs },
      "Failed to store thread mapping",
    );
  }
}
