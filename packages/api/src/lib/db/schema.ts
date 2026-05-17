/**
 * Drizzle schema — single source of truth for the internal database.
 *
 * Used by `drizzle-kit generate` to produce versioned SQL migration files.
 * NOT imported at runtime — the migration runner executes raw SQL files.
 *
 * Convention: tables are ordered chronologically by when they were introduced.
 * EE tables (backups, masking, scim, sla) are included here so they are
 * part of the standard migration path instead of lazy ensureTable() calls.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  numeric,
  real,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  foreignKey,
  primaryKey,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Core tables
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    userId: text("user_id"),
    userLabel: text("user_label"),
    authMode: text("auth_mode").notNull(),
    sql: text("sql").notNull(),
    durationMs: integer("duration_ms").notNull(),
    rowCount: integer("row_count"),
    success: boolean("success").notNull(),
    error: text("error"),
    // Multi-database columns
    sourceId: text("source_id"),
    sourceType: text("source_type"),
    targetHost: text("target_host"),
    // Data classification
    tablesAccessed: jsonb("tables_accessed"),
    columnsAccessed: jsonb("columns_accessed"),
    // Org scoping
    orgId: text("org_id"),
    // Soft-delete (retention purge)
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // #2067 — MCP filter discriminators. NULL for non-MCP rows; today
    // only the MCP transport populates these. See migration 0049.
    actorKind: text("actor_kind"),
    clientId: text("client_id"),
    toolName: text("tool_name"),
    // #2519 — cross-environment audit linkage (PRD #2515 slice 4).
    // NULL for single-env executions; on fanout, one parent row carries
    // NULL and N child rows reference the parent's id. ON DELETE SET
    // NULL so retention purge of the parent leaves the per-env children
    // attributable. See migration 0074.
    parentAuditId: uuid("parent_audit_id"),
  },
  (t) => [
    index("idx_audit_log_timestamp").on(t.timestamp),
    index("idx_audit_log_user_id").on(t.userId),
    index("idx_audit_log_source_id").on(t.sourceId),
    index("idx_audit_log_tables_accessed").using("gin", t.tablesAccessed),
    index("idx_audit_log_columns_accessed").using("gin", t.columnsAccessed),
    index("idx_audit_log_org").on(t.orgId),
    index("idx_audit_log_deleted_at").on(t.deletedAt).where(sql`deleted_at IS NOT NULL`),
    index("idx_audit_log_org_actor_ts").on(t.orgId, t.actorKind, t.timestamp.desc())
      .where(sql`actor_kind IS NOT NULL`),
    index("idx_audit_log_client_id").on(t.clientId).where(sql`client_id IS NOT NULL`),
    index("idx_audit_log_parent_audit_id").on(t.parentAuditId).where(sql`parent_audit_id IS NOT NULL`),
    foreignKey({
      columns: [t.parentAuditId],
      foreignColumns: [t.id],
      name: "audit_log_parent_audit_id_fkey",
    }).onDelete("set null"),
    check("chk_audit_log_actor_kind", sql`actor_kind IS NULL OR actor_kind IN ('human', 'agent', 'mcp', 'scheduler')`),
    check("chk_audit_log_auth_mode", sql`auth_mode IN ('none', 'simple-key', 'managed', 'byot')`),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id"),
    title: text("title"),
    surface: text("surface").default("web"),
    connectionId: text("connection_id"),
    // 0067 — group-aware routing (#2345). `connection_id` is the
    // execution target (which replica SQL runs against);
    // `connection_group_id` is the content scope (which group's
    // entities, dashboards, etc. resolve). Two columns, two purposes —
    // they are deliberately decoupled.
    connectionGroupId: text("connection_group_id"),
    // 0077 — three-state Auto/Pin/All picker state (#2518). NULL is
    // read as "pin" by the runtime so pre-#2518 conversations whose
    // `connection_id` already names a single member keep their
    // single-execution behavior. Validation lives in the chat route's
    // Zod schema (single source of truth) rather than a CHECK here.
    routingMode: text("routing_mode"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    // Saved/starred
    starred: boolean("starred").notNull().default(false),
    // Sharing
    shareToken: varchar("share_token", { length: 64 }),
    shareExpiresAt: timestamp("share_expires_at", { withTimezone: true }),
    shareMode: varchar("share_mode", { length: 10 }).notNull().default("public"),
    // Notebook
    notebookState: jsonb("notebook_state"),
    // Org scoping
    orgId: text("org_id"),
    // Soft-delete
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // F-77 per-conversation aggregate step counter. Incremented after every
    // agent run by `result.steps.length`. Once it crosses
    // ATLAS_CONVERSATION_STEP_CAP the chat handler rejects further messages
    // with `conversation_budget_exceeded` and the UI surfaces a
    // start-a-new-conversation affordance.
    totalSteps: integer("total_steps").notNull().default(0),
    // 0073 — #2363 chat-as-dashboard-editor. When the chat drawer opens on
    // `/dashboards/[id]` the request body supplies `boundDashboardId` and
    // the conversation is stamped to that dashboard for its lifetime.
    // Nullable so existing rows + non-drawer chats stay untouched.
    // ON DELETE SET NULL keeps the audit trail when a dashboard is removed.
    boundDashboardId: uuid("bound_dashboard_id").references(() => dashboards.id, { onDelete: "set null" }),
  },
  (t) => [
    index("idx_conversations_user").on(t.userId),
    index("idx_conversations_starred").on(t.userId, t.starred).where(sql`starred = true`),
    uniqueIndex("idx_conversations_share_token").on(t.shareToken).where(sql`share_token IS NOT NULL`),
    check("chk_share_mode", sql`share_mode IN ('public', 'org')`),
    // share_mode='org' without an org_id is the F-01 bug class — see #1737 / 0034.
    check("chk_org_scoped_share", sql`share_mode <> 'org' OR org_id IS NOT NULL`),
    index("idx_conversations_org").on(t.orgId),
    index("idx_conversations_group").on(t.connectionGroupId, t.orgId),
    index("idx_conversations_bound_dashboard").on(t.boundDashboardId).where(sql`bound_dashboard_id IS NOT NULL`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_messages_conversation").on(t.conversationId),
  ],
);

// ---------------------------------------------------------------------------
// Slack integration
// ---------------------------------------------------------------------------

export const slackInstallations = pgTable(
  "slack_installations",
  {
    teamId: text("team_id").primaryKey(),
    botTokenEncrypted: text("bot_token_encrypted").notNull(),
    // F-47 key version for `bot_token_encrypted`.
    botTokenKeyVersion: integer("bot_token_key_version").notNull().default(1),
    orgId: text("org_id"),
    workspaceName: text("workspace_name"),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_slack_installations_org").on(t.orgId),
  ],
);

export const slackThreads = pgTable(
  "slack_threads",
  {
    threadTs: text("thread_ts").notNull(),
    channelId: text("channel_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.threadTs, t.channelId] }),
    index("idx_slack_threads_conversation").on(t.conversationId),
  ],
);

// ---------------------------------------------------------------------------
// Action framework
// ---------------------------------------------------------------------------

export const actionLog = pgTable(
  "action_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    requestedBy: text("requested_by"),
    approvedBy: text("approved_by"),
    authMode: text("auth_mode").notNull(),
    actionType: text("action_type").notNull(),
    target: text("target").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    result: jsonb("result"),
    error: text("error"),
    rollbackInfo: jsonb("rollback_info"),
    conversationId: uuid("conversation_id"),
    requestId: text("request_id"),
    // Org scoping
    orgId: text("org_id"),
  },
  (t) => [
    index("idx_action_log_requested_by").on(t.requestedBy),
    index("idx_action_log_status").on(t.status),
    index("idx_action_log_action_type").on(t.actionType),
    index("idx_action_log_conversation").on(t.conversationId),
    index("idx_action_log_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Connection groups — multi-environment semantic layer
// ---------------------------------------------------------------------------
//
// Declared above `connections` so the composite FK on `connections.group_id`
// can name `connectionGroups` directly; the chronological-by-introduction
// ordering of this file is a soft convention, not a runtime requirement.

export const connectionGroups = pgTable(
  "connection_groups",
  {
    id: text("id").notNull(),
    orgId: text("org_id").notNull().default("__global__"),
    name: text("name").notNull(),
    // Admin-pinned primary member. NULL = "use first member by
    // (created_at, id)" — see lib/dashboards-group-resolve.ts. 0066
    // introduces this for group-scoped dashboard cards (#2342).
    //
    // The DB enforces a composite FK `(primary_connection_id, org_id)
    // → connections(id, org_id)` so the primary stays org-isolated.
    // The FK is declared in the migration only — drizzle's declaration
    // order forbids referencing `connections` from this earlier table
    // (forward reference at module eval time). The smoke test in
    // `migrate-pg.test.ts` pins the FK shape so drift here surfaces
    // explicitly rather than as a silently dropped constraint.
    primaryConnectionId: text("primary_connection_id"),
    // 0071 — group lifecycle. `active` = normal; `archived` = retired
    // region (cascade ran). See PRD #2336 § "Phase 4 archive cascade"
    // and the POST /admin/connection-groups/:id/archive route.
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.orgId] }),
    index("idx_connection_groups_org").on(t.orgId),
    uniqueIndex("uq_connection_groups_org_name").on(t.orgId, t.name),
    index("idx_connection_groups_primary").on(t.primaryConnectionId, t.orgId),
    // 0071 — partial index supports the list handler's hot path
    // (`WHERE org_id = $1 AND status = 'active'`).
    index("idx_connection_groups_active").on(t.orgId).where(sql`status = 'active'`),
    check("chk_connection_groups_status", sql`status IN ('active', 'archived')`),
  ],
);

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    question: text("question").notNull(),
    cronExpression: text("cron_expression").notNull(),
    deliveryChannel: text("delivery_channel").notNull().default("webhook"),
    recipients: jsonb("recipients").notNull().default(sql`'[]'`),
    // 0068/0069 — group-scoped scheduling (#2343/#2347). New rows
    // scope to a connection group; the legacy content-scope
    // connection_id column was removed in 0069.
    connectionGroupId: text("connection_group_id"),
    approvalMode: text("approval_mode").notNull().default("auto"),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Org scoping
    orgId: text("org_id"),
    // Plugin ownership (#1987). NULL → user-created task. Non-NULL → matches
    // workspace_plugins.catalog_id; uninstall scopes cleanup by (plugin_id, org_id).
    pluginId: text("plugin_id"),
  },
  (t) => [
    index("idx_scheduled_tasks_owner").on(t.ownerId),
    index("idx_scheduled_tasks_enabled").on(t.enabled).where(sql`enabled = true`),
    index("idx_scheduled_tasks_next_run").on(t.nextRunAt).where(sql`enabled = true`),
    index("idx_scheduled_tasks_org").on(t.orgId),
    index("idx_scheduled_tasks_group").on(t.orgId, t.connectionGroupId),
    index("idx_scheduled_tasks_plugin_org").on(t.pluginId, t.orgId).where(sql`plugin_id IS NOT NULL`),
    foreignKey({
      columns: [t.connectionGroupId, t.orgId],
      foreignColumns: [connectionGroups.id, connectionGroups.orgId],
      name: "fk_scheduled_tasks_group",
    }).onDelete("restrict"),
  ],
);

export const scheduledTaskRuns = pgTable(
  "scheduled_task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => scheduledTasks.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: text("status").notNull().default("running"),
    conversationId: uuid("conversation_id"),
    actionId: uuid("action_id"),
    error: text("error"),
    tokensUsed: integer("tokens_used"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Delivery tracking
    deliveryStatus: text("delivery_status"),
    deliveryError: text("delivery_error"),
  },
  (t) => [
    index("idx_scheduled_task_runs_task").on(t.taskId),
    index("idx_scheduled_task_runs_status").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Admin-managed connections
// ---------------------------------------------------------------------------

export const connections = pgTable(
  "connections",
  {
    id: text("id").notNull(),
    url: text("url").notNull(),
    // F-47: encryption key version for `url`. Populated by app code on
    // write with the active keyset version; read by the rotation script
    // to identify rows below the active version.
    urlKeyVersion: integer("url_key_version").notNull().default(1),
    type: text("type").notNull(),
    description: text("description"),
    schemaName: text("schema_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    // Org scoping — composite PK with id
    orgId: text("org_id").notNull().default("__global__"),
    // Developer/published mode status
    status: text("status").notNull().default("published"),
    // Connection group membership (multi-environment semantic layer).
    // Required after 0069; existing rows are repaired into a
    // single-member group before the NOT NULL constraint is applied.
    groupId: text("group_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.orgId] }),
    index("idx_connections_org").on(t.orgId),
    index("idx_connections_group").on(t.groupId, t.orgId),
    // Composite FK so a connection can never reference a group in a
    // different org. ON DELETE RESTRICT: the DELETE handler already
    // rejects non-empty groups with a typed 409; the FK is the
    // last-resort defence against raw-SQL or test-path bypasses. SET NULL
    // would have been the friendlier action, but PG nulls every column
    // in a composite FK on cascade and `connections.org_id` is NOT NULL.
    foreignKey({
      columns: [t.groupId, t.orgId],
      foreignColumns: [connectionGroups.id, connectionGroups.orgId],
      name: "fk_connections_group",
    }).onDelete("restrict"),
    check("chk_connections_status", sql`status IN ('published', 'draft', 'archived')`),
  ],
);

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export const tokenUsage = pgTable(
  "token_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id"),
    conversationId: text("conversation_id"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    model: text("model"),
    provider: text("provider"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Org scoping
    orgId: text("org_id"),
  },
  (t) => [
    index("idx_token_usage_user_id").on(t.userId),
    index("idx_token_usage_created_at").on(t.createdAt),
    index("idx_token_usage_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    token: text("token").notNull().unique(),
    status: text("status").notNull().default("pending"),
    invitedBy: text("invited_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Org scoping
    orgId: text("org_id"),
  },
  (t) => [
    index("idx_invitations_email").on(t.email),
    index("idx_invitations_token").on(t.token),
    index("idx_invitations_status").on(t.status),
    uniqueIndex("idx_invitations_pending_email").on(t.email, t.orgId).where(sql`status = 'pending'`),
    index("idx_invitations_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Plugin & application settings
// ---------------------------------------------------------------------------

export const pluginSettings = pgTable("plugin_settings", {
  pluginId: text("plugin_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Org scoping
  orgId: text("org_id"),
});

export const settings = pgTable(
  "settings",
  {
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
    orgId: text("org_id"),
  },
  (t) => [
    // Replaces the original PK. Global settings: one row per key where org_id IS NULL.
    // Per-org overrides: one row per (key, org_id) pair.
    uniqueIndex("uq_settings_key_global").on(t.key).where(sql`org_id IS NULL`),
    uniqueIndex("uq_settings_key_org").on(t.key, t.orgId).where(sql`org_id IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Semantic entities (DB-backed semantic layer)
// ---------------------------------------------------------------------------

export const semanticEntities = pgTable(
  "semantic_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    entityType: text("entity_type").notNull(),
    name: text("name").notNull(),
    yamlContent: text("yaml_content").notNull(),
    // Group scope (multi-environment semantic layer, #2340). One row
    // per (org_id, entity_type, name, group_id) — multi-member groups
    // share the same entity definition. Nullable so legacy
    // `__global__` demo entities (connection_id IS NULL too) stay
    // unique through the COALESCE sentinel in the partial indexes
    // below.
    connectionGroupId: text("connection_group_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Developer/published mode status
    status: text("status").notNull().default("published"),
  },
  (t) => [
    uniqueIndex("idx_semantic_entities_org_type_name").on(t.orgId, t.entityType, t.name),
    index("idx_semantic_entities_org").on(t.orgId),
    index("idx_semantic_entities_org_type").on(t.orgId, t.entityType),
    index("idx_semantic_entities_group").on(t.connectionGroupId, t.orgId),
    check("chk_semantic_entities_status", sql`status IN ('published', 'draft', 'draft_delete', 'archived')`),
    // IMPORTANT: These are placeholder stubs — the real indexes are UNIQUE on
    // (org_id, entity_type, name, COALESCE(connection_group_id, '__default__')) and
    // are managed by raw SQL in migration 0063 (which superseded 0028's
    // connection_id-keyed indexes). Drizzle can't represent expression
    // indexes, so these non-unique approximations exist solely to
    // suppress drift warnings. Do NOT rely on these for constraint
    // reasoning — and any code calling `ON CONFLICT (...)` against
    // these indexes must include `entity_type` in the conflict-target
    // column list, otherwise Postgres raises "no unique or exclusion
    // constraint matching the ON CONFLICT specification" and the
    // upsert silently fails.
    index("uq_semantic_entity_published").on(t.orgId, t.entityType, t.name, t.connectionGroupId).where(sql`status = 'published'`),
    index("uq_semantic_entity_draft").on(t.orgId, t.entityType, t.name, t.connectionGroupId).where(sql`status = 'draft'`),
    index("uq_semantic_entity_tombstone").on(t.orgId, t.entityType, t.name, t.connectionGroupId).where(sql`status = 'draft_delete'`),
  ],
);

// ---------------------------------------------------------------------------
// Semantic entity versions (version history for rollback + diff)
// ---------------------------------------------------------------------------

export const semanticEntityVersions = pgTable(
  "semantic_entity_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id").notNull().references(() => semanticEntities.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    entityType: text("entity_type").notNull(),
    name: text("name").notNull(),
    yamlContent: text("yaml_content").notNull(),
    changeSummary: text("change_summary"),
    authorId: text("author_id"),
    authorLabel: text("author_label"),
    versionNumber: integer("version_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_sev_entity").on(t.entityId),
    index("idx_sev_org_type_name").on(t.orgId, t.entityType, t.name),
    index("idx_sev_created").on(t.entityId, sql`created_at DESC`),
    uniqueIndex("idx_sev_entity_version").on(t.entityId, t.versionNumber),
  ],
);

// ---------------------------------------------------------------------------
// Learned patterns (dynamic learning layer)
// ---------------------------------------------------------------------------

export const learnedPatterns = pgTable(
  "learned_patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id"),
    patternSql: text("pattern_sql").notNull(),
    description: text("description"),
    sourceEntity: text("source_entity"),
    sourceQueries: jsonb("source_queries"),
    confidence: real("confidence").notNull().default(0.1),
    repetitionCount: integer("repetition_count").notNull().default(1),
    status: text("status").notNull().default("pending"),
    proposedBy: text("proposed_by"),
    reviewedBy: text("reviewed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    type: text("type").notNull().default("query_pattern"),
    amendmentPayload: jsonb("amendment_payload"),
  },
  (t) => [
    index("idx_learned_patterns_org_status").on(t.orgId, t.status),
    index("idx_learned_patterns_org_entity").on(t.orgId, t.sourceEntity),
    index("idx_learned_patterns_type").on(t.type),
  ],
);

// ---------------------------------------------------------------------------
// Prompt library
// ---------------------------------------------------------------------------

export const promptCollections = pgTable(
  "prompt_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id"),
    name: text("name").notNull(),
    industry: text("industry").notNull(),
    description: text("description").notNull().default(""),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Developer/published mode status
    status: text("status").notNull().default("published"),
  },
  (t) => [
    index("idx_prompt_collections_org").on(t.orgId),
    index("idx_prompt_collections_builtin").on(t.isBuiltin).where(sql`is_builtin = true`),
    check("chk_prompt_collections_status", sql`status IN ('published', 'draft', 'archived')`),
    // #2169: collapse org_id NULL into a single bucket so globals can't
    // duplicate, and lower-case the name so casing variants can't coexist
    // within the same workspace. The `COALESCE(org_id, '')` form is
    // load-bearing — a plain `(org_id, lower(name))` would let multiple
    // global rows (org_id IS NULL) share a name, since SQL treats NULLs
    // as distinct in unique indexes. Removing this index reopens the
    // duplicate-libraries bug. See migration 0054 for the dedup +
    // index-creation migration.
    uniqueIndex("prompt_collections_org_name_uniq").on(
      sql`COALESCE(${t.orgId}, '')`,
      sql`lower(${t.name})`,
    ),
  ],
);

export const promptItems = pgTable(
  "prompt_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionId: uuid("collection_id").notNull().references(() => promptCollections.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    description: text("description"),
    category: text("category"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_prompt_items_collection").on(t.collectionId),
  ],
);

export const userFavoritePrompts = pgTable(
  "user_favorite_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    text: text("text").notNull(),
    position: doublePrecision("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Prevent the same user from pinning the same text twice in a workspace.
    // md5() wrap keeps the btree key short so long messages don't blow the
    // 8191-byte page-tuple limit. See migration 0029.
    uniqueIndex("uq_user_favorite_prompts").on(t.userId, t.orgId, sql`md5(${t.text})`),
    index("idx_user_favorite_prompts_user_org").on(t.userId, t.orgId, t.position.desc(), t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// Trusted devices — per-user 2FA trust grants. See migration 0048.
// ---------------------------------------------------------------------------

export const trustedDevice = pgTable(
  "trusted_device",
  {
    // Matches Better Auth's `verification.identifier` (the trust-device cookie payload).
    identifier: text("identifier").primaryKey(),
    // FK to "user"(id) ON DELETE CASCADE is enforced in the migration —
    // Drizzle's `references()` would require Better Auth's `user` table to
    // be defined in this schema, which it isn't. Plain text() matches.
    userId: text("user_id").notNull(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    deviceLabel: text("device_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_trusted_device_user_id_created_at").on(t.userId, t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// Query suggestions
// ---------------------------------------------------------------------------

export const querySuggestions = pgTable(
  "query_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id"),
    description: text("description").notNull(),
    patternSql: text("pattern_sql").notNull(),
    normalizedHash: text("normalized_hash").notNull(),
    tablesInvolved: jsonb("tables_involved").notNull().default(sql`'[]'`),
    primaryTable: text("primary_table"),
    frequency: integer("frequency").notNull().default(1),
    clickedCount: integer("clicked_count").notNull().default(0),
    score: real("score").notNull().default(0),
    // CHECK constraint in the migration restricts values to the
    // SuggestionApprovalStatus / SuggestionStatus enum sets. The `$type`
    // on the Drizzle column tightens the ORM's inferred type to match.
    approvalStatus: text("approval_status")
      .$type<import("@useatlas/types").SuggestionApprovalStatus>()
      .notNull()
      .default("pending"),
    status: text("status")
      .$type<import("@useatlas/types").SuggestionStatus>()
      .notNull()
      .default("draft"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    distinctUserClicks: integer("distinct_user_clicks").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // UNIQUE NULLS NOT DISTINCT — requires PostgreSQL 15+
    // Handled via raw SQL in migration since Drizzle doesn't support NULLS NOT DISTINCT
    index("idx_query_suggestions_org_table").on(t.orgId, t.primaryTable),
    index("idx_query_suggestions_org_score").on(t.orgId, sql`score DESC`),
    index("idx_query_suggestions_tables").using("gin", t.tablesInvolved),
    index("idx_query_suggestions_approval_queue").on(t.orgId, t.approvalStatus, sql`last_seen_at DESC`),
  ],
);

// ---------------------------------------------------------------------------
// Starter-prompt moderation — distinct-user click tracking
// ---------------------------------------------------------------------------

export const suggestionUserClicks = pgTable(
  "suggestion_user_clicks",
  {
    suggestionId: uuid("suggestion_id")
      .notNull()
      .references(() => querySuggestions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    firstClickedAt: timestamp("first_clicked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.suggestionId, t.userId] }),
    index("idx_suggestion_user_clicks_suggestion_clicked").on(t.suggestionId, sql`first_clicked_at DESC`),
  ],
);

// ---------------------------------------------------------------------------
// Usage metering
// ---------------------------------------------------------------------------

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id"),
    userId: text("user_id"),
    eventType: text("event_type").notNull(),
    quantity: integer("quantity").notNull().default(1),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_usage_events_workspace").on(t.workspaceId, t.createdAt),
    index("idx_usage_events_type").on(t.eventType, t.createdAt),
    index("idx_usage_events_user").on(t.userId, t.createdAt),
  ],
);

export const usageSummaries = pgTable(
  "usage_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    period: text("period").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    queryCount: integer("query_count").notNull().default(0),
    tokenCount: integer("token_count").notNull().default(0),
    activeUsers: integer("active_users").notNull().default(0),
    storageBytes: bigint("storage_bytes", { mode: "bigint" }).notNull().default(BigInt(0)),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_usage_summaries_ws_period").on(t.workspaceId, t.period, t.periodStart),
    index("idx_usage_summaries_workspace").on(t.workspaceId, t.periodStart),
  ],
);

// ---------------------------------------------------------------------------
// Enterprise SSO providers
// ---------------------------------------------------------------------------

export const ssoProviders = pgTable(
  "sso_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    type: text("type").notNull(),
    issuer: text("issuer").notNull(),
    domain: text("domain").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    config: jsonb("config").notNull().default(sql`'{}'`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ssoEnforced: boolean("sso_enforced").notNull().default(false),
    verificationToken: text("verification_token"),
    domainVerified: boolean("domain_verified").notNull().default(false),
    domainVerifiedAt: timestamp("domain_verified_at", { withTimezone: true }),
    domainVerificationStatus: text("domain_verification_status").notNull().default("pending"),
  },
  (t) => [
    check("chk_sso_type", sql`type IN ('saml', 'oidc')`),
    check("chk_domain_verification_status", sql`domain_verification_status IN ('pending', 'verified', 'failed')`),
    check("chk_enabled_requires_verified", sql`NOT enabled OR domain_verified`),
    index("idx_sso_providers_org").on(t.orgId),
    uniqueIndex("idx_sso_providers_domain").on(t.domain),
    index("idx_sso_providers_enabled").on(t.orgId, t.enabled).where(sql`enabled = true`),
  ],
);

// ---------------------------------------------------------------------------
// Demo leads
// ---------------------------------------------------------------------------

export const demoLeads = pgTable(
  "demo_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
    sessionCount: integer("session_count").notNull().default(1),
  },
  (t) => [
    index("idx_demo_leads_created").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Enterprise IP allowlist
// ---------------------------------------------------------------------------

export const ipAllowlist = pgTable(
  "ip_allowlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    cidr: text("cidr").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("ip_allowlist_org_id_cidr_unique").on(t.orgId, t.cidr),
    index("idx_ip_allowlist_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Enterprise custom roles
// ---------------------------------------------------------------------------

export const customRoles = pgTable(
  "custom_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    permissions: jsonb("permissions").notNull().default(sql`'[]'`),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_custom_roles_org_name").on(t.orgId, t.name),
    index("idx_custom_roles_org").on(t.orgId),
    index("idx_custom_roles_builtin").on(t.isBuiltin).where(sql`is_builtin = true`),
  ],
);

// ---------------------------------------------------------------------------
// User onboarding
// ---------------------------------------------------------------------------

export const userOnboarding = pgTable("user_onboarding", {
  userId: text("user_id").primaryKey(),
  tourCompletedAt: timestamp("tour_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Audit retention config
// ---------------------------------------------------------------------------

export const auditRetentionConfig = pgTable(
  "audit_retention_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull().unique(),
    // Default 365 days mirrors migration 0042 (#1927). The DB default and
    // this Drizzle declaration must agree — otherwise `drizzle-kit generate`
    // would emit a migration to remove the DEFAULT on the next schema diff.
    retentionDays: integer("retention_days").default(365),
    hardDeleteDelayDays: integer("hard_delete_delay_days").notNull().default(30),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
    lastPurgeAt: timestamp("last_purge_at", { withTimezone: true }),
    lastPurgeCount: integer("last_purge_count"),
  },
  (t) => [
    index("idx_audit_retention_config_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Workspace model config
// ---------------------------------------------------------------------------

export const workspaceModelConfig = pgTable(
  "workspace_model_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull().unique(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // Nullable for provider='gateway' on platform credits (no BYOT key).
    // For provider='bedrock' this holds an encrypted JSON blob shaped as
    // `{ accessKeyId, secretAccessKey, sessionToken? }`.
    apiKeyEncrypted: text("api_key_encrypted"),
    // F-47 key version. When `api_key_encrypted` is NULL the version is unused —
    // `decryptSecret` is never called against a null column.
    apiKeyKeyVersion: integer("api_key_key_version").notNull().default(1),
    baseUrl: text("base_url"),
    // AWS region for provider='bedrock'. Required when bedrock is the
    // provider (enforced by chk_model_provider_region); NULL for every
    // other provider.
    bedrockRegion: text("bedrock_region"),
    // Deprecation tracking. Flipped to 'deprecated' after a BYOT
    // catalog refresh discovers the saved model is no longer surfaced
    // upstream. Reset to 'healthy' on every successful save.
    modelStatus: text("model_status").notNull().default("healthy"),
    modelSuggestedReplacement: text("model_suggested_replacement"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "chk_model_provider",
      sql`provider IN ('anthropic', 'openai', 'azure-openai', 'custom', 'gateway', 'bedrock')`,
    ),
    check(
      "chk_model_provider_key",
      sql`provider = 'gateway' OR api_key_encrypted IS NOT NULL`,
    ),
    check(
      "chk_model_provider_region",
      sql`provider != 'bedrock' OR bedrock_region IS NOT NULL`,
    ),
    check(
      "chk_model_status",
      sql`model_status IN ('healthy', 'deprecated')`,
    ),
    index("idx_workspace_model_config_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// BYOT model catalog cache — L2 to per-pod in-memory caches.
//
// Operational cache, not user-surfaced content — intentionally bypasses
// the mode system. The `gateway` provider is excluded because that
// catalog is anonymous + globally cached server-side.
// ---------------------------------------------------------------------------

export const workspaceModelCatalog = pgTable(
  "workspace_model_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    provider: text("provider").notNull(),
    region: text("region").notNull().default(""),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "chk_workspace_model_catalog_provider",
      sql`provider IN ('anthropic', 'openai', 'bedrock')`,
    ),
    uniqueIndex("uq_workspace_model_catalog_org_provider_region").on(
      t.orgId,
      t.provider,
      t.region,
    ),
    index("idx_workspace_model_catalog_org_provider").on(t.orgId, t.provider),
    index("idx_workspace_model_catalog_fetched_at").on(t.fetchedAt),
  ],
);

// ---------------------------------------------------------------------------
// Approval workflows
// ---------------------------------------------------------------------------

export const approvalRules = pgTable(
  "approval_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    ruleType: text("rule_type").notNull(),
    pattern: text("pattern").notNull().default(""),
    threshold: integer("threshold"),
    enabled: boolean("enabled").notNull().default(true),
    // #2072 — surface scoping. 'any' preserves pre-2072 fires-everywhere
    // semantics; the other values pin a rule to a single transport.
    surface: text("surface").notNull().default("any"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("chk_approval_rule_type", sql`rule_type IN ('table', 'column', 'cost')`),
    check(
      "chk_approval_rule_surface",
      sql`surface IN ('any', 'chat', 'mcp', 'scheduler', 'slack', 'teams', 'webhook')`,
    ),
    index("idx_approval_rules_org").on(t.orgId),
    index("idx_approval_rules_org_enabled").on(t.orgId).where(sql`enabled = true`),
    index("idx_approval_rules_org_surface").on(t.orgId, t.surface),
  ],
);

export const approvalQueue = pgTable(
  "approval_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    ruleId: uuid("rule_id").notNull(),
    ruleName: text("rule_name").notNull(),
    requesterId: text("requester_id").notNull(),
    requesterEmail: text("requester_email"),
    querySql: text("query_sql").notNull(),
    explanation: text("explanation"),
    // #2344 — group scope. Nullable during the transition; backfilled
    // from `connections.group_id` via 0062's 1:1 map. Composite FK to
    // (connection_groups.id, connection_groups.orgId) so a row cannot
    // reference a group in a different org. ON DELETE RESTRICT mirrors
    // `connections.group_id` and forces admins to expire / reject the
    // queue before tearing down the group.
    connectionGroupId: text("connection_group_id"),
    tablesAccessed: jsonb("tables_accessed").default(sql`'[]'`),
    columnsAccessed: jsonb("columns_accessed").default(sql`'[]'`),
    status: text("status").notNull().default("pending"),
    reviewerId: text("reviewer_id"),
    reviewerEmail: text("reviewer_email"),
    reviewComment: text("review_comment"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // #2072 — origin surface stamped at request creation. NULL for legacy
    // rows / callers that didn't bind a surface; only chat / mcp / scheduler
    // / slack / teams / webhook for new rows.
    surface: text("surface"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    check("chk_approval_status", sql`status IN ('pending', 'approved', 'denied', 'expired')`),
    check(
      "chk_approval_request_surface",
      sql`surface IS NULL OR surface IN ('chat', 'mcp', 'scheduler', 'slack', 'teams', 'webhook')`,
    ),
    foreignKey({
      columns: [t.connectionGroupId, t.orgId],
      foreignColumns: [connectionGroups.id, connectionGroups.orgId],
      name: "fk_approval_queue_group",
    }).onDelete("restrict"),
    index("idx_approval_queue_org_status").on(t.orgId, t.status),
    index("idx_approval_queue_expires").on(t.expiresAt).where(sql`status = 'pending'`),
    index("idx_approval_queue_requester").on(t.requesterId),
    // #2344 — partial index covers the hasApprovedRequest hot path.
    index("idx_approval_queue_group")
      .on(t.orgId, t.connectionGroupId, t.requesterId)
      .where(sql`status = 'approved'`),
  ],
);

// ---------------------------------------------------------------------------
// Workspace branding
// ---------------------------------------------------------------------------

export const workspaceBranding = pgTable(
  "workspace_branding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull().unique(),
    logoUrl: text("logo_url"),
    logoText: text("logo_text"),
    primaryColor: text("primary_color"),
    faviconUrl: text("favicon_url"),
    hideAtlasBranding: boolean("hide_atlas_branding").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_workspace_branding_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Onboarding emails
// ---------------------------------------------------------------------------

export const onboardingEmails = pgTable(
  "onboarding_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    step: text("step").notNull(),
    triggeredBy: text("triggered_by").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_onboarding_emails_user_step").on(t.userId, t.step),
    index("idx_onboarding_emails_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Email preferences
// ---------------------------------------------------------------------------

export const emailPreferences = pgTable("email_preferences", {
  userId: text("user_id").primaryKey(),
  onboardingEmails: boolean("onboarding_emails").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Abuse prevention
// ---------------------------------------------------------------------------

export const abuseEvents = pgTable(
  "abuse_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    level: text("level").notNull(),
    triggerType: text("trigger_type").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'`),
    actor: text("actor").notNull().default("system"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_abuse_events_workspace").on(t.workspaceId, t.createdAt),
    index("idx_abuse_events_level").on(t.level),
  ],
);

// ---------------------------------------------------------------------------
// Custom domains
// ---------------------------------------------------------------------------

export const customDomains = pgTable(
  "custom_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    domain: text("domain").notNull().unique(),
    status: text("status").notNull().default("pending"),
    railwayDomainId: text("railway_domain_id"),
    cnameTarget: text("cname_target"),
    certificateStatus: text("certificate_status"),
    // DNS TXT ownership verification — mirrors sso_providers (migration 0022).
    // Written by ee/src/platform/domains.ts (registerDomain + verifyDomainDnsTxt)
    // and read by rowToDomain + hasVerifiedCustomDomain.
    verificationToken: text("verification_token"),
    domainVerified: boolean("domain_verified").notNull().default(false),
    domainVerifiedAt: timestamp("domain_verified_at", { withTimezone: true }),
    domainVerificationStatus: text("domain_verification_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [
    check("chk_domain_status", sql`status IN ('pending', 'verified', 'failed')`),
    check(
      "chk_custom_domain_verification_status",
      sql`domain_verification_status IN ('pending', 'verified', 'failed')`,
    ),
    index("idx_custom_domains_workspace").on(t.workspaceId),
    index("idx_custom_domains_status").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// EE: Backups
// ---------------------------------------------------------------------------

export const backups = pgTable(
  "backups",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }),
    status: text("status").notNull().default("in_progress"),
    storagePath: text("storage_path").notNull(),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
    errorMessage: text("error_message"),
  },
  (t) => [
    index("idx_backups_status").on(t.status, sql`created_at DESC`),
  ],
);

export const backupConfig = pgTable("backup_config", {
  id: text("id").primaryKey().default("_default"),
  schedule: text("schedule").notNull().default("0 3 * * *"),
  retentionDays: integer("retention_days").notNull().default(30),
  storagePath: text("storage_path").notNull().default("./backups"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// EE: PII column classifications (compliance/masking)
// ---------------------------------------------------------------------------

export const piiColumnClassifications = pgTable(
  "pii_column_classifications",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    orgId: text("org_id").notNull(),
    tableName: text("table_name").notNull(),
    columnName: text("column_name").notNull(),
    // Group scope (#2341). One row per (org_id, table_name, column_name,
    // group_id) — multi-member groups share the same classification
    // (replicas inside a group share schema, so the column's PII
    // category is the same across all members). Nullable for legacy
    // rows whose connection_id no longer resolves to a live connection;
    // those rows live in the COALESCE sentinel bucket.
    connectionGroupId: text("connection_group_id"),
    category: text("category").notNull(),
    confidence: text("confidence").notNull().default("medium"),
    maskingStrategy: text("masking_strategy").notNull().default("partial"),
    reviewed: boolean("reviewed").notNull().default(false),
    dismissed: boolean("dismissed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_pii_column_classifications_group").on(t.connectionGroupId, t.orgId),
    // IMPORTANT: placeholder stub — the real index is UNIQUE on
    // (org_id, table_name, column_name, COALESCE(connection_group_id,
    // '__default__')) and is managed by raw SQL in migration 0064.
    // Drizzle can't represent COALESCE expression indexes, so this
    // non-unique approximation exists solely to suppress drift warnings.
    // Do NOT rely on this for constraint reasoning. Callers using `ON
    // CONFLICT` must target the COALESCE expression, not the column.
    index("pii_column_classifications_unique").on(t.orgId, t.tableName, t.columnName, t.connectionGroupId),
  ],
);

// ---------------------------------------------------------------------------
// EE: SCIM group mappings
// ---------------------------------------------------------------------------

export const scimGroupMappings = pgTable(
  "scim_group_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    scimGroupName: text("scim_group_name").notNull(),
    roleName: text("role_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("scim_group_mappings_org_group").on(t.orgId, t.scimGroupName),
  ],
);

// ---------------------------------------------------------------------------
// EE: SLA metrics
// ---------------------------------------------------------------------------

export const slaMetrics = pgTable(
  "sla_metrics",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    workspaceId: text("workspace_id").notNull(),
    latencyMs: doublePrecision("latency_ms").notNull(),
    isError: boolean("is_error").notNull().default(false),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_sla_metrics_ws_time").on(t.workspaceId, sql`recorded_at DESC`),
  ],
);

export const slaAlerts = pgTable(
  "sla_alerts",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    workspaceId: text("workspace_id").notNull(),
    alertType: text("alert_type").notNull(),
    status: text("status").notNull().default("firing"),
    currentValue: doublePrecision("current_value").notNull(),
    threshold: doublePrecision("threshold").notNull(),
    message: text("message").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
  },
  (t) => [
    index("idx_sla_alerts_ws").on(t.workspaceId, t.status),
  ],
);

export const slaThresholds = pgTable("sla_thresholds", {
  workspaceId: text("workspace_id").primaryKey(),
  latencyP99Ms: doublePrecision("latency_p99_ms").notNull().default(5000),
  errorRatePct: doublePrecision("error_rate_pct").notNull().default(5),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Teams integration (0001_teams_installations.sql)
// ---------------------------------------------------------------------------

export const teamsInstallations = pgTable(
  "teams_installations",
  {
    tenantId: text("tenant_id").primaryKey(),
    orgId: text("org_id"),
    tenantName: text("tenant_name"),
    // Stays nullable — admin-consent installs persist no password.
    appPasswordEncrypted: text("app_password_encrypted"),
    // F-47 key version for `app_password_encrypted`.
    appPasswordKeyVersion: integer("app_password_key_version").notNull().default(1),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_teams_installations_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Discord integration (0002_discord_installations.sql)
// ---------------------------------------------------------------------------

export const discordInstallations = pgTable(
  "discord_installations",
  {
    guildId: text("guild_id").primaryKey(),
    orgId: text("org_id"),
    guildName: text("guild_name"),
    // Stays nullable — OAuth installs leave bot_token unset until BYOT supplies it.
    botTokenEncrypted: text("bot_token_encrypted"),
    // F-47 key version for `bot_token_encrypted`.
    botTokenKeyVersion: integer("bot_token_key_version").notNull().default(1),
    applicationId: text("application_id"),
    publicKey: text("public_key"),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_discord_installations_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Telegram integration (0003_telegram_installations.sql)
// ---------------------------------------------------------------------------

export const telegramInstallations = pgTable(
  "telegram_installations",
  {
    botId: text("bot_id").primaryKey(),
    botTokenEncrypted: text("bot_token_encrypted").notNull(),
    // F-47 key version for `bot_token_encrypted`.
    botTokenKeyVersion: integer("bot_token_key_version").notNull().default(1),
    botUsername: text("bot_username"),
    orgId: text("org_id"),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_telegram_installations_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Google Chat integration (0007_gchat_installations.sql)
// ---------------------------------------------------------------------------

export const gchatInstallations = pgTable(
  "gchat_installations",
  {
    projectId: text("project_id").primaryKey(),
    serviceAccountEmail: text("service_account_email").notNull(),
    credentialsJsonEncrypted: text("credentials_json_encrypted").notNull(),
    // F-47 key version for `credentials_json_encrypted`.
    credentialsJsonKeyVersion: integer("credentials_json_key_version").notNull().default(1),
    orgId: text("org_id"),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_gchat_installations_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// GitHub integration (0008_github_installations.sql)
// ---------------------------------------------------------------------------

export const githubInstallations = pgTable(
  "github_installations",
  {
    userId: text("user_id").primaryKey(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    // F-47 key version for `access_token_encrypted`.
    accessTokenKeyVersion: integer("access_token_key_version").notNull().default(1),
    username: text("username"),
    orgId: text("org_id"),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_github_installations_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Linear integration (0009_linear_installations.sql)
// ---------------------------------------------------------------------------

export const linearInstallations = pgTable(
  "linear_installations",
  {
    userId: text("user_id").primaryKey(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    // F-47 key version for `api_key_encrypted`.
    apiKeyKeyVersion: integer("api_key_key_version").notNull().default(1),
    userName: text("user_name"),
    userEmail: text("user_email"),
    orgId: text("org_id"),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_linear_installations_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// WhatsApp integration (0010_whatsapp_installations.sql)
// ---------------------------------------------------------------------------

export const whatsappInstallations = pgTable(
  "whatsapp_installations",
  {
    phoneNumberId: text("phone_number_id").primaryKey(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    // F-47 key version for `access_token_encrypted`.
    accessTokenKeyVersion: integer("access_token_key_version").notNull().default(1),
    displayPhone: text("display_phone"),
    orgId: text("org_id"),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_whatsapp_installations_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Email integration (0011_email_installations.sql)
// ---------------------------------------------------------------------------

export const emailInstallations = pgTable(
  "email_installations",
  {
    configId: text("config_id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    provider: text("provider").notNull(),
    senderAddress: text("sender_address").notNull(),
    // `config_encrypted` carries `encryptSecret(JSON.stringify(config))` —
    // the JSONB sibling was dropped in 0040 once F-41 cleared soak.
    configEncrypted: text("config_encrypted").notNull(),
    // F-47 key version for `config_encrypted`.
    configKeyVersion: integer("config_key_version").notNull().default(1),
    orgId: text("org_id"),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_email_installations_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// OAuth state (0005_oauth_state.sql)
// ---------------------------------------------------------------------------

export const oauthState = pgTable("oauth_state", {
  nonce: text("nonce").primaryKey(),
  orgId: text("org_id"),
  provider: text("provider").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_oauth_state_expires").on(t.expiresAt),
]);

// ---------------------------------------------------------------------------
// Region migrations (0012_region_migrations.sql)
// ---------------------------------------------------------------------------

export const regionMigrations = pgTable(
  "region_migrations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceRegion: text("source_region").notNull(),
    targetRegion: text("target_region").notNull(),
    status: text("status").notNull().default("pending"),
    requestedBy: text("requested_by"),
    errorMessage: text("error_message"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Phase 3 cutover stamps this to TRUE when the destination takes
    // ownership. Read by resetMigrationForRetry() to refuse re-running
    // Phase 1 (export from source) on a workspace that already moved.
    regionUpdated: boolean("region_updated").notNull().default(false),
  },
  (t) => [
    index("idx_region_migrations_workspace").on(t.workspaceId),
    index("idx_region_migrations_status").on(t.status),
    uniqueIndex("idx_region_migrations_one_active")
      .on(t.workspaceId)
      .where(sql`status IN ('pending', 'in_progress')`),
  ],
);

// ---------------------------------------------------------------------------
// Sandbox credentials (0004_sandbox_credentials.sql)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plugin marketplace (0014_plugin_marketplace.sql)
// ---------------------------------------------------------------------------

export const pluginCatalog = pgTable(
  "plugin_catalog",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    type: text("type").notNull(),
    npmPackage: text("npm_package"),
    iconUrl: text("icon_url"),
    configSchema: jsonb("config_schema"),
    minPlan: text("min_plan").notNull().default("starter"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_plugin_catalog_slug").on(t.slug),
    index("idx_plugin_catalog_type").on(t.type),
    index("idx_plugin_catalog_enabled").on(t.enabled).where(sql`enabled = true`),
    check("chk_plugin_catalog_type", sql`type IN ('datasource', 'context', 'interaction', 'action', 'sandbox')`),
  ],
);

export const workspacePlugins = pgTable(
  "workspace_plugins",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    catalogId: text("catalog_id").notNull().references(() => pluginCatalog.id, { onDelete: "cascade" }),
    config: jsonb("config").notNull().default(sql`'{}'`),
    enabled: boolean("enabled").notNull().default(true),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    installedBy: text("installed_by"),
  },
  (t) => [
    uniqueIndex("idx_workspace_plugins_unique").on(t.workspaceId, t.catalogId),
    index("idx_workspace_plugins_workspace").on(t.workspaceId),
    index("idx_workspace_plugins_catalog").on(t.catalogId),
  ],
);

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id"),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // Sharing
    shareToken: varchar("share_token", { length: 64 }),
    shareExpiresAt: timestamp("share_expires_at", { withTimezone: true }),
    shareMode: varchar("share_mode", { length: 10 }).notNull().default("public"),
    // Auto-refresh
    refreshSchedule: text("refresh_schedule"),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    nextRefreshAt: timestamp("next_refresh_at", { withTimezone: true }),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_dashboards_org").on(t.orgId),
    index("idx_dashboards_owner").on(t.ownerId),
    uniqueIndex("idx_dashboards_share_token").on(t.shareToken).where(sql`share_token IS NOT NULL`),
    check("chk_dashboard_share_mode", sql`share_mode IN ('public', 'org')`),
    // share_mode='org' without an org_id is the F-01 bug class — see #1737 / 0034.
    check("chk_org_scoped_share", sql`share_mode <> 'org' OR org_id IS NOT NULL`),
    index("idx_dashboards_next_refresh").on(t.nextRefreshAt).where(sql`refresh_schedule IS NOT NULL AND deleted_at IS NULL`),
  ],
);

export const dashboardCards = pgTable(
  "dashboard_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardId: uuid("dashboard_id").notNull().references(() => dashboards.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    title: text("title").notNull(),
    sql: text("sql").notNull(),
    chartConfig: jsonb("chart_config"),
    cachedColumns: jsonb("cached_columns"),
    cachedRows: jsonb("cached_rows"),
    cachedAt: timestamp("cached_at", { withTimezone: true }),
    // 0066: group-scoped execution. The card's `connection_group_id`
    // resolves to a physical connection at view time via
    // `lib/dashboards-group-resolve.ts` (primary member, or first by
    // `(created_at, id)` if the primary is unset). No FK at the DB
    // layer — `dashboard_cards` doesn't carry its own `org_id`, so a
    // composite FK to `connection_groups (id, org_id)` would either
    // require denormalising org_id or relax to a single-column ref
    // that leaks cross-org. Same trade-off 0063 made for
    // `semantic_entities.connection_group_id`; org scope is enforced
    // one layer up in the route handler.
    connectionGroupId: text("connection_group_id"),
    // NULL = not yet placed; client auto-lays out by `position`.
    layout: jsonb("layout"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_dashboard_cards_dashboard").on(t.dashboardId),
    index("idx_dashboard_cards_position").on(t.dashboardId, t.position),
    index("idx_dashboard_cards_group").on(t.connectionGroupId),
  ],
);

// 0074 — Per-user dashboard drafts (#2364, PRD #2362). Composite PK
// `(user_id, dashboard_id)` enforces "one in-flight draft per editor
// per dashboard"; opening the chat drawer in a new tab UPSERTs onto
// the same row. ON DELETE CASCADE on dashboard_id mirrors
// `dashboard_cards` — a deleted dashboard takes its drafts with it.
// Org scope lives on the parent dashboard; this table inherits it via
// the FK + the route-layer scope check.
//
// Intentionally OUT of the global content-mode publish system:
// per-user drafts are private to the editor and publish individually
// when the user clicks Publish on THIS dashboard, not through the
// workspace-wide `/api/v1/admin/publish` transaction.
export const dashboardUserDrafts = pgTable(
  "dashboard_user_drafts",
  {
    userId: text("user_id").notNull(),
    dashboardId: uuid("dashboard_id").notNull().references(() => dashboards.id, { onDelete: "cascade" }),
    // Full DashboardSnapshot — title/description/cards array — see
    // `lib/dashboard-versioning.ts`. Stored as a snapshot rather than
    // mutating `dashboard_cards` so the published view stays stable
    // for viewers until the user explicitly publishes.
    draft: jsonb("draft").notNull(),
    // Snapshot of published AT FORK TIME. Refreshed by `rebase`. Lets
    // `publishDraftMerge` + `rebaseDraftSnapshot` do a true three-way
    // merge without falling back to "treat current published as
    // baseline" (which would silently overwrite a teammate's edit).
    baseline: jsonb("baseline").notNull(),
    // Moment of fork from published. Compared to dashboards.updated_at
    // on rebase to detect "your baseline has changed" (user story 13).
    publishedBaselineAt: timestamp("published_baseline_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.dashboardId] }),
    index("idx_dashboard_user_drafts_dashboard").on(t.dashboardId),
  ],
);

export const sandboxCredentials = pgTable(
  "sandbox_credentials",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    provider: text("provider").notNull(),
    // `credentials_encrypted` carries `encryptSecret(JSON.stringify(credentials))` —
    // the JSONB sibling was dropped in 0040 once F-41 cleared soak.
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    // F-47 key version for `credentials_encrypted`.
    credentialsKeyVersion: integer("credentials_key_version").notNull().default(1),
    displayName: text("display_name"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("sandbox_credentials_org_provider").on(t.orgId, t.provider),
    index("idx_sandbox_credentials_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Admin action audit log
// ---------------------------------------------------------------------------

export const adminActionLog = pgTable(
  "admin_action_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    // actorId / actorEmail relaxed to nullable in migration 0035 (F-36)
    // to back the GDPR "right to erasure" contract — scrubbed rows set
    // both columns to NULL and stamp `anonymizedAt`. Live-write rows
    // remain populated by `logAdminAction`; nullability applies only to
    // the post-erasure state.
    actorId: text("actor_id"),
    actorEmail: text("actor_email"),
    scope: text("scope").notNull().default("workspace"),
    orgId: text("org_id"),
    actionType: text("action_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    status: text("status").notNull().default("success"),
    metadata: jsonb("metadata"),
    ipAddress: text("ip_address"),
    requestId: text("request_id").notNull(),
    /** GDPR erasure marker (F-36). NULL = not scrubbed; non-NULL = actor_id + actor_email are NULL. */
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_admin_action_log_timestamp").on(t.timestamp),
    index("idx_admin_action_log_actor_id").on(t.actorId),
    index("idx_admin_action_log_org_id").on(t.orgId),
    index("idx_admin_action_log_action_type").on(t.actionType),
    index("idx_admin_action_log_target_type").on(t.targetType),
    index("idx_admin_action_log_org_ts").on(t.orgId, t.timestamp),
    check("chk_admin_action_scope", sql`scope IN ('platform', 'workspace')`),
    check("chk_admin_action_status", sql`status IN ('success', 'failure')`),
  ],
);

// ---------------------------------------------------------------------------
// Admin action retention config
// ---------------------------------------------------------------------------
// Parallel to `auditRetentionConfig` — retention policy for `adminActionLog`.
// Key is `org_id` with the reserved literal 'platform' for the platform-scoped
// policy row. See migration 0035 and `.claude/research/design/admin-action-log-retention.md`.

export const adminActionRetentionConfig = pgTable(
  "admin_action_retention_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull().unique(),
    retentionDays: integer("retention_days"),
    hardDeleteDelayDays: integer("hard_delete_delay_days").notNull().default(30),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
    lastPurgeAt: timestamp("last_purge_at", { withTimezone: true }),
    lastPurgeCount: integer("last_purge_count"),
  },
  (t) => [
    index("idx_admin_action_retention_config_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Sub-processor change-feed (#1924) — see migration 0045 for design notes.
// ---------------------------------------------------------------------------

export const subProcessorSubscriptions = pgTable(
  "sub_processor_subscriptions",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    tokenEncrypted: text("token_encrypted").notNull(),
    tokenKeyVersion: integer("token_key_version").notNull().default(1),
    createdByUserId: text("created_by_user_id"),
    // AtlasUser.label at registration time (not necessarily an email).
    createdByLabel: text("created_by_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_sub_processor_subscriptions_url").on(t.url),
  ],
);

export const subProcessorSnapshots = pgTable(
  "sub_processor_snapshots",
  {
    // BIGSERIAL on the SQL side — drizzle's `bigint` with mode `bigint`
    // reads/writes BIGINT; the auto-increment is handled by Postgres.
    id: bigint("id", { mode: "bigint" }).primaryKey().notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_sub_processor_snapshots_published_at").on(t.publishedAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// Per-OAuth-client MCP rate-limit overrides (#2071) — see migration 0051 for
// design notes (separate table vs JSONB on `oauthClient`, FK avoidance).
// ---------------------------------------------------------------------------

export const oauthClientRateLimits = pgTable(
  "oauth_client_rate_limits",
  {
    clientId: text("client_id").notNull(),
    referenceId: text("reference_id").notNull(),
    requestsPerMinute: integer("requests_per_minute").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: text("updated_by_user_id"),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.referenceId] }),
    check(
      "oauth_client_rate_limits_rpm_range",
      sql`requests_per_minute >= 1 AND requests_per_minute <= 3600`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Cross-workspace agent identity (#2073) — see migration 0053 for the full
// design rationale. Two-table layout mirrors the #2071 precedent of NOT
// adding columns to Better-Auth-owned `oauthClient`.
// ---------------------------------------------------------------------------

export const oauthClientWorkspaceScope = pgTable(
  "oauth_client_workspace_scope",
  {
    clientId: text("client_id").primaryKey(),
    referenceId: text("reference_id").notNull(),
    scope: text("scope").notNull().default("single"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: text("updated_by_user_id"),
  },
  (t) => [
    check(
      "oauth_client_workspace_scope_value",
      sql`${t.scope} IN ('single', 'multi')`,
    ),
  ],
);

export const oauthClientWorkspaceGrants = pgTable(
  "oauth_client_workspace_grants",
  {
    clientId: text("client_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    grantedByUserId: text("granted_by_user_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.workspaceId] }),
    index("idx_oauth_client_workspace_grants_workspace").on(t.workspaceId),
  ],
);

// ---------------------------------------------------------------------------
// Proactive chat answer meter (#2296) — see migration 0073 for design notes.
// Five event types track the proactive lifecycle (classify → react → offer
// → accept → feedback). Cost stored as integer micro-USD (millionths).
// ---------------------------------------------------------------------------

export const proactiveMeterEvents = pgTable(
  "proactive_meter_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id"),
    eventType: text("event_type").notNull(),
    outcome: text("outcome"),
    tokens: integer("tokens").notNull().default(0),
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    actorUserId: text("actor_user_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_proactive_meter_events_workspace_created").on(
      t.workspaceId,
      t.createdAt.desc(),
    ),
    index("idx_proactive_meter_events_workspace_type_created").on(
      t.workspaceId,
      t.eventType,
      t.createdAt.desc(),
    ),
    check(
      "chk_proactive_meter_event_type",
      sql`event_type IN ('classify', 'react', 'offer', 'accept', 'feedback', 'public_refused')`,
    ),
    check(
      "chk_proactive_meter_outcome",
      sql`outcome IS NULL OR outcome IN ('helpful', 'not-helpful', 'wrong-data', 'no-feedback')`,
    ),
  ],
);

// MCP bearer tokens (`mcp_tokens`) were added in PR A of #2024 and removed
// in PR C when the hosted MCP path moved to OAuth 2.1 access tokens issued
// by `@better-auth/oauth-provider`. The drizzle table definition lived
// here through the soak; migration 0047 drops the table. Token lifecycle
// for hosted MCP is now Better Auth's `oauthAccessToken` /
// `oauthRefreshToken` schema, which Better Auth's runtime owns.

// Proactive chat admin opt-in (#2294, PRD #2291). Two tables back the
// workspace-level admin console for proactive mode:
//   - workspace_proactive_config — 1 row per workspace, master toggle +
//     defaults. Enterprise-gated at the route layer; the table exists on
//     every tenant so future plan upgrades read pre-existing config
//     without a migration.
//   - channel_proactive_config   — N rows per workspace, per-channel
//     allow/deny + optional sensitivity override. Unique on
//     (workspace_id, channel_id) so a POST acts as an upsert.
// ---------------------------------------------------------------------------

export const workspaceProactiveConfig = pgTable(
  "workspace_proactive_config",
  {
    workspaceId: text("workspace_id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    sensitivity: text("sensitivity").notNull().default("balanced"),
    classifierMode: text("classifier_mode").notNull().default("regex-prefilter"),
    announcementChannelId: text("announcement_channel_id"),
    monthlyClassifierCap: integer("monthly_classifier_cap"),
    // One-shot idempotency stamp for the activation announcement
    // (#2300). NULL means the AnnouncementCoordinator may post the
    // first-time-enable message to `announcement_channel_id`; NOT NULL
    // means it already fired and disable→re-enable is a no-op.
    announcementPostedAt: timestamp("announcement_posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "chk_workspace_proactive_sensitivity",
      sql`${t.sensitivity} IN ('cautious', 'balanced', 'eager')`,
    ),
    check(
      "chk_workspace_proactive_classifier_mode",
      sql`${t.classifierMode} IN ('regex-prefilter', 'classify-all')`,
    ),
    check(
      "chk_workspace_proactive_monthly_cap_nonneg",
      sql`${t.monthlyClassifierCap} IS NULL OR ${t.monthlyClassifierCap} >= 0`,
    ),
  ],
);

export const channelProactiveConfig = pgTable(
  "channel_proactive_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    channelId: text("channel_id").notNull(),
    allow: boolean("allow").notNull(),
    sensitivity: text("sensitivity"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "chk_channel_proactive_sensitivity",
      sql`${t.sensitivity} IS NULL OR ${t.sensitivity} IN ('cautious', 'balanced', 'eager')`,
    ),
    uniqueIndex("uq_channel_proactive_workspace_channel").on(t.workspaceId, t.channelId),
    index("idx_channel_proactive_workspace").on(t.workspaceId),
  ],
);

// ---------------------------------------------------------------------------
// Proactive chat — three-layer kill switch + per-user opt-out (#2295,
// PRD #2291). Single table backs four orthogonal pause shapes:
//
//   workspace-kill   one row, channel_id NULL, user_id NULL, expires_at NULL.
//                    Admin "pause all proactive" — wins over everything.
//   admin-channel    per-channel admin deny. channel_id NOT NULL,
//                    user_id NULL, expires_at NULL.
//   user-optout      DM `unsubscribe`. workspace-scoped per user;
//                    channel_id NULL, user_id NOT NULL, expires_at NULL.
//   channel-24h      In-channel `@atlas pause`. channel_id NOT NULL,
//                    user_id NULL, expires_at = now() + 24h.
//
// Precedence resolved in app layer (`decidePauseFromRows`):
//   workspace-kill > admin-channel > user-optout > channel-24h
//
// Expired rows are ignored at read time; no sweeper at MVP.
// ---------------------------------------------------------------------------

export const proactivePauses = pgTable(
  "proactive_pauses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    channelId: text("channel_id"),
    userId: text("user_id"),
    layer: text("layer").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "chk_proactive_pauses_layer",
      sql`${t.layer} IN ('channel-24h', 'admin-channel', 'workspace-kill', 'user-optout')`,
    ),
    index("idx_proactive_pauses_lookup").on(t.workspaceId, t.channelId, t.expiresAt),
    // Partial index keyed on (workspace, user) — keeps user-optout
    // lookups (DM `unsubscribe`) off the wide workspace scan.
    index("idx_proactive_pauses_user")
      .on(t.workspaceId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Proactive chat — public dataset for non-linked askers (#2297, PRD #2291).
//
// The unlinked-asker flow from #2293 stops at "link your Atlas account."
// This table is the curated allowlist of fully-qualified semantic entity
// names that an unlinked asker is allowed to ask questions about — the
// admin opts in entity-by-entity. `deny_metrics` is the per-entry escape
// hatch for "allow `users` but never `users.email`": column / measure
// names that block a query even when the parent entity is allowed.
//
// Defaults are conservative — empty allowlist on day one. No
// auto-population. Cross-entity joins are strict (`isEntityAllowed`
// rejects a query that touches any out-of-allowlist entity, even via
// JOIN). Refusal emits a `proactive.public_refused` meter event whose
// `metadata.entityName` drives the discoverability rollup in the
// admin console.
// ---------------------------------------------------------------------------

export const proactivePublicDataset = pgTable(
  "proactive_public_dataset",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    entityName: text("entity_name").notNull(),
    denyMetrics: text("deny_metrics")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_proactive_public_dataset_workspace_entity").on(
      t.workspaceId,
      t.entityName,
    ),
    index("idx_proactive_public_dataset_workspace").on(t.workspaceId),
  ],
);
