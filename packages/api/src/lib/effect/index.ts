/**
 * Effect.ts foundation for Atlas.
 *
 * Re-exports tagged error types, the Hono bridge, and Effect services
 * so consumers can import from a single entry point:
 *
 * ```ts
 * import { runEffect, EmptyQueryError, ConnectionRegistry } from "@atlas/api/lib/effect";
 * ```
 */

export {
  // Utilities
  normalizeError,
  // SQL validation
  EmptyQueryError,
  ForbiddenPatternError,
  ParseError,
  WhitelistError,
  // Connection
  ConnectionNotFoundError,
  PoolExhaustedError,
  NoDatasourceError,
  // Query execution
  QueryTimeoutError,
  QueryExecutionError,
  // Rate limiting
  RateLimitExceededError,
  ConcurrencyLimitError,
  // RLS
  RLSError,
  // Enterprise
  EnterpriseError,
  EnterpriseGateError,
  ApprovalRequiredError,
  // Plugin
  PluginRejectedError,
  CustomValidatorError,
  // Action
  ActionTimeoutError,
  // Scheduler
  SchedulerTaskTimeoutError,
  SchedulerExecutionError,
  DeliveryError,
  // Union type
  type AtlasError,
  type AtlasErrorTag,
} from "./errors";

export { runEffect, runHandler, mapTaggedError, domainError, type DomainErrorMapping, type RunEffectOptions } from "./hono";

// Deploy-mode resolver (#2572 — slice 10/11 of #2017). Pure function;
// lives in core so `lib/config.ts:applyDeployMode` can call it without
// dynamic-importing `@atlas/ee/deploy-mode`. EE re-exports for back-compat.
export { resolveDeployMode } from "./deploy-mode";

// ── Effect Services (P4+) ───────────────────────────────────────────

export {
  ConnectionRegistry,
  ConnectionRegistryLive,
  makeConnectionRegistryLive,
  createTestLayer,
  type ConnectionRegistryShape,
  // Plugin Registry (P5)
  PluginRegistry,
  PluginRegistryLive,
  makePluginRegistryLive,
  makeWiredPluginRegistryLive,
  createPluginTestLayer,
  type PluginRegistryShape,
  type PluginWiringConfig,
  // Request + Auth Context (P8)
  RequestContext,
  makeRequestContextLayer,
  createRequestContextTestLayer,
  AuthContext,
  makeAuthContextLayer,
  createAuthContextTestLayer,
  type RequestContextShape,
  type AuthContextShape,
  // Enterprise subsystem Tags (#2563 slice 1/11 of #2017)
  ResidencyResolver,
  ModelRouter,
  MaskingPolicy,
  ComplianceReports,
  ApprovalGate,
  SlaMetrics,
  BackupsManager,
  AuditRetention,
  AuditPurgeScheduler,
  IpAllowlistPolicy,
  SSOPolicy,
  SCIMProvenance,
  RolesPolicy,
  Branding,
  Domains,
  ProactiveGate,
  DeployModeResolver,
  NoopResidencyResolverLayer,
  NoopModelRouterLayer,
  NoopMaskingPolicyLayer,
  NoopComplianceReportsLayer,
  NoopApprovalGateLayer,
  NoopSlaMetricsLayer,
  NoopBackupsManagerLayer,
  NoopAuditRetentionLayer,
  NoopAuditPurgeSchedulerLayer,
  NoopIpAllowlistPolicyLayer,
  NoopSSOPolicyLayer,
  NoopSCIMProvenanceLayer,
  NoopRolesPolicyLayer,
  NoopBrandingLayer,
  NoopDomainsLayer,
  NoopProactiveGateLayer,
  NoopDeployModeResolverLayer,
  NoopEnterpriseDefaultsLayer,
  type ResidencyResolverShape,
  type ModelRouterShape,
  type MaskingPolicyShape,
  type ComplianceReportsShape,
  type ApprovalGateShape,
  type SlaMetricsShape,
  type BackupsManagerShape,
  type AuditRetentionShape,
  type AuditPurgeSchedulerShape,
  type IpAllowlistPolicyShape,
  type SSOPolicyShape,
  type SCIMProvenanceShape,
  type RolesPolicyShape,
  type BrandingShape,
  type DomainsShape,
  type ProactiveGateShape,
  type DeployModeResolverShape,
} from "./services";

// ── Startup Layers (P6) ─────────────────────────────────────────────

export {
  Telemetry,
  TelemetryLive,
  Config,
  ConfigLive,
  Migration,
  MigrationLive,
  SemanticSync,
  SemanticSyncLive,
  Settings,
  SettingsLive,
  Scheduler,
  makeSchedulerLive,
  buildAppLayer,
  type TelemetryShape,
  type ConfigShape,
  type MigrationShape,
  type SemanticSyncShape,
  type SettingsShape,
  type SchedulerShape,
} from "./layers";

// ── AI Model Service (P10a) ─────────────────────────────────────────

export {
  AtlasAiModel,
  AtlasAiModelLive,
  makeWorkspaceAiModelLayer,
  createAiModelTestLayer,
  type AtlasAiModelShape,
} from "./ai";

// ── Toolkit Service (P10b) ──────────────────────────────────────────

export {
  AtlasToolkit,
  AtlasToolkitLive,
  makeAtlasToolkitLive,
  createToolkitTestLayer,
  type AtlasToolkitShape,
} from "./toolkit";

// ── SemanticGenerator Service (#3506 — MCP V2 Blocker #1) ───────────

export {
  SemanticGenerator,
  SemanticGeneratorLive,
  createSemanticGeneratorTestLayer,
  type SemanticGeneratorShape,
  type DatasourceProfiler,
  type ProfileConnectionOptions,
  type ProfileConnectionResult,
  type ProfileAndGenerateOptions,
  type ProfileAndGenerateResult,
} from "./semantic-generator";

// ── SQL Client Service (native @effect/sql) ─────────────────────────

export {
  AtlasSqlClient,
  makeAtlasSqlClientLive,
  makeOrgSqlClientLive,
  createSqlClientTestLayer,
  type AtlasSqlClientShape,
} from "./sql";

// ── Internal DB Service (P11b) ──────────────────────────────────────

export {
  InternalDB,
  makeInternalDBLive,
  createInternalDBTestLayer,
  queryEffect,
  type InternalDBShape,
} from "@atlas/api/lib/db/internal";

// ── WorkspaceInstaller (#2742 — slice 4 of 1.5.3) ───────────────────

export {
  WorkspaceInstaller,
  WorkspaceInstallerLive,
  createWorkspaceInstallerTestLayer,
  INTEGRATION_CREDENTIALS_SLUGS,
  type WorkspaceInstallerShape,
  type WorkspaceInstallRow,
  type InstallInput,
  type InstallResult,
  type InstallError,
} from "./workspace-installer";

export {
  AlreadyInstalledError,
  ConfigSchemaError,
  CatalogNotFoundError,
  InstallNotFoundError,
} from "./errors";

// ── PillarCatalogQuery (#2741 — slice 3 of 1.5.3) ───────────────────

export {
  PillarCatalogQuery,
  PillarCatalogQueryLive,
  createPillarCatalogQueryTestLayer,
  projectCatalogWithInstalls,
  type PillarCatalogQueryShape,
  type CatalogEntry,
  type CatalogEntryWithState,
  type WorkspaceInstall,
  type WorkspacePlanContext,
} from "./pillar-catalog-query";
