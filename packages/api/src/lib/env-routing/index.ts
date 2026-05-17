/**
 * Pure routing module for the agent-decided cross-environment `executeSQL`
 * `scope` parameter (PRD #2515, slice 1 #2516).
 *
 * Takes the agent's `scope` hint, the conversation's per-turn override
 * ("pinned to <member>" / "all envs" / "auto"), and the active connection
 * group's member list, and returns a `RoutingPlan` describing whether the
 * SQL should execute against one member (`single`) or fan out across many
 * (`fanout`). The caller wires the plan into `executeSQL`'s pipeline.
 *
 * **Pure.** No DB, no IO, no fetch. The caller resolves the active group +
 * members from `internalQuery` (or wherever) and hands them in. This makes
 * the routing table exhaustively unit-testable and decouples the routing
 * policy from the executeSQL plumbing.
 *
 * Policy summary:
 *
 *   - 1×1 group (one member) → always single. Routing flags are ignored —
 *     fanout is structurally meaningless and the picker stays hidden.
 *   - Picker mode `pin` (slice 3) → single against `currentMember`. Agent's
 *     scope hint is ignored because the user pre-chose the target.
 *   - Picker mode `all` (slice 3) → fanout across every member. Agent's
 *     scope hint is ignored because the user pre-chose "every env".
 *   - Picker mode `auto` (default, slice 1) → agent decides:
 *       - `scope: "all"` → fanout
 *       - `scope: "this"` or unset → single against `currentMember`
 *       - `scope: "<member id>"` → single against that member
 *       - `scope: "<unknown id>"` → single against `primaryMember ??
 *         currentMember`, with a warning surfaced for the agent / log.
 *
 * Slice 1 invokes this with `pickerMode` unset / "auto" — the pin/all
 * cases land in slice 3 alongside the picker UI and the conversation
 * `routing_mode` column. Both branches are already covered by the unit
 * tests so slice 3 picks up a verified routing policy.
 *
 * @see PRD #2515 — agent-routed cross-environment querying
 * @see issue #2516 — slice 1 acceptance criteria
 */

/** Sentinel column name prepended to the merged result; mirrors `__demo__` / `__global__`. */
export const ENV_COLUMN = "__env__" as const;

/** Per-conversation routing override. Slice 3 wires this to `conversations.routing_mode`. */
export type RoutingMode = "auto" | "pin" | "all";

/** Agent-emitted scope hint on the `executeSQL` tool call. */
export type AgentScope = "this" | "all" | (string & {});

/** Inputs to {@link resolveRoutingPlan}. All fields readonly; the module is pure. */
export interface RoutingInput {
  /** Agent's `scope` argument on `executeSQL`. Undefined means the agent did not set one. */
  readonly agentScope?: AgentScope;
  /**
   * Conversation's currently-selected member. Resolved by the caller from
   * the per-turn override → conversation's stored `connection_id` →
   * group's `primary_connection_id`. Always a registered connection id.
   */
  readonly currentMember: string;
  /**
   * Every member of the active connection group (or `[currentMember]` for
   * the 1×1 case / no group). Order matters for the fanout output.
   */
  readonly members: readonly string[];
  /**
   * Group's primary member. Used as the fallback target when the agent
   * names an unknown member id. Defaults to `currentMember` if omitted.
   */
  readonly primaryMember?: string;
  /** Picker override. Defaults to `"auto"`. Slice 3 passes through. */
  readonly pickerMode?: RoutingMode;
}

/** Discriminator for why the planner picked the plan it did. Surfaced to logs / audit. */
export type RoutingReason =
  | "1x1-group"
  | "picker-pin"
  | "picker-all"
  | "agent-all"
  | "agent-member"
  | "agent-this"
  | "fallback-current";

export type RoutingPlan =
  | {
      readonly kind: "single";
      readonly connectionId: string;
      readonly reason: RoutingReason;
    }
  | {
      readonly kind: "fanout";
      readonly connectionIds: readonly string[];
      readonly reason: RoutingReason;
    };

export interface RoutingResult {
  readonly plan: RoutingPlan;
  /** Warnings to surface in logs / tool output. Empty when the plan is a clean win. */
  readonly warnings: readonly string[];
}

/**
 * Resolve a {@link RoutingPlan} from the routing inputs. Pure; safe to call
 * any number of times on the same input.
 *
 * The function is total — every input shape produces a plan. Invalid agent
 * scopes (string ids not in `members`) fall back to a single execution
 * against the primary member and surface a warning so callers can log /
 * audit the divergence.
 */
export function resolveRoutingPlan(input: RoutingInput): RoutingResult {
  const warnings: string[] = [];
  const pickerMode: RoutingMode = input.pickerMode ?? "auto";

  // Defensive — caller should pass at least `[currentMember]`; we tolerate
  // an empty array by treating it as a 1×1 group around currentMember.
  const members =
    input.members.length === 0 ? [input.currentMember] : input.members;
  const primary = input.primaryMember ?? input.currentMember;

  // 1×1 group: fanout is structurally meaningless. Agent / picker hints are
  // ignored — the only available member is the answer.
  if (members.length <= 1) {
    return {
      plan: {
        kind: "single",
        connectionId: members[0] ?? input.currentMember,
        reason: "1x1-group",
      },
      warnings,
    };
  }

  // Picker override wins over the agent's hint for multi-member groups.
  if (pickerMode === "pin") {
    return {
      plan: {
        kind: "single",
        connectionId: input.currentMember,
        reason: "picker-pin",
      },
      warnings,
    };
  }
  if (pickerMode === "all") {
    return {
      plan: {
        kind: "fanout",
        connectionIds: members,
        reason: "picker-all",
      },
      warnings,
    };
  }

  // Auto: agent decides.
  const scope = input.agentScope;
  if (scope === "all") {
    return {
      plan: { kind: "fanout", connectionIds: members, reason: "agent-all" },
      warnings,
    };
  }
  if (scope === undefined || scope === "this") {
    return {
      plan: {
        kind: "single",
        connectionId: input.currentMember,
        reason: "agent-this",
      },
      warnings,
    };
  }
  // Named member id.
  if (members.includes(scope)) {
    return {
      plan: { kind: "single", connectionId: scope, reason: "agent-member" },
      warnings,
    };
  }
  // Unknown member id — fall back, warn loudly so the agent's mistake is
  // observable in audit. Returning a 500 here would hard-fail a tool call
  // whose recovery path is "run against the conversation's pinned member,"
  // so we degrade rather than abort.
  warnings.push(
    `agent scope "${scope}" did not match any member of the active group (members: ${members.join(", ")}) — falling back to primary "${primary}"`,
  );
  return {
    plan: {
      kind: "single",
      connectionId: primary,
      reason: "fallback-current",
    },
    warnings,
  };
}
