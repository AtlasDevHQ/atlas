import type { ConnectionInfo } from "@useatlas/types/connection";

/** Bucketization dimension for the connections list. Post-0096 cutover
 * (#2744 / ADR-0007) the `"environment"` view is gone — the type-grouped
 * provider blocks are now the sole view. The dimension type stays for
 * the bucketizer's API surface so call sites stay explicit, but `"type"`
 * is the only meaningful value. */
export type GroupByDimension = "type" | "environment";

/** Reserved bucket key for connections with no `groupId`. Kept for the
 * environment-bucket branch in the bucketizer; callers that don't use
 * that dimension can ignore. */
export const NO_ENVIRONMENT_KEY = "__none__";

export interface ConnectionBucket {
  key: string;
  connections: ConnectionInfo[];
}

/**
 * Bucketize a connection list by `dbType` or by `groupId`. Pure: no
 * I/O, no sort beyond input order, no fabrication of empty buckets —
 * callers decide what to render for missing providers.
 */
export function bucketizeConnections(
  connections: ReadonlyArray<ConnectionInfo>,
  dimension: GroupByDimension,
): ConnectionBucket[] {
  const buckets = new Map<string, ConnectionInfo[]>();
  for (const conn of connections) {
    const key = bucketKey(conn, dimension);
    const list = buckets.get(key) ?? [];
    list.push(conn);
    buckets.set(key, list);
  }
  return Array.from(buckets, ([key, conns]) => ({ key, connections: conns }));
}

function bucketKey(conn: ConnectionInfo, dimension: GroupByDimension): string {
  if (dimension === "type") return conn.dbType;
  // `null` (explicit unassign) and `undefined` (older serializer) both
  // collapse to the same no-environment bucket.
  return conn.groupId ?? NO_ENVIRONMENT_KEY;
}
