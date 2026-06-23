/**
 * Pure cross-group **reach** resolver (ADR-0022, keystone slice (a) #3893).
 *
 * Reach is a new axis *above* the `env-routing/` Member planner: it decides
 * **which Connection groups** a conversation may query, where the Member
 * planner decides **which Member within a group** a query hits. The two are
 * deliberately separate modules — reach (cross-group) and routing
 * (intra-group) are distinct axes and must not be folded together (ADR-0022
 * §1; PRD #3892 "Implementation Decisions").
 *
 * Given the conversation's reach state and the workspace's **visible** groups
 * (already filtered by content-mode / RLS / whitelist by the caller — see
 * `./lookup.ts`), this resolves the set of **reachable** groups:
 *
 *   - `all`  → every visible group (the default; the agent ranges cross-group
 *              and the picker that narrows to Focus lands in slice (c)).
 *   - `focus`→ exactly the named group **iff it is visible**, else **empty**.
 *              An out-of-reach focus resolves to *nothing* — it is **never**
 *              silently substituted with another group. That no-substitution
 *              invariant is the security property the whole feature rests on
 *              (the #3867(b) fix): the agent must not be able to reach a
 *              source the conversation's scope excludes.
 *
 * **Pure.** No DB, no IO. The caller resolves `visibleGroups` (impure, see
 * `loadVisibleGroups` in `./lookup.ts`) and hands them in, making the reach
 * policy exhaustively unit-testable and decoupled from the executeSQL
 * plumbing — exactly the shape `resolveRoutingPlan` already uses.
 *
 * @see ADR-0022 — cross-group reach + cross-source composition
 * @see issue #3893 — slice (a) acceptance criteria
 */

/**
 * Per-conversation Group-reach value.
 *
 * Slice (a) always passes `{ kind: "all" }` — the picker / conversation-scope
 * persistence that produces a `focus` state lands in slice (c). The `focus`
 * branch is built and tested now so the bound is enforced from day one and
 * slice (c) inherits a verified resolver.
 */
export type ReachState =
  | { readonly kind: "all" }
  | { readonly kind: "focus"; readonly groupId: string };

/**
 * Map a persisted `conversations.group_reach` column value to a {@link ReachState}
 * (slice (c) #3895). `null` / `undefined` (the column default) → `all`; a
 * non-empty `connection_group_id` → `focus` on that group.
 *
 * Pure + total. Centralises the column ↔ state encoding so the chat route, the
 * `executeSQL` reach bound, and the Source-catalog narrowing all read the
 * conversation's reach the same way — the column is the single wire/DB
 * representation and this is the single decoder.
 */
export function reachStateFromColumn(value: string | null | undefined): ReachState {
  return value ? { kind: "focus", groupId: value } : { kind: "all" };
}

/**
 * A Connection group the workspace can see, as resolved by the impure
 * `loadVisibleGroups` lookup. `id` is the canonical `connection_group_id`
 * (a group-of-one standalone datasource uses its own connection id as its
 * group id — #3855). `members` / `primary` carry the connection(s) the
 * caller routes execution to; the resolver itself reads only `id`.
 */
export interface VisibleGroup {
  /** Canonical group id (group-of-one: equal to the connection id). */
  readonly id: string;
  /** Member connection ids of this group (always ≥ 1). */
  readonly members: readonly string[];
  /** Representative connection id execution routes to by default. */
  readonly primary: string;
}

/** Why the resolver returned the reach set it did. Surfaced to logs / audit. */
export type ReachReason = "all-visible" | "focus-resolved" | "focus-invisible";

export interface ReachResult {
  /** The reachable groups, intact (members + primary preserved). */
  readonly reachableGroups: readonly VisibleGroup[];
  /** Discriminator for why this reach set was chosen. */
  readonly reason: ReachReason;
  /**
   * Warnings to surface in logs / audit. Empty for a clean resolution; a
   * Focus that names an invisible/unknown group emits one so the divergence
   * is observable rather than silently collapsing to empty reach.
   */
  readonly warnings: readonly string[];
}

/**
 * Resolve the reachable Connection groups from a reach state + the visible
 * groups. Pure; total — every input shape produces a result, never throws.
 *
 * Critically, a `focus` on a group that is not in `visibleGroups` resolves
 * to an **empty** reach set with a warning — it does **not** fall back to any
 * other group. Callers must treat empty reach as "nothing reachable," never
 * as "use the default."
 */
export function resolveReach(
  state: ReachState,
  visibleGroups: readonly VisibleGroup[],
): ReachResult {
  if (state.kind === "all") {
    return {
      reachableGroups: visibleGroups,
      reason: "all-visible",
      warnings: [],
    };
  }

  // Focus: exactly the named group, iff visible. No substitution.
  const match = visibleGroups.find((grp) => grp.id === state.groupId);
  if (match) {
    return {
      reachableGroups: [match],
      reason: "focus-resolved",
      warnings: [],
    };
  }

  return {
    reachableGroups: [],
    reason: "focus-invisible",
    warnings: [
      `focus group "${state.groupId}" is not visible to this workspace ` +
        `(visible: ${visibleGroups.map((grp) => grp.id).join(", ") || "none"}) ` +
        `— reach is empty; not substituting another source`,
    ],
  };
}

/**
 * Whether `groupId` is within a resolved reach set. Matches by **canonical
 * group id** only — a member connection id is not its group, so naming a
 * Member where a Group is expected is (correctly) not reachable.
 */
export function isReachable(result: ReachResult, groupId: string): boolean {
  return result.reachableGroups.some((grp) => grp.id === groupId);
}
