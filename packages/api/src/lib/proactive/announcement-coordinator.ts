/**
 * AnnouncementCoordinator — proactive-chat one-time activation announcement
 * (PRD #2291, slice #2300).
 *
 * The very first time a workspace admin flips `proactive.enabled = true`
 * AND has set an `announcement_channel_id`, Atlas posts a single
 * onboarding message to that channel so end-users learn about the new
 * behaviour before the bot starts reacting to their messages.
 *
 * Idempotency contract:
 *   - `workspace_proactive_config.announcement_posted_at` (NULL = never
 *     posted) is the single source of truth.
 *   - A successful post stamps the column inside the same transaction
 *     so concurrent admins flipping the toggle race-safely produce one
 *     announcement, not N.
 *   - Disabling + re-enabling does NOT clear the stamp — re-announcing
 *     every toggle would erode end-user trust ("did this just install
 *     again?").
 *
 * Port shape: the coordinator depends on a `ChatAnnouncer` interface
 * rather than the chat plugin directly so:
 *   - The host can wire any chat-platform implementation (Slack today,
 *     Teams / Discord / etc tomorrow) without dragging the coordinator
 *     into the plugin closure.
 *   - Unit tests can pass an in-memory stub instead of standing up the
 *     full chat-plugin bridge.
 *
 * Failure policy: posting is best-effort. If the announcer rejects, the
 * coordinator returns `{ posted: false, reason }` and leaves the DB
 * stamp NULL so a later retry (next admin save, scheduled retry, etc)
 * can re-attempt. The route layer treats the announcement as a
 * non-blocking side-effect of the PUT — failing to announce never fails
 * the API call.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("proactive-announcement-coordinator");

// ---------------------------------------------------------------------------
// Port / dependency shapes
// ---------------------------------------------------------------------------

/**
 * Minimal contract the coordinator needs from the chat plugin to post
 * one channel message. The real implementation in the chat plugin
 * fans this out to `adapter.postChannelMessage(channelId, ...)`; tests
 * can pass a noop stub.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` so the
 * coordinator can decide whether to stamp the DB. We avoid raising —
 * announcer implementations are responsible for translating their
 * platform errors into a structured "no" because the coordinator must
 * never crash the admin-config save path.
 */
export interface ChatAnnouncer {
  postChannelAnnouncement(input: {
    /** Atlas workspace id (== org id) — surfaces in audit / logs. */
    workspaceId: string;
    /** Platform channel id (Slack `C…`, Teams `19:…`, etc). */
    channelId: string;
    /** Markdown body. Pre-rendered by `buildAnnouncementMessage`. */
    markdown: string;
  }): Promise<{ ok: true; messageId?: string } | { ok: false; reason: string }>;
}

/** Result returned to the admin route layer. */
export type AnnouncementOutcome =
  | { posted: true; messageId?: string }
  | { posted: false; reason: string };

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Render the one-shot activation message. Pure — exported so the unit
 * test pins the wording without booting the coordinator. Plain-markdown
 * for now; cards (Slack Block Kit / Teams Adaptive Cards) land in a
 * follow-up slice when we want per-platform rich rendering.
 *
 * The copy intentionally:
 *   - Names the behaviour ("Atlas now answers data questions…") instead
 *     of just "proactive mode is on" — non-admin end users don't share
 *     our jargon.
 *   - Mentions the privacy posture ("only reads messages in channels
 *     you opt in") so users see the consent story at the point of
 *     contact, not just in the admin console.
 *   - Tells users how to opt out so we never look like we're hiding
 *     the off switch.
 */
export function buildAnnouncementMessage(): string {
  return [
    "*Atlas can now help answer data questions in this workspace.*",
    "",
    "When a teammate asks a data question in a channel an admin has",
    "opted into proactive mode, Atlas may offer to look it up. Atlas",
    "only reads messages in channels that have been explicitly opted",
    "in by an admin — it does not monitor the whole workspace.",
    "",
    "To opt yourself out of proactive answers, DM Atlas with",
    "`unsubscribe`. Channel admins can pause proactive mode in a",
    "channel for 24 hours with `@atlas pause`.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface AnnounceActivationInput {
  workspaceId: string;
  /** Channel id from `workspace_proactive_config.announcement_channel_id`. */
  channelId: string;
  /** Host-provided port. Pass an in-memory stub from tests. */
  announcer: ChatAnnouncer;
}

/**
 * Post the activation announcement if (and only if) it has never been
 * posted for this workspace.
 *
 * Race safety: the stamp is **claimed atomically BEFORE the post**.
 * Concurrent admin enable flips race on a single conditional UPDATE
 * (`SET announcement_posted_at = NOW() WHERE announcement_posted_at
 * IS NULL`); Postgres serialises the writes and exactly one UPDATE
 * affects a row. The winner proceeds to post the announcement; the
 * losers see `rowCount = 0` and return `already_posted` without
 * calling the announcer. This guarantees at-most-one post per
 * workspace under any concurrency, at the cost of: if the announcer
 * call fails after the stamp is taken, we treat the announcement as
 * delivered (no retry). That trade is correct here — `chat.post` is
 * the cheap side and double-announcing erodes end-user trust more
 * than silently dropping a single failed post; admins can re-trigger
 * via a follow-up "Resend announcement" affordance if needed.
 */
export async function announceActivation(
  input: AnnounceActivationInput,
): Promise<AnnouncementOutcome> {
  const { workspaceId, channelId, announcer } = input;

  if (!hasInternalDB()) {
    log.debug(
      { workspaceId },
      "Skipping activation announcement — no internal DB configured",
    );
    return { posted: false, reason: "no_internal_db" };
  }

  // Atomic claim — conditional UPDATE returning the row id when the
  // claim succeeds. Postgres serialises racing UPDATEs; exactly one
  // racer flips the row from NULL to NOW(). Losers (and re-enables
  // after the first announcement) see zero rows back and short-circuit
  // before the announcer runs.
  let claimedRows: { id: unknown }[];
  try {
    claimedRows = await internalQuery<{ id: unknown }>(
      `UPDATE workspace_proactive_config
          SET announcement_posted_at = NOW(),
              updated_at = NOW()
        WHERE workspace_id = $1
          AND announcement_posted_at IS NULL
        RETURNING workspace_id AS id`,
      [workspaceId],
    );
  } catch (err) {
    log.warn(
      {
        workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Activation announcement claim UPDATE failed — leaving stamp NULL for retry",
    );
    return {
      posted: false,
      reason: `claim_update_failed:${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (claimedRows.length === 0) {
    // Either no config row exists (admin flipped enable without going
    // through the materialise step) or the row is already stamped.
    // Distinguish for the caller: an admin debugging "why didn't the
    // announcement fire?" benefits from the difference.
    const probe = await internalQuery<{ announcement_posted_at: Date | null }>(
      `SELECT announcement_posted_at
         FROM workspace_proactive_config
        WHERE workspace_id = $1`,
      [workspaceId],
    );
    if (probe.length === 0) {
      return { posted: false, reason: "no_config_row" };
    }
    return { posted: false, reason: "already_posted" };
  }

  const markdown = buildAnnouncementMessage();
  let announceResult: Awaited<ReturnType<ChatAnnouncer["postChannelAnnouncement"]>>;
  try {
    announceResult = await announcer.postChannelAnnouncement({
      workspaceId,
      channelId,
      markdown,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The stamp is already taken — we cannot retry without a manual
    // admin-driven reset. Logged at warn so on-call sees the failure.
    log.warn(
      { workspaceId, channelId, err: message },
      "Activation announcement post threw AFTER stamp was claimed — announcement will not retry without admin reset",
    );
    return { posted: false, reason: `announcer_threw:${message}` };
  }

  if (!announceResult.ok) {
    log.warn(
      { workspaceId, channelId, reason: announceResult.reason },
      "Activation announcement post rejected AFTER stamp was claimed — announcement will not retry without admin reset",
    );
    return { posted: false, reason: announceResult.reason };
  }

  log.info(
    { workspaceId, channelId, messageId: announceResult.messageId ?? null },
    "Proactive activation announcement posted",
  );
  return { posted: true, messageId: announceResult.messageId };
}

/**
 * No-op announcer for tests / dev when no chat plugin is wired. The
 * route layer falls back to this when the host hasn't registered a
 * real announcer so a stray enable flip doesn't 500.
 */
export const NULL_ANNOUNCER: ChatAnnouncer = {
  async postChannelAnnouncement() {
    return { ok: false, reason: "no_announcer_configured" };
  },
};
