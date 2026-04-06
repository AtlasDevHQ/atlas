/**
 * Usage metering helpers.
 *
 * Provides event logging and aggregate rollup for per-workspace usage
 * tracking. Events are recorded to usage_events; summaries are
 * materialized into usage_summaries on demand.
 *
 * Two write strategies:
 * - `logUsageEvent` is fire-and-forget via `internalExecute` — async
 *   errors are handled by internalExecute's circuit-breaker `.catch`.
 * - `aggregateUsageSummary` awaits the query but swallows errors.
 * In both cases, metering failures never propagate to the caller.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  internalExecute,
  internalQuery,
} from "@atlas/api/lib/db/internal";

const log = createLogger("metering");

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

// Query and token events are emitted from the agent loop's onFinish callback.
// Login events are emitted from the Better Auth session.create hook in auth/server.ts.
export type UsageEventType = "query" | "token" | "login";

export interface UsageEvent {
  workspaceId: string | null;
  userId: string | null;
  eventType: UsageEventType;
  quantity: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event logging (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Log a usage event. Fire-and-forget — async errors are handled by
 * internalExecute's circuit-breaker. No-op if internal DB is not configured.
 */
export function logUsageEvent(event: UsageEvent): void {
  if (!hasInternalDB()) return;

  // Error handling is delegated to internalExecute's .catch handler,
  // which logs failures with SQL context and trips the circuit breaker
  // after 5 consecutive failures. No try/catch needed here — hasInternalDB()
  // guards against the only synchronous throw path (DATABASE_URL unset).
  internalExecute(
    `INSERT INTO usage_events (workspace_id, user_id, event_type, quantity, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      event.workspaceId ?? null,
      event.userId ?? null,
      event.eventType,
      event.quantity,
      event.metadata ? JSON.stringify(event.metadata) : null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Login event (deduplicated, once per user per day)
// ---------------------------------------------------------------------------

/**
 * Emit a login usage event, deduplicated to once per user per UTC day.
 * Fire-and-forget — never blocks or fails the caller. Called from the
 * Better Auth session.create hook in auth/server.ts.
 *
 * @param workspaceId - Active organization ID (skip if null)
 * @param userId - The user who signed in
 */
export async function emitLoginEvent(
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!hasInternalDB()) return;

  try {
    // Check if a login event already exists for this user today (UTC)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    let alreadyLogged = false;
    try {
      const rows = await internalQuery<{ n: number }>(
        `SELECT 1 AS n FROM usage_events WHERE user_id = $1 AND workspace_id = $2 AND event_type = 'login' AND created_at >= $3 LIMIT 1`,
        [userId, workspaceId, todayStart.toISOString()],
      );
      alreadyLogged = rows.length > 0;
    } catch (err) {
      // Dedup check failed — emit anyway (best-effort)
      log.warn(
        { err: err instanceof Error ? err.message : String(err), userId },
        "Login dedup check failed — emitting event anyway",
      );
    }

    if (alreadyLogged) return;

    logUsageEvent({
      workspaceId,
      userId,
      eventType: "login",
      quantity: 1,
    });
  } catch (err) {
    // intentionally best-effort — never block sign-in on metering
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId },
      "Failed to emit login event",
    );
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate usage events into a summary row for the given workspace and period.
 * Uses atomic upsert (ON CONFLICT ... DO UPDATE) for concurrent safety.
 *
 * @param workspaceId - The workspace/org to aggregate for.
 * @param period - "daily" or "monthly".
 * @param periodStart - The start of the period (truncated to day/month).
 */
export async function aggregateUsageSummary(
  workspaceId: string,
  period: "daily" | "monthly",
  periodStart: Date,
): Promise<void> {
  if (!hasInternalDB()) return;

  const periodStartISO = periodStart.toISOString();
  const interval = period === "daily" ? "1 day" : "1 month";

  try {
    await internalQuery(
      `INSERT INTO usage_summaries (workspace_id, period, period_start, query_count, token_count, active_users, storage_bytes)
       SELECT
         $1,
         $2,
         $3::timestamptz,
         COALESCE(SUM(CASE WHEN event_type = 'query' THEN quantity ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN event_type = 'token' THEN quantity ELSE 0 END), 0),
         COALESCE(COUNT(DISTINCT CASE WHEN event_type = 'login' THEN user_id END), 0),
         0
       FROM usage_events
       WHERE workspace_id = $1
         AND created_at >= $3::timestamptz
         AND created_at < $3::timestamptz + $4::interval
       ON CONFLICT (workspace_id, period, period_start) DO UPDATE SET
         query_count = EXCLUDED.query_count,
         token_count = EXCLUDED.token_count,
         active_users = EXCLUDED.active_users,
         updated_at = now()`,
      [workspaceId, period, periodStartISO, interval],
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), workspaceId, period },
      "Failed to aggregate usage summary",
    );
  }
}

// ---------------------------------------------------------------------------
// Query helpers (for admin API)
// ---------------------------------------------------------------------------

export interface UsageSummaryRow {
  id: string;
  workspace_id: string;
  period: string;
  period_start: string;
  query_count: number;
  token_count: number;
  active_users: number;
  storage_bytes: number;
  updated_at: string;
  [key: string]: unknown;
}

export interface UsageCurrentPeriod {
  queryCount: number;
  tokenCount: number;
  activeUsers: number;
  periodStart: string;
  periodEnd: string;
}

/**
 * Get the current period summary for a workspace by querying usage_events
 * directly (real-time, not from pre-aggregated summaries).
 */
export async function getCurrentPeriodUsage(
  workspaceId: string,
): Promise<UsageCurrentPeriod> {
  if (!hasInternalDB()) {
    return { queryCount: 0, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" };
  }

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const rows = await internalQuery<{
    query_count: number;
    token_count: number;
    active_users: number;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN event_type = 'query' THEN quantity ELSE 0 END), 0)::int AS query_count,
       COALESCE(SUM(CASE WHEN event_type = 'token' THEN quantity ELSE 0 END), 0)::int AS token_count,
       COALESCE(COUNT(DISTINCT CASE WHEN event_type = 'login' THEN user_id END), 0)::int AS active_users
     FROM usage_events
     WHERE workspace_id = $1
       AND created_at >= $2
       AND created_at < $3`,
    [workspaceId, periodStart.toISOString(), periodEnd.toISOString()],
  );

  const row = rows[0];
  return {
    queryCount: row?.query_count ?? 0,
    tokenCount: row?.token_count ?? 0,
    activeUsers: row?.active_users ?? 0,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  };
}

/**
 * Get historical usage summaries for a workspace.
 */
export async function getUsageHistory(
  workspaceId: string,
  period: "daily" | "monthly",
  startDate?: string,
  endDate?: string,
  limit = 90,
): Promise<UsageSummaryRow[]> {
  if (!hasInternalDB()) return [];

  const params: unknown[] = [workspaceId, period];
  const conditions = ["workspace_id = $1", "period = $2"];

  if (startDate) {
    params.push(startDate);
    conditions.push(`period_start >= $${params.length}`);
  }
  if (endDate) {
    params.push(endDate);
    conditions.push(`period_start <= $${params.length}`);
  }

  params.push(limit);
  const limitIdx = params.length;

  return internalQuery<UsageSummaryRow>(
    `SELECT * FROM usage_summaries
     WHERE ${conditions.join(" AND ")}
     ORDER BY period_start DESC
     LIMIT $${limitIdx}`,
    params,
  );
}

/**
 * Get per-user usage breakdown within a workspace for a time range.
 */
export async function getUsageBreakdown(
  workspaceId: string,
  startDate?: string,
  endDate?: string,
  limit = 100,
): Promise<Array<{
  user_id: string;
  query_count: number;
  token_count: number;
  login_count: number;
}>> {
  if (!hasInternalDB()) return [];

  const params: unknown[] = [workspaceId];
  const conditions = ["workspace_id = $1", "user_id IS NOT NULL"];

  if (startDate) {
    params.push(startDate);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (endDate) {
    params.push(endDate);
    conditions.push(`created_at <= $${params.length}`);
  }

  params.push(limit);
  const limitIdx = params.length;

  return internalQuery<{
    user_id: string;
    query_count: number;
    token_count: number;
    login_count: number;
  }>(
    `SELECT
       user_id,
       SUM(CASE WHEN event_type = 'query' THEN quantity ELSE 0 END)::int AS query_count,
       SUM(CASE WHEN event_type = 'token' THEN quantity ELSE 0 END)::int AS token_count,
       SUM(CASE WHEN event_type = 'login' THEN quantity ELSE 0 END)::int AS login_count
     FROM usage_events
     WHERE ${conditions.join(" AND ")}
     GROUP BY user_id
     ORDER BY query_count DESC
     LIMIT $${limitIdx}`,
    params,
  );
}
