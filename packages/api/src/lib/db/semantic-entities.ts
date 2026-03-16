/**
 * CRUD helpers for org-scoped semantic entities stored in the internal DB.
 *
 * Entity types: "entity", "metric", "glossary", "catalog".
 * Each entity is stored as raw YAML content keyed by (orgId, entityType, name).
 */

import { internalQuery, hasInternalDB } from "./internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("semantic-entities");

export type SemanticEntityType = "entity" | "metric" | "glossary" | "catalog";

export interface SemanticEntityRow {
  id: string;
  org_id: string;
  entity_type: SemanticEntityType;
  name: string;
  yaml_content: string;
  connection_id: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * Upsert a semantic entity for an org.
 * Uses ON CONFLICT on (org_id, entity_type, name) to update if exists.
 */
export async function upsertEntity(
  orgId: string,
  entityType: SemanticEntityType,
  name: string,
  yamlContent: string,
  connectionId?: string,
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Internal DB required for org-scoped semantic entities");
  }
  await internalQuery(
    `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, entity_type, name)
     DO UPDATE SET yaml_content = EXCLUDED.yaml_content,
                   connection_id = EXCLUDED.connection_id,
                   updated_at = now()`,
    [orgId, entityType, name, yamlContent, connectionId ?? null],
  );
}

/**
 * List all semantic entities for an org, optionally filtered by type.
 */
export async function listEntities(
  orgId: string,
  entityType?: SemanticEntityType,
): Promise<SemanticEntityRow[]> {
  if (!hasInternalDB()) return [];

  if (entityType) {
    return internalQuery<SemanticEntityRow>(
      `SELECT id, org_id, entity_type, name, yaml_content, connection_id, created_at, updated_at
       FROM semantic_entities
       WHERE org_id = $1 AND entity_type = $2
       ORDER BY name`,
      [orgId, entityType],
    );
  }

  return internalQuery<SemanticEntityRow>(
    `SELECT id, org_id, entity_type, name, yaml_content, connection_id, created_at, updated_at
     FROM semantic_entities
     WHERE org_id = $1
     ORDER BY entity_type, name`,
    [orgId],
  );
}

/**
 * Get a single semantic entity by org, type, and name.
 */
export async function getEntity(
  orgId: string,
  entityType: SemanticEntityType,
  name: string,
): Promise<SemanticEntityRow | null> {
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<SemanticEntityRow>(
    `SELECT id, org_id, entity_type, name, yaml_content, connection_id, created_at, updated_at
     FROM semantic_entities
     WHERE org_id = $1 AND entity_type = $2 AND name = $3`,
    [orgId, entityType, name],
  );
  return rows[0] ?? null;
}

/**
 * Delete a semantic entity by org, type, and name.
 * Returns true if a row was deleted.
 */
export async function deleteEntity(
  orgId: string,
  entityType: SemanticEntityType,
  name: string,
): Promise<boolean> {
  if (!hasInternalDB()) return false;

  const rows = await internalQuery<{ id: string }>(
    `DELETE FROM semantic_entities
     WHERE org_id = $1 AND entity_type = $2 AND name = $3
     RETURNING id`,
    [orgId, entityType, name],
  );
  return rows.length > 0;
}

/**
 * Count entities for an org, optionally by type.
 */
export async function countEntities(
  orgId: string,
  entityType?: SemanticEntityType,
): Promise<number> {
  if (!hasInternalDB()) return 0;

  const rows = entityType
    ? await internalQuery<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM semantic_entities WHERE org_id = $1 AND entity_type = $2`,
        [orgId, entityType],
      )
    : await internalQuery<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM semantic_entities WHERE org_id = $1`,
        [orgId],
      );
  return parseInt(rows[0]?.count ?? "0", 10);
}

/**
 * Bulk upsert entities for an org. Each entity is upserted individually —
 * failures are logged and skipped (partial imports are expected).
 * Used by the import endpoint.
 */
export async function bulkUpsertEntities(
  orgId: string,
  entities: Array<{ entityType: SemanticEntityType; name: string; yamlContent: string; connectionId?: string }>,
): Promise<number> {
  if (!hasInternalDB()) {
    throw new Error("Internal DB required for org-scoped semantic entities");
  }
  if (entities.length === 0) return 0;

  let upserted = 0;
  for (const e of entities) {
    try {
      await upsertEntity(orgId, e.entityType, e.name, e.yamlContent, e.connectionId);
      upserted++;
    } catch (err) {
      log.warn(
        { orgId, entityType: e.entityType, name: e.name, err: err instanceof Error ? err.message : String(err) },
        "Failed to upsert semantic entity — skipping",
      );
    }
  }
  return upserted;
}
