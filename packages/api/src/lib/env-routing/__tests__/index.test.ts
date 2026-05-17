/**
 * Exhaustive unit tests for the agent-decided routing module
 * (PRD #2515, slice 1 #2516). Pure — no DB, no IO. Covers every branch of
 * the routing table so slices 3 / 4 inherit a verified policy.
 *
 * The named `describe` blocks line up with the issue's acceptance criteria
 * categories. Boundary cases (unknown members, empty member list, 1×1
 * group with explicit fanout request) live alongside the main matrix.
 */

import { describe, it, expect } from "bun:test";
import { resolveRoutingPlan, ENV_COLUMN, type RoutingReason } from "../index";

describe("ENV_COLUMN", () => {
  it("uses the `__env__` sentinel — matches the `__demo__` / `__global__` shape", () => {
    expect(ENV_COLUMN).toBe("__env__");
  });
});

describe("resolveRoutingPlan — Auto mode (default)", () => {
  it("scope: 'this' → single execution against the current member", () => {
    const { plan, warnings } = resolveRoutingPlan({
      agentScope: "this",
      currentMember: "us-int",
      members: ["us-int", "eu", "apac"],
      primaryMember: "us-int",
    });
    expect(plan).toEqual({
      kind: "single",
      connectionId: "us-int",
      reason: "agent-this",
    });
    expect(warnings).toEqual([]);
  });

  it("scope omitted → same as scope: 'this' (single, agent-this reason)", () => {
    const { plan, warnings } = resolveRoutingPlan({
      currentMember: "eu",
      members: ["us-int", "eu", "apac"],
    });
    expect(plan).toEqual({
      kind: "single",
      connectionId: "eu",
      reason: "agent-this",
    });
    expect(warnings).toEqual([]);
  });

  it("scope: 'all' → fanout across every member, in declared order", () => {
    const { plan, warnings } = resolveRoutingPlan({
      agentScope: "all",
      currentMember: "us-int",
      members: ["us-int", "eu", "apac"],
    });
    expect(plan).toEqual({
      kind: "fanout",
      connectionIds: ["us-int", "eu", "apac"],
      reason: "agent-all",
    });
    expect(warnings).toEqual([]);
  });

  it("scope: '<known member id>' → single execution against that member", () => {
    const { plan, warnings } = resolveRoutingPlan({
      agentScope: "apac",
      currentMember: "us-int",
      members: ["us-int", "eu", "apac"],
    });
    expect(plan).toEqual({
      kind: "single",
      connectionId: "apac",
      reason: "agent-member",
    });
    expect(warnings).toEqual([]);
  });

  it("scope: '<unknown id>' → fall back to the group's primary with a warning", () => {
    const { plan, warnings } = resolveRoutingPlan({
      agentScope: "us-west-2",
      currentMember: "us-int",
      members: ["us-int", "eu", "apac"],
      primaryMember: "us-int",
    });
    expect(plan).toEqual({
      kind: "single",
      connectionId: "us-int",
      reason: "fallback-current",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("us-west-2");
    expect(warnings[0]).toContain("us-int");
  });

  it("scope: '<unknown id>' with no primaryMember → falls back to currentMember", () => {
    const { plan, warnings } = resolveRoutingPlan({
      agentScope: "ghost-region",
      currentMember: "eu",
      members: ["us-int", "eu"],
      // primaryMember omitted
    });
    expect(plan).toEqual({
      kind: "single",
      connectionId: "eu",
      reason: "fallback-current",
    });
    expect(warnings).toHaveLength(1);
  });
});

describe("resolveRoutingPlan — 1×1 group (single-member or empty)", () => {
  it("one member, scope: 'all' → single (fanout is structurally meaningless)", () => {
    const { plan, warnings } = resolveRoutingPlan({
      agentScope: "all",
      currentMember: "lonely",
      members: ["lonely"],
    });
    expect(plan).toEqual({
      kind: "single",
      connectionId: "lonely",
      reason: "1x1-group",
    });
    expect(warnings).toEqual([]);
  });

  it("one member, scope: '<named>' → single, ignores the agent's member hint", () => {
    const { plan } = resolveRoutingPlan({
      agentScope: "phantom",
      currentMember: "lonely",
      members: ["lonely"],
    });
    expect(plan).toEqual({
      kind: "single",
      connectionId: "lonely",
      reason: "1x1-group",
    });
  });

  it("empty member list (defensive) → single against currentMember", () => {
    const { plan } = resolveRoutingPlan({
      agentScope: "all",
      currentMember: "default",
      members: [],
    });
    expect(plan).toEqual({
      kind: "single",
      connectionId: "default",
      reason: "1x1-group",
    });
  });

  it("one member, picker 'all' → still single (1×1 short-circuits picker)", () => {
    const { plan } = resolveRoutingPlan({
      pickerMode: "all",
      agentScope: "this",
      currentMember: "lonely",
      members: ["lonely"],
    });
    expect(plan.kind).toBe("single");
    expect(plan.reason).toBe("1x1-group");
  });
});

describe("resolveRoutingPlan — picker overrides (slice 3 wiring, slice 1 validates)", () => {
  it("picker 'pin' + agent 'all' → single against currentMember (pin wins)", () => {
    const { plan, warnings } = resolveRoutingPlan({
      pickerMode: "pin",
      agentScope: "all",
      currentMember: "eu",
      members: ["us-int", "eu", "apac"],
    });
    expect(plan).toEqual({
      kind: "single",
      connectionId: "eu",
      reason: "picker-pin",
    });
    expect(warnings).toEqual([]);
  });

  it("picker 'pin' + agent '<other member>' → still pinned member", () => {
    const { plan } = resolveRoutingPlan({
      pickerMode: "pin",
      agentScope: "apac",
      currentMember: "eu",
      members: ["us-int", "eu", "apac"],
    });
    expect(plan).toEqual({
      kind: "single",
      connectionId: "eu",
      reason: "picker-pin",
    });
  });

  it("picker 'all' + agent 'this' → fanout (override wins)", () => {
    const { plan } = resolveRoutingPlan({
      pickerMode: "all",
      agentScope: "this",
      currentMember: "us-int",
      members: ["us-int", "eu", "apac"],
    });
    expect(plan).toEqual({
      kind: "fanout",
      connectionIds: ["us-int", "eu", "apac"],
      reason: "picker-all",
    });
  });

  it("picker 'all' + agent omitted → fanout", () => {
    const { plan } = resolveRoutingPlan({
      pickerMode: "all",
      currentMember: "us-int",
      members: ["us-int", "eu", "apac"],
    });
    expect(plan).toEqual({
      kind: "fanout",
      connectionIds: ["us-int", "eu", "apac"],
      reason: "picker-all",
    });
  });

  it("picker 'auto' (explicit) === picker omitted — agent decides", () => {
    const explicit = resolveRoutingPlan({
      pickerMode: "auto",
      agentScope: "all",
      currentMember: "us-int",
      members: ["us-int", "eu", "apac"],
    });
    const implicit = resolveRoutingPlan({
      agentScope: "all",
      currentMember: "us-int",
      members: ["us-int", "eu", "apac"],
    });
    expect(explicit).toEqual(implicit);
  });
});

describe("resolveRoutingPlan — fanout member ordering", () => {
  it("preserves the caller's `members` order so the merged result is deterministic", () => {
    const { plan } = resolveRoutingPlan({
      agentScope: "all",
      currentMember: "apac",
      members: ["apac", "us-int", "eu"],
    });
    if (plan.kind !== "fanout") throw new Error("expected fanout");
    expect(plan.connectionIds).toEqual(["apac", "us-int", "eu"]);
  });
});

describe("resolveRoutingPlan — reasons are stable identifiers", () => {
  // The reasons are wired into audit / telemetry attributes. Pin the values
  // here so a typo-rename surfaces as a test failure rather than silently
  // changing the attribute observers depend on.
  it("emits one of the documented reason strings", () => {
    const cases: Array<{ input: Parameters<typeof resolveRoutingPlan>[0]; reason: RoutingReason }> = [
      { input: { agentScope: "this", currentMember: "a", members: ["a", "b"] }, reason: "agent-this" },
      { input: { agentScope: "all", currentMember: "a", members: ["a", "b"] }, reason: "agent-all" },
      { input: { agentScope: "b", currentMember: "a", members: ["a", "b"] }, reason: "agent-member" },
      { input: { agentScope: "z", currentMember: "a", members: ["a", "b"], primaryMember: "a" }, reason: "fallback-current" },
      { input: { currentMember: "a", members: ["a"] }, reason: "1x1-group" },
      { input: { pickerMode: "pin", currentMember: "a", members: ["a", "b"] }, reason: "picker-pin" },
      { input: { pickerMode: "all", currentMember: "a", members: ["a", "b"] }, reason: "picker-all" },
    ];
    for (const { input, reason } of cases) {
      const { plan } = resolveRoutingPlan(input);
      expect(plan.reason).toBe(reason);
    }
  });
});
