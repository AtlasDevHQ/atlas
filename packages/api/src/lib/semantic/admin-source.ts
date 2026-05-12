/**
 * Unified admin-entity source (#2312).
 *
 * Before this module, list and detail read from different places:
 *
 * - List forked by `isSaas` between `/admin/semantic/org/entities`
 *   (DB-backed, via `listEntitiesWithOverlay`) and
 *   `/admin/semantic/entities` (disk via `discoverEntities`).
 * - Detail read disk-only with a DB-overlay fallback bolted on as the
 *   #2310 hotfix.
 *
 * The split meant a SaaS list could surface a draft entity that the
 * detail endpoint couldn't resolve — every click became
 * `Failed to load "<name>": HTTP 404`. The hotfix patched detail; this
 * module retires the divergence by feeding both routes from one
 * DB-overlay-aware source.
 *
 * Boundary: `mergeAdminEntities` and `parseRowToAdminSummary` are pure
 * (data-in / data-out, no I/O) so they're easy to unit-test. The
 * orchestrators `listAdminEntities` and `getAdminEntity` do the I/O —
 * the route handlers in `admin.ts` delegate to them.
 *
 * Shadow rule: when a DB row and a disk entity share a `name`, the DB
 * row wins. This matches `listEntitiesWithOverlay`'s spirit (DB is the
 * source of truth; disk is a mirror that can lag on a Railway pod
 * restart) and prevents stale disk entries from masking fresh drafts in
 * developer mode.
 */

import * as path from "path";
import * as yaml from "js-yaml";
import { createLogger } from "@atlas/api/lib/logger";
import {
  getEntity,
  listEntitiesWithOverlay,
  listEntityRows,
  type SemanticEntityRow,
  type SemanticEntityStatus,
} from "./entities";
import {
  discoverEntities,
  findEntityFile,
  isValidEntityName,
  readYamlFile,
  type EntitySummary,
} from "./files";
import { getSemanticRoot as resolveSemanticRoot } from "./sync";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { EntityShape } from "./shapes";

const log = createLogger("semantic-admin-source");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AdminEntitySourceKind = "db" | "disk";

/**
 * Caller-facing summary shape. Superset of disk's `EntitySummary` plus
 * lifecycle fields the file tree needs to render draft accents.
 *
 * `name` is the entity's display name (the YAML `name:` field if
 * present, otherwise the table name). `table` is always the SQL table.
 * Some entities deliberately differ (e.g. a metric named `mrr` against
 * the `subscription_events` table); collapsing them was the conflation
 * bug the frontend's shape-normalizer at `admin/semantic/page.tsx:467`
 * was masking.
 */
export interface AdminEntitySummary {
  readonly name: string;
  readonly table: string;
  readonly description: string;
  readonly columnCount: number;
  readonly joinCount: number;
  readonly measureCount: number;
  /** "default" for the base disk dir, the subdir name for per-source entities, or the DB row's `connection_id` (or "default" when null). */
  readonly source: string;
  /** Value of the YAML `connection:` field when set — distinct from the DB row's connection_id. */
  readonly connection: string | null;
  /** Value of the YAML `type:` field — only set on some entity definitions. */
  readonly type: string | null;
  readonly status: SemanticEntityStatus;
  readonly sourceKind: AdminEntitySourceKind;
  readonly connectionId: string | null;
  readonly updatedAt: string | null;
}

export interface AdminEntityListResult {
  readonly entities: AdminEntitySummary[];
  readonly warnings: string[];
}

export interface AdminEntityDetail {
  readonly entity: Record<string, unknown>;
  readonly status: SemanticEntityStatus;
  readonly source: AdminEntitySourceKind;
}

/**
 * Thrown by `getAdminEntity` when an entity row exists but its YAML
 * content can't be projected to an object. Route handlers map this to
 * a 500 with a `requestId` for log correlation — the three distinct
 * `kind` values let on-call distinguish a data-integrity issue (parse,
 * shape) from a programmer error.
 */
export class AdminEntityYamlError extends Error {
  constructor(
    public readonly kind: "parse" | "shape",
    public readonly entityName: string,
    public readonly entitySource: AdminEntitySourceKind,
    cause?: unknown,
  ) {
    super(`Admin entity YAML ${kind} error for "${entityName}" (source=${entitySource})`);
    this.name = "AdminEntityYamlError";
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — no I/O, fully unit-testable
// ---------------------------------------------------------------------------

interface YamlCounts {
  readonly columnCount: number;
  readonly joinCount: number;
  readonly measureCount: number;
}

/**
 * Compute dimension / join / measure counts from a parsed entity YAML
 * object. Mirrors the projection in `discoverEntities` so disk and DB
 * rows produce identical counts for the same content.
 */
function countSections(raw: Record<string, unknown>): YamlCounts {
  const dimensions = raw.dimensions;
  let columnCount = 0;
  if (Array.isArray(dimensions)) {
    columnCount = dimensions.length;
  } else if (dimensions && typeof dimensions === "object") {
    columnCount = Object.keys(dimensions).length;
  }

  const joins = raw.joins;
  let joinCount = 0;
  if (Array.isArray(joins)) {
    joinCount = joins.length;
  } else if (joins && typeof joins === "object") {
    joinCount = Object.keys(joins).length;
  }

  const measures = raw.measures;
  let measureCount = 0;
  if (Array.isArray(measures)) {
    measureCount = measures.length;
  } else if (measures && typeof measures === "object") {
    measureCount = Object.keys(measures).length;
  }

  return { columnCount, joinCount, measureCount };
}

/**
 * Project a single DB row to the admin summary shape. Returns `null` for
 * rows whose YAML is unparseable, has no `table` field, or doesn't
 * deserialize to an object — same gate the SQL whitelist applies, so
 * the file tree and the agent can't drift on what counts as queryable.
 */
export function parseRowToAdminSummary(row: SemanticEntityRow): AdminEntitySummary | null {
  let raw: unknown;
  try {
    raw = yaml.load(row.yaml_content);
  } catch (err) {
    log.warn(
      { orgId: row.org_id, name: row.name, err: err instanceof Error ? err.message : String(err) },
      "parseRowToAdminSummary: failed to parse yaml_content — skipping row",
    );
    return null;
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const parsed = EntityShape.safeParse(raw);
  if (!parsed.success || !parsed.data.table) return null;

  const data = parsed.data as Record<string, unknown>;
  const nameField = typeof data.name === "string" && data.name ? data.name : null;
  const { columnCount, joinCount, measureCount } = countSections(data);

  return {
    name: nameField ?? parsed.data.table,
    table: parsed.data.table,
    description: typeof data.description === "string" ? data.description : "",
    columnCount,
    joinCount,
    measureCount,
    source: row.connection_id ?? "default",
    connection: typeof data.connection === "string" ? data.connection : null,
    type: typeof data.type === "string" ? data.type : null,
    status: row.status,
    sourceKind: "db",
    connectionId: row.connection_id,
    updatedAt: row.updated_at,
  };
}

function diskToAdminSummary(e: EntitySummary): AdminEntitySummary {
  return {
    name: e.table,
    table: e.table,
    description: e.description,
    columnCount: e.columnCount,
    joinCount: e.joinCount,
    measureCount: e.measureCount,
    source: e.source,
    connection: e.connection,
    type: e.type,
    status: "published",
    sourceKind: "disk",
    connectionId: null,
    updatedAt: null,
  };
}

/**
 * Combine DB rows + disk entities into a single sorted list. Pure — no
 * I/O, fully deterministic given the inputs. The "shadow" rule: a DB
 * row wins over a disk entity with the same `name`.
 *
 * Callers (the orchestrator below) are responsible for pre-filtering DB
 * rows via `listEntitiesWithOverlay` (developer mode) or
 * `listEntityRows(..., 'published')` (published mode). This helper
 * doesn't re-implement those visibility rules; it just merges.
 */
export function mergeAdminEntities(input: {
  readonly dbRows: readonly SemanticEntityRow[];
  readonly diskEntities: readonly EntitySummary[];
  readonly diskWarnings: readonly string[];
}): AdminEntityListResult {
  const merged: AdminEntitySummary[] = [];
  const seen = new Set<string>();

  for (const row of input.dbRows) {
    const summary = parseRowToAdminSummary(row);
    if (!summary) continue;
    if (seen.has(summary.name)) continue;
    seen.add(summary.name);
    merged.push(summary);
  }

  for (const entry of input.diskEntities) {
    const summary = diskToAdminSummary(entry);
    if (seen.has(summary.name)) continue;
    seen.add(summary.name);
    merged.push(summary);
  }

  merged.sort((a, b) => a.name.localeCompare(b.name));
  return { entities: merged, warnings: [...input.diskWarnings] };
}

// ---------------------------------------------------------------------------
// Orchestrators — wire the pure helper to I/O
// ---------------------------------------------------------------------------

/**
 * Load the unified admin entity list for a request.
 *
 * - DB read (when `hasInternalDB()` and an `orgId` is present) uses
 *   `listEntitiesWithOverlay` in developer mode and `listEntityRows`
 *   with `status='published'` otherwise. The visibility / overlay rules
 *   live in those queries — not duplicated here.
 * - Disk read scopes to `resolveSemanticRoot(orgId)` so a SaaS request
 *   reads `.orgs/<orgId>/`, not the API container's bundled fixture.
 * - The two are merged with DB-shadows-disk so a stale on-disk mirror
 *   never masks a fresh DB draft.
 */
export async function listAdminEntities(opts: {
  readonly orgId?: string;
  readonly mode?: "developer" | "published";
}): Promise<AdminEntityListResult> {
  const mode = opts.mode ?? "published";

  let dbRows: SemanticEntityRow[] = [];
  if (opts.orgId && hasInternalDB()) {
    dbRows = mode === "developer"
      ? await listEntitiesWithOverlay(opts.orgId, "entity")
      : await listEntityRows(opts.orgId, "entity", "published");
  }

  const root = resolveSemanticRoot(opts.orgId);
  const { entities: diskEntities, warnings } = discoverEntities(root);

  return mergeAdminEntities({ dbRows, diskEntities, diskWarnings: warnings });
}

interface GetAdminEntityOptions {
  readonly name: string;
  readonly orgId?: string;
  readonly requestId?: string;
}

/**
 * Resolve a single admin entity by name. Returns `null` when neither
 * disk nor DB has it — the route handler maps that to a 404.
 *
 * Resolution order is disk-first, DB-fallback. Disk wins because the
 * per-source subdirectory layout (`semantic/<source>/entities/<name>.yml`)
 * is the canonical place self-hosted users keep authored YAML, and we
 * want a fast short-circuit when the local file is present. DB picks up
 * the SaaS / draft case the disk doesn't know about.
 *
 * Errors:
 * - Invalid `name` (path traversal probe) → `null` (route maps to 400
 *   via `isValidEntityName` check before calling).
 * - YAML parse failure or non-object shape → throws `AdminEntityYamlError`.
 *   Route maps to 500 with `requestId`.
 * - DB query failure → propagates the underlying Error so the route can
 *   log + 500. Don't swallow — masking a DB outage as "not found" would
 *   make the frontend show an empty workspace.
 */
export async function getAdminEntity(opts: GetAdminEntityOptions): Promise<AdminEntityDetail | null> {
  const { name, orgId, requestId } = opts;

  if (!isValidEntityName(name)) {
    log.warn({ requestId, name }, "getAdminEntity: rejected invalid entity name");
    return null;
  }

  // 1. Disk first
  const diskRoot = resolveSemanticRoot(orgId);
  const filePath = findEntityFile(diskRoot, name);
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(diskRoot))) {
      log.error({ requestId, name, resolved, root: diskRoot }, "getAdminEntity: resolved path escaped semantic root");
      return null;
    }

    let raw: unknown;
    try {
      raw = readYamlFile(filePath);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), filePath, entityName: name, requestId },
        "getAdminEntity: failed to parse entity YAML file",
      );
      throw new AdminEntityYamlError("parse", name, "disk", err);
    }

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      log.error(
        { entityName: name, requestId, parsedType: raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw },
        "getAdminEntity: disk YAML did not parse to an object",
      );
      throw new AdminEntityYamlError("shape", name, "disk");
    }

    return { entity: raw as Record<string, unknown>, status: "published", source: "disk" };
  }

  // 2. DB fallback — only when we have both an org and the internal DB
  if (orgId && hasInternalDB()) {
    let row: SemanticEntityRow | null;
    try {
      row = await getEntity(orgId, "entity", name);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), entityName: name, orgId, requestId },
        "getAdminEntity: DB overlay query failed",
      );
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (!row) return null;

    let parsed: unknown;
    try {
      parsed = yaml.load(row.yaml_content);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), entityName: name, orgId, requestId },
        "getAdminEntity: DB-backed YAML parse failed",
      );
      throw new AdminEntityYamlError("parse", name, "db", err);
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.error(
        { entityName: name, orgId, requestId, parsedType: parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed },
        "getAdminEntity: DB-backed YAML did not parse to an object",
      );
      throw new AdminEntityYamlError("shape", name, "db");
    }

    return { entity: parsed as Record<string, unknown>, status: row.status, source: "db" };
  }

  return null;
}
