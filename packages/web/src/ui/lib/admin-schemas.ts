/**
 * Zod schemas for types imported from @useatlas/types, used by admin page
 * useAdminFetch calls for runtime response validation.
 *
 * Most schemas in this file use z.string() for string-literal unions
 * (e.g. DBType) to remain resilient when the API adds new values
 * independently of the web bundle. Type annotations keep the schema
 * output assignable to the imported TypeScript interface.
 *
 * Exceptions: wire shapes that live in `@useatlas/schemas` are re-exported
 * at the top of this file and use `z.enum(TUPLE)` where the TS union and
 * the tuple come from the same `@useatlas/types` source (so enum
 * tightening is drift-free by construction). See
 * `packages/schemas/README.md`.
 */
import { z } from "zod";
import type {
  ConnectionInfo,
  ConnectionHealth,
  WorkspaceBranding,
  WorkspaceModelConfig,
  PIIColumnClassification,
  SemanticDiffResponse,
  RegionMigration,
  RegionPickerItem,
  RegionStatus,
  WorkspaceRegion,
  WorkspaceSLASummary,
  WorkspaceSLADetail,
  SLAAlert,
  SLAThresholds,
  SLAMetricPoint,
} from "@/ui/lib/types";
import {
  BackupEntrySchema,
  CustomDomainSchema,
  PlatformWorkspaceSchema,
  PlatformWorkspaceUserSchema,
  NoisyNeighborSchema,
} from "@useatlas/schemas";
import { asPercentage } from "@useatlas/types";
export {
  AbuseStatusSchema,
  AbuseThresholdConfigSchema,
  AbuseDetailSchema,
  ApprovalRuleSchema,
  ApprovalRequestSchema,
  BackupEntrySchema,
  BackupConfigSchema,
  BillingStatusSchema,
  CustomDomainSchema,
  IntegrationStatusSchema,
  PlatformStatsSchema,
  PlatformWorkspaceSchema,
  NoisyNeighborSchema,
} from "@useatlas/schemas";

// ── Connection ────────────────────────────────────────────────────

const ConnectionHealthSchema = z.object({
  status: z.string(),
  latencyMs: z.number(),
  message: z.string().optional(),
  checkedAt: z.string(),
}) as z.ZodType<ConnectionHealth>;

export const ConnectionInfoSchema = z.object({
  id: z.string(),
  dbType: z.string(),
  description: z.string().nullable().optional(),
  status: z.string().optional(),
  health: ConnectionHealthSchema.optional(),
}) as z.ZodType<ConnectionInfo>;

// ── Branding ──────────────────────────────────────────────────────

export const WorkspaceBrandingSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  logoUrl: z.string().nullable(),
  logoText: z.string().nullable(),
  primaryColor: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  hideAtlasBranding: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) as z.ZodType<WorkspaceBranding>;

// ── Model Config ──────────────────────────────────────────────────

export const WorkspaceModelConfigSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().nullable(),
  apiKeyMasked: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) as z.ZodType<WorkspaceModelConfig>;

// ── Compliance ────────────────────────────────────────────────────

export const PIIColumnClassificationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  tableName: z.string(),
  columnName: z.string(),
  connectionId: z.string(),
  category: z.string(),
  confidence: z.string(),
  maskingStrategy: z.string(),
  reviewed: z.boolean(),
  dismissed: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) as z.ZodType<PIIColumnClassification>;

// ── Semantic Diff ─────────────────────────────────────────────────

const SemanticTableDiffSchema = z.object({
  table: z.string(),
  addedColumns: z.array(z.object({ name: z.string(), type: z.string() })),
  removedColumns: z.array(z.object({ name: z.string(), type: z.string() })),
  typeChanges: z.array(z.object({ name: z.string(), yamlType: z.string(), dbType: z.string() })),
});

export const SemanticDiffResponseSchema = z.object({
  connection: z.string(),
  newTables: z.array(z.string()),
  removedTables: z.array(z.string()),
  tableDiffs: z.array(SemanticTableDiffSchema),
  unchangedCount: z.number(),
  summary: z.object({
    total: z.number(),
    new: z.number(),
    removed: z.number(),
    changed: z.number(),
    unchanged: z.number(),
  }),
  warnings: z.array(z.string()).optional(),
}) as z.ZodType<SemanticDiffResponse>;

// ── Connections list (shared by connections + schema-diff pages) ───

export const ConnectionsResponseSchema = z.object({
  connections: z.array(ConnectionInfoSchema).optional(),
}).transform((r) => r.connections ?? []);

// ── Platform ─────────────────────────────────────────────────────
// PlatformStatsSchema, PlatformWorkspaceSchema, NoisyNeighborSchema and
// PlatformWorkspaceUserSchema come from @useatlas/schemas so the three
// enum columns (status / planTier / metric) stay strict across the
// route OpenAPI contract and the web parse.

export const PlatformWorkspacesResponseSchema = z.object({
  workspaces: z.array(PlatformWorkspaceSchema),
});

export const PlatformNeighborsResponseSchema = z.object({
  neighbors: z.array(NoisyNeighborSchema),
  medians: z.object({
    queries: z.number(),
    tokens: z.number(),
    storage: z.number(),
  }),
});

export const PlatformWorkspaceDetailResponseSchema = z.object({
  workspace: PlatformWorkspaceSchema,
  users: z.array(PlatformWorkspaceUserSchema),
});

// ── Backups ──────────────────────────────────────────────────────
// BackupEntrySchema + BackupConfigSchema re-exported above from
// @useatlas/schemas — the web parse, route OpenAPI validation, and tests
// share a single definition so tightening `status` to `z.enum(BACKUP_STATUSES)`
// doesn't have to be applied twice.

export const BackupsResponseSchema = z.object({
  backups: z.array(BackupEntrySchema),
});

// ── Custom Domain ────────────────────────────────────────────────
// CustomDomainSchema re-exported above from @useatlas/schemas.

export const DomainResponseSchema = z.object({
  domain: CustomDomainSchema.nullable(),
});

export const DomainsResponseSchema = z.object({
  domains: z.array(CustomDomainSchema),
});

// ── Region / Residency ───────────────────────────────────────────

export const RegionPickerItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
}) as z.ZodType<RegionPickerItem>;

export const RegionStatusSchema = z.object({
  region: z.string(),
  label: z.string(),
  workspaceCount: z.number(),
  healthy: z.boolean(),
}) as z.ZodType<RegionStatus>;

export const WorkspaceRegionSchema = z.object({
  workspaceId: z.string(),
  region: z.string(),
  assignedAt: z.string(),
}) as z.ZodType<WorkspaceRegion>;

export const RegionsResponseSchema = z.object({
  regions: z.array(RegionStatusSchema),
  defaultRegion: z.string(),
});

export const AssignmentsResponseSchema = z.object({
  assignments: z.array(WorkspaceRegionSchema),
});

export const RegionMigrationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sourceRegion: z.string(),
  targetRegion: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]),
  requestedBy: z.string().nullable(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
}) as z.ZodType<RegionMigration>;

export const MigrationStatusResponseSchema = z.object({
  migration: RegionMigrationSchema.nullable(),
});

// ── SLA ──────────────────────────────────────────────────────────

// `.min(0).max(100)` on `errorRatePct` / `uptimePct` at the wire boundary
// so a drifted response (scale mixup, NaN, negative) fails parse instead
// of silently branding as `Percentage` (#1685). `.transform` brands the
// validated value, then a `satisfies z.ZodType<WorkspaceSLASummary, unknown>`
// at the end preserves the structural-drift guard (a `workspaceName`
// rename in `@useatlas/types` still breaks this file at compile time).
export const WorkspaceSLASummarySchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  latencyP50Ms: z.number(),
  latencyP95Ms: z.number(),
  latencyP99Ms: z.number(),
  errorRatePct: z.number().min(0).max(100).transform((n) => asPercentage(n)),
  uptimePct: z.number().min(0).max(100).transform((n) => asPercentage(n)),
  totalQueries: z.number(),
  failedQueries: z.number(),
  lastQueryAt: z.string().nullable(),
}) satisfies z.ZodType<WorkspaceSLASummary, unknown>;

const SLAMetricPointSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
}) as z.ZodType<SLAMetricPoint>;

export const WorkspaceSLADetailSchema = z.object({
  summary: WorkspaceSLASummarySchema,
  latencyTimeline: z.array(SLAMetricPointSchema),
  errorTimeline: z.array(SLAMetricPointSchema),
}) as z.ZodType<WorkspaceSLADetail>;

export const SLAAlertSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  type: z.string(),
  status: z.string(),
  message: z.string(),
  currentValue: z.number(),
  threshold: z.number(),
  firedAt: z.string(),
  resolvedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
}) as z.ZodType<SLAAlert>;

export const SLAThresholdsSchema = z.object({
  latencyP99Ms: z.number(),
  errorRatePct: z.number().min(0).max(100).transform((n) => asPercentage(n)),
}) satisfies z.ZodType<SLAThresholds, unknown>;

export const SLAWorkspacesResponseSchema = z.object({
  workspaces: z.array(WorkspaceSLASummarySchema),
  hoursBack: z.number(),
});

export const SLAAlertsResponseSchema = z.object({
  alerts: z.array(SLAAlertSchema),
});

// ── Audit ────────────────────────────────────────────────────────

export const AuditStatsSchema = z.object({
  totalQueries: z.number(),
  totalErrors: z.number(),
  errorRate: z.number(),
  queriesPerDay: z.array(z.object({ day: z.string(), count: z.number() })),
});

export const AuditFacetsSchema = z.object({
  tables: z.array(z.string()),
  columns: z.array(z.string()),
});

export const AuditConnectionMetaSchema = z.object({
  connections: z.array(z.object({
    id: z.string(),
    description: z.string().optional(),
  })),
});

// ── Audit Analytics ──────────────────────────────────────────────

export const VolumePointSchema = z.object({
  day: z.string(),
  count: z.number(),
  errors: z.number(),
});

export const SlowQuerySchema = z.object({
  query: z.string(),
  avgDuration: z.number(),
  maxDuration: z.number(),
  count: z.number(),
});

export const FrequentQuerySchema = z.object({
  query: z.string(),
  count: z.number(),
  avgDuration: z.number(),
  errorCount: z.number(),
});

export const ErrorGroupSchema = z.object({
  error: z.string(),
  count: z.number(),
});

export const AuditUserStatsSchema = z.object({
  userId: z.string(),
  userEmail: z.string().nullable().optional(),
  count: z.number(),
  avgDuration: z.number(),
  errorCount: z.number(),
  errorRate: z.number(),
});

export const AuditVolumeResponseSchema = z.object({
  volume: z.array(VolumePointSchema),
});

export const AuditSlowResponseSchema = z.object({
  queries: z.array(SlowQuerySchema),
});

export const AuditFrequentResponseSchema = z.object({
  queries: z.array(FrequentQuerySchema),
});

export const AuditErrorsResponseSchema = z.object({
  errors: z.array(ErrorGroupSchema),
});

export const AuditUsersResponseSchema = z.object({
  users: z.array(AuditUserStatsSchema),
});

// ── Billing ──────────────────────────────────────────────────────
// BillingStatusSchema re-exported above from @useatlas/schemas. Tightens
// `plan.tier` to PLAN_TIERS and `usage.tokenOverageStatus` to
// OVERAGE_STATUSES — Stripe-controlled fields (subscription.plan /
// subscription.status) stay free-form z.string().

// ── Sessions ─────────────────────────────────────────────────────

export const SessionStatsSchema = z.object({
  total: z.number(),
  active: z.number(),
  uniqueUsers: z.number(),
});

/**
 * One row in the admin sessions list. `ipAddress` and `userAgent` are
 * `.nullable()` (not `.optional()`) on purpose — the API always emits
 * these keys with an explicit `null` when the value is unknown. The
 * sessions-schema round-trip test guards this distinction so we notice
 * if the API ever drifts from `string | null` to `string | undefined`.
 */
export const SessionRowSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userEmail: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});

export const SessionsListSchema = z.object({
  sessions: z.array(SessionRowSchema),
  total: z.number(),
});

/**
 * Authoritative TypeScript shape for one admin session row. Inferred from
 * the schema so the Zod parse at `useAdminFetch` time is the single source
 * of truth — columns.tsx re-exports this for its `ColumnDef<SessionRow>`
 * generic, and the inference guarantees the two stay in lockstep.
 */
export type SessionRow = z.infer<typeof SessionRowSchema>;

// ── Token Usage ──────────────────────────────────────────────────

export const TokenSummarySchema = z.object({
  totalPromptTokens: z.number(),
  totalCompletionTokens: z.number(),
  totalTokens: z.number(),
  totalRequests: z.number(),
  from: z.string(),
  to: z.string(),
});

const UserTokenRowSchema = z.object({
  userId: z.string(),
  userEmail: z.string().nullable().optional(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  requestCount: z.number(),
});

const TrendPointSchema = z.object({
  day: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  requestCount: z.number(),
});

export const TrendsResponseSchema = z.object({
  trends: z.array(TrendPointSchema),
  from: z.string(),
  to: z.string(),
});

export const TokenUserResponseSchema = z.object({
  users: z.array(UserTokenRowSchema),
});

// ── Usage ────────────────────────────────────────────────────────

const DailyUsagePointSchema = z.object({
  period_start: z.string(),
  query_count: z.number(),
  token_count: z.number(),
  active_users: z.number(),
});

const UserUsageRowSchema = z.object({
  user_id: z.string(),
  query_count: z.number(),
  token_count: z.number(),
  login_count: z.number(),
});

export const UsageSummarySchema = z.object({
  workspaceId: z.string(),
  current: z.object({
    queryCount: z.number(),
    tokenCount: z.number(),
    activeUsers: z.number(),
    periodStart: z.string(),
    periodEnd: z.string(),
  }),
  plan: z.object({
    tier: z.string(),
    displayName: z.string(),
    trialEndsAt: z.string().nullable(),
  }),
  limits: z.object({
    tokenBudgetPerSeat: z.number().nullable(),
    totalTokenBudget: z.number().nullable(),
    maxSeats: z.number().nullable(),
    maxConnections: z.number().nullable(),
  }),
  history: z.array(DailyUsagePointSchema),
  users: z.array(UserUsageRowSchema),
  hasStripe: z.boolean(),
});

// ── Users ────────────────────────────────────────────────────────

export const UserStatsSchema = z.object({
  total: z.number(),
  banned: z.number(),
  byRole: z.record(z.string(), z.number()),
});

// ── API Keys ─────────────────────────────────────────────────────

const ApiKeyRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  start: z.string().nullable(),
  prefix: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastRequest: z.string().nullable(),
});

export const ListApiKeysResponseSchema = z.object({
  apiKeys: z.array(ApiKeyRowSchema),
  total: z.number(),
});

// ── Plugins ──────────────────────────────────────────────────────

const PluginDescriptionSchema = z.object({
  id: z.string(),
  types: z.array(z.enum(["datasource", "context", "interaction", "action", "sandbox"])),
  version: z.string(),
  name: z.string(),
  status: z.enum(["registered", "initializing", "healthy", "unhealthy", "teardown"]),
  enabled: z.boolean(),
});

export const PluginListResponseSchema = z.object({
  plugins: z.array(PluginDescriptionSchema).optional(),
  manageable: z.boolean().optional(),
}).transform((r) => ({
  plugins: r.plugins ?? [],
  manageable: r.manageable ?? false,
}));

// ── Plugin Marketplace ──────────────────────────────────────────

const PLUGIN_TYPES = ["datasource", "context", "interaction", "action", "sandbox"] as const;

export const CatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  type: z.enum(PLUGIN_TYPES),
  npmPackage: z.string().nullable(),
  iconUrl: z.string().nullable(),
  configSchema: z.unknown().nullable(),
  minPlan: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  installed: z.boolean().optional(),
  installationId: z.string().nullable().optional(),
  installedConfig: z.unknown().nullable().optional(),
});

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const AvailablePluginsResponseSchema = z.object({
  plugins: z.array(CatalogEntrySchema),
  total: z.number(),
});

export const PlatformCatalogResponseSchema = z.object({
  entries: z.array(CatalogEntrySchema),
  total: z.number(),
});
