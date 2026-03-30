/**
 * Zod schemas for types imported from @useatlas/types, used by admin page
 * useAdminFetch calls for runtime response validation.
 *
 * Schemas use z.string() for string-literal unions (e.g. DBType) to remain
 * resilient when the API adds new values. Type annotations ensure the
 * schema output is assignable to the imported TypeScript interface.
 */
import { z } from "zod";
import type {
  ConnectionInfo,
  ConnectionHealth,
  WorkspaceBranding,
  WorkspaceModelConfig,
  ApprovalRule,
  ApprovalRequest,
  AbuseStatus,
  AbuseThresholdConfig,
  PIIColumnClassification,
  SemanticDiffResponse,
} from "@/ui/lib/types";

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

// ── Abuse ─────────────────────────────────────────────────────────

const AbuseEventSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  level: z.string(),
  trigger: z.string(),
  message: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  actor: z.string(),
});

export const AbuseStatusSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string().nullable(),
  level: z.string(),
  trigger: z.string().nullable(),
  message: z.string().nullable(),
  updatedAt: z.string(),
  events: z.array(AbuseEventSchema),
}) as z.ZodType<AbuseStatus>;

export const AbuseThresholdConfigSchema = z.object({
  queryRateLimit: z.number(),
  queryRateWindowSeconds: z.number(),
  errorRateThreshold: z.number(),
  uniqueTablesLimit: z.number(),
  throttleDelayMs: z.number(),
}) as z.ZodType<AbuseThresholdConfig>;

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
