/**
 * Org access-control roles vs. the permissions Better Auth's organization
 * plugin actually checks.
 *
 * `org-permissions.ts` builds a CUSTOM statement and CUSTOM owner/admin/member
 * roles, and `server.ts` passes both to `organization({ ac, roles })`. That
 * replaces Better Auth's stock `defaultStatements` / `defaultRoles` wholesale
 * rather than extending them — so a resource the stock roles gate but ours
 * omits is not "unrestricted", it is DENIED to everyone:
 * `role.authorize()` returns `unknownResourceResponse` when the requested
 * resource is absent from the role's statements (`plugins/access/access.mjs`).
 *
 * That is how invitations came to be impossible for every role including
 * `owner` — the custom statement never carried `invitation`, and nothing
 * compared it against what the routes ask for. These tests are that comparison.
 */

import { describe, it, expect } from "bun:test";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { ac, owner, admin, member } from "../org-permissions";

/**
 * Resources Better Auth gates that Atlas deliberately does not carry, with the
 * reason. Both are for organization-plugin features this deployment does not
 * enable (`server.ts` passes neither `teams` nor `dynamicAccessControl`), so
 * their routes are unreachable and granting them would be granting toward a
 * surface that does not exist.
 *
 * Listed rather than silently skipped: if either feature is ever switched on,
 * the guard below fails and forces a decision instead of shipping a dead deny.
 */
const DELIBERATELY_ABSENT: Record<string, string> = {
  team: "teams are not enabled on the organization() plugin",
  ac: "dynamicAccessControl is not enabled on the organization() plugin",
};

describe("org access control — invitation", () => {
  it("lets owner and admin create an invitation", () => {
    // The exact request `routes/crud-invites.mjs` makes.
    expect(owner.authorize({ invitation: ["create"] }).success).toBe(true);
    expect(admin.authorize({ invitation: ["create"] }).success).toBe(true);
  });

  it("lets owner and admin cancel an invitation", () => {
    expect(owner.authorize({ invitation: ["cancel"] }).success).toBe(true);
    expect(admin.authorize({ invitation: ["cancel"] }).success).toBe(true);
  });

  it("does not let a plain member invite or cancel", () => {
    expect(member.authorize({ invitation: ["create"] }).success).toBe(false);
    expect(member.authorize({ invitation: ["cancel"] }).success).toBe(false);
  });
});

describe("org access control — statement covers what the plugin gates", () => {
  it("carries every resource Better Auth's org routes check, or names why not", () => {
    const ours = new Set(Object.keys(ac.statements));
    const missing = Object.keys(defaultStatements).filter(
      (resource) => !ours.has(resource) && !(resource in DELIBERATELY_ABSENT),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the deliberately-absent list honest — each entry is still absent", () => {
    // If a resource here gains a definition, the exemption is stale and should
    // be deleted rather than left to excuse a grant that now exists.
    const ours = new Set(Object.keys(ac.statements));
    const staleExemptions = Object.keys(DELIBERATELY_ABSENT).filter((r) => ours.has(r));
    expect(staleExemptions).toEqual([]);
  });
});

describe("org access control — the deny that started this", () => {
  it("treats an absent resource as a hard deny, not an absence of restriction", () => {
    // Pins the Better Auth semantic this whole file depends on. If a future
    // version ever default-ALLOWED unknown resources, the coverage guard above
    // would still pass while meaning nothing — this is what catches that.
    const roleWithoutResource = ac.newRole({ settings: ["read"] });
    const result = roleWithoutResource.authorize({ invitation: ["create"] });
    expect(result.success).toBe(false);
  });
});
