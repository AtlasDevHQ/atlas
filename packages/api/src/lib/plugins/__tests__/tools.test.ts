import { describe, test, expect, beforeEach } from "bun:test";
import {
  setDialectHints,
  getDialectHints,
  pluginDialectModules,
  setContextFragments,
  getContextFragments,
} from "../tools";
import type { DialectHint } from "../wiring";

describe("setDialectHints / getDialectHints", () => {
  beforeEach(() => {
    setDialectHints([]);
  });

  test("defaults to empty array", () => {
    expect(getDialectHints()).toEqual([]);
  });

  test("round-trips DialectHint[]", () => {
    const hints: DialectHint[] = [
      { pluginId: "bq", dbType: "bigquery", dialect: "Use SAFE_DIVIDE for BigQuery." },
      { pluginId: "redshift", dbType: "redshift", dialect: "Use GETDATE() instead of NOW()." },
    ];
    setDialectHints(hints);
    expect(getDialectHints()).toEqual(hints);
  });

  test("overwrites previous hints", () => {
    setDialectHints([{ pluginId: "a", dbType: "postgres", dialect: "first" }]);
    setDialectHints([{ pluginId: "b", dbType: "mysql", dialect: "second" }]);
    expect(getDialectHints()).toEqual([{ pluginId: "b", dbType: "mysql", dialect: "second" }]);
  });

  test("set empty clears hints", () => {
    setDialectHints([{ pluginId: "a", dbType: "postgres", dialect: "hint" }]);
    setDialectHints([]);
    expect(getDialectHints()).toEqual([]);
  });
});

describe("pluginDialectModules", () => {
  beforeEach(() => {
    setDialectHints([]);
  });

  test("projects wired hints into dbType-keyed {dbType, module} modules (#4515)", () => {
    setDialectHints([
      { pluginId: "bq", dbType: "bigquery", dialect: "Use SAFE_DIVIDE." },
      { pluginId: "ch", dbType: "clickhouse", dialect: "Use toStartOfMonth()." },
    ]);
    expect(pluginDialectModules()).toEqual([
      { dbType: "bigquery", module: "Use SAFE_DIVIDE." },
      { dbType: "clickhouse", module: "Use toStartOfMonth()." },
    ]);
  });

  test("empty when no hints are wired", () => {
    expect(pluginDialectModules()).toEqual([]);
  });
});

describe("setContextFragments / getContextFragments", () => {
  beforeEach(() => {
    setContextFragments([]);
  });

  test("defaults to empty array", () => {
    expect(getContextFragments()).toEqual([]);
  });

  test("round-trips fragments", () => {
    setContextFragments(["frag1", "frag2"]);
    expect(getContextFragments()).toEqual(["frag1", "frag2"]);
  });
});
