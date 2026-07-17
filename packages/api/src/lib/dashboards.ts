/**
 * Dashboard persistence — CRUD operations for dashboards and cards.
 *
 * Pattern follows scheduled-tasks.ts: hasInternalDB() guard, CrudResult/CrudDataResult
 * discriminated unions, org_id scoping.
 */

import * as crypto from "crypto";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  hasInternalDB,
  internalQuery,
  internalExecute,
} from "@atlas/api/lib/db/internal";
import type {
  Dashboard,
  DashboardCard,
  DashboardCardAnnotation,
  DashboardCardKind,
  DashboardCardLayout,
  DashboardWithCards,
  DashboardChartConfig,
  DashboardParameter,
  SharedDashboardCard,
  SharedDashboardParameterSummaryItem,
  SharedDashboardView,
} from "@atlas/api/lib/dashboard-types";
import { DASHBOARD_GRID } from "@atlas/api/lib/dashboard-types";
import { getSetting } from "@atlas/api/lib/settings";
import { resolveDateExpression, DashboardParameterError } from "@atlas/api/lib/dashboard-parameters";
import { dashboardParametersSchema, dashboardCardAnnotationsSchema } from "@useatlas/schemas";
import type { ShareMode, ShareExpiryKey } from "@useatlas/types/share";
import { SHARE_EXPIRY_OPTIONS } from "@useatlas/types/share";
import type { CrudResult, CrudDataResult, CrudFailReason } from "@atlas/api/lib/conversations";
import {
  selectGroupMember,
  NoGroupMembersError,
  type GroupSnapshot,
} from "@atlas/api/lib/dashboards-group-resolve";

export type { CrudResult, CrudDataResult, CrudFailReason };
export { NoGroupMembersError };

const log = createLogger("dashboards");

/**
 * Tile layout in the 24-col freeform grid. Single source for both write-time
 * Zod validation (route) and read-time DB-row validation (`rowToCard`).
 */
export const CardLayoutSchema = z.object({
  x: z.number().int().min(0).max(DASHBOARD_GRID.COLS - 1),
  y: z.number().int().min(0).max(DASHBOARD_GRID.MAX_Y),
  w: z.number().int().min(DASHBOARD_GRID.MIN_W).max(DASHBOARD_GRID.MAX_W),
  h: z.number().int().min(DASHBOARD_GRID.MIN_H).max(DASHBOARD_GRID.MAX_H),
}).refine((l) => l.x + l.w <= DASHBOARD_GRID.COLS, {
  message: `Tile extends past column ${DASHBOARD_GRID.COLS}`,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the `dashboards.parameters` JSONB into validated definitions. A
 * malformed row degrades to `[]` with a logged warning rather than throwing —
 * a single bad row should not 500 the whole dashboard fetch (mirrors the
 * chart_config / layout handling in `rowToCard`).
 */
function parseParameters(raw: unknown, dashboardId: unknown): DashboardParameter[] {
  if (raw == null) return [];
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    const parsed = dashboardParametersSchema.safeParse(value);
    if (parsed.success) return parsed.data as DashboardParameter[];
    log.warn(
      { dashboardId, issues: parsed.error.issues },
      "Discarding malformed dashboards.parameters JSONB",
    );
  } catch (err) {
    log.warn({ dashboardId, err: errorMessage(err) }, "Failed to parse parameters JSONB");
  }
  return [];
}

/**
 * Parse the `dashboard_cards.annotations` JSONB into validated event markers
 * (#3209). A malformed row degrades to `[]` with a logged warning rather than
 * throwing — a single bad row should not 500 the whole dashboard fetch (mirrors
 * `parseParameters` + the chart_config / layout handling in `rowToCard`). This
 * is the read-side re-validation the renderer relies on, since `rowToCard`
 * otherwise hands cached JSONB to the client un-checked.
 */
function parseAnnotations(raw: unknown, cardId: unknown): DashboardCardAnnotation[] {
  if (raw == null) return [];
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    const parsed = dashboardCardAnnotationsSchema.safeParse(value);
    if (parsed.success) return parsed.data as DashboardCardAnnotation[];
    log.warn(
      { cardId, issues: parsed.error.issues },
      "Discarding malformed dashboard_cards.annotations JSONB",
    );
  } catch (err) {
    log.warn({ cardId, err: errorMessage(err) }, "Failed to parse annotations JSONB");
  }
  return [];
}

function rowToDashboard(r: Record<string, unknown>): Dashboard {
  return {
    id: r.id as string,
    orgId: (r.org_id as string) ?? null,
    ownerId: r.owner_id as string,
    title: r.title as string,
    description: (r.description as string) ?? null,
    shareToken: (r.share_token as string) ?? null,
    shareExpiresAt: r.share_expires_at ? String(r.share_expires_at as Date | string) : null,
    shareMode: (r.share_mode as ShareMode) ?? "public",
    refreshSchedule: (r.refresh_schedule as string) ?? null,
    lastRefreshAt: r.last_refresh_at ? String(r.last_refresh_at as Date | string) : null,
    nextRefreshAt: r.next_refresh_at ? String(r.next_refresh_at as Date | string) : null,
    parameters: parseParameters(r.parameters, r.id),
    cardCount: typeof r.card_count === "number" ? r.card_count : (typeof r.card_count === "string" ? parseInt(r.card_count, 10) : 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function rowToCard(r: Record<string, unknown>): DashboardCard {
  let chartConfig: DashboardChartConfig | null = null;
  if (r.chart_config) {
    try {
      chartConfig = typeof r.chart_config === "string"
        ? JSON.parse(r.chart_config)
        : (r.chart_config as DashboardChartConfig);
    } catch (err) {
      log.warn({ cardId: r.id, err: errorMessage(err) }, "Failed to parse chart_config JSONB");
    }
  }

  let cachedColumns: string[] | null = null;
  if (r.cached_columns) {
    try {
      cachedColumns = typeof r.cached_columns === "string"
        ? JSON.parse(r.cached_columns)
        : (r.cached_columns as string[]);
    } catch (err) {
      log.warn({ cardId: r.id, err: errorMessage(err) }, "Failed to parse cached_columns JSONB");
    }
  }

  let cachedRows: Record<string, unknown>[] | null = null;
  if (r.cached_rows) {
    try {
      cachedRows = typeof r.cached_rows === "string"
        ? JSON.parse(r.cached_rows)
        : (r.cached_rows as Record<string, unknown>[]);
    } catch (err) {
      log.warn({ cardId: r.id, err: errorMessage(err) }, "Failed to parse cached_rows JSONB");
    }
  }

  let layout: DashboardCardLayout | null = null;
  if (r.layout) {
    try {
      const raw = typeof r.layout === "string" ? JSON.parse(r.layout) : r.layout;
      const parsed = CardLayoutSchema.safeParse(raw);
      if (parsed.success) {
        layout = parsed.data;
      } else {
        log.warn({ cardId: r.id, issues: parsed.error.issues }, "Discarding malformed dashboard_card.layout JSONB");
      }
    } catch (err) {
      log.warn({ cardId: r.id, err: errorMessage(err) }, "Failed to parse layout JSONB");
    }
  }

  // #3138: a card's kind is DERIVED from `content` presence — a text /
  // section-block card always carries NON-EMPTY markdown (the persist schema
  // enforces `.min(1)`), a chart card never does. No `kind` column; this is the
  // single point where the discriminator is read, so it defends its own
  // invariant: an empty / whitespace-only `content` degrades to a chart card
  // rather than a silently-blank text tile.
  const rawContent = typeof r.content === "string" ? r.content : null;
  const content = rawContent && rawContent.trim().length > 0 ? rawContent : null;
  const kind: DashboardCardKind = content != null ? "text" : "chart";

  return {
    id: r.id as string,
    dashboardId: r.dashboard_id as string,
    position: typeof r.position === "number" ? r.position : 0,
    title: r.title as string,
    kind,
    sql: r.sql as string,
    chartConfig,
    content,
    annotations: parseAnnotations(r.annotations, r.id),
    cachedColumns,
    cachedRows,
    cachedAt: r.cached_at ? String(r.cached_at as Date | string) : null,
    connectionGroupId: (r.connection_group_id as string) ?? null,
    layout,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * First-publish visibility gate (#4320). A never-published dashboard
 * (`first_published_at IS NULL`) is private to its creator; once published it
 * is org-visible permanently. Returns `null` (no clause) when `viewerId` is
 * omitted — that's the deliberate opt-out for system/owner-internal callers
 * (the publish merge's own baseline load, auto-refresh, agent tools acting on
 * an already-bound board) that must still resolve a never-published row. Every
 * USER-FACING surface — reads AND the write/share/delete paths (#4537) —
 * passes `viewerId` so the gate is enforced at the request boundary, where the
 * acting identity lives.
 */
function firstPublishVisibilityClause(
  viewerId: string | null | undefined,
  params: unknown[],
  paramIdx: number,
  tableAlias?: string,
): { clause: string | null; nextIdx: number } {
  if (viewerId == null) return { clause: null, nextIdx: paramIdx };
  const prefix = tableAlias ? `${tableAlias}.` : "";
  params.push(viewerId);
  return {
    clause: `(${prefix}first_published_at IS NOT NULL OR ${prefix}owner_id = $${paramIdx})`,
    nextIdx: paramIdx + 1,
  };
}

function orgScopeClause(
  orgId: string | null | undefined,
  params: unknown[],
  paramIdx: number,
  tableAlias?: string,
): { clause: string; nextIdx: number } {
  const col = tableAlias ? `${tableAlias}.org_id` : "org_id";
  if (orgId) {
    params.push(orgId);
    return { clause: `${col} = $${paramIdx}`, nextIdx: paramIdx + 1 };
  }
  return { clause: `${col} IS NULL`, nextIdx: paramIdx };
}

function generateShareToken(): string {
  return crypto.randomBytes(21).toString("base64url");
}

function computeExpiresAt(expiresIn?: ShareExpiryKey | null): string | null {
  if (!expiresIn || expiresIn === "never") return null;
  const seconds = SHARE_EXPIRY_OPTIONS[expiresIn];
  if (seconds === null) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Group-scoped execution resolver (#2342)
// ---------------------------------------------------------------------------

/**
 * Load the group's primary + membership snapshot for resolver use. The
 * snapshot drives `selectGroupMember` — see `lib/dashboards-group-resolve.ts`
 * for the resolution rules.
 *
 * Members come back ordered by `(created_at ASC, id ASC)` so the resolver's
 * fallback path matches the DB-side ORDER BY and the documented tie-breaker.
 */
export async function loadGroupSnapshot(
  groupId: string,
  orgId: string | null,
): Promise<GroupSnapshot | null> {
  if (!hasInternalDB()) return null;
  // Post-0096 cutover (#2744 / ADR-0007 pure-collapse): groups are
  // free-form JSONB strings in `workspace_plugins.config.group_id`
  // with no separate `connection_groups` row and no `primary_connection_id`.
  // "Membership" is an aggregation over datasource installs sharing
  // the same `config->>'group_id'` in the workspace. The snapshot's
  // `primaryConnectionId` field stays null; `selectGroupMember` falls
  // through to the deterministic (installed_at, install_id) sort.
  const memberRows = await internalQuery<{ id: string; created_at: Date | string }>(
    `SELECT install_id AS id, installed_at AS created_at FROM workspace_plugins
      WHERE config->>'group_id' = $1
        AND workspace_id = $2
        AND pillar = 'datasource'
        AND status != 'archived'
      ORDER BY installed_at ASC, install_id ASC`,
    [groupId, orgId ?? "__global__"],
  );
  if (memberRows.length === 0) return null;

  return {
    groupId,
    orgId,
    primaryConnectionId: null,
    members: memberRows.map((r) => ({
      id: r.id,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })),
  };
}

/**
 * Resolve the physical connection id a card executes against.
 *
 * Cards with `connectionGroupId` resolve to the group's primary member
 * (or first-by-(created_at, id) when no primary is set). Cards without
 * a group fall through to the workspace default (`null`). The 0066
 * backfill populated `connection_group_id` from the legacy `connection_id`
 * via 0062's 1:1 mapping, so post-1.4.4 cards always carry a group when
 * they had a legacy connection.
 *
 * Throws `NoGroupMembersError` when the card resolves to a group with
 * zero members — the route layer must catch and return a 500 with
 * `requestId` rather than silently falling through to the workspace
 * connection (CLAUDE.md "Prefer errors over silent fallbacks").
 */
export async function resolveCardConnectionId(
  card: { connectionGroupId: string | null },
  orgId: string | null,
): Promise<string | null> {
  if (card.connectionGroupId) {
    const snap = await loadGroupSnapshot(card.connectionGroupId, orgId);
    if (!snap) {
      throw new NoGroupMembersError(card.connectionGroupId, orgId);
    }
    return selectGroupMember(snap);
  }
  return null;
}

// ---------------------------------------------------------------------------
// CRUD — Dashboards
// ---------------------------------------------------------------------------

export async function createDashboard(opts: {
  ownerId: string;
  orgId?: string | null;
  title: string;
  description?: string | null;
  /** Top-level parameter definitions (#2267). Cards bind to them via `:<key>`. */
  parameters?: DashboardParameter[] | null;
}): Promise<CrudDataResult<Dashboard>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `INSERT INTO dashboards (owner_id, org_id, title, description, parameters)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *, 0 AS card_count`,
      [
        opts.ownerId,
        opts.orgId ?? null,
        opts.title,
        opts.description ?? null,
        JSON.stringify(opts.parameters ?? []),
      ],
    );
    if (rows.length === 0) return { ok: false, reason: "error" };
    return { ok: true, data: rowToDashboard(rows[0]) };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "createDashboard failed");
    return { ok: false, reason: "error" };
  }
}

export async function getDashboard(
  id: string,
  scope: { orgId?: string | null; viewerId?: string | null },
): Promise<CrudDataResult<DashboardWithCards>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const params: unknown[] = [id];
    const org = orgScopeClause(scope.orgId, params, 2, "d");
    // #4320 — a never-published dashboard is only readable by its creator.
    const vis = firstPublishVisibilityClause(scope.viewerId, params, org.nextIdx, "d");
    const visClause = vis.clause ? ` AND ${vis.clause}` : "";
    const dashRows = await internalQuery<Record<string, unknown>>(
      `SELECT d.*, COALESCE(cc.cnt, 0)::int AS card_count
       FROM dashboards d
       LEFT JOIN (SELECT dashboard_id, COUNT(*)::int AS cnt FROM dashboard_cards GROUP BY dashboard_id) cc
         ON cc.dashboard_id = d.id
       WHERE d.id = $1 AND ${org.clause}${visClause} AND d.deleted_at IS NULL`,
      params,
    );
    if (dashRows.length === 0) return { ok: false, reason: "not_found" };

    const cardRows = await internalQuery<Record<string, unknown>>(
      `SELECT * FROM dashboard_cards WHERE dashboard_id = $1 ORDER BY position ASC, created_at ASC`,
      [id],
    );

    const dash = rowToDashboard(dashRows[0]);
    const { cardCount: _, ...rest } = dash;
    return {
      ok: true,
      data: { ...rest, cards: cardRows.map(rowToCard) },
    };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "getDashboard failed");
    return { ok: false, reason: "error" };
  }
}

export async function listDashboards(opts?: {
  orgId?: string | null;
  viewerId?: string | null;
  limit?: number;
  offset?: number;
}): Promise<CrudDataResult<{ dashboards: Dashboard[]; total: number }>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };

  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;

  try {
    const params: unknown[] = [];
    let paramIdx = 1;
    const org = orgScopeClause(opts?.orgId, params, paramIdx, "d");
    paramIdx = org.nextIdx;

    // #4320 — never-published dashboards surface only in their creator's list.
    const vis = firstPublishVisibilityClause(opts?.viewerId, params, paramIdx, "d");
    paramIdx = vis.nextIdx;
    const visClause = vis.clause ? ` AND ${vis.clause}` : "";

    const where = `WHERE ${org.clause}${visClause} AND d.deleted_at IS NULL`;

    const [countRows, dataRows] = await Promise.all([
      internalQuery<Record<string, unknown>>(
        `SELECT COUNT(*)::int AS total FROM dashboards d ${where}`,
        params,
      ),
      internalQuery<Record<string, unknown>>(
        `SELECT d.*, COALESCE(cc.cnt, 0)::int AS card_count
         FROM dashboards d
         LEFT JOIN (SELECT dashboard_id, COUNT(*)::int AS cnt FROM dashboard_cards GROUP BY dashboard_id) cc
           ON cc.dashboard_id = d.id
         ${where}
         ORDER BY d.updated_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset],
      ),
    ]);

    const total = (countRows[0]?.total as number) ?? 0;
    return { ok: true, data: { dashboards: dataRows.map(rowToDashboard), total } };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "listDashboards failed");
    return { ok: false, reason: "error" };
  }
}

export async function updateDashboard(
  id: string,
  scope: { orgId?: string | null; viewerId?: string | null },
  updates: {
    title?: string;
    description?: string | null;
    refreshSchedule?: string | null;
    /** Replace the dashboard's parameter definitions (#2267). */
    parameters?: DashboardParameter[];
  },
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };

  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (updates.title !== undefined) {
    setClauses.push(`title = $${paramIdx++}`);
    params.push(updates.title);
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = $${paramIdx++}`);
    params.push(updates.description);
  }
  if (updates.refreshSchedule !== undefined) {
    setClauses.push(`refresh_schedule = $${paramIdx++}`);
    params.push(updates.refreshSchedule);
  }
  if (updates.parameters !== undefined) {
    setClauses.push(`parameters = $${paramIdx++}::jsonb`);
    params.push(JSON.stringify(updates.parameters));
  }

  if (setClauses.length === 0) return { ok: true };
  setClauses.push(`updated_at = now()`);

  const org = orgScopeClause(scope.orgId, params, paramIdx);
  paramIdx = org.nextIdx;
  // #4537 — write-side mirror of the read gate: a never-published dashboard
  // only accepts writes from its creator.
  const vis = firstPublishVisibilityClause(scope.viewerId, params, paramIdx);
  paramIdx = vis.nextIdx;
  const visClause = vis.clause ? ` AND ${vis.clause}` : "";

  try {
    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboards SET ${setClauses.join(", ")}
       WHERE id = $${paramIdx} AND ${org.clause}${visClause} AND deleted_at IS NULL
       RETURNING id`,
      [...params, id],
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error(
      { dashboardId: id, orgId: scope.orgId ?? null, viewerGated: scope.viewerId != null, err: errorMessage(err) },
      "updateDashboard failed",
    );
    return { ok: false, reason: "error" };
  }
}

export async function deleteDashboard(
  id: string,
  scope: { orgId?: string | null; viewerId?: string | null },
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const params: unknown[] = [id];
    const org = orgScopeClause(scope.orgId, params, 2);
    // #4537 — a non-owner must not be able to blind-delete a never-published
    // board (it would strand the creator's in-flight draft unreachable).
    const vis = firstPublishVisibilityClause(scope.viewerId, params, org.nextIdx);
    const visClause = vis.clause ? ` AND ${vis.clause}` : "";
    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboards SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND ${org.clause}${visClause} AND deleted_at IS NULL
       RETURNING id`,
      params,
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error(
      { dashboardId: id, orgId: scope.orgId ?? null, viewerGated: scope.viewerId != null, err: errorMessage(err) },
      "deleteDashboard failed",
    );
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// CRUD — Cards
// ---------------------------------------------------------------------------

export async function addCard(opts: {
  dashboardId: string;
  title: string;
  sql: string;
  chartConfig?: DashboardChartConfig | null;
  /** #3138 / #4318 — markdown body of a text / section card. NULL/omitted for a
   *  chart card; the card kind is DERIVED from this column's presence in
   *  `rowToCard`. A text card stores sql = '' and content = markdown. */
  content?: string | null;
  /** Event annotations (#3209) — dated markers on a time-series card. Defaults
   *  to none (empty array) when omitted; never null (the column is NOT NULL). */
  annotations?: DashboardCardAnnotation[];
  cachedColumns?: string[] | null;
  cachedRows?: Record<string, unknown>[] | null;
  /** Group-scoped execution target (1.4.4). */
  connectionGroupId?: string | null;
  layout?: DashboardCardLayout | null;
}): Promise<CrudDataResult<DashboardCard>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    // Get next position
    const posRows = await internalQuery<Record<string, unknown>>(
      `SELECT COALESCE(MAX(position), -1)::int + 1 AS next_pos FROM dashboard_cards WHERE dashboard_id = $1`,
      [opts.dashboardId],
    );
    const nextPos = (posRows[0]?.next_pos as number) ?? 0;

    const rows = await internalQuery<Record<string, unknown>>(
      `INSERT INTO dashboard_cards (dashboard_id, position, title, sql, chart_config, content, annotations, cached_columns, cached_rows, cached_at, connection_group_id, layout)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        opts.dashboardId,
        nextPos,
        opts.title,
        opts.sql,
        opts.chartConfig ? JSON.stringify(opts.chartConfig) : null,
        // 0117 — NULL for a chart card; markdown for a text card. `rowToCard`
        // derives the kind from this column's presence (#3138 / #4318).
        opts.content ?? null,
        // 0121 — the column is NOT NULL DEFAULT '[]'; pass the explicit array
        // (or '[]' when absent) so a card always persists a defined value.
        JSON.stringify(opts.annotations ?? []),
        opts.cachedColumns ? JSON.stringify(opts.cachedColumns) : null,
        opts.cachedRows ? JSON.stringify(opts.cachedRows) : null,
        opts.cachedRows ? new Date().toISOString() : null,
        opts.connectionGroupId ?? null,
        opts.layout ? JSON.stringify(opts.layout) : null,
      ],
    );
    if (rows.length === 0) return { ok: false, reason: "error" };

    // Touch parent dashboard
    internalExecute(`UPDATE dashboards SET updated_at = now() WHERE id = $1`, [opts.dashboardId]);

    return { ok: true, data: rowToCard(rows[0]) };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "addCard failed");
    return { ok: false, reason: "error" };
  }
}

export async function updateCard(
  cardId: string,
  dashboardId: string,
  updates: {
    title?: string;
    /** #4318 — replace the card's SQL in place (REST card-SQL edit parity).
     *  Omitted leaves the query unchanged; the new query is validated at
     *  render/refresh time through the full pipeline, not on store. */
    sql?: string;
    chartConfig?: DashboardChartConfig | null;
    /** Event annotations (#3209). `null` / omitted leaves them unchanged; an
     *  explicit array (including `[]`) replaces the card's markers. */
    annotations?: DashboardCardAnnotation[] | null;
    position?: number;
    layout?: DashboardCardLayout | null;
  },
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };

  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (updates.title !== undefined) {
    setClauses.push(`title = $${paramIdx++}`);
    params.push(updates.title);
  }
  if (updates.sql !== undefined) {
    setClauses.push(`sql = $${paramIdx++}`);
    params.push(updates.sql);
  }
  if (updates.chartConfig !== undefined) {
    setClauses.push(`chart_config = $${paramIdx++}`);
    params.push(updates.chartConfig ? JSON.stringify(updates.chartConfig) : null);
  }
  // 0121 — replace the card's event markers. A `null` means "leave unchanged"
  // (the field wasn't in the patch); an explicit array (including `[]` to clear
  // all markers) is persisted. The column is NOT NULL, so a clear writes '[]'.
  if (updates.annotations !== undefined && updates.annotations !== null) {
    setClauses.push(`annotations = $${paramIdx++}`);
    params.push(JSON.stringify(updates.annotations));
  }
  if (updates.position !== undefined) {
    setClauses.push(`position = $${paramIdx++}`);
    params.push(updates.position);
  }
  if (updates.layout !== undefined) {
    setClauses.push(`layout = $${paramIdx++}`);
    params.push(updates.layout ? JSON.stringify(updates.layout) : null);
  }

  if (setClauses.length === 0) return { ok: true };
  setClauses.push(`updated_at = now()`);

  try {
    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboard_cards SET ${setClauses.join(", ")}
       WHERE id = $${paramIdx} AND dashboard_id = $${paramIdx + 1}
       RETURNING id`,
      [...params, cardId, dashboardId],
    );
    if (rows.length === 0) return { ok: false, reason: "not_found" };

    internalExecute(`UPDATE dashboards SET updated_at = now() WHERE id = $1`, [dashboardId]);
    return { ok: true };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "updateCard failed");
    return { ok: false, reason: "error" };
  }
}

export async function removeCard(
  cardId: string,
  dashboardId: string,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = await internalQuery<{ id: string }>(
      `DELETE FROM dashboard_cards WHERE id = $1 AND dashboard_id = $2 RETURNING id`,
      [cardId, dashboardId],
    );
    if (rows.length === 0) return { ok: false, reason: "not_found" };

    internalExecute(`UPDATE dashboards SET updated_at = now() WHERE id = $1`, [dashboardId]);
    return { ok: true };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "removeCard failed");
    return { ok: false, reason: "error" };
  }
}

export async function refreshCard(
  cardId: string,
  dashboardId: string,
  result: { columns: string[]; rows: Record<string, unknown>[] },
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboard_cards
       SET cached_columns = $1, cached_rows = $2, cached_at = now(), updated_at = now()
       WHERE id = $3 AND dashboard_id = $4
       RETURNING id`,
      [JSON.stringify(result.columns), JSON.stringify(result.rows), cardId, dashboardId],
    );
    if (rows.length === 0) return { ok: false, reason: "not_found" };

    internalExecute(`UPDATE dashboards SET updated_at = now() WHERE id = $1`, [dashboardId]);
    return { ok: true };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "refreshCard failed");
    return { ok: false, reason: "error" };
  }
}

/**
 * Read a dashboard's `updated_at` at FULL microsecond precision, as text
 * (#4325). The node-postgres driver coerces a timestamptz to a millisecond JS
 * `Date`, and `String(date)` truncates further to whole seconds — so the draft
 * stale-baseline guard, which compared `String(updated_at)` on both sides,
 * treated two publishes in the SAME wall-clock second as equal and let the
 * second clobber the first (a lost update). Casting to `text` in SQL preserves
 * the stored microseconds and is byte-stable across reads of the same value, so
 * the guard distinguishes same-second publishes.
 *
 * Returns a DISCRIMINATED result rather than `string | null` so callers can
 * tell a transient DB failure (`error` → retry / 500) apart from a genuinely
 * absent row (`not_found` → 404) — collapsing both into "not found" would take
 * a retryable blip and report it to the user as a definitive 404 (CLAUDE.md
 * "prefer errors over silent fallbacks").
 */
export type DashboardUpdatedAtResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: "no_db" | "not_found" | "error" };

export async function loadDashboardUpdatedAtPrecise(
  dashboardId: string,
): Promise<DashboardUpdatedAtResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = await internalQuery<{ updated_at: string | null }>(
      `SELECT updated_at::text AS updated_at
         FROM dashboards
        WHERE id = $1 AND deleted_at IS NULL`,
      [dashboardId],
    );
    const updatedAt = rows[0]?.updated_at ?? null;
    if (updatedAt === null) return { ok: false, reason: "not_found" };
    return { ok: true, updatedAt };
  } catch (err) {
    log.error({ err: errorMessage(err), dashboardId }, "loadDashboardUpdatedAtPrecise failed");
    return { ok: false, reason: "error" };
  }
}

export async function getCard(
  cardId: string,
  dashboardId: string,
): Promise<CrudDataResult<DashboardCard>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT * FROM dashboard_cards WHERE id = $1 AND dashboard_id = $2`,
      [cardId, dashboardId],
    );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    return { ok: true, data: rowToCard(rows[0]) };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "getCard failed");
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/** Failure reason for shareDashboard — extends CrudFailReason with the invariant violation. */
export type ShareDashboardFailReason = CrudFailReason | "invalid_org_scope";

/** Result type for shareDashboard — carries the broader failure enum.
 *  `rotated` is true only when a PRE-EXISTING share token was replaced by a new
 *  one (an explicit rotation that invalidated prior links) — never on the
 *  first-time creation of a share. Lets the caller warn that old links died. */
export type ShareDashboardResult =
  | { ok: true; data: { token: string; expiresAt: string | null; shareMode: ShareMode; rotated: boolean } }
  | { ok: false; reason: ShareDashboardFailReason };

/**
 * Create or refresh a dashboard share link. Scope-bound to the caller's
 * org via `orgScopeClause`.
 *
 * Rejects `share_mode='org'` when the caller's scope has no orgId or the
 * dashboard row has no org_id. Mirrors the conversations check — same
 * DB-level CHECK (`chk_org_scoped_share`, 0034) enforces the invariant,
 * but surfacing it as `invalid_org_scope` lets the route layer respond
 * with a friendly 400 instead of relying on a Postgres error string. See
 * #1737.
 */
export async function shareDashboard(
  id: string,
  scope: { orgId?: string | null; viewerId?: string | null },
  opts?: { expiresIn?: ShareExpiryKey | null; shareMode?: ShareMode; rotate?: boolean },
): Promise<ShareDashboardResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    // A freshly-minted token used ONLY when there is no existing share, or when
    // the caller explicitly asked to rotate. Editing a live share's expiry or
    // visibility must NOT silently mint a new token — that would break every
    // previously-distributed link. Rotation is opt-in via `rotate` (#4317).
    const candidateToken = generateShareToken();
    const rotate = opts?.rotate ?? false;
    const expiresAt = computeExpiresAt(opts?.expiresIn);
    const shareMode: ShareMode = opts?.shareMode ?? "public";

    // Belt-and-suspenders for the DB CHECK (#1737): refuse org-scoped
    // shares without a concrete orgId, either from scope or the row.
    if (shareMode === "org") {
      if (!scope.orgId) {
        log.warn(
          { dashboardId: id },
          "Refusing to create org-scoped dashboard share: caller has no orgId (#1737)",
        );
        return { ok: false, reason: "invalid_org_scope" };
      }
      // Verify the dashboard row itself has an org_id. orgScopeClause
      // already filters to matching rows, but a callsite that relaxes
      // scope in the future should still hit this guard.
      const params: unknown[] = [id];
      const lookupOrg = orgScopeClause(scope.orgId, params, 2);
      // #4537 — gated for the same reason as the relaxed-scope guard above:
      // an ungated pre-check on a scope-relaxed callsite would answer
      // invalid_org_scope (400) instead of not_found for someone else's
      // never-published board — an existence oracle.
      const lookupVis = firstPublishVisibilityClause(scope.viewerId, params, lookupOrg.nextIdx);
      const lookupVisClause = lookupVis.clause ? ` AND ${lookupVis.clause}` : "";
      const orgRows = await internalQuery<{ org_id: string | null }>(
        `SELECT org_id FROM dashboards WHERE id = $1 AND ${lookupOrg.clause}${lookupVisClause} AND deleted_at IS NULL`,
        params,
      );
      if (orgRows.length === 0) return { ok: false, reason: "not_found" };
      if (!orgRows[0].org_id) {
        log.warn(
          { dashboardId: id },
          "Refusing to create org-scoped dashboard share: dashboard has no org_id (#1737)",
        );
        return { ok: false, reason: "invalid_org_scope" };
      }
    }

    // Capture the prior token in a CTE so the UPDATE can PRESERVE it (unless
    // `rotate`) and so we can report whether a live link was invalidated —
    // still a single round-trip. `prev.old_token IS NULL` covers the
    // first-time-share case, where there is no existing link to preserve.
    const params: unknown[] = [candidateToken, expiresAt, shareMode, rotate, id];
    const org = orgScopeClause(scope.orgId, params, 6, "src");
    // #4537 — a non-owner must not mint (or rotate) a share link on a
    // never-published board they cannot read.
    const vis = firstPublishVisibilityClause(scope.viewerId, params, org.nextIdx, "src");
    const visClause = vis.clause ? ` AND ${vis.clause}` : "";

    const rows = await internalQuery<{ share_token: string; old_token: string | null }>(
      `WITH prev AS (
         SELECT src.id, src.share_token AS old_token FROM dashboards src
         WHERE src.id = $5 AND ${org.clause}${visClause} AND src.deleted_at IS NULL
       )
       UPDATE dashboards d
       SET share_token = CASE WHEN $4::boolean OR prev.old_token IS NULL THEN $1 ELSE prev.old_token END,
           share_expires_at = $2,
           share_mode = $3,
           updated_at = now()
       FROM prev
       WHERE d.id = prev.id
       RETURNING d.share_token AS share_token, prev.old_token AS old_token`,
      params,
    );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    const token = rows[0].share_token;
    const oldToken = rows[0].old_token ?? null;
    const rotated = oldToken !== null && token !== oldToken;
    return { ok: true, data: { token, expiresAt, shareMode, rotated } };
  } catch (err) {
    log.error(
      { dashboardId: id, orgId: scope.orgId ?? null, viewerGated: scope.viewerId != null, err: errorMessage(err) },
      "shareDashboard failed",
    );
    return { ok: false, reason: "error" };
  }
}

export async function unshareDashboard(
  id: string,
  scope: { orgId?: string | null; viewerId?: string | null },
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const params: unknown[] = [id];
    const org = orgScopeClause(scope.orgId, params, 2);
    // #4537 — only the creator may revoke a never-published board's share.
    const vis = firstPublishVisibilityClause(scope.viewerId, params, org.nextIdx);
    const visClause = vis.clause ? ` AND ${vis.clause}` : "";
    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboards SET share_token = NULL, share_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND ${org.clause}${visClause} AND deleted_at IS NULL
       RETURNING id`,
      params,
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error(
      { dashboardId: id, orgId: scope.orgId ?? null, viewerGated: scope.viewerId != null, err: errorMessage(err) },
      "unshareDashboard failed",
    );
    return { ok: false, reason: "error" };
  }
}

export async function getShareStatus(
  id: string,
  scope: { orgId?: string | null; viewerId?: string | null },
): Promise<CrudDataResult<{ shared: boolean; token: string | null; expiresAt: string | null; shareMode: ShareMode }>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const params: unknown[] = [id];
    const org = orgScopeClause(scope.orgId, params, 2);
    // #4537 — the status response carries the share TOKEN; leaking it to a
    // non-owner of a never-published board is a live-link disclosure.
    const vis = firstPublishVisibilityClause(scope.viewerId, params, org.nextIdx);
    const visClause = vis.clause ? ` AND ${vis.clause}` : "";
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT share_token, share_expires_at, share_mode FROM dashboards
       WHERE id = $1 AND ${org.clause}${visClause} AND deleted_at IS NULL`,
      params,
    );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    const row = rows[0];
    const token = (row.share_token as string) ?? null;
    return {
      ok: true,
      data: {
        shared: token !== null,
        token,
        expiresAt: row.share_expires_at ? String(row.share_expires_at as Date | string) : null,
        shareMode: (row.share_mode as ShareMode) ?? "public",
      },
    };
  } catch (err) {
    log.error(
      { dashboardId: id, orgId: scope.orgId ?? null, viewerGated: scope.viewerId != null, err: errorMessage(err) },
      "getShareStatus failed",
    );
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// Public shared access
// ---------------------------------------------------------------------------

export type SharedDashboardFailReason = "no_db" | "not_found" | "expired" | "error";

/**
 * Access-control facts a share request needs to gate on, kept SEPARATE from the
 * serialized {@link SharedDashboardView} (#4316). `orgId` is an internal id the
 * viewer must never receive, but the route needs it to verify org membership —
 * returning it here (not on the view) lets the handler gate without ever being
 * able to spill it into the JSON body it returns.
 */
export interface SharedDashboardAccess {
  shareMode: ShareMode;
  orgId: string | null;
}

/**
 * Format one dashboard parameter as a frozen, display-only summary value
 * (#4316). Resolves the parameter's DEFAULT (the value the cached snapshot was
 * built with) to a human string — never the `key`, `type`, or raw default
 * expression. A `null` default reads as "All" (an unfiltered dimension, e.g.
 * "Region: All"). A relative-date default (`now - 30 days`) is resolved to a
 * concrete ISO date via the same server-side resolver the render path uses —
 * against `frozenAt`, the snapshot's capture instant, never the view request's
 * clock (#4538).
 */
function formatParameterDisplayValue(param: DashboardParameter, frozenAt: Date): string {
  if (param.default === null || param.default === undefined) return "All";
  if (param.type === "date") {
    try {
      return resolveDateExpression(String(param.default), frozenAt);
    } catch (err) {
      // `resolveDateExpression` throws ONLY `DashboardParameterError` on a
      // malformed default. Narrow to it and re-throw anything else, so a future
      // resolver change that throws a different error isn't silently relabeled
      // as an "unparseable date". A malformed date must not break the whole
      // shared snapshot — fall back to the raw literal (display-only text,
      // never bound to SQL here). Logged so a bad persisted default stays
      // visible.
      if (!(err instanceof DashboardParameterError)) throw err;
      log.warn(
        { paramKey: param.key, default: param.default, err: errorMessage(err) },
        "Shared parameter summary: unparseable date default — using raw literal",
      );
      return String(param.default);
    }
  }
  return String(param.default);
}

/**
 * Build the frozen `{ label, displayValue }` parameter summary for a shared
 * snapshot (#4316) — one entry per declared parameter, in declaration order.
 * Display-only: no keys, no definitions, no controls. Exported for unit tests.
 * `frozenAt` is the snapshot's capture instant (see
 * {@link resolveSharedSnapshotInstant}); the wall-clock default only serves
 * callers with no snapshot to anchor to.
 */
export function buildSharedParameterSummary(
  parameters: DashboardParameter[] | null | undefined,
  frozenAt: Date = new Date(),
): SharedDashboardParameterSummaryItem[] {
  return (parameters ?? []).map((param) => ({
    label: param.label,
    displayValue: formatParameterDisplayValue(param, frozenAt),
  }));
}

/**
 * The instant the shown data itself was captured (#4565): the newest of the
 * dashboard-level `lastRefreshAt` and every card's `cachedAt` (a manual
 * per-card refresh stamps `cachedAt` without touching `lastRefreshAt`, so
 * neither alone is authoritative), or `null` when the snapshot carries no
 * cached data at all. Distinct from {@link resolveSharedSnapshotInstant} in
 * that it does NOT fall back to `updatedAt`/`createdAt`: a never-refreshed
 * board has no data instant to report, so the shared caption must be omitted
 * rather than mislabelling the creation date as data time.
 */
export function resolveSharedDataInstant(dashboard: DashboardWithCards): Date | null {
  const candidates = [
    dashboard.lastRefreshAt,
    ...dashboard.cards.map((card) => card.cachedAt),
  ];
  let newest: Date | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = new Date(candidate);
    if (Number.isNaN(parsed.getTime())) continue;
    if (newest === null || parsed > newest) newest = parsed;
  }
  return newest;
}

/**
 * The instant a shared snapshot's data was frozen (#4538): the data-capture
 * instant ({@link resolveSharedDataInstant}) when present, else a stable
 * fallback of `updatedAt`, then `createdAt`. Relative-date parameter summaries
 * resolve against this instant — never the view request's clock — so the
 * summary frame stays exactly as frozen as the `cachedRows` it labels. A
 * never-refreshed dashboard (no cached data to drift from) falls back to
 * `updatedAt`/`createdAt` — any stable instant labels an empty snapshot
 * correctly.
 */
export function resolveSharedSnapshotInstant(dashboard: DashboardWithCards): Date {
  const dataInstant = resolveSharedDataInstant(dashboard);
  if (dataInstant) return dataInstant;
  const updated = new Date(dashboard.updatedAt);
  return Number.isNaN(updated.getTime()) ? new Date(dashboard.createdAt) : updated;
}

/** Project one full {@link DashboardCard} down to the data-only shared shape
 *  (#4316). Field-by-field construction — NOT a spread-then-delete — so `sql`
 *  and the internal ids (`dashboardId`, `connectionGroupId`) are structurally
 *  never copied across, and a new field on `DashboardCard` cannot ride along by
 *  omission. */
function projectSharedCard(card: DashboardCard): SharedDashboardCard {
  return {
    id: card.id,
    position: card.position,
    title: card.title,
    kind: card.kind,
    chartConfig: card.chartConfig,
    content: card.content,
    annotations: card.annotations,
    cachedColumns: card.cachedColumns,
    cachedRows: card.cachedRows,
    cachedAt: card.cachedAt,
    layout: card.layout,
  };
}

/**
 * Project a full {@link DashboardWithCards} into the minimal, data-only
 * {@link SharedDashboardView} the share endpoint serializes (#4316). The
 * projection is the single place the shared payload is constructed for BOTH
 * public and org share modes — one shape, no per-mode divergence. Exported for
 * unit tests. `frozenAt` defaults to the snapshot's own capture instant
 * (#4538) and is injectable only for tests — passing a request-time `new
 * Date()` here reintroduces the summary-vs-data drift the default exists to
 * prevent.
 */
export function projectSharedDashboardView(
  dashboard: DashboardWithCards,
  frozenAt: Date = resolveSharedSnapshotInstant(dashboard),
): SharedDashboardView {
  return {
    title: dashboard.title,
    description: dashboard.description,
    shareMode: dashboard.shareMode,
    cards: dashboard.cards.map(projectSharedCard),
    parameterSummary: buildSharedParameterSummary(dashboard.parameters, frozenAt),
    // The data-capture instant the caption renders as "Data as of …" (#4565) —
    // the SAME frozen instant the summary above resolves against whenever the
    // snapshot carries data, so every temporal label on the page shares one
    // instant. `null` (caption omitted) for a never-refreshed board.
    dataAsOf: resolveSharedDataInstant(dashboard)?.toISOString() ?? null,
    createdAt: dashboard.createdAt,
    updatedAt: dashboard.updatedAt,
    lastRefreshAt: dashboard.lastRefreshAt,
  };
}

export async function getSharedDashboard(
  token: string,
): Promise<
  | { ok: true; view: SharedDashboardView; access: SharedDashboardAccess }
  | { ok: false; reason: SharedDashboardFailReason }
> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const dashRows = await internalQuery<Record<string, unknown>>(
      `SELECT * FROM dashboards
       WHERE share_token = $1 AND deleted_at IS NULL`,
      [token],
    );
    if (dashRows.length === 0) return { ok: false, reason: "not_found" };

    const dash = dashRows[0];

    // Check expiry
    if (dash.share_expires_at) {
      const expiresAt = new Date(String(dash.share_expires_at as Date | string));
      if (expiresAt < new Date()) return { ok: false, reason: "expired" };
    }

    const cardRows = await internalQuery<Record<string, unknown>>(
      `SELECT * FROM dashboard_cards WHERE dashboard_id = $1 ORDER BY position ASC, created_at ASC`,
      [dash.id],
    );

    const dashboard = rowToDashboard(dash);
    // No explicit instant: the projection anchors relative-date parameter
    // summaries to the snapshot's own capture instant, not this request (#4538).
    const view = projectSharedDashboardView({ ...dashboard, cards: cardRows.map(rowToCard) });
    // `orgId` rides in `access`, not `view` — the route gates org membership on
    // it but can only serialize `view`, so the internal id can't leak (#4316).
    return {
      ok: true,
      view,
      access: { shareMode: dashboard.shareMode, orgId: dashboard.orgId },
    };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "getSharedDashboard failed");
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// Scheduler — auto-refresh
// ---------------------------------------------------------------------------

/** Get dashboards due for auto-refresh (next_refresh_at <= now). */
export async function getDashboardsDueForRefresh(): Promise<Dashboard[]> {
  if (!hasInternalDB()) return [];
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT d.*, COALESCE(cc.cnt, 0)::int AS card_count
       FROM dashboards d
       LEFT JOIN (SELECT dashboard_id, COUNT(*)::int AS cnt FROM dashboard_cards GROUP BY dashboard_id) cc
         ON cc.dashboard_id = d.id
       WHERE d.refresh_schedule IS NOT NULL
         AND d.next_refresh_at <= now()
         AND d.deleted_at IS NULL
       ORDER BY d.next_refresh_at ASC`,
    );
    return rows.map(rowToDashboard);
  } catch (err) {
    log.error({ err: errorMessage(err) }, "getDashboardsDueForRefresh failed");
    return [];
  }
}

/** Default retention window before an abandoned never-published shell is swept. */
export const DEFAULT_ABANDON_CLEANUP_HOURS = 72;

/**
 * Soft-delete abandoned never-published dashboard shells (#4320). A shell is
 * "abandoned" when it was NEVER published (`first_published_at IS NULL`), has
 * NO published cards AND NO in-flight per-user drafts (so the sweep can never
 * destroy real work), and was created longer than the retention window ago.
 * These rows are already invisible to everyone but their creator via the
 * first-publish gate — this sweep stops empty shells accumulating in the
 * creator's own list and in the table.
 *
 * The window is the platform setting `ATLAS_DASHBOARD_ABANDON_CLEANUP_HOURS`
 * (default {@link DEFAULT_ABANDON_CLEANUP_HOURS}); a value <= 0 disables the
 * sweep entirely. Returns the number of shells soft-deleted.
 */
export async function cleanupAbandonedDashboards(now: Date = new Date()): Promise<number> {
  if (!hasInternalDB()) return 0;

  const raw = getSetting("ATLAS_DASHBOARD_ABANDON_CLEANUP_HOURS");
  const hours = raw == null || raw === "" ? DEFAULT_ABANDON_CLEANUP_HOURS : Number(raw);
  if (!Number.isFinite(hours)) {
    log.warn(
      { value: raw },
      "Invalid ATLAS_DASHBOARD_ABANDON_CLEANUP_HOURS — skipping abandoned-dashboard cleanup",
    );
    return 0;
  }
  // A non-positive window disables the sweep (operator opt-out).
  if (hours <= 0) return 0;

  const cutoff = new Date(now.getTime() - hours * 3_600_000).toISOString();
  try {
    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboards d
          SET deleted_at = now(), updated_at = now()
        WHERE d.first_published_at IS NULL
          AND d.deleted_at IS NULL
          AND d.created_at < $1
          AND NOT EXISTS (SELECT 1 FROM dashboard_cards c WHERE c.dashboard_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM dashboard_user_drafts u WHERE u.dashboard_id = d.id)
        RETURNING d.id`,
      [cutoff],
    );
    if (rows.length > 0) {
      log.info(
        { count: rows.length, hours },
        "Swept abandoned never-published dashboard shells",
      );
    }
    return rows.length;
  } catch (err) {
    log.error({ err: errorMessage(err) }, "cleanupAbandonedDashboards failed");
    return 0;
  }
}

/**
 * Atomically lock a dashboard for refresh.
 * Updates last_refresh_at and computes next_refresh_at from the cron expression.
 * Returns true if lock acquired (this process should run the refresh).
 */
export async function lockDashboardForRefresh(
  dashboardId: string,
  computeNextRun: (expr: string, after?: Date) => Date | null,
): Promise<boolean> {
  if (!hasInternalDB()) return false;
  try {
    // Read the cron expression to compute next run
    const dashRows = await internalQuery<Record<string, unknown>>(
      `SELECT refresh_schedule FROM dashboards WHERE id = $1 AND refresh_schedule IS NOT NULL AND deleted_at IS NULL`,
      [dashboardId],
    );
    if (dashRows.length === 0) return false;

    const cronExpr = dashRows[0].refresh_schedule as string;
    const nextRun = computeNextRun(cronExpr);
    if (!nextRun) {
      log.warn({ dashboardId, cronExpr }, "lockDashboardForRefresh: computeNextRun returned null — skipping");
      return false;
    }

    // Atomic UPDATE — only succeeds if next_refresh_at is still in the past
    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboards SET
         last_refresh_at = now(),
         next_refresh_at = $1,
         updated_at = now()
       WHERE id = $2 AND refresh_schedule IS NOT NULL AND deleted_at IS NULL
         AND next_refresh_at <= now()
       RETURNING id`,
      [nextRun?.toISOString() ?? null, dashboardId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error({ err: errorMessage(err), dashboardId }, "lockDashboardForRefresh failed");
    return false;
  }
}

/**
 * Refresh all cards in a dashboard (standalone — no Hono context).
 * Used by the scheduler engine during auto-refresh ticks, and by the
 * post-publish async refresh (#4325) with `onlyCardIds` set to just the cards
 * whose SQL/config changed.
 *
 * @param opts.onlyCardIds When provided, only cards whose id is in the set are
 *   refreshed; every other card is skipped entirely (not counted). Absent →
 *   refresh every card (the scheduler default).
 */
export async function refreshDashboardCards(
  dashboardId: string,
  opts?: { onlyCardIds?: ReadonlySet<string> },
): Promise<{
  refreshed: number;
  failed: number;
  total: number;
}> {
  const { connections } = await import("@atlas/api/lib/db/connection");
  const { validateSQL } = await import("@atlas/api/lib/tools/sql");
  const {
    resolveDashboardParameterValues,
    bindDashboardParameters,
    extractPlaceholderNames,
    isBindableDbType,
  } = await import("@atlas/api/lib/dashboard-parameters");

  // Fetch dashboard with cards (unscoped — scheduler runs across all orgs;
  // SQL is re-validated before execution, connections come from stored card data)
  const dashResult = await getDashboardUnscoped(dashboardId);
  if (!dashResult.ok) {
    log.warn({ dashboardId, reason: dashResult.reason }, "Auto-refresh: dashboard not accessible");
    return { refreshed: 0, failed: 0, total: 0 };
  }

  const onlyCardIds = opts?.onlyCardIds;
  const cards = onlyCardIds
    ? dashResult.data.cards.filter((c) => onlyCardIds.has(c.id))
    : dashResult.data.cards;
  const dashboardOrgId = dashResult.data.orgId ?? null;
  // Auto-refresh renders the cached snapshot with the parameters' DEFAULT
  // values (#2267) — there's no interactive viewer to supply overrides. A
  // malformed default (e.g. an unparseable relative-date) degrades to no
  // parameter values; cards that reference a placeholder then fail bind +
  // skip (logged below) rather than executing an unbound query.
  let defaultParamValues: Record<string, string | number | null> = {};
  try {
    defaultParamValues = resolveDashboardParameterValues(dashResult.data.parameters, undefined);
  } catch (err) {
    log.warn(
      { dashboardId, err: errorMessage(err) },
      "Auto-refresh: failed to resolve default parameter values",
    );
  }
  let refreshed = 0;
  let failed = 0;

  for (const card of cards) {
    // #3138: a text / section-block card has no SQL — skip it entirely
    // (no validation, no execution, no cache write). It stays counted in
    // `total` but never in refreshed/failed.
    if (card.kind === "text") continue;
    try {
      // Resolve group → primary member before validation so the
      // connectionId-keyed whitelist lookup runs against the right
      // physical connection. NoGroupMembersError is treated as a
      // skip + warn here (scheduler tick is best-effort across cards);
      // the interactive routes surface it as a 500 + requestId.
      const resolvedConnectionId = await resolveCardConnectionId(
        { connectionGroupId: card.connectionGroupId },
        dashboardOrgId,
      );
      // Scope validation to the dashboard's workspace so a shared install_id
      // validates against the right dialect — matches the getForOrg routing
      // below (#3109).
      const validation = await validateSQL(card.sql, resolvedConnectionId ?? undefined, dashboardOrgId ?? undefined);
      if (!validation.valid) {
        log.warn({ cardId: card.id, error: validation.error }, "Auto-refresh: card SQL failed validation");
        failed++;
        continue;
      }
      const db = dashboardOrgId
        ? connections.getForOrg(dashboardOrgId, resolvedConnectionId ?? undefined)
        : resolvedConnectionId
          ? connections.get(resolvedConnectionId)
          : connections.getDefault();

      // Bind dashboard parameters (#2267): rewrite `:<key>` → positional binds
      // and pass the resolved DEFAULT values through the driver bind protocol.
      // Non-parameterized cards run unchanged.
      let execSql = card.sql;
      let bindValues: unknown[] | undefined;
      if (extractPlaceholderNames(card.sql).length > 0) {
        let dbType: string | null = null;
        try {
          dbType = connections.getDBType(resolvedConnectionId ?? "default", dashboardOrgId ?? undefined);
        } catch (dbTypeErr) {
          // Surface the real failure — never silently coerce to "" and emit a
          // misleading "non-PostgreSQL/MySQL" warning (CLAUDE.md "never
          // silently swallow errors").
          log.warn(
            { cardId: card.id, connectionId: resolvedConnectionId ?? "default", err: errorMessage(dbTypeErr) },
            "Auto-refresh: could not resolve datasource type for a parameterized card — skipping",
          );
          failed++;
          continue;
        }
        if (!isBindableDbType(dbType)) {
          log.warn(
            { cardId: card.id, dbType },
            "Auto-refresh: parameterized card on a non-PostgreSQL/MySQL datasource — skipping",
          );
          failed++;
          continue;
        }
        const bound = bindDashboardParameters(card.sql, defaultParamValues, dbType);
        execSql = bound.sql;
        bindValues = bound.values;
      }
      const queryResult = await db.query(execSql, 30000, bindValues);
      const result = await refreshCard(card.id, dashboardId, {
        columns: queryResult.columns,
        rows: queryResult.rows as Record<string, unknown>[],
      });
      if (result.ok) refreshed++;
      else failed++;
    } catch (err) {
      if (err instanceof NoGroupMembersError) {
        log.warn(
          { cardId: card.id, groupId: err.groupId, orgId: err.orgId },
          "Auto-refresh: card resolves to a group with no members — skipping until an admin adds one",
        );
        failed++;
        continue;
      }
      log.warn({ err: errorMessage(err), cardId: card.id }, "Auto-refresh: card query failed");
      failed++;
    }
  }

  return { refreshed, failed, total: cards.length };
}

/** Get dashboard with cards without org scoping (for scheduler engine). */
async function getDashboardUnscoped(
  id: string,
): Promise<CrudDataResult<DashboardWithCards>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const dashRows = await internalQuery<Record<string, unknown>>(
      `SELECT d.*, COALESCE(cc.cnt, 0)::int AS card_count
       FROM dashboards d
       LEFT JOIN (SELECT dashboard_id, COUNT(*)::int AS cnt FROM dashboard_cards GROUP BY dashboard_id) cc
         ON cc.dashboard_id = d.id
       WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [id],
    );
    if (dashRows.length === 0) return { ok: false, reason: "not_found" };

    const cardRows = await internalQuery<Record<string, unknown>>(
      `SELECT * FROM dashboard_cards WHERE dashboard_id = $1 ORDER BY position ASC, created_at ASC`,
      [id],
    );

    const dash = rowToDashboard(dashRows[0]);
    const { cardCount: _, ...rest } = dash;
    return {
      ok: true,
      data: { ...rest, cards: cardRows.map(rowToCard) },
    };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "getDashboardUnscoped failed");
    return { ok: false, reason: "error" };
  }
}

/**
 * Set refresh schedule and compute next_refresh_at.
 * Pass null to disable auto-refresh.
 */
export async function setRefreshSchedule(
  dashboardId: string,
  scope: { orgId?: string | null; viewerId?: string | null },
  schedule: string | null,
  computeNextRun: (expr: string, after?: Date) => Date | null,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    let nextRefresh: string | null = null;
    if (schedule) {
      const nextDate = computeNextRun(schedule);
      if (!nextDate) {
        log.error({ dashboardId, schedule }, "setRefreshSchedule: computeNextRun returned null — schedule will not fire");
        return { ok: false, reason: "error" };
      }
      nextRefresh = nextDate.toISOString();
    }
    const params: unknown[] = [schedule, nextRefresh, dashboardId];
    const org = orgScopeClause(scope.orgId, params, 4);
    // #4537 — only the creator may (re)schedule a never-published board.
    const vis = firstPublishVisibilityClause(scope.viewerId, params, org.nextIdx);
    const visClause = vis.clause ? ` AND ${vis.clause}` : "";

    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboards SET refresh_schedule = $1, next_refresh_at = $2, updated_at = now()
       WHERE id = $3 AND ${org.clause}${visClause} AND deleted_at IS NULL
       RETURNING id`,
      params,
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error(
      { dashboardId, orgId: scope.orgId ?? null, viewerGated: scope.viewerId != null, err: errorMessage(err) },
      "setRefreshSchedule failed",
    );
    return { ok: false, reason: "error" };
  }
}
