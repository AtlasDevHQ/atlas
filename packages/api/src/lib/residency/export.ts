/**
 * Workspace data export for cross-region migration.
 *
 * Queries the internal database for all workspace-scoped data and builds
 * an ExportBundle compatible with the import endpoint at
 * POST /api/v1/admin/migrate/import.
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
} from "@useatlas/types";

const log = createLogger("region-export");

/** Coerce a DB timestamp value to an ISO 8601 string. */
function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return new Date().toISOString();
}

/**
 * Export all workspace data for a given org into an ExportBundle.
 *
 * Queries conversations (with messages), semantic entities, learned patterns,
 * and org-scoped settings from the internal database. The returned bundle
 * is ready to POST to the target region's import endpoint.
 */
export async function exportWorkspaceBundle(
  orgId: string,
  sourceLabel?: string,
): Promise<ExportBundle> {
  const pool = getInternalDB();

  // --- 1. Conversations ---
  const convResult = await pool.query(
    `SELECT id, user_id, title, surface, connection_id, starred, created_at, updated_at
     FROM conversations WHERE org_id = $1 AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [orgId],
  );

  const conversations: ExportedConversation[] = [];
  let totalMessages = 0;

  for (const conv of convResult.rows) {
    const msgResult = await pool.query(
      `SELECT id, role, content, created_at
       FROM messages WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [conv.id as string],
    );

    const messages: ExportedMessage[] = msgResult.rows.map((m) => ({
      id: m.id as string,
      role: m.role as ExportedMessage["role"],
      content: m.content,
      createdAt: toISO(m.created_at),
    }));
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

  // --- 2. Semantic entities ---
  const entityResult = await pool.query(
    `SELECT name, entity_type, yaml_content, connection_id
     FROM semantic_entities WHERE org_id = $1
     ORDER BY entity_type, name`,
    [orgId],
  );

  const semanticEntities: ExportedSemanticEntity[] = entityResult.rows.map((e) => ({
    name: e.name as string,
    entityType: e.entity_type as string,
    yamlContent: e.yaml_content as string,
    connectionId: (e.connection_id as string | null) ?? null,
  }));

  // --- 3. Learned patterns ---
  const patternResult = await pool.query(
    `SELECT pattern_sql, description, source_entity, confidence, status
     FROM learned_patterns WHERE org_id = $1
     ORDER BY created_at ASC`,
    [orgId],
  );

  const learnedPatterns: ExportedLearnedPattern[] = patternResult.rows.map((p) => ({
    patternSql: p.pattern_sql as string,
    description: (p.description as string | null) ?? null,
    sourceEntity: (p.source_entity as string | null) ?? null,
    confidence: p.confidence as number,
    status: p.status as ExportedLearnedPattern["status"],
  }));

  // --- 4. Org-scoped settings ---
  const settingResult = await pool.query(
    `SELECT key, value FROM settings WHERE org_id = $1 ORDER BY key`,
    [orgId],
  );

  const settings: ExportedSetting[] = settingResult.rows.map((s) => ({
    key: s.key as string,
    value: s.value as string,
  }));

  // --- Build bundle ---
  const bundle: ExportBundle = {
    manifest: {
      version: EXPORT_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      source: { label: sourceLabel ?? "region-migration" },
      counts: {
        conversations: conversations.length,
        messages: totalMessages,
        semanticEntities: semanticEntities.length,
        learnedPatterns: learnedPatterns.length,
        settings: settings.length,
      },
    },
    conversations,
    semanticEntities,
    learnedPatterns,
    settings,
  };

  log.info(
    { orgId, counts: bundle.manifest.counts },
    "Workspace data exported for migration",
  );

  return bundle;
}
