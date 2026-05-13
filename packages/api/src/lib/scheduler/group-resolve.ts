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
    const groupRows = await internalQuery<{ primary_connection_id: string | null }>(
      `SELECT primary_connection_id
         FROM connection_groups
        WHERE id = $1 AND org_id = $2`,
      [groupId, orgId ?? "__global__"],
    );
    if (groupRows.length === 0) return null;
    let primaryConnectionId = groupRows[0]?.primary_connection_id ?? null;

    let memberRows = await internalQuery<{ id: string; created_at: Date | string }>(
      `SELECT id, created_at
         FROM connections
        WHERE group_id = $1
          AND org_id = $2
          AND status != 'archived'
        ORDER BY created_at ASC, id ASC`,
      [groupId, orgId ?? "__global__"],
    );
    if (memberRows.length === 0 && orgId !== null && orgId !== "__global__") {
      const globalRows = await Promise.all([
        primaryConnectionId === null
          ? internalQuery<{ primary_connection_id: string | null }>(
            `SELECT primary_connection_id
               FROM connection_groups
              WHERE id = $1 AND org_id = '__global__'`,
            [groupId],
          )
          : Promise.resolve([]),
        internalQuery<{ id: string; created_at: Date | string }>(
          `SELECT id, created_at
           FROM connections
          WHERE group_id = $1
            AND org_id = '__global__'
            AND status != 'archived'
          ORDER BY created_at ASC, id ASC`,
          [groupId],
        ),
      ]);
      primaryConnectionId = primaryConnectionId ?? globalRows[0][0]?.primary_connection_id ?? null;
      memberRows = globalRows[1];
    }

    return {
      groupId,
      orgId,
      primaryConnectionId,
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
  readonly legacyConnectionId: string | null;
}): Promise<string | null> {
  if (!opts.connectionGroupId) return opts.legacyConnectionId;

  const snapshot = await loadScheduledTaskGroupSnapshot(opts.connectionGroupId, opts.orgId);
  if (!snapshot) {
    throw new Error(`Connection group ${opts.connectionGroupId} for scheduled task ${opts.taskId} was not found.`);
  }
  return selectScheduledTaskGroupMember(snapshot);
}
