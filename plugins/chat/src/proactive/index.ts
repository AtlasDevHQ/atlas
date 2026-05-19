/**
 * Proactive chat layer — public exports.
 *
 * Slice #2292: reaction-first tracer (subscribe → classify → react).
 * Slice #2293: reaction-to-answer flow (the asker reacts back or
 * clicks the ephemeral "Yes, answer" card → Atlas posts the answer).
 * Later slices add kill switches, admin config, meter, and feedback.
 */

export type {
  ChannelPauseLayer,
  ChannelProactiveConfig,
  ClassificationResult,
  GetChannelConfigsFn,
  GetWorkspaceConfigFn,
  InterjectionAction,
  InterjectionDecision,
  LLMClassifierFn,
  OnPauseRequestFn,
  PauseLayer,
  ProactiveGateFn,
  RecentActivity,
  ResolveWorkspaceIdFn,
  SensitivityPreset,
  WorkspaceProactiveConfig,
} from "./types";

export {
  CHANNEL_PAUSE_DURATION_MS,
  detectPauseCommand,
  detectUnsubscribeDM,
  resolvePauseRequest,
  type IsPausedFn,
  type PauseDecision,
} from "./pause";

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
  type ProactiveUserResolverContext,
  type ReactionAnswerDecision,
  type ResolvedAsker,
  type ShouldAnswerOnReactionInput,
} from "./answerer";

// Identity brands + runtime chokepoints (#2641). Types live in
// `@useatlas/types/proactive`; the assert helpers + error class live in
// `./identity` and are re-exported here so hosts can pull both from a
// single `@useatlas/chat` import.
export {
  InvalidProactiveIdentityError,
  assertAtlasUserId,
  assertExternalUserId,
  assertWorkspaceId,
  type ProactiveIdentityField,
} from "./identity";
export type {
  AtlasUserId,
  ExternalUserId,
  WorkspaceId,
} from "@useatlas/types/proactive";

export {
  PROACTIVE_ANSWER_ACTION_ID,
  PROACTIVE_DISMISS_ACTION_ID,
  buildProactiveAnswerCard,
  buildProactiveOfferCard,
  buildUnlinkedAskerPrompt,
  buildWrongDataModal,
} from "../cards/proactive-answer-card";

export {
  PROACTIVE_FB_HELPFUL_ACTION_ID,
  PROACTIVE_FB_NOT_HELPFUL_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_ACTION_ID,
  PROACTIVE_FB_WRONG_DATA_INPUT_ID,
  PROACTIVE_FB_WRONG_DATA_MODAL_ID,
  RECENT_ANSWER_MAX_ENTRIES,
  RECENT_ANSWER_TTL_MS,
  RecentAnswers,
  outcomeForActionId,
  parseFeedbackSlashArgs,
  type FeedbackCollectorFn,
  type FeedbackOutcome,
  type FeedbackSlashParse,
  type FeedbackSource,
  type ProactiveFeedbackEvent,
  type RecentAnswerEntry,
} from "./feedback";
