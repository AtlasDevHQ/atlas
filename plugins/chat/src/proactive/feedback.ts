/**
 * Feedback collector for proactive chat (slice #2298).
 *
 * Three inline-button outcomes — Helpful, Not helpful, Wrong data — are
 * attached to every proactive answer (slice #2293). `Wrong data` opens
 * a small text modal so the user can attach context. The slash
 * subcommand `/atlas feedback <text>` covers the freeform path when
 * the user wants to add context without a specific Atlas answer to
 * react to.
 *
 * Inline buttons beat native chat reactions because there's no emoji
 * hunt — the user clicks the verb that matches what they think.
 */

import type { ProactiveAsker } from "./answerer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome a feedback event records. */
export type FeedbackOutcome = "helpful" | "not-helpful" | "wrong-data";

/** Source surface the feedback originated from. */
export type FeedbackSource = "button" | "modal" | "slash-command";

/** Event handed to the host-supplied collector. */
export interface ProactiveFeedbackEvent {
  /** Thread the original Atlas answer was posted in. */
  threadId: string;
  /**
   * Atlas-answer message ID this feedback is about. Empty string for
   * `/atlas feedback <text>` when the user did not quote a specific
   * answer — the host should fall back to the most recent Atlas
   * answer in the channel by the same user.
   */
  answerMessageId: string;
  /** The chat-platform user who gave feedback. */
  asker: ProactiveAsker;
  /** What the user said. */
  outcome: FeedbackOutcome;
  /** Optional freeform context (modal textarea, slash command argument). */
  context?: string;
  /** Which surface generated this event. */
  source: FeedbackSource;
}

/**
 * Host-supplied persistence callback.
 *
 * Implementations should never throw — failures should resolve so the
 * user still gets a "Thanks" reply.
 */
export type FeedbackCollectorFn = (event: ProactiveFeedbackEvent) => Promise<void>;

// ---------------------------------------------------------------------------
// Action IDs (button + modal + slash)
// ---------------------------------------------------------------------------

export const PROACTIVE_FB_HELPFUL_ACTION_ID = "atlas_proactive_fb_helpful";
export const PROACTIVE_FB_NOT_HELPFUL_ACTION_ID = "atlas_proactive_fb_not_helpful";
export const PROACTIVE_FB_WRONG_DATA_ACTION_ID = "atlas_proactive_fb_wrong_data";

/** Maps a button action ID to the feedback outcome. */
const ACTION_TO_OUTCOME: Record<string, FeedbackOutcome> = {
  [PROACTIVE_FB_HELPFUL_ACTION_ID]: "helpful",
  [PROACTIVE_FB_NOT_HELPFUL_ACTION_ID]: "not-helpful",
  [PROACTIVE_FB_WRONG_DATA_ACTION_ID]: "wrong-data",
};

/** Slack modal callback id for the wrong-data textarea modal. */
export const PROACTIVE_FB_WRONG_DATA_MODAL_ID = "atlas_proactive_fb_wrong_data_modal";

/** Text input id inside the wrong-data modal. */
export const PROACTIVE_FB_WRONG_DATA_INPUT_ID = "atlas_proactive_fb_wrong_data_input";

/** Returns the feedback outcome for a button action id, or `null`. */
export function outcomeForActionId(actionId: string): FeedbackOutcome | null {
  return ACTION_TO_OUTCOME[actionId] ?? null;
}

// ---------------------------------------------------------------------------
// Slash command parser
// ---------------------------------------------------------------------------

/** Result of parsing `/atlas <args>` for a feedback subcommand. */
export type FeedbackSlashParse =
  | { kind: "feedback"; text: string }
  | { kind: "not-feedback" };

/**
 * Detect a `/atlas feedback <text>` invocation.
 *
 * The Chat SDK delivers the slash command as `command="/atlas"` and
 * `args="feedback ..."`. We accept the `feedback` keyword (case
 * insensitive) optionally followed by `:` or whitespace, then capture
 * the rest as the freeform context. Pure function.
 */
export function parseFeedbackSlashArgs(args: string | undefined | null): FeedbackSlashParse {
  if (typeof args !== "string") return { kind: "not-feedback" };
  const trimmed = args.trim();
  if (trimmed.length === 0) return { kind: "not-feedback" };
  const match = trimmed.match(/^feedback(?:\s*[:-]\s*|\s+)(.+)$/i);
  if (!match) {
    // `/atlas feedback` alone (no body) still counts as a feedback
    // invocation — host may want to prompt for text. We surface this
    // as a feedback parse with empty text so the listener can choose
    // to open a modal or post a hint.
    if (/^feedback\s*$/i.test(trimmed)) return { kind: "feedback", text: "" };
    return { kind: "not-feedback" };
  }
  return { kind: "feedback", text: match[1].trim() };
}

// ---------------------------------------------------------------------------
// Recent-answer registry (for `/atlas feedback <text>` fallback)
// ---------------------------------------------------------------------------

/**
 * Atlas's most recent proactive answer to a given user in a channel.
 *
 * `/atlas feedback <text>` without a quoted message falls back to this
 * entry so the user doesn't have to identify the answer manually.
 */
export interface RecentAnswerEntry {
  threadId: string;
  /** ID of the Atlas message containing the answer. */
  answerMessageId: string;
  /** Original question text — surfaced to the host for context. */
  question: string;
  /** Answer body — surfaced to the host for context. */
  answer: string;
  /** Epoch ms when recorded. */
  recordedAt: number;
}

/** TTL after which a recent-answer entry is forgotten. */
export const RECENT_ANSWER_TTL_MS = 24 * 60 * 60 * 1000;

/** Hard cap on the recent-answer map. Oldest evicts on overflow. */
export const RECENT_ANSWER_MAX_ENTRIES = 10_000;

/**
 * In-memory map: (channelId, userId) → most recent Atlas answer.
 *
 * Single-process, mirroring `PendingAnswers`. The pattern is
 * intentional — slice #2296's persistent meter will replace both maps
 * with PG-backed storage; until then in-memory is fine for Slack-first
 * MVP scale.
 */
export class RecentAnswers {
  private readonly store = new Map<string, RecentAnswerEntry>();

  constructor(
    private readonly ttlMs: number = RECENT_ANSWER_TTL_MS,
    private readonly maxEntries: number = RECENT_ANSWER_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  /** Build the key. */
  static key(channelId: string, userId: string): string {
    return `${channelId}:${userId}`;
  }

  /** Record a new answer. Evicts oldest when at capacity. */
  record(channelId: string, userId: string, entry: Omit<RecentAnswerEntry, "recordedAt">): void {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(RecentAnswers.key(channelId, userId), {
      ...entry,
      recordedAt: this.now(),
    });
  }

  /** Look up the latest answer; returns null on miss or expiry. */
  lookup(channelId: string, userId: string): RecentAnswerEntry | null {
    const entry = this.store.get(RecentAnswers.key(channelId, userId));
    if (!entry) return null;
    if (this.now() - entry.recordedAt > this.ttlMs) return null;
    return entry;
  }

  /** Current size for tests / diagnostics. */
  size(): number {
    return this.store.size;
  }
}
