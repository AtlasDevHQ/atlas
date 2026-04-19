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
  ApprovalRule,
  ApprovalRequest,
  PIIColumnClassification,
  SemanticDiffResponse,
  PlatformStats,
  PlatformWorkspace,
  PlatformWorkspaceUser,
  NoisyNeighbor,
  BackupEntry,
  BackupConfig,
  CustomDomain,
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
export {
  AbuseStatusSchema,
  AbuseThresholdConfigSchema,
  AbuseDetailSchema,
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

// ── Approval ──────────────────────────────────────────────────────

export const ApprovalRuleSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  ruleType: z.string(),
  pattern: z.string(),
  threshold: z.number().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) as z.ZodType<ApprovalRule>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  requesterId: z.string(),
  requesterEmail: z.string().nullable(),
  querySql: z.string(),
  explanation: z.string().nullable(),
  connectionId: z.string(),
  tablesAccessed: z.array(z.string()),
  columnsAccessed: z.array(z.string()),
  status: z.string(),
  reviewerId: z.string().nullable(),
  reviewerEmail: z.string().nullable(),
  reviewComment: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
}) as z.ZodType<ApprovalRequest>;

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

export const PlatformStatsSchema = z.object({
  totalWorkspaces: z.number(),
  activeWorkspaces: z.number(),
  suspendedWorkspaces: z.number(),
  totalUsers: z.number(),
  totalQueries24h: z.number(),
  mrr: z.number(),
}) as z.ZodType<PlatformStats>;

export const PlatformWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  planTier: z.string(),
  status: z.string(),
  byot: z.boolean(),
  members: z.number(),
  connections: z.number(),
  conversations: z.number(),
  queriesLast24h: z.number(),
  scheduledTasks: z.number(),
  stripeCustomerId: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  region: z.string().nullable(),
  regionAssignedAt: z.string().nullable(),
  createdAt: z.string(),
}) as z.ZodType<PlatformWorkspace>;

const PlatformWorkspaceUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  createdAt: z.string(),
}) as z.ZodType<PlatformWorkspaceUser>;

export const NoisyNeighborSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  planTier: z.string(),
  metric: z.string(),
  value: z.number(),
  median: z.number(),
  ratio: z.number(),
}) as z.ZodType<NoisyNeighbor>;

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

export const BackupEntrySchema = z.object({
  id: z.string(),
  status: z.string(),
  sizeBytes: z.number().nullable(),
  storagePath: z.string(),
  createdAt: z.string(),
  retentionExpiresAt: z.string(),
  errorMessage: z.string().nullable(),
}) as z.ZodType<BackupEntry>;

export const BackupConfigSchema = z.object({
  schedule: z.string(),
  retentionDays: z.number(),
  storagePath: z.string(),
}) as z.ZodType<BackupConfig>;

export const BackupsResponseSchema = z.object({
  backups: z.array(BackupEntrySchema),
});

// ── Custom Domain ────────────────────────────────────────────────

export const CustomDomainSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  domain: z.string(),
  status: z.string(),
  railwayDomainId: z.string().nullable(),
  cnameTarget: z.string().nullable(),
  certificateStatus: z.string().nullable(),
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
  verificationToken: z.string().nullable(),
  domainVerified: z.boolean(),
  domainVerifiedAt: z.string().nullable(),
  domainVerificationStatus: z.enum(["pending", "verified", "failed"]),
}) as z.ZodType<CustomDomain>;

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

export const WorkspaceSLASummarySchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  latencyP50Ms: z.number(),
  latencyP95Ms: z.number(),
  latencyP99Ms: z.number(),
  errorRatePct: z.number(),
  uptimePct: z.number(),
  totalQueries: z.number(),
  failedQueries: z.number(),
  lastQueryAt: z.string().nullable(),
}) as z.ZodType<WorkspaceSLASummary>;

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
  errorRatePct: z.number(),
}) as z.ZodType<SLAThresholds>;

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

export const BillingStatusSchema = z.object({
  workspaceId: z.string(),
  plan: z.object({
    tier: z.string(),
    displayName: z.string(),
    pricePerSeat: z.number(),
    defaultModel: z.string(),
    byot: z.boolean(),
    trialEndsAt: z.string().nullable(),
  }),
  limits: z.object({
    tokenBudgetPerSeat: z.number().nullable(),
    totalTokenBudget: z.number().nullable(),
    maxSeats: z.number().nullable(),
    maxConnections: z.number().nullable(),
  }),
  usage: z.object({
    queryCount: z.number(),
    tokenCount: z.number(),
    seatCount: z.number(),
    tokenUsagePercent: z.number(),
    tokenOverageStatus: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
  }),
  seats: z.object({
    count: z.number(),
    max: z.number().nullable(),
  }).optional(),
  connections: z.object({
    count: z.number(),
    max: z.number().nullable(),
  }).optional(),
  currentModel: z.string().optional(),
  overagePerMillionTokens: z.number().optional(),
  subscription: z.object({
    stripeSubscriptionId: z.string(),
    plan: z.string(),
    status: z.string(),
  }).nullable(),
});

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

// ── Integrations ─────────────────────────────────────────────────

const SlackStatusSchema = z.object({
  connected: z.boolean(),
  teamId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  installedAt: z.string().nullable(),
  oauthConfigured: z.boolean(),
  envConfigured: z.boolean(),
  configurable: z.boolean(),
});

const TeamsStatusSchema = z.object({
  connected: z.boolean(),
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  installedAt: z.string().nullable(),
  configurable: z.boolean(),
});

const DiscordStatusSchema = z.object({
  connected: z.boolean(),
  guildId: z.string().nullable(),
  guildName: z.string().nullable(),
  installedAt: z.string().nullable(),
  configurable: z.boolean(),
});

const TelegramStatusSchema = z.object({
  connected: z.boolean(),
  botId: z.string().nullable(),
  botUsername: z.string().nullable(),
  installedAt: z.string().nullable(),
  configurable: z.boolean(),
});

const GChatStatusSchema = z.object({
  connected: z.boolean(),
  projectId: z.string().nullable(),
  serviceAccountEmail: z.string().nullable(),
  installedAt: z.string().nullable(),
  configurable: z.boolean(),
});

const GitHubStatusSchema = z.object({
  connected: z.boolean(),
  username: z.string().nullable(),
  installedAt: z.string().nullable(),
  configurable: z.boolean(),
});

const LinearStatusSchema = z.object({
  connected: z.boolean(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  installedAt: z.string().nullable(),
  configurable: z.boolean(),
});

const WhatsAppStatusSchema = z.object({
  connected: z.boolean(),
  phoneNumberId: z.string().nullable(),
  displayPhone: z.string().nullable(),
  installedAt: z.string().nullable(),
  configurable: z.boolean(),
});

const EmailStatusSchema = z.object({
  connected: z.boolean(),
  provider: z.string().nullable(),
  senderAddress: z.string().nullable(),
  installedAt: z.string().nullable(),
  configurable: z.boolean(),
});

const WebhookStatusSchema = z.object({
  activeCount: z.number(),
  configurable: z.boolean(),
});

export const IntegrationStatusSchema = z.object({
  slack: SlackStatusSchema,
  teams: TeamsStatusSchema,
  discord: DiscordStatusSchema,
  telegram: TelegramStatusSchema,
  gchat: GChatStatusSchema,
  github: GitHubStatusSchema,
  linear: LinearStatusSchema,
  whatsapp: WhatsAppStatusSchema,
  email: EmailStatusSchema,
  webhooks: WebhookStatusSchema,
  deliveryChannels: z.array(z.string()),
  deployMode: z.string(),
  hasInternalDB: z.boolean(),
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
