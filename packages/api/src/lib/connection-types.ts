/**
 * Canonical connection wire types shared across backend, SDK, and frontend.
 *
 * These types represent the JSON-serialized shapes returned by the API.
 * The backend's internal types (e.g. HealthCheckResult with checkedAt: Date)
 * are separate — JSON serialization converts Date to string automatically.
 */

/** Known database types supported by Atlas (core + plugins). */
export const DB_TYPES = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "snowflake", label: "Snowflake" },
  { value: "duckdb", label: "DuckDB" },
  { value: "salesforce", label: "Salesforce" },
] as const;

/** Database type — derived from DB_TYPES. */
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
  description?: string;
  health?: ConnectionHealth;
}

/** Wire format for a single connection detail (admin GET /connections/:id). */
export interface ConnectionDetail {
  id: string;
  dbType: string;
  description: string | null;
  health: ConnectionHealth | null;
  maskedUrl: string | null;
  schema: string | null;
  managed: boolean;
}
