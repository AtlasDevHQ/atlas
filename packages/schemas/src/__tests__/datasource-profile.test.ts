import { describe, expect, test } from "bun:test";
import type { DatasourceProfileStreamEvent } from "@useatlas/types";
import {
  DatasourceProfileResultSchema,
  parseDatasourceProfileStreamEvent,
} from "../datasource-profile";

const result = {
  id: "prod-us",
  queryable: true,
  persisted: true,
  persistedStatus: "draft",
  entitiesGenerated: 2,
  metricsGenerated: 1,
  tables: ["orders", "users"],
  profilingErrors: 0,
  incomplete: false,
  elapsedMs: 1234,
};

describe("DatasourceProfileResultSchema", () => {
  test("parses a terminal result payload", () => {
    const r = DatasourceProfileResultSchema.safeParse(result);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(result);
  });

  test("parses an incomplete result with incompleteTables", () => {
    const partial = { ...result, incomplete: true, incompleteTables: ["audit"] };
    const r = DatasourceProfileResultSchema.safeParse(partial);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(partial);
  });
});

describe("parseDatasourceProfileStreamEvent (the NDJSON event union, #4111)", () => {
  // The parser validates untrusted server JSON, returning the typed event or
  // `null` — every fixture crosses the boundary as `unknown`.
  function expectParses(input: DatasourceProfileStreamEvent): void {
    expect(parseDatasourceProfileStreamEvent(input)).toEqual(input);
  }
  function expectRejects(input: unknown): void {
    expect(parseDatasourceProfileStreamEvent(input)).toBeNull();
  }

  test("parses a start event", () => {
    expectParses({ type: "start", total: 3 });
  });

  test("parses a done table event", () => {
    expectParses({ type: "table", name: "orders", index: 0, total: 2, status: "done" });
  });

  test("parses an error table event with its scrubbed message", () => {
    expectParses({ type: "table", name: "users", index: 1, total: 2, status: "error", error: "denied" });
  });

  test("parses the terminal result event", () => {
    expectParses({ type: "result", ...result });
  });

  test("parses each registered terminal-error code", () => {
    for (const code of ["reconnect_required", "profiling_failed", "internal_error"] as const) {
      expectParses({ type: "error", error: code, message: "boom", requestId: "req-1" });
    }
  });

  test("rejects an unregistered terminal-error code", () => {
    expectRejects({ type: "error", error: "kaboom", message: "x" });
  });

  test("rejects an unknown table status", () => {
    expectRejects({ type: "table", name: "x", index: 0, total: 1, status: "skipped" });
  });

  test("rejects an unknown event type (caller skips it as forward-compat)", () => {
    expectRejects({ type: "heartbeat" });
  });

  test("rejects a known event missing required fields", () => {
    // A `table` event without index/total/status is not coerced — it's rejected.
    expectRejects({ type: "table", name: "orders" });
  });

  test("rejects non-object JSON primitives (a stray stream line)", () => {
    expectRejects(42);
    expectRejects("oops");
    expectRejects(null);
    expectRejects([{ type: "start", total: 1 }]);
  });
});
