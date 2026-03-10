import { describe, test, expect } from "bun:test";
import { parseDuckDBUrl } from "../src/connection";

describe("parseDuckDBUrl", () => {
  test("parses duckdb:// as in-memory", () => {
    expect(parseDuckDBUrl("duckdb://")).toEqual({ path: ":memory:", readOnly: false });
  });

  test("parses duckdb://:memory: as in-memory", () => {
    expect(parseDuckDBUrl("duckdb://:memory:")).toEqual({ path: ":memory:", readOnly: false });
  });

  test("parses duckdb:///absolute/path.duckdb", () => {
    expect(parseDuckDBUrl("duckdb:///tmp/data.duckdb")).toEqual({
      path: "/tmp/data.duckdb",
      readOnly: true,
    });
  });

  test("parses duckdb://relative/path.duckdb", () => {
    expect(parseDuckDBUrl("duckdb://data/analytics.duckdb")).toEqual({
      path: "data/analytics.duckdb",
      readOnly: true,
    });
  });

  test("rejects non-duckdb URL", () => {
    expect(() => parseDuckDBUrl("postgresql://localhost:5432/db")).toThrow(
      /expected duckdb:\/\/ scheme/,
    );
  });

  test("rejects empty string", () => {
    expect(() => parseDuckDBUrl("")).toThrow(/expected duckdb:\/\/ scheme/);
  });

  test("parses path with .duckdb extension", () => {
    expect(parseDuckDBUrl("duckdb://my-data.duckdb")).toEqual({
      path: "my-data.duckdb",
      readOnly: true,
    });
  });

  test("parses nested path", () => {
    expect(parseDuckDBUrl("duckdb://data/warehouse/analytics.duckdb")).toEqual({
      path: "data/warehouse/analytics.duckdb",
      readOnly: true,
    });
  });
});
