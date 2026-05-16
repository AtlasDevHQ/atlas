import type { ConnectionInfo } from "@useatlas/types/connection";

/**
 * Dimension the connections list is bucketized by. URL-encoded via nuqs as
 * `?groupBy=type` (default) or `?groupBy=environment` so admins can deep-link
 * directly to either view. Kept as a separate string-literal union from the
 * nuqs parser so the bucketizer can be tested without a Next.js context.
 */
export type GroupByDimension = "type" | "environment";

/** Reserved key used when a connection has no `groupId` and the user has
 * picked the Environment dimension. Surfaced in the UI as "No environment"
 * so admins can see which connections are unassigned without filtering
 * them out. */
export const NO_ENVIRONMENT_KEY = "__none__";

export interface ConnectionBucket {
  /** Stable bucket key — `dbType` for `type`, `groupId` (or {@link NO_ENVIRONMENT_KEY}) for `environment`. */
  key: string;
  /** Connections in this bucket, in input order. */
  connections: ConnectionInfo[];
}

/**
 * Bucketize a connection list by `dbType` or by `groupId`. Pure: no I/O,
 * no sort beyond input order, no fabrication of empty buckets — callers
 * decide what to render for missing providers.
 *
 * Stable across re-renders only when the input array is stable; React
 * callers should already be working off a memoized list.
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
  // `groupId` is `null` (explicit unassign) or `undefined` (older serializer)
  // — both collapse to the same "no environment" bucket so admins don't see
  // two parallel empty groupings on the same page.
  return conn.groupId ?? NO_ENVIRONMENT_KEY;
}
