/**
 * Tests for the `atlas.profile.*` span attribute builder (#3684).
 *
 * The profiler seam is wrapped in `withSpan`/`withEffectSpan` so a slow/hanging
 * profile gets latency attribution. Capturing live spans would mean wiring an
 * `InMemorySpanExporter` into the global tracer provider — heavier than the typo
 * it would catch (same precedent as the `atlas.sql.execute` attribute builder),
 * so the pure attribute builder is the load-bearing piece under test. The no-op
 * behaviour of the wrap itself is covered by `tracing.test.ts`.
 */
import { describe, it, expect } from "bun:test";
import { profileSpanAttributes } from "../profiler";

describe("profileSpanAttributes", () => {
  it("always emits the db_type attribute", () => {
    expect(profileSpanAttributes("postgres")).toEqual({
      "atlas.profile.db_type": "postgres",
    });
  });

  it("emits schema when provided", () => {
    expect(profileSpanAttributes("postgres", { schema: "analytics" })).toEqual({
      "atlas.profile.db_type": "postgres",
      "atlas.profile.schema": "analytics",
    });
  });

  it("emits connection_id when provided", () => {
    expect(
      profileSpanAttributes("clickhouse", { connectionId: "warehouse" }),
    ).toEqual({
      "atlas.profile.db_type": "clickhouse",
      "atlas.profile.connection_id": "warehouse",
    });
  });

  it("emits the selected-table COUNT (not the names — keeps cardinality bounded)", () => {
    expect(
      profileSpanAttributes("mysql", { selectedTables: ["orders", "users", "events"] }),
    ).toEqual({
      "atlas.profile.db_type": "mysql",
      "atlas.profile.selected_table_count": 3,
    });
  });

  it("combines every attribute when all inputs are present", () => {
    expect(
      profileSpanAttributes("postgres", {
        schema: "public",
        connectionId: "default",
        selectedTables: ["orders"],
      }),
    ).toEqual({
      "atlas.profile.db_type": "postgres",
      "atlas.profile.schema": "public",
      "atlas.profile.connection_id": "default",
      "atlas.profile.selected_table_count": 1,
    });
  });

  it("omits optional attributes rather than emitting undefined values", () => {
    const attrs = profileSpanAttributes("postgres", {});
    expect(Object.keys(attrs)).toEqual(["atlas.profile.db_type"]);
  });
});
