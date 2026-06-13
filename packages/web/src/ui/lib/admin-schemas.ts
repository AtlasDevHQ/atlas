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
import type { AbuseRestoreStatus, PlanTier } from "@useatlas/types";
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
 * One audit-log row as returned by `GET /api/v1/admin/audit` (the route
 * selects `a.*`, so every audit_log column is present). Validating here turns
 * a wire-shape drift into a TS/runtime error instead of a silent `undefined`.
 * `.passthrough()` keeps forward-compat columns the table doesn't render yet.
 */
export const AuditRowSchema = z
  .object({
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
    // MCP attribution (migration 0049) — NULL for non-MCP rows.
    actor_kind: z.string().nullable().optional(),
    client_id: z.string().nullable().optional(),
    tool_name: z.string().nullable().optional(),
  })
  .passthrough();

export const AuditRowsResponseSchema = z.object({
  rows: z.array(AuditRowSchema),
  total: z.number(),
});

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
  // /admin/connections Add picker uses (#3377); the default listing is
  // filtered to chat/integration server-side.
  type: z.enum(["chat", "integration", "datasource"]),
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
  pillar: z.enum(["datasource", "chat", "action"]).optional(),
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
