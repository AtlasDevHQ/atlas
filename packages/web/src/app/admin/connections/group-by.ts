import type { ConnectionInfo } from "@useatlas/types/connection";

/** Bucketization dimension for the connections list. Kept separate from
 * the nuqs parser so the bucketizer is testable without a Next.js
 * context. */
export type GroupByDimension = "type" | "environment";

/** Reserved bucket key for connections with no `groupId`. The UI
 * renders this bucket as "No environment" so unassigned connections
 * stay visible rather than filtered out. */
export const NO_ENVIRONMENT_KEY = "__none__";

/** Canonical deep link to the embedded environments view. Anything
 * that links to the connection groups should import this rather than
 * hand-rolling the URL — keeps the toggle, the per-row chip, and the
 * scheduled-tasks empty state in lockstep. */
export const ENVIRONMENT_VIEW_HREF = "/admin/connections?groupBy=environment";

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
