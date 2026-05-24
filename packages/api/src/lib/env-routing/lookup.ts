/**
 * Impure helper that fetches the routing inputs (active group's members +
 * primary) for the agent-decided `executeSQL` `scope` parameter.
 *
 * Lives alongside the pure {@link resolveRoutingPlan} module but stays in
 * its own file so the routing logic is testable without a DB. Slice 1
 * wires this from `executeSQL` for the `scope` case only — when the agent
 * omits `scope` or asks for the conversation's current member, the
 * existing single-env path runs without invoking the lookup (zero new
 * DB calls on the hot path for back-compat).
 *
 * Returns `{ members: [currentConnectionId] }` (a 1×1 result) whenever
 * the internal DB isn't configured or the connection has no group — both
 * cases mean fanout is structurally impossible, and the caller should
 * treat the result like a single-member group.
 *
 * @see PRD #2515 — agent-routed cross-environment querying
 * @see issue #2516 — slice 1 acceptance criteria
 */

import { internalQuery, hasInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("env-routing:lookup");

export interface GroupRoutingContext {
  /** Active group id. Undefined when the connection is not in a group or the internal DB is offline. */
  readonly groupId?: string;
  /** Every member of the active group (in deterministic id order). Always non-empty — defaults to `[currentMember]` for the 1×1 case. */
  readonly members: readonly string[];
  /** Group primary, used as fallback. Defaults to `currentMember` when no group is found. */
  readonly primaryMember: string;
  /** The connection id this lookup was anchored on (echoed for caller convenience). */
  readonly currentMember: string;
}

/**
 * Resolve the active group's members + primary for the supplied
 * connection id. Never throws — every failure mode collapses to a 1×1
 * result so the caller can treat the routing as a single execution.
 */
export async function loadGroupRoutingContext(
  orgId: string | undefined,
  currentConnectionId: string,
): Promise<GroupRoutingContext> {
  const fallback: GroupRoutingContext = {
    members: [currentConnectionId],
    primaryMember: currentConnectionId,
    currentMember: currentConnectionId,
  };

  if (!orgId || !hasInternalDB()) {
    return fallback;
  }

  try {
    // Post-0096 cutover (#2744 / ADR-0007 pure-collapse): groups are
    // free-form JSONB strings in `workspace_plugins.config.group_id` with
    // no separate `connection_groups` row and no `primary_connection_id`.
    // Step 1 — find the install's group_id (NULL means ungrouped).
    const connRows = await internalQuery<{ group_id: string | null }>(
      `SELECT config->>'group_id' AS group_id FROM workspace_plugins
        WHERE install_id = $1
          AND (workspace_id = $2 OR workspace_id = '__global__')
          AND pillar = 'datasource'
          AND status != 'archived'
        LIMIT 1`,
      [currentConnectionId, orgId],
    );
    const groupId = connRows[0]?.group_id ?? null;
    if (!groupId) {
      // Distinguish "install ungrouped" (expected for legacy 1×1
      // installs) from "install not found / archived" (suspect — the
      // agent rendered a multi-member prompt but the runtime sees no
      // matching row, so the agent's `scope: "all"` is silently
      // downgraded to single-env). Log loudly per CLAUDE.md "Never
      // silently swallow errors".
      const reason = connRows.length === 0 ? "connection-not-found" : "connection-ungrouped";
      log.warn(
        { orgId, currentConnectionId, reason },
        "Group routing context degraded to 1×1 — agent's scope hint may be silently downgraded",
      );
      return fallback;
    }

    // Step 2 — load every sibling install sharing the same JSONB
    // group_id. No primary lookup post-cutover; deterministic
    // alphabetical sort by install_id picks the fallback primary.
    const memberRows = await internalQuery<{ id: string }>(
      `SELECT install_id AS id FROM workspace_plugins
        WHERE config->>'group_id' = $1
          AND (workspace_id = $2 OR workspace_id = '__global__')
          AND pillar = 'datasource'
          AND status != 'archived'
        ORDER BY install_id`,
      [groupId, orgId],
    );

    const members = memberRows.map((r) => r.id);
    const primaryMember = members[0] ?? currentConnectionId;

    return {
      groupId,
      members: members.length > 0 ? members : [currentConnectionId],
      primaryMember,
      currentMember: currentConnectionId,
    };
  } catch (err) {
    // Routing-lookup failure must not hard-fail the whole tool call —
    // we can still run the single-env path. Log loudly so the operator
    // sees the divergence (per CLAUDE.md "Never silently swallow errors").
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId, currentConnectionId },
      "Failed to resolve group routing context — falling back to single-env execution",
    );
    return fallback;
  }
}
