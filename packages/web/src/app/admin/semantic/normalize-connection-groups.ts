/**
 * Derive per-group display metadata for the `/admin/semantic` grouped tree
 * (#3235) from the admin connections list (`/api/v1/admin/connections`).
 *
 * The semantic entities endpoint carries only the group id (`connectionId`),
 * not its datasource type, so the grouped-tree section headers ("warehouse ·
 * Snowflake · 2 members") are joined in from the connections list. This is
 * metadata only — which groups render is decided by the entities themselves —
 * so a group with no matching connection is simply absent here and falls back
 * to an id-derived label in `SemanticFileTree`.
 *
 * Extracted from `page.tsx` (mirrors `normalize-drift.ts` / `normalize-metrics.ts`)
 * so the pivot — default-bucket folding, member counting, first-non-empty
 * datasource-type/name resolution, label precedence — is unit-testable.
 */

import type { ConnectionInfo } from "@/ui/lib/types";
import { labelForDbType } from "@/app/admin/connections/provider-meta";
import { stripGroupPrefix } from "@/ui/lib/strip-group-prefix";
import type { SemanticGroupMeta } from "@/ui/components/admin/semantic-file-tree";

/**
 * Pivot the connections list by group id (null = the default / unassigned
 * group) into `SemanticGroupMeta[]`. Members of a group share a schema, so
 * they share a datasource type in practice; the first non-empty `dbType` /
 * `groupName` wins. Connections with no `dbType` are dropped (malformed rows
 * shouldn't inflate the member count).
 */
export function connectionGroupsFrom(
  connections: ReadonlyArray<ConnectionInfo>,
): SemanticGroupMeta[] {
  // Map keys on `null` natively — the default group needs no string sentinel.
  const buckets = new Map<
    string | null,
    { id: string | null; name: string | null; dbType: string | null; count: number }
  >();
  for (const c of connections) {
    if (!c.dbType) continue;
    const id = c.groupId ?? null;
    const bucket = buckets.get(id) ?? { id, name: c.groupName ?? null, dbType: null, count: 0 };
    bucket.count += 1;
    if (!bucket.dbType && c.dbType) bucket.dbType = c.dbType;
    if (!bucket.name && c.groupName) bucket.name = c.groupName;
    buckets.set(id, bucket);
  }
  return [...buckets.values()].map((b) => ({
    id: b.id,
    // The connections endpoint sets groupName = group_id verbatim post-cutover
    // (#2744/ADR-0007), so `b.name ?? b.id` and the strip are equivalent today;
    // the fallback keeps the label honest if a distinct name ever returns.
    label: b.id == null ? "default" : stripGroupPrefix(b.name ?? b.id),
    dbTypeLabel: b.dbType ? labelForDbType(b.dbType) : undefined,
    memberCount: b.count,
  }));
}
