/** Known database types for UI dropdowns and wire format validation. Plugins may register additional dbType values not listed here. */
export const DB_TYPES = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "snowflake", label: "Snowflake" },
  { value: "duckdb", label: "DuckDB" },
  { value: "salesforce", label: "Salesforce" },
] as const;

/** Database type — closed union derived from DB_TYPES. The backend's internal DBType in @atlas/api/lib/db/connection.ts is wider to accommodate plugin-registered databases. */
export type DBType = (typeof DB_TYPES)[number]["value"];

/** Valid status values for connections (developer/published mode). */
export const CONNECTION_STATUSES = ["published", "draft", "archived"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Valid health-check status values for a connection. */
export const HEALTH_STATUSES = ["healthy", "degraded", "unhealthy"] as const;

/** Health check status for a connection. */
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** Wire format for a connection health check result (JSON-serialized). */
export interface ConnectionHealth {
  status: HealthStatus;
  latencyMs: number;
  message?: string;
  checkedAt: string;
}

/** Wire format for a connection in list responses. */
export interface ConnectionInfo {
  id: string;
  dbType: DBType;
  description?: string | null;
  status?: ConnectionStatus;
  health?: ConnectionHealth;
  /**
   * Connection group membership. Three states are meaningful:
   * - `undefined` — older serializer / client predating the field.
   * - `null` — explicitly unassigned (no group, or moved out via admin UI).
   * - `string` — current membership.
   * Schema + code use `group_id`; UI copy renders this as "environment".
   */
  groupId?: string | null;
  /**
   * Display name of the group, denormalized so list responses can render
   * a badge without a second round-trip to `/admin/connections/groups`.
   * Same three-state semantics as {@link groupId}.
   */
  groupName?: string | null;
}

/** Real-time pool size counters (only available for core adapters with pool access). */
export interface PoolStats {
  totalSize: number;
  activeCount: number;
  idleCount: number;
  waitingCount: number;
}

/** Wire format for per-connection pool metrics. */
export interface PoolMetrics {
  connectionId: string;
  dbType: string;
  pool: PoolStats | null;
  totalQueries: number;
  totalErrors: number;
  avgQueryTimeMs: number;
  consecutiveFailures: number;
  lastDrainAt: string | null;
}

/** Wire format for per-org pool metrics (extends PoolMetrics with org scope). */
export interface OrgPoolMetrics extends PoolMetrics {
  orgId: string;
  /** Data residency region for this pool, if assigned. */
  region?: string;
}

/** Wire format for org pool configuration (returned by admin API). */
export interface OrgPoolConfig {
  maxConnections: number;
  idleTimeoutMs: number;
  maxOrgs: number;
  warmupProbes: number;
  drainThreshold: number;
}

/** Wire format for a single connection detail response. */
export interface ConnectionDetail {
  id: string;
  /** Broader than DBType — includes fallback "unknown" when metadata is unavailable. */
  dbType: DBType | "unknown";
  description: string | null;
  status?: ConnectionStatus;
  health: ConnectionHealth | null;
  maskedUrl: string | null;
  schema: string | null;
  managed: boolean;
  /**
   * Connection group membership. Three states are meaningful:
   * - `undefined` — older serializer / client predating the field.
   * - `null` — explicitly unassigned (no group, or moved out via admin UI).
   * - `string` — current membership.
   * Schema + code use `group_id`; UI copy renders this as "environment".
   */
  groupId?: string | null;
  /**
   * Display name of the group, denormalized so the detail view can render
   * a badge without a second round-trip. Same three-state semantics as
   * {@link groupId}.
   */
  groupName?: string | null;
}

/**
 * A connection group bundles connections that share a logical schema
 * (e.g. multi-region prod replicas). Content scoped to a group is shared
 * across every member.
 *
 * Vocabulary: schema + code call this a `ConnectionGroup`; UI copy says
 * "environment". The `name` is a mutable display label — references key
 * off `id`, never `name`. `memberCount` is a denormalized read-side
 * projection (snapshot at query time) — split into a dedicated summary
 * shape once a second read site needs a different denormalization.
 */
/**
 * Group lifecycle.
 *
 * - `active`   — default. Group accepts new members, content writes,
 *                and chat routing.
 * - `archived` — read-only tombstone. The group's content was
 *                cascade-archived; renames, member assignments, and
 *                re-archives are refused server-side.
 */
export type ConnectionGroupStatus = "active" | "archived";

export interface ConnectionGroup {
  id: string;
  name: string;
  /** Lifecycle. Optional at the type level so older SDK consumers
   * compiled against pre-status wire types still typecheck after a
   * `@useatlas/types` bump — `0.0.x` exact-pin semver means a required
   * field is a breaking change for every dependent. New backends
   * always populate it; consumers should treat `undefined` as `active`. */
  status?: ConnectionGroupStatus;
  /** Number of connections currently assigned to this group. */
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One connection's membership in a {@link ConnectionGroup}. Returned by
 * the group detail endpoint so the admin UI can render member chips
 * without a second round-trip to `/admin/connections`.
 */
export interface ConnectionGroupMember {
  connectionId: string;
  /** Mirrors {@link ConnectionInfo.dbType} so member chips can show an icon. */
  dbType: DBType | "unknown";
  /** Optional human-readable description from the underlying connection. */
  description: string | null;
}
