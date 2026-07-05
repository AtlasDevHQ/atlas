/**
 * Table-driven unit test for the pure `executeSQL` planner (#4350).
 *
 * The whole point of extracting `resolveSqlExecutionPlan` is that the
 * reach ⊕ member ⊕ routing ⊕ per-leg-execution-target cascade — the untested
 * inline glue every regression on this surface lived in (#3961 / #3947 /
 * #3109 / #4109 / #3867(b)) — is now a pure value a table can assert over,
 * WITHOUT a mocked DB. The two impure lookups are injected: `resolveReachableGroups`
 * runs the REAL pure `resolveReach` against an in-memory visible-groups fixture,
 * and `loadGroupRoutingContext` returns an in-memory routing context. No
 * `mock.module`, no fake Postgres — just the planner's real branching over
 * `(reachState, group, scope, routingMode, members)`.
 */

import { describe, expect, it } from "bun:test";
import { resolveReach, type VisibleGroup } from "@atlas/api/lib/group-reach";
import type { GroupRoutingContext } from "@atlas/api/lib/env-routing/lookup";
import {
  resolveSqlExecutionPlan,
  type PlanRequestContext,
  type SqlExecutionPlanArgs,
  type SqlExecutionPlanDeps,
} from "@atlas/api/lib/tools/sql-execution-plan";

// --- In-memory deps. `resolveReachableGroups` exercises the real reach
// resolver against a fixture; `loadGroupRoutingContext` returns a fixed
// routing context. A group-of-one falls back to [currentMember] like the real
// (degraded) lookup, so the routing table matches production shapes. ---
function makeDeps(opts: {
  visibleGroups?: readonly VisibleGroup[];
  routing?: (currentMember: string) => GroupRoutingContext;
  onResolveReach?: () => void;
  onLoadRouting?: () => void;
}): SqlExecutionPlanDeps {
  return {
    resolveReachableGroups: async (_orgId, _mode, reachState) => {
      opts.onResolveReach?.();
      return resolveReach(reachState, opts.visibleGroups ?? []);
    },
    loadGroupRoutingContext: async (_orgId, currentMember) => {
      opts.onLoadRouting?.();
      return (
        opts.routing?.(currentMember) ?? {
          members: [currentMember],
          primaryMember: currentMember,
          currentMember,
          degraded: false,
        }
      );
    },
  };
}

const run = (
  reqCtx: PlanRequestContext | undefined,
  args: SqlExecutionPlanArgs,
  deps: SqlExecutionPlanDeps,
) => resolveSqlExecutionPlan(reqCtx, args, deps);

// A two-group visible fixture reused across the reach table.
const TWO_GROUPS: readonly VisibleGroup[] = [
  { id: "postgres", members: ["postgres"], primary: "postgres" },
  { id: "clickhouse", members: ["clickhouse"], primary: "clickhouse" },
];

describe("resolveSqlExecutionPlan — reach gate", () => {
  it("All-sources + no named group: skips reach lookup entirely (no per-query DB cost)", async () => {
    let reachCalls = 0;
    const deps = makeDeps({ visibleGroups: TWO_GROUPS, onResolveReach: () => reachCalls++ });
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "own-conn" },
      {},
      deps,
    );
    expect(reachCalls).toBe(0);
    expect(plan.kind).toBe("single");
    if (plan.kind === "single") expect(plan.executionTarget.connectionId).toBe("own-conn");
  });

  it("runs a query against the agent-named reachable group's primary member", async () => {
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" } },
      { group: "clickhouse" },
      makeDeps({ visibleGroups: TWO_GROUPS }),
    );
    expect(plan.kind).toBe("single");
    if (plan.kind === "single") expect(plan.executionTarget.connectionId).toBe("clickhouse");
  });

  // #3867(b) — the no-substitution invariant. An out-of-reach target is a hard
  // reject, NEVER silently re-routed to a reachable source.
  describe("#3867(b) — out-of-reach rejects, never re-routes", () => {
    it("rejects an agent-named group outside reach and names the reachable set", async () => {
      const { plan, logs } = await run(
        { user: { activeOrganizationId: "org-1" } },
        { group: "secret-db" },
        makeDeps({ visibleGroups: TWO_GROUPS }),
      );
      expect(plan.kind).toBe("reject");
      if (plan.kind === "reject") {
        expect(plan.error).toContain("not within this conversation's reach");
        expect(plan.error).toContain("postgres");
        expect(plan.error).toContain("clickhouse");
      }
      // The rejection is surfaced for observability, not swallowed.
      expect(logs.some((l) => l.message.includes("rejected an out-of-reach group target"))).toBe(true);
    });

    it("rejects a query to a different VISIBLE group when Focused (only the focused group is reachable)", async () => {
      const { plan } = await run(
        { user: { activeOrganizationId: "org-1" }, groupReach: "postgres" },
        { group: "clickhouse" },
        makeDeps({ visibleGroups: TWO_GROUPS }),
      );
      expect(plan.kind).toBe("reject");
      if (plan.kind === "reject") expect(plan.error).toContain("not within this conversation's reach");
    });

    it("rejects an omitted-group query when Focused on a now-invisible group — the 'focused on group' shape", async () => {
      const { plan, logs } = await run(
        { user: { activeOrganizationId: "org-1" }, connectionId: "postgres", groupReach: "gone" },
        {},
        makeDeps({ visibleGroups: TWO_GROUPS }),
      );
      expect(plan.kind).toBe("reject");
      if (plan.kind === "reject") {
        expect(plan.error).toContain('focused on group "gone"');
        expect(plan.error).toContain("I will not query a");
      }
      // The focus-on-invisible reach warning is surfaced (not swallowed): it
      // explains WHY reach is empty rather than substituting another source.
      expect(logs.some((l) => l.message.includes('focus group "gone" is not visible'))).toBe(true);
    });

    it("rejects any group when the workspace has no reachable groups (degenerate — never falls through to default)", async () => {
      const { plan } = await run(
        { user: {} },
        { group: "postgres" },
        makeDeps({ visibleGroups: [] }),
      );
      expect(plan.kind).toBe("reject");
      if (plan.kind === "reject") expect(plan.error).toContain("none");
    });
  });

  it("binds an omitted-group query to the focused group's member (no `group` arg needed under Focus)", async () => {
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "postgres", groupReach: "clickhouse" },
      {},
      makeDeps({ visibleGroups: TWO_GROUPS }),
    );
    expect(plan.kind).toBe("single");
    if (plan.kind === "single") expect(plan.executionTarget.connectionId).toBe("clickhouse");
  });

  describe("multi-member group — member pinning via connectionId", () => {
    const MULTI: readonly VisibleGroup[] = [
      { id: "postgres", members: ["pg-eu", "pg-us"], primary: "pg-eu" },
      { id: "clickhouse", members: ["clickhouse"], primary: "clickhouse" },
    ];

    it("targets the group's primary when only `group` is given", async () => {
      const { plan } = await run(
        { user: { activeOrganizationId: "org-1" } },
        { group: "postgres" },
        makeDeps({ visibleGroups: MULTI }),
      );
      if (plan.kind === "single") expect(plan.executionTarget.connectionId).toBe("pg-eu");
      else throw new Error("expected single");
    });

    it("honors a `connectionId` that is a member of the targeted group", async () => {
      const { plan } = await run(
        { user: { activeOrganizationId: "org-1" } },
        { group: "postgres", connectionId: "pg-us" },
        makeDeps({ visibleGroups: MULTI }),
      );
      if (plan.kind === "single") expect(plan.executionTarget.connectionId).toBe("pg-us");
      else throw new Error("expected single");
    });

    it("IGNORES a foreign `connectionId` (member of another group) — falls back to primary, no cross-group escape", async () => {
      const { plan } = await run(
        { user: { activeOrganizationId: "org-1" } },
        { group: "postgres", connectionId: "clickhouse" },
        makeDeps({ visibleGroups: MULTI }),
      );
      if (plan.kind === "single") {
        expect(plan.executionTarget.connectionId).toBe("pg-eu");
        expect(plan.executionTarget.connectionId).not.toBe("clickhouse");
      } else throw new Error("expected single");
    });

    it("rejects a `group` that names a MEMBER id, not the canonical group", async () => {
      const { plan } = await run(
        { user: { activeOrganizationId: "org-1" } },
        { group: "pg-us" },
        makeDeps({ visibleGroups: MULTI }),
      );
      expect(plan.kind).toBe("reject");
    });
  });

  describe("member-selection cascade tail", () => {
    it("uses the raw `connectionId` arg as the member when no group and no stamped context", async () => {
      // All-sources, no named group → no reach lookup; the agent's own
      // `connectionId` arg is the member (second rung of the cascade).
      const { plan } = await run({ user: { activeOrganizationId: "org-1" } }, { connectionId: "arg-conn" }, makeDeps({}));
      expect(plan.kind).toBe("single");
      if (plan.kind === "single") expect(plan.executionTarget.connectionId).toBe("arg-conn");
    });

    it("falls through to the 'default' sentinel with no reqCtx and no ids (MCP / scheduler shape)", async () => {
      // No request context, no group, no connectionId → the whitelist-bucket
      // sentinel `"default"`, byte-identical to the whitelist accessors' own
      // param default. unpinned=false (no context ⇒ not the own connection).
      const { plan } = await run(undefined, {}, makeDeps({}));
      expect(plan.kind).toBe("single");
      if (plan.kind === "single") {
        expect(plan.executionTarget.connectionId).toBe("default");
        expect(plan.executionTarget.unpinned).toBe(false);
      }
    });
  });

  // The acceptance criterion asks for the reach ⊕ routing ⊕ whitelist-bucket
  // INTERACTION, not just each axis alone. This is the composition seam: reach
  // selects the group's member, that member feeds the routing lookup, and the
  // group fans out — the exact chain a composition-order regression would hit.
  describe("reach ⊕ routing interaction — named group + scope:'all' fans out the group's members", () => {
    it("a reach-selected multi-member group fans out, each leg its own (unpinned=false) target", async () => {
      const { plan } = await run(
        { user: { activeOrganizationId: "org-1" }, connectionId: "own-conn" },
        { group: "prod", scope: "all" },
        makeDeps({
          visibleGroups: [{ id: "prod", members: ["prod-eu", "prod-us"], primary: "prod-eu" }],
          // Routing is anchored on the reach-selected member (the group's
          // primary), and returns the group's full roster to fan out over.
          routing: () => ({
            members: ["prod-eu", "prod-us"],
            primaryMember: "prod-eu",
            currentMember: "prod-eu",
            degraded: false,
          }),
        }),
      );
      expect(plan.kind).toBe("fanout");
      if (plan.kind === "fanout") {
        expect(plan.legs.map((l) => l.connectionId)).toEqual(["prod-eu", "prod-us"]);
        expect(plan.fanoutReason).toBe("agent-all");
        // Neither leg IS the conversation's own connection ("own-conn"), so no
        // leg widens its whitelist bucket — the whole fanout is pinned.
        expect(plan.legs.every((l) => l.unpinned === false)).toBe(true);
      }
    });
  });
});

describe("resolveSqlExecutionPlan — #3961 whitelist-bucket (unpinned) derivation", () => {
  // The union-widening `unpinned` flag on the execution target must be TRUE
  // only for the conversation's OWN connection under All-sources reach, and
  // FALSE for every pinned member / sibling / named-group leg. This is the
  // exact flag that drifted in #3961 / #3947 / #3109 when derived twice.
  it("unpinned=true for the conversation's own connection under All-sources (the #3961 fix)", async () => {
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "own-conn" },
      {},
      makeDeps({}),
    );
    if (plan.kind === "single") {
      expect(plan.executionTarget.connectionId).toBe("own-conn");
      expect(plan.executionTarget.unpinned).toBe(true);
    } else throw new Error("expected single");
  });

  it("unpinned=false when a group is named (the leg is not the conversation's own connection)", async () => {
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "own-conn" },
      { group: "clickhouse" },
      makeDeps({ visibleGroups: TWO_GROUPS }),
    );
    if (plan.kind === "single") {
      expect(plan.executionTarget.connectionId).toBe("clickhouse");
      expect(plan.executionTarget.unpinned).toBe(false);
    } else throw new Error("expected single");
  });

  it("unpinned=false under Focus even for a single reachable group (reach is not 'all')", async () => {
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "postgres", groupReach: "postgres" },
      {},
      makeDeps({ visibleGroups: TWO_GROUPS }),
    );
    if (plan.kind === "single") expect(plan.executionTarget.unpinned).toBe(false);
    else throw new Error("expected single");
  });
});

describe("resolveSqlExecutionPlan — routing / fanout (scope ⊗ routingMode ⊗ members)", () => {
  const twoMemberRouting = (currentMember: string): GroupRoutingContext => ({
    members: ["m-a", "m-b"],
    primaryMember: "m-a",
    currentMember,
    degraded: false,
  });

  it("fast path: scope unset + routingMode auto → single, no routing lookup, no routing reason", async () => {
    let routingCalls = 0;
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "m-a" },
      {},
      makeDeps({ routing: twoMemberRouting, onLoadRouting: () => routingCalls++ }),
    );
    expect(routingCalls).toBe(0);
    expect(plan.kind).toBe("single");
    // The fast path runs no routing lookup, so it carries no routing reason —
    // a documented invariant of that branch.
    if (plan.kind === "single") expect(plan.routingReason).toBeUndefined();
  });

  it("scope 'all' fans out across every member, each leg with its own execution target", async () => {
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "m-a" },
      { scope: "all" },
      makeDeps({ routing: twoMemberRouting }),
    );
    expect(plan.kind).toBe("fanout");
    if (plan.kind === "fanout") {
      expect(plan.legs.map((l) => l.connectionId)).toEqual(["m-a", "m-b"]);
      expect(plan.fanoutReason).toBe("agent-all");
      // Under All-sources reach, only the leg that IS the conversation's own
      // connection (m-a) widens; the sibling (m-b) stays pinned. Per-leg, never
      // a single broadcast target (#3961).
      const byId = new Map(plan.legs.map((l) => [l.connectionId, l.unpinned]));
      expect(byId.get("m-a")).toBe(true);
      expect(byId.get("m-b")).toBe(false);
    }
  });

  it("picker routingMode 'all' overrides the agent's scope and fans out", async () => {
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "m-a", routingMode: "all" },
      { scope: "this" },
      makeDeps({ routing: twoMemberRouting }),
    );
    expect(plan.kind).toBe("fanout");
    if (plan.kind === "fanout") expect(plan.fanoutReason).toBe("picker-all");
  });

  it("picker routingMode 'pin' stays single against the current member, ignoring scope", async () => {
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "m-b", routingMode: "pin" },
      { scope: "all" },
      makeDeps({ routing: twoMemberRouting }),
    );
    expect(plan.kind).toBe("single");
    if (plan.kind === "single") {
      expect(plan.executionTarget.connectionId).toBe("m-b");
      expect(plan.routingReason).toBe("picker-pin");
    }
  });

  it("scope names a specific member → single against that member", async () => {
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "m-a" },
      { scope: "m-b" },
      makeDeps({ routing: twoMemberRouting }),
    );
    expect(plan.kind).toBe("single");
    if (plan.kind === "single") {
      expect(plan.executionTarget.connectionId).toBe("m-b");
      expect(plan.routingReason).toBe("agent-member");
    }
  });

  it("scope names an unknown member → single against the primary, with a surfaced warning", async () => {
    const { plan, logs } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "m-a" },
      { scope: "ghost" },
      makeDeps({ routing: twoMemberRouting }),
    );
    expect(plan.kind).toBe("single");
    if (plan.kind === "single") {
      expect(plan.executionTarget.connectionId).toBe("m-a");
      expect(plan.routingReason).toBe("fallback-current");
    }
    expect(logs.some((l) => l.message.includes('scope "ghost"'))).toBe(true);
  });

  // #4109 — a degraded routing lookup collapses to a 1×1 fallback ([currentMember]).
  // A fanout request must then safely degrade to single, never fan out against
  // phantom members the lookup couldn't confirm.
  it("#4109: scope 'all' with a degraded 1×1 routing context collapses to single, no phantom fanout", async () => {
    const { plan } = await run(
      { user: { activeOrganizationId: "org-1" }, connectionId: "m-a" },
      { scope: "all" },
      makeDeps({
        routing: (currentMember) => ({
          members: [currentMember],
          primaryMember: currentMember,
          currentMember,
          degraded: true,
        }),
      }),
    );
    expect(plan.kind).toBe("single");
    if (plan.kind === "single") {
      expect(plan.executionTarget.connectionId).toBe("m-a");
      expect(plan.routingReason).toBe("1x1-group");
    }
  });
});
