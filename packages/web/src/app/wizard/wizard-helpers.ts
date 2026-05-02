import type { ConnectionInfo } from "@/ui/lib/types";

export const DEMO_CONNECTION_ID = "__demo__";

/**
 * Map an arbitrary error to user-facing copy. Raw `err.message` may include
 * filesystem paths, stack frames, or DB driver internals — keep those in
 * `console.warn` for support and surface a clean line to the user.
 *
 * Pattern recognition is intentional: we don't try to enumerate every wizard
 * error — most go through the `fallback`. Pre-defined patterns (filesystem
 * permission denied, network unreachable, timeouts, "not found") get their
 * own actionable copy so users have a next step instead of a stack trace.
 */
export function userMessageFor(error: unknown, fallback: string): string {
  if (error instanceof TypeError) return "Couldn't reach the server. Check your connection and try again.";
  if (error instanceof Error) {
    if (/permission denied|EACCES|ENOENT|EPERM/i.test(error.message)) {
      return "Atlas couldn't write to its semantic layer directory. Check the server logs and the configured semantic layer path.";
    }
    if (/not found/i.test(error.message)) return error.message;
    if (/timeout|timed out/i.test(error.message)) return "The server took too long to respond. Try again in a moment.";
  }
  return fallback;
}

/**
 * Display a human-friendly name for a connection. The reserved `__demo__` id
 * is always shown as "Demo dataset"; everything else surfaces verbatim so the
 * id stays recognizable for users who recognize their own connection names.
 */
export function connectionDisplayName(c: ConnectionInfo): string {
  if (c.id === DEMO_CONNECTION_ID) return "Demo dataset";
  return c.id;
}

export interface PartitionedConnections {
  connections: ConnectionInfo[];
  /** The pre-loaded demo connection, if available. */
  demo: ConnectionInfo | null;
  /** User-visible saved connections, with internal/test ids filtered out. */
  user: ConnectionInfo[];
}

/**
 * Split the admin connections list into its onboarding-relevant buckets.
 * Hides ids that begin with `_` (Atlas-internal) and known test fixtures so
 * those don't pollute the user-facing picker.
 */
export function partitionConnections(
  connections: ConnectionInfo[] | null,
): PartitionedConnections {
  if (!connections) return { connections: [], demo: null, user: [] };
  const demo = connections.find((c) => c.id === DEMO_CONNECTION_ID) ?? null;
  const user = connections.filter(
    (c) => c.id !== DEMO_CONNECTION_ID && !c.id.startsWith("_") && !/^draft_test$/i.test(c.id),
  );
  return { connections, demo, user };
}
