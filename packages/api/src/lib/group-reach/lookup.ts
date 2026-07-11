/**
 * Impure helper that enumerates the **visible** Connection groups a workspace
 * can query, for the pure {@link resolveReach} module to bound against
 * (ADR-0022, slice (a) #3893).
 *
 * Lives alongside the pure resolver but in its own file so the reach policy
 * stays testable without a DB — exactly the `env-routing/` split
 * ({@link resolveRoutingPlan} ↔ {@link loadGroupRoutingContext}).
 *
 * "Visible" is sourced from the **content-mode-filtered whitelist map**
 * (`loadOrgWhitelist`), which is the workspace's authoritative analytical
 * surface: a group with no whitelisted tables in the active mode (a
 * draft/unpublished datasource, or one outside the workspace) is invisible
 * and never surfaces here. Member connection ids fold into their canonical
 * `connection_group_id` (via `listConnectionGroupMembers`); a group-of-one
 * standalone datasource (#3855) keys under its own connection id and stands
 * alone. The result is the set of groups the agent may target with
 * `executeSQL`'s per-query group bound.
 *
 * Scope note: this enumerates **SQL** Connection groups only — the whitelist
 * is SQL-entity-derived. REST datasources are reached via their own tool
 * (`executeRestOperation`) and bounded by REST scope (ADR-0011), a separate
 * axis; the slice-(b) Source catalog is what unifies both into one menu.
 *
 * Never throws — every failure mode degrades (logged, per CLAUDE.md "never
 * silently swallow errors") rather than hard-failing the agent's turn.
 *
 * @see ADR-0022 — cross-group reach
 * @see issue #3893 — slice (a) acceptance criteria
 */

import { loadOrgWhitelist } from "@atlas/api/lib/semantic";
import { createLogger } from "@atlas/api/lib/logger";
import type { AtlasMode } from "@useatlas/types/auth";
import type { VisibleGroup } from "./index";

const log = createLogger("group-reach:lookup");

/**
 * Resolve the workspace's visible Connection groups for the given content
 * mode. Returns `[]` when there is no workspace (`orgId` undefined — the
 * self-hosted / single-flat-connection case) or when the whitelist can't be
 * loaded; both mean "no enumerable cross-group surface," and the caller
 * treats an absent target as the degenerate single-connection case.
 */
export async function loadVisibleGroups(
  orgId: string | undefined,
  mode?: AtlasMode,
): Promise<readonly VisibleGroup[]> {
  if (!orgId) return [];

  let whitelist: Map<string, Set<string>>;
  try {
    whitelist = await loadOrgWhitelist(orgId, mode);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to load whitelist for visible-groups lookup — reporting no reachable groups",
    );
    return [];
  }

  // Group membership: member connection id → canonical group id, plus the
  // member roster per group. Best-effort — a failure means we cannot fold
  // members into groups, so each visible key surfaces as its own group
  // rather than the whole workspace going dark (logged, not swallowed).
  const memberToGroup = new Map<string, string>();
  const groupToMembers = new Map<string, string[]>();
  try {
    // Dynamic import (mirrors `whitelist.ts`): `entities.ts` is frequently
    // partial-mocked by test fixtures, so a STATIC import here would pull it
    // into the broadly-imported `sql.ts` graph and break those fixtures with a
    // module-load "export not found" SyntaxError. Resolving at call-time keeps
    // the dependency out of the load graph.
    const { listConnectionGroupMembers } = await import(
      "@atlas/api/lib/semantic/entities"
    );
    const rows = await listConnectionGroupMembers(orgId);
    for (const { group_id, id } of rows) {
      memberToGroup.set(id, group_id);
      const roster = groupToMembers.get(group_id) ?? [];
      roster.push(id);
      groupToMembers.set(group_id, roster);
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to load group membership — visible groups will not fold env replicas",
    );
  }

  // Canonical group ids = the non-empty whitelist keys, with member ids
  // collapsed into their group. An empty table set means content-mode
  // filtered this key out (invisible) — skip it.
  const canonical = new Set<string>();
  for (const [key, tables] of whitelist) {
    if (tables.size === 0) continue;
    canonical.add(memberToGroup.get(key) ?? key);
  }

  return [...canonical].sort().map((id) => {
    const members = (groupToMembers.get(id) ?? [id]).slice().sort();
    return { id, members, primary: members[0] ?? id } satisfies VisibleGroup;
  });
}

/**
 * Resolve the connection id a semantic Amendment's evidence should execute
 * against — its resolved Connection group's primary member (#4513). "Evidence
 * runs where the change lives": an amendment on a group-scoped entity must run
 * its test query against that group's datasource, not the default connection.
 *
 * - `null`/`undefined` group → `"default"` (the flat default scope).
 * - a group id → its `primary` member from {@link loadVisibleGroups} (a
 *   group-of-one standalone datasource resolves to its own connection id).
 * - a group that no longer resolves (self-hosted with no visible-groups DB, or
 *   a group hidden by content mode) → the group id itself, since a standalone
 *   datasource keys its group under its own connection id; a genuinely
 *   unresolvable group degrades to that id rather than silently retargeting the
 *   default datasource.
 *
 * Never throws — {@link loadVisibleGroups} already degrades to `[]` on failure.
 */
export async function resolveGroupPrimaryConnectionId(
  orgId: string | undefined,
  groupId: string | null | undefined,
  mode?: AtlasMode,
): Promise<string> {
  if (!groupId) return "default";
  const visible = await loadVisibleGroups(orgId, mode);
  const match = visible.find((g) => g.id === groupId);
  if (!match) {
    // The group did not resolve to a visible primary — content-mode hid it, it
    // is not in this workspace, or (upstream) the whitelist load degraded to []
    // (logged in loadVisibleGroups). Log the degradation so that if the fallback
    // id turns out not to be a registered connection, the downstream
    // `Connection "…" is not registered` error is traceable to HERE rather than
    // read as a spurious SQL-validation failure.
    log.debug(
      { orgId, groupId, visibleCount: visible.length },
      "resolveGroupPrimaryConnectionId: group did not resolve to a visible primary — falling back to the group id",
    );
    return groupId;
  }
  return match.primary;
}
