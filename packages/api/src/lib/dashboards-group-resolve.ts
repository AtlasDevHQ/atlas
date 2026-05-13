/**
 * Group-scoped dashboard-card resolver (#2342).
 *
 * Pure helpers that pick the physical connection a card executes against
 * once cards carry a `connection_group_id` instead of a single
 * `connection_id`. The DB-touching async wrapper lives one layer up in
 * `lib/dashboards.ts` so the resolver is unit-testable without spinning
 * up the internal Postgres.
 *
 * Resolution rules (matching the PRD-default "primary-member execution"
 * — side-by-side rendering is explicitly out of scope for v1):
 *
 *   1. `primaryConnectionId` set AND still a member → return the primary.
 *   2. `primaryConnectionId` null OR points at a removed member → return
 *      the first member ordered by `(created_at ASC, id ASC)`.
 *   3. Zero members → throw `NoGroupMembersError` so the route layer
 *      surfaces a 500 + requestId. Silent fallback to the workspace
 *      default would render the card against the wrong connection — the
 *      "Prefer errors over silent fallbacks" rule in CLAUDE.md.
 */

export interface GroupMember {
  /** Connection id (matches `connections.id`). */
  readonly id: string;
  /** ISO-8601 timestamp; we compare lexicographically. */
  readonly createdAt: string;
}

export interface GroupSnapshot {
  readonly groupId: string;
  readonly orgId: string | null;
  /** Admin-pinned primary, NULL when unset. */
  readonly primaryConnectionId: string | null;
  /** Current membership; may be empty. */
  readonly members: readonly GroupMember[];
}

/**
 * Thrown when a card resolves to a group that has zero current members.
 * The route layer logs and returns a typed 500 with the request id —
 * never silently fall back to the workspace default connection.
 */
export class NoGroupMembersError extends Error {
  override readonly name = "NoGroupMembersError";
  readonly groupId: string;
  readonly orgId: string | null;
  constructor(groupId: string, orgId: string | null) {
    super(
      `Connection group ${groupId} (org=${orgId ?? "__global__"}) has no members; card cannot resolve to a connection.`,
    );
    this.groupId = groupId;
    this.orgId = orgId;
  }
}

/**
 * Pick the connection id a card executes against, given a group snapshot.
 * See module doc for resolution rules.
 *
 * The fallback ordering uses string compare on `createdAt` — every caller
 * passes ISO-8601 timestamps (DB column is `TIMESTAMPTZ`, stringified by
 * `internalQuery`), so lexicographic order matches chronological order.
 */
export function selectGroupMember(snapshot: GroupSnapshot): string {
  if (snapshot.members.length === 0) {
    throw new NoGroupMembersError(snapshot.groupId, snapshot.orgId);
  }

  if (snapshot.primaryConnectionId !== null) {
    const found = snapshot.members.find((m) => m.id === snapshot.primaryConnectionId);
    if (found) return found.id;
    // Primary points at a member that's no longer in the group. Fall
    // through to the (created_at, id) ordering rather than propagating
    // a stale id — the card keeps rendering until an admin re-pins.
  }

  // Defensive copy so a frozen / shared input isn't mutated.
  const sorted = [...snapshot.members].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0].id;
}
