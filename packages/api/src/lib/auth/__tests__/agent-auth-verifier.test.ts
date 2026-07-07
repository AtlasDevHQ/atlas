/**
 * Unit tests for the Agent-Auth → AtlasUser producer (#4409 reversible seam).
 *
 * `resolveAgentAuthActor` is the sixth producer of `AtlasUser` and the single
 * place the agent-auth workspace binding + trust boundary are enforced. These
 * pin the branches that are awkward to reach through the full plugin: the
 * fail-closed denials and the org-role-only (withhold-`platform_admin`)
 * boundary. The end-to-end happy + cross-workspace paths are additionally
 * covered through the real plugin in `agent-auth-plugin.test.ts`.
 *
 * `resolveEffectiveRole` and `listUserWorkspaceIds` are mocked (both hit the
 * internal DB in production); the tests drive their return values per-case.
 */

import { describe, it, expect, mock } from "bun:test";

let workspacesFor: (userId: string) => Promise<string[]> = async () => ["wsA"];
mock.module("@atlas/api/lib/auth/oauth-workspace-grants", () => ({
  getOAuthClientScope: async () => "single",
  hasWorkspaceGrant: async () => false,
  userIsWorkspaceMember: async () => false,
  listUserWorkspaceIds: (userId: string) => workspacesFor(userId),
  listWorkspaceGrantsForClient: async () => [],
  setWorkspaceScopeAndGrants: async () => undefined,
  revokeWorkspaceGrant: async () => 0,
}));

// Capture the arguments the verifier passes to resolveEffectiveRole so we can
// assert the org-role-only boundary (userRole must be undefined).
const roleCalls: Array<[unknown, string, string | undefined]> = [];
let roleResult: unknown = undefined;
mock.module("@atlas/api/lib/auth/effective-role", () => ({
  resolveEffectiveRole: async (userRole: unknown, userId: string, orgId: string | undefined) => {
    roleCalls.push([userRole, userId, orgId]);
    return roleResult;
  },
}));

import { resolveAgentAuthActor } from "@atlas/api/lib/auth/agent-auth-verifier";

const baseIdentity = {
  userId: "user_1",
  requestedWorkspaceId: "wsA",
  agentId: "agent_1",
  label: "Agent One",
};

describe("resolveAgentAuthActor (#4409 sixth AtlasUser producer)", () => {
  it("happy: owning user is a member → binds an AtlasUser scoped to that workspace", async () => {
    workspacesFor = async () => ["wsA", "wsOther"];
    roleResult = "member";
    const result = await resolveAgentAuthActor(baseIdentity);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.user.id).toBe("user_1");
    expect(result.user.mode).toBe("managed");
    expect(result.user.activeOrganizationId).toBe("wsA");
    expect(result.user.role).toBe("member");
    expect(result.user.claims).toMatchObject({ agent_auth: true, agent_id: "agent_1", active_organization_id: "wsA" });
    // Frozen — createAtlasUser hardens the object.
    expect(Object.isFrozen(result.user)).toBe(true);
  });

  it("threads the resolved org role onto the AtlasUser", async () => {
    workspacesFor = async () => ["wsA"];
    roleResult = "admin";
    const result = await resolveAgentAuthActor(baseIdentity);
    expect(result.kind === "ok" && result.user.role).toBe("admin");
  });

  it("org-role-only: never passes a user-level role to resolveEffectiveRole (withholds platform_admin)", async () => {
    roleCalls.length = 0;
    workspacesFor = async () => ["wsA"];
    roleResult = "member";
    await resolveAgentAuthActor(baseIdentity);
    // Exactly the hosted/cli boundary: userRole arg is undefined.
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0][0]).toBeUndefined();
    expect(roleCalls[0]).toEqual([undefined, "user_1", "wsA"]);
  });

  it("cross-workspace isolation: owning user not a member of the requested workspace → denied", async () => {
    workspacesFor = async () => ["wsA"]; // not wsB
    const result = await resolveAgentAuthActor({ ...baseIdentity, requestedWorkspaceId: "wsB" });
    expect(result).toEqual({ kind: "denied", reason: "not_a_member" });
  });

  it("missing workspace binding → denied without a membership lookup", async () => {
    let called = false;
    workspacesFor = async () => {
      called = true;
      return ["wsA"];
    };
    const result = await resolveAgentAuthActor({ ...baseIdentity, requestedWorkspaceId: undefined });
    expect(result).toEqual({ kind: "denied", reason: "missing_workspace" });
    expect(called).toBe(false);
  });

  it("fail-closed: a membership-lookup error denies (never a broader identity)", async () => {
    workspacesFor = async () => {
      throw new Error("internal DB down");
    };
    const result = await resolveAgentAuthActor(baseIdentity);
    expect(result).toEqual({ kind: "denied", reason: "membership_lookup_failed" });
  });

  it("no resolved role → AtlasUser omits role (downstream defaults to least privilege)", async () => {
    workspacesFor = async () => ["wsA"];
    roleResult = undefined;
    const result = await resolveAgentAuthActor(baseIdentity);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.user.role).toBeUndefined();
  });
});
