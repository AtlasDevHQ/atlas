/**
 * Pure interjection policy for proactive chat.
 *
 * Given a classification result + the channel/workspace config + recent
 * activity, returns whether Atlas should react, answer, or stay silent.
 *
 * Slice #2292 narrows the action to `react | skip` — the reply path
 * arrives in #2293. Sensitivity → confidence-threshold mapping lives
 * here so policy decisions stay testable as a single truth table.
 */

import type {
  ClassificationResult,
  ChannelProactiveConfig,
  InterjectionDecision,
  RecentActivity,
  SensitivityPreset,
  WorkspaceProactiveConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Confidence thresholds per sensitivity preset.
 *
 * - cautious: only interject when the classifier is very sure (≥ 0.85)
 * - balanced: default (≥ 0.70)
 * - eager:    catch borderline cases too (≥ 0.55)
 *
 * Values chosen to feel right at MVP; tune from design-partner data
 * before any broader rollout (see PRD §Stability bar).
 */
export const SENSITIVITY_THRESHOLDS: Record<SensitivityPreset, number> = {
  cautious: 0.85,
  balanced: 0.7,
  eager: 0.55,
};

/**
 * Minimum gap between interjections in the same channel (ms).
 *
 * Rate limit applied even when the policy would otherwise react — keeps
 * Atlas from spamming a chatty channel. 60s feels low-impact at MVP;
 * the admin-console rollup PR will surface this as a tunable.
 */
export const RECENT_INTERJECTION_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// decideInterjection
// ---------------------------------------------------------------------------

export interface DecideInterjectionInput {
  classification: ClassificationResult;
  workspace: WorkspaceProactiveConfig;
  /** Per-channel override. Absent => defaults to allowed at workspace level. */
  channel?: ChannelProactiveConfig;
  /** Whether the channel is on the allowlist for this slice. */
  channelAllowed: boolean;
  /** Recent-activity sample for rate limiting. */
  recentActivity?: RecentActivity;
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number;
}

/**
 * Decide whether to react, answer, or skip.
 *
 * Pure function — all I/O happens outside. Truth-table tested against
 * the cartesian product of (confidence × channel × workspace × recent
 * activity) in `__tests__/policy.test.ts`.
 *
 * For slice #2292 the only positive action is `react` — the answer
 * path lands in #2293 and will widen the return type.
 */
export function decideInterjection(input: DecideInterjectionInput): InterjectionDecision {
  const {
    classification,
    workspace,
    channel,
    channelAllowed,
    recentActivity,
    now = Date.now,
  } = input;

  if (!workspace.enabled) {
    return { action: "skip", reason: "workspace-disabled" };
  }
  if (!channelAllowed) {
    return { action: "skip", reason: "channel-not-allowed" };
  }
  if (channel && channel.allow === false) {
    return { action: "skip", reason: "channel-denied" };
  }
  if (!classification.isQuestion) {
    return { action: "skip", reason: "not-a-question" };
  }

  const effectiveSensitivity: SensitivityPreset =
    channel?.sensitivity ?? workspace.sensitivity;
  const threshold = SENSITIVITY_THRESHOLDS[effectiveSensitivity];
  if (classification.confidence < threshold) {
    return { action: "skip", reason: "below-confidence-threshold" };
  }

  if (recentActivity?.lastInterjectionAt != null) {
    const elapsed = now() - recentActivity.lastInterjectionAt;
    if (elapsed < RECENT_INTERJECTION_COOLDOWN_MS) {
      return { action: "skip", reason: "rate-limited" };
    }
  }

  return { action: "react", reason: "passes-threshold" };
}
