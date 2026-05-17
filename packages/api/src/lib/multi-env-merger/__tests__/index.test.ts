/**
 * Exhaustive unit tests for the cross-environment result merger
 * (PRD #2515, slice 1 #2516). Pure — no DB, no IO.
 *
 * Covers the categories the slice acceptance criteria called out
 * explicitly:
 *   - same schema across members
 *   - schema divergence (column union with NULL fill)
 *   - partial failure (success rows preserved, error in envContributions)
 *   - all members empty
 *   - type coercion across members
 *
 * Plus boundary cases: zero-input edge, `__env__` collision defence,
 * order-preservation, single-member fanout (degenerate but valid).
 */

import { describe, it, expect } from "bun:test";
import { mergeMemberResults, type MemberExecutionResult } from "../index";
import { ENV_COLUMN } from "@atlas/api/lib/env-routing";

describe("mergeMemberResults — same schema across members", () => {
  it("prepends __env__ and preserves row order by member, then by row", () => {
    const inputs: MemberExecutionResult[] = [
      {
        connectionId: "us-int",
        columns: ["region", "revenue"],
        rows: [
          { region: "us", revenue: 100 },
          { region: "us", revenue: 110 },
        ],
        durationMs: 30,
      },
      {
        connectionId: "eu",
        columns: ["region", "revenue"],
        rows: [{ region: "eu", revenue: 80 }],
        durationMs: 50,
      },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.columns).toEqual(["__env__", "region", "revenue"]);
    expect(merged.rows).toEqual([
      { __env__: "us-int", region: "us", revenue: 100 },
      { __env__: "us-int", region: "us", revenue: 110 },
      { __env__: "eu", region: "eu", revenue: 80 },
    ]);
    expect(merged.envContributions).toEqual([
      { connectionId: "us-int", rowCount: 2, error: null, durationMs: 30 },
      { connectionId: "eu", rowCount: 1, error: null, durationMs: 50 },
    ]);
  });
});

describe("mergeMemberResults — schema divergence (column union + NULL fill)", () => {
  it("unions columns in order of first appearance; missing cells become null", () => {
    const inputs: MemberExecutionResult[] = [
      {
        connectionId: "us-int",
        columns: ["a", "b"],
        rows: [{ a: 1, b: 2 }],
        durationMs: 10,
      },
      {
        connectionId: "eu",
        columns: ["a", "c"],
        rows: [{ a: 3, c: 4 }],
        durationMs: 12,
      },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.columns).toEqual(["__env__", "a", "b", "c"]);
    expect(merged.rows).toEqual([
      { __env__: "us-int", a: 1, b: 2, c: null },
      { __env__: "eu", a: 3, b: null, c: 4 },
    ]);
  });

  it("preserves the first member's column order when later members add new columns", () => {
    const inputs: MemberExecutionResult[] = [
      {
        connectionId: "first",
        columns: ["x", "y"],
        rows: [{ x: 1, y: 2 }],
        durationMs: 5,
      },
      {
        connectionId: "second",
        columns: ["z", "y"], // z is new; y already seen
        rows: [{ z: 9, y: 8 }],
        durationMs: 6,
      },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.columns).toEqual(["__env__", "x", "y", "z"]);
  });
});

describe("mergeMemberResults — partial failure", () => {
  it("preserves successful members' rows and surfaces the failed one in envContributions only", () => {
    const inputs: MemberExecutionResult[] = [
      {
        connectionId: "us-int",
        columns: ["n"],
        rows: [{ n: 1 }, { n: 2 }],
        durationMs: 11,
      },
      {
        connectionId: "eu",
        error: "ECONNREFUSED 10.0.0.4:5432",
        durationMs: 9,
      },
      {
        connectionId: "apac",
        columns: ["n"],
        rows: [{ n: 3 }],
        durationMs: 80,
      },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.columns).toEqual(["__env__", "n"]);
    expect(merged.rows).toEqual([
      { __env__: "us-int", n: 1 },
      { __env__: "us-int", n: 2 },
      { __env__: "apac", n: 3 },
    ]);
    expect(merged.envContributions).toEqual([
      { connectionId: "us-int", rowCount: 2, error: null, durationMs: 11 },
      { connectionId: "eu", rowCount: 0, error: "ECONNREFUSED 10.0.0.4:5432", durationMs: 9 },
      { connectionId: "apac", rowCount: 1, error: null, durationMs: 80 },
    ]);
  });

  it("all-error fanout returns empty rows and `[__env__]` columns + per-member errors", () => {
    const inputs: MemberExecutionResult[] = [
      { connectionId: "us-int", error: "timeout", durationMs: 30000 },
      { connectionId: "eu", error: "pg: relation does not exist", durationMs: 20 },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.columns).toEqual(["__env__"]);
    expect(merged.rows).toEqual([]);
    expect(merged.envContributions).toEqual([
      { connectionId: "us-int", rowCount: 0, error: "timeout", durationMs: 30000 },
      { connectionId: "eu", rowCount: 0, error: "pg: relation does not exist", durationMs: 20 },
    ]);
  });
});

describe("mergeMemberResults — all members empty", () => {
  it("zero-rowCount entries for every member; columns and rows reflect the empty fanout", () => {
    const inputs: MemberExecutionResult[] = [
      { connectionId: "us-int", columns: ["a"], rows: [], durationMs: 12 },
      { connectionId: "eu", columns: ["a"], rows: [], durationMs: 14 },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.columns).toEqual(["__env__", "a"]);
    expect(merged.rows).toEqual([]);
    expect(merged.envContributions).toEqual([
      { connectionId: "us-int", rowCount: 0, error: null, durationMs: 12 },
      { connectionId: "eu", rowCount: 0, error: null, durationMs: 14 },
    ]);
  });
});

describe("mergeMemberResults — type coercion across members", () => {
  it("coerces a column to string when members disagree on the typeof", () => {
    const inputs: MemberExecutionResult[] = [
      {
        connectionId: "us-int",
        columns: ["count"],
        rows: [{ count: 7 }],
        durationMs: 4,
      },
      {
        connectionId: "eu",
        columns: ["count"],
        rows: [{ count: "12" }],
        durationMs: 6,
      },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.rows).toEqual([
      { __env__: "us-int", count: "7" },
      { __env__: "eu", count: "12" },
    ]);
  });

  it("does not coerce a column whose only divergence is null vs typed value", () => {
    const inputs: MemberExecutionResult[] = [
      {
        connectionId: "us-int",
        columns: ["count"],
        rows: [{ count: 7 }, { count: null }],
        durationMs: 4,
      },
      {
        connectionId: "eu",
        columns: ["count"],
        rows: [{ count: 8 }],
        durationMs: 6,
      },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.rows[0]?.["count"]).toBe(7);
    expect(merged.rows[1]?.["count"]).toBe(null);
    expect(merged.rows[2]?.["count"]).toBe(8);
  });

  it("only coerces the type-mixed columns — uniformly-typed siblings pass through", () => {
    const inputs: MemberExecutionResult[] = [
      {
        connectionId: "us-int",
        columns: ["count", "label"],
        rows: [{ count: 7, label: "ok" }],
        durationMs: 4,
      },
      {
        connectionId: "eu",
        columns: ["count", "label"],
        rows: [{ count: "12", label: "ok" }],
        durationMs: 6,
      },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.rows).toEqual([
      { __env__: "us-int", count: "7", label: "ok" },
      { __env__: "eu", count: "12", label: "ok" },
    ]);
  });
});

describe("mergeMemberResults — boundary cases", () => {
  it("zero members (defensive) → empty rows, sentinel-only columns, empty contributions", () => {
    const merged = mergeMemberResults([]);
    expect(merged.columns).toEqual(["__env__"]);
    expect(merged.rows).toEqual([]);
    expect(merged.envContributions).toEqual([]);
  });

  it("single-member fanout (degenerate) — works the same as a regular fanout", () => {
    const merged = mergeMemberResults([
      {
        connectionId: "only",
        columns: ["a"],
        rows: [{ a: 1 }],
        durationMs: 5,
      },
    ]);
    expect(merged.columns).toEqual(["__env__", "a"]);
    expect(merged.rows).toEqual([{ __env__: "only", a: 1 }]);
    expect(merged.envContributions).toHaveLength(1);
  });

  it("a member exposing a literal `__env__` column does not clobber the sentinel", () => {
    const inputs: MemberExecutionResult[] = [
      {
        connectionId: "us-int",
        columns: [ENV_COLUMN, "n"],
        rows: [{ __env__: "imposter", n: 1 }],
        durationMs: 3,
      },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.columns).toEqual(["__env__", "n"]);
    expect(merged.rows[0]?.["__env__"]).toBe("us-int");
    expect(merged.rows[0]?.["n"]).toBe(1);
  });
});

describe("mergeMemberResults — envContributions ordering", () => {
  it("contribution order matches the input order, regardless of success/failure interleaving", () => {
    const inputs: MemberExecutionResult[] = [
      { connectionId: "first-fail", error: "x", durationMs: 1 },
      { connectionId: "second-ok", columns: ["a"], rows: [{ a: 1 }], durationMs: 2 },
      { connectionId: "third-fail", error: "y", durationMs: 3 },
    ];
    const merged = mergeMemberResults(inputs);
    expect(merged.envContributions.map((c) => c.connectionId)).toEqual([
      "first-fail",
      "second-ok",
      "third-fail",
    ]);
  });
});
