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

import type { OutboxStatus } from "../lead-outbox/outbox";
import type { EmailOutboxStatus } from "../email-outbox/outbox";
import type { AgentRunStatus } from "../durable-session";
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
    // #2067 / #3615 / #4046 — actor discriminators. `actor_kind` is populated on
    // every new row (web chat / `/query` → 'human', scheduler → 'scheduler',
    // MCP → 'mcp', unattended workspace API key → 'api_key' (#4046 / ADR-0027 §6),
    // any other agent-loop SQL → 'agent'); only pre-#3615 historical rows are
    // NULL. `client_id` / `tool_name` stay MCP-only. See migrations 0049
    // (columns) + 0160 (api_key) + the writer wiring in lib/auth/audit.ts.
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
    // Migration 0079 makes this FK DEFERRABLE INITIALLY DEFERRED so the
    // fanout's fire-and-forget parent + child INSERTs can race without
    // 23503 violations. drizzle-orm does not expose deferrability as a
    // first-class option; the deferrability is declared in the SQL
    // migration and verified by `migrate-pg.test.ts`.
    foreignKey({
      columns: [t.parentAuditId],
      foreignColumns: [t.id],
      name: "audit_log_parent_audit_id_fkey",
    }).onDelete("set null"),
    check("chk_audit_log_actor_kind", sql`actor_kind IS NULL OR actor_kind IN ('human', 'agent', 'mcp', 'scheduler', 'api_key')`),
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
    // 0112 — per-conversation REST datasource exclude-set (#3066, S2a).
    // Holds `workspace_plugins.install_id` values the agent must NOT query
    // for this conversation. Empty (`'{}'`, the default) = every in-scope
    // REST datasource is queryable, so a newly-installed one is reachable
    // with no action. SQL routing (`routing_mode`) is unaffected. See
    // ADR-0011. NOT NULL DEFAULT '{}' so existing rows read as "all in
    // scope" without a backfill.
    restExcludedDatasourceIds: text("rest_excluded_datasource_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // 0113 — per-conversation REST-only focus (#3067, S2b). When set,
    // holds the single `workspace_plugins.install_id` the conversation
    // targets exclusively, suspending `executeSQL`. NULL (the default) =
    // not focused: `routing_mode` + `rest_excluded_datasource_ids` apply
    // as normal, and they stay RETAINED-but-inert while focused so
    // clearing focus returns to the prior scope. See ADR-0011.
    restFocusDatasourceId: text("rest_focus_datasource_id"),
    // 0149 — per-conversation Group reach (#3895, ADR-0022 slice (c)). NULL
    // (the default) = All sources: every visible Connection group is reachable
    // and the agent routes per question via the Source catalog. A
    // `connection_group_id` value = Focus → that group: only it is reachable;
    // executeSQL REJECTS any other group target (no silent re-route — the
    // #3867(b) fix). Reach is the axis ABOVE member routing (`routing_mode`);
    // REST scope is a separate axis. This column feeds the slice-(a) reach
    // resolver (#3893) so Focus actually bounds executeSQL. Existing group-bound
    // rows were backfilled to Focus (behavior-preserving).
    groupReach: text("group_reach"),
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
// Chat plugin shared cache
// ---------------------------------------------------------------------------
//
// Created in migration `0086_consolidate_slack_installations.sql` (#2634).
// Owned-and-managed by the chat plugin's `PgStateAdapter` for general
// thread-subscription / lock / KV-cache traffic, but takes Slack
// workspace installs (`slack:installation:<teamId>`) as a first-class
// citizen too — replaces the dropped `slack_installations` table as
// the single source of truth for Slack OAuth state. See `lib/slack/store.ts`.
//
// The partial expression index on `value->>'orgId'` (filtered by the
// `slack:installation:` key prefix) keeps `getInstallationByOrg`
// efficient without pulling a full GIN onto every cache row.

export const chatCache = pgTable(
  "chat_cache",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_chat_cache_expires")
      .on(t.expiresAt)
      .where(sql`expires_at IS NOT NULL`),
    index("idx_chat_cache_slack_org_id")
      .on(sql`(value->>'orgId')`)
      .where(sql`key LIKE 'slack:installation:%'`),
  ],
);

// ---------------------------------------------------------------------------
// Slack integration
// ---------------------------------------------------------------------------
//
// `slack_installations` was dropped in migration
// `0086_consolidate_slack_installations.sql` (#2634). Workspace install
// data now lives in `chat_cache` (above) under the `slack:installation:`
// key prefix. The dropped table is allowed-listed by
// `scripts/check-schema-drift.sh` (it subtracts `DROP TABLE` targets
// from the expected pgTable set).

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
// Connection groups + connections — DROPPED by migration 0094
// ---------------------------------------------------------------------------
//
// 0094 / #2744 (ADR-0007) is the 1.5.3 cutover. The `connection_groups`
// and `connections` pgTables that previously lived in this region of the
// file are gone. Installs live in `workspace_plugins` under
// `pillar = 'datasource'`; `ConnectionRegistry` reads from there via
// `DatasourcePoolResolver` (slice 5 / #2743). The named-group
// abstraction collapsed into denormalised JSONB inside
// `workspace_plugins.config.group_id` — remaining `connection_group_id`
// columns on scheduled_tasks/approval_queue/conversations/
// semantic_entities/dashboard_cards are free-form text identifiers
// with no DB FK (they always matched a group conceptually, just one
// that no longer has a backing row).
//
// `scripts/check-schema-drift.sh` excludes both dropped tables via the
// CREATE-minus-DROP set logic, so the drift check stays green without
// vestigial pgTable definitions here.

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
    // 0094 / #2744 — composite FK to `connection_groups (id, org_id)`
    // dropped with the table. `connection_group_id` stays as a
    // free-form text identifier matching `workspace_plugins.config->>'group_id'`.
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
// Admin-managed connections — DROPPED by migration 0094
// ---------------------------------------------------------------------------
//
// See the consolidated note above the `connection_groups` placeholder.
// Datasource installs live in `workspace_plugins WHERE pillar = 'datasource'`.

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
    // Prompt-cache split (#3099). Nullable, default 0 — existing rows backfill
    // to 0 and the INSERT path always supplies a value (`?? 0`). cache_read =
    // tokens served from cache (~90% cheaper); cache_write = tokens written to
    // cache (~25% premium). From usage.inputTokenDetails.{cacheRead,cacheWrite}.
    cacheReadTokens: integer("cache_read_tokens").default(0),
    cacheWriteTokens: integer("cache_write_tokens").default(0),
    model: text("model"),
    provider: text("provider"),
    // Agent-turn wall-clock latency in ms (runAgent entry → onFinish), #3931.
    // Nullable, no default — NULL for rows predating the migration; the INSERT
    // path supplies a value for every turn after. Powers the /platform/demo
    // latency rollup (aggregates skip NULLs).
    latencyMs: integer("latency_ms"),
    // Provider-cost USD for the turn from the Vercel AI Gateway
    // (providerMetadata.gateway.cost, summed across steps), #4036 / migration
    // 0155. Zero-markup actual cost — captured now; the basis the included usage
    // credit + overage meter will draw against once #4038/#4039 land. Nullable,
    // no default: NULL for non-gateway / BYOK-direct providers and rows predating
    // the migration, distinct from 0 ("cost was zero").
    gatewayCostUsd: numeric("gateway_cost_usd", { precision: 12, scale: 6 }),
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

// Legacy `invitations` (plural) table has been dropped. Org invitations
// live in Better Auth's `invitation` (singular) table owned by the org
// plugin in `lib/auth/server.ts`.

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
// Semantic profile status (durable partial-profile marker, #3682)
// ---------------------------------------------------------------------------

export const semanticProfileStatus = pgTable(
  "semantic_profile_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // NULL = flat default group; uniqueness keys on COALESCE(.., '__default__')
    // via the raw-SQL expression index in migration 0138 (see placeholder note).
    connectionGroupId: text("connection_group_id"),
    totalTables: integer("total_tables").notNull(),
    failedCount: integer("failed_count").notNull(),
    // [{ table, error }] — DSN-scrubbed per-table profiling failures (#3579).
    failedTables: jsonb("failed_tables").notNull().default(sql`'[]'::jsonb`),
    partial: boolean("partial").notNull(),
    profiledAt: timestamp("profiled_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // IMPORTANT: placeholder stub. The REAL natural-key index is UNIQUE on
    // (org_id, COALESCE(connection_group_id, '__default__')) and is managed by
    // raw SQL in migration 0138. Drizzle can't represent the COALESCE expression
    // index, so this non-unique approximation carries the SAME NAME
    // (`uq_semantic_profile_status_org_group`) as the real index so the next
    // `drizzle-kit generate` sees a name match and does NOT emit a spurious
    // DROP/CREATE INDEX for it — mirrors the `semantic_entities` 0063 pattern.
    // (Note: `check-schema-drift.sh` only diffs TABLE presence, not indexes, so
    // the table mirror above is what keeps THAT guard green — the same-name stub
    // is purely for drizzle-kit's index diff.) Never use Drizzle's query builder
    // for ON CONFLICT on this table: the real target is the expression index and
    // only exists in raw SQL — `upsertProfileStatus` keys on it, NOT this stub.
    index("uq_semantic_profile_status_org_group").on(t.orgId, t.connectionGroupId),
    // Real partial index from 0138 — the publish-flow read filters on `partial`.
    index("idx_semantic_profile_status_org_partial").on(t.orgId).where(sql`partial`),
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
    // Connection group the semantic amendment targets (ADR-0012, #3284).
    // NULL = default (flat entities/) group. Lets the admin approve path
    // rebuild the correct group scope from a persisted amendment row.
    connectionGroupId: text("connection_group_id"),
    // Performance-aware Atlas (PRD #3617 B-0, #3631). Rolling mean wall-clock
    // (ms), last-observed timestamp (staleness), and error counter for the
    // pattern's executions. avg_duration_ms / last_seen_at are NULL until the
    // pattern is first observed; error_count starts at 0.
    avgDurationMs: doublePrecision("avg_duration_ms"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    errorCount: integer("error_count").notNull().default(0),
    // Performance-aware Atlas (PRD #3617 B-2, #3636). True once the nightly
    // auto-promote/decay job (lib/learn/promote-decay-scheduler.ts) promoted
    // this row from pending → approved. Stays true across a later auto-demote
    // so decay only demotes machine-promoted rows, never human approvals, and
    // so the admin UI can mark them visually distinct.
    autoPromoted: boolean("auto_promoted").notNull().default(false),
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
    // Performance-aware Atlas (PRD #3617 B-0, #3631). Rolling mean wall-clock
    // (ms) of the suggestion's runs. NULL until first observed.
    avgDurationMs: doublePrecision("avg_duration_ms"),
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
    // Output-equivalent (model-weighted) token count for `token` events (#3989,
    // migration 0152). Raw tokens normalized by the per-model TokenWeighting
    // table (reference model = 1.0). Nullable, no default: NULL means "not
    // weighted" (non-token events, or token rows predating the migration) —
    // distinct from 0 ("weighted to zero"). Budget/period summation reads
    // COALESCE(weighted_quantity, quantity) so legacy token rows still count.
    weightedQuantity: integer("weighted_quantity"),
    // Provider-cost USD for a `token` event's turn from the Vercel AI Gateway
    // (providerMetadata.gateway.cost, summed across steps), #4036 / migration
    // 0155. The billing/period aggregate sums this into the at-cost dollar spend
    // the included credit + overage meter WILL draw against once #4038/#4039
    // land (captured-only today). Nullable, no default: NULL for non-token
    // events, non-gateway providers, and rows predating the migration;
    // aggregation reads COALESCE(SUM(...), 0).
    gatewayCostUsd: numeric("gateway_cost_usd", { precision: 12, scale: 6 }),
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
    // #2072 — agent-origin scoping (renamed from "surface" in ADR-0015).
    // 'any' preserves pre-2072 fires-everywhere semantics; the other
    // values pin a rule to a single transport.
    origin: text("origin").notNull().default("any"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("chk_approval_rule_type", sql`rule_type IN ('table', 'column', 'cost', 'datasource')`),
    check(
      "chk_approval_rule_origin",
      sql`origin IN ('any', 'chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'discord', 'whatsapp', 'gchat', 'webhook', 'cli')`,
    ),
    index("idx_approval_rules_org").on(t.orgId),
    index("idx_approval_rules_org_enabled").on(t.orgId).where(sql`enabled = true`),
    index("idx_approval_rules_org_origin").on(t.orgId, t.origin),
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
    // #2072 — agent origin stamped at request creation (renamed from
    // "surface" in ADR-0015). NULL for legacy rows / callers that didn't
    // bind an origin; only chat / mcp / scheduler / slack / teams /
    // webhook for new rows.
    origin: text("origin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    check("chk_approval_status", sql`status IN ('pending', 'approved', 'denied', 'expired')`),
    check(
      "chk_approval_request_origin",
      sql`origin IS NULL OR origin IN ('chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'discord', 'whatsapp', 'gchat', 'webhook', 'cli')`,
    ),
    // 0094 / #2744 — composite FK to `connection_groups (id, org_id)`
    // dropped with the table. `connection_group_id` stays as a
    // free-form text identifier matching `workspace_plugins.config->>'group_id'`.
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
    // Depth of the last verification — 'full-restore' (restored into a scratch
    // DB and counted base tables) vs 'header-only' (degraded fallback), or null
    // if never verified. Added by #2941. The ee/ runtime DDL adds this via an
    // idempotent ALTER in ensureTable(); this mirror keeps drizzle-kit from
    // emitting a DROP COLUMN on the next generate.
    verifyLevel: text("verify_level"),
    // Source DB's public BASE TABLE count captured at backup time (#2989).
    // verifyByRestore asserts restored >= expected to catch a dump truncated
    // on a clean statement boundary (psql exits 0 but incomplete). Like
    // verify_level, added by an idempotent ALTER in ensureTable(); mirrored
    // here so drizzle-kit doesn't emit a DROP COLUMN.
    expectedTableCount: integer("expected_table_count"),
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
// Billing: @better-auth/stripe `subscription` table
// ---------------------------------------------------------------------------

/**
 * The @better-auth/stripe plugin's `subscription` table. Better Auth owns its
 * creation on US (the stripe plugin is registered only when STRIPE_SECRET_KEY
 * is set — US-only per the per-service env), so this is NOT a table Atlas
 * historically created. Migration 0152 (#4019) adds a forward `CREATE TABLE IF
 * NOT EXISTS subscription` so the passive EU/APAC region DBs — which never
 * register the stripe plugin — reach full schema parity with US. (The purge's
 * `subscription` deletes are to_regclass-probed, so an absent table was already
 * tolerated; the unconditional `scim_group_mappings` delete is what actually
 * aborted the EU/APAC purge — fixed by the same migration + a new probe.)
 *
 * This mirror exists so scripts/check-schema-drift.sh sees a pgTable for the
 * table 0152 now creates. The column names stay camelCase to match what Better
 * Auth generates (string→text, date→timestamptz, number→integer, boolean,
 * id→text PK, `required: false`→nullable). Mirrors
 * `migrations/0152_region_db_subscription_scim_parity.sql`.
 */
export const subscription = pgTable("subscription", {
  id: text("id").primaryKey(),
  plan: text("plan").notNull(),
  referenceId: text("referenceId").notNull(),
  stripeCustomerId: text("stripeCustomerId"),
  stripeSubscriptionId: text("stripeSubscriptionId"),
  status: text("status").notNull(),
  periodStart: timestamp("periodStart", { withTimezone: true }),
  periodEnd: timestamp("periodEnd", { withTimezone: true }),
  trialStart: timestamp("trialStart", { withTimezone: true }),
  trialEnd: timestamp("trialEnd", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancelAtPeriodEnd"),
  cancelAt: timestamp("cancelAt", { withTimezone: true }),
  canceledAt: timestamp("canceledAt", { withTimezone: true }),
  endedAt: timestamp("endedAt", { withTimezone: true }),
  seats: integer("seats"),
  billingInterval: text("billingInterval"),
  stripeScheduleId: text("stripeScheduleId"),
});

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
// Discord integration (0002_discord_installations.sql)
//
// Note: the sibling teams/telegram/gchat/whatsapp_installations tables were
// dropped by migration 0119 (#3161) — static-bot installs now live entirely in
// `workspace_plugins`. `discord_installations` is retained because it still
// backs the self-hosted Discord BYOT bot-token path.
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
    // #2650 — install-handler dispatch key. Mirrors `CatalogInstallModel`
    // in lib/config.ts. CHECK constraint enforces the enum at DB layer.
    installModel: text("install_model").notNull().default("oauth"),
    // #2650 — gate on per-deploy-mode visibility. SaaS hides `false`
    // rows from admin-UI listings; self-host always shows them.
    saasEligible: boolean("saas_eligible").notNull().default(true),
    // 0092 / #2739 — three-pillar taxonomy. Backfilled from `type` on
    // migration; required for every catalog row. ADR-0006 mapping:
    // chat→chat, datasource→datasource, everything else→action.
    pillar: text("pillar").notNull(),
    // 0092 / #2739 — coming-soon affordance. `coming_soon` rows render
    // as grey/inert cards in admin UI (slice 9 wires the rendering).
    implementationStatus: text("implementation_status").notNull().default("available"),
    // 0092 / #2739 — built-in Datasource catalog rows (slice 5) set
    // this true so the cutover migrator backfills a workspace_plugins
    // row per workspace (demo connection as auto_install).
    autoInstall: boolean("auto_install").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_plugin_catalog_slug").on(t.slug),
    index("idx_plugin_catalog_type").on(t.type),
    index("idx_plugin_catalog_enabled").on(t.enabled).where(sql`enabled = true`),
    // Partial on enabled = true keeps the index narrow — admin-UI catalog
    // listing and chat-plugin AdapterRegistry both `WHERE enabled = true`.
    index("idx_plugin_catalog_install_model")
      .on(t.type, t.installModel)
      .where(sql`enabled = true`),
    check("chk_plugin_catalog_type", sql`type IN ('datasource', 'context', 'interaction', 'action', 'sandbox', 'chat', 'integration')`),
    check("chk_plugin_catalog_install_model", sql`install_model IN ('oauth', 'form', 'static-bot', 'oauth-datasource')`),
    // 0161 / #4206 / ADR-0028 — widened to admit the fourth pillar `knowledge`
    // (hosted OKF collections). Kept in lockstep with migration 0161.
    check("chk_plugin_catalog_pillar", sql`pillar IN ('datasource', 'chat', 'action', 'knowledge')`),
    check("chk_plugin_catalog_implementation_status", sql`implementation_status IN ('available', 'coming_soon')`),
  ],
);

export const workspacePlugins = pgTable(
  "workspace_plugins",
  {
    // 0092 / #2739 — `id` lost its PK status when the composite PK
    // landed; it stays as a NOT NULL, uniquely-indexed column so
    // existing handler INSERTs that RETURNING id keep working until
    // WorkspaceInstaller (#2742) pivots them onto the composite.
    // TODO(#2742): decide whether `id` is still needed once
    // WorkspaceInstaller owns the writes.
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    catalogId: text("catalog_id").notNull().references(() => pluginCatalog.id, { onDelete: "cascade" }),
    // 0092 / #2739 — per-instance install identifier.
    //  - chat/action installs: singleton enforced by the
    //    `workspace_plugins_singleton` partial unique. Rows backfilled
    //    by 0092 carry the catalog_id sentinel; every post-#2739
    //    writer (Slack/Telegram/static-bots, the form-install spine in
    //    integrations/install/persist-form-install.ts) writes the row
    //    id — both conventions coexist, so never join/filter on
    //    install_id for these pillars; key on (workspace_id, catalog_id).
    //  - datasource installs (#2743 / #2744): user-facing id like
    //    `prod-us`, multi-instance per (workspace, catalog).
    installId: text("install_id").notNull(),
    // 0092 / #2739 — three-pillar taxonomy. Denormalized from
    // plugin_catalog.pillar so the partial unique index can gate on
    // it without a join.
    pillar: text("pillar").notNull(),
    config: jsonb("config").notNull().default(sql`'{}'`),
    enabled: boolean("enabled").notNull().default(true),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    installedBy: text("installed_by"),
    // 0094 / #2744 — content-mode column mirroring the dropped
    // `connections.status`. Admin route + ConnectionRegistry read this
    // to filter draft/archived installs; the content-mode middleware
    // overlays `status IN ('published', 'draft')` in developer mode.
    status: text("status").notNull().default("published"),
    // 0094 / #2744 — required by `ContentModeRegistry`'s simple promote
    // SQL (`UPDATE workspace_plugins SET status='published', updated_at = now()`).
    // Every other content-mode table carries one; workspace_plugins
    // inherits the column now that it participates in the mode system
    // as the post-cutover `connections` substitute.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 0092 / #2739 — composite PK per ADR-0007. Replaces single-column
    // `id` PK from 0014.
    primaryKey({ columns: [t.workspaceId, t.catalogId, t.installId] }),
    // 0092 / #2739 — preserves the `id` uniqueness invariant that the
    // dropped single-column PK used to enforce.
    uniqueIndex("workspace_plugins_id_unique").on(t.id),
    // 0094 / #2744 — the pre-1.5.3 global unique
    // (`idx_workspace_plugins_unique`) was dropped here as part of the
    // cutover. `workspace_plugins_singleton` below remains as the sole
    // singleton-enforcement index for chat + action pillars; datasource
    // installs are intentionally multi-instance per (workspace, catalog).
    // 0092 / #2739 — post-1.5.3 invariant: singleton install per
    // (workspace, catalog) for chat + action pillars only. Datasource
    // pillar is admitted multiple times.
    uniqueIndex("workspace_plugins_singleton")
      .on(t.workspaceId, t.catalogId)
      .where(sql`pillar IN ('chat', 'action')`),
    // 0120 / #3167 — closes the static-bot routing-id concurrent-install
    // race. The five static-bot handlers' cross-workspace pre-checks
    // (`assert*UnboundElsewhere`) aren't transactionally fused with the
    // per-workspace-locked cap-gate UPSERT, so two DIFFERENT workspaces
    // could both bind the SAME routing id and collapse the read-side
    // resolver onto its `rows.length > 1` fail-closed. This partial unique
    // index is the DB-enforced backstop: one routing key per platform.
    //   - Leading `catalog_id` scopes the routing value per platform, so a
    //     Telegram chat_id "123" never collides with a Discord guild_id "123".
    //   - The CASE maps each catalog to its JSONB routing key (mirrors the
    //     per-handler `*InstallConfig` shapes). A NULL result (Slack, any
    //     future unmapped chat catalog, or gchat's `my_customer` self-install
    //     alias via NULLIF) is DISTINCT in the index → exempt from the
    //     constraint. Adding a static-bot platform means extending BOTH this
    //     CASE and the migration 0120 expression in lockstep.
    //   - `WHERE enabled = true` matches the pre-check filter, so a
    //     disconnected (disabled) install frees its routing id for reuse.
    // The handlers catch the 23505 this raises and surface the same
    // "already connected elsewhere" error as the pre-check (see
    // `lib/integrations/install/routing-id-conflict.ts`).
    uniqueIndex("workspace_plugins_chat_routing_id_unique")
      .on(
        t.catalogId,
        sql`(CASE catalog_id
       WHEN 'catalog:telegram' THEN config->>'chat_id'
       WHEN 'catalog:discord'  THEN config->>'guild_id'
       WHEN 'catalog:teams'    THEN config->>'tenant_id'
       WHEN 'catalog:whatsapp' THEN config->>'phone_number_id'
       WHEN 'catalog:gchat'    THEN NULLIF(config->>'workspace_id', 'my_customer')
     END)`,
      )
      .where(sql`enabled = true AND pillar = 'chat'`),
    index("idx_workspace_plugins_workspace").on(t.workspaceId),
    index("idx_workspace_plugins_catalog").on(t.catalogId),
    index("idx_workspace_plugins_status").on(t.workspaceId, t.status),
    // 0161 / #4206 / ADR-0028 — widened to admit the fourth pillar `knowledge`.
    // The `workspace_plugins_singleton` partial unique above stays
    // `WHERE pillar IN ('chat', 'action')`, so knowledge (like datasource) is
    // multi-instance per (workspace, catalog) — that exclusion is what makes
    // collections possible.
    check("chk_workspace_plugins_pillar", sql`pillar IN ('datasource', 'chat', 'action', 'knowledge')`),
    check("chk_workspace_plugins_status", sql`status IN ('published', 'draft', 'archived')`),
  ],
);

// ---------------------------------------------------------------------------
// Knowledge Base pillar (0162 / 0163 — #4206, ADR-0028)
// ---------------------------------------------------------------------------

// knowledge_documents — hosted OKF documents, one row per file in a
// collection's bundle tree. A collection is a `workspace_plugins` install
// (pillar `knowledge`, `install_id` = collection slug). Workspace-global,
// never group-scoped; owned by exactly one collection via `collectionId`.
// OKF frontmatter is stored as real columns; the body byte-identical.
// Content-mode participant — every ingest lands `draft` (the ADR-0028 §4
// review gate), promoted only via the atomic publish endpoint. Mirrors
// migration 0162.
export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Better-Auth organization id. Workspace-global (no group FK), TEXT/no-FK
    // like the other org-scoped Atlas tables.
    workspaceId: text("workspace_id").notNull(),
    // The owning collection = `workspace_plugins.install_id` slug. No composite
    // FK (see migration 0162); referential integrity is the ingest slice's job.
    collectionId: text("collection_id").notNull(),
    // Bundle path within the collection tree, unique PER COLLECTION.
    path: text("path").notNull(),
    // OKF frontmatter, stored verbatim.
    type: text("type"),
    title: text("title"),
    description: text("description"),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    // OKF `timestamp` frontmatter field (the document's own timestamp),
    // distinct from Atlas ingest bookkeeping. Column is `"timestamp"` (a
    // Postgres type keyword) — JS field renamed to avoid shadowing the
    // imported `timestamp` column helper.
    docTimestamp: timestamp("timestamp", { withTimezone: true }),
    resource: text("resource"),
    // Markdown body, byte-identical to what was reviewed (ADR-0028 §3).
    body: text("body").notNull(),
    // `atlas:` frontmatter provenance extension.
    atlasSource: text("atlas_source"),
    atlasIngestedAt: timestamp("atlas_ingested_at", { withTimezone: true }),
    // Content-mode lifecycle — defaults `draft` (the review gate).
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Per-collection tree walks and per-tenant scans.
    index("idx_knowledge_documents_collection").on(t.workspaceId, t.collectionId),
    // Content-mode status filter (published-only read + developer overlay).
    index("idx_knowledge_documents_status").on(t.workspaceId, t.status),
    // GIN over the OKF `tags` array for the frontmatter-filter search tier.
    index("idx_knowledge_documents_tags").using("gin", t.tags),
    // `path` unique per collection, not per workspace (ADR-0028 §2).
    uniqueIndex("uq_knowledge_documents_collection_path").on(
      t.workspaceId,
      t.collectionId,
      t.path,
    ),
    check(
      "chk_knowledge_documents_status",
      sql`status IN ('draft', 'published', 'archived')`,
    ),
  ],
);

// knowledge_links — the intra-collection link graph extracted at ingest.
// One row per markdown link: (source document, target path, anchor text).
// Content-mode-exempt (derived data whose visibility follows its source
// document — see migration 0163). `targetPath` is a lazily-resolved path
// string, not a FK. Mirrors migration 0163.
export const knowledgeLinks = pgTable(
  "knowledge_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The document the link was found in. Cascade so a document's edges vanish
    // with it (re-ingest deletes the document, its links follow).
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    // The bundle path the link points at — resolved lazily, not a FK.
    targetPath: text("target_path").notNull(),
    anchorText: text("anchor_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_knowledge_links_source").on(t.sourceDocumentId),
    index("idx_knowledge_links_target").on(t.targetPath),
  ],
);

// integration_credentials (0089) — dedicated credential store for lazy
// OAuth integrations (Salesforce, future Jira / etc.). The dual-store
// teardown order is documented in ADR-0003: credentials first, install
// record second. FK cascade is the defensive backstop, not the primary
// cleanup path.
export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    catalogId: text("catalog_id").notNull().references(() => pluginCatalog.id, { onDelete: "cascade" }),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    credentialsKeyVersion: integer("credentials_key_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_integration_credentials_unique").on(t.workspaceId, t.catalogId),
    index("idx_integration_credentials_workspace").on(t.workspaceId),
  ],
);

// operator_integration_credentials (0140, #3704) — OPERATOR-tier (platform)
// integration app credentials, set + rotated from the Admin console without
// a redeploy, encrypted at rest. One row per platform slug (the app
// registration is operator-shared; no per-workspace dimension). Deliberately
// separate from the workspace-tier `integration_credentials` above — see
// lib/integrations/operator-credentials/ for the isolation seam. Env stays
// the self-host fallback (resolver precedence: DB row → env → unset).
export const operatorIntegrationCredentials = pgTable(
  "operator_integration_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: text("platform").notNull(),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    credentialsKeyVersion: integer("credentials_key_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_operator_integration_credentials_platform").on(t.platform),
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
    // Parameters (#2267) — JSONB array of definitions [{ key, type, default,
    // label }]; cards bind to them via `:<key>`. See
    // 0116_dashboard_parameters.sql + lib/dashboard-parameters.ts.
    parameters: jsonb("parameters").notNull().default(sql`'[]'`),
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
    // 0117: markdown body of a `text` / section-block card (#3138). NULL for a
    // chart card; the card kind is DERIVED from this column's presence in
    // `rowToCard` (no `kind` column). A text card stores sql = '' and
    // chart_config = NULL and never reaches the SQL pipeline.
    content: text("content"),
    // 0121: event annotations (#3209) — a JSONB array of dated markers
    // [{ x, label, color? }] rendered as VERTICAL `<ReferenceLine>`s on a
    // line / area card (the read-side sibling of the HORIZONTAL goal-line
    // `chart_config.thresholds` from #3208). Lives in its OWN card-level
    // column rather than inside `chart_config` so it survives a chart-type
    // re-detection. NOT NULL DEFAULT '[]' — `rowToCard` always sees an array;
    // the shape is re-validated on read via `dashboardCardAnnotationsSchema`.
    annotations: jsonb("annotations").notNull().default(sql`'[]'`),
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

// 0083 — Per-user staged destructive ops on dashboards (#2365, PRD #2362).
// The bound chat agent's `removeCard` and `updateCardSql` tools do NOT
// mutate the draft directly; they queue a row here. Accepting a stage
// applies the change to the draft via the versioning module; discarding
// drops it. Terminal rows are kept (audit trail) so the table grows
// per-edit-session and is GC'd at dashboard delete via ON DELETE CASCADE.
//
// Per-user scope — `user_id text` mirrors `dashboard_user_drafts.user_id`
// so the table works in every auth mode without an FK into Better Auth's
// managed `user` table.
export const dashboardStageChanges = pgTable(
  "dashboard_stage_changes",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    dashboardId: uuid("dashboard_id").notNull().references(() => dashboards.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    // `remove_card` payload: { cardId }.
    // `edit_sql`    payload: { cardId, newSql, currentSql }.
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    // `pending` / `applied` / `discarded`. Terminal-state rows are frozen
    // — accept / discard helpers are no-ops on rows that aren't `pending`.
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
  },
  (t) => [
    // Mirrors the migration's CHECK constraint on `kind`.
    check("dashboard_stage_changes_kind_chk", sql`${t.kind} IN ('remove_card', 'edit_sql')`),
    // Mirrors the migration's CHECK on `status`.
    check("dashboard_stage_changes_status_chk", sql`${t.status} IN ('pending', 'applied', 'discarded')`),
    // Terminal-state invariants: pending rows have both timestamps NULL;
    // applied rows have applied_at set + discarded_at NULL; discarded
    // rows have discarded_at set + applied_at NULL.
    check(
      "dashboard_stage_changes_timestamps_chk",
      sql`(${t.status} = 'pending' AND ${t.appliedAt} IS NULL AND ${t.discardedAt} IS NULL)
       OR (${t.status} = 'applied' AND ${t.appliedAt} IS NOT NULL AND ${t.discardedAt} IS NULL)
       OR (${t.status} = 'discarded' AND ${t.discardedAt} IS NOT NULL AND ${t.appliedAt} IS NULL)`,
    ),
    // Per-user pending stages by dashboard — drives the overlay query on
    // every render. Partial index keeps it tight (terminal rows excluded).
    index("idx_dashboard_stage_changes_user_pending")
      .on(t.dashboardId, t.userId, t.status)
      .where(sql`status = 'pending'`),
    index("idx_dashboard_stage_changes_dashboard").on(t.dashboardId),
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

// Per-classify reviewer verdict (#2622). Migration 0084. Composite PK
// on (workspace_id, message_id) — admin upserts a single verdict per
// classified message per workspace.
export const proactiveClassificationReview = pgTable(
  "proactive_classification_review",
  {
    workspaceId: text("workspace_id").notNull(),
    messageId: text("message_id").notNull(),
    verdict: text("verdict").notNull(),
    reviewerUserId: text("reviewer_user_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.messageId] }),
    check(
      "chk_proactive_classification_review_verdict",
      sql`verdict IN ('misfire', 'correct', 'unsure')`,
    ),
    index("idx_proactive_classification_review_workspace_created").on(
      t.workspaceId,
      t.createdAt.desc(),
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
    check(
      "chk_workspace_proactive_workspace_id_nonempty",
      sql`${t.workspaceId} <> ''`,
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

// ---------------------------------------------------------------------------
// twenty_integrations (0098) — per-workspace credentials for the Twenty CRM
// plugin. Listed in `INTEGRATION_TABLES` (lib/db/integration-tables.ts) so
// F-47 key rotation + F-42 residue audit walk the table generically. The
// `api_key_encrypted` column uses the `db/secret-encryption.ts` pair
// (CLAUDE.md guidance for new integration credential columns).
// ---------------------------------------------------------------------------

export const twentyIntegrations = pgTable(
  "twenty_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    baseUrl: text("base_url"),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    apiKeyKeyVersion: integer("api_key_key_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_twenty_integrations_workspace_unique").on(t.workspaceId),
  ],
);

// ---------------------------------------------------------------------------
// crm_outbox (0102) — durable queue for SaaS CRM (Twenty) lead dispatches.
// Slice 2 of 1.6.0 (#2729). Owned by `lib/lead-outbox/`. No credentials are
// stored in this table, so it is intentionally NOT a member of
// `INTEGRATION_TABLES` (F-47 rotation / F-42 audit skip it). The partial
// index on (status, created_at) WHERE status IN ('pending','in_flight')
// keeps the flusher poll fast as done/dead rows accumulate.
// ---------------------------------------------------------------------------

export const crmOutbox = pgTable(
  "crm_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    // Per-email serialization key (0104, #2870). Lowercased+trimmed
    // primary email extracted from `payload` at enqueue. CLAIM_SQL
    // dedupes by this column and gates each claim on a no-in_flight
    // check so concurrent rows for the same email never dispatch
    // simultaneously. Nullable for legacy / non-email-keyed event
    // types — those rows fall back to per-id deduplication.
    emailKey: text("email_key"),
    // Tenant attribution for per-row dispatch routing (0106, #2849).
    // SaaS lead-capture (Atlas's own pipeline) carries the resolved
    // operator workspace id; a future per-tenant plugin enqueue path
    // lands a customer workspace id. NOT NULL with DEFAULT to the
    // operator sentinel so the migration backfills atomically and
    // raw-INSERT fixtures don't have to thread workspace_id through.
    // See migration 0106 for the fallback rationale.
    workspaceId: text("workspace_id").notNull().default("<atlas-operator>"),
    status: text("status").$type<OutboxStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // TODO(#2729-followup): rename to a generic `resource_ids JSONB` if
    // a second SaaS CRM ever ships. The Twenty-specific names leak
    // vendor specifics into what is otherwise a generic outbox.
    twentyPersonId: text("twenty_person_id"),
    twentyNoteId: text("twenty_note_id"),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "crm_outbox_status_chk",
      sql`status IN ('pending', 'in_flight', 'done', 'dead')`,
    ),
    index("idx_crm_outbox_pending_created")
      .on(t.status, t.createdAt)
      .where(sql`status IN ('pending', 'in_flight')`),
    index("idx_crm_outbox_email_key_active")
      .on(t.emailKey, t.status, t.createdAt)
      .where(sql`status IN ('pending', 'in_flight')`),
    index("idx_crm_outbox_workspace_status_created")
      .on(t.workspaceId, t.status, t.createdAt)
      .where(sql`status IN ('pending', 'in_flight')`),
  ],
);

// ---------------------------------------------------------------------------
// email_outbox (0107) — durable queue for transactional email (password reset,
// signup verification OTP). Slice for #2942 residual scope. Owned by
// `lib/email-outbox/`. A stripped-down mirror of `crm_outbox`: no email_key
// serialization, no workspace_id routing, no sub-step resource-id columns —
// transactional sends are single, independent, at-least-once operations.
//
// `status` here is the OUTBOX LIFECYCLE status, NOT the content-mode status
// (draft/published/archived). email_outbox is an operational queue, not
// user-surfaced content, so it is intentionally OUTSIDE the content-mode
// system (CLAUDE.md § Content Mode System carve-out). The payload IS a
// bearer credential for the TTL window (a live reset link / OTP) — hence
// encrypted at rest — but it holds no LONG-LIVED provider credential, so
// there is nothing for F-47 rotation to re-key: it is NOT a member of
// `INTEGRATION_TABLES`.
// ---------------------------------------------------------------------------

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Send classification for observability / metrics bucketing
    // (e.g. 'password-reset', 'verification-otp'). Never used for routing.
    emailType: text("email_type").notNull(),
    // Rendered EmailMessage { to, subject, html }, JSON-serialized then
    // encrypted via encryptSecret (enc:v<N>:... AES-256-GCM) — TEXT, not
    // JSONB, because the stored value is opaque ciphertext. Holds a live
    // reset link / OTP for the TTL window, hence encryption at rest.
    payload: text("payload").notNull(),
    // Optional org scope so the flusher re-resolves a per-org transport
    // override on re-send. NULL for session-less flows (password reset).
    orgId: text("org_id"),
    // Hard delivery deadline (per-type TTL). The flusher dead-letters a
    // row past this rather than delivering an expired token. NULL = none.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").$type<EmailOutboxStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "email_outbox_status_chk",
      sql`status IN ('pending', 'in_flight', 'done', 'dead')`,
    ),
    index("idx_email_outbox_pending_created")
      .on(t.status, t.createdAt)
      .where(sql`status IN ('pending', 'in_flight')`),
  ],
);

/**
 * Stripe webhook event ledger (#3423) — idempotency + ordering for the
 * must-not-be-lost sync in the Stripe plugin's `onEvent`. `event_id` is
 * the Stripe event id (replays no-op); `event_created` per
 * `stripe_subscription_id` lets a delayed older event be ignored instead
 * of regressing status/plan. Pruned by the reconciliation sweep after
 * 30 days. Mirrors `migrations/0128_stripe_webhook_event_ledger.sql`.
 */
export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    eventId: text("event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    eventCreated: timestamp("event_created", { withTimezone: true }).notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    appliedPlanTier: text("applied_plan_tier"),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_stripe_webhook_events_sub").on(t.stripeSubscriptionId, t.eventCreated.desc()),
    index("idx_stripe_webhook_events_processed").on(t.processedAt),
  ],
);

/**
 * Tombstones for Stripe subscription ids erased by GDPR purge (#3468) —
 * the purge's own cancellation generates `customer.subscription.deleted`
 * webhooks that arrive AFTER the purge transaction; without the
 * tombstone, recording them regrows `stripe_webhook_events` rows for a
 * purged workspace. Stamped inside the `hardDeleteWorkspace`
 * transaction; consulted by `classifyStripeEvent`; pruned by the
 * reconciliation sweep after 30 days (past Stripe's ~3-week retry
 * horizon). Mirrors `migrations/0129_stripe_purged_subscriptions.sql`.
 */
export const stripePurgedSubscriptions = pgTable(
  "stripe_purged_subscriptions",
  {
    stripeSubscriptionId: text("stripe_subscription_id").primaryKey(),
    purgedAt: timestamp("purged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_stripe_purged_subscriptions_purged_at").on(t.purgedAt)],
);

/**
 * Overage-meter report ledger (#3992; re-denominated to at-cost cents #4039) —
 * idempotency + reconciliation for the `OverageMeter` reporter that flushes each
 * billing period's usage overage to a Stripe Billing Meter on a scheduler tick.
 * One row per (org, billing period): `reported_cost_cents` is the CUMULATIVE
 * at-cost overage CENTS already reported to Stripe for that period. Each tick
 * reports only `currentOverage − reported_cost_cents` (the delta) and advances
 * `reported_cost_cents`, so the same delta reported twice bills once (the second
 * tick computes a zero delta). The CHECK keeps the cumulative non-negative; the
 * upsert uses GREATEST so a late/retried tick can never regress it (which would
 * re-report already-billed overage).
 *
 * `reported_tokens` is the SUPERSEDED token-denominated cumulative (#3992). It
 * is the EXPAND phase of a two-phase column swap: the reporter no longer
 * reads/writes it (it moved to `reported_cost_cents` in #4039), but it stays
 * mirrored here until the N+1 CONTRACT migration drops it, so the schema-drift
 * check passes during the overlap window. Mirrors
 * `migrations/0154_overage_meter_reports.sql` + `0156_overage_meter_reports_cost_cents.sql`.
 */
export const overageMeterReports = pgTable(
  "overage_meter_reports",
  {
    orgId: text("org_id").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    // Superseded by reportedCents (#4039); kept until the N+1 contract drop.
    reportedTokens: bigint("reported_tokens", { mode: "number" }).notNull().default(0),
    reportedCents: bigint("reported_cost_cents", { mode: "number" }).notNull().default(0),
    lastEventIdentifier: text("last_event_identifier"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.periodStart] }),
    check("chk_overage_meter_reports_tokens_nonneg", sql`reported_tokens >= 0`),
    check("chk_overage_meter_reports_cost_cents_nonneg", sql`reported_cost_cents >= 0`),
    index("idx_overage_meter_reports_updated").on(t.updatedAt),
  ],
);

/**
 * Durable Stripe teardown outbox (#3679) — the symmetric counterpart to the
 * plan-tier reconcile sweep. Workspace delete/purge cancels Stripe
 * subscriptions (and deletes the customer on GDPR purge) BEFORE the DB
 * cascade; a Stripe outage at that instant used to fold into a warnings
 * string and the cascade proceeded, stranding a live subscription invoicing a
 * deleted workspace. Failed (or drift-detected) ops are persisted here and
 * retried by `reconcile-stripe-teardown.ts` until success or `resource_missing`.
 * The two partial unique indexes make enqueue idempotent (one pending op per
 * Stripe id). Mirrors `migrations/0141_stripe_teardown_pending.sql`.
 */
export const stripeTeardownPending = pgTable(
  "stripe_teardown_pending",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    stripeSubId: text("stripe_sub_id"),
    stripeCustomerId: text("stripe_customer_id"),
    op: text("op").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("chk_stripe_teardown_pending_op", sql`op IN ('cancel_subscription', 'delete_customer')`),
    check(
      "chk_stripe_teardown_pending_target",
      sql`(op = 'cancel_subscription' AND stripe_sub_id IS NOT NULL) OR (op = 'delete_customer' AND stripe_customer_id IS NOT NULL)`,
    ),
    uniqueIndex("idx_stripe_teardown_pending_sub")
      .on(t.stripeSubId)
      .where(sql`op = 'cancel_subscription'`),
    uniqueIndex("idx_stripe_teardown_pending_customer")
      .on(t.stripeCustomerId)
      .where(sql`op = 'delete_customer'`),
    index("idx_stripe_teardown_pending_attempts").on(t.attempts, t.createdAt),
  ],
);

/**
 * Durable + atomic one-trial-per-user marker (#3469/#3470) — one row per
 * user, stamped at grant time. The PRIMARY KEY makes
 * `INSERT ... ON CONFLICT (user_id) DO NOTHING` an atomic claim under
 * concurrent workspace creation; the row survives owner demotion and org
 * deletion (org_id is deliberately NOT an FK). Mirrors
 * `migrations/0130_user_trial_grants.sql`.
 */
export const userTrialGrants = pgTable("user_trial_grants", {
  // FK to Better Auth's "user"(id) ON DELETE CASCADE is enforced in the
  // migration — Drizzle's `references()` would require the Better Auth
  // `user` table in this schema, which it isn't. Plain text() matches
  // (same pattern as trusted_device above).
  userId: text("user_id").primaryKey(),
  orgId: text("org_id").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// MCP action policy — per-workspace kill-switch (#3509, ADR-0016 gate 1)
// ---------------------------------------------------------------------------

/**
 * Per-workspace, customer-admin allow/deny over MCP action *categories* —
 * gate 1 of the MCP dispatch order (`packages/mcp/src/dispatch-gate.ts`),
 * short-circuiting a blocked category before scope / RBAC / approval. The
 * default posture is `allowed` (the ABSENCE of a row); a category is blocked
 * iff a row exists with `status = 'blocked'`. `org_id` is the Better-Auth
 * organization id (TEXT, no FK — `organization` is not a Drizzle table).
 * Mirrors `migrations/0134_mcp_action_policy.sql`.
 */
export const mcpActionPolicy = pgTable(
  "mcp_action_policy",
  {
    orgId: text("org_id").notNull(),
    category: text("category").notNull(),
    status: text("status").notNull().default("allowed"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.category] }),
    check("chk_mcp_action_policy_status", sql`status IN ('allowed', 'blocked')`),
  ],
);

// ---------------------------------------------------------------------------
// Durable agent sessions — turn checkpoint store (#3745, ADR-0020)
// ---------------------------------------------------------------------------

/**
 * Durable agent-session checkpoints. A *run* is one user turn; phase 1a
 * (#3745) writes exactly one terminal row per turn (`done`/`failed`) at
 * completion, establishing the persistence seam before per-step `running`
 * checkpoints and `parked`/`resuming_lease` resume land in later slices.
 *
 * CONTENT-MODE EXEMPT (deliberate): this is execution state — the in-flight
 * turn's transcript + lifecycle status — not user-surfaced content, so it
 * carries no draft/published `status` column or ContentModeRegistry filter
 * (there is nothing to publish). The `status` column is the run lifecycle
 * (running/parked/done/failed), unrelated to content mode. See ADR-0020 and
 * docs/development/content-mode.md.
 *
 * `conversation_id` FKs `conversations(id)` ON DELETE CASCADE — a run is
 * meaningless once its conversation is gone. `org_id` is the Better-Auth
 * organization id (TEXT, no FK — `organization` is not a Drizzle table).
 * Mirrors `migrations/0143_agent_runs.sql`.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    orgId: text("org_id"),
    status: text("status").$type<AgentRunStatus>().notNull().default("running"),
    stepIndex: integer("step_index").notNull().default(0),
    transcript: jsonb("transcript").notNull(),
    parkedReason: text("parked_reason"),
    // resuming_lease (expiry) + resuming_lease_owner (holder token) are the
    // single-resumer guard for crash-resume (#3747, migration 0144). resuming_lease
    // is the lease EXPIRY instant; resuming_lease_owner is a per-resume token so a
    // release is safe under TTL expiry (a stale resumer can't clear a re-claimed
    // live lease). resuming_lease is defined in 0143; the owner column is added by 0144.
    resumingLease: timestamp("resuming_lease", { withTimezone: true }),
    resumingLeaseOwner: text("resuming_lease_owner"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_agent_runs_conversation").on(t.conversationId),
    index("idx_agent_runs_org").on(t.orgId),
    // Non-terminal runs are the hot working set for resume + the park reaper,
    // a small slice of a table dominated by terminal rows awaiting the sweep.
    index("idx_agent_runs_active").on(t.status).where(sql`status IN ('running', 'parked')`),
    // Resume-lease lookup (#3747, 0144): the claimable-run-for-this-conversation
    // scan, partial on the same non-terminal predicate so it stays a small hot index.
    index("idx_agent_runs_resume_lease")
      .on(t.conversationId, t.resumingLease)
      .where(sql`status IN ('running', 'parked')`),
    check("chk_agent_runs_status", sql`status IN ('running', 'parked', 'done', 'failed')`),
    // #3748 (migration 0146): a `parked` run MUST carry a `parked_reason` (the
    // approval-queue ref — the only link from a decision back to the suspended
    // turn); non-parked rows clear it. Makes a reason-less, un-resolvable parked
    // zombie unrepresentable at the source of truth.
    check(
      "chk_agent_runs_parked_reason",
      sql`status <> 'parked' OR parked_reason IS NOT NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Durable per-session working memory — named slot store (#3754, ADR-0020)
// ---------------------------------------------------------------------------

/**
 * Durable per-session agent working memory. A typed, named per-SESSION store the
 * agent loop + tools read/update through a `DurableState` handle. The session is
 * the *conversation* (NOT a single turn): a slot written in one turn is readable
 * in the next, and after crash/resume — so the key is `conversation_id`, not the
 * per-turn `agent_runs.id`. One row per (session, named slot).
 *
 * CONTENT-MODE EXEMPT (deliberate, same as {@link agentRuns}): this is execution
 * state — an in-flight agent's scratch memory — not user-surfaced content, so it
 * carries no draft/published `status` column or ContentModeRegistry filter.
 *
 * `conversation_id` FKs `conversations(id)` ON DELETE CASCADE — a session's
 * memory is meaningless once its conversation is gone. `org_id` is the
 * Better-Auth organization id (TEXT, no FK — `organization` is not a Drizzle
 * table); it is the tenant scope later slices (#3756 isolation, #3757 bounds)
 * enforce on. Mirrors `migrations/0145_agent_session_memory.sql`.
 */
export const agentSessionMemory = pgTable(
  "agent_session_memory",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    orgId: text("org_id"),
    namespace: text("namespace").notNull(),
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per (session, named slot); the leading PK column also serves the
    // hot per-conversation load (a session's slots at turn start).
    primaryKey({ columns: [t.conversationId, t.namespace] }),
    // Per-tenant scans for the future bounds/sweep + isolation slices.
    index("idx_agent_session_memory_org").on(t.orgId),
  ],
);

/**
 * Per-Connection-group routing descriptions for the agent Source catalog
 * (ADR-0022 §4, #3894). Mirrors migration 0148. A group is an abstraction over
 * one-or-more `workspace_plugins` installs sharing a `config->>'group_id'`
 * (post-0096 there is no `connection_groups` table), so its description has no
 * single install row to live on — hence its own table keyed on the canonical
 * group id. `source` distinguishes an auto description (generated from the
 * group's entities at `/wizard/save`) from a manual one (admin-refined);
 * auto-generation never clobbers a manual override. Content-mode-exempt: this is
 * operator metadata (the group-level analogue of the per-connection
 * `config.description`), not draft→publish content.
 */
export const connectionGroupDescriptions = pgTable(
  "connection_group_descriptions",
  {
    orgId: text("org_id").notNull(),
    groupId: text("group_id").notNull(),
    description: text("description").notNull(),
    source: text("source").notNull().default("auto"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.groupId] }),
    check("chk_connection_group_descriptions_source", sql`source IN ('auto', 'manual')`),
  ],
);
