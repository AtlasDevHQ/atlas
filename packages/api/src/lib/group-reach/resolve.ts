/**
 * The **single** reach resolver both the advertised Source-catalog menu and
 * the enforcing `executeSQL` gate consume (ADR-0022).
 *
 * Before this module, two sites recomputed reach independently — the
 * Source-catalog builder (`source-catalog/lookup.ts`) narrowed the *menu* it
 * shows the agent, while `executeSQL`'s planner narrowed the *enforceable* set
 * it will actually run against — each calling `resolveReach(reachState,
 * loadVisibleGroups(orgId, mode))` on its own. Two copies of the same
 * derivation can drift, and "advertised ≠ enforceable" is exactly the class of
 * bug the group-reach feature exists to prevent (the agent must never see a
 * source on the menu it is then refused at execution, or vice versa).
 *
 * Folding both into one call makes "advertised == enforceable" hold by
 * construction: the same visible-groups lookup feeds the same pure
 * {@link resolveReach}, so the menu and the gate can only ever agree.
 *
 * This is the impure half of the `resolveReach` (pure) ⊕ `loadVisibleGroups`
 * (impure) split — it exists purely to bind the two together once.
 *
 * @see ADR-0022 — cross-group reach + Source catalog
 * @see issue #4350 — collapse the executeSQL planner; unify the two reach reads
 */

import { resolveReach, type ReachResult, type ReachState } from "./index";
import { loadVisibleGroups } from "./lookup";
import type { AtlasMode } from "@useatlas/types/auth";

/**
 * Resolve the reachable Connection groups for a workspace + content mode under
 * the conversation's reach state. `loadVisibleGroups` degrades to `[]` (no
 * workspace / whitelist load failure) rather than throwing, and
 * {@link resolveReach} is total, so this never throws — an empty reach set is a
 * valid, fully-degraded result the caller treats as "nothing reachable".
 */
export async function resolveReachableGroups(
  orgId: string | undefined,
  mode: AtlasMode | undefined,
  reachState: ReachState,
): Promise<ReachResult> {
  const visibleGroups = await loadVisibleGroups(orgId, mode);
  return resolveReach(reachState, visibleGroups);
}
