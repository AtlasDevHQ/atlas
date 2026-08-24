/**
 * Org access-control roles vs. the permissions Better Auth's organization
 * plugin actually checks.
 *
 * `org-permissions.ts` builds a CUSTOM statement and CUSTOM owner/admin/member
 * roles, and `server.ts` passes both to `organization({ ac, roles })`. That
 * replaces Better Auth's stock defaultStatements / defaultRoles wholesale
 * rather than extending them — so a resource the stock roles gate but ours
 * omits is not "unrestricted", it is DENIED to everyone: role.authorize()
 * returns unknownResourceResponse when the requested resource is absent from
 * the role's statements (better-auth's plugins/access module).
 *
 * That is how invitations came to be impossible for every role including
 * `owner` — the custom statement never carried `invitation`, and nothing
 * compared it against what the routes ask for. These tests are that comparison.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { ac, owner, admin, member } from "../org-permissions";

/**
 * Resources Better Auth gates that Atlas deliberately does not carry, with the
 * reason. Both are for organization-plugin features this deployment does not
 * enable (`server.ts` passes neither `teams` nor `dynamicAccessControl`), so
 * their routes are unreachable and granting them would aim at a surface that
 * does not exist.
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
    // The exact request better-auth's invite route makes.
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
  it("carries every stock resource AND every stock action on it, or names why not", () => {
    // Action-level, not just resource-level: a resource present with a MISSING
    // ACTION denies exactly like an absent resource, so a resource-only check
    // would pass while the route 403s. Reported with the exemption reasons so a
    // failure says what to do rather than just naming a key.
    const ours = ac.statements as Record<string, readonly string[] | undefined>;
    const gaps: string[] = [];
    for (const [resource, stockActions] of Object.entries(defaultStatements)) {
      if (resource in DELIBERATELY_ABSENT) continue;
      const mine = ours[resource];
      if (!mine) {
        gaps.push(`${resource}: absent entirely (stock grants ${stockActions.join(", ")})`);
        continue;
      }
      const missingActions = stockActions.filter((a) => !mine.includes(a));
      if (missingActions.length > 0) {
        gaps.push(`${resource}: missing action(s) ${missingActions.join(", ")}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it("keeps the deliberately-absent list honest — each entry is still absent", () => {
    // If a resource here gains a definition, the exemption is stale and should
    // be deleted rather than left to excuse a grant that now exists.
    const ours = new Set(Object.keys(ac.statements));
    const stale = Object.entries(DELIBERATELY_ABSENT)
      .filter(([resource]) => ours.has(resource))
      .map(([resource, why]) => `${resource} is now defined, but is exempted because: ${why}`);
    expect(stale).toEqual([]);
  });
});

describe("org access control — the deny that started this", () => {
  it("treats an absent resource as a hard deny, not an absence of restriction", () => {
    // Pins the better-auth semantic this whole file depends on. If a future
    // version ever default-ALLOWED unknown resources, the coverage guard above
    // would still pass while meaning nothing — this is what catches that.
    const roleWithoutResource = ac.newRole({ settings: ["read"] });
    expect(roleWithoutResource.authorize({ invitation: ["create"] }).success).toBe(false);
  });

  it("denies a resource that is present but missing the requested action", () => {
    // The other half of the same failure, and the one the resource-level guard
    // above used to miss entirely.
    const roleMissingAction = ac.newRole({ invitation: ["cancel"] });
    expect(roleMissingAction.authorize({ invitation: ["create"] }).success).toBe(false);
  });
});

describe("org access control — the web client mirror", () => {
  /**
   * `packages/web/src/lib/auth/org-permissions.ts` is a hand-copy of this
   * module (the web package cannot import from `@atlas/api`), and it is fed to
   * `organizationClient({ ac, roles })`. Nothing in CI compared the two, so the
   * server fix for `invitation` left the client still denying it — a UI-side
   * reproduction of the same bug, waiting for the first client-side gate.
   *
   * Compared as normalised source rather than by importing the web module,
   * because importing across the package boundary is exactly what the copy
   * exists to avoid.
   */
  function acDefinition(absolutePath: string): string {
    const source = readFileSync(absolutePath, "utf8");
    const start = source.indexOf("const statement = {");
    expect(start).toBeGreaterThan(-1);
    return source
      .slice(start)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("*"))
      .join("\n");
  }

  it("defines exactly the same statement and roles as the server module", () => {
    const repoRoot = join(import.meta.dir, "../../../../../..");
    const server = acDefinition(join(repoRoot, "packages/api/src/lib/auth/org-permissions.ts"));
    const web = acDefinition(join(repoRoot, "packages/web/src/lib/auth/org-permissions.ts"));
    expect(web).toBe(server);
  });
});
