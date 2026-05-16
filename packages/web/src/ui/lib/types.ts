/**
 * Shared types for Atlas UI.
 *
 * All types are canonical from @useatlas/types — no local duplication.
 */

import type { ShareMode } from "@useatlas/types";

export { AUTH_MODES, ATLAS_MODES, ADMIN_ROLES, DB_TYPES } from "@useatlas/types";
export type {
  AdminRole,
  AtlasMode,
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
  ConnectionGroup,
  ConnectionGroupMember,
  ConnectionStatus,
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
  LearnedPatternType,
  AmendmentPayload,
  AmendmentType,
  PromptCollection,
  PromptCollectionStatus,
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
  GatewayCatalogModel,
  GatewayCatalogResponse,
  ByotCatalogRefreshSkipReason,
  ByotRefreshCycleResult,
} from "@useatlas/types";
export type {
  ApprovalRule,
  ApprovalRuleType,
  ApprovalRuleSurface,
  ApprovalRequest,
  ApprovalRequestSurface,
  ApprovalStatus,
} from "@useatlas/types";
export { APPROVAL_RULE_SURFACES, APPROVAL_REQUEST_SURFACES } from "@useatlas/types";
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
  DeployMode,
  DeployModeSetting,
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
export type {
  AbuseLevel,
  AbuseTrigger,
  AbuseEvent,
  AbuseStatus,
  AbuseThresholdConfig,
  AbuseCounters,
  AbuseInstance,
  AbuseDetail,
  AbuseEventsStatus,
} from "@useatlas/types";
export type { Percentage, Ratio } from "@useatlas/types";
export type {
  WorkspaceSLASummary,
  SLAMetricPoint,
  WorkspaceSLADetail,
  SLAAlertStatus,
  SLAAlertType,
  SLAAlert,
  SLAThresholds,
} from "@useatlas/types";
export type {
  BackupEntry,
  BackupStatus,
  BackupConfig,
} from "@useatlas/types";
export type {
  Region,
  RegionConfig,
  RegionPickerItem,
  WorkspaceRegion,
  RegionStatus,
  MigrationStatus,
  RegionMigration,
} from "@useatlas/types";
export { MIGRATION_STATUSES } from "@useatlas/types";
export type {
  CustomDomain,
  DomainStatus,
  CertificateStatus,
} from "@useatlas/types";
export type {
  Dashboard,
  DashboardCard,
  DashboardCardLayout,
  DashboardWithCards,
  DashboardChartConfig,
  DashboardSuggestion,
  ChartType,
  ProposedCard,
  ProposedDashboardSpec,
  ProposedCardValidationError,
  ProposeDashboardResult,
  PreviewCardResponse,
} from "@useatlas/types";
export { CHART_TYPES } from "@useatlas/types";
export { DOMAIN_STATUSES, CERTIFICATE_STATUSES } from "@useatlas/types";
export { BACKUP_STATUSES } from "@useatlas/types";
export { WELL_KNOWN_REGIONS } from "@useatlas/types";
export { ABUSE_LEVELS, ABUSE_TRIGGERS } from "@useatlas/types";
export { SLA_ALERT_STATUSES, SLA_ALERT_TYPES } from "@useatlas/types";
export { ONBOARDING_EMAIL_STEPS, ONBOARDING_MILESTONES } from "@useatlas/types";
export { PII_CATEGORIES, MASKING_STRATEGIES, PII_CONFIDENCE_LEVELS, COMPLIANCE_REPORT_TYPES } from "@useatlas/types";
export { SHARE_EXPIRY_OPTIONS, PROMPT_INDUSTRIES, PROMPT_COLLECTION_STATUSES, MODEL_CONFIG_PROVIDERS, APPROVAL_RULE_TYPES, APPROVAL_STATUSES, WORKSPACE_STATUSES, PLAN_TIERS, NOISY_NEIGHBOR_METRICS, CONNECTION_STATUSES } from "@useatlas/types";
export { parseChatError } from "@useatlas/types/errors";

// --- Web-only types (not in @useatlas/types) ---

export type ShareStatus =
  | { shared: false }
  | { shared: true; token: string; url: string; expiresAt: string | null; shareMode: ShareMode };

/**
 * Wire shape of `GET /api/v1/me/connection-groups` (#2422). Mirrored
 * here — not bumped into `@useatlas/types` — because there's no
 * cross-package consumer yet (web is the only caller). If the SDK or
 * another package starts consuming this, promote the type to
 * `@useatlas/types` and re-export it via this file. See CLAUDE.md
 * "Frontend is a pure HTTP client".
 */
export type MeConnectionGroupsEmptyReason = "no_active_org" | "no_internal_db";
