/**
 * Proactive chat layer — public exports.
 *
 * Slice #2292: reaction-first tracer (subscribe → classify → react).
 * Slice #2293: reaction-to-answer flow (the asker reacts back or
 * clicks the ephemeral "Yes, answer" card → Atlas posts the answer).
 * Later slices add kill switches, admin config, meter, and feedback.
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

export {
  PendingAnswers,
  PENDING_ANSWER_MAX_ENTRIES,
  PENDING_ANSWER_TTL_MS,
  shouldAnswerOnReaction,
  type PendingAnswerEntry,
  type ProactiveAsker,
  type ProactiveExecuteQuery,
  type ProactiveQueryResult,
  type ProactiveUserResolver,
  type ReactionAnswerDecision,
  type ResolvedAsker,
  type ShouldAnswerOnReactionInput,
} from "./answerer";

export {
  PROACTIVE_ANSWER_ACTION_ID,
  PROACTIVE_DISMISS_ACTION_ID,
  buildProactiveAnswerCard,
  buildProactiveOfferCard,
  buildUnlinkedAskerPrompt,
} from "../cards/proactive-answer-card";
