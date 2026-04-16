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
 * Upsert a semantic entity for an org at status='published'.
 *
 * Writes the published row — used for direct (non-draft) updates from the
 * editor and the expert amendment flow. Uses ON CONFLICT on the partial
 * published unique index so draft/tombstone rows for the same key are
 * preserved untouched.
 *
 * For the developer-mode draft workflow, use `upsertDraftEntity` instead.
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
    `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_id, status)
     VALUES ($1, $2, $3, $4, $5, 'published')
     ON CONFLICT (org_id, name, COALESCE(connection_id, '__default__')) WHERE status = 'published'
     DO UPDATE SET yaml_content = EXCLUDED.yaml_content,
                   entity_type = EXCLUDED.entity_type,
                   connection_id = EXCLUDED.connection_id,
                   updated_at = now()`,
    [orgId, entityType, name, yamlContent, connectionId ?? null],
  );
}

/**
 * Upsert a semantic entity at status='draft'.
 *
 * Used for developer-mode writes. The published row (if any) is left
 * untouched. ON CONFLICT on the partial draft unique index updates an
 * existing draft in place.
 */
export async function upsertDraftEntity(
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
    `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_id, status)
     VALUES ($1, $2, $3, $4, $5, 'draft')
     ON CONFLICT (org_id, name, COALESCE(connection_id, '__default__')) WHERE status = 'draft'
     DO UPDATE SET yaml_content = EXCLUDED.yaml_content,
                   entity_type = EXCLUDED.entity_type,
                   connection_id = EXCLUDED.connection_id,
                   updated_at = now()`,
    [orgId, entityType, name, yamlContent, connectionId ?? null],
  );
}

/**
 * Insert a draft_delete tombstone for an entity.
 *
 * Used for developer-mode deletes where a published row exists — the
 * tombstone hides the published entity via the overlay query until publish
 * time. ON CONFLICT on the partial tombstone unique index updates the
 * tombstone's updated_at timestamp if one already exists.
 */
export async function upsertTombstone(
  orgId: string,
  entityType: SemanticEntityType,
  name: string,
  connectionId?: string,
): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Internal DB required for org-scoped semantic entities");
  }
  await internalQuery(
    `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_id, status)
     VALUES ($1, $2, $3, '', $4, 'draft_delete')
     ON CONFLICT (org_id, name, COALESCE(connection_id, '__default__')) WHERE status = 'draft_delete'
     DO UPDATE SET updated_at = now()`,
    [orgId, entityType, name, connectionId ?? null],
  );
}

/**
 * Delete the draft row (or tombstone) for an entity. Leaves any published
 * row intact. Returns true if a draft row was removed.
 *
 * Used when an admin discards an in-progress draft in developer mode.
 */
export async function deleteDraftEntity(
  orgId: string,
  entityType: SemanticEntityType,
  name: string,
  connectionId?: string,
): Promise<boolean> {
  if (!hasInternalDB()) return false;
  const rows = await internalQuery<{ id: string }>(
    `DELETE FROM semantic_entities
     WHERE org_id = $1
       AND entity_type = $2
       AND name = $3
       AND COALESCE(connection_id, '__default__') = COALESCE($4, '__default__')
       AND status IN ('draft', 'draft_delete')
     RETURNING id`,
    [orgId, entityType, name, connectionId ?? null],
  );
  return rows.length > 0;
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
 * Developer-mode overlay read for semantic entities.
 *
 * Returns the superposition of published + draft + draft_delete rows such that:
 * - A `draft_delete` tombstone hides the published entity it targets (final
 *   projection excludes tombstones)
 * - A `draft` row supersedes a published row with the same
 *   (org_id, name, connection_id) key
 * - Unmodified published entities pass through
 * - `archived` entity rows are excluded (the `status IN` filter drops them)
 * - Entities whose parent connection is archived are also excluded
 *
 * The CTE uses DISTINCT ON with a status priority (draft_delete > draft >
 * published) so exactly one row per entity key survives, then the outer
 * SELECT drops tombstones.
 *
 * Used by `loadOrgWhitelist` in developer mode. Published mode uses
 * `listEntities(..., "published")` instead — a simple status = 'published'
 * filter is sufficient because there's at most one published row per key.
 */
export async function listEntitiesWithOverlay(
  orgId: string,
  entityType?: SemanticEntityType,
): Promise<SemanticEntityRow[]> {
  if (!hasInternalDB()) return [];

  const baseSelect =
    "id, org_id, entity_type, name, yaml_content, connection_id, status, created_at, updated_at";

  if (entityType) {
    return internalQuery<SemanticEntityRow>(
      `WITH overlay AS (
         SELECT DISTINCT ON (org_id, name, connection_id) ${baseSelect}
         FROM semantic_entities
         WHERE org_id = $1
           AND entity_type = $2
           AND status IN ('published', 'draft', 'draft_delete')
           AND (
             connection_id IS NULL
             OR connection_id IN (
               SELECT id FROM connections
               WHERE org_id = $1 AND status IN ('published', 'draft')
             )
           )
         ORDER BY org_id, name, connection_id,
           CASE status
             WHEN 'draft_delete' THEN 0
             WHEN 'draft' THEN 1
             ELSE 2
           END
       )
       SELECT ${baseSelect} FROM overlay
       WHERE status != 'draft_delete'
       ORDER BY name`,
      [orgId, entityType],
    );
  }

  return internalQuery<SemanticEntityRow>(
    `WITH overlay AS (
       SELECT DISTINCT ON (org_id, name, connection_id) ${baseSelect}
       FROM semantic_entities
       WHERE org_id = $1
         AND status IN ('published', 'draft', 'draft_delete')
         AND (
           connection_id IS NULL
           OR connection_id IN (
             SELECT id FROM connections
             WHERE org_id = $1 AND status IN ('published', 'draft')
           )
         )
       ORDER BY org_id, name, connection_id,
         CASE status
           WHEN 'draft_delete' THEN 0
           WHEN 'draft' THEN 1
           ELSE 2
         END
     )
     SELECT ${baseSelect} FROM overlay
     WHERE status != 'draft_delete'
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

// ─────────────────────────────────────────────────────────────────────
// Publish helpers — operate on a caller-owned transactional client so the
// atomic publish endpoint (#1429) can run all steps under a single BEGIN.
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal pg client shape the publish helpers need. Matches the return of
 * `pool.connect()` from node-postgres, but typed here so we don't import
 * pg in code that runs in browsers/Edge.
 */
export interface TransactionalClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * Step 1: apply `draft_delete` tombstones for an org.
 *
 * Deletes the published entity row targeted by each tombstone, then deletes
 * the tombstones themselves. Returns the number of published rows removed
 * (i.e., how many entities the admin actually hid).
 *
 * Runs on a caller-supplied client so the caller controls the transaction.
 */
export async function applyTombstones(
  client: TransactionalClient,
  orgId: string,
): Promise<number> {
  // Delete the published rows targeted by tombstones (using USING join)
  const deletedPublished = await client.query(
    `DELETE FROM semantic_entities p
     USING semantic_entities d
     WHERE p.org_id = $1 AND p.status = 'published'
       AND d.org_id = p.org_id
       AND d.name = p.name
       AND COALESCE(d.connection_id, '__default__') = COALESCE(p.connection_id, '__default__')
       AND d.status = 'draft_delete'
     RETURNING p.id`,
    [orgId],
  );

  // Delete the tombstones themselves
  await client.query(
    `DELETE FROM semantic_entities WHERE org_id = $1 AND status = 'draft_delete'`,
    [orgId],
  );

  return deletedPublished.rows.length;
}

/**
 * Step 2 + 3: promote all draft entities for an org to published.
 *
 * First deletes any published row superseded by a draft for the same entity
 * key, then flips `status='draft' → 'published'` on the remaining drafts.
 * Returns the number of drafts promoted.
 */
export async function promoteDraftEntities(
  client: TransactionalClient,
  orgId: string,
): Promise<number> {
  // Remove published rows that a draft is about to replace
  await client.query(
    `DELETE FROM semantic_entities p
     USING semantic_entities d
     WHERE p.org_id = $1 AND p.status = 'published'
       AND d.org_id = p.org_id
       AND d.name = p.name
       AND COALESCE(d.connection_id, '__default__') = COALESCE(p.connection_id, '__default__')
       AND d.status = 'draft'`,
    [orgId],
  );

  // Promote drafts to published
  const promoted = await client.query(
    `UPDATE semantic_entities SET status = 'published', updated_at = now()
     WHERE org_id = $1 AND status = 'draft'
     RETURNING id`,
    [orgId],
  );
  return promoted.rows.length;
}

/** Reserved ID for the onboarding demo connection. */
export const DEMO_CONNECTION_ID = "__demo__";

/**
 * Outcome of `archiveSingleConnection` — lets the caller decide the HTTP
 * status without re-querying.
 *
 * - `not_found`: the connection row doesn't exist for this org.
 * - `already_archived`: the connection row was already `archived` when
 *   we locked it. Cascade counts still fire (the UPDATEs filter
 *   `status='published'`, so they're no-ops when nothing's left), so
 *   publish-style callers that want to reconcile straggler entities or
 *   demo prompts still get their cleanup. The route handler interprets
 *   this as an idempotent 200 for standalone calls.
 * - `archived`: happy-path — the connection row was flipped from non-
 *   archived to `archived`, with cascade counts.
 */
export type ArchiveConnectionResult =
  | { status: "not_found" }
  | { status: "already_archived"; entities: number; prompts: number }
  | { status: "archived"; entities: number; prompts: number };

/**
 * Outcome of `restoreSingleConnection`. `not_found` means the connection
 * row doesn't exist; `not_archived` means it exists but isn't currently
 * in the `archived` state — restore is strict (caller-mapped to 404),
 * not idempotent, because restoring a live connection would be surprising
 * and there's no cleanup work to reconcile.
 */
export type RestoreConnectionResult =
  | { status: "not_found" }
  | { status: "not_archived" }
  | { status: "restored"; entities: number; prompts: number };

/**
 * Archive a single connection and cascade to its semantic entities.
 *
 * Locks the connection row first with `SELECT ... FOR UPDATE` to serialize
 * concurrent archive/restore calls — without the lock, a mid-flight
 * restore could cascade entities back to `published` while a competing
 * archive flips them to `archived`, leaving the connection and entities
 * in opposite states.
 *
 * When the connection id matches `DEMO_CONNECTION_ID` and the caller
 * passes a `demoIndustry`, built-in demo prompt collections for that
 * industry are also archived — mirroring the publish-time demo cascade.
 *
 * The entity + prompt cascades always run (both UPDATEs filter on
 * `status='published'`, so they're idempotent no-ops when nothing is
 * stale). This matters for the `already_archived` case: a publish that
 * re-submits `archiveConnections: ["__demo__"]` after the connection
 * row is already archived still reconciles any entities or prompts
 * that somehow drifted back to `published`.
 *
 * Runs on a caller-supplied transactional client so the caller owns the
 * BEGIN/COMMIT boundary. Callers must wrap this in a transaction — the
 * `FOR UPDATE` lock only holds inside one.
 */
export async function archiveSingleConnection(
  client: TransactionalClient,
  orgId: string,
  connectionId: string,
  opts?: { demoIndustry?: string | null },
): Promise<ArchiveConnectionResult> {
  const current = await client.query(
    `SELECT status FROM connections WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, connectionId],
  );
  if (current.rows.length === 0) {
    return { status: "not_found" };
  }
  const row = current.rows[0] as { status: string };
  const wasAlreadyArchived = row.status === "archived";

  // Flip the connection row only if it isn't already archived. The
  // cascade UPDATEs below run in either case so stragglers get cleaned up.
  if (!wasAlreadyArchived) {
    await client.query(
      `UPDATE connections SET status = 'archived', updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [orgId, connectionId],
    );
  }

  const archivedEntities = await client.query(
    `UPDATE semantic_entities SET status = 'archived', updated_at = now()
     WHERE org_id = $1 AND connection_id = $2 AND status = 'published'
     RETURNING id`,
    [orgId, connectionId],
  );

  let promptCount = 0;
  if (connectionId === DEMO_CONNECTION_ID && opts?.demoIndustry) {
    const archivedPrompts = await client.query(
      `UPDATE prompt_collections SET status = 'archived', updated_at = now()
       WHERE org_id = $1
         AND is_builtin = true
         AND status = 'published'
         AND industry = $2
       RETURNING id`,
      [orgId, opts.demoIndustry],
    );
    promptCount = archivedPrompts.rows.length;
  }

  return {
    status: wasAlreadyArchived ? "already_archived" : "archived",
    entities: archivedEntities.rows.length,
    prompts: promptCount,
  };
}

/**
 * Restore a single archived connection and cascade entities back to
 * `published`. Demo prompt collections for the org's industry are
 * restored too when the id matches `DEMO_CONNECTION_ID` and the caller
 * passes a `demoIndustry`.
 *
 * Locks the connection row with `SELECT ... FOR UPDATE` to serialize
 * against a concurrent archive — same rationale as
 * `archiveSingleConnection`. Callers must wrap this in a transaction.
 *
 * Returns a tagged result — both `not_found` and `not_archived` are
 * caller-mapped to 404. Unlike archive's `already_archived`, restore
 * is strict: asking to restore a live connection is treated as an
 * error, not a silent success, because there's no cleanup work to
 * reconcile and flipping a live connection to its current state is
 * never what the caller meant.
 */
export async function restoreSingleConnection(
  client: TransactionalClient,
  orgId: string,
  connectionId: string,
  opts?: { demoIndustry?: string | null },
): Promise<RestoreConnectionResult> {
  const current = await client.query(
    `SELECT status FROM connections WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, connectionId],
  );
  if (current.rows.length === 0) {
    return { status: "not_found" };
  }
  const row = current.rows[0] as { status: string };
  if (row.status !== "archived") {
    return { status: "not_archived" };
  }

  await client.query(
    `UPDATE connections SET status = 'published', updated_at = now()
     WHERE org_id = $1 AND id = $2 AND status = 'archived'`,
    [orgId, connectionId],
  );

  const restoredEntities = await client.query(
    `UPDATE semantic_entities SET status = 'published', updated_at = now()
     WHERE org_id = $1 AND connection_id = $2 AND status = 'archived'
     RETURNING id`,
    [orgId, connectionId],
  );

  let promptCount = 0;
  if (connectionId === DEMO_CONNECTION_ID && opts?.demoIndustry) {
    const restoredPrompts = await client.query(
      `UPDATE prompt_collections SET status = 'published', updated_at = now()
       WHERE org_id = $1
         AND is_builtin = true
         AND status = 'archived'
         AND industry = $2
       RETURNING id`,
      [orgId, opts.demoIndustry],
    );
    promptCount = restoredPrompts.rows.length;
  }

  return {
    status: "restored",
    entities: restoredEntities.rows.length,
    prompts: promptCount,
  };
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
