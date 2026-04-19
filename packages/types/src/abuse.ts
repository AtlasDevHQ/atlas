// ---------------------------------------------------------------------------
// Abuse prevention types — wire format for API + admin UI
// ---------------------------------------------------------------------------

/** Graduated abuse response levels (escalation order). */
export const ABUSE_LEVELS = ["none", "warning", "throttled", "suspended"] as const;
export type AbuseLevel = (typeof ABUSE_LEVELS)[number];

/** Which anomaly detector triggered the abuse event. */
export const ABUSE_TRIGGERS = [
  "query_rate",
  "error_rate",
  "unique_tables",
  "manual",
] as const;
export type AbuseTrigger = (typeof ABUSE_TRIGGERS)[number];

/** A single abuse event recorded in the audit trail. */
export interface AbuseEvent {
  id: string;
  workspaceId: string;
  level: AbuseLevel;
  trigger: AbuseTrigger;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  /** Who initiated the event — "system" for auto-detection, user ID for manual reinstate. */
  actor: string;
}

/** Current abuse status for a workspace. */
export interface AbuseStatus {
  workspaceId: string;
  workspaceName: string | null;
  level: AbuseLevel;
  trigger: AbuseTrigger | null;
  message: string | null;
  updatedAt: string;
  /** Recent abuse events for this workspace. */
  events: AbuseEvent[];
}

/** Abuse threshold configuration (read-only from admin API). */
export interface AbuseThresholdConfig {
  /** Max queries per workspace per sliding window. */
  queryRateLimit: number;
  /** Sliding window duration in seconds. */
  queryRateWindowSeconds: number;
  /** Max error rate (0–1) before escalation. */
  errorRateThreshold: number;
  /** Max unique tables accessed per window before escalation. */
  uniqueTablesLimit: number;
  /** Delay injected for throttled workspaces, in milliseconds. */
  throttleDelayMs: number;
}

/** Live sliding-window counters for the admin detail panel. */
export interface AbuseCounters {
  queryCount: number;
  errorCount: number;
  /** Null when queryCount < 10 (the engine only evaluates error rate once it has a baseline). */
  errorRatePct: number | null;
  uniqueTablesAccessed: number;
  /** Consecutive escalation count currently driving the level. */
  escalations: number;
}

/**
 * A flag "instance" — one continuous stretch of non-"none" activity for a
 * workspace, bookended by an escalation event and (optionally) a reinstatement
 * event.
 *
 * `events` are chronological (oldest first). `endedAt` is null while the
 * instance is still active (no reinstatement yet).
 */
export interface AbuseInstance {
  startedAt: string;
  endedAt: string | null;
  /** Highest level reached during the instance. */
  peakLevel: AbuseLevel;
  events: AbuseEvent[];
}

/**
 * Full investigation context for a single flagged workspace.
 *
 * Returned from `GET /api/v1/admin/abuse/:workspaceId/detail`. Lazy-loaded on
 * row expand — the list endpoint stays lightweight.
 */
export interface AbuseDetail {
  workspaceId: string;
  workspaceName: string | null;
  level: AbuseLevel;
  trigger: AbuseTrigger | null;
  message: string | null;
  updatedAt: string;
  counters: AbuseCounters;
  thresholds: AbuseThresholdConfig;
  /**
   * Current (unreinstated) flag instance.
   *
   * May be empty if the workspace is flagged in memory but no persisted event
   * is yet readable — e.g. `DATABASE_URL` isn't set on a self-hosted deploy,
   * the write is still in flight, or `persistAbuseEvent` failed and was
   * swallowed. The detail-panel empty copy deliberately doesn't assume the DB
   * is broken in this case.
   */
  currentInstance: AbuseInstance;
  /** Prior closed instances, newest-first. Capped server-side. */
  priorInstances: AbuseInstance[];
}
