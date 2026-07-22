/**
 * The pure `executeSQL` execution **planner** (#4350).
 *
 * `executeSQL` composes four individually-deep, well-tested pure resolvers —
 * reach ({@link resolveReach}), intra-group routing ({@link resolveRoutingPlan}),
 * per-leg execution-target derivation ({@link resolveExecutionTarget}), and
 * member-result merge (`mergeMemberResults`) — but the ~150-line chain that
 * WIRES them used to live inline in the tool's `execute` closure, re-reading the
 * request context twice (the closure itself and again inside the fanout).
 *
 * That untested wiring is where the bugs lived. #3961 — a fanout leg
 * broadcasting one member's whitelist bucket onto its siblings — is a
 * composition-order bug this module fixes directly, by resolving each leg's
 * execution target from ITS OWN id. #3867(b) — no silent re-route of an
 * out-of-reach target — becomes a first-class `reject` value here. The related
 * whitelist-bucket drift of #3947 / #3109 was SSOT'd away in
 * {@link resolveExecutionTarget} itself; the planner's job is to feed it the
 * correct post-reach/post-routing id (never the raw arg), not to re-derive the
 * bucket. (The degraded-routing *certainty* fix of #4109 lives in the routing
 * lookup + `metric-run`, NOT here — the planner never reads `degraded`; it only
 * inherits the safe collapse a 1×1/degraded routing context already implies: a
 * fanout request turns into a single leg, never a fan-out across phantom
 * members the lookup could not confirm.)
 *
 * This module folds the wiring into one place. Given the request context and
 * the tool args, it resolves the whole cascade —
 *
 *   reach gate → group-target member → current member → routing-mode
 *   fast-path → routing plan → per-leg execution target
 *
 * — and returns a discriminated {@link SqlExecutionPlan}: a hard `reject`
 * (out-of-reach, never a silent re-route), a `single` leg, or a `fanout` across
 * pre-resolved per-leg {@link ExecutionTarget}s. The tool's `execute` then only
 * runs the leg(s) and merges — no orchestration decisions of its own.
 *
 * **Read-once.** The caller reads `getRequestContext()` a single time and hands
 * it in; the planner derives `orgId`, reach, member, and every per-leg
 * execution target from that one snapshot (closing the "reqCtx read twice"
 * leak — execute closure + fanout re-read — and, via
 * {@link resolveReachableGroups}, the "reach resolved twice" leak between the
 * advertised menu and this enforcing gate).
 *
 * **Testable without a DB.** The two impure lookups (visible groups for reach,
 * group members for routing) are injected as {@link SqlExecutionPlanDeps}, so a
 * table-driven test drives the full `(reachState, group, scope, routingMode,
 * members)` interaction with plain in-memory stand-ins — no `mock.module`, no
 * fake Postgres. The prior shipped regressions are expressible against this
 * planner directly.
 *
 * @see ADR-0022 — cross-group reach + cross-source composition
 * @see ADR-0010 — environment scoping / execution target
 * @see packages/api/src/lib/group-reach/execution-target.ts — the SSOT this extends
 */

import {
  isReachable,
  reachStateFromColumn,
  type ReachResult,
  type ReachState,
} from "@atlas/api/lib/group-reach";
import { resolveReachableGroups } from "@atlas/api/lib/group-reach/resolve";
import { ROUTING_MODE_WITHOUT_CONVERSATION } from "@atlas/api/lib/conversation-scope";
import {
  resolveExecutionTarget,
  type ExecutionTarget,
} from "@atlas/api/lib/group-reach/execution-target";
import {
  resolveRoutingPlan,
  type RoutingMode,
  type RoutingReason,
} from "@atlas/api/lib/env-routing";
import {
  loadGroupRoutingContext,
  type GroupRoutingContext,
} from "@atlas/api/lib/env-routing/lookup";
import type { AtlasMode } from "@useatlas/types/auth";

/**
 * The subset of `RequestContext` the planner reads. A structural subset (not
 * the full type) so callers — and tests — hand in exactly what the cascade
 * needs. Compatible with `resolveExecutionTarget`'s `{ groupReach, connectionId }`
 * argument, which the planner threads verbatim.
 */
export interface PlanRequestContext {
  /** Persisted `conversations.group_reach` → {@link ReachState}. `null`/undefined = All sources. */
  readonly groupReach?: string | null;
  /** Per-turn execution target stamped by the chat route. The "conversation's own connection". */
  readonly connectionId?: string;
  /** Resolved content mode; scopes the visible-groups whitelist lookup. */
  readonly atlasMode?: AtlasMode;
  /** Three-state Auto/Pin/All picker. Undefined (non-chat callers) → `"auto"`. */
  readonly routingMode?: RoutingMode;
  /** Active workspace; scopes both impure lookups. */
  readonly user?: { readonly activeOrganizationId?: string };
}

/** The `executeSQL` tool args the planner routes on. */
export interface SqlExecutionPlanArgs {
  /** Agent-named target Connection group (cross-group reach). Omitted → conversation's current group. */
  readonly group?: string;
  /** Agent-named specific member within the targeted group. */
  readonly connectionId?: string;
  /** Cross-environment routing override ("this" / "all" / a member id). */
  readonly scope?: string;
}

/**
 * A single structured log the caller emits (`log.warn(fields, message)`).
 * The planner never logs itself — it returns the operational signals (reach
 * warnings, the out-of-reach rejection, routing fallbacks) so the pure
 * cascade stays free of an injected logger, and the caller keeps one log seam.
 */
export interface PlanLog {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

/**
 * The discriminated execution plan. `execute` switches on `kind`:
 *   - `reject` → return `{ success: false, error }` (no query runs).
 *   - `single` → run one leg against `executionTarget`.
 *   - `fanout` → run every `leg` and merge; each leg carries its OWN
 *     execution target (never a single broadcast target across legs — that
 *     would leak one leg's whitelist bucket onto the others, #3961).
 */
export type SqlExecutionPlan =
  | { readonly kind: "reject"; readonly error: string }
  | {
      readonly kind: "single";
      /**
       * Whitelist-bucket + execution target for this leg (fed to `validateSQL`
       * + execution). Its `connectionId` IS the resolved member to run against
       * (post-reach, post-routing) — the single source for the leg's id, so a
       * separate `connId` field (which could drift from it) is deliberately not
       * carried; the fanout variant likewise derives ids from its `legs`.
       */
      readonly executionTarget: ExecutionTarget;
      /** Picker mode threaded to the pipeline for observability. */
      readonly routingMode: RoutingMode;
      /** Why routing picked this leg. Undefined on the fast path (no routing lookup ran). */
      readonly routingReason?: RoutingReason;
    }
  | {
      readonly kind: "fanout";
      /** Per-leg execution targets (order = fanout output order). Each resolved from ITS own id. */
      readonly legs: readonly ExecutionTarget[];
      /** Why the fanout was chosen (`agent-all` / `picker-all`). */
      readonly fanoutReason: RoutingReason;
    };

export interface SqlExecutionPlanResult {
  readonly plan: SqlExecutionPlan;
  /** Structured logs for the caller to emit. Empty on a clean resolution. */
  readonly logs: readonly PlanLog[];
}

/**
 * Injected impure lookups. Defaults wire the real DB-backed resolvers; tests
 * pass in-memory stand-ins so the whole `(reachState, group, scope,
 * routingMode, members)` table runs without a mocked DB.
 */
export interface SqlExecutionPlanDeps {
  readonly resolveReachableGroups: (
    orgId: string | undefined,
    mode: AtlasMode | undefined,
    reachState: ReachState,
  ) => Promise<ReachResult>;
  readonly loadGroupRoutingContext: (
    orgId: string | undefined,
    currentMember: string,
  ) => Promise<GroupRoutingContext>;
}

const defaultDeps: SqlExecutionPlanDeps = {
  resolveReachableGroups,
  loadGroupRoutingContext,
};

/**
 * Resolve the full `executeSQL` execution plan from one request-context
 * snapshot and the tool args. Never throws — the injected lookups degrade
 * rather than fault, and every branch returns a plan (`reject` included).
 *
 * The cascade, in order:
 *   1. **Reach gate** — when the agent names a `group` OR the conversation is
 *      Focused, resolve the reachable groups (shared with the catalog menu)
 *      and reject any out-of-reach target. Under All-sources with no named
 *      group we skip the lookup entirely (no per-query DB cost on the common
 *      default path).
 *   2. **Member selection** — the group's pinned/primary member, else the raw
 *      `connectionId`, else the conversation's own connection, else `"default"`.
 *   3. **Fast path** — when no scope override and the picker isn't fanning out,
 *      a single leg against the current member (no routing lookup).
 *   4. **Routing** — otherwise load the group's members and run
 *      {@link resolveRoutingPlan}; a `single` plan → one leg, a `fanout` plan →
 *      per-leg targets resolved from each member id.
 */
export async function resolveSqlExecutionPlan(
  reqCtx: PlanRequestContext | undefined,
  args: SqlExecutionPlanArgs,
  deps: SqlExecutionPlanDeps = defaultDeps,
): Promise<SqlExecutionPlanResult> {
  const { group, connectionId, scope } = args;
  const logs: PlanLog[] = [];
  const orgId = reqCtx?.user?.activeOrganizationId;

  // --- 1. Reach gate (ADR-0022). Only resolved when the agent names a `group`
  // or the conversation is Focused; under `all` with no named group every
  // group is reachable, so we skip the lookup and the legacy single-connection
  // path stands (no per-query DB cost on the common default case). ---
  const reachState = reachStateFromColumn(reqCtx?.groupReach);
  let groupTargetMember: string | undefined;
  if (group !== undefined || reachState.kind === "focus") {
    const reach = await deps.resolveReachableGroups(orgId, reqCtx?.atlasMode, reachState);
    // A `focus`-on-invisible resolution explains (via a warning) why reach is
    // empty rather than substituting another source; surface it so the
    // divergence is observable. Under `all` warnings is always [].
    for (const w of reach.warnings) {
      logs.push({ message: w, fields: { group, groupReach: reqCtx?.groupReach, orgId } });
    }
    // The group this query targets: the agent's explicit `group`, else — under
    // Focus — the single focused group. (Under `all` with no explicit group we
    // don't enter this branch.)
    const targetGroupId =
      group ?? (reachState.kind === "focus" ? reach.reachableGroups[0]?.id : undefined);
    if (targetGroupId === undefined || !isReachable(reach, targetGroupId)) {
      const reachable = reach.reachableGroups.map((g) => g.id);
      logs.push({
        message: "executeSQL rejected an out-of-reach group target — not re-routing",
        fields: { group, groupReach: reqCtx?.groupReach, orgId, reachable },
      });
      // Two shapes: the agent named an out-of-reach group, OR the conversation
      // is Focused on a group that isn't currently reachable (content-mode hid
      // it, or it was removed). Either way we refuse to substitute another
      // source — the no-substitution invariant the whole feature rests on.
      const error =
        group === undefined && reachState.kind === "focus"
          ? `This conversation is focused on group "${reachState.groupId}", which is not ` +
            `currently reachable (visible groups: ${reachable.join(", ") || "none"}). ` +
            `The focused source may be unpublished or removed — I will not query a ` +
            `different source instead. Widen the conversation's scope to All sources to query elsewhere.`
          : `Connection group "${group}" is not within this conversation's reach ` +
            `(reachable groups: ${reachable.join(", ") || "none"}). ` +
            `I will not query a different source instead — re-run against a reachable ` +
            `group, or omit \`group\` to use the conversation's current source.`;
      return { plan: { kind: "reject", error }, logs };
    }
    // Resolve the group to a connection to execute against: the group's
    // primary member (a group-of-one resolves to its own connection id).
    // `connectionId`, if also supplied, may pin a specific member of THIS
    // group; otherwise the group's primary is used. The per-group whitelist
    // resolves via this connection id (members register their group's tables).
    const target = reach.reachableGroups.find((g) => g.id === targetGroupId);
    groupTargetMember =
      connectionId && target?.members.includes(connectionId)
        ? connectionId
        : target?.primary;
  }

  // --- 2. Member selection. Post-reach member → agent's raw connectionId →
  // conversation's own connection → the "default" sentinel. ---
  const currentMember =
    groupTargetMember ?? connectionId ?? reqCtx?.connectionId ?? "default";

  // #2518 — three-state picker. Undefined here means the caller never went
  // through the chat route (tools / MCP / scheduler / unit tests), i.e. there
  // is no conversation and therefore no `routing_mode` column to decode, where
  // the legacy "agent decides" semantics are the right answer. #4351 — this is
  // deliberately NOT the NULL-column default (`routingModeFromColumn` → 'pin');
  // both constants live side by side in `lib/conversation-scope.ts` with the
  // rationale for why the two questions get different answers.
  const routingMode = reqCtx?.routingMode ?? ROUTING_MODE_WITHOUT_CONVERSATION;

  // --- 3. Fast path — only when EVERY override path collapses to "single
  // execution against currentMember": the agent emitted no scope (or "this")
  // AND the picker is not the fanout case ('all'). 'pin' also collapses to
  // single (pin always routes to currentMember), so it keeps the fast path;
  // 'auto' with no agent scope is the legacy single-env shape. No routing DB
  // lookup on this path. ---
  if ((scope === undefined || scope === "this") && routingMode !== "all") {
    return {
      plan: {
        kind: "single",
        // Resolve the target from the POST-reach/post-routing member id
        // (`currentMember`) — NEVER the raw `connectionId` arg — so the
        // whitelist bucket matches what we execute against (risk guard #1).
        // The target's `connectionId` IS `currentMember`.
        executionTarget: resolveExecutionTarget(reqCtx, currentMember),
        routingMode,
      },
      logs,
    };
  }

  // --- 4. Routing path: the agent asked for fanout / a specific member, or
  // the picker is pinning 'all' (overrides the agent's scope regardless of
  // value). Load the active group's members + primary, then run the pure
  // routing module. Failures collapse to a 1×1 fallback inside the lookup so
  // the tool call still returns a useful result. ---
  const ctx = await deps.loadGroupRoutingContext(orgId, currentMember);
  const { plan, warnings } = resolveRoutingPlan({
    agentScope: scope,
    currentMember: ctx.currentMember,
    members: ctx.members,
    primaryMember: ctx.primaryMember,
    pickerMode: routingMode,
  });
  for (const w of warnings) {
    logs.push({ message: w, fields: { connectionId: currentMember, scope, plan: plan.kind } });
  }

  if (plan.kind === "single") {
    return {
      plan: {
        kind: "single",
        // Post-routing member id (`plan.connectionId`), not the raw arg; it
        // becomes the target's `connectionId`.
        executionTarget: resolveExecutionTarget(reqCtx, plan.connectionId),
        routingMode,
        routingReason: plan.reason,
      },
      logs,
    };
  }

  // Fanout: each leg resolves its OWN execution target from ITS connection id
  // — a leg whose id IS the conversation's own connection under All-sources
  // reach derives `unpinned: true`; sibling legs derive `false`. A single
  // broadcast target across legs would leak one leg's whitelist bucket onto
  // the others (#3961), so the derivation is strictly per-leg.
  return {
    plan: {
      kind: "fanout",
      legs: plan.connectionIds.map((connId) => resolveExecutionTarget(reqCtx, connId)),
      fanoutReason: plan.reason,
    },
    logs,
  };
}
