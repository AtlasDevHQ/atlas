/**
 * CRUD helpers for org-scoped semantic entities stored in the internal DB.
 *
 * Entity types: "entity", "metric", "glossary", "catalog".
 * Each entity is stored as raw YAML content keyed by (orgId, entityType, name).
 */

import { internalQuery, hasInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { Effect, Duration } from "effect";
import { normalizeError } from "@atlas/api/lib/effect/errors";

const log = createLogger("semantic-entities");

export type SemanticEntityType = "entity" | "metric" | "glossary" | "catalog";

/** Valid status values for semantic entities in the developer/published mode system. */
export const SEMANTIC_ENTITY_STATUSES = ["published", "draft", "draft_delete", "archived"] as const;
export type SemanticEntityStatus = (typeof SEMANTIC_ENTITY_STATUSES)[number];

export interface SemanticEntityRow {
  id: string;
  org_id: string;
  entity_type: SemanticEntityType;
  name: string;
  yaml_content: string;
  connection_id: string | null;
  status: SemanticEntityStatus;
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
 * List all semantic entities for an org, optionally filtered by type and status.
 *
 * @param statusFilter - When provided, adds `AND status = $N` to the query.
 *   Use `"published"` in published mode to hide draft/archived rows.
 *   Omit (or pass undefined) in developer mode to return all rows.
 */
export async function listEntities(
  orgId: string,
  entityType?: SemanticEntityType,
  statusFilter?: SemanticEntityStatus,
): Promise<SemanticEntityRow[]> {
  if (!hasInternalDB()) return [];

  if (entityType) {
    if (statusFilter) {
      return internalQuery<SemanticEntityRow>(
        `SELECT id, org_id, entity_type, name, yaml_content, connection_id, status, created_at, updated_at
         FROM semantic_entities
         WHERE org_id = $1 AND entity_type = $2 AND status = $3
         ORDER BY name`,
        [orgId, entityType, statusFilter],
      );
    }
    return internalQuery<SemanticEntityRow>(
      `SELECT id, org_id, entity_type, name, yaml_content, connection_id, status, created_at, updated_at
       FROM semantic_entities
       WHERE org_id = $1 AND entity_type = $2
       ORDER BY name`,
      [orgId, entityType],
    );
  }

  if (statusFilter) {
    return internalQuery<SemanticEntityRow>(
      `SELECT id, org_id, entity_type, name, yaml_content, connection_id, status, created_at, updated_at
       FROM semantic_entities
       WHERE org_id = $1 AND status = $2
       ORDER BY entity_type, name`,
      [orgId, statusFilter],
    );
  }

  return internalQuery<SemanticEntityRow>(
    `SELECT id, org_id, entity_type, name, yaml_content, connection_id, status, created_at, updated_at
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
    `SELECT id, org_id, entity_type, name, yaml_content, connection_id, status, created_at, updated_at
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
 * Count entities for an org, optionally by type and status.
 */
export async function countEntities(
  orgId: string,
  entityType?: SemanticEntityType,
  statusFilter?: SemanticEntityStatus,
): Promise<number> {
  if (!hasInternalDB()) return 0;

  let query: string;
  let params: unknown[];

  if (entityType && statusFilter) {
    query = `SELECT COUNT(*)::TEXT AS count FROM semantic_entities WHERE org_id = $1 AND entity_type = $2 AND status = $3`;
    params = [orgId, entityType, statusFilter];
  } else if (entityType) {
    query = `SELECT COUNT(*)::TEXT AS count FROM semantic_entities WHERE org_id = $1 AND entity_type = $2`;
    params = [orgId, entityType];
  } else if (statusFilter) {
    query = `SELECT COUNT(*)::TEXT AS count FROM semantic_entities WHERE org_id = $1 AND status = $2`;
    params = [orgId, statusFilter];
  } else {
    query = `SELECT COUNT(*)::TEXT AS count FROM semantic_entities WHERE org_id = $1`;
    params = [orgId];
  }

  const rows = await internalQuery<{ count: string }>(query, params);
  return parseInt(rows[0]?.count ?? "0", 10);
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

export interface SemanticEntityVersionRow {
  id: string;
  entity_id: string;
  org_id: string;
  entity_type: SemanticEntityType;
  name: string;
  yaml_content: string;
  change_summary: string | null;
  author_id: string | null;
  author_label: string | null;
  version_number: number;
  created_at: string;
  [key: string]: unknown;
}

/**
 * Create a version snapshot for a semantic entity.
 * Version number is auto-computed as MAX(version_number) + 1 for the entity.
 */
export async function createVersion(
  entityId: string,
  orgId: string,
  entityType: SemanticEntityType,
  name: string,
  yamlContent: string,
  changeSummary: string | null,
  authorId: string | null,
  authorLabel: string | null,
): Promise<string> {
  if (!hasInternalDB()) {
    throw new Error("Internal DB required for semantic entity versions");
  }

  const rows = await internalQuery<{ id: string }>(
    `INSERT INTO semantic_entity_versions
       (entity_id, org_id, entity_type, name, yaml_content, change_summary, author_id, author_label, version_number)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, COALESCE(MAX(version_number), 0) + 1
     FROM semantic_entity_versions
     WHERE entity_id = $1
     RETURNING id`,
    [entityId, orgId, entityType, name, yamlContent, changeSummary, authorId, authorLabel],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(`Failed to create version snapshot for entity ${entityId}: INSERT returned no rows`);
  }
  return id;
}

/**
 * List version summaries for an entity (no YAML content for efficiency).
 */
export async function listVersions(
  orgId: string,
  entityType: SemanticEntityType,
  name: string,
  limit = 20,
  offset = 0,
): Promise<{ versions: Omit<SemanticEntityVersionRow, "yaml_content">[]; total: number }> {
  if (!hasInternalDB()) return { versions: [], total: 0 };

  const [versions, countRows] = await Effect.runPromise(
    Effect.all([
      Effect.tryPromise({
        try: () => internalQuery<Omit<SemanticEntityVersionRow, "yaml_content">>(
          `SELECT id, entity_id, org_id, entity_type, name, change_summary, author_id, author_label, version_number, created_at
           FROM semantic_entity_versions
           WHERE org_id = $1 AND entity_type = $2 AND name = $3
           ORDER BY version_number DESC
           LIMIT $4 OFFSET $5`,
          [orgId, entityType, name, limit, offset],
        ),
        catch: normalizeError,
      }),
      Effect.tryPromise({
        try: () => internalQuery<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count
           FROM semantic_entity_versions
           WHERE org_id = $1 AND entity_type = $2 AND name = $3`,
          [orgId, entityType, name],
        ),
        catch: normalizeError,
      }),
    ], { concurrency: "unbounded" }).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(30),
        onTimeout: () => new Error(`Version listing queries for ${entityType}/${name} timed out after 30s`),
      }),
    ),
  );

  return {
    versions,
    total: parseInt(countRows[0]?.count ?? "0", 10),
  };
}

/**
 * Get a single version with full YAML content.
 */
export async function getVersion(
  versionId: string,
  orgId: string,
): Promise<SemanticEntityVersionRow | null> {
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<SemanticEntityVersionRow>(
    `SELECT id, entity_id, org_id, entity_type, name, yaml_content, change_summary, author_id, author_label, version_number, created_at
     FROM semantic_entity_versions
     WHERE id = $1 AND org_id = $2`,
    [versionId, orgId],
  );
  return rows[0] ?? null;
}

/**
 * Generate a human-readable summary of what changed between two YAML versions.
 * Returns null if comparison fails (non-fatal).
 */
export async function generateChangeSummary(
  oldYaml: string | null,
  newYaml: string,
): Promise<string | null> {
  if (!oldYaml) return "Initial version";

  try {
    const yaml = await import("js-yaml");
    const oldObj = yaml.load(oldYaml) as Record<string, unknown> | null;
    const newObj = yaml.load(newYaml) as Record<string, unknown> | null;
    if (!oldObj || !newObj) return null;

    const parts: string[] = [];

    // Compare array sections
    const sections: Array<{ key: string; label: string }> = [
      { key: "dimensions", label: "dimension" },
      { key: "measures", label: "measure" },
      { key: "joins", label: "join" },
      { key: "query_patterns", label: "pattern" },
    ];

    for (const { key, label } of sections) {
      const oldArr = Array.isArray(oldObj[key]) ? (oldObj[key] as Array<{ name?: string }>) : [];
      const newArr = Array.isArray(newObj[key]) ? (newObj[key] as Array<{ name?: string }>) : [];
      const oldNames = new Set(oldArr.map((d) => d.name ?? ""));
      const newNames = new Set(newArr.map((d) => d.name ?? ""));
      const added = [...newNames].filter((n) => n && !oldNames.has(n)).length;
      const removed = [...oldNames].filter((n) => n && !newNames.has(n)).length;
      if (added > 0) parts.push(`+${added} ${label}${added > 1 ? "s" : ""}`);
      if (removed > 0) parts.push(`-${removed} ${label}${removed > 1 ? "s" : ""}`);
    }

    // Check description change
    if ((oldObj.description ?? "") !== (newObj.description ?? "")) {
      parts.push("description updated");
    }

    // Check table name change
    if ((oldObj.table ?? "") !== (newObj.table ?? "")) {
      parts.push("table renamed");
    }

    return parts.length > 0 ? parts.join(", ") : "No structural changes";
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to generate change summary — returning null",
    );
    return null;
  }
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
