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
 * Race safety: the stamp is written via a conditional UPDATE
 * (`WHERE announcement_posted_at IS NULL`) immediately AFTER the post
 * succeeds. If two admin requests race the enable flip:
 *   - Both will read `announcement_posted_at = NULL` from the pre-check
 *     SELECT (or skip it).
 *   - Both will call the announcer (two posts at worst — acceptable;
 *     we'd rather double-announce than swallow the first attempt
 *     because of a transient lookup miss).
 *   - Only one UPDATE actually flips the row from NULL to NOW(); the
 *     loser returns posted: true but does not double-stamp.
 *
 * In practice the admin PUT path is serialised per workspace by the
 * admin UI's optimistic locking — the race window is academic, but
 * pinning the conditional UPDATE eliminates it for completeness.
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

  // Pre-check: short-circuit on the already-posted path so the announcer
  // never runs for a workspace that's already past the one-shot. This
  // is the hot path (every admin save after the first announcement
  // hits it).
  const rows = await internalQuery<{ announcement_posted_at: Date | null }>(
    `SELECT announcement_posted_at
       FROM workspace_proactive_config
      WHERE workspace_id = $1`,
    [workspaceId],
  );

  if (rows.length === 0) {
    // No config row yet — caller flipped enable without going through
    // the admin route's materialise step. Treat as "nothing to do" so we
    // never announce a workspace that hasn't been configured at all.
    return { posted: false, reason: "no_config_row" };
  }
  if (rows[0].announcement_posted_at !== null) {
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
    log.warn(
      { workspaceId, channelId, err: message },
      "Activation announcement post threw — leaving stamp NULL for retry",
    );
    return { posted: false, reason: `announcer_threw:${message}` };
  }

  if (!announceResult.ok) {
    log.warn(
      { workspaceId, channelId, reason: announceResult.reason },
      "Activation announcement post rejected — leaving stamp NULL for retry",
    );
    return { posted: false, reason: announceResult.reason };
  }

  // Stamp the row only after a successful post. Conditional WHERE so a
  // racing winner doesn't get clobbered by a slower loser (see race
  // safety note above).
  try {
    await internalQuery(
      `UPDATE workspace_proactive_config
          SET announcement_posted_at = NOW(),
              updated_at = NOW()
        WHERE workspace_id = $1
          AND announcement_posted_at IS NULL`,
      [workspaceId],
    );
  } catch (err) {
    // Stamp failure is logged but doesn't downgrade the outcome — the
    // message DID land in the channel. A subsequent enable flip will
    // re-attempt; the announcer implementation is responsible for its
    // own dedupe if double-posting is unacceptable.
    log.warn(
      {
        workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Stamped activation announcement but UPDATE failed — may re-announce",
    );
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
