/**
 * Resume-pending coordinate store for chat-surface approval-park (#3750).
 *
 * When an agent turn initiated from a chat platform (Slack/Telegram/…) parks
 * on an approval rule, the durable engine writes a `parked` checkpoint keyed
 * on the approval-queue ref (`agent_runs.parked_reason`) — but that row is
 * deliberately surface-agnostic: it records WHAT the agent was doing, never
 * WHERE to deliver the answer (ADR-0020). To resume the *thread* once the
 * approval is resolved, the chat surface needs the platform + thread
 * coordinates, which it stores HERE, beside the run.
 *
 * Storage: a single `chat_cache` row keyed `chat:resume-pending:<conversationId>`
 * carrying `{ platform, threadId, orgId }`. This is an Atlas-extension field on
 * an already-Atlas-owned table (the same category as the Slack installation
 * extension fields in the chat-plugin × Atlas contract). The chat-adapter never
 * reads it; only host code writes (at park) and reads/deletes (at resume) it.
 * No new table, no `agent_runs` column — the engine stays surface-neutral.
 *
 * Lifecycle: written at park, consumed (read + deleted) on a successful resume
 * delivery, and TTL-expired (via `expires_at`, mirroring the max-park window)
 * so a parked run that is swept to `failed` never leaves a dangling coordinate.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { getMaxParkMinutes } from "@atlas/api/lib/durable-session";

const log = createLogger("chat-resume-pending-store");

/**
 * Chat cache table — mirrors `lib/slack/store.ts`'s resolution so a
 * non-default `state.tablePrefix` deploy lands the coordinate in the same
 * physical table the rest of the chat-plugin state uses. SaaS pins the
 * default (`chat_cache`). Import-time env read (permitted by the testing
 * discipline for import-time config).
 */
const CACHE_TABLE = (() => {
  const raw = process.env.ATLAS_SLACK_INSTALL_TABLE;
  if (!raw) return "chat_cache";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw)) {
    throw new Error(
      `ATLAS_SLACK_INSTALL_TABLE must be a valid SQL identifier (got '${raw}')`,
    );
  }
  return raw;
})();

const KEY_PREFIX = "chat:resume-pending:";

function keyFor(conversationId: string): string {
  return `${KEY_PREFIX}${conversationId}`;
}

/**
 * Coordinates needed to resume a parked chat turn and deliver the continued
 * answer back to its originating thread.
 *
 * - `platform` — chat-plugin platform slug (`"slack"`, `"telegram"`, …). Typed
 *   as a string because core cannot import the plugin's `ChatPlatform` union;
 *   the deliverer impl (registered by the plugin) narrows it.
 * - `threadId` — the canonical cross-platform thread anchor the bridge uses
 *   everywhere (Slack `channel:thread_ts`, Telegram `chat:message_thread_id`,
 *   …); sufficient addressing for a thread post.
 * - `orgId` — the workspace the turn ran under.
 * - `externalId` / `externalUserId` — the bot-actor binding inputs
 *   (`botActorUser({ platform, externalId, orgId, externalUserId })`). Stored
 *   so the resume re-enters under the SAME actor identity that parked — its
 *   `userId` (`${platform}-bot:${externalId}[:externalUserId]`) must match for
 *   the approval gate's `hasApprovedRequest` dedup to clear on re-run. Without
 *   the exact actor the rewritten "approved, re-run now" transcript would
 *   re-park (a different requester id ⇒ no prior approval ⇒ a fresh request).
 */
export interface ChatResumeCoordinates {
  readonly platform: string;
  readonly threadId: string;
  readonly orgId: string;
  readonly externalId: string;
  readonly externalUserId?: string;
}

/**
 * Persist the thread coordinates for a parked chat turn, keyed by
 * conversation. Best-effort and fail-soft: a write failure is logged and
 * returns `false` (the turn still parks; the user simply won't get an
 * auto-resumed thread — they fall back to the admin-console approval flow).
 * Never throws into the chat reply path.
 *
 * TTL mirrors the max-park window so the coordinate self-expires in lockstep
 * with the parked run the sweep would fail.
 */
export async function saveResumePending(
  conversationId: string,
  coords: ChatResumeCoordinates,
): Promise<boolean> {
  if (!hasInternalDB()) return false;
  const ttlMinutes = getMaxParkMinutes(coords.orgId);
  try {
    await internalQuery(
      `INSERT INTO ${CACHE_TABLE} (key, value, expires_at)
         VALUES ($1, $2::jsonb, now() + ($3 || ' minutes')::interval)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             expires_at = EXCLUDED.expires_at`,
      [
        keyFor(conversationId),
        JSON.stringify({
          platform: coords.platform,
          threadId: coords.threadId,
          orgId: coords.orgId,
          externalId: coords.externalId,
          ...(coords.externalUserId !== undefined
            ? { externalUserId: coords.externalUserId }
            : {}),
        }),
        String(ttlMinutes),
      ],
    );
    return true;
  } catch (err) {
    log.warn(
      {
        conversationId,
        platform: coords.platform,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to persist chat resume-pending coordinates — thread auto-resume will be unavailable for this turn",
    );
    return false;
  }
}

/**
 * Load the resume coordinates for a conversation. Returns `null` when there is
 * no internal DB, no pending row (never parked, already delivered, or expired),
 * or the stored value is malformed. A DB error is logged and returns `null`
 * (fail-soft — a failed lookup must not break the approval-review handler).
 */
export async function loadResumePending(
  conversationId: string,
): Promise<ChatResumeCoordinates | null> {
  if (!hasInternalDB()) return null;
  try {
    const rows = await internalQuery<{ value: unknown }>(
      `SELECT value FROM ${CACHE_TABLE}
         WHERE key = $1
           AND (expires_at IS NULL OR expires_at > now())`,
      [keyFor(conversationId)],
    );
    const value = rows[0]?.value;
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (
      typeof v.platform !== "string" ||
      typeof v.threadId !== "string" ||
      typeof v.orgId !== "string" ||
      typeof v.externalId !== "string"
    ) {
      log.warn({ conversationId }, "chat resume-pending row has malformed coordinates — ignoring");
      return null;
    }
    return {
      platform: v.platform,
      threadId: v.threadId,
      orgId: v.orgId,
      externalId: v.externalId,
      ...(typeof v.externalUserId === "string" ? { externalUserId: v.externalUserId } : {}),
    };
  } catch (err) {
    log.warn(
      { conversationId, err: err instanceof Error ? err.message : String(err) },
      "Failed to load chat resume-pending coordinates",
    );
    return null;
  }
}

/**
 * Delete the resume-pending row after a successful (or terminally failed)
 * delivery so it is consumed exactly once. Best-effort: a failed delete leaves
 * the row to TTL-expire. Never throws.
 */
export async function clearResumePending(conversationId: string): Promise<void> {
  if (!hasInternalDB()) return;
  try {
    await internalQuery(`DELETE FROM ${CACHE_TABLE} WHERE key = $1`, [keyFor(conversationId)]);
  } catch (err) {
    log.debug(
      { conversationId, err: err instanceof Error ? err.message : String(err) },
      "Failed to clear chat resume-pending coordinates — will TTL-expire",
    );
  }
}
