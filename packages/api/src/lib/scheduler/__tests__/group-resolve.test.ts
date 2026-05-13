import { describe, expect, it } from "bun:test";
import {
  NoScheduledTaskGroupMembersError,
  selectScheduledTaskGroupMember,
  type SchedulerGroupSnapshot,
} from "../group-resolve";

const MEMBERS = [
  { id: "us-int", createdAt: "2026-04-01T00:00:00Z" },
  { id: "eu", createdAt: "2026-04-15T00:00:00Z" },
  { id: "apac", createdAt: "2026-05-01T00:00:00Z" },
] as const;

describe("selectScheduledTaskGroupMember", () => {
  it("returns the primary member when it is still in the group", () => {
    const snap: SchedulerGroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: "eu",
      members: [...MEMBERS],
    };

    expect(selectScheduledTaskGroupMember(snap)).toBe("eu");
  });

  it("falls back to the first member by (created_at ASC, id ASC) when primary is missing", () => {
    const snap: SchedulerGroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: "ghost",
      members: [...MEMBERS],
    };

    expect(selectScheduledTaskGroupMember(snap)).toBe("us-int");
  });

  it("breaks fallback ties by id", () => {
    const snap: SchedulerGroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: null,
      members: [
        { id: "zeta", createdAt: "2026-04-01T00:00:00Z" },
        { id: "alpha", createdAt: "2026-04-01T00:00:00Z" },
      ],
    };

    expect(selectScheduledTaskGroupMember(snap)).toBe("alpha");
  });

  it("sorts Date-created members chronologically", () => {
    const snap: SchedulerGroupSnapshot = {
      groupId: "g_prod",
      orgId: "org-1",
      primaryConnectionId: null,
      members: [
        { id: "may", createdAt: new Date("2026-05-01T00:00:00Z") },
        { id: "apr", createdAt: new Date("2026-04-01T00:00:00Z") },
      ],
    };

    expect(selectScheduledTaskGroupMember(snap)).toBe("apr");
  });

  it("throws when the group has no members", () => {
    expect(() =>
      selectScheduledTaskGroupMember({
        groupId: "g_empty",
        orgId: "org-1",
        primaryConnectionId: null,
        members: [],
      }),
    ).toThrow(NoScheduledTaskGroupMembersError);
  });
});
