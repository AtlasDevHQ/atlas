/**
 * Slack thread → Atlas conversation ID mapping.
 *
 * Maps Slack thread_ts values to Atlas conversation IDs so follow-up
 * messages in a thread continue the same conversation context.
 *
 * Thread mapping is stored but conversation context is not yet loaded
 * across messages. Each message is currently standalone.
 */

import { hasInternalDB, internalQuery, getInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("slack-threads");

/**
 * Get the Atlas conversation ID for a Slack thread.
 * Returns null if no mapping exists or conversation persistence isn't available.
 */
export async function getConversationId(
  channelId: string,
  threadTs: string,
): Promise<string | null> {
  if (!hasInternalDB()) {
    log.debug("No internal DB — skipping thread mapping lookup");
    return null;
  }

  try {
    const rows = await internalQuery<{ conversation_id: string }>(
      "SELECT conversation_id FROM slack_threads WHERE channel_id = $1 AND thread_ts = $2",
      [channelId, threadTs],
    );
    return rows[0]?.conversation_id ?? null;
  } catch (err) {
    log.error(
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
): Promise<void> {
  if (!hasInternalDB()) {
    log.debug("No internal DB — skipping thread mapping storage");
    return;
  }

  const pool = getInternalDB();
  await pool.query(
    `INSERT INTO slack_threads (channel_id, thread_ts, conversation_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (thread_ts, channel_id) DO UPDATE SET conversation_id = $3`,
    [channelId, threadTs, conversationId],
  );
}
