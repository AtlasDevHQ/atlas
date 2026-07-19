/**
 * Admin migration import route.
 *
 * Mounted under /api/v1/admin/migrate. Receives an export bundle produced by
 * `atlas export` (via the `atlas migrate-import` CLI) and imports workspace
 * data into the active org. Idempotent — re-importing skips data that already
 * exists in the target workspace.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB, type InternalPoolClient } from "@atlas/api/lib/db/internal";
import { computeNextRun } from "@atlas/api/lib/scheduled-tasks";
import type { ExportBundle, ImportResult, SupportedBundleVersion } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-migrate");

/**
 * The pre-#4460 bundle version — four sections only (conversations, semantic
 * entities, learned patterns, settings). Still accepted so bundles produced by
 * older exporters import cleanly; the v2 sections simply come back 0/0.
 */
const LEGACY_BUNDLE_VERSION = 1 satisfies SupportedBundleVersion;

/**
 * The current bundle version (#4460 — dashboards, knowledge, scheduled tasks,
 * session memory are required sections).
 *
 * Deliberately a LOCAL constant rather than `EXPORT_BUNDLE_VERSION` from
 * `@useatlas/types`: packages/api is scaffold-bound, and a scaffold build
 * pinned to an older published package (where the constant's *value* is still
 * 1) would otherwise silently shrink the importer's accept set to `{1}` and
 * reject every v2 bundle. A new value export can't fix that either — it would
 * trip scripts/check-published-symbols.ts. The `satisfies` tether keeps both
 * constants pinned to the type-level `SupportedBundleVersion` union so they
 * can't drift from the wire contract at compile time.
 */
const CURRENT_BUNDLE_VERSION = 2 satisfies SupportedBundleVersion;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates top-level bundle structure and required fields on each element. */
export function validateBundle(body: unknown): { ok: true; bundle: ExportBundle } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const obj = body as Record<string, unknown>;

  if (!obj.manifest || typeof obj.manifest !== "object") {
    return { ok: false, error: "Missing or invalid 'manifest' field." };
  }

  const manifest = obj.manifest as Record<string, unknown>;
  if (manifest.version !== CURRENT_BUNDLE_VERSION && manifest.version !== LEGACY_BUNDLE_VERSION) {
    return { ok: false, error: `Unsupported bundle version: ${String(manifest.version)}. Expected ${LEGACY_BUNDLE_VERSION} or ${CURRENT_BUNDLE_VERSION}.` };
  }

  // v2 bundles MUST carry the #4460 sections. A producer that claims v2 but
  // drops a section indicates exporter drift — fail loudly instead of
  // silently stranding a pillar in the source region.
  if (manifest.version === CURRENT_BUNDLE_VERSION) {
    for (const section of ["dashboards", "knowledgeDocuments", "scheduledTasks", "agentSessionMemory"] as const) {
      if (!Array.isArray(obj[section])) {
        return { ok: false, error: `Missing or invalid '${section}' field. Expected an array (required for a version-${CURRENT_BUNDLE_VERSION} bundle).` };
      }
    }
  }

  if (!Array.isArray(obj.conversations)) {
    return { ok: false, error: "Missing or invalid 'conversations' field. Expected an array." };
  }
  if (!Array.isArray(obj.semanticEntities)) {
    return { ok: false, error: "Missing or invalid 'semanticEntities' field. Expected an array." };
  }
  if (!Array.isArray(obj.learnedPatterns)) {
    return { ok: false, error: "Missing or invalid 'learnedPatterns' field. Expected an array." };
  }
  if (!Array.isArray(obj.settings)) {
    return { ok: false, error: "Missing or invalid 'settings' field. Expected an array." };
  }

  // Validate required fields on each conversation element
  for (let i = 0; i < obj.conversations.length; i++) {
    const c = obj.conversations[i] as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || typeof c.id !== "string" || !Array.isArray(c.messages)) {
      return { ok: false, error: `conversations[${i}]: must have 'id' (string) and 'messages' (array).` };
    }
  }

  // Validate required fields on each semantic entity
  for (let i = 0; i < obj.semanticEntities.length; i++) {
    const e = obj.semanticEntities[i] as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || typeof e.name !== "string" || typeof e.entityType !== "string" || typeof e.yamlContent !== "string") {
      return { ok: false, error: `semanticEntities[${i}]: must have 'name', 'entityType', and 'yamlContent' (strings).` };
    }
    // `connectionGroupId` is optional (#2423). When present it must be either
    // null or a non-empty string — anything else (numbers, objects, "") would
    // pass the `?? null` coalesce and reach pg as junk.
    if ("connectionGroupId" in e && e.connectionGroupId !== null && e.connectionGroupId !== undefined) {
      if (typeof e.connectionGroupId !== "string" || e.connectionGroupId.length === 0) {
        return { ok: false, error: `semanticEntities[${i}].connectionGroupId: must be a non-empty string, null, or omitted.` };
      }
    }
  }

  // Validate required fields on each learned pattern
  for (let i = 0; i < obj.learnedPatterns.length; i++) {
    const p = obj.learnedPatterns[i] as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || typeof p.patternSql !== "string") {
      return { ok: false, error: `learnedPatterns[${i}]: must have 'patternSql' (string).` };
    }
  }

  // Validate required fields on each setting
  for (let i = 0; i < obj.settings.length; i++) {
    const s = obj.settings[i] as Record<string, unknown> | null;
    if (!s || typeof s !== "object" || typeof s.key !== "string" || typeof s.value !== "string") {
      return { ok: false, error: `settings[${i}]: must have 'key' and 'value' (strings).` };
    }
  }

  // v2 sections (#4460) — validated whenever PRESENT, regardless of the
  // claimed version, so a mislabeled producer can never smuggle junk past
  // the shape checks (and never silently loses a present section either).
  if ("dashboards" in obj && obj.dashboards !== undefined) {
    if (!Array.isArray(obj.dashboards)) {
      return { ok: false, error: "Invalid 'dashboards' field. Expected an array." };
    }
    for (let i = 0; i < obj.dashboards.length; i++) {
      const d = obj.dashboards[i] as Record<string, unknown> | null;
      if (!d || typeof d !== "object" || typeof d.id !== "string" || typeof d.ownerId !== "string" || typeof d.title !== "string" || !Array.isArray(d.cards) || !Array.isArray(d.drafts)) {
        return { ok: false, error: `dashboards[${i}]: must have 'id', 'ownerId', 'title' (strings), 'cards' and 'drafts' (arrays).` };
      }
      // Guard the sharing posture at the seam: `chk_dashboard_share_mode`
      // would abort the whole transaction on anything else, and coalescing an
      // absent value to "public" would silently WIDEN sharing — a security
      // posture must be stated by the producer, never defaulted permissively.
      if (d.shareMode !== "public" && d.shareMode !== "org") {
        return { ok: false, error: `dashboards[${i}].shareMode: must be 'public' or 'org'.` };
      }
      for (let j = 0; j < d.cards.length; j++) {
        const card = d.cards[j] as Record<string, unknown> | null;
        if (!card || typeof card !== "object" || typeof card.id !== "string" || typeof card.title !== "string" || typeof card.sql !== "string") {
          return { ok: false, error: `dashboards[${i}].cards[${j}]: must have 'id', 'title', and 'sql' (strings).` };
        }
      }
      for (let j = 0; j < d.drafts.length; j++) {
        const draft = d.drafts[j] as Record<string, unknown> | null;
        // `draft`/`baseline` presence mirrors the memory section's `"value" in m`
        // guard — both back NOT NULL jsonb columns, and JSON.stringify(undefined)
        // would bind NULL and abort the transaction with a raw pg 500.
        if (!draft || typeof draft !== "object" || typeof draft.userId !== "string" || typeof draft.publishedBaselineAt !== "string" || !("draft" in draft) || !("baseline" in draft)) {
          return { ok: false, error: `dashboards[${i}].drafts[${j}]: must have 'userId', 'publishedBaselineAt' (strings), 'draft', and 'baseline'.` };
        }
      }
    }
  }

  if ("knowledgeDocuments" in obj && obj.knowledgeDocuments !== undefined) {
    if (!Array.isArray(obj.knowledgeDocuments)) {
      return { ok: false, error: "Invalid 'knowledgeDocuments' field. Expected an array." };
    }
    for (let i = 0; i < obj.knowledgeDocuments.length; i++) {
      const k = obj.knowledgeDocuments[i] as Record<string, unknown> | null;
      if (!k || typeof k !== "object" || typeof k.id !== "string" || typeof k.collectionId !== "string" || typeof k.path !== "string" || typeof k.body !== "string" || !Array.isArray(k.links)) {
        return { ok: false, error: `knowledgeDocuments[${i}]: must have 'id', 'collectionId', 'path', 'body' (strings) and 'links' (array).` };
      }
      // Guard the content-mode CHECK constraint at the seam — a bad status
      // would otherwise abort the whole transaction with a pg error.
      if (k.status !== "draft" && k.status !== "published" && k.status !== "archived") {
        return { ok: false, error: `knowledgeDocuments[${i}].status: must be 'draft', 'published', or 'archived'.` };
      }
    }
  }

  if ("scheduledTasks" in obj && obj.scheduledTasks !== undefined) {
    if (!Array.isArray(obj.scheduledTasks)) {
      return { ok: false, error: "Invalid 'scheduledTasks' field. Expected an array." };
    }
    for (let i = 0; i < obj.scheduledTasks.length; i++) {
      const t = obj.scheduledTasks[i] as Record<string, unknown> | null;
      if (!t || typeof t !== "object" || typeof t.id !== "string" || typeof t.ownerId !== "string" || typeof t.name !== "string" || typeof t.question !== "string" || typeof t.cronExpression !== "string") {
        return { ok: false, error: `scheduledTasks[${i}]: must have 'id', 'ownerId', 'name', 'question', and 'cronExpression' (strings).` };
      }
      // Approval posture + enabled are execution-safety fields: defaulting an
      // absent approvalMode to "auto" or an absent enabled to true would let a
      // malformed bundle run an agent task with a more permissive posture than
      // its admin configured. Require the producer to state both.
      if (typeof t.approvalMode !== "string" || t.approvalMode.length === 0) {
        return { ok: false, error: `scheduledTasks[${i}].approvalMode: must be a non-empty string.` };
      }
      if (typeof t.enabled !== "boolean") {
        return { ok: false, error: `scheduledTasks[${i}].enabled: must be a boolean.` };
      }
    }
  }

  if ("agentSessionMemory" in obj && obj.agentSessionMemory !== undefined) {
    if (!Array.isArray(obj.agentSessionMemory)) {
      return { ok: false, error: "Invalid 'agentSessionMemory' field. Expected an array." };
    }
    for (let i = 0; i < obj.agentSessionMemory.length; i++) {
      const m = obj.agentSessionMemory[i] as Record<string, unknown> | null;
      if (!m || typeof m !== "object" || typeof m.conversationId !== "string" || typeof m.namespace !== "string" || !("value" in m)) {
        return { ok: false, error: `agentSessionMemory[${i}]: must have 'conversationId', 'namespace' (strings) and 'value'.` };
      }
    }
  }

  return { ok: true, bundle: obj as unknown as ExportBundle };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ImportResultSchema = z.object({
  conversations: z.object({ imported: z.number(), skipped: z.number() }),
  semanticEntities: z.object({ imported: z.number(), skipped: z.number() }),
  learnedPatterns: z.object({ imported: z.number(), skipped: z.number() }),
  settings: z.object({ imported: z.number(), skipped: z.number() }),
  dashboards: z.object({ imported: z.number(), skipped: z.number() }),
  knowledgeDocuments: z.object({ imported: z.number(), skipped: z.number() }),
  scheduledTasks: z.object({ imported: z.number(), skipped: z.number() }),
  agentSessionMemory: z.object({ imported: z.number(), skipped: z.number() }),
});

const importRoute = createRoute({
  method: "post",
  path: "/import",
  tags: ["Admin — Migration"],
  summary: "Import a migration bundle",
  description:
    "Receives an export bundle from `atlas-operator export` and imports workspace data " +
    "(conversations, semantic entities, learned patterns, settings, dashboards, " +
    "knowledge documents, scheduled tasks, agent session memory) into the " +
    "active organization. Idempotent — re-importing skips data that already exists.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            manifest: z.object({
              version: z.number(),
              exportedAt: z.string(),
              source: z.object({
                label: z.string(),
                apiUrl: z.string().optional(),
              }),
              counts: z.object({
                conversations: z.number(),
                messages: z.number(),
                semanticEntities: z.number(),
                learnedPatterns: z.number(),
                settings: z.number(),
                // v2 sections (#4460) — absent on a v1 bundle.
                dashboards: z.number().optional(),
                dashboardCards: z.number().optional(),
                dashboardUserDrafts: z.number().optional(),
                knowledgeDocuments: z.number().optional(),
                knowledgeLinks: z.number().optional(),
                scheduledTasks: z.number().optional(),
                agentSessionMemory: z.number().optional(),
              }),
            }),
            conversations: z.array(z.unknown()),
            semanticEntities: z.array(z.unknown()),
            learnedPatterns: z.array(z.unknown()),
            settings: z.array(z.unknown()),
            // v2 sections (#4460). Declared here so zod's strip-unknown-keys
            // behavior can't drop them before validateBundle/importBundle run.
            dashboards: z.array(z.unknown()).optional(),
            knowledgeDocuments: z.array(z.unknown()).optional(),
            scheduledTasks: z.array(z.unknown()).optional(),
            agentSessionMemory: z.array(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Import summary with imported/skipped counts",
      content: { "application/json": { schema: ImportResultSchema } },
    },
    400: {
      description: "Invalid bundle format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Import logic (runs inside a transaction)
// ---------------------------------------------------------------------------

export async function importBundle(
  client: InternalPoolClient,
  bundle: ExportBundle,
  orgId: string,
): Promise<ImportResult> {
  const result: ImportResult = {
    conversations: { imported: 0, skipped: 0 },
    semanticEntities: { imported: 0, skipped: 0 },
    learnedPatterns: { imported: 0, skipped: 0 },
    settings: { imported: 0, skipped: 0 },
    dashboards: { imported: 0, skipped: 0 },
    knowledgeDocuments: { imported: 0, skipped: 0 },
    scheduledTasks: { imported: 0, skipped: 0 },
    agentSessionMemory: { imported: 0, skipped: 0 },
  };

  // --- 1. Conversations + Messages ---
  for (const conv of bundle.conversations) {
    const existing = await client.query(
      "SELECT id FROM conversations WHERE id = $1 AND org_id = $2",
      [conv.id, orgId],
    );

    if (existing.rows.length > 0) {
      result.conversations.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO conversations (id, user_id, title, surface, connection_id, starred, created_at, updated_at, org_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        conv.id,
        conv.userId,
        conv.title,
        conv.surface ?? "web",
        conv.connectionId,
        conv.starred ?? false,
        conv.createdAt,
        conv.updatedAt,
        orgId,
      ],
    );

    for (const msg of conv.messages) {
      await client.query(
        `INSERT INTO messages (id, conversation_id, role, content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [msg.id, conv.id, msg.role, JSON.stringify(msg.content), msg.createdAt],
      );
    }

    result.conversations.imported++;
  }

  // --- 2. Semantic Entities ---
  for (const entity of bundle.semanticEntities) {
    const existing = await client.query(
      "SELECT id FROM semantic_entities WHERE org_id = $1 AND entity_type = $2 AND name = $3",
      [orgId, entity.entityType, entity.name],
    );

    if (existing.rows.length > 0) {
      result.semanticEntities.skipped++;
      continue;
    }

    // `connectionGroupId` is optional on the wire — bundles from producers
    // that have no concept of the column omit the key entirely. Coalesce to
    // null so omitted and explicit-null land in the same column shape.
    await client.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, entity.entityType, entity.name, entity.yamlContent, entity.connectionGroupId ?? null],
    );
    result.semanticEntities.imported++;
  }

  // --- 3. Learned Patterns ---
  for (const pattern of bundle.learnedPatterns) {
    const existing = await client.query(
      "SELECT id FROM learned_patterns WHERE org_id = $1 AND pattern_sql = $2",
      [orgId, pattern.patternSql],
    );

    if (existing.rows.length > 0) {
      result.learnedPatterns.skipped++;
      continue;
    }

    // Preserve amendment identity across the migration (#4569, audit M9):
    // `type`/`amendment_payload`/`connection_group_id` (plus reviewer + review
    // time + seen count) round-trip so a `semantic_amendment` row lands as an
    // amendment, not an orphaned query pattern. Fields are optional on the
    // bundle (pre-#4569 exports omit them) — default to a query pattern.
    // `amendment_payload` is jsonb, so serialize the object; null stays null.
    //
    // This INSERT restoring a historical `approved` amendment is NOT a
    // violation of #4506's "the seam is the only writer of `approved`": that
    // invariant scopes *live* review decisions. Bulk migration replays an
    // already-decided row (its applied YAML travels in this same bundle's
    // `semantic_entities`), the same way a DB restore would.
    await client.query(
      `INSERT INTO learned_patterns (org_id, pattern_sql, description, source_entity, confidence, status, type, amendment_payload, connection_group_id, reviewed_by, reviewed_at, repetition_count, auto_promoted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        orgId,
        pattern.patternSql,
        pattern.description,
        pattern.sourceEntity,
        pattern.confidence,
        pattern.status,
        pattern.type ?? "query_pattern",
        pattern.amendmentPayload == null ? null : JSON.stringify(pattern.amendmentPayload),
        pattern.connectionGroupId ?? null,
        pattern.reviewedBy ?? null,
        pattern.reviewedAt ?? null,
        pattern.repetitionCount ?? 1,
        // Human vs machine approval road (#4571): carried so the injection
        // eligibility bypass survives migration. A human-approved pattern
        // (`false`) stays injectable regardless of confidence; a machine one
        // (`true`) stays confidence-gated. Fail closed on absence — a pre-#4571
        // bundle can't prove provenance, so default to machine/gated (`true`)
        // rather than granting an unearned bypass.
        pattern.autoPromoted ?? true,
      ],
    );
    result.learnedPatterns.imported++;
  }

  // --- 4. Settings ---
  for (const setting of bundle.settings) {
    // Skip if key already exists (don't override target workspace settings)
    const existing = await client.query(
      "SELECT key FROM settings WHERE key = $1 AND org_id = $2",
      [setting.key, orgId],
    );

    if (existing.rows.length > 0) {
      result.settings.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO settings (key, value, org_id)
       VALUES ($1, $2, $3)`,
      [setting.key, setting.value, orgId],
    );
    result.settings.imported++;
  }

  // --- 5. Dashboards (v2, #4460) — cards + per-user drafts ride inline ---
  // Original UUIDs preserved so card/draft FKs survive. Share token + expiry
  // are NOT restored (share URLs are region-bound — the owner re-mints links
  // in the target); card `cached_*` snapshots start empty and regenerate on
  // first render. `next_refresh_at` is recomputed from the schedule below —
  // the due-refresh scan requires `next_refresh_at <= now()`, so leaving it
  // NULL would silently kill auto-refresh in the target region.
  for (const dash of bundle.dashboards ?? []) {
    const existing = await client.query(
      "SELECT id FROM dashboards WHERE id = $1 AND org_id = $2",
      [dash.id, orgId],
    );

    if (existing.rows.length > 0) {
      result.dashboards.skipped++;
      continue;
    }

    const refreshSchedule = dash.refreshSchedule ?? null;
    let nextRefreshAt: string | null = null;
    if (refreshSchedule) {
      const nextRefresh = computeNextRun(refreshSchedule);
      if (nextRefresh) {
        nextRefreshAt = nextRefresh.toISOString();
      } else {
        log.warn(
          { orgId, dashboardId: dash.id, refreshSchedule },
          "Imported dashboard has an unparseable refresh schedule — auto-refresh will not fire until the schedule is re-saved",
        );
      }
    }

    await client.query(
      `INSERT INTO dashboards (id, org_id, owner_id, title, description, share_mode, refresh_schedule, next_refresh_at, parameters, first_published_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        dash.id,
        orgId,
        dash.ownerId,
        dash.title,
        dash.description ?? null,
        // Validated as 'public' | 'org' — never defaulted (a coalesce here
        // would silently widen sharing on a malformed bundle).
        dash.shareMode,
        refreshSchedule,
        nextRefreshAt,
        // JSONB columns take explicit serialization — a bare JS array would be
        // bound as a Postgres array, not jsonb.
        JSON.stringify(dash.parameters ?? []),
        dash.firstPublishedAt ?? null,
        dash.createdAt,
        dash.updatedAt,
      ],
    );

    for (const card of dash.cards) {
      await client.query(
        `INSERT INTO dashboard_cards (id, dashboard_id, position, title, sql, chart_config, content, annotations, connection_group_id, layout, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          card.id,
          dash.id,
          card.position ?? 0,
          card.title,
          card.sql ?? "",
          card.chartConfig == null ? null : JSON.stringify(card.chartConfig),
          card.content ?? null,
          JSON.stringify(card.annotations ?? []),
          card.connectionGroupId ?? null,
          card.layout == null ? null : JSON.stringify(card.layout),
          card.createdAt,
          card.updatedAt,
        ],
      );
    }

    for (const draft of dash.drafts) {
      await client.query(
        `INSERT INTO dashboard_user_drafts (user_id, dashboard_id, draft, baseline, published_baseline_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          draft.userId,
          dash.id,
          JSON.stringify(draft.draft),
          JSON.stringify(draft.baseline),
          draft.publishedBaselineAt,
          draft.createdAt,
          draft.updatedAt,
        ],
      );
    }

    result.dashboards.imported++;
  }

  // --- 6. Knowledge documents (v2, #4460) — link graph rides inline ---
  // Review `status` and original UUIDs preserved. The FTS vector is a
  // generated column and rebuilds on insert; sync credentials/state are
  // carve-outs (per-region ciphertext — the customer re-syncs in the target).
  for (const doc of bundle.knowledgeDocuments ?? []) {
    const existing = await client.query(
      "SELECT id FROM knowledge_documents WHERE id = $1 AND workspace_id = $2",
      [doc.id, orgId],
    );

    if (existing.rows.length > 0) {
      result.knowledgeDocuments.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO knowledge_documents (id, workspace_id, collection_id, path, type, title, description, tags, "timestamp", resource, body, atlas_source, atlas_ingested_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        doc.id,
        orgId,
        doc.collectionId,
        doc.path,
        doc.type ?? null,
        doc.title ?? null,
        doc.description ?? null,
        JSON.stringify(doc.tags ?? []),
        doc.docTimestamp ?? null,
        doc.resource ?? null,
        doc.body,
        doc.atlasSource ?? null,
        doc.atlasIngestedAt ?? null,
        doc.status,
        doc.createdAt,
        doc.updatedAt,
      ],
    );

    for (const link of doc.links) {
      await client.query(
        `INSERT INTO knowledge_links (source_document_id, target_path, anchor_text)
         VALUES ($1, $2, $3)`,
        [doc.id, link.targetPath, link.anchorText ?? null],
      );
    }

    result.knowledgeDocuments.imported++;
  }

  // --- 7. Scheduled-task definitions (v2, #4460) ---
  // `next_run_at` is recomputed from the cron expression so the target
  // region's scheduler re-plans on its own clock (a NULL next_run_at would
  // never fire — the due-task scan requires next_run_at <= now()). Run
  // history stays behind; `connection_group_id`/`plugin_id` refs dangle
  // until the datasource/plugin is re-installed in the target.
  for (const task of bundle.scheduledTasks ?? []) {
    const existing = await client.query(
      "SELECT id FROM scheduled_tasks WHERE id = $1 AND org_id = $2",
      [task.id, orgId],
    );

    if (existing.rows.length > 0) {
      result.scheduledTasks.skipped++;
      continue;
    }

    // null on an unparseable cron — matches create-task semantics (the task
    // exists but is not scheduled until the admin fixes the expression).
    // Logged with import context so a task that arrives dead is findable —
    // an "imported" count alone would mask exactly the stranded-pillar class
    // #4460 exists to kill.
    const nextRun = computeNextRun(task.cronExpression);
    if (!nextRun) {
      log.warn(
        { orgId, taskId: task.id, cronExpression: task.cronExpression },
        "Imported scheduled task has an unparseable cron expression — it will not fire until the expression is fixed in Admin → Scheduled Tasks",
      );
    }

    await client.query(
      `INSERT INTO scheduled_tasks (id, owner_id, org_id, name, question, cron_expression, delivery_channel, recipients, connection_group_id, approval_mode, enabled, plugin_id, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        task.id,
        task.ownerId,
        orgId,
        task.name,
        task.question,
        task.cronExpression,
        task.deliveryChannel ?? "webhook",
        JSON.stringify(task.recipients ?? []),
        task.connectionGroupId ?? null,
        // Validated non-empty / boolean — never defaulted (a permissive
        // fallback on the approval posture would bypass the admin's gate).
        task.approvalMode,
        task.enabled,
        task.pluginId ?? null,
        nextRun ? nextRun.toISOString() : null,
        task.createdAt,
        task.updatedAt,
      ],
    );

    result.scheduledTasks.imported++;
  }

  // --- 8. Durable agent session memory (v2, #4460, ADR-0020) ---
  // Runs after section 1 so the conversation FK resolves whether the
  // conversation was imported this pass or already existed (skip path).
  // `agent_runs` checkpoints are a carve-out (region-local resume leases).
  for (const memory of bundle.agentSessionMemory ?? []) {
    const existing = await client.query(
      "SELECT conversation_id FROM agent_session_memory WHERE conversation_id = $1 AND namespace = $2",
      [memory.conversationId, memory.namespace],
    );

    if (existing.rows.length > 0) {
      result.agentSessionMemory.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO agent_session_memory (conversation_id, org_id, namespace, value, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        memory.conversationId,
        orgId,
        memory.namespace,
        JSON.stringify(memory.value),
        memory.createdAt,
        memory.updatedAt,
      ],
    );

    result.agentSessionMemory.imported++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const adminMigrate = createAdminRouter();
adminMigrate.use(requireOrgContext());

adminMigrate.openapi(importRoute, async (c) => {
  const { orgId } = c.get("orgContext");
  const requestId = c.get("requestId") as string;

  // Validate bundle structure
  const body = c.req.valid("json");
  const validation = validateBundle(body);
  if (!validation.ok) {
    return c.json({ error: "bad_request", message: validation.error, requestId }, 400);
  }

  const { bundle } = validation;
  log.info(
    {
      requestId,
      orgId,
      source: bundle.manifest.source.label,
      counts: bundle.manifest.counts,
    },
    "Starting migration import",
  );

  // Run entire import inside a transaction for atomicity
  const pool = getInternalDB();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await importBundle(client, bundle, orgId);
    await client.query("COMMIT");

    log.info({ requestId, orgId, result }, "Migration import complete");
    return c.json(result, 200);
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      log.warn({ err: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)), requestId }, "Rollback failed");
    });
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Migration import failed, rolled back");
    return c.json({ error: "import_failed", message: `Import failed — all changes rolled back. ${detail}`, requestId }, 500);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Internal import endpoint — for cross-region migration (service-to-service)
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { createHash, timingSafeEqual } from "crypto";

/** Timing-safe string comparison — prevents timing attacks on secret values. */
function timingSafeCompare(a: string, b: string): boolean {
  const aHash = createHash("sha256").update(a).digest();
  const bHash = createHash("sha256").update(b).digest();
  return timingSafeEqual(aHash, bHash);
}

/**
 * Internal import router — accepts ATLAS_INTERNAL_SECRET for auth instead of
 * admin session auth. Used by the migration executor to transfer workspace
 * data between regional API instances.
 *
 * POST /api/v1/internal/migrate/import
 *   Headers: X-Atlas-Internal-Token: <ATLAS_INTERNAL_SECRET>
 *   Body: { orgId: string, ...ExportBundle }
 */
export const internalMigrate = new Hono();

internalMigrate.post("/import", async (c) => {
  const requestId = crypto.randomUUID();
  const token = c.req.header("X-Atlas-Internal-Token");
  const secret = process.env.ATLAS_INTERNAL_SECRET;

  if (!secret) {
    log.error({ requestId }, "ATLAS_INTERNAL_SECRET not configured — internal import unavailable");
    return c.json({ error: "not_configured", message: "Internal import is not configured.", requestId }, 503);
  }

  if (!token || !timingSafeCompare(token, secret)) {
    log.warn({ requestId }, "Invalid internal token on cross-region import attempt");
    return c.json({ error: "unauthorized", message: "Invalid internal token.", requestId }, 401);
  }

  const body = await c.req.json() as Record<string, unknown>;
  const orgId = body.orgId;
  if (!orgId || typeof orgId !== "string") {
    return c.json({ error: "bad_request", message: "Missing 'orgId' in request body.", requestId }, 400);
  }

  // Validate the bundle (orgId is separate from bundle payload)
  const validation = validateBundle(body);
  if (!validation.ok) {
    return c.json({ error: "bad_request", message: validation.error, requestId }, 400);
  }

  const { bundle } = validation;
  log.info(
    { requestId, orgId, source: bundle.manifest.source.label, counts: bundle.manifest.counts },
    "Starting internal cross-region import",
  );

  const pool = getInternalDB();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await importBundle(client, bundle, orgId);
    await client.query("COMMIT");

    log.info({ requestId, orgId, result }, "Internal cross-region import complete");
    return c.json(result, 200);
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      log.warn({ err: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)), requestId }, "Rollback failed");
    });
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Internal import failed, rolled back");
    return c.json({ error: "import_failed", message: `Import failed — all changes rolled back. ${detail}`, requestId }, 500);
  } finally {
    client.release();
  }
});
