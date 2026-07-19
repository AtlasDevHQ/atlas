/**
 * Workspace data export for cross-region migration.
 *
 * Queries the internal database for the bundle-scoped workspace data (the
 * per-table moves/stays decisions live in `bundle-scope.ts`) and builds an
 * ExportBundle compatible with the import endpoint at
 * POST /api/v1/admin/migrate/import.
 *
 * This is the SINGLE bundle producer: the region-migration executor
 * (migrate.ts) and the `atlas-operator export` CLI both call it, so the
 * bundle scope cannot drift between the two surfaces (#4460). The per-table
 * moves/stays decision registry lives in `bundle-scope.ts`; a new
 * workspace-scoped table must be classified there (its tripwire test fails
 * otherwise) and, when classified as exported, queried here.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import {
  EXPORT_BUNDLE_VERSION,
  type ExportBundle,
  type ExportedConversation,
  type ExportedMessage,
  type ExportedSemanticEntity,
  type ExportedLearnedPattern,
  type ExportedSetting,
  type ExportedDashboard,
  type ExportedDashboardCard,
  type ExportedDashboardUserDraft,
  type ExportedKnowledgeDocument,
  type ExportedKnowledgeLink,
  type ExportedScheduledTask,
  type ExportedAgentSessionMemory,
} from "@useatlas/types";

const log = createLogger("region-export");

/** Coerce a DB timestamp value to an ISO 8601 string. */
function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  log.warn({ valueType: typeof value }, "Unexpected timestamp value in export — defaulting to current time");
  return new Date().toISOString();
}

/** Nullable variant of {@link toISO} for optional timestamp columns. */
function toISOOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toISO(value);
}

/**
 * Org scoping for a bundle export. The region-migration executor always
 * passes a concrete org id; the `atlas-operator export` CLI passes `null`
 * for a no-auth self-hosted instance whose rows carry `org_id IS NULL`.
 */
function scopeClause(columnRef: string, orgScope: string | null): string {
  return orgScope === null ? `${columnRef} IS NULL` : `${columnRef} = $1`;
}

/**
 * Export the bundle-scoped data for a given org into an ExportBundle.
 *
 * Bundle scope (v2, #4460 — see `bundle-scope.ts` for the full per-table
 * decision registry and `data-residency.mdx` for the customer-facing table):
 * conversations (with messages), semantic entities, learned patterns,
 * org-scoped settings, dashboards (cards + per-user drafts; share tokens
 * dropped — the owner re-shares in the target), knowledge documents (with
 * link graph + review status), scheduled-task definitions (next run
 * recomputed at import), and durable agent session memory. The returned
 * bundle is ready to POST to the target region's import endpoint.
 *
 * @param orgScope - Org id to export, or `null` to export rows with
 *   `org_id IS NULL` (no-auth self-hosted instances, CLI path).
 * @param sourceLabel - Human-readable label recorded in the manifest.
 * @param apiUrl - Source API base URL recorded in the manifest, if known.
 */
export async function exportWorkspaceBundle(
  orgScope: string | null,
  sourceLabel?: string,
  apiUrl?: string,
): Promise<ExportBundle> {
  const pool = getInternalDB();
  const params = orgScope === null ? [] : [orgScope];

  // All section queries are independent — one parallel batch, no waterfalls.
  const [
    convResult,
    allMsgResult,
    entityResult,
    patternResult,
    settingResult,
    dashboardResult,
    cardResult,
    draftResult,
    knowledgeDocResult,
    knowledgeLinkResult,
    scheduledTaskResult,
    sessionMemoryResult,
  ] = await Promise.all([
    // --- 1. Conversations + Messages (2 queries, no N+1) ---
    pool.query(
      `SELECT id, user_id, title, surface, connection_id, starred, created_at, updated_at
       FROM conversations WHERE ${scopeClause("org_id", orgScope)} AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      params,
    ),
    pool.query(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${scopeClause("c.org_id", orgScope)} AND c.deleted_at IS NULL
       ORDER BY m.conversation_id, m.created_at ASC`,
      params,
    ),
    // --- 2. Semantic entities ---
    // Group-scoped wire shape (#2340 → #2346). The legacy `connection_id`
    // column survives until #2347 drops it; bundles exclusively carry the
    // group identifier now.
    pool.query(
      `SELECT name, entity_type, yaml_content, connection_group_id
       FROM semantic_entities WHERE ${scopeClause("org_id", orgScope)}
       ORDER BY entity_type, name`,
      params,
    ),
    // --- 3. Learned patterns ---
    // Amendment-identity columns (#4569) + approval provenance (#4571) ride
    // along so an amendment survives as an amendment and the injection
    // eligibility bypass survives the migration.
    pool.query(
      `SELECT pattern_sql, description, source_entity, confidence, status,
              type, amendment_payload, connection_group_id, reviewed_by, reviewed_at,
              repetition_count, auto_promoted
       FROM learned_patterns WHERE ${scopeClause("org_id", orgScope)}
       ORDER BY created_at ASC`,
      params,
    ),
    // --- 4. Org-scoped settings ---
    pool.query(
      `SELECT key, value FROM settings WHERE ${scopeClause("org_id", orgScope)} ORDER BY key`,
      params,
    ),
    // --- 5. Dashboards (v2, #4460) ---
    // Share token + expiry deliberately excluded: share URLs are region-bound,
    // so the owner re-shares from the target region. Refresh bookkeeping +
    // card caches excluded: the importer recomputes next_refresh_at from the
    // schedule, and card data regenerates on first render.
    pool.query(
      `SELECT id, owner_id, title, description, share_mode, refresh_schedule,
              parameters, first_published_at, created_at, updated_at
       FROM dashboards WHERE ${scopeClause("org_id", orgScope)} AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      params,
    ),
    pool.query(
      `SELECT c.id, c.dashboard_id, c.position, c.title, c.sql, c.chart_config,
              c.content, c.annotations, c.connection_group_id, c.layout,
              c.created_at, c.updated_at
       FROM dashboard_cards c
       JOIN dashboards d ON d.id = c.dashboard_id
       WHERE ${scopeClause("d.org_id", orgScope)} AND d.deleted_at IS NULL
       ORDER BY c.dashboard_id, c.position ASC`,
      params,
    ),
    // Per-user drafts are content under ADR-0034's draft-first model, so they
    // move; the draft-card data cache (`dashboard_draft_card_cache`) does not.
    pool.query(
      `SELECT dr.user_id, dr.dashboard_id, dr.draft, dr.baseline,
              dr.published_baseline_at, dr.created_at, dr.updated_at
       FROM dashboard_user_drafts dr
       JOIN dashboards d ON d.id = dr.dashboard_id
       WHERE ${scopeClause("d.org_id", orgScope)} AND d.deleted_at IS NULL
       ORDER BY dr.dashboard_id, dr.user_id ASC`,
      params,
    ),
    // --- 6. Knowledge documents (v2, #4460) ---
    // Review `status` and original UUIDs preserved. The FTS vector is a
    // generated column (rebuilds on insert); sync credentials + sync state are
    // carve-outs (per-region ciphertext — re-enter the secret and re-sync).
    pool.query(
      `SELECT id, collection_id, path, type, title, description, tags,
              "timestamp", resource, body, atlas_source, atlas_ingested_at,
              status, created_at, updated_at
       FROM knowledge_documents WHERE ${scopeClause("workspace_id", orgScope)}
       ORDER BY collection_id, path ASC`,
      params,
    ),
    pool.query(
      `SELECT l.source_document_id, l.target_path, l.anchor_text
       FROM knowledge_links l
       JOIN knowledge_documents kd ON kd.id = l.source_document_id
       WHERE ${scopeClause("kd.workspace_id", orgScope)}
       ORDER BY l.source_document_id, l.created_at ASC`,
      params,
    ),
    // --- 7. Scheduled-task definitions (v2, #4460) ---
    // Run history (`scheduled_task_runs`) is a carve-out; last/next run are
    // not exported — the importer recomputes next_run_at from the cron.
    pool.query(
      `SELECT id, owner_id, name, question, cron_expression, delivery_channel,
              recipients, connection_group_id, approval_mode, enabled, plugin_id,
              created_at, updated_at
       FROM scheduled_tasks WHERE ${scopeClause("org_id", orgScope)}
       ORDER BY created_at ASC`,
      params,
    ),
    // --- 8. Durable agent session memory (v2, #4460, ADR-0020) ---
    // Scoped via the conversations join (not the nullable denormalized
    // org_id) so memory rows travel iff their conversation travels — the
    // import-side FK then resolves by construction. `agent_runs` checkpoints
    // are a carve-out (region-local resume leases).
    pool.query(
      `SELECT m.conversation_id, m.namespace, m.value, m.created_at, m.updated_at
       FROM agent_session_memory m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${scopeClause("c.org_id", orgScope)} AND c.deleted_at IS NULL
       ORDER BY m.conversation_id, m.namespace ASC`,
      params,
    ),
  ]);

  // Group messages by conversation_id
  const messagesByConv = new Map<string, ExportedMessage[]>();
  for (const m of allMsgResult.rows) {
    const convId = m.conversation_id as string;
    let msgs = messagesByConv.get(convId);
    if (!msgs) {
      msgs = [];
      messagesByConv.set(convId, msgs);
    }
    msgs.push({
      id: m.id as string,
      role: m.role as ExportedMessage["role"],
      content: m.content,
      createdAt: toISO(m.created_at),
    });
  }

  const conversations: ExportedConversation[] = [];
  let totalMessages = 0;

  for (const conv of convResult.rows) {
    const messages = messagesByConv.get(conv.id as string) ?? [];
    totalMessages += messages.length;

    conversations.push({
      id: conv.id as string,
      userId: (conv.user_id as string | null) ?? null,
      title: (conv.title as string | null) ?? null,
      surface: ((conv.surface as string) ?? "web") as ExportedConversation["surface"],
      connectionId: (conv.connection_id as string | null) ?? null,
      starred: (conv.starred as boolean) ?? false,
      createdAt: toISO(conv.created_at),
      updatedAt: toISO(conv.updated_at),
      messages,
    });
  }

  const semanticEntities: ExportedSemanticEntity[] = entityResult.rows.map((e) => ({
    name: e.name as string,
    entityType: e.entity_type as string,
    yamlContent: e.yaml_content as string,
    connectionGroupId: (e.connection_group_id as string | null) ?? null,
  }));

  const learnedPatterns: ExportedLearnedPattern[] = patternResult.rows.map((p) => ({
    patternSql: p.pattern_sql as string,
    description: (p.description as string | null) ?? null,
    sourceEntity: (p.source_entity as string | null) ?? null,
    confidence: p.confidence as number,
    status: p.status as ExportedLearnedPattern["status"],
    // Amendment identity (#4569) — carried so a `semantic_amendment` row lands
    // as an amendment instead of an orphaned query pattern.
    type: (p.type as ExportedLearnedPattern["type"]) ?? "query_pattern",
    amendmentPayload: (p.amendment_payload as Record<string, unknown> | null) ?? null,
    connectionGroupId: (p.connection_group_id as string | null) ?? null,
    reviewedBy: (p.reviewed_by as string | null) ?? null,
    reviewedAt: toISOOrNull(p.reviewed_at),
    repetitionCount: (p.repetition_count as number) ?? 1,
    // Human vs machine approval road (#4571) — carried so the injection
    // eligibility bypass survives region migration. Column is NOT NULL.
    autoPromoted: Boolean(p.auto_promoted),
  }));

  const settings: ExportedSetting[] = settingResult.rows.map((s) => ({
    key: s.key as string,
    value: s.value as string,
  }));

  // --- Dashboards: group cards + drafts by dashboard_id ---
  const cardsByDashboard = new Map<string, ExportedDashboardCard[]>();
  for (const c of cardResult.rows) {
    const dashId = c.dashboard_id as string;
    let cards = cardsByDashboard.get(dashId);
    if (!cards) {
      cards = [];
      cardsByDashboard.set(dashId, cards);
    }
    cards.push({
      id: c.id as string,
      position: (c.position as number) ?? 0,
      title: c.title as string,
      sql: (c.sql as string) ?? "",
      chartConfig: c.chart_config ?? null,
      content: (c.content as string | null) ?? null,
      annotations: c.annotations ?? [],
      connectionGroupId: (c.connection_group_id as string | null) ?? null,
      layout: c.layout ?? null,
      createdAt: toISO(c.created_at),
      updatedAt: toISO(c.updated_at),
    });
  }

  const draftsByDashboard = new Map<string, ExportedDashboardUserDraft[]>();
  for (const d of draftResult.rows) {
    const dashId = d.dashboard_id as string;
    let drafts = draftsByDashboard.get(dashId);
    if (!drafts) {
      drafts = [];
      draftsByDashboard.set(dashId, drafts);
    }
    drafts.push({
      userId: d.user_id as string,
      draft: d.draft,
      baseline: d.baseline,
      publishedBaselineAt: toISO(d.published_baseline_at),
      createdAt: toISO(d.created_at),
      updatedAt: toISO(d.updated_at),
    });
  }

  let totalCards = 0;
  let totalDrafts = 0;
  const dashboards: ExportedDashboard[] = dashboardResult.rows.map((d) => {
    const id = d.id as string;
    const cards = cardsByDashboard.get(id) ?? [];
    const drafts = draftsByDashboard.get(id) ?? [];
    totalCards += cards.length;
    totalDrafts += drafts.length;
    return {
      id,
      ownerId: d.owner_id as string,
      title: d.title as string,
      description: (d.description as string | null) ?? null,
      // NOT NULL column — bound raw. No `?? "public"` fallback: manufacturing
      // a permissive sharing posture here would defeat the importer's refusal
      // to default it (the producer must state the posture).
      shareMode: d.share_mode as ExportedDashboard["shareMode"],
      refreshSchedule: (d.refresh_schedule as string | null) ?? null,
      parameters: d.parameters ?? [],
      firstPublishedAt: toISOOrNull(d.first_published_at),
      createdAt: toISO(d.created_at),
      updatedAt: toISO(d.updated_at),
      cards,
      drafts,
    };
  });

  // --- Knowledge documents: group links by source document ---
  const linksByDocument = new Map<string, ExportedKnowledgeLink[]>();
  for (const l of knowledgeLinkResult.rows) {
    const docId = l.source_document_id as string;
    let links = linksByDocument.get(docId);
    if (!links) {
      links = [];
      linksByDocument.set(docId, links);
    }
    links.push({
      targetPath: l.target_path as string,
      anchorText: (l.anchor_text as string | null) ?? null,
    });
  }

  let totalLinks = 0;
  const knowledgeDocuments: ExportedKnowledgeDocument[] = knowledgeDocResult.rows.map((k) => {
    const links = linksByDocument.get(k.id as string) ?? [];
    totalLinks += links.length;
    return {
      id: k.id as string,
      collectionId: k.collection_id as string,
      path: k.path as string,
      type: (k.type as string | null) ?? null,
      title: (k.title as string | null) ?? null,
      description: (k.description as string | null) ?? null,
      tags: k.tags ?? [],
      docTimestamp: toISOOrNull(k.timestamp),
      resource: (k.resource as string | null) ?? null,
      body: k.body as string,
      atlasSource: (k.atlas_source as string | null) ?? null,
      atlasIngestedAt: toISOOrNull(k.atlas_ingested_at),
      status: k.status as ExportedKnowledgeDocument["status"],
      createdAt: toISO(k.created_at),
      updatedAt: toISO(k.updated_at),
      links,
    };
  });

  const scheduledTasks: ExportedScheduledTask[] = scheduledTaskResult.rows.map((t) => ({
    id: t.id as string,
    ownerId: t.owner_id as string,
    name: t.name as string,
    question: t.question as string,
    cronExpression: t.cron_expression as string,
    deliveryChannel: (t.delivery_channel as string) ?? "webhook",
    recipients: t.recipients ?? [],
    connectionGroupId: (t.connection_group_id as string | null) ?? null,
    // NOT NULL columns — bound raw, no permissive fallbacks (same rationale
    // as `shareMode` above: the approval posture is stated, never defaulted).
    approvalMode: t.approval_mode as string,
    enabled: t.enabled as boolean,
    pluginId: (t.plugin_id as string | null) ?? null,
    createdAt: toISO(t.created_at),
    updatedAt: toISO(t.updated_at),
  }));

  const agentSessionMemory: ExportedAgentSessionMemory[] = sessionMemoryResult.rows.map((m) => ({
    conversationId: m.conversation_id as string,
    namespace: m.namespace as string,
    value: m.value,
    createdAt: toISO(m.created_at),
    updatedAt: toISO(m.updated_at),
  }));

  // --- Build bundle ---
  const bundle: ExportBundle = {
    manifest: {
      version: EXPORT_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      source: {
        label: sourceLabel ?? "region-migration",
        ...(apiUrl ? { apiUrl } : {}),
      },
      counts: {
        conversations: conversations.length,
        messages: totalMessages,
        semanticEntities: semanticEntities.length,
        learnedPatterns: learnedPatterns.length,
        settings: settings.length,
        dashboards: dashboards.length,
        dashboardCards: totalCards,
        dashboardUserDrafts: totalDrafts,
        knowledgeDocuments: knowledgeDocuments.length,
        knowledgeLinks: totalLinks,
        scheduledTasks: scheduledTasks.length,
        agentSessionMemory: agentSessionMemory.length,
      },
    },
    conversations,
    semanticEntities,
    learnedPatterns,
    settings,
    dashboards,
    knowledgeDocuments,
    scheduledTasks,
    agentSessionMemory,
  };

  log.info(
    { orgScope, counts: bundle.manifest.counts },
    "Workspace data exported for migration",
  );

  return bundle;
}
