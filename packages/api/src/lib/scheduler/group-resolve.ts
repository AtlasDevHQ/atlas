import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("scheduler-group-resolve");

export interface SchedulerGroupMember {
  readonly id: string;
  readonly createdAt: Date | string;
}

export interface SchedulerGroupSnapshot {
  readonly groupId: string;
  readonly orgId: string | null;
  readonly primaryConnectionId: string | null;
  readonly members: readonly SchedulerGroupMember[];
}

function timestampToSortable(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export class NoScheduledTaskGroupMembersError extends Error {
  override readonly name = "NoScheduledTaskGroupMembersError";
  readonly groupId: string;
  readonly orgId: string | null;

  constructor(groupId: string, orgId: string | null) {
    super(`Connection group ${groupId} (org=${orgId ?? "__global__"}) has no members; scheduled task cannot resolve to a connection.`);
    this.groupId = groupId;
    this.orgId = orgId;
  }
}

export function selectScheduledTaskGroupMember(snapshot: SchedulerGroupSnapshot): string {
  if (snapshot.members.length === 0) {
    throw new NoScheduledTaskGroupMembersError(snapshot.groupId, snapshot.orgId);
  }

  if (snapshot.primaryConnectionId !== null) {
    const primary = snapshot.members.find((m) => m.id === snapshot.primaryConnectionId);
    if (primary) return primary.id;
    log.warn(
      {
        groupId: snapshot.groupId,
        orgId: snapshot.orgId,
        primaryConnectionId: snapshot.primaryConnectionId,
      },
      "Scheduled task group primary is missing — falling back to first member",
    );
  }

  const sorted = [...snapshot.members].sort((a, b) => {
    const aCreatedAt = timestampToSortable(a.createdAt);
    const bCreatedAt = timestampToSortable(b.createdAt);
    if (aCreatedAt !== bCreatedAt) return aCreatedAt < bCreatedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0].id;
}

export async function loadScheduledTaskGroupSnapshot(
  groupId: string,
  orgId: string | null,
): Promise<SchedulerGroupSnapshot | null> {
  if (!hasInternalDB()) return null;

  try {
    // Post-0096 cutover (#2744 / ADR-0007 pure-collapse): groups are
    // free-form JSONB strings in `workspace_plugins.config.group_id`,
    // with no separate `connection_groups` row and no `primary_connection_id`.
    // "Membership" is an aggregation over datasource installs sharing the
    // same `config->>'group_id'` in the workspace. `primaryConnectionId`
    // stays in the snapshot shape for back-compat but is always null —
    // `selectScheduledTaskGroupMember` falls through to the deterministic
    // sort, which is the only ordering left.
    //
    // Two-stage lookup preserves the pre-cutover "group not found" vs
    // "group has zero non-archived members" distinction (codex P2, #2784):
    //   1. Probe `EXISTS` across ALL statuses for any install carrying
    //      this group_id. Returning `null` only when truly absent
    //      preserves the upstream "group not found" hard error.
    //   2. Member query filters to non-archived rows. An empty result
    //      surfaces upstream as `NoScheduledTaskGroupMembersError` so
    //      the executor's empty-group handler (log + skip + actionable
    //      "add/unarchive a member" guidance) fires, not the generic
    //      "group not found" path.
    const existsRows = await internalQuery<{ exists_flag: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM workspace_plugins
          WHERE config->>'group_id' = $1
            AND workspace_id = $2
            AND pillar = 'datasource'
       ) AS exists_flag`,
      [groupId, orgId ?? "__global__"],
    );
    if (existsRows[0]?.exists_flag !== true) return null;

    const memberRows = await internalQuery<{ id: string; created_at: Date | string }>(
      `SELECT install_id AS id, installed_at AS created_at
         FROM workspace_plugins
        WHERE config->>'group_id' = $1
          AND workspace_id = $2
          AND pillar = 'datasource'
          AND status != 'archived'
        ORDER BY installed_at ASC, install_id ASC`,
      [groupId, orgId ?? "__global__"],
    );
    // #2416 — strictly in-org: no widening to '__global__'. An empty
    // member set surfaces upstream as NoScheduledTaskGroupMembersError
    // so the executor logs + skips the tick. The next admin action
    // (add a member, archive the task, unarchive a member) recovers.

    return {
      groupId,
      orgId,
      primaryConnectionId: null,
      members: memberRows.map((row) => ({ id: row.id, createdAt: timestampToSortable(row.created_at) })),
    };
  } catch (err) {
    log.error({ err: errorMessage(err), groupId, orgId }, "Failed to load scheduled task group snapshot");
    throw err;
  }
}

export async function resolveScheduledTaskConnection(opts: {
  readonly taskId: string;
  readonly orgId: string | null;
  readonly connectionGroupId: string | null;
}): Promise<string | null> {
  if (!opts.connectionGroupId) return null;

  const snapshot = await loadScheduledTaskGroupSnapshot(opts.connectionGroupId, opts.orgId);
  if (!snapshot) {
    throw new Error(`Connection group ${opts.connectionGroupId} for scheduled task ${opts.taskId} was not found.`);
  }
  return selectScheduledTaskGroupMember(snapshot);
}
