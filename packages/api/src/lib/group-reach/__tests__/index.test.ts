/**
 * Behavioral unit tests for the pure cross-group reach resolver
 * (ADR-0022, slice (a) #3893). Pure — no DB, no IO. The named `describe`
 * blocks line up with the issue's acceptance criteria: default-all,
 * visibility filtering, and the no-substitution invariant.
 *
 * `GroupReachResolver` is the new axis *above* the `env-routing/` Member
 * planner: it decides *which Connection groups* are reachable, never
 * *which Member within a group* (that stays env-routing's job). These
 * tests pin the reach policy so the executeSQL group-target bound and
 * the slice-(c) picker inherit a verified resolver.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveReach,
  isReachable,
  type VisibleGroup,
  type ReachReason,
} from "../index";

/** Build a `VisibleGroup` with a sane single-member default. */
function g(id: string, members?: string[]): VisibleGroup {
  const m = members ?? [id];
  return { id, members: m, primary: m[0] ?? id };
}

const VISIBLE: readonly VisibleGroup[] = [
  g("postgres", ["pg-us", "pg-eu"]),
  g("clickhouse"),
  g("stripe-rest"),
];

describe("resolveReach — All (default)", () => {
  it("kind 'all' → every visible group is reachable, order preserved", () => {
    const result = resolveReach({ kind: "all" }, VISIBLE);
    expect(result.reachableGroups.map((x) => x.id)).toEqual([
      "postgres",
      "clickhouse",
      "stripe-rest",
    ]);
    expect(result.reason).toBe("all-visible");
    expect(result.warnings).toEqual([]);
  });

  it("kind 'all' over an empty workspace → empty reach, no warning", () => {
    const result = resolveReach({ kind: "all" }, []);
    expect(result.reachableGroups).toEqual([]);
    expect(result.reason).toBe("all-visible");
    expect(result.warnings).toEqual([]);
  });

  it("returns the visible group objects intact (members + primary preserved)", () => {
    const result = resolveReach({ kind: "all" }, VISIBLE);
    const pg = result.reachableGroups.find((x) => x.id === "postgres");
    expect(pg?.members).toEqual(["pg-us", "pg-eu"]);
    expect(pg?.primary).toBe("pg-us");
  });
});

describe("resolveReach — visibility filtering", () => {
  it("never includes a group absent from the visible set (content-mode/whitelist-invisible excluded)", () => {
    // `draft-group` is NOT in the visible set (caller filtered it by
    // content-mode/whitelist), so it can never be reachable.
    const result = resolveReach({ kind: "all" }, VISIBLE);
    expect(result.reachableGroups.map((x) => x.id)).not.toContain("draft-group");
  });

  it("Focus on a visible group → exactly that group", () => {
    const result = resolveReach({ kind: "focus", groupId: "clickhouse" }, VISIBLE);
    expect(result.reachableGroups.map((x) => x.id)).toEqual(["clickhouse"]);
    expect(result.reason).toBe("focus-resolved");
    expect(result.warnings).toEqual([]);
  });
});

describe("resolveReach — no silent substitution", () => {
  it("Focus on an INVISIBLE/unknown group → empty reach, never another group", () => {
    const result = resolveReach({ kind: "focus", groupId: "draft-group" }, VISIBLE);
    // The keystone invariant: an out-of-reach focus resolves to *nothing*,
    // it does NOT fall back to the first visible group or any substitute.
    expect(result.reachableGroups).toEqual([]);
    expect(result.reason).toBe("focus-invisible");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("draft-group");
  });

  it("Focus on an empty workspace → empty reach (no substitution possible)", () => {
    const result = resolveReach({ kind: "focus", groupId: "postgres" }, []);
    expect(result.reachableGroups).toEqual([]);
    expect(result.reason).toBe("focus-invisible");
    expect(result.warnings).toHaveLength(1);
  });
});

describe("isReachable", () => {
  it("true for a group in the resolved reach, false otherwise", () => {
    const all = resolveReach({ kind: "all" }, VISIBLE);
    expect(isReachable(all, "postgres")).toBe(true);
    expect(isReachable(all, "clickhouse")).toBe(true);
    expect(isReachable(all, "draft-group")).toBe(false);
  });

  it("false for every group but the focused one under Focus", () => {
    const focus = resolveReach({ kind: "focus", groupId: "stripe-rest" }, VISIBLE);
    expect(isReachable(focus, "stripe-rest")).toBe(true);
    expect(isReachable(focus, "postgres")).toBe(false);
  });

  it("matches by canonical group id, not by member connection id", () => {
    // A query naming a *member* id ("pg-us") is not naming the *group*
    // ("postgres"). Reach is a group axis; member selection is env-routing's
    // job. `isReachable` must not accept a member id as the group.
    const all = resolveReach({ kind: "all" }, VISIBLE);
    expect(isReachable(all, "postgres")).toBe(true);
    expect(isReachable(all, "pg-us")).toBe(false);
  });
});

describe("ReachReason — stable identifiers", () => {
  it("emits one of the documented reason strings", () => {
    const cases: Array<{ state: Parameters<typeof resolveReach>[0]; reason: ReachReason }> = [
      { state: { kind: "all" }, reason: "all-visible" },
      { state: { kind: "focus", groupId: "postgres" }, reason: "focus-resolved" },
      { state: { kind: "focus", groupId: "nope" }, reason: "focus-invisible" },
    ];
    for (const { state, reason } of cases) {
      expect(resolveReach(state, VISIBLE).reason).toBe(reason);
    }
  });
});
