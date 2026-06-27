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
  isInternalCircuitOpen,
} from "@atlas/api/lib/db/internal";
import { resolveBillingPeriod } from "@atlas/api/lib/billing/period";

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
  /**
   * Output-equivalent (model-weighted) token count for `token` events (#3989).
   * Computed at agent-step accounting time via the TokenWeighting module and
   * persisted to `usage_events.weighted_quantity` alongside the raw `quantity`,
   * so budget math can denominate in output-equivalent tokens. Omit (or pass
   * `null`) for non-token events — the column is NULL for those.
   */
  weightedQuantity?: number | null;
  /**
   * Provider-cost USD for a `token` event's turn, from the Vercel AI Gateway
   * (`providerMetadata.gateway.cost`, summed across the turn's steps), #4036.
   * Persisted to `usage_events.gateway_cost_usd` as the at-cost dollar basis the
   * Structure B credit + overage meter will draw against once #4038/#4039 land
   * (captured-only today). Omit (or pass `null`) for non-token events and for
   * non-gateway providers — the column is NULL there.
   */
  gatewayCostUsd?: number | null;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event logging (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Log a usage event. Fire-and-forget — async errors are handled by
 * internalExecute's circuit-breaker. No-op if internal DB is not configured.
 *
 * DROPPED-EVENT POLICY (#3428): when the internal-DB circuit breaker is open,
 * `internalExecute` silently increments a drop counter and returns — the usage
 * row is lost, and the workspace's period SUM is **permanently under-counted**
 * (no queue/replay in v1). The triage decision (2026-06-12) ACCEPTS that
 * under-count exposure for availability, but requires the degradation to be
 * OPERATOR-VISIBLE rather than silent. So before delegating to
 * `internalExecute` we read {@link isInternalCircuitOpen} and emit a loud,
 * structured `log.error` per dropped event — with workspace/user/event context
 * an operator can act on — because the breaker itself only logs ONCE on open
 * and a per-write debug line thereafter. If alert volume shows this happening
 * in practice, revisit with a bounded fail-open / local buffer + replay.
 */
export function logUsageEvent(event: UsageEvent): void {
  if (!hasInternalDB()) return;

  // Operator-visible drop alert (#3428). The circuit being open means this
  // write is about to be dropped on the floor by internalExecute and the
  // event is gone for good — surface it loudly with enough context (workspace,
  // user, event type, quantity) to scope the under-count, then still call
  // internalExecute so the drop counter advances and recovery is re-triggered.
  if (isInternalCircuitOpen()) {
    log.error(
      {
        workspaceId: event.workspaceId,
        userId: event.userId,
        eventType: event.eventType,
        quantity: event.quantity,
        reason: "circuit_open",
      },
      "Usage event dropped — internal DB circuit breaker open; period usage will be permanently under-counted (#3428, no replay in v1)",
    );
  }

  // Error handling is delegated to internalExecute's .catch handler,
  // which logs failures with SQL context and trips the circuit breaker
  // after 5 consecutive failures. No try/catch needed here — hasInternalDB()
  // guards against the only synchronous throw path (DATABASE_URL unset).
  internalExecute(
    `INSERT INTO usage_events (workspace_id, user_id, event_type, quantity, weighted_quantity, gateway_cost_usd, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.workspaceId ?? null,
      event.userId ?? null,
      event.eventType,
      event.quantity,
      event.weightedQuantity ?? null,
      event.gatewayCostUsd ?? null,
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
  /** Raw token spend for the period (sum of `token` event `quantity`). */
  tokenCount: number;
  /**
   * Output-equivalent (model-weighted) token spend for the period (#3989): the
   * sum of `COALESCE(weighted_quantity, quantity)` over `token` events. This is
   * the budget denominator — a turn on a pricier model contributes more here
   * than its raw `tokenCount`. Token rows predating migration 0152 have a NULL
   * `weighted_quantity` and fall back to their raw `quantity`, so this is never
   * less than it should be for un-backfilled history.
   */
  weightedTokenCount: number;
  /**
   * At-cost provider spend in USD for the period (#4036): the sum of
   * `gateway_cost_usd` over `token` events — the EXACT zero-markup dollars Atlas
   * paid the Vercel AI Gateway. This is the LIVE Structure B billing numerator:
   * dollar enforcement (#4038) denominates the included credit ($20/seat) against
   * it, and the at-cost overage meter (#4039) reports `costUsd − credit` in cents.
   * `weightedTokenCount` above is no longer a billing denominator (display only).
   * Rows with a NULL `gateway_cost_usd` (non-gateway providers, or token rows
   * predating migration 0155) simply don't contribute.
   */
  costUsd: number;
  activeUsers: number;
  /** Inclusive ISO start of the metering window. */
  periodStart: string;
  /** Exclusive ISO end of the window — the moment usage resets. */
  periodEnd: string;
  /**
   * Where the window came from (#3431):
   *   - `"stripe"`    — anchored on the org's active Stripe subscription
   *                     period (`current_period_start`/`_end`).
   *   - `"utc-month"` — UTC calendar-month fallback (trial / unsubscribed
   *                     / no internal DB). Agrees with `proactive/quota.ts`.
   * Lets the billing/usage UI and the 429 copy label the reset accurately.
   */
  periodSource: "stripe" | "utc-month";
}

/**
 * Get the current period summary for a workspace by querying usage_events
 * directly (real-time, not from pre-aggregated summaries).
 *
 * The window is the org's Stripe billing period when an active
 * subscription exists, else the UTC calendar month (#3431) — resolved by
 * {@link resolveBillingPeriod}. This replaced a server-local-timezone
 * calendar month that drifted from the invoice anchor and from the
 * proactive subsystem's UTC month.
 *
 * @param now - Current time; injected so tests can pin the boundary.
 */
export async function getCurrentPeriodUsage(
  workspaceId: string,
  now: Date = new Date(),
): Promise<UsageCurrentPeriod> {
  if (!hasInternalDB()) {
    return {
      queryCount: 0,
      tokenCount: 0,
      weightedTokenCount: 0,
      costUsd: 0,
      activeUsers: 0,
      periodStart: "",
      periodEnd: "",
      periodSource: "utc-month",
    };
  }

  const period = await resolveBillingPeriod(workspaceId, now);

  const rows = await internalQuery<{
    query_count: number;
    token_count: number;
    weighted_token_count: number;
    cost_usd: number;
    active_users: number;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN event_type = 'query' THEN quantity ELSE 0 END), 0)::int AS query_count,
       COALESCE(SUM(CASE WHEN event_type = 'token' THEN quantity ELSE 0 END), 0)::int AS token_count,
       COALESCE(SUM(CASE WHEN event_type = 'token' THEN COALESCE(weighted_quantity, quantity) ELSE 0 END), 0)::int AS weighted_token_count,
       COALESCE(SUM(CASE WHEN event_type = 'token' THEN gateway_cost_usd ELSE 0 END), 0)::float8 AS cost_usd,
       COALESCE(COUNT(DISTINCT CASE WHEN event_type = 'login' THEN user_id END), 0)::int AS active_users
     FROM usage_events
     WHERE workspace_id = $1
       AND created_at >= $2
       AND created_at < $3`,
    [workspaceId, period.start.toISOString(), period.end.toISOString()],
  );

  const row = rows[0];
  return {
    queryCount: row?.query_count ?? 0,
    tokenCount: row?.token_count ?? 0,
    weightedTokenCount: row?.weighted_token_count ?? 0,
    // `::float8` so `pg` returns a JS number (not a numeric string). Dollar sums
    // stay well within float8's ~15 significant digits, so no meaningful drift.
    costUsd: row?.cost_usd ?? 0,
    activeUsers: row?.active_users ?? 0,
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    periodSource: period.source,
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
