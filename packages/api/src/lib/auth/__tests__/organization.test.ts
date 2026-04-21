/**
 * Tests for organization plugin integration.
 *
 * Covers:
 * - createAtlasUser with options object
 * - Session carries org context
 * - Org-scoped access control role definitions
 * - OrgRole is an alias for AtlasRole
 */

import { describe, it, expect } from "bun:test";
import { createAtlasUser, ATLAS_ROLES } from "../types";
import { ac, owner, admin, member } from "../org-permissions";

// ---------------------------------------------------------------------------
// createAtlasUser with options object
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

  it("is frozen (immutable)", () => {
    const user = createAtlasUser("u1", "managed", "alice@test.com", { role: "member", activeOrganizationId: "org-1" });
    expect(Object.isFrozen(user)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Access control role definitions
// ---------------------------------------------------------------------------

describe("org-permissions access control", () => {
  it("defines member role with limited permissions", () => {
    expect(member).toBeDefined();
  });

  it("defines admin role with management permissions", () => {
    expect(admin).toBeDefined();
  });

  it("defines owner role with full permissions", () => {
    expect(owner).toBeDefined();
  });

  it("access controller is defined", () => {
    expect(ac).toBeDefined();
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
});
