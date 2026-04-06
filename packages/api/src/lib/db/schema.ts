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
  real,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
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
  },
  (t) => [
    index("idx_audit_log_timestamp").on(t.timestamp),
    index("idx_audit_log_user_id").on(t.userId),
    index("idx_audit_log_source_id").on(t.sourceId),
    index("idx_audit_log_tables_accessed").using("gin", t.tablesAccessed),
    index("idx_audit_log_columns_accessed").using("gin", t.columnsAccessed),
    index("idx_audit_log_org").on(t.orgId),
    index("idx_audit_log_deleted_at").on(t.deletedAt).where(sql`deleted_at IS NOT NULL`),
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
  },
  (t) => [
    index("idx_conversations_user").on(t.userId),
    index("idx_conversations_starred").on(t.userId, t.starred).where(sql`starred = true`),
    uniqueIndex("idx_conversations_share_token").on(t.shareToken).where(sql`share_token IS NOT NULL`),
    check("chk_share_mode", sql`share_mode IN ('public', 'org')`),
    index("idx_conversations_org").on(t.orgId),
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
    botToken: text("bot_token").notNull(),
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
    connectionId: text("connection_id"),
    approvalMode: text("approval_mode").notNull().default("auto"),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Org scoping
    orgId: text("org_id"),
  },
  (t) => [
    index("idx_scheduled_tasks_owner").on(t.ownerId),
    index("idx_scheduled_tasks_enabled").on(t.enabled).where(sql`enabled = true`),
    index("idx_scheduled_tasks_next_run").on(t.nextRunAt).where(sql`enabled = true`),
    index("idx_scheduled_tasks_org").on(t.orgId),
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
    type: text("type").notNull(),
    description: text("description"),
    schemaName: text("schema_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    // Org scoping — composite PK with id
    orgId: text("org_id").notNull().default("__global__"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.orgId] }),
    index("idx_connections_org").on(t.orgId),
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
    connectionId: text("connection_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_semantic_entities_org_type_name").on(t.orgId, t.entityType, t.name),
    index("idx_semantic_entities_org").on(t.orgId),
    index("idx_semantic_entities_org_type").on(t.orgId, t.entityType),
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
  },
  (t) => [
    index("idx_prompt_collections_org").on(t.orgId),
    index("idx_prompt_collections_builtin").on(t.isBuiltin).where(sql`is_builtin = true`),
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
  },
  (t) => [
    check("chk_sso_type", sql`type IN ('saml', 'oidc')`),
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
    retentionDays: integer("retention_days"),
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
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("chk_model_provider", sql`provider IN ('anthropic', 'openai', 'azure-openai', 'custom')`),
    index("idx_workspace_model_config_org").on(t.orgId),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("chk_approval_rule_type", sql`rule_type IN ('table', 'column', 'cost')`),
    index("idx_approval_rules_org").on(t.orgId),
    index("idx_approval_rules_org_enabled").on(t.orgId).where(sql`enabled = true`),
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
    connectionId: text("connection_id").notNull().default("default"),
    tablesAccessed: jsonb("tables_accessed").default(sql`'[]'`),
    columnsAccessed: jsonb("columns_accessed").default(sql`'[]'`),
    status: text("status").notNull().default("pending"),
    reviewerId: text("reviewer_id"),
    reviewerEmail: text("reviewer_email"),
    reviewComment: text("review_comment"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    check("chk_approval_status", sql`status IN ('pending', 'approved', 'denied', 'expired')`),
    index("idx_approval_queue_org_status").on(t.orgId, t.status),
    index("idx_approval_queue_expires").on(t.expiresAt).where(sql`status = 'pending'`),
    index("idx_approval_queue_requester").on(t.requesterId),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [
    check("chk_domain_status", sql`status IN ('pending', 'verified', 'failed')`),
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
    connectionId: text("connection_id").notNull().default("default"),
    category: text("category").notNull(),
    confidence: text("confidence").notNull().default("medium"),
    maskingStrategy: text("masking_strategy").notNull().default("partial"),
    reviewed: boolean("reviewed").notNull().default(false),
    dismissed: boolean("dismissed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pii_column_classifications_unique").on(t.orgId, t.tableName, t.columnName, t.connectionId),
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
    appPassword: text("app_password"),
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
    botToken: text("bot_token"),
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
    botToken: text("bot_token").notNull(),
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
    credentialsJson: text("credentials_json").notNull(),
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
    accessToken: text("access_token").notNull(),
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
    apiKey: text("api_key").notNull(),
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
    accessToken: text("access_token").notNull(),
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
    config: jsonb("config").notNull().$type<Record<string, unknown>>().default({}),
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
    connectionId: text("connection_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_dashboard_cards_dashboard").on(t.dashboardId),
    index("idx_dashboard_cards_position").on(t.dashboardId, t.position),
  ],
);

export const sandboxCredentials = pgTable(
  "sandbox_credentials",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    provider: text("provider").notNull(),
    credentials: jsonb("credentials").notNull(),
    displayName: text("display_name"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("sandbox_credentials_org_provider").on(t.orgId, t.provider),
    index("idx_sandbox_credentials_org").on(t.orgId),
  ],
);
