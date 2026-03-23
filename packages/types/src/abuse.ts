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
