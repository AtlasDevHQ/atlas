/**
 * Single source of truth for the **execution target** of one SQL leg —
 * the (member/connection id, whitelist-widening flag) pair that both
 * `validateSQL` (table whitelist) and `executeSQL.execute` (routing +
 * execution) MUST agree on.
 *
 * Before this module, two places derived the "unpinned All-sources" notion
 * independently: `executeSQL.execute` decided the member across three axes
 * (reach ⊕ intra-group routing ⊕ per-turn `scope`), while `validateSQL`
 * SEPARATELY re-derived the same flag inline to feed the table whitelist.
 * That duplicated derivation is the root of #3961 / #3947 / #3109 — the two
 * copies could (and did) drift. This module extracts ONE pure function both
 * consume, so the whitelist bucket a query validates against can never
 * diverge from the member it executes against.
 *
 * The `unpinned` derivation is PURE over `(reqCtx, connectionId)`: it does no
 * IO and never throws. It reads reach through the canonical
 * {@link reachStateFromColumn} SSOT so "All sources" here cannot drift from
 * `executeSQL`'s reach gate (a falsy-but-non-null `groupReach` is "all",
 * which a bare `?? null` check would miss).
 *
 * @see ADR-0022 — cross-group reach + cross-source composition
 * @see issues #3961 / #3947 / #3109 — the drift regressions this SSOTs away
 */

import { reachStateFromColumn } from "@atlas/api/lib/group-reach";

export interface ExecutionTarget {
  /**
   * Resolved member/connection id this leg validates AND executes against
   * (post-reach, post-routing). A registered connection id, or `"default"`
   * for no-RequestContext / no-connectionId callers.
   */
  readonly connectionId: string;
  /**
   * Whitelist-bucket widening flag. TRUE only when reach is `"all"` AND
   * `connectionId` IS the conversation's own connection (`reqCtx.connectionId`).
   * Fed verbatim to `getOrgWhitelistedTables({ unpinned })`. Total, never
   * throws. FALSE for every pinned member, sibling pin, non-own fanout leg,
   * and no-context caller.
   */
  readonly unpinned: boolean;
  /** Optional: why it resolved this way (reach ⊕ routing reason); logs/audit only. */
  readonly reason?: string;
}

/**
 * Resolve the execution target for one SQL leg from the request context and
 * the POST-reach/post-routing connection id.
 *
 * ⚠ Callers MUST pass the resolved member id (`currentMember` /
 * `plan.connectionId` / the per-leg fanout `connId`) — NEVER the raw,
 * pre-reach `connectionId` argument of `executeSQL`. Feeding the pre-reach id
 * flips `unpinned` and leaks the union across sources (#3961). Fan-out legs
 * MUST resolve their OWN target per-leg; a single broadcast target across
 * legs is a regression.
 *
 * `connectionId` is `string | undefined` (not the plan's bare `string`) so
 * non-execute callers of `validateSQL` — which pass a possibly-undefined
 * connectionId — can share this SSOT. The `connectionId !== undefined` clause
 * of the derivation is thereby load-bearing, exactly as in the code this
 * replaces; passing `undefined` yields `unpinned: false` and a `"default"`
 * bucket id (byte-identical to the whitelist accessors' own `= "default"`
 * param default).
 */
export function resolveExecutionTarget(
  reqCtx: { readonly groupReach?: string | null; readonly connectionId?: string } | undefined,
  connectionId: string | undefined,
): ExecutionTarget {
  // The exact derivation this SSOTs away from `validateSQL`'s inline copy:
  // reach is "All sources" AND the lookup id IS the conversation's own
  // connection (never a sibling pin / non-own fanout leg).
  const unpinned =
    reachStateFromColumn(reqCtx?.groupReach).kind === "all" &&
    connectionId !== undefined &&
    connectionId === reqCtx?.connectionId;

  return {
    connectionId: connectionId ?? "default",
    unpinned,
    reason: unpinned ? "all-sources-self" : "pinned",
  };
}
