/**
 * Unified admin-entity source. Both list and detail handlers read through
 * this module so they can't disagree on what's visible.
 *
 * `mergeAdminEntities` + `parseRowToAdminSummary` are pure (no I/O) for
 * unit-testability. The orchestrators `listAdminEntities` + `getAdminEntity`
 * wire them to filesystem + DB reads.
 *
 * Source rule (#2561): the internal DB is canonical for the admin API
 * when `hasInternalDB() && orgId`. The per-org disk mirror at
 * `.orgs/<orgId>/entities/` is a derived cache for the agent's `explore`
 * tool, kept in sync by `sync.ts`; admin surfaces ignore it when the DB
 * is reachable. Disk is the fallback exclusively for pure-YAML self-
 * hosted (no internal DB). Both branches route through
 * `mergeAdminEntities` so the response shape and sort order are
 * identical regardless of source.
 */

import * as path from "path";
import * as yaml from "js-yaml";
import { createLogger } from "@atlas/api/lib/logger";
import {
  getEntity,
  listEntitiesWithOverlay,
  listEntityRows,
  type SemanticEntityRow,
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
import { EntityShape, type EntityShapeT } from "./shapes";
import { dedupKey } from "./dedup-key";

const log = createLogger("semantic-admin-source");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AdminEntitySourceKind = "db" | "disk";

/**
 * Statuses that can legitimately appear in a caller-facing summary.
 *
 * The DB queries upstream (`listEntitiesWithOverlay`'s outer
 * `WHERE status != 'draft_delete'`, `listEntityRows`'s `status='published'`
 * filter) already drop `archived` + `draft_delete`, so widening to
 * `SemanticEntityStatus` here would let consumers branch on values that
 * can't appear. Disk entries are always `published`.
 */
export type AdminEntityStatus = "published" | "draft";

/**
 * Caller-facing summary shape. Discriminated on `sourceKind` so the disk
 * arm enforces `connectionId === null`, `updatedAt === null`, and
 * `status === "published"` at the type level — invariants that hold by
 * construction but used to be expressible only in comments.
 *
 * `name` is the storage key — the DB row's `name` column (DB branch) or
 * the YAML file stem (disk branch). The detail / edit / delete routes
 * look up by this exact value, so the frontend must roundtrip it through
 * URLs unchanged. #2891.
 *
 * `displayName` is what the file tree renders — the YAML `name:` field
 * if present, otherwise the `table:` value. Pre-#2891 this was overloaded
 * onto `name` and 404'd every detail lookup whose YAML name didn't match
 * the storage key.
 *
 * `table` is always the SQL table. Some entities deliberately differ on
 * `name` / `table` (e.g. a metric `name: mrr` over `table: subscription_events`).
 * Collapsing the two was the conflation bug the frontend shape-normalizer
 * was masking before #2312.
 */
interface AdminEntitySummaryShared {
  readonly name: string;
  readonly displayName: string;
  readonly table: string;
  readonly description: string;
  readonly columnCount: number;
  readonly joinCount: number;
  readonly measureCount: number;
  readonly source: string;
  /** YAML `connection:` hint — distinct from the DB row's group scope. */
  readonly connection: string | null;
  /** YAML `type:` field, when set. */
  readonly type: string | null;
}

export type AdminEntitySummary =
  | (AdminEntitySummaryShared & {
      readonly sourceKind: "db";
      readonly status: AdminEntityStatus;
      readonly connectionId: string | null;
      readonly updatedAt: string;
    })
  | (AdminEntitySummaryShared & {
      readonly sourceKind: "disk";
      readonly status: "published";
      /**
       * `null` for the default `entities/` dir. Per-source disk dirs
       * (`semantic/<source>/entities/`) lift their source name into
       * `connectionId` (#2891) — same-stem files under different sources
       * would otherwise collide on the `(name, connectionId)` dedup key.
       * Read-only for the file tree's env badge.
       */
      readonly connectionId: string | null;
      readonly updatedAt: null;
    });

export interface AdminEntityListResult {
  readonly entities: AdminEntitySummary[];
  readonly warnings: string[];
}

export interface AdminEntityDetail {
  /** Validated through `EntityShape` — `entity.table` is guaranteed to be a string. */
  readonly entity: EntityShapeT;
  readonly status: AdminEntityStatus;
  readonly source: AdminEntitySourceKind;
}

/**
 * Base class for admin entity YAML failures. Two subclasses below cover the
 * `parse` vs `shape` axis exhaustively, so a `switch` on `err.kind` at the
 * route layer can use `assertNever` for compile-time exhaustiveness.
 */
export abstract class AdminEntityYamlError extends Error {
  abstract readonly kind: "parse" | "shape";
  constructor(
    message: string,
    public readonly entityName: string,
    public readonly entitySource: AdminEntitySourceKind,
    cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Thrown when `js-yaml` cannot parse the YAML content. */
export class AdminEntityYamlParseError extends AdminEntityYamlError {
  readonly kind = "parse" as const;
  constructor(entityName: string, entitySource: AdminEntitySourceKind, cause?: unknown) {
    super(`Admin entity YAML parse error for "${entityName}" (source=${entitySource})`, entityName, entitySource, cause);
  }
}

/**
 * Thrown when the parsed YAML isn't a plain object with a `table` field —
 * the minimum shape needed to render `<EntityDetail>`. `js-yaml` will
 * happily return `null`, a string, a number, or an array for technically-
 * valid YAML; this is the gate that turns garbage into a 500 instead of
 * letting it reach the frontend.
 */
export class AdminEntityYamlShapeError extends AdminEntityYamlError {
  readonly kind = "shape" as const;
  constructor(entityName: string, entitySource: AdminEntitySourceKind) {
    super(`Admin entity YAML shape error for "${entityName}" (source=${entitySource})`, entityName, entitySource);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — no I/O, fully unit-testable
// ---------------------------------------------------------------------------

/** Count an entity-YAML section that can be either an array or an object map. */
function sectionLength(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

/**
 * Project a single DB row to the admin summary shape. Returns `null` for
 * rows whose YAML is unparseable, has no `table`, or doesn't deserialize
 * to an object — the same gate the SQL whitelist applies, so the file
 * tree and the agent stay in lockstep on what counts as queryable.
 *
 * Rejections are logged at `warn` (not silently dropped): a server-side
 * schema regression that empties the list would otherwise look identical
 * to "user has no entities" in operator logs.
 *
 * `parseRowToAdminSummary` is only called from `mergeAdminEntities` where
 * `status` is pre-filtered by the upstream SQL query — published or draft
 * only. The narrow `AdminEntityStatus` cast is safe by construction; a
 * future caller that bypasses the filter would need to widen.
 */
export function parseRowToAdminSummary(row: SemanticEntityRow): AdminEntitySummary | null {
  let raw: unknown;
  try {
    raw = yaml.load(row.yaml_content);
  } catch (err) {
    log.warn(
      { orgId: row.org_id, name: row.name, err: err instanceof Error ? err.message : String(err) },
      "parseRowToAdminSummary: yaml_content unparseable — skipping row",
    );
    return null;
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    log.warn(
      { orgId: row.org_id, name: row.name, parsedType: raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw },
      "parseRowToAdminSummary: yaml_content did not parse to an object — skipping row",
    );
    return null;
  }

  const parsed = EntityShape.safeParse(raw);
  if (!parsed.success) {
    log.warn(
      { orgId: row.org_id, name: row.name, issues: parsed.error.issues.map((i) => i.path.join(".")) },
      "parseRowToAdminSummary: row failed EntityShape — skipping",
    );
    return null;
  }
  if (!parsed.data.table) {
    log.warn(
      { orgId: row.org_id, name: row.name },
      "parseRowToAdminSummary: row has empty `table` — skipping",
    );
    return null;
  }

  const data = parsed.data as Record<string, unknown>;
  const nameField = typeof data.name === "string" && data.name ? data.name : null;

  // Status from the row is one of the four `SemanticEntityStatus` values,
  // but the upstream SQL filters drop `archived` + `draft_delete` before
  // this projector ever runs. Narrowing here keeps consumers honest about
  // what they can encounter. If the upstream filter is ever changed this
  // assertion will produce a misleading list — covered by the integration
  // suite in `overlay-queries-integration.test.ts`.
  const status: AdminEntityStatus = row.status === "draft" ? "draft" : "published";

  return {
    // #2891: `name` is the storage key (`row.name`) so the URL the
    // frontend builds from this response roundtrips to a successful
    // `getEntity(... name)` lookup. `displayName` carries what the file
    // tree used to render off `name` (YAML `name:` field or table).
    name: row.name,
    displayName: nameField ?? parsed.data.table,
    table: parsed.data.table,
    description: typeof data.description === "string" ? data.description : "",
    columnCount: sectionLength(data.dimensions),
    joinCount: sectionLength(data.joins),
    measureCount: sectionLength(data.measures),
    source: row.connection_group_id ?? "default",
    connection: typeof data.connection === "string" ? data.connection : null,
    type: typeof data.type === "string" ? data.type : null,
    status,
    sourceKind: "db",
    connectionId: row.connection_group_id ?? null,
    updatedAt: row.updated_at,
  };
}

function diskToAdminSummary(e: EntitySummary): AdminEntitySummary {
  // #2891: disk lookups go through `findEntityFile(root, name)` which
  // expects the file stem — so `name` must be the file stem, not the
  // table. `displayName` keeps the existing UX label.
  //
  // Group-scoped disk dirs can hold the same file stem under different
  // groups — the merge dedup is `(name, connectionId)`, so leaving
  // `connectionId: null` for every disk row would collapse them. Scope by
  // the resolved `e.group` (ADR-0012, #3275), NOT the raw `e.source`: for a
  // canonical `groups/<g>/` entity the directory is authoritative, and the
  // flat default root with a `group:`/`connection:` field resolves to that
  // field's group — using `e.source` would scope it to "default" and disagree
  // with the drift reader / whitelist, which both key off the resolved group.
  // This mirrors the DB path (`parseRowToAdminSummary`): source =
  // group-or-"default", connectionId = group-or-null. "default" stays null so
  // single-group orgs keep the unchanged badge-free rendering.
  const resolvedGroup = e.group !== "default" ? e.group : null;
  return {
    name: e.name,
    displayName: e.displayName,
    table: e.table,
    description: e.description,
    columnCount: e.columnCount,
    joinCount: e.joinCount,
    measureCount: e.measureCount,
    source: e.group,
    connection: e.connection,
    type: e.type,
    status: "published",
    sourceKind: "disk",
    connectionId: resolvedGroup,
    updatedAt: null,
  };
}

/**
 * Project DB rows and/or disk entities to admin summaries, sort
 * deterministically, and dedup defensively. Pure — no I/O.
 *
 * Post-PR-2561 the orchestrators never pass both lists populated in the
 * same call — `listAdminEntities` chooses DB-only (DB present) or
 * disk-only (no DB) and feeds the other list as `[]`. The merge survives
 * as the shared projection + sort + dedup pipeline so the DB and disk
 * branches produce identically-shaped output; the dedup pass is
 * defense-in-depth against duplicate rows within a single source
 * (e.g. a future migration that breaks the partial-unique index) rather
 * than the cross-source shadow rule it used to implement.
 *
 * Dedup key is `(summary.name, connectionId)` (#2412). The 0063 partial
 * unique index made `connection_group_id` part of the natural key —
 * collapsing on `name` alone silently dropped rows when the same entity
 * existed in two groups (e.g. `users` in `g_prod_us` AND `g_prod_eu`),
 * surviving whichever Postgres surfaced first. Two entities sharing
 * `table` but with different display names also produce two entries
 * (correct: they're different things), and so do same-name entities in
 * different groups.
 *
 * Sort is deterministic on `(name, group)` so M-group orgs read
 * left-to-right in a stable order; disk entries (null group) sort before
 * any named group when names match.
 */
// The `(name, connection_group_id)` dedup key now lives in `dedup-key.ts`
// so `loadEntitiesForOrg` can import it without pulling the larger admin-
// source surface into its test fixtures (#2503 review).

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
    const key = dedupKey(summary.name, summary.connectionId);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(summary);
  }

  for (const entry of input.diskEntities) {
    const summary = diskToAdminSummary(entry);
    const key = dedupKey(summary.name, summary.connectionId);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(summary);
  }

  merged.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    // Within a name, null-group (disk / legacy) sorts before named groups,
    // then named groups sort lexicographically.
    const ag = a.connectionId ?? "";
    const bg = b.connectionId ?? "";
    return ag.localeCompare(bg);
  });
  return { entities: merged, warnings: [...input.diskWarnings] };
}

// ---------------------------------------------------------------------------
// Orchestrators — wire the pure helpers to I/O
// ---------------------------------------------------------------------------

/**
 * Load the unified admin entity list.
 *
 * - When `hasInternalDB()` AND an `orgId` is present, returns DB rows only.
 *   `listEntitiesWithOverlay` is used in developer mode and `listEntityRows`
 *   with `status='published'` otherwise. The per-org disk mirror at
 *   `.orgs/<orgId>/entities/` is a derived cache for the agent's `explore`
 *   tool and is intentionally NOT consulted here — see the module header.
 * - When no internal DB exists (pure-YAML self-hosted) OR no `orgId` is in
 *   scope, falls back to the disk root via `resolveSemanticRoot(opts.orgId)`.
 *   Pre-existing tests rely on the no-orgId branch reading the bundled
 *   fixture; that behavior is preserved.
 * - DB rejections propagate (a real DB outage shouldn't masquerade as an
 *   empty workspace — the route handler maps it to a 500 with `requestId`).
 */
export async function listAdminEntities(opts: {
  readonly orgId?: string;
  readonly mode?: "developer" | "published";
}): Promise<AdminEntityListResult> {
  const mode = opts.mode ?? "published";

  if (opts.orgId && hasInternalDB()) {
    const dbRows = mode === "developer"
      ? await listEntitiesWithOverlay(opts.orgId, "entity")
      : await listEntityRows(opts.orgId, "entity", "published");
    return mergeAdminEntities({ dbRows, diskEntities: [], diskWarnings: [] });
  }

  const root = resolveSemanticRoot(opts.orgId);
  const { entities: diskEntities, warnings } = discoverEntities(root);

  return mergeAdminEntities({ dbRows: [], diskEntities, diskWarnings: warnings });
}

interface GetAdminEntityOptions {
  readonly name: string;
  readonly orgId?: string;
  readonly requestId?: string;
  /**
   * Scope the DB lookup to a specific `connection_group_id` (#2412).
   * Required for multi-group orgs where the same entity name exists in
   * more than one group — without it the DB call throws
   * `AmbiguousEntityError`. Pass `null` to scope to legacy null-group
   * rows, omit to use the unique-or-409 default.
   */
  readonly connectionGroupId?: string | null;
  /**
   * Content-mode gate (#2481). `published` restricts the DB lookup to
   * `status = 'published'` so non-admin callers never see drafts even
   * when an admin is mid-edit in developer mode. `developer` returns
   * the overlay-effective row (draft shadows published). Defaults to
   * `developer` to preserve the pre-#2481 admin-route behavior.
   *
   * Disk entries are always considered published; the gate only affects
   * the DB fallback branch.
   */
  readonly mode?: "developer" | "published";
}

/**
 * Resolve a single admin entity by name. Returns `null` when the active
 * source (DB when present, otherwise disk) has no match — the route
 * handler maps that to a 404.
 *
 * DB-only when `hasInternalDB() && orgId`; disk-only fallback otherwise.
 * Symmetric with `listAdminEntities` so navigating to an entity that
 * doesn't appear in the list can't accidentally surface a stale disk
 * mirror file. Self-hosted users who edit YAMLs in-repo run `atlas init`
 * to sync to DB; the disk-fast-path optimisation that used to live here
 * was the same surface that hid the duplicate-display-name bug.
 *
 * Errors:
 * - Invalid `name` (path-traversal probe) → `null` (route maps to 404
 *   silently to avoid leaking whether the probe hit a real file; an
 *   upstream `isValidEntityName` check in the route returns 400 first).
 * - YAML parse failure → throws `AdminEntityYamlParseError`.
 * - Non-object / missing `table` → throws `AdminEntityYamlShapeError`.
 * - DB query failure → propagates the underlying Error. Don't swallow:
 *   masking a DB outage as "not found" would make the frontend show an
 *   empty workspace.
 */
export async function getAdminEntity(opts: GetAdminEntityOptions): Promise<AdminEntityDetail | null> {
  const { name, orgId, requestId, connectionGroupId } = opts;
  const mode = opts.mode ?? "developer";

  if (!isValidEntityName(name)) {
    log.warn({ requestId, name }, "getAdminEntity: rejected invalid entity name");
    return null;
  }

  // DB is canonical when it's available — see module header for the
  // source rule. `connectionGroupId` is passed verbatim: `undefined`
  // triggers the unique-or-409 path in `getEntity`, an explicit `null`
  // or string scopes to that group. The route layer decides which.
  // `mode` gates draft visibility — published-mode SQL restricts to
  // `status = 'published'`, developer-mode returns the overlay row.
  if (orgId && hasInternalDB()) {
    const row = await getEntity(orgId, "entity", name, connectionGroupId, mode);
    if (!row) return null;

    const detail = parseEntityYaml(name, "db", () => yaml.load(row.yaml_content), requestId);
    const status: AdminEntityStatus = row.status === "draft" ? "draft" : "published";
    return { entity: detail, status, source: "db" };
  }

  // No internal DB → pure-YAML self-hosted. The disk root holds the
  // authored YAML. Resolve DETAIL by (name, group) through the SAME
  // discovery (`discoverEntities`) the LIST path uses, so the two can't
  // drift: `findEntityFile` resolved by file stem alone and, after #3275
  // kept same-stem rows distinct per group in the LIST, the DETAIL read
  // could still open whichever stem match was scanned first — the wrong
  // group.
  const diskRoot = resolveSemanticRoot(orgId);
  const stemMatches = discoverEntities(diskRoot).entities.filter((e) => e.name === name);

  let filePath: string | null;
  if (stemMatches.length === 0) {
    // `discoverEntities` parses every file and drops the unparseable / no-
    // `table` ones, so an authored-but-broken file would vanish here and
    // 404 — hiding a real authoring error behind "not found". Fall back to
    // a raw stem existence check (group-agnostic: a broken file's group is
    // unknowable) and let `parseEntityYaml` below surface it as the 500 the
    // route contracts for malformed YAML. A genuinely absent file still
    // returns null → 404.
    filePath = findEntityFile(diskRoot, name);
    if (!filePath) return null;
  } else {
    let chosen: EntitySummary | undefined;
    if (connectionGroupId === undefined) {
      // Mirror the DB unique-or-409 contract: a stem-only lookup spanning
      // more than one group is ambiguous — reject rather than silently pick.
      if (stemMatches.length > 1) {
        log.warn(
          { requestId, name, groups: stemMatches.map((e) => e.group) },
          "getAdminEntity: ambiguous stem-only disk lookup across groups — pass connectionGroupId to disambiguate",
        );
        return null;
      }
      chosen = stemMatches[0];
    } else {
      const wantGroup = connectionGroupId === null ? "default" : connectionGroupId;
      chosen = stemMatches.find((e) => e.group === wantGroup);
    }
    if (!chosen) return null;
    filePath = chosen.filePath;
  }

  // Intentional 403→404 downgrade if the path escapes the root: don't
  // leak whether a path-traversal probe hit a real file. The route's
  // upstream `isValidEntityName` check returns 400 for obvious probes,
  // so this branch is pure defense-in-depth (symlinks, future bugs in
  // disk path resolution). `requestId` is preserved end-to-end via the
  // 404 response so log correlation works.
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(diskRoot))) {
    log.error({ requestId, name, resolved, root: diskRoot }, "getAdminEntity: resolved path escaped semantic root");
    return null;
  }

  const detail = parseEntityYaml(name, "disk", () => readYamlFile(filePath), requestId);
  return { entity: detail, status: "published", source: "disk" };
}

/**
 * Run a YAML-producing function and validate the result through
 * `EntityShape`. Both detail paths (disk read + DB row parse) go through
 * here so list and detail can't drift on what counts as a "valid enough
 * to render" entity. Throws the appropriate tagged error on failure.
 */
function parseEntityYaml(
  name: string,
  source: AdminEntitySourceKind,
  load: () => unknown,
  requestId: string | undefined,
): EntityShapeT {
  let raw: unknown;
  try {
    raw = load();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), entityName: name, source, requestId },
      "parseEntityYaml: YAML parse failed",
    );
    throw new AdminEntityYamlParseError(name, source, err);
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    log.error(
      { entityName: name, source, requestId, parsedType: raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw },
      "parseEntityYaml: YAML did not parse to an object",
    );
    throw new AdminEntityYamlShapeError(name, source);
  }

  const parsed = EntityShape.safeParse(raw);
  if (!parsed.success || !parsed.data.table) {
    log.error(
      { entityName: name, source, requestId, issues: parsed.success ? "empty table" : parsed.error.issues.map((i) => i.path.join(".")) },
      "parseEntityYaml: YAML failed EntityShape validation",
    );
    throw new AdminEntityYamlShapeError(name, source);
  }

  return parsed.data;
}
