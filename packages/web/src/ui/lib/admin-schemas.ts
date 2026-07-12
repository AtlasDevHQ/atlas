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
  AbuseRestoreStatus,
  PlanTier,
  KnowledgeCollectionListResponse,
  KnowledgeCollectionSource,
  KnowledgeDocumentListResponse,
  KnowledgeIngestSummary,
  KnowledgeSyncRunResponse,
  KnowledgeUninstallResponse,
} from "@useatlas/types";
import {
  BackupEntrySchema,
  CustomDomainSchema,
  NoisyNeighborSchema,
  PlatformWorkspaceSchema,
  PlatformWorkspaceUserSchema,
} from "@useatlas/schemas";

// Local literal tuple instead of importing the value-export tuple from
// `@useatlas/types`. The template scaffold installs `@useatlas/types`
// from the registry — adding a new value export forces a publish-first
// merge dance for every PR (#useatlas/types-scaffold-gotcha). The
// `satisfies` constraint pins this tuple to the same union as the
// canonical `AbuseRestoreStatus` so adding a level in
// `@useatlas/types/abuse.ts` fails compile here until both sides match.
const ABUSE_RESTORE_STATUSES = [
  "pending",
  "ok",
  "db_unavailable",
  "load_failed",
] as const satisfies readonly AbuseRestoreStatus[];
export {
  AbuseStatusSchema,
  AbuseThresholdConfigSchema,
  AbuseDetailSchema,
  ApprovalRuleSchema,
  ApprovalRequestSchema,
  AuditErrorsResponseSchema,
  AuditFrequentResponseSchema,
  AuditSlowResponseSchema,
  AuditUserStatsSchema,
  AuditUsersResponseSchema,
  AuditVolumeResponseSchema,
  BackupEntrySchema,
  BackupConfigSchema,
  CrmOutboxRowSchema,
  CrmOutboxRowDetailSchema,
  CrmOutboxListResponseSchema,
  BillingStatusSchema,
  ConnectionHealthSchema,
  ConnectionInfoSchema,
  ConnectionsResponseSchema,
  ConnectionGroupDescriptionsResponseSchema,
  MAX_GROUP_DESCRIPTION_CHARS,
  CustomDomainSchema,
  ErrorGroupSchema,
  FrequentQuerySchema,
  IntegrationStatusSchema,
  PIIColumnClassificationSchema,
  PlatformStatsSchema,
  PlatformWorkspaceSchema,
  NoisyNeighborSchema,
  RegionPickerItemSchema,
  RegionStatusSchema,
  WorkspaceRegionSchema,
  RegionMigrationSchema,
  RegionsResponseSchema,
  AssignmentsResponseSchema,
  MigrationStatusResponseSchema,
  SemanticDiffResponseSchema,
  SLAAlertSchema,
  SLAAlertsResponseSchema,
  SLAMetricPointSchema,
  SLAThresholdsSchema,
  SLAWorkspacesResponseSchema,
  SlowQuerySchema,
  TokenSummarySchema,
  TokenUserResponseSchema,
  TrendPointSchema,
  TrendsResponseSchema,
  UsageSummarySchema,
  UserTokenRowSchema,
  VolumePointSchema,
  WorkspaceBrandingSchema,
  WorkspaceModelConfigSchema,
  WorkspaceSLADetailSchema,
  WorkspaceSLASummarySchema,
  GatewayCatalogModelSchema,
  GatewayCatalogResponseSchema,
  SessionMemorySlotSchema,
  SessionMemoryViewSchema,
  SessionMemoryListResponseSchema,
} from "@useatlas/schemas";

// ── Platform ─────────────────────────────────────────────────────
// PlatformStatsSchema, PlatformWorkspaceSchema, NoisyNeighborSchema and
// PlatformWorkspaceUserSchema come from @useatlas/schemas so the three
// enum columns (status / planTier / metric) stay strict across the
// route OpenAPI contract and the web parse.

export const PlatformWorkspacesResponseSchema = z.object({
  workspaces: z.array(PlatformWorkspaceSchema),
  // Optional + additive — older API doesn't include this field; the
  // platform-admin page treats absence as `"ok"` (the conservative
  // "everything's fine" default). Sourced from `getAbuseRestoreStatus()`.
  abuseRestoreStatus: z.enum(ABUSE_RESTORE_STATUSES).optional(),
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

export const BackupsResponseSchema = z.object({
  backups: z.array(BackupEntrySchema),
});

// ── Custom Domain ────────────────────────────────────────────────

export const DomainResponseSchema = z.object({
  domain: CustomDomainSchema.nullable(),
});

export const DomainsResponseSchema = z.object({
  domains: z.array(CustomDomainSchema),
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

/**
 * The strict audit-row shape — one field per `audit_log` column the table
 * knows about. This object is the SSOT: the exported {@link AuditRow} type is
 * inferred from it (no index signature, so typos on property access still fail
 * `tsgo`), while {@link AuditRowSchema} adds `.passthrough()` on top for the
 * wire parse only.
 */
const AuditRowShape = z.object({
  id: z.string(),
  user_id: z.string().nullable(),
  sql: z.string(),
  success: z.boolean(),
  duration_ms: z.number(),
  row_count: z.number().nullable(),
  timestamp: z.string(),
  user_email: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  source_id: z.string().nullable().optional(),
  tables_accessed: z.array(z.string()).nullable(),
  columns_accessed: z.array(z.string()).nullable(),
  // MCP attribution (migration 0049) — NULL for non-MCP rows; populated by
  // the MCP transport with the actor kind, OAuth client id, and dispatched
  // tool.
  actor_kind: z.string().nullable().optional(),
  client_id: z.string().nullable().optional(),
  tool_name: z.string().nullable().optional(),
});

/**
 * One audit-log row as returned by `GET /api/v1/admin/audit` (the route
 * selects `a.*`, so every audit_log column is present). Validating here turns
 * a wire-shape drift into a TS/runtime error instead of a silent `undefined`.
 * `.passthrough()` keeps forward-compat columns the table doesn't render yet —
 * on the runtime parse ONLY; the derived {@link AuditRow} type stays strict.
 */
export const AuditRowSchema = AuditRowShape.passthrough();

export const AuditRowsResponseSchema = z.object({
  rows: z.array(AuditRowSchema),
  total: z.number(),
});

/**
 * The audit-row shape, derived from {@link AuditRowShape} (the strict object,
 * NOT the passthrough schema) so the schema is the single source of truth AND
 * the type keeps typo-detection on property access — a `.passthrough()` infer
 * would add an `[key: string]: unknown` index signature that silently swallows
 * typos. The audit table's `columns.tsx` re-exports this; deriving it (rather
 * than hand-writing a parallel interface) means a schema change can't silently
 * drift from the rendered table (#4278).
 */
export type AuditRow = z.infer<typeof AuditRowShape>;

// `AuditConnectionMetaSchema` removed in #2444 — the audit page now reuses
// the canonical `ConnectionsResponseSchema` so every consumer of
// `/api/v1/admin/connections` shares the same TanStack Query cache shape
// (an array, not an object envelope). The old subset schema cached an
// `{ connections: [...] }` shape that crashed `/admin/connections` when the
// audit page populated the cache first.

/**
 * Subset of `/api/v1/admin/oauth-clients` consumed by the audit-log
 * filter bar (#2067). The dropdown only needs `clientId` + the
 * display label; pulling the full row would force the schema to
 * track every column the OAuth Clients admin page surfaces.
 */
export const AuditOAuthClientsSchema = z.object({
  clients: z.array(
    z.object({
      clientId: z.string(),
      clientName: z.string().nullable(),
    }),
  ),
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

// ── Users ────────────────────────────────────────────────────────

export const UserStatsSchema = z.object({
  total: z.number(),
  banned: z.number(),
  byRole: z.record(z.string(), z.number()),
});

// ── MCP Action Policy ────────────────────────────────────────────
//
// Mirrors the `McpActionPolicyResponse` wire shape from @useatlas/types.
// `category` stays `z.string()` (not the literal union) so the dashboard is
// resilient if the API adds a category before the web bundle ships — the
// admin-schemas convention. Every category (with its label/description) comes
// from the server, so the UI never hardcodes the category set.
export const PolicyEntrySchema = z.object({
  category: z.string(),
  label: z.string(),
  description: z.string(),
  status: z.enum(["allowed", "blocked"]),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
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

// ── OAuth Clients (#2024 / #2065) ────────────────────────────────
// Wire schemas live in `me-schemas.ts` so the per-user `/settings/ai-agents`
// page (#2065) and the admin page share one source. Re-exported here so
// existing admin imports (`@/ui/lib/admin-schemas`) keep working.
export {
  OAuthClientSchema,
  ListOAuthClientsResponseSchema,
  type OAuthClient,
} from "./me-schemas";

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

// ── Integrations Catalog (1.5.2 slice 3 — #2651) ────────────────
//
// Customer-facing read over `plugin_catalog`, joined with
// `workspace_plugins` to compute per-card install state. Used by
// the /admin/integrations catalog card section.

// Local literal tuple instead of importing the value-export tuple from
// `@useatlas/types`. Same scaffold-publish rationale as
// `ABUSE_RESTORE_STATUSES` above — the satisfies constraint pins this
// to the canonical `PlanTier` union so adding a tier in
// `@useatlas/types/platform.ts` fails compile here until both sides
// match.
const PLAN_TIERS_LITERAL = [
  "free",
  "trial",
  "starter",
  "pro",
  "business",
] as const satisfies readonly PlanTier[];

const RawCatalogEntrySchema = z.object({
  id: z.string(),
  slug: z.string(),
  // `datasource` appears only on the `?pillar=datasource` listing the
  // /admin/connections Add picker uses (#3377); `context` only on the
  // `?pillar=knowledge` listing the /admin/knowledge picker uses (#4619,
  // knowledge rows carry `type = 'context'`). The default listing is
  // filtered to chat/integration server-side.
  type: z.enum(["chat", "integration", "datasource", "context"]),
  // `oauth-datasource` is the GitHub-Data install model (migration 0111) —
  // it rides the `?pillar=datasource` listing, so the picker schema must
  // accept it or one such row fails the whole catalog parse (#3384 review).
  installModel: z.enum(["oauth", "form", "static-bot", "oauth-datasource"]),
  name: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  minPlan: z.string(),
  configSchema: z.unknown().nullable(),
  installed: z.boolean(),
  installedAt: z.string().nullable(),
  installedBy: z.string().nullable(),
  // Per-install state derived from `workspace_plugins.config.status`.
  // `"reconnect_needed"` triggers the Reconnect affordance on the
  // integration card (#2658).
  installStatus: z.string().nullable(),
  upsellOnly: z.boolean(),
  // Post-#2701: `accessible` mirrors `!upsellOnly` (operator workspaces
  // always see `true`). `upgradeRequired` is the plan tier needed for
  // ineligible rows, or `null` when the row is accessible. Both fields
  // are additive so older API responses (pre-#2701) parse via
  // `.optional()` — the UI defaults to deriving from `upsellOnly` /
  // `minPlan` when they're absent.
  accessible: z.boolean().optional(),
  upgradeRequired: z.string().nullable().optional(),
  // ── New in #2741 (slice 3 of 1.5.3 — three-pillar taxonomy) ──────
  // Optional + nullable so older API responses (pre-#2741) parse via
  // the same schema. Slice 8 reads `pillar` for section splitting on
  // the admin UI; slice 9 reads `implementationStatus` for the
  // coming-soon badge. Until those slices land the fields are present
  // but not rendered — the UI continues to derive its sections from
  // the legacy `type` field.
  pillar: z.enum(["datasource", "chat", "action", "knowledge"]).optional(),
  implementationStatus: z.enum(["available", "coming_soon"]).optional(),
  // ── New in #2745 (slice 7 of 1.5.3) ──────────────────────────────
  // Non-secret subset of `workspace_plugins.config` for installed rows.
  // Carries Salesforce `instance_url` / `org_id`, Jira `cloud_id`, etc.
  // Optional so older API responses (pre-#2745) parse via the same
  // schema — `/admin/connections` defaults to a generic detail row when
  // the field is absent. `null` is the explicit "row not installed"
  // signal; treat it the same as absent at the render layer.
  installConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  // ── New in #3387 ─────────────────────────────────────────────────
  // Server-derived "this row can be installed via the schema-driven
  // form-install": `installModel === "form"` AND a form-install handler
  // is actually registered for the slug (the same registry the
  // /install-form dispatch consults). Emitted ONLY on the
  // `?pillar=datasource` listing; the default listing omits it (its
  // wire shape is pinned byte-identical), hence `.optional()`.
  // Consumers must fail closed: absent ⇒ not form-installable —
  // rendering a submittable tile for a handler-less row would 500 at
  // submit.
  formInstallable: z.boolean().optional(),
});

/**
 * Discriminated view of the catalog row's plan-access state. The wire
 * shape carries two independent fields (`accessible` + `upgradeRequired`)
 * for backward compatibility; only two of the four `(accessible,
 * upgradeRequired)` combinations are legal, and the invariant is
 * enforced at the producer only.
 *
 * Parsing into this union at the fetch boundary means consumers
 * (catalog-section.tsx) get an exhaustive switch instead of having
 * to re-check both fields. The `requiredPlan` field on the `upgrade`
 * branch is a typed {@link PlanTier} — a legacy `"team"` value falls
 * back to `null` so the UI hides the upgrade chip rather than
 * rendering a non-buyable plan name.
 */
export type CatalogAccess =
  | { readonly kind: "accessible" }
  | { readonly kind: "upgrade"; readonly requiredPlan: PlanTier | null };

/**
 * Narrow a raw `(accessible, upgradeRequired, upsellOnly, minPlan)`
 * tuple to {@link CatalogAccess}. Tolerates pre-#2701 API responses
 * (no `accessible` field) by deriving from `upsellOnly` + `minPlan`.
 */
function deriveAccess(input: {
  accessible?: boolean;
  upgradeRequired?: string | null;
  upsellOnly: boolean;
  minPlan: string;
}): CatalogAccess {
  const isAccessible =
    typeof input.accessible === "boolean" ? input.accessible : !input.upsellOnly;
  if (isAccessible) return { kind: "accessible" };
  const raw =
    typeof input.upgradeRequired === "string" ? input.upgradeRequired : input.minPlan;
  // Match the API's `parsePlanTier` — legacy / drifted values map to
  // `null` so the UI's upgrade chip can hide rather than rendering an
  // unbuyable plan name.
  const requiredPlan = (PLAN_TIERS_LITERAL as readonly string[]).includes(raw)
    ? (raw as PlanTier)
    : null;
  return { kind: "upgrade", requiredPlan };
}

export const IntegrationsCatalogEntrySchema = RawCatalogEntrySchema.transform(
  ({ accessible: _accessible, upgradeRequired: _upgradeRequired, ...entry }) => ({
    // Drop the raw wire fields (`accessible`, `upgradeRequired`) on the
    // way through so consumers can't bypass the `access` tagged union
    // by reading them directly. `upsellOnly` stays because the admin
    // UI still uses it as a fast-path boolean for layout decisions.
    ...entry,
    access: deriveAccess({
      accessible: _accessible,
      upgradeRequired: _upgradeRequired,
      upsellOnly: entry.upsellOnly,
      minPlan: entry.minPlan,
    }),
  }),
);

export type IntegrationsCatalogEntry = z.infer<typeof IntegrationsCatalogEntrySchema>;

export const IntegrationsCatalogResponseSchema = z.object({
  catalog: z.array(IntegrationsCatalogEntrySchema),
});

// ── Security adoption telemetry ───────────────────────────────
// Wire schemas live in `@useatlas/schemas` (single source of truth shared
// with the API route layer). Re-exported here for `useAdminFetch` call
// sites that import from this barrel.

export {
  SecurityBucketsSchema,
  WorkspaceSecurityMetricsSchema,
  PlatformSecurityMetricsSchema,
} from "@useatlas/schemas";

// ── Sandbox (/admin/sandbox) ──────────────────────────────────
// Provider-key vocabulary + status wire schemas live in
// `@useatlas/schemas` (single source of truth shared with the API route
// layer, #3371). `SANDBOX_PROVIDER_BACKEND_IDS` maps provider keys to the
// backend ids that `ATLAS_SANDBOX_BACKEND` stores (#3375).

export {
  SANDBOX_PROVIDER_KEYS,
  SANDBOX_PROVIDER_BACKEND_IDS,
  SandboxProviderKeySchema,
  SandboxStatusSchema,
  type SandboxProviderKey,
  type SandboxConnectedProvider,
  type SandboxStatus,
} from "@useatlas/schemas";

export type {
  SecurityBuckets,
  WorkspaceSecurityMetrics,
  PlatformSecurityMetrics,
} from "@useatlas/types";

// ── Learned patterns (/admin/learned-patterns) ────────────────
// Wire schema lives in `@useatlas/schemas` (single source of truth shared
// with the API route layer, #4579). Re-exported here for the cockpit page's
// `useServerDataTable` call site, so a wire rename surfaces as a
// `schema_mismatch` banner instead of a silently empty table.

export {
  LearnedPatternSchema,
  LearnedPatternsListResponseSchema,
} from "@useatlas/schemas";

// ── Demo tracking (#3931) ────────────────────────────────────────────
// Web-local mirrors of the inline shapes in
// `packages/api/src/api/routes/platform-demo.ts`. Kept here (not in
// `@useatlas/schemas`) so the scaffold template's pinned-version build never
// blocks on a not-yet-published symbol. Keep field names in lockstep with the
// route's response schemas.

export const DemoConfigSchema = z.object({
  model: z.string(),
  maxSteps: z.number().int(),
  rpm: z.number().int(),
  effectiveModel: z.string().nullable(),
});
export type DemoConfig = z.infer<typeof DemoConfigSchema>;

// Token/cache counts are integers (kept in lockstep with the API's
// TokenRollupSchema + the lib DemoTokenRollup interface); avgLatencyMs and
// estimatedCostUsd are genuine floats and stay un-`.int()`.
const DemoTokenRollupSchema = z.object({
  turns: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  avgLatencyMs: z.number().nullable(),
  estimatedCostUsd: z.number().nullable(),
});
export type DemoTokenRollup = z.infer<typeof DemoTokenRollupSchema>;

export const DemoLeadSchema = z.object({
  email: z.string(),
  sessionCount: z.number().int(),
  firstSeen: z.string(),
  lastActive: z.string(),
  conversationCount: z.number().int(),
  usage: DemoTokenRollupSchema,
});
export type DemoLead = z.infer<typeof DemoLeadSchema>;

export const DemoLeadsResponseSchema = z.object({
  leads: z.array(DemoLeadSchema),
});

export const DemoPerModelSchema = DemoTokenRollupSchema.extend({
  model: z.string().nullable(),
  provider: z.string().nullable(),
});
export type DemoPerModel = z.infer<typeof DemoPerModelSchema>;

export const DemoMetricsResponseSchema = z.object({
  leadCount: z.number().int(),
  sessionCount: z.number().int(),
  totals: DemoTokenRollupSchema.extend({ costComplete: z.boolean() }),
  perModel: z.array(DemoPerModelSchema),
});
export type DemoMetricsResponse = z.infer<typeof DemoMetricsResponseSchema>;

const DemoTranscriptMessageSchema = z.object({
  role: z.string(),
  content: z.unknown(),
  createdAt: z.string(),
});
const DemoTranscriptConversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string(),
  messages: z.array(DemoTranscriptMessageSchema),
});
export const DemoTranscriptResponseSchema = z.object({
  email: z.string(),
  conversations: z.array(DemoTranscriptConversationSchema),
});
export type DemoTranscriptResponse = z.infer<typeof DemoTranscriptResponseSchema>;
export type DemoTranscriptConversation = z.infer<typeof DemoTranscriptConversationSchema>;

// ---------------------------------------------------------------------------
// Knowledge Base (/admin/knowledge, #4209, ADR-0028)
// ---------------------------------------------------------------------------
// Local Zod mirrors of the `@useatlas/types` knowledge wire types. Kept local
// (not imported as values from `@useatlas/schemas`) to avoid the scaffold
// publish-first dance — see the file header. `status` is a CLOSED
// `z.enum(["draft","published"])` (not the usual forward-compat `z.string()`)
// because the API excludes archived rows — see the inline comment on the field.
// The `_Assignable*` type-level checks at the end of this block are the drift
// guard: each schema's inferred output must stay assignable to its canonical
// `@useatlas/types` interface, or this file fails to type-check.

const KnowledgeDocumentCountsSchema = z.object({
  draft: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
});

const KnowledgeCollectionSyncStatusSchema = z.object({
  lastSyncAt: z.string(),
  status: z.enum(["success", "error"]),
  error: z.string().nullable(),
});

export const KnowledgeCollectionSchema = z.object({
  slug: z.string(),
  source: z.enum(["upload", "bundle-sync", "notion", "confluence", "confluence-datacenter", "gitbook", "zendesk", "salesforce-knowledge", "intercom", "front", "helpscout", "freshdesk"]),
  description: z.string().nullable(),
  installedAt: z.string().nullable(),
  endpointUrl: z.string().nullable(),
  // Optional: absent from an older API during a deploy-overlap window.
  authScheme: z.enum(["none", "bearer", "basic"]).nullable().optional(),
  sync: KnowledgeCollectionSyncStatusSchema.nullable(),
  documents: KnowledgeDocumentCountsSchema,
});

export const KnowledgeCollectionListResponseSchema = z.object({
  collections: z.array(KnowledgeCollectionSchema),
});

export const KnowledgeDocumentSummarySchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  type: z.string().nullable(),
  tags: z.array(z.string()),
  // The API excludes archived documents, so an active collection's documents
  // are only ever draft or published — a closed union (not the usual
  // forward-compat `z.string()`), matching `KnowledgeDocumentSummary`.
  status: z.enum(["draft", "published"]),
  updatedAt: z.string().nullable(),
});

export const KnowledgeDocumentListResponseSchema = z.object({
  collection: z.string(),
  documents: z.array(KnowledgeDocumentSummarySchema),
});

const KnowledgeRejectedFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export const KnowledgeIngestSummarySchema = z.object({
  collection: z.string(),
  format: z.enum(["tar", "tar.gz", "zip"]),
  documents: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    demoted: z.number().int().nonnegative(),
    resurrected: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  linksWritten: z.number().int().nonnegative(),
  published: z.boolean(),
  rejected: z.array(KnowledgeRejectedFileSchema),
  // `.default(0)`: added in v0.0.41 — an older API omits it during a
  // deploy-overlap window, and the parse must not fail (absent = none skipped).
  skippedNonMarkdown: z.number().int().nonnegative().default(0),
});

export const KnowledgeUninstallResponseSchema = z.object({
  archived: z.boolean(),
  collection: z.string(),
  archivedDocuments: z.number().int().nonnegative(),
});

// One manual "Sync now" attempt (#4211). A failed attempt is still a 200 with
// `status: "error"` — the request completed; the sync itself didn't.
export const KnowledgeSyncRunResponseSchema = z.object({
  collection: z.string(),
  status: z.enum(["success", "error"]),
  syncedAt: z.string(),
  error: z.string().nullable(),
  format: z.enum(["tar", "tar.gz", "zip"]).nullable(),
  documents: z
    .object({
      created: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(),
      demoted: z.number().int().nonnegative(),
      resurrected: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
  archivedAbsent: z.number().int().nonnegative().nullable(),
  linksWritten: z.number().int().nonnegative().nullable(),
  rejected: z.array(KnowledgeRejectedFileSchema),
});

// Compile-time drift guards. `_Expect<T extends true>` rejects any check that
// resolves to `false`. The `*Drift` guards check ONE direction — schema output
// stays assignable to the `@useatlas/types` wire interface — which catches a
// dropped field or a schema enum widened past the wire union, and keeps the
// otherwise consumer-less uninstall shape honest. They can NOT catch the wire
// union widening past a closed schema enum (a narrower enum is always
// assignable to a wider union), so closed enums here need a paired
// reverse-direction guard like `_KnowledgeSourceExhaustive` below.
type _Expect<T extends true> = T;
export type _KnowledgeCollectionListDrift = _Expect<
  z.infer<typeof KnowledgeCollectionListResponseSchema> extends KnowledgeCollectionListResponse
    ? true
    : false
>;
// Reverse direction for the closed `source` enum: every member of the wire
// union must be parseable by the schema. Without this, adding a fifth
// `KnowledgeCollectionSource` in `@useatlas/types` (which the API's
// `satisfies KnowledgeCollectionListResponse` guarantees gets emitted)
// type-checks green here and hard-fails `/admin/knowledge` at Zod-parse time —
// including during a deploy-overlap window.
export type _KnowledgeSourceExhaustive = _Expect<
  KnowledgeCollectionSource extends z.infer<typeof KnowledgeCollectionSchema>["source"]
    ? true
    : false
>;
export type _KnowledgeDocumentListDrift = _Expect<
  z.infer<typeof KnowledgeDocumentListResponseSchema> extends KnowledgeDocumentListResponse
    ? true
    : false
>;
export type _KnowledgeIngestSummaryDrift = _Expect<
  z.infer<typeof KnowledgeIngestSummarySchema> extends KnowledgeIngestSummary ? true : false
>;
export type _KnowledgeUninstallDrift = _Expect<
  z.infer<typeof KnowledgeUninstallResponseSchema> extends KnowledgeUninstallResponse ? true : false
>;
export type _KnowledgeSyncRunDrift = _Expect<
  z.infer<typeof KnowledgeSyncRunResponseSchema> extends KnowledgeSyncRunResponse ? true : false
>;
