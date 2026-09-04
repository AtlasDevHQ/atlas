/**
 * Tests for `lib/auth/types.ts` — `createAtlasUser` validation, the
 * `AUTH_MODES` constant, and the `ATLAS_ROLES` / `ORG_ROLES` tuple invariant.
 *
 * Formerly split across `types.test.ts` and `organization.test.ts`; the latter
 * was named for the org plugin but exercised this module (createAtlasUser with
 * an options object + the role tuples), so it was folded in here.
 *
 * ⚠️ The ATLAS_ROLES / ORG_ROLES tuple assertions at the bottom are the
 * invariant `packages/api/src/__mocks__/api-test-mocks.ts` points at — its
 * `@atlas/api/lib/auth/types` mock must stay aligned with the real tuples or
 * role-escalation bugs like F-10 (#1752) go unnoticed in every mocked suite.
 */

import { describe, it, expect } from "bun:test";
import { createAtlasUser, AUTH_MODES, ATLAS_ROLES } from "../types";
import { ac, owner, admin, member } from "../org-permissions";

describe("createAtlasUser()", () => {
  it("throws when id is empty string", () => {
    expect(() => createAtlasUser("", "simple-key", "label")).toThrow(
      "AtlasUser id must be non-empty",
    );
  });

  it("throws when label is empty string", () => {
    expect(() => createAtlasUser("usr_1", "managed", "")).toThrow(
      "AtlasUser label must be non-empty",
    );
  });

  it("returns an object with correct id, mode, and label", () => {
    const user = createAtlasUser("usr_1", "byot", "alice@example.com");
    expect(user.id).toBe("usr_1");
    expect(user.mode).toBe("byot");
    expect(user.label).toBe("alice@example.com");
  });

  it("returns a frozen object", () => {
    const user = createAtlasUser("usr_1", "simple-key", "api-key-sk-t");
    expect(Object.isFrozen(user)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createAtlasUser with the options object (org context + claims)
// ---------------------------------------------------------------------------

describe("createAtlasUser() with options object", () => {
  it("includes activeOrganizationId when provided", () => {
    const user = createAtlasUser("u1", "managed", "alice@test.com", { role: "admin", activeOrganizationId: "org-123" });
    expect(user.activeOrganizationId).toBe("org-123");
  });

  it("omits activeOrganizationId when not provided", () => {
    const user = createAtlasUser("u1", "managed", "alice@test.com", { role: "admin" });
    expect(user.activeOrganizationId).toBeUndefined();
  });

  it("works with no options", () => {
    const user = createAtlasUser("u1", "managed", "alice@test.com");
    expect(user.role).toBeUndefined();
    expect(user.activeOrganizationId).toBeUndefined();
    expect(user.claims).toBeUndefined();
  });

  it("includes claims without needing undefined placeholder", () => {
    const user = createAtlasUser("u1", "byot", "alice@test.com", { claims: { sub: "u1" } });
    expect(user.claims?.sub).toBe("u1");
    expect(user.activeOrganizationId).toBeUndefined();
  });

  it("preserves all fields when all provided", () => {
    const claims = { sub: "u1", org_id: "org-789" };
    const user = createAtlasUser("u1", "managed", "alice@test.com", {
      role: "owner",
      activeOrganizationId: "org-789",
      claims,
    });
    expect(user.id).toBe("u1");
    expect(user.mode).toBe("managed");
    expect(user.label).toBe("alice@test.com");
    expect(user.role).toBe("owner");
    expect(user.activeOrganizationId).toBe("org-789");
    expect(user.claims?.org_id).toBe("org-789");
  });
});

describe("AUTH_MODES", () => {
  it("contains all four auth modes", () => {
    expect(AUTH_MODES).toEqual(["none", "simple-key", "managed", "byot"]);
  });

  it("is a readonly tuple at the type level", () => {
    // `as const` makes the array readonly at compile time; at runtime it's a plain array
    expect(Array.isArray(AUTH_MODES)).toBe(true);
    expect(AUTH_MODES.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// ATLAS_ROLES / OrgRole unification
// ---------------------------------------------------------------------------

describe("ATLAS_ROLES", () => {
  it("contains member, admin, owner, platform_admin", () => {
    expect(ATLAS_ROLES).toEqual(["member", "admin", "owner", "platform_admin"]);
  });

  // ORG_ROLES is the subset of ATLAS_ROLES that can be assigned through
  // workspace admin endpoints (role change, invitations). `platform_admin` is
  // intentionally excluded — see F-10 in security-audit-1-2-3.md.
  it("ORG_ROLES is ATLAS_ROLES minus platform_admin", async () => {
    const { ORG_ROLES } = await import("@useatlas/types");
    expect([...ORG_ROLES].sort()).toEqual(["admin", "member", "owner"]);
    expect(new Set(ORG_ROLES)).toEqual(new Set(ATLAS_ROLES.filter((r) => r !== "platform_admin")));
  });

  // The org role objects are exercised behaviourally (authorize() on each role,
  // and ac.newRole()) in `org-permissions.test.ts`; referenced here only so the
  // ATLAS_ROLES ↔ org-role pairing stays visible from the tuple assertions.
  it("pairs with the three org roles org-permissions defines", () => {
    expect([owner, admin, member].every((r) => typeof r.authorize === "function")).toBe(true);
    expect(typeof ac.newRole).toBe("function");
  });
});
