/**
 * Canonical connection wire types shared across backend, SDK, and frontend.
 *
 * These types represent the JSON-serialized shapes returned by the API.
 * The backend's internal types (e.g. HealthCheckResult with checkedAt: Date)
 * are separate — JSON serialization converts Date to string automatically.
 */

/** Known database types for UI dropdowns and wire format validation. Plugins may register additional dbType values not listed here. */
export const DB_TYPES = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "snowflake", label: "Snowflake" },
  { value: "duckdb", label: "DuckDB" },
  { value: "salesforce", label: "Salesforce" },
] as const;

/** Database type — closed union derived from DB_TYPES. The backend's internal DBType in connection.ts is wider to accommodate plugin-registered databases. */
export type DBType = (typeof DB_TYPES)[number]["value"];

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
  health?: ConnectionHealth;
}

/** Wire format for a single connection detail response. */
export interface ConnectionDetail {
  id: string;
  /** Broader than DBType — includes fallback "unknown" when metadata is unavailable. */
  dbType: string;
  description: string | null;
  health: ConnectionHealth | null;
  maskedUrl: string | null;
  schema: string | null;
  managed: boolean;
}
