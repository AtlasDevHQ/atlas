// ---------------------------------------------------------------------------
// Abuse prevention types — wire format for API + admin UI
// ---------------------------------------------------------------------------

// Adding a value here requires a matching migration to extend the DB
// CHECK in `packages/api/src/lib/db/migrations/*_abuse_events_enum_checks.sql`
// — otherwise `persistAbuseEvent` will fail at INSERT time.

import type { Percentage, Ratio } from "./percentage";

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
  /**
   * Per-workspace load status for the `events` payload (#1682). Defaults
   * to `"ok"` in pre-existing callers that don't yet surface the signal,
   * so list consumers who filter on `eventsStatus === "ok"` can safely
   * treat the absence as the happy path.
   */
  eventsStatus?: AbuseEventsStatus;
}

/** Abuse threshold configuration (read-only from admin API). */
export interface AbuseThresholdConfig {
  /** Max queries per workspace per sliding window. */
  queryRateLimit: number;
  /** Sliding window duration in seconds. */
  queryRateWindowSeconds: number;
  /**
   * Max error rate before escalation. `Ratio` (0–1) — authored in
   * `atlas.config.ts` / env vars as a fraction because the engine's
   * internal comparison `errorCount / totalCount > errorRateThreshold`
   * works on fractions too. Cross-scale mixups with `AbuseCounters.errorRatePct`
   * (a `Percentage`) are prevented by the brand (#1685).
   */
  errorRateThreshold: Ratio;
  /** Max unique tables accessed per window before escalation. */
  uniqueTablesLimit: number;
  /** Delay injected for throttled workspaces, in milliseconds. */
  throttleDelayMs: number;
}

/** Live sliding-window counters for the admin detail panel. */
export interface AbuseCounters {
  queryCount: number;
  errorCount: number;
  /**
   * Error rate as a `Percentage` (0–100), matching the SLA surfaces'
   * convention. Null when queryCount < 10 (the engine only evaluates
   * error rate once it has a baseline). Branded (#1685) so a caller
   * cannot assign this value into a `Ratio`-typed slot without an
   * explicit `percentageToRatio` — the brand catches the scale mixup at
   * assignment, not at the `>` / `<` operator.
   */
  errorRatePct: Percentage | null;
  uniqueTablesAccessed: number;
  /** Consecutive escalation count currently driving the level. */
  escalations: number;
}

/**
 * Phantom brand for `AbuseInstance` (#1684). `unique symbol` declared
 * module-privately; the required `never`-typed key rejects plain object
 * literals, so minting requires a localized cast. Two call sites own
 * that cast: `createAbuseInstance` (enforces peakLevel ≡ max(event
 * levels), endedAt non-null iff last event is a manual "none"
 * reinstatement, startedAt ≡ events[0].createdAt) and `AbuseInstanceSchema`
 * at the wire boundary. Zero runtime cost — the brand erases.
 */
declare const abuseInstanceBrand: unique symbol;

/**
 * A flag "instance" — one continuous stretch of non-"none" activity for a
 * workspace, bookended by an escalation event and (optionally) a
 * reinstatement event.
 *
 * `events` are chronological (oldest first) and `readonly` — post-
 * construction mutation would silently invalidate the cached `peakLevel`
 * / `endedAt` invariants the factory established. `endedAt` is null while
 * the instance is still active (no reinstatement yet). See
 * `abuseInstanceBrand` above for the nominal-typing guarantee.
 */
export interface AbuseInstance {
  readonly [abuseInstanceBrand]: never;
  startedAt: string;
  endedAt: string | null;
  /** Highest level reached during the instance. */
  peakLevel: AbuseLevel;
  events: readonly AbuseEvent[];
}

/**
 * Diagnostic channel for the `events` payload on `AbuseDetail` (#1682).
 *
 * Before this tag, a DB load failure silently degraded `events` to `[]` —
 * indistinguishable from "this workspace has never been flagged." An
 * operator investigating a re-flagged workspace during a transient DB
 * outage saw a clean slate and could reinstate a repeat offender based on
 * false-empty history. `eventsStatus` surfaces the degraded state so the UI
 * can show a loud warning rather than the benign empty-history copy.
 *
 * - `ok` — events loaded successfully (empty history is truly empty).
 * - `load_failed` — `getAbuseEvents` caught a DB error. Counters + level in
 *   the rest of the payload are still accurate (they come from in-memory
 *   state), but the audit trail is unreachable; do not draw conclusions
 *   from `currentInstance` / `priorInstances` being empty.
 * - `db_unavailable` — `hasInternalDB()` returned false. Expected on a
 *   self-hosted deploy without `DATABASE_URL`; the engine is running in
 *   ephemeral in-memory mode. Prior flag history does not exist to load.
 */
export const ABUSE_EVENTS_STATUSES = ["ok", "load_failed", "db_unavailable"] as const;
export type AbuseEventsStatus = (typeof ABUSE_EVENTS_STATUSES)[number];

/**
 * Full investigation context for a single flagged workspace.
 *
 * Returned from `GET /api/v1/admin/abuse/:workspaceId/detail`. Lazy-loaded on
 * row expand — the list endpoint stays lightweight.
 *
 * Extends `Omit<AbuseStatus, "events">` so the identity fields
 * (workspaceId, workspaceName, level, trigger, message, updatedAt) stay
 * structurally coupled to the list response. Events move into
 * `currentInstance.events` / `priorInstances[i].events` — the detail panel
 * splits them by flag instance so the list's flat `events` array is the
 * wrong shape here.
 */
export interface AbuseDetail extends Omit<AbuseStatus, "events"> {
  counters: AbuseCounters;
  thresholds: AbuseThresholdConfig;
  /**
   * Current (unreinstated) flag instance.
   *
   * May be empty if the workspace is flagged in memory but no persisted event
   * is yet readable — read `eventsStatus` to distinguish the three
   * possibilities: really-empty history, DB load failure, or a self-hosted
   * deploy without `DATABASE_URL`. The detail-panel UI renders a loud
   * banner when `eventsStatus !== "ok"` so an operator does not mistake a
   * degraded audit trail for "never flagged."
   */
  currentInstance: AbuseInstance;
  /** Prior closed instances, newest-first. Capped server-side. */
  priorInstances: AbuseInstance[];
  /**
   * Load status for the events payload. Propagates from `getAbuseEvents` →
   * lib → route → UI so the admin panel can distinguish empty-because-clean
   * from empty-because-broken. See `AbuseEventsStatus`.
   */
  eventsStatus: AbuseEventsStatus;
}
