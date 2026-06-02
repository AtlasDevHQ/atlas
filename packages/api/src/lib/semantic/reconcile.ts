/**
 * Reconcile-action dispatcher for the drift drawer. All writes stage as
 * drafts (#2177); the route layer maps `mismatch`/`not_found` → 404 and
 * `not_available` → 501.
 */

import * as yaml from "js-yaml";
import type { AtlasMode } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
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
  /** Connection alias for DB introspection — matches the drift fetch's `?connection=` query. */
  readonly connection: string;
  /**
   * Trinary group scope (#2412): `undefined` → unique-or-409, `null` →
   * legacy null-scope row, string → that group.
   */
  readonly connectionGroupId?: string | null;
}

/**
 * The `remove` ok variant carries no entity payload — the row was deleted.
 * `sync_yaml` and `create_from_db` always return the refreshed entity.
 * The nested discriminant makes `{action:"remove", entity:{...}}` and
 * `{action:"sync_yaml", entity:null}` unrepresentable.
 */
export type ReconcileResult =
  | { readonly status: "ok"; readonly action: "remove"; readonly name: string }
  | {
      readonly status: "ok";
      readonly action: "sync_yaml" | "create_from_db";
      readonly name: string;
      readonly entity: { readonly name: string; readonly yamlContent: string };
    }
  | { readonly status: "not_found"; readonly reason: string }
  | { readonly status: "mismatch"; readonly reason: string }
  | { readonly status: "not_available"; readonly reason: string };

function resolveTableName(row: SemanticEntityRow): string {
  try {
    const doc = yaml.load(row.yaml_content);
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      const t = (doc as Record<string, unknown>).table;
      if (typeof t === "string" && t.length > 0) return t;
    }
  } catch (err) {
    log.warn(
      { err: errorMessage(err), name: row.name },
      "resolveTableName: failed to parse entity YAML — falling back to row.name",
    );
  }
  return row.name;
}

/**
 * DB is authoritative; disk is a persistent cache. Disk sync failures must
 * not roll back a committed DB mutation — matches the editor's contract.
 */
async function safeSyncToDisk(
  orgId: string,
  name: string,
  yamlContent: string,
): Promise<void> {
  try {
    const { syncEntityToDisk } = await import("./sync");
    await syncEntityToDisk(orgId, name, "entity", yamlContent);
  } catch (err) {
    log.warn(
      { err: errorMessage(err), orgId, name },
      "Entity reconciled in DB but disk sync failed — will be synced on next restart",
    );
  }
}

async function safeSyncDeleteFromDisk(orgId: string, name: string): Promise<void> {
  try {
    const { syncEntityDeleteFromDisk } = await import("./sync");
    await syncEntityDeleteFromDisk(orgId, name, "entity");
  } catch (err) {
    log.warn(
      { err: errorMessage(err), orgId, name },
      "Entity removed in DB but disk sync failed — will be cleaned on next restart",
    );
  }
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
  invalidateOrgWhitelist(input.orgId);
  await safeSyncToDisk(input.orgId, input.name, updatedYaml);

  log.info(
    { orgId: input.orgId, name: input.name, table },
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
  invalidateOrgWhitelist(input.orgId);
  await safeSyncDeleteFromDisk(input.orgId, input.name);

  log.info({ orgId: input.orgId, name: input.name }, "Removed entity via reconcile");

  return { status: "ok", action: "remove", name: input.name };
}

async function reconcileCreateFromDb(input: ReconcileInput): Promise<ReconcileResult> {
  const existing = await getEntity(input.orgId, "entity", input.name, input.connectionGroupId);
  if (existing) {
    return {
      status: "mismatch",
      reason: `Entity "${input.name}" already exists. Use sync_yaml to update it instead.`,
    };
  }

  const schema = await getDBSchemaRaw(input.connection, input.orgId);
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
  invalidateOrgWhitelist(input.orgId);
  await safeSyncToDisk(input.orgId, input.name, starterYaml);

  log.info(
    { orgId: input.orgId, name: input.name, columns: columns.length },
    "Created starter entity from DB introspection",
  );

  return {
    status: "ok",
    action: "create_from_db",
    name: input.name,
    entity: { name: input.name, yamlContent: starterYaml },
  };
}
