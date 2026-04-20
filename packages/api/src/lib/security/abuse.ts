/**
 * Abuse prevention — anomaly detection with graduated response.
 *
 * Detects abusive query patterns per workspace using sliding window counters:
 * - Query rate (rapid-fire requests)
 * - Error rate (high failure ratio)
 * - Unique tables accessed (scanning unusual breadth)
 *
 * Graduated response: warn (log + webhook) → throttle (inject delays) → suspend.
 *
 * All state is in-memory with periodic flush to the internal DB for persistence
 * across restarts. Thresholds are configurable via env vars or atlas.config.ts.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalExecute, internalQuery } from "@atlas/api/lib/db/internal";
import {
  ABUSE_LEVELS,
  ABUSE_TRIGGERS,
  type AbuseLevel,
  type AbuseTrigger,
  type AbuseEvent,
  type AbuseStatus,
  type AbuseThresholdConfig,
  type AbuseDetail,
} from "@useatlas/types";
import { errorRatePct, splitIntoInstances } from "./abuse-instances";

const log = createLogger("abuse");

// ---------------------------------------------------------------------------
// Enum drift coercion
// ---------------------------------------------------------------------------
// A drifted abuse_events row must never crash the admin page, so we validate
// level / trigger_type against the canonical tuples, coerce unknowns to safe
// defaults, and warn on drift. Callers that care about the *distinction*
// between a genuine `none` and a drift-coerced `none` (e.g. restoreAbuseState
// — where the difference is fail-open vs fail-safe) read `levelDrifted`.

const LEVEL_SET: ReadonlySet<string> = new Set(ABUSE_LEVELS);
const TRIGGER_SET: ReadonlySet<string> = new Set(ABUSE_TRIGGERS);

function isAbuseLevel(v: unknown): v is AbuseLevel {
  return typeof v === "string" && LEVEL_SET.has(v);
}

function isAbuseTrigger(v: unknown): v is AbuseTrigger {
  return typeof v === "string" && TRIGGER_SET.has(v);
}

interface CoercedAbuseEnums {
  level: AbuseLevel;
  trigger: AbuseTrigger;
  /** True when `rawLevel` was not a member of `ABUSE_LEVELS` — caller may skip or escalate. */
  levelDrifted: boolean;
  /** True when `rawTrigger` was not a member of `ABUSE_TRIGGERS`. */
  triggerDrifted: boolean;
}

function coerceAbuseEnums(
  rowId: string,
  rawLevel: unknown,
  rawTrigger: unknown,
): CoercedAbuseEnums {
  const levelOk = isAbuseLevel(rawLevel);
  const triggerOk = isAbuseTrigger(rawTrigger);
  if (!levelOk || !triggerOk) {
    log.warn(
      { rowId, rawLevel, rawTrigger },
      "abuse event with drifted enum",
    );
  }
  return {
    level: levelOk ? rawLevel : "none",
    trigger: triggerOk ? rawTrigger : "manual",
    levelDrifted: !levelOk,
    triggerDrifted: !triggerOk,
  };
}

// ---------------------------------------------------------------------------
// Configuration — env var thresholds
// ---------------------------------------------------------------------------

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getAbuseConfig(): AbuseThresholdConfig {
  return {
    queryRateLimit: envInt("ATLAS_ABUSE_QUERY_RATE", 200),
    queryRateWindowSeconds: envInt("ATLAS_ABUSE_WINDOW_SECONDS", 300),
    errorRateThreshold: envFloat("ATLAS_ABUSE_ERROR_RATE", 0.5),
    uniqueTablesLimit: envInt("ATLAS_ABUSE_UNIQUE_TABLES", 50),
    throttleDelayMs: envInt("ATLAS_ABUSE_THROTTLE_DELAY_MS", 2000),
  };
}

// ---------------------------------------------------------------------------
// In-memory workspace state
// ---------------------------------------------------------------------------

interface WindowCounter {
  timestamps: number[];
  errorCount: number;
  tables: Set<string>;
}

interface WorkspaceAbuseState {
  level: AbuseLevel;
  trigger: AbuseTrigger | null;
  message: string | null;
  updatedAt: number;
  window: WindowCounter;
  /** Escalation count — how many consecutive windows triggered. */
  escalations: number;
}

const workspaceState = new Map<string, WorkspaceAbuseState>();

/** Reset all in-memory state. For tests. */
export function _resetAbuseState(): void {
  workspaceState.clear();
}

/** Get or create workspace state. */
function getState(workspaceId: string): WorkspaceAbuseState {
  let state = workspaceState.get(workspaceId);
  if (!state) {
    state = {
      level: "none",
      trigger: null,
      message: null,
      updatedAt: Date.now(),
      window: { timestamps: [], errorCount: 0, tables: new Set() },
      escalations: 0,
    };
    workspaceState.set(workspaceId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Sliding window maintenance
// ---------------------------------------------------------------------------

function pruneWindow(w: WindowCounter, windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  const firstValid = w.timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) {
    w.timestamps.splice(0, firstValid);
  } else if (firstValid === -1) {
    w.timestamps.length = 0;
    w.errorCount = 0;
    w.tables.clear();
  }
}

// ---------------------------------------------------------------------------
// Record a query event
// ---------------------------------------------------------------------------

/**
 * Record a query event for abuse detection.
 * Call this after each query execution (success or failure).
 */
export function recordQueryEvent(
  workspaceId: string,
  opts: { success: boolean; tablesAccessed?: string[] },
): void {
  const config = getAbuseConfig();
  const windowMs = config.queryRateWindowSeconds * 1000;
  const state = getState(workspaceId);
  const w = state.window;

  // If workspace is already suspended, skip tracking
  if (state.level === "suspended") return;

  pruneWindow(w, windowMs);

  const now = Date.now();
  w.timestamps.push(now);
  if (!opts.success) w.errorCount++;
  if (opts.tablesAccessed) {
    for (const t of opts.tablesAccessed) w.tables.add(t);
  }

  // Check thresholds
  checkThresholds(workspaceId, state, config);
}

// ---------------------------------------------------------------------------
// Threshold evaluation & escalation
// ---------------------------------------------------------------------------

function checkThresholds(
  workspaceId: string,
  state: WorkspaceAbuseState,
  config: AbuseThresholdConfig,
): void {
  const w = state.window;
  const queryCount = w.timestamps.length;

  // Query rate check
  if (queryCount > config.queryRateLimit) {
    escalate(workspaceId, state, "query_rate", `Query rate ${queryCount} exceeds limit ${config.queryRateLimit} in ${config.queryRateWindowSeconds}s window`);
    return;
  }

  // Error rate check (need at least 10 queries to evaluate)
  if (queryCount >= 10) {
    const errorRate = w.errorCount / queryCount;
    if (errorRate > config.errorRateThreshold) {
      escalate(workspaceId, state, "error_rate", `Error rate ${(errorRate * 100).toFixed(0)}% exceeds threshold ${(config.errorRateThreshold * 100).toFixed(0)}%`);
      return;
    }
  }

  // Unique tables check
  if (w.tables.size > config.uniqueTablesLimit) {
    escalate(workspaceId, state, "unique_tables", `${w.tables.size} unique tables accessed exceeds limit ${config.uniqueTablesLimit}`);
    return;
  }

  // No threshold exceeded — if we had escalations, decay them
  if (state.escalations > 0 && queryCount < config.queryRateLimit * 0.5) {
    state.escalations = Math.max(0, state.escalations - 1);
  }
}

function escalate(
  workspaceId: string,
  state: WorkspaceAbuseState,
  trigger: AbuseTrigger,
  message: string,
): void {
  const prevLevel = state.level;
  state.escalations++;
  state.trigger = trigger;
  state.message = message;
  state.updatedAt = Date.now();

  // First trigger → warning
  // Second consecutive trigger → throttle
  // Third consecutive trigger → suspend
  if (state.escalations === 1 && prevLevel === "none") {
    state.level = "warning";
  } else if (state.escalations >= 2 && prevLevel === "warning") {
    state.level = "throttled";
  } else if (state.escalations >= 3 && prevLevel === "throttled") {
    state.level = "suspended";
  }

  // Only emit event if level changed
  if (state.level !== prevLevel) {
    const event: AbuseEvent = {
      id: crypto.randomUUID(),
      workspaceId,
      level: state.level,
      trigger,
      message,
      metadata: {
        queryCount: state.window.timestamps.length,
        errorCount: state.window.errorCount,
        uniqueTables: state.window.tables.size,
        escalations: state.escalations,
      },
      createdAt: new Date().toISOString(),
      actor: "system",
    };

    log.warn(
      { workspaceId, level: state.level, trigger, message, escalations: state.escalations },
      "Abuse level changed: %s → %s",
      prevLevel,
      state.level,
    );

    persistAbuseEvent(event);
  }
}

// ---------------------------------------------------------------------------
// Workspace abuse status check (called from middleware)
// ---------------------------------------------------------------------------

/**
 * Check the current abuse level for a workspace.
 * Returns the current level and throttle delay if applicable.
 */
export function checkAbuseStatus(workspaceId: string): {
  level: AbuseLevel;
  throttleDelayMs?: number;
} {
  const state = workspaceState.get(workspaceId);
  if (!state || state.level === "none" || state.level === "warning") {
    return { level: state?.level ?? "none" };
  }

  if (state.level === "throttled") {
    const config = getAbuseConfig();
    return { level: "throttled", throttleDelayMs: config.throttleDelayMs };
  }

  return { level: "suspended" };
}

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

/** List all workspaces with non-"none" abuse levels. */
export function listFlaggedWorkspaces(): AbuseStatus[] {
  const results: AbuseStatus[] = [];
  for (const [workspaceId, state] of workspaceState) {
    if (state.level === "none") continue;
    results.push({
      workspaceId,
      workspaceName: null, // Resolved by the admin route
      level: state.level,
      trigger: state.trigger,
      message: state.message,
      updatedAt: new Date(state.updatedAt).toISOString(),
      events: [],
    });
  }
  return results.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Read the full investigation context for a single flagged workspace:
 * current in-memory counters, thresholds, and the split of persisted events
 * into current/prior instances.
 *
 * Returns `null` when the workspace is not currently flagged (level = "none"
 * or unknown workspace) — callers should 404. DB persistence failures degrade
 * to empty `events` rather than throwing: the in-memory status is still worth
 * returning even if the audit trail is momentarily unreachable.
 */
export async function getAbuseDetail(
  workspaceId: string,
  priorLimit = 5,
  eventLimit = 50,
): Promise<AbuseDetail | null> {
  const state = workspaceState.get(workspaceId);
  if (!state || state.level === "none") return null;

  const config = getAbuseConfig();
  const w = state.window;
  const queryCount = w.timestamps.length;
  // Error rate is only meaningful once we've got a small baseline (mirrors
  // `checkThresholds`). Surface `null` so the UI can show "baseline pending"
  // rather than a misleading 0% / 100%. Arithmetic is delegated to the pure
  // `errorRatePct` helper.
  const errorRate =
    queryCount >= 10 ? errorRatePct(w.errorCount, queryCount) : null;

  const events = await getAbuseEvents(workspaceId, eventLimit);
  const { currentInstance, priorInstances } = splitIntoInstances(events, priorLimit);

  return {
    workspaceId,
    workspaceName: null, // Resolved by the admin route (same as listFlaggedWorkspaces).
    level: state.level,
    trigger: state.trigger,
    message: state.message,
    updatedAt: new Date(state.updatedAt).toISOString(),
    counters: {
      queryCount,
      errorCount: w.errorCount,
      errorRatePct: errorRate,
      uniqueTablesAccessed: w.tables.size,
      escalations: state.escalations,
    },
    thresholds: config,
    currentInstance,
    priorInstances,
  };
}

/** Manually reinstate a suspended or throttled workspace. */
export function reinstateWorkspace(workspaceId: string, actorId: string): boolean {
  const state = workspaceState.get(workspaceId);
  if (!state || state.level === "none") return false;

  const prevLevel = state.level;
  state.level = "none";
  state.trigger = null;
  state.message = null;
  state.escalations = 0;
  state.updatedAt = Date.now();
  // Reset the window so the workspace gets a clean slate
  state.window = { timestamps: [], errorCount: 0, tables: new Set() };

  const event: AbuseEvent = {
    id: crypto.randomUUID(),
    workspaceId,
    level: "none",
    trigger: "manual",
    message: `Reinstated from ${prevLevel} by admin`,
    metadata: { previousLevel: prevLevel },
    createdAt: new Date().toISOString(),
    actor: actorId,
  };

  log.info(
    { workspaceId, previousLevel: prevLevel, actorId },
    "Workspace reinstated from %s",
    prevLevel,
  );

  persistAbuseEvent(event);
  return true;
}

// ---------------------------------------------------------------------------
// Persistence — abuse events to internal DB
// ---------------------------------------------------------------------------

function persistAbuseEvent(event: AbuseEvent): void {
  if (!hasInternalDB()) return;

  try {
    internalExecute(
      `INSERT INTO abuse_events (id, workspace_id, level, trigger_type, message, metadata, actor, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.id,
        event.workspaceId,
        event.level,
        event.trigger,
        event.message,
        JSON.stringify(event.metadata),
        event.actor,
        event.createdAt,
      ],
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to persist abuse event",
    );
  }
}

/** Load recent abuse events from DB for a workspace. */
export async function getAbuseEvents(
  workspaceId: string,
  limit = 50,
): Promise<AbuseEvent[]> {
  if (!hasInternalDB()) return [];

  try {
    const rows = await internalQuery<{
      id: string;
      workspace_id: string;
      level: string;
      trigger_type: string;
      message: string;
      metadata: string;
      actor: string;
      created_at: string;
    }>(
      `SELECT id, workspace_id, level, trigger_type, message, metadata, actor, created_at
       FROM abuse_events
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [workspaceId, limit],
    );

    return rows.map((r) => {
      const { level, trigger } = coerceAbuseEnums(r.id, r.level, r.trigger_type);
      return {
        id: r.id,
        workspaceId: r.workspace_id,
        level,
        trigger,
        message: r.message,
        metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) as Record<string, unknown> : (r.metadata as Record<string, unknown>),
        createdAt: r.created_at,
        actor: r.actor,
      };
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      "Failed to load abuse events",
    );
    return [];
  }
}

/** Restore in-memory state from DB on startup. */
export async function restoreAbuseState(): Promise<void> {
  if (!hasInternalDB()) return;

  try {
    // Get the latest event per workspace to restore current level
    const rows = await internalQuery<{
      workspace_id: string;
      level: string;
      trigger_type: string;
      message: string;
      created_at: string;
    }>(
      `SELECT DISTINCT ON (workspace_id) workspace_id, level, trigger_type, message, created_at
       FROM abuse_events
       ORDER BY workspace_id, created_at DESC`,
    );

    let driftSkipped = 0;
    for (const row of rows) {
      const { level, trigger, levelDrifted } = coerceAbuseEnums(
        row.workspace_id,
        row.level,
        row.trigger_type,
      );
      // A drifted level collapses to "none" — we can't trust that as "already
      // reinstated" because the stored enforcement state is ambiguous. Skip,
      // but count separately so the restore summary surfaces potential lost
      // enforcement rather than silently dropping it.
      if (levelDrifted) {
        driftSkipped++;
        continue;
      }
      if (level === "none") continue; // Already reinstated

      const state = getState(row.workspace_id);
      state.level = level;
      state.trigger = trigger;
      state.message = row.message;
      state.updatedAt = new Date(row.created_at).getTime();
      // Set escalations based on current level to maintain correct position in the ladder
      state.escalations = level === "warning" ? 1 : level === "throttled" ? 2 : 3;
    }

    const restored = [...workspaceState.values()].filter((s) => s.level !== "none").length;
    if (restored > 0 || driftSkipped > 0) {
      log.info(
        { count: restored, driftSkipped },
        "Restored abuse state for %d workspaces (%d skipped due to enum drift)",
        restored,
        driftSkipped,
      );
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to restore abuse state from DB — starting with empty state",
    );
  }
}

// ---------------------------------------------------------------------------
// Periodic cleanup — evict stale window data (called by SchedulerLayer fiber)
// ---------------------------------------------------------------------------

/** Interval for abuse cleanup. Exported for SchedulerLayer. */
export const ABUSE_CLEANUP_INTERVAL_MS = 300_000;

/**
 * Evict stale abuse detection window data. Called periodically by the
 * SchedulerLayer fiber in lib/effect/layers.ts.
 */
export function abuseCleanupTick(): void {
  const config = getAbuseConfig();
  const windowMs = config.queryRateWindowSeconds * 1000;

  for (const [id, state] of workspaceState) {
    pruneWindow(state.window, windowMs);

    // Remove entries with no activity and level "none"
    if (state.level === "none" && state.window.timestamps.length === 0) {
      workspaceState.delete(id);
    }
  }
}
