/**
 * Pure pause-detection helpers for the proactive listener (#2295).
 *
 * The listener consults the host for `isPaused` (DB-backed) and writes
 * pauses via `onPauseRequest`. Both are injected as callbacks so the
 * plugin never imports from `@atlas/api`.
 *
 * `detectPauseCommand` and `detectUnsubscribeDM` are pure string helpers
 * tested in isolation so the listener test stays small.
 */
import type {
  ChannelPauseLayer,
  OnPauseRequestFn,
  PauseLayer,
} from "./types";

// ---------------------------------------------------------------------------
// 24h pause shorthand
// ---------------------------------------------------------------------------

/** Duration of an in-channel `@atlas pause` row (24h, in ms). */
export const CHANNEL_PAUSE_DURATION_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Command detection
// ---------------------------------------------------------------------------

/**
 * Detect an in-channel "@atlas pause" command.
 *
 * Recognises any text that mentions Atlas (in plain prose or as a
 * platform mention token) immediately followed by the word `pause`.
 * Case-insensitive; tolerates surrounding punctuation.
 *
 * Examples that match:
 *   - "@atlas pause"
 *   - "Hey @atlas, pause this channel for a bit"
 *   - "<@U123|atlas> pause"
 *   - "atlas pause please"
 *
 * Examples that do NOT match:
 *   - "pause" alone (would silence Atlas in any channel mentioning the word)
 *   - "@atlas reset" (different verb)
 */
export function detectPauseCommand(text: string): boolean {
  if (!text) return false;
  const normalised = text.trim().toLowerCase();
  if (normalised.length === 0) return false;
  // Bound the inspection window. Chat platforms cap a single message
  // around the kilobyte range; capping here defeats any ReDoS attempt
  // built around long pathological inputs. Real `@atlas pause`
  // commands sit well inside this window.
  const window = normalised.length > 4096 ? normalised.slice(0, 4096) : normalised;
  // Two independent forms, tested with separate regexes so neither
  // alternation backtracks into the other:
  //   1. plain-prose `atlas` / `@atlas` (with word boundary) followed
  //      by punctuation + `pause`
  //   2. Slack-style platform mention `<@U…|atlas>` followed by
  //      punctuation + `pause`. The mention body is bounded to 64
  //      chars to keep the matcher linear (CodeQL js/polynomial-redos).
  return (
    /(?:^|[^a-z0-9])@?atlas\b[\s,!:;.-]{0,4}pause\b/.test(window) ||
    /<@[a-z0-9_-]{1,64}\|atlas>[\s,!:;.-]{0,4}pause\b/.test(window)
  );
}

/**
 * Detect a DM `unsubscribe` command.
 *
 * The DM unsubscribe path is intentionally strict: only the literal
 * word "unsubscribe" (with optional whitespace + trailing punctuation)
 * qualifies. A user typing `"How do I unsubscribe?"` is a question,
 * not a command — keep it unambiguous so the agent answers the
 * question rather than silencing itself.
 */
export function detectUnsubscribeDM(text: string): boolean {
  if (!text) return false;
  return /^[\s]*unsubscribe[\s.!?]*$/i.test(text);
}

// ---------------------------------------------------------------------------
// Layer types used by the listener
// ---------------------------------------------------------------------------

/**
 * Decision returned by the host's `isPaused` callback.
 *
 * Listener uses this *before* classification so it pays the LLM cost
 * only on messages that survive the kill switch.
 */
export interface PauseDecision {
  paused: boolean;
  /** Epoch ms when the pause expires; absent on indefinite pauses. */
  until?: number;
  /** Which layer is keeping Atlas silent — surfaces in logs + audit. */
  layer?: PauseLayer;
}

/**
 * Host-supplied callback that reads `proactive_pauses`.
 *
 * Resolves to `{ paused: false }` when no row matches. Resolves to
 * `{ paused: true, layer, until? }` for the highest-precedence matching
 * row (workspace-kill > admin-channel > user-optout > channel-24h).
 *
 * Implementations MUST fail CLOSED on registry errors — return
 * `{ paused: true, layer: "workspace-kill" }` (or rethrow; the listener
 * catches and silences). The kill switch's product contract is
 * "deliver silence when an admin or user asked for it"; a fail-open
 * posture on DB blip defeats all four layers at once.
 */
export type IsPausedFn = (input: {
  workspaceId: string;
  channelId: string;
  userId?: string;
}) => Promise<PauseDecision>;

// ---------------------------------------------------------------------------
// Pause-command wiring
// ---------------------------------------------------------------------------

/**
 * Resolve the layer + duration for a detected pause command.
 *
 * In-channel `@atlas pause` → `channel-24h` for 24h.
 * DM `unsubscribe`         → `user-optout`, indefinite.
 *
 * The listener calls the host's `onPauseRequest` with the resolved
 * shape; the host writes the row. The plugin doesn't talk to the DB.
 */
export function resolvePauseRequest(
  trigger: "channel-pause-command" | "dm-unsubscribe",
  input: {
    workspaceId: string;
    channelId: string;
    userId: string;
    now?: () => number;
  },
): Parameters<OnPauseRequestFn>[0] {
  const now = input.now ?? Date.now;
  if (trigger === "channel-pause-command") {
    return {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      userId: input.userId,
      layer: "channel-24h" satisfies ChannelPauseLayer,
      durationMs: CHANNEL_PAUSE_DURATION_MS,
      requestedAt: now(),
    };
  }
  return {
    workspaceId: input.workspaceId,
    channelId: null,
    userId: input.userId,
    layer: "user-optout",
    durationMs: null,
    requestedAt: now(),
  };
}
