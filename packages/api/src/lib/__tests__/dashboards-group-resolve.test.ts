/**
 * Tests for the group-scoped dashboard-card resolver (#2342).
 *
 * The resolver decides which physical connection a card executes against
 * once cards reference a `connection_group_id` instead of a single
 * `connection_id`. Three named cases pin the contract:
 *
 *   1. Card → group with explicit `primaryConnectionId` → execute on the
 *      primary member.
 *   2. Card → group with `primaryConnectionId IS NULL` → fall back to the
 *      group's first member ordered by `(created_at, id)`.
 *   3. Card → group with zero members → throw `NoGroupMembersError` so
 *      the route layer can surface a 500 + requestId rather than silently
 *      defaulting to the workspace connection (the silent-fallback class
 *      flagged by CLAUDE.md "Prefer errors over silent fallbacks").
 *
 * Pure-function tests — no DB. The async wrapper that pulls the group
 * snapshot out of Postgres has its own integration shape in
 * `migrate-pg.test.ts` so the DB FK / column shape stays in lockstep.
 */

import { describe, it, expect } from "bun:test";
import {
  selectGroupMember,
  NoGroupMembersError,
  type GroupSnapshot,
} from "../dashboards-group-resolve";

const MEMBERS_FRESH_TO_STALE = [
  { id: "us-int", createdAt: "2026-04-01T00:00:00Z" },
  { id: "eu", createdAt: "2026-04-15T00:00:00Z" },
  { id: "apac", createdAt: "2026-05-01T00:00:00Z" },
] as const;

describe("selectGroupMember", () => {
  it("returns the primary member when primaryConnectionId is set and still present", () => {
    const snap: GroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: "eu",
      members: [...MEMBERS_FRESH_TO_STALE],
    };
    expect(selectGroupMember(snap)).toBe("eu");
  });

  it("falls back to the first member ordered by (created_at ASC, id ASC) when primaryConnectionId is null", () => {
    // us-int is the oldest by created_at — the fallback rule pins
    // "first member" to chronological order so the resolution is
    // deterministic across replica reads.
    const snap: GroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: null,
      members: [...MEMBERS_FRESH_TO_STALE],
    };
    expect(selectGroupMember(snap)).toBe("us-int");
  });

  it("falls back to first member when primaryConnectionId points at a removed member", () => {
    // The primary was set to a connection that has since been removed
    // from the group (admin moved it elsewhere). Don't crash and don't
    // silently propagate the stale id; fall back to the first remaining
    // member so the card keeps rendering until the admin renames the
    // primary.
    const snap: GroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: "ghost",
      members: [...MEMBERS_FRESH_TO_STALE],
    };
    expect(selectGroupMember(snap)).toBe("us-int");
  });

  it("breaks created_at ties by id ASC", () => {
    // Two members created in the same statement — the fallback must be
    // deterministic across processes. `id` is the tie-breaker (matches
    // the SQL ORDER BY in lib/dashboards.ts that loads the snapshot).
    const snap: GroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: null,
      members: [
        { id: "zeta", createdAt: "2026-04-01T00:00:00Z" },
        { id: "alpha", createdAt: "2026-04-01T00:00:00Z" },
      ],
    };
    expect(selectGroupMember(snap)).toBe("alpha");
  });

  it("throws NoGroupMembersError when the group has zero members", () => {
    // Critical path: never silently fall through to the workspace
    // default. The route layer catches NoGroupMembersError and surfaces
    // a 500 with the requestId attached so the user sees an actionable
    // failure rather than a card backed by the wrong connection.
    const snap: GroupSnapshot = {
      groupId: "g_empty",
      orgId: "org-1",
      primaryConnectionId: null,
      members: [],
    };
    expect(() => selectGroupMember(snap)).toThrow(NoGroupMembersError);
    try {
      selectGroupMember(snap);
    } catch (err) {
      expect(err).toBeInstanceOf(NoGroupMembersError);
      expect((err as NoGroupMembersError).groupId).toBe("g_empty");
      expect((err as NoGroupMembersError).orgId).toBe("org-1");
    }
  });

  it("throws even when the primary is set but the member list is empty", () => {
    // Stale `primaryConnectionId` plus zero members = orphaned group.
    // The check must not short-circuit on the truthy primary id.
    const snap: GroupSnapshot = {
      groupId: "g_drained",
      orgId: "org-1",
      primaryConnectionId: "us-int",
      members: [],
    };
    expect(() => selectGroupMember(snap)).toThrow(NoGroupMembersError);
  });
});
