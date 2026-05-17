/**
 * Proactive chat layer — public exports.
 *
 * Slice #2292: reaction-first tracer. Subscribe → classify → react. No
 * reply yet. Later slices add the answer, kill switches, admin config,
 * meter, and feedback.
 */

export type {
  ChannelProactiveConfig,
  ClassificationResult,
  InterjectionAction,
  InterjectionDecision,
  LLMClassifierFn,
  ProactiveGateFn,
  RecentActivity,
  SensitivityPreset,
  WorkspaceProactiveConfig,
} from "./types";

export {
  classifyMessage,
  regexPreFilter,
  type ClassifyMessageOptions,
  type ClassifyMessageResult,
} from "./classifier";

export {
  decideInterjection,
  RECENT_INTERJECTION_COOLDOWN_MS,
  SENSITIVITY_THRESHOLDS,
  type DecideInterjectionInput,
} from "./policy";

export {
  PROACTIVE_REACTION,
  registerProactiveListener,
  resolveChannelAllowlist,
  type ProactiveListenerConfig,
} from "./listener";
