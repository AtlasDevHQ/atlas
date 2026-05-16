/**
 * Reconcile-action dispatcher for the drift drawer (#2462 / PRD #2458 slice 3).
 *
 * Three actions on a `(orgId, entityName, connection)` tuple:
 *
 * - `sync_yaml` — rewrite the entity's YAML to match the introspected DB
 *   columns. Preserves user-authored fields via {@link reconcileEntityYaml}.
 *   Stages as draft regardless of `atlasMode` (#2177), same contract as the
 *   semantic editor PUT.
 *
 * - `remove` — delete the entity row. Mirrors the existing
 *   `deleteOrgEntityRoute` semantics: a draft is hard-deleted, a published
 *   row is tombstoned for the next publish.
 *
 * - `create_from_db` — introspect the named DB table and write a starter
 *   entity. Returns `mismatch` when an entity by that name already exists,
 *   or when the DB doesn't contain a matching table (the route layer maps
 *   both to 404 per acceptance criterion).
 *
 * The dispatcher returns a tagged {@link ReconcileResult} so the route layer
 * can map each variant to the right HTTP status without re-querying.
 */

import * as yaml from "js-yaml";
import type { AtlasMode } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  getEntity,
  upsertDraftEntity,
  deleteDraftEntityForGroup,
  upsertTombstoneForGroup,
  type SemanticEntityRow,
} from "./entities";
import { runDriftDiff, getDBSchemaRaw } from "./diff";
import { reconcileEntityYaml, generateStarterEntityYaml } from "./yaml-reconciler";

const log = createLogger("semantic-reconcile");

export type ReconcileAction = "sync_yaml" | "remove" | "create_from_db";

export interface ReconcileInput {
  readonly orgId: string;
  readonly name: string;
  readonly action: ReconcileAction;
  readonly atlasMode: AtlasMode;
  /**
   * Connection alias for DB introspection (matches the drift fetch's
   * `?connection=` query string). Used for `sync_yaml` to compute the
   * per-table diff and for `create_from_db` to find the source table.
   */
  readonly connection: string;
  /**
   * Group scope for the entity row (#2412). When omitted, mirrors the
   * unscoped-lookup contract in {@link getEntity}.
   */
  readonly connectionGroupId?: string | null;
}

export type ReconcileResult =
  | {
      readonly status: "ok";
      readonly action: ReconcileAction;
      readonly name: string;
      readonly entity: { readonly name: string; readonly yamlContent: string } | null;
    }
  | {
      readonly status: "not_found";
      readonly reason: string;
    }
  | {
      readonly status: "mismatch";
      readonly reason: string;
    }
  | {
      readonly status: "not_available";
      readonly reason: string;
    };

/**
 * Resolve the table name an entity targets — defaults to the entity row name
 * when the YAML omits an explicit `table:` field (matches the diff engine's
 * fallback in `parseEntityYAML`).
 */
function resolveTableName(row: SemanticEntityRow): string {
  try {
    const doc = yaml.load(row.yaml_content);
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      const t = (doc as Record<string, unknown>).table;
      if (typeof t === "string" && t.length > 0) return t;
    }
  } catch {
    // Fall through — caller will see an empty diff and skip the rewrite.
  }
  return row.name;
}

export async function reconcileEntity(input: ReconcileInput): Promise<ReconcileResult> {
  if (!hasInternalDB()) {
    return {
      status: "not_available",
      reason: "Reconcile requires an internal database (DATABASE_URL).",
    };
  }

  switch (input.action) {
    case "sync_yaml":
      return reconcileSyncYaml(input);
    case "remove":
      return reconcileRemove(input);
    case "create_from_db":
      return reconcileCreateFromDb(input);
  }
}

async function reconcileSyncYaml(input: ReconcileInput): Promise<ReconcileResult> {
  const row = await getEntity(input.orgId, "entity", input.name, input.connectionGroupId);
  if (!row) {
    return { status: "not_found", reason: `Entity "${input.name}" not found.` };
  }

  const table = resolveTableName(row);
  const driftResult = await runDriftDiff(input.connection, {
    orgId: input.orgId,
    atlasMode: input.atlasMode,
  });
  const tableDiff = driftResult.diff.tableDiffs.find((d) => d.table === table) ?? {
    table,
    addedColumns: [],
    removedColumns: [],
    typeChanges: [],
  };

  const updatedYaml = reconcileEntityYaml(row.yaml_content, tableDiff);
  await upsertDraftEntity(input.orgId, "entity", input.name, updatedYaml, input.connection);

  const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
  const { syncEntityToDisk } = await import("./sync");
  invalidateOrgWhitelist(input.orgId);
  await syncEntityToDisk(input.orgId, input.name, "entity", updatedYaml);

  log.info(
    { orgId: input.orgId, name: input.name, table, action: "sync_yaml" },
    "Reconciled entity YAML to DB columns",
  );

  return {
    status: "ok",
    action: "sync_yaml",
    name: input.name,
    entity: { name: input.name, yamlContent: updatedYaml },
  };
}

async function reconcileRemove(input: ReconcileInput): Promise<ReconcileResult> {
  // Mirror the existing `deleteOrgEntityRoute` semantics — hard-delete a
  // draft / tombstone-then-publish-overwrite a published row. Same draft
  // staging contract as the semantic editor (#2177).
  const existing = await getEntity(input.orgId, "entity", input.name, input.connectionGroupId);
  if (!existing) {
    return { status: "not_found", reason: `Entity "${input.name}" not found.` };
  }

  const groupId = existing.connection_group_id ?? null;
  let removed: boolean;
  if (existing.status === "draft" || existing.status === "draft_delete") {
    removed = await deleteDraftEntityForGroup(input.orgId, "entity", input.name, groupId);
  } else {
    await upsertTombstoneForGroup(input.orgId, "entity", input.name, groupId);
    removed = true;
  }
  if (!removed) {
    return { status: "not_found", reason: `Entity "${input.name}" not found.` };
  }

  const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
  const { syncEntityDeleteFromDisk } = await import("./sync");
  invalidateOrgWhitelist(input.orgId);
  await syncEntityDeleteFromDisk(input.orgId, input.name, "entity");

  log.info(
    { orgId: input.orgId, name: input.name, action: "remove" },
    "Removed entity via reconcile",
  );

  return { status: "ok", action: "remove", name: input.name, entity: null };
}

async function reconcileCreateFromDb(input: ReconcileInput): Promise<ReconcileResult> {
  // Refuse to clobber an existing entity. Acceptance criterion: 404 when
  // the action target doesn't make sense.
  const existing = await getEntity(input.orgId, "entity", input.name, input.connectionGroupId);
  if (existing) {
    return {
      status: "mismatch",
      reason: `Entity "${input.name}" already exists. Use sync_yaml to update it instead.`,
    };
  }

  // Source table name defaults to the entity name (the drift drawer opens
  // off `new` rows whose name matches the DB table). The connection's full
  // schema is introspected once and matched here so we never write a
  // starter entity for a non-existent table.
  const schema = await getDBSchemaRaw(input.connection);
  const snapshot = schema.get(input.name);
  if (!snapshot) {
    return {
      status: "mismatch",
      reason: `Table "${input.name}" not found on connection "${input.connection}".`,
    };
  }

  const columns = [...snapshot.columns].map(([name, type]) => ({ name, type }));
  const starterYaml = generateStarterEntityYaml(input.name, columns);

  await upsertDraftEntity(input.orgId, "entity", input.name, starterYaml, input.connection);
  const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
  const { syncEntityToDisk } = await import("./sync");
  invalidateOrgWhitelist(input.orgId);
  await syncEntityToDisk(input.orgId, input.name, "entity", starterYaml);

  log.info(
    { orgId: input.orgId, name: input.name, columns: columns.length, action: "create_from_db" },
    "Created starter entity from DB introspection",
  );

  return {
    status: "ok",
    action: "create_from_db",
    name: input.name,
    entity: { name: input.name, yamlContent: starterYaml },
  };
}
