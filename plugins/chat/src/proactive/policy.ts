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
 * Lower threshold ⇒ more interjections. The classifier returns a
 * confidence in `[0, 1]`; this table is the only place those numbers
 * become product-visible behaviour, so any tuning happens here.
 *
 * - cautious  (≥ 0.85) — only obvious data questions ("what was MRR
 *                        last month?"). Designed for `#general`-style
 *                        channels where additive noise costs more than
 *                        the missed answer.
 * - balanced  (≥ 0.70) — workspace default; most reasonable data
 *                        questions pass, soft-mention "any idea on
 *                        signups?" passes when the classifier is
 *                        fairly sure.
 * - eager     (≥ 0.55) — catches loose mentions of metrics ("curious
 *                        about churn this week"). Intended for
 *                        dedicated `#ask-data`-style channels where
 *                        the social cost of an Atlas reaction is low.
 *
 * Rationale for the specific MVP values:
 *
 *  - The gap between presets (≈0.15) is wide enough that flipping a
 *    channel from balanced→eager produces a visible behavioural change
 *    (per User story 5 in PRD #2291 — "switch from Balanced to Eager
 *    and observe more interjections").
 *  - 0.85 leaves enough headroom below `1.0` that the cautious preset
 *    still fires on real questions; we don't want it to behave like an
 *    off switch.
 *  - 0.55 is the lowest we're willing to go pre-stability-bar — below
 *    that the classifier's signal-to-noise gets dominated by the LLM's
 *    own miscalibration rather than by question quality.
 *
 * Per PRD #2291 §Stability bar, these values are MVP placeholders.
 * Tune from design-partner data (misfire rate + acceptance rate
 * captured by #2298 / `proactive_meter_events`) before any broader
 * rollout — do not relax `eager` below 0.55 or tighten `cautious`
 * above 0.95 without explicit acceptance-rate evidence. The
 * `sensitivity-presets.test.ts` acceptance suite pins the values
 * documented here, so a tuning PR must update both.
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
