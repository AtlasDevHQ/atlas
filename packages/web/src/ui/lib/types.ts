/**
 * Shared types for Atlas UI.
 *
 * All types are canonical from @useatlas/types — no local duplication.
 */

import type { ShareMode } from "@useatlas/types";

export { AUTH_MODES, DB_TYPES } from "@useatlas/types";
export type {
  AuthMode,
  Conversation,
  Message,
  ConversationWithMessages,
  NotebookStateWire,
  ForkBranchWire,
  ShareMode,
  ShareExpiryKey,
  DeliveryChannel,
  ScheduledTask,
  ScheduledTaskWithRuns,
  ScheduledTaskRunWithTaskName,
  ConnectionHealth,
  ConnectionInfo,
  ConnectionDetail,
  PoolMetrics,
  ChatErrorCode,
  ChatErrorInfo,
  ClientErrorCode,
  Dimension,
  Join,
  Measure,
  QueryPattern,
  SemanticEntitySummary,
  SemanticEntityDetail,
  EntityData,
  ActionApprovalMode,
  ActionLogEntry,
  SemanticDiffResponse,
  SemanticTableDiff,
  LearnedPattern,
  LearnedPatternStatus,
  LearnedPatternSource,
  PromptCollection,
  PromptItem,
  PromptIndustry,
  QuerySuggestion,
  ObjectType,
  WizardEntityColumn,
  WizardEntityResult,
  WizardForeignKey,
  WizardInferredForeignKey,
  WizardTableEntry,
} from "@useatlas/types";
export type {
  ModelConfigProvider,
  WorkspaceModelConfig,
  TestModelConfigResponse,
} from "@useatlas/types";
export type {
  ApprovalRule,
  ApprovalRuleType,
  ApprovalRequest,
  ApprovalStatus,
} from "@useatlas/types";
export type {
  PIICategory,
  PIIConfidence,
  MaskingStrategy,
  PIIColumnClassification,
  UpdatePIIClassificationRequest,
  ComplianceReportType,
  ComplianceReportFilters,
  DataAccessRow,
  DataAccessReport,
  UserActivityRow,
  UserActivityReport,
} from "@useatlas/types";
export type {
  PlatformWorkspace,
  PlatformWorkspaceDetail,
  PlatformWorkspaceUser,
  PlatformStats,
  NoisyNeighbor,
  NoisyNeighborMetric,
  WorkspaceStatus,
  PlanTier,
} from "@useatlas/types";
export type {
  WorkspaceBranding,
  WorkspaceBrandingPublic,
  SetWorkspaceBrandingInput,
} from "@useatlas/types";
export type {
  OnboardingEmailStep,
  OnboardingMilestone,
  OnboardingEmailTrigger,
  OnboardingEmailRecord,
  OnboardingEmailStatus,
  OnboardingEmailPreferences,
} from "@useatlas/types";
export { ONBOARDING_EMAIL_STEPS, ONBOARDING_MILESTONES } from "@useatlas/types";
export { PII_CATEGORIES, MASKING_STRATEGIES, PII_CONFIDENCE_LEVELS, COMPLIANCE_REPORT_TYPES } from "@useatlas/types";
export { SHARE_EXPIRY_OPTIONS, PROMPT_INDUSTRIES, MODEL_CONFIG_PROVIDERS, APPROVAL_RULE_TYPES, APPROVAL_STATUSES, WORKSPACE_STATUSES, PLAN_TIERS, NOISY_NEIGHBOR_METRICS } from "@useatlas/types";
export { parseChatError } from "@useatlas/types/errors";

// --- Web-only types (not in @useatlas/types) ---

export type ShareStatus =
  | { shared: false }
  | { shared: true; token: string; url: string; expiresAt: string | null; shareMode: ShareMode };
