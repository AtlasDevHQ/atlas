/**
 * Shared types for the proactive chat layer.
 *
 * Proactive mode lets Atlas listen to channel messages in opted-in
 * channels, classify them as answerable data questions, and react /
 * eventually answer without an explicit `@atlas` mention. This module
 * holds only the pure shapes — see `classifier.ts`, `policy.ts`, and
 * `listener.ts` for behaviour.
 *
 * Slice #2292 ships the reaction-first tracer: subscribe → classify →
 * react. Later slices add the reply, kill switches, admin config,
 * meter, and feedback.
 */

/** Result of running a message through the question classifier. */
export interface ClassificationResult {
  /** Whether the message looks like an answerable data question. */
  isQuestion: boolean;
  /** Confidence in [0, 1] — 1.0 = certain, 0.0 = certainly not. */
  confidence: number;
  /** Optional short reason from the LLM, useful for audit + tuning. */
  reasoning?: string;
}

/** Three-tier sensitivity preset. Maps to a confidence threshold in policy. */
export type SensitivityPreset = "cautious" | "balanced" | "eager";

/** Workspace-level proactive settings. */
export interface WorkspaceProactiveConfig {
  /** Master toggle. When false, the listener never reacts. */
  enabled: boolean;
  /** Confidence-threshold preset. */
  sensitivity: SensitivityPreset;
  /** Classifier mode. */
  classifierMode: "regex-prefilter" | "classify-all";
}

/** Per-channel override. Absent fields fall back to workspace defaults. */
export interface ChannelProactiveConfig {
  channelId: string;
  /** When false, the channel is denied (Atlas never interjects). */
  allow: boolean;
  /** Optional sensitivity override. */
  sensitivity?: SensitivityPreset;
}

/** Recent interjection activity used for rate limiting. */
export interface RecentActivity {
  /** Epoch ms of the most recent interjection in this channel, if any. */
  lastInterjectionAt?: number;
}

/** Action returned by `decideInterjection`. */
export type InterjectionAction = "react" | "skip";

/** Decision returned by `decideInterjection`. */
export interface InterjectionDecision {
  action: InterjectionAction;
  /** Short tag explaining why — used in audit + tests. */
  reason: string;
}

/**
 * LLM classifier function injected from the host.
 *
 * Keeps the plugin decoupled from the API package and from any specific
 * model wiring. The host passes a function that runs the workspace's
 * configured Atlas model against a question-detection prompt.
 *
 * Implementations should never throw — failures should resolve as
 * `{ isQuestion: false, confidence: 0 }` so the listener fails closed.
 */
export type LLMClassifierFn = (text: string) => Promise<ClassificationResult>;

/**
 * Gate callback injected from the host.
 *
 * Returns true when proactive mode is allowed for this workspace. The
 * host wires this to `isEnterpriseEnabled() && workspaceFlag` so the
 * plugin itself does not import `@atlas/ee`.
 */
export type ProactiveGateFn = () => boolean | Promise<boolean>;
