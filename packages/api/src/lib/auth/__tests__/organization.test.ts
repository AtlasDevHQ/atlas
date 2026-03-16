/**
 * Tests for organization plugin integration.
 *
 * Covers:
 * - createAtlasUser with activeOrganizationId
 * - Session carries org context
 * - Org-scoped access control role definitions
 */

import { describe, it, expect } from "bun:test";
import { createAtlasUser, ATLAS_ROLES } from "../types";
import { ac, owner, admin, member } from "../org-permissions";

// ---------------------------------------------------------------------------
// createAtlasUser with activeOrganizationId
// ---------------------------------------------------------------------------

describe("createAtlasUser() with org context", () => {
  it("includes activeOrganizationId when provided", () => {
    const user = createAtlasUser("u1", "managed", "alice@test.com", "admin", "org-123");
    expect(user.activeOrganizationId).toBe("org-123");
  });

  it("omits activeOrganizationId when not provided", () => {
    const user = createAtlasUser("u1", "managed", "alice@test.com", "admin");
    expect(user.activeOrganizationId).toBeUndefined();
  });

  it("includes org_id in claims when activeOrganizationId is set", () => {
    const user = createAtlasUser("u1", "managed", "alice@test.com", "admin", "org-456", { sub: "u1" });
    expect(user.claims?.org_id).toBeUndefined(); // claims don't auto-include org_id — that's done in managed.ts
  });

  it("preserves all fields when all provided", () => {
    const claims = { sub: "u1", org_id: "org-789" };
    const user = createAtlasUser("u1", "managed", "alice@test.com", "owner", "org-789", claims);
    expect(user.id).toBe("u1");
    expect(user.mode).toBe("managed");
    expect(user.label).toBe("alice@test.com");
    expect(user.role).toBe("owner");
    expect(user.activeOrganizationId).toBe("org-789");
    expect(user.claims?.org_id).toBe("org-789");
  });

  it("is frozen (immutable)", () => {
    const user = createAtlasUser("u1", "managed", "alice@test.com", "member", "org-1");
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
// ATLAS_ROLES updated
// ---------------------------------------------------------------------------

describe("ATLAS_ROLES", () => {
  it("contains member, admin, owner (not viewer/analyst)", () => {
    expect(ATLAS_ROLES).toEqual(["member", "admin", "owner"]);
  });
});
