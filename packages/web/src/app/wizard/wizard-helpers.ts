import type { ConnectionInfo } from "@/ui/lib/types";
import { DEMO_CONNECTION_ID } from "../admin/connections/columns";

export { DEMO_CONNECTION_ID };

/**
 * Map an arbitrary error to user-facing copy. Raw `err.message` may include
 * filesystem paths, stack frames, or DB driver internals — keep those in
 * `console.warn` for support and surface a clean line to the user.
 *
 * Recognized patterns get specific copy; everything else falls through to
 * `fallback`. See tests for the current pattern list.
 */
export function userMessageFor(error: unknown, fallback: string): string {
  if (error instanceof TypeError) return "Couldn't reach the server. Check your connection and try again.";
  if (error instanceof Error) {
    // Check filesystem/permission patterns FIRST so a wrapped message like
    // "ENOENT: ... not found, open '/srv/...'" never falls into the more
    // permissive "not found" branch below and leaks the path.
    if (/permission denied|EACCES|ENOENT|EPERM/i.test(error.message)) {
      return "Atlas couldn't write to its semantic layer directory. Check the server logs and the configured semantic layer path.";
    }
    if (/timeout|timed out/i.test(error.message)) return "The server took too long to respond. Try again in a moment.";
    if (/not found/i.test(error.message)) {
      // Defense-in-depth: even if a "not found" error embeds a path, strip it
      // before showing the user. Real backend "not found" messages today look
      // like `Connection "default" not found.` — they have no paths.
      return scrubPaths(error.message);
    }
  }
  return fallback;
}

/** Replace any token that looks like an absolute path with a placeholder. */
function scrubPaths(message: string): string {
  return message.replace(/['"]?(\/[^\s'"]+)/g, "<path>");
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
  /** The pre-loaded demo connection, if available. */
  readonly demo: ConnectionInfo | null;
  /** User-visible saved connections, with internal/test ids filtered out. */
  readonly user: readonly ConnectionInfo[];
}

/**
 * Split the admin connections list into the buckets the wizard surfaces:
 * the demo connection (rendered as a dedicated card) and user-visible saved
 * connections.
 */
export function partitionConnections(
  connections: ConnectionInfo[] | null,
): PartitionedConnections {
  if (!connections) return { demo: null, user: [] };
  const demo = connections.find((c) => c.id === DEMO_CONNECTION_ID) ?? null;
  const user = connections.filter(
    (c) =>
      c.id !== DEMO_CONNECTION_ID &&
      !c.id.startsWith("_") &&        // Atlas-internal connection ids
      !/^draft_test$/i.test(c.id) &&  // legacy fixture left in some seeded envs
      c.id.trim() !== "",             // defensive — API shouldn't emit empty ids
  );
  return { demo, user };
}
