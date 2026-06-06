/**
 * Tests for the admin Metrics viewer's normalization (#3276 / #3235).
 *
 * The `/api/v1/admin/semantic/metrics` endpoint returns one entry per file as
 * `{ source, file, data }`, where `data` is one of three shapes. Regressions
 * here silently drop metrics from the admin UI even though the backend
 * discovered them — exactly the #3276 bug for single-object files.
 */

import { describe, expect, test } from "bun:test";
import { normalizeMetrics, metricItemsFromData } from "../normalize-metrics";

describe("metricItemsFromData", () => {
  test("returns an array of metrics unchanged", () => {
    const arr = [{ id: "a", sql: "SELECT 1" }];
    expect(metricItemsFromData(arr)).toBe(arr);
  });

  test("unwraps the { metrics: [...] } shape", () => {
    const data = { metrics: [{ id: "a", sql: "SELECT 1" }] };
    expect(metricItemsFromData(data)).toEqual(data.metrics);
  });

  test("wraps a single-object metric (#3276)", () => {
    const data = { id: "total_companies", sql: "SELECT count(*) FROM companies" };
    expect(metricItemsFromData(data)).toEqual([data]);
  });

  test("recognizes single-object metrics keyed by name or label", () => {
    expect(metricItemsFromData({ name: "rev", sql: "SELECT 1" })).toEqual([
      { name: "rev", sql: "SELECT 1" },
    ]);
    expect(metricItemsFromData({ label: "rev", sql: "SELECT 1" })).toEqual([
      { label: "rev", sql: "SELECT 1" },
    ]);
  });

  test("returns null for objects without sql + id/name/label", () => {
    expect(metricItemsFromData({ description: "no sql here" })).toBeNull();
    expect(metricItemsFromData({ sql: "SELECT 1" })).toBeNull(); // no id/name/label
    expect(metricItemsFromData(null)).toBeNull();
    expect(metricItemsFromData("nope")).toBeNull();
  });
});

describe("normalizeMetrics", () => {
  test("returns [] for non-array input", () => {
    expect(normalizeMetrics(null)).toEqual([]);
    expect(normalizeMetrics({ metrics: [] })).toEqual([]);
  });

  test("renders array-form metric files", () => {
    const result = normalizeMetrics([
      { file: "core", source: "default", data: [{ id: "a", sql: "SELECT 1" }, { id: "b", sql: "SELECT 2" }] },
    ]);
    expect(result.map((m) => m.name)).toEqual(["a", "b"]);
    expect(result.every((m) => m.file === "core")).toBe(true);
  });

  test("renders { metrics: [] } wrapper files", () => {
    const result = normalizeMetrics([
      { file: "wrapped", source: "default", data: { metrics: [{ id: "a", sql: "SELECT 1" }] } },
    ]);
    expect(result.map((m) => m.name)).toEqual(["a"]);
  });

  test("renders single-object metric files that used to be dropped (#3276)", () => {
    const result = normalizeMetrics([
      {
        file: "total_companies",
        source: "default",
        data: { id: "total_companies", sql: "SELECT count(*) FROM companies" },
      },
    ]);
    expect(result.length).toBe(1);
    expect(result[0]).toMatchObject({
      name: "total_companies",
      sql: "SELECT count(*) FROM companies",
      file: "total_companies",
      source: "default",
    });
  });

  test("attributes group metrics to their source (#3235)", () => {
    // groups/<group>/metrics/<id>.yml — a single-object file reported with
    // source: <group>. Must appear AND carry the group.
    const result = normalizeMetrics([
      {
        file: "sessions_per_day",
        source: "warehouse",
        data: { id: "sessions_per_day", sql: "SELECT count(*) FROM sessions" },
      },
    ]);
    expect(result.length).toBe(1);
    expect(result[0]!.source).toBe("warehouse");
    expect(result[0]!.file).toBe("sessions_per_day");
  });

  test("falls back to the entry file/source when the metric object omits them", () => {
    const result = normalizeMetrics([
      { file: "core", source: "default", data: [{ id: "a", sql: "SELECT 1" }] },
    ]);
    expect(result[0]!.file).toBe("core");
    expect(result[0]!.source).toBe("default");
  });

  test("mixed shapes in one payload all render", () => {
    const result = normalizeMetrics([
      { file: "arr", source: "default", data: [{ id: "a", sql: "SELECT 1" }] },
      { file: "wrap", source: "default", data: { metrics: [{ id: "b", sql: "SELECT 2" }] } },
      { file: "single", source: "warehouse", data: { id: "c", sql: "SELECT 3" } },
    ]);
    expect(result.map((m) => m.name).toSorted()).toEqual(["a", "b", "c"]);
  });
});
