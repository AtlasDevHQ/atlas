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
  DashboardCardLayout,
  DashboardWithCards,
  DashboardChartConfig,
} from "@atlas/api/lib/dashboard-types";
import { DASHBOARD_GRID } from "@atlas/api/lib/dashboard-types";
import type { ShareMode, ShareExpiryKey } from "@useatlas/types/share";
import { SHARE_EXPIRY_OPTIONS } from "@useatlas/types/share";
import type { CrudResult, CrudDataResult, CrudFailReason } from "@atlas/api/lib/conversations";

export type { CrudResult, CrudDataResult, CrudFailReason };

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

function rowToDashboard(r: Record<string, unknown>): Dashboard {
  return {
    id: r.id as string,
    orgId: (r.org_id as string) ?? null,
    ownerId: r.owner_id as string,
    title: r.title as string,
    description: (r.description as string) ?? null,
    shareToken: (r.share_token as string) ?? null,
    shareExpiresAt: r.share_expires_at ? String(r.share_expires_at) : null,
    shareMode: (r.share_mode as ShareMode) ?? "public",
    refreshSchedule: (r.refresh_schedule as string) ?? null,
    lastRefreshAt: r.last_refresh_at ? String(r.last_refresh_at) : null,
    nextRefreshAt: r.next_refresh_at ? String(r.next_refresh_at) : null,
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

  return {
    id: r.id as string,
    dashboardId: r.dashboard_id as string,
    position: typeof r.position === "number" ? r.position : 0,
    title: r.title as string,
    sql: r.sql as string,
    chartConfig,
    cachedColumns,
    cachedRows,
    cachedAt: r.cached_at ? String(r.cached_at) : null,
    connectionId: (r.connection_id as string) ?? null,
    layout,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
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
// CRUD — Dashboards
// ---------------------------------------------------------------------------

export async function createDashboard(opts: {
  ownerId: string;
  orgId?: string | null;
  title: string;
  description?: string | null;
}): Promise<CrudDataResult<Dashboard>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `INSERT INTO dashboards (owner_id, org_id, title, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *, 0 AS card_count`,
      [opts.ownerId, opts.orgId ?? null, opts.title, opts.description ?? null],
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
  scope: { orgId?: string | null },
): Promise<CrudDataResult<DashboardWithCards>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const params: unknown[] = [id];
    const org = orgScopeClause(scope.orgId, params, 2, "d");
    const dashRows = await internalQuery<Record<string, unknown>>(
      `SELECT d.*, COALESCE(cc.cnt, 0)::int AS card_count
       FROM dashboards d
       LEFT JOIN (SELECT dashboard_id, COUNT(*)::int AS cnt FROM dashboard_cards GROUP BY dashboard_id) cc
         ON cc.dashboard_id = d.id
       WHERE d.id = $1 AND ${org.clause} AND d.deleted_at IS NULL`,
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

    const where = `WHERE ${org.clause} AND d.deleted_at IS NULL`;

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
  scope: { orgId?: string | null },
  updates: {
    title?: string;
    description?: string | null;
    refreshSchedule?: string | null;
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

  if (setClauses.length === 0) return { ok: true };
  setClauses.push(`updated_at = now()`);

  const org = orgScopeClause(scope.orgId, params, paramIdx);
  paramIdx = org.nextIdx;

  try {
    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboards SET ${setClauses.join(", ")}
       WHERE id = $${paramIdx} AND ${org.clause} AND deleted_at IS NULL
       RETURNING id`,
      [...params, id],
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "updateDashboard failed");
    return { ok: false, reason: "error" };
  }
}

export async function deleteDashboard(
  id: string,
  scope: { orgId?: string | null },
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const params: unknown[] = [id];
    const org = orgScopeClause(scope.orgId, params, 2);
    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboards SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND ${org.clause} AND deleted_at IS NULL
       RETURNING id`,
      params,
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "deleteDashboard failed");
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
  cachedColumns?: string[] | null;
  cachedRows?: Record<string, unknown>[] | null;
  connectionId?: string | null;
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
      `INSERT INTO dashboard_cards (dashboard_id, position, title, sql, chart_config, cached_columns, cached_rows, cached_at, connection_id, layout)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        opts.dashboardId,
        nextPos,
        opts.title,
        opts.sql,
        opts.chartConfig ? JSON.stringify(opts.chartConfig) : null,
        opts.cachedColumns ? JSON.stringify(opts.cachedColumns) : null,
        opts.cachedRows ? JSON.stringify(opts.cachedRows) : null,
        opts.cachedRows ? new Date().toISOString() : null,
        opts.connectionId ?? null,
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
    chartConfig?: DashboardChartConfig | null;
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
  if (updates.chartConfig !== undefined) {
    setClauses.push(`chart_config = $${paramIdx++}`);
    params.push(updates.chartConfig ? JSON.stringify(updates.chartConfig) : null);
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

/** Result type for shareDashboard — carries the broader failure enum. */
export type ShareDashboardResult =
  | { ok: true; data: { token: string; expiresAt: string | null; shareMode: ShareMode } }
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
  scope: { orgId?: string | null },
  opts?: { expiresIn?: ShareExpiryKey | null; shareMode?: ShareMode },
): Promise<ShareDashboardResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const token = generateShareToken();
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
      const orgRows = await internalQuery<{ org_id: string | null }>(
        `SELECT org_id FROM dashboards WHERE id = $1 AND ${lookupOrg.clause} AND deleted_at IS NULL`,
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

    const params: unknown[] = [token, expiresAt, shareMode, id];
    const org = orgScopeClause(scope.orgId, params, 5);

    const rows = await internalQuery<{ share_token: string }>(
      `UPDATE dashboards SET share_token = $1, share_expires_at = $2, share_mode = $3, updated_at = now()
       WHERE id = $4 AND ${org.clause} AND deleted_at IS NULL
       RETURNING share_token`,
      params,
    );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    return { ok: true, data: { token: rows[0].share_token, expiresAt, shareMode } };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "shareDashboard failed");
    return { ok: false, reason: "error" };
  }
}

export async function unshareDashboard(
  id: string,
  scope: { orgId?: string | null },
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const params: unknown[] = [id];
    const org = orgScopeClause(scope.orgId, params, 2);
    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboards SET share_token = NULL, share_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND ${org.clause} AND deleted_at IS NULL
       RETURNING id`,
      params,
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "unshareDashboard failed");
    return { ok: false, reason: "error" };
  }
}

export async function getShareStatus(
  id: string,
  scope: { orgId?: string | null },
): Promise<CrudDataResult<{ shared: boolean; token: string | null; expiresAt: string | null; shareMode: ShareMode }>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const params: unknown[] = [id];
    const org = orgScopeClause(scope.orgId, params, 2);
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT share_token, share_expires_at, share_mode FROM dashboards
       WHERE id = $1 AND ${org.clause} AND deleted_at IS NULL`,
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
        expiresAt: row.share_expires_at ? String(row.share_expires_at) : null,
        shareMode: (row.share_mode as ShareMode) ?? "public",
      },
    };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "getShareStatus failed");
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// Public shared access
// ---------------------------------------------------------------------------

export type SharedDashboardFailReason = "no_db" | "not_found" | "expired" | "error";

export async function getSharedDashboard(
  token: string,
): Promise<
  | { ok: true; data: DashboardWithCards }
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
      const expiresAt = new Date(String(dash.share_expires_at));
      if (expiresAt < new Date()) return { ok: false, reason: "expired" };
    }

    const cardRows = await internalQuery<Record<string, unknown>>(
      `SELECT * FROM dashboard_cards WHERE dashboard_id = $1 ORDER BY position ASC, created_at ASC`,
      [dash.id],
    );

    const dashboard = rowToDashboard(dash);
    // Strip shareToken from public response — callers already know the token
    const { cardCount: _, shareToken: _token, ...rest } = dashboard;
    return {
      ok: true,
      data: {
        ...rest,
        shareToken: null,
        cards: cardRows.map(rowToCard),
      },
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
 * Used by the scheduler engine during auto-refresh ticks.
 */
export async function refreshDashboardCards(dashboardId: string): Promise<{
  refreshed: number;
  failed: number;
  total: number;
}> {
  const { connections } = await import("@atlas/api/lib/db/connection");
  const { validateSQL } = await import("@atlas/api/lib/tools/sql");

  // Fetch dashboard with cards (unscoped — scheduler runs across all orgs;
  // SQL is re-validated before execution, connections come from stored card data)
  const dashResult = await getDashboardUnscoped(dashboardId);
  if (!dashResult.ok) {
    log.warn({ dashboardId, reason: dashResult.reason }, "Auto-refresh: dashboard not accessible");
    return { refreshed: 0, failed: 0, total: 0 };
  }

  const cards = dashResult.data.cards;
  let refreshed = 0;
  let failed = 0;

  for (const card of cards) {
    try {
      const validation = validateSQL(card.sql, card.connectionId ?? undefined);
      if (!validation.valid) {
        log.warn({ cardId: card.id, error: validation.error }, "Auto-refresh: card SQL failed validation");
        failed++;
        continue;
      }
      const db = card.connectionId
        ? connections.get(card.connectionId)
        : connections.getDefault();
      const queryResult = await db.query(card.sql, 30000);
      const result = await refreshCard(card.id, dashboardId, {
        columns: queryResult.columns,
        rows: queryResult.rows as Record<string, unknown>[],
      });
      if (result.ok) refreshed++;
      else failed++;
    } catch (err) {
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
  scope: { orgId?: string | null },
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

    const rows = await internalQuery<{ id: string }>(
      `UPDATE dashboards SET refresh_schedule = $1, next_refresh_at = $2, updated_at = now()
       WHERE id = $3 AND ${org.clause} AND deleted_at IS NULL
       RETURNING id`,
      params,
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "setRefreshSchedule failed");
    return { ok: false, reason: "error" };
  }
}
