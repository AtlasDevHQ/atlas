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
    // Step 1 — find the connection's group_id (NULL means ungrouped).
    const connRows = await internalQuery<{ group_id: string | null }>(
      `SELECT group_id FROM connections
        WHERE id = $1
          AND (org_id = $2 OR org_id = '__global__')
          AND status != 'archived'
        LIMIT 1`,
      [currentConnectionId, orgId],
    );
    const groupId = connRows[0]?.group_id ?? null;
    if (!groupId) {
      return fallback;
    }

    // Step 2 — load every sibling connection in the same group + the
    // group's primary. Two cheap queries are simpler than one join
    // (and the connection_groups composite PK already includes org_id).
    const [memberRows, groupRows] = await Promise.all([
      internalQuery<{ id: string }>(
        `SELECT id FROM connections
          WHERE group_id = $1
            AND (org_id = $2 OR org_id = '__global__')
            AND status != 'archived'
          ORDER BY id`,
        [groupId, orgId],
      ),
      internalQuery<{ primary_connection_id: string | null }>(
        `SELECT primary_connection_id FROM connection_groups
          WHERE id = $1
            AND org_id = $2
          LIMIT 1`,
        [groupId, orgId],
      ),
    ]);

    const members = memberRows.map((r) => r.id);
    const primaryFromGroup = groupRows[0]?.primary_connection_id ?? null;
    const primaryMember = primaryFromGroup && members.includes(primaryFromGroup)
      ? primaryFromGroup
      : (members[0] ?? currentConnectionId);

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
