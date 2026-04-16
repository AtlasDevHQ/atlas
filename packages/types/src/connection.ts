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

/** Health check status for a connection. */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

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
}
