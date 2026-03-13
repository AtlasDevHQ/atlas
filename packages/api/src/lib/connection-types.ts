/**
 * Canonical connection wire types shared across backend, SDK, and frontend.
 *
 * These types represent the JSON-serialized shapes returned by the API.
 * The backend's internal types (e.g. HealthCheckResult with checkedAt: Date)
 * are separate — JSON serialization converts Date to string automatically.
 */

export * from "@useatlas/types/connection";
