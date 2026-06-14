/**
 * REST-derived admin entities — the read-only `/admin/semantic` surface for
 * REST/OpenAPI datasources (#3628).
 *
 * REST datasources are queryable the moment they're installed (the agent
 * renders entities live from the cached `openapi_snapshot` at prompt-build
 * time), but until now they were INVISIBLE to `/admin/semantic`: a REST-only
 * workspace saw a "no semantic layer / run atlas init" empty state while the
 * agent was happily querying REST entities. This module converges REST onto
 * the same admin surface SQL datasources use — WITHOUT persisting anything.
 *
 * Convergence, not consolidation (ADR-0017):
 * - Entities are derived on read from the cached snapshot via the SAME pure
 *   {@link generateSemanticModel} the agent's Path B uses — never persisted to
 *   `semantic_entities`, never publish-gated. A "Rediscover schema" re-probe is
 *   the only refresh; there is no draft/publish lifecycle to keep in sync.
 * - The result is strictly READ-ONLY (`readOnly: true`); the admin route never
 *   exposes edit/delete/version paths for these rows, and the web hides those
 *   controls.
 *
 * Token note: this is a HUMAN-facing admin view. It renders entity YAML for
 * display only and does NOT touch what the agent consumes at prompt time —
 * the REST agent prompt stays on the compact `operation-graph` representation
 * (Path A) regardless. No agent-token cost. See issue #3628.
 */
import { createLogger } from "@atlas/api/lib/logger";
import { resolveWorkspaceRestDatasources } from "./workspace-datasource";
import { generateSemanticModel, renderEntityYaml } from "./semantic-generator";
import type { GeneratedEntity } from "./semantic-generator";
import type { RestDatasource } from "./datasource";
import {
  REST_ENTITY_TYPE_TAG,
  ENTITY_YAML_DIMENSION_KEYS,
  ENTITY_YAML_JOIN_KEYS,
} from "@useatlas/schemas/semantic-entity-yaml";

const log = createLogger("admin-rest-entities");

/**
 * Delimiter joining a datasource install id to an entity name in the admin
 * storage key. Two workspace-global REST datasources can each expose a `Person`
 * entity; embedding the install id keeps the `(name, connectionId)` admin dedup
 * key unique and lets the detail/raw routes resolve the exact datasource
 * without a separate lookup. `::` survives {@link isValidEntityName} (it only
 * forbids `/`, `\`, `..`, `\0`) and `encodeURIComponent` in the web URL.
 */
export const REST_ENTITY_KEY_DELIMITER = "::";

/** Build the admin storage key for a REST entity. */
export function makeRestEntityKey(installId: string, entityName: string): string {
  return `${installId}${REST_ENTITY_KEY_DELIMITER}${entityName}`;
}

/**
 * Parse a REST admin storage key back into its install id + entity name.
 * Returns `null` for a non-REST key (no delimiter) so callers can fall through
 * to the DB/disk source. Splits on the FIRST delimiter — install ids never
 * contain `::`, and an entity name theoretically could, so the remainder is the
 * entity name verbatim.
 */
export function parseRestEntityKey(
  name: string,
): { readonly installId: string; readonly entityName: string } | null {
  const idx = name.indexOf(REST_ENTITY_KEY_DELIMITER);
  if (idx <= 0) return null;
  const installId = name.slice(0, idx);
  const entityName = name.slice(idx + REST_ENTITY_KEY_DELIMITER.length);
  if (!installId || !entityName) return null;
  return { installId, entityName };
}

/**
 * Admin summary for a REST-derived entity. Structurally compatible with the
 * SQL `AdminEntitySummary` shared fields the web list mapper reads, plus
 * `readOnly: true` and `sourceKind: "rest"`. `status` is always `"published"`
 * — REST entities are queryable on install, with no draft lifecycle.
 */
export interface RestAdminEntitySummary {
  readonly name: string;
  readonly displayName: string;
  readonly table: string;
  readonly description: string;
  readonly columnCount: number;
  readonly joinCount: number;
  readonly measureCount: number;
  readonly source: string;
  readonly connection: string | null;
  readonly type: string;
  readonly sourceKind: "rest";
  readonly status: "published";
  readonly connectionId: string | null;
  readonly readOnly: true;
  /** Human-facing datasource name, for disambiguating same-named entities. */
  readonly datasourceName: string;
}

export interface RestAdminEntityListResult {
  readonly entities: RestAdminEntitySummary[];
  readonly warnings: string[];
}

/** Web detail shape — mirrors the SQL entity-detail JSON the web's `EntityDetail` reads. */
export interface RestAdminEntityDetail {
  readonly entity: {
    readonly name: string;
    readonly table: string;
    readonly description: string;
    readonly type: typeof REST_ENTITY_TYPE_TAG;
    readonly readOnly: true;
    readonly dimensions: ReadonlyArray<Record<string, unknown>>;
    readonly joins: ReadonlyArray<Record<string, unknown>>;
    readonly measures: ReadonlyArray<never>;
    readonly query_patterns: ReadonlyArray<Record<string, unknown>>;
  };
  /** The rendered entity YAML (Path B renderer), for the admin "YAML" view. */
  readonly yaml: string;
}

/**
 * Map a generated REST entity to the web detail shape the shared `EntityDetail`
 * component reads. Pure (no I/O) so the mapping is unit-tested directly. Joins
 * are mapped to the web `Join` shape (`to` / `relationship` / `description`) so
 * they render with a name; columns become `dimensions`.
 */
export function toDetailEntity(entity: GeneratedEntity): RestAdminEntityDetail["entity"] {
  return {
    name: entity.name,
    table: entity.resource,
    description: entity.description,
    type: REST_ENTITY_TYPE_TAG,
    readOnly: true,
    // Shared dimension key names come from the contract so the detail JSON path
    // can't drift from the YAML renderers either. `to` is the web `Join` shape
    // (the shared EntityDetail component reads it) — deliberately NOT the YAML
    // `target_entity` — but `relationship` is the one shared join key.
    dimensions: entity.columns.map((c) => {
      const dim: Record<string, unknown> = {
        [ENTITY_YAML_DIMENSION_KEYS.name]: c.name,
        [ENTITY_YAML_DIMENSION_KEYS.type]: c.type,
      };
      if (c.primaryKey) dim[ENTITY_YAML_DIMENSION_KEYS.primaryKey] = true;
      if (c.description) dim[ENTITY_YAML_DIMENSION_KEYS.description] = c.description;
      return dim;
    }),
    joins: entity.joins.map((j) => {
      const join: Record<string, unknown> = {
        to: j.targetEntity,
        [ENTITY_YAML_JOIN_KEYS.relationship]: j.relationship,
      };
      if (j.description) join.description = j.description;
      return join;
    }),
    measures: [],
    query_patterns: entity.queryPatterns.map((qp) => ({
      name: qp.name,
      description: qp.description,
    })),
  };
}

export function summarizeEntity(ds: RestDatasource, entity: GeneratedEntity): RestAdminEntitySummary {
  // A REST datasource's cross-environment scope (ADR-0010): `groupId` places
  // its entities under that group in the file tree, exactly like SQL entities;
  // workspace-global datasources (no group) sort into the default section.
  const connectionId = ds.groupId ?? null;
  return {
    name: makeRestEntityKey(ds.id, entity.name),
    displayName: entity.name,
    table: entity.resource,
    description: entity.description,
    columnCount: entity.columns.length,
    joinCount: entity.joins.length,
    measureCount: 0,
    source: connectionId ?? "default",
    connection: null,
    type: REST_ENTITY_TYPE_TAG,
    sourceKind: "rest",
    status: "published",
    connectionId,
    readOnly: true,
    datasourceName: ds.displayName,
  };
}

/**
 * List every REST-derived entity across the workspace's REST datasources.
 * Never throws: the resolver is fail-soft (`[]` on error) and generation is
 * pure, so a single broken snapshot degrades to a warning rather than emptying
 * the admin list. `activeGroupId` is intentionally omitted so the admin view
 * shows ALL installs regardless of any conversation env pin (this is an
 * operator surface, not a chat turn).
 */
export async function listRestAdminEntities(orgId: string): Promise<RestAdminEntityListResult> {
  const entities: RestAdminEntitySummary[] = [];
  const warnings: string[] = [];

  let datasources: ReadonlyArray<RestDatasource>;
  try {
    datasources = await resolveWorkspaceRestDatasources(orgId);
  } catch (err) {
    // The fail-soft resolver shouldn't reject, but never let an unexpected
    // throw blank the SQL entity list it's merged with.
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "listRestAdminEntities: resolver threw — returning no REST entities",
    );
    return { entities, warnings };
  }

  for (const ds of datasources) {
    try {
      const model = generateSemanticModel(ds.graph);
      for (const entity of model.entities) {
        entities.push(summarizeEntity(ds, entity));
      }
    } catch (err) {
      log.warn(
        { orgId, datasourceId: ds.id, err: err instanceof Error ? err.message : String(err) },
        "listRestAdminEntities: failed to generate model for a REST datasource — skipping it",
      );
      warnings.push(`Could not read entities from REST datasource "${ds.displayName}".`);
    }
  }

  // Deterministic order so the file tree is stable across loads.
  entities.sort((a, b) => {
    const byName = a.displayName.localeCompare(b.displayName);
    if (byName !== 0) return byName;
    return (a.connectionId ?? "").localeCompare(b.connectionId ?? "");
  });

  return { entities, warnings };
}

/**
 * Resolve a single REST entity's read-only detail by its admin storage key.
 * Returns `null` when the key isn't a REST key, the datasource is gone, or the
 * entity isn't in the (current) snapshot — the route maps that to a 404 (or a
 * fall-through to DB/disk). Uses the resolver's `focus` to resolve ONLY the
 * keyed install, avoiding decrypting every datasource's credentials.
 */
export async function getRestAdminEntityDetail(
  orgId: string,
  name: string,
): Promise<RestAdminEntityDetail | null> {
  const parsed = parseRestEntityKey(name);
  if (!parsed) return null;

  let datasources: ReadonlyArray<RestDatasource>;
  try {
    datasources = await resolveWorkspaceRestDatasources(orgId, { focus: parsed.installId });
  } catch (err) {
    log.warn(
      { orgId, installId: parsed.installId, err: err instanceof Error ? err.message : String(err) },
      "getRestAdminEntityDetail: resolver threw",
    );
    return null;
  }

  const ds = datasources.find((d) => d.id === parsed.installId);
  if (!ds) return null;

  const model = generateSemanticModel(ds.graph);
  const entity = model.entities.find((e) => e.name === parsed.entityName);
  if (!entity) return null;

  return {
    entity: toDetailEntity(entity),
    yaml: renderEntityYaml(entity),
  };
}
