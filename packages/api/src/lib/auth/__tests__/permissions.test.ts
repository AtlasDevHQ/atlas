/**
 * Unit tests for role-based action permissions.
 *
 * Covers:
 * - getUserRole() defaults per auth mode
 * - getUserRole() with explicit role
 * - parseRole() validation
 * - canApprove() across all role x approval mode combinations
 * - canApprove() with per-action requiredRole override
 * - Edge cases: undefined user, auto approval mode
 */

import { describe, it, expect } from "bun:test";
import { canApprove, getUserRole, parseRole } from "../permissions";
import { createAtlasUser } from "../types";
import type { AtlasRole } from "../types";
import type { ActionApprovalMode } from "@atlas/api/lib/action-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(mode: "simple-key" | "managed" | "byot", role?: AtlasRole) {
  return createAtlasUser(`user-${mode}`, mode, `${mode}-label`, role ? { role } : undefined);
}

// ---------------------------------------------------------------------------
// getUserRole()
// ---------------------------------------------------------------------------

describe("getUserRole()", () => {
  it("returns explicit role when set", () => {
    expect(getUserRole(makeUser("simple-key", "owner"))).toBe("owner");
    expect(getUserRole(makeUser("managed", "admin"))).toBe("admin");
    expect(getUserRole(makeUser("byot", "member"))).toBe("member");
  });

  it("defaults to admin for simple-key mode", () => {
    expect(getUserRole(makeUser("simple-key"))).toBe("admin");
  });

  it("defaults to member for managed mode", () => {
    expect(getUserRole(makeUser("managed"))).toBe("member");
  });

  it("defaults to member for byot mode", () => {
    expect(getUserRole(makeUser("byot"))).toBe("member");
  });
});

// ---------------------------------------------------------------------------
// parseRole()
// ---------------------------------------------------------------------------

describe("parseRole()", () => {
  it("returns valid roles", () => {
    expect(parseRole("member")).toBe("member");
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("owner")).toBe("owner");
    expect(parseRole("platform_admin")).toBe("platform_admin");
  });

  it("is case-insensitive", () => {
    expect(parseRole("ADMIN")).toBe("admin");
    expect(parseRole("Member")).toBe("member");
    expect(parseRole("OWNER")).toBe("owner");
    expect(parseRole("PLATFORM_ADMIN")).toBe("platform_admin");
  });

  it("trims whitespace", () => {
    expect(parseRole("  admin  ")).toBe("admin");
  });

  it("returns undefined for invalid values", () => {
    expect(parseRole("superadmin")).toBeUndefined();
    expect(parseRole("")).toBeUndefined();
    expect(parseRole(undefined)).toBeUndefined();
    expect(parseRole("root")).toBeUndefined();
    // Old roles are no longer valid
    expect(parseRole("viewer")).toBeUndefined();
    expect(parseRole("analyst")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// canApprove() — core matrix
// ---------------------------------------------------------------------------

describe("canApprove()", () => {
  describe("with undefined user (no-auth mode)", () => {
    it("denies all approval modes (no user = no approval ability)", () => {
      expect(canApprove(undefined, "auto")).toBe(false);
      expect(canApprove(undefined, "manual")).toBe(false);
      expect(canApprove(undefined, "admin-only")).toBe(false);
    });
  });

  describe("auto approval mode", () => {
    it("allows all roles (no human approval needed)", () => {
      expect(canApprove(makeUser("managed", "member"), "auto")).toBe(true);
      expect(canApprove(makeUser("simple-key", "admin"), "auto")).toBe(true);
      expect(canApprove(makeUser("byot", "owner"), "auto")).toBe(true);
    });
  });

  describe("manual approval mode", () => {
    it("denies member", () => {
      expect(canApprove(makeUser("managed", "member"), "manual")).toBe(false);
      expect(canApprove(makeUser("byot", "member"), "manual")).toBe(false);
    });

    it("allows admin", () => {
      expect(canApprove(makeUser("simple-key", "admin"), "manual")).toBe(true);
      expect(canApprove(makeUser("managed", "admin"), "manual")).toBe(true);
      expect(canApprove(makeUser("byot", "admin"), "manual")).toBe(true);
    });

    it("allows owner", () => {
      expect(canApprove(makeUser("simple-key", "owner"), "manual")).toBe(true);
      expect(canApprove(makeUser("managed", "owner"), "manual")).toBe(true);
    });
  });

  describe("admin-only approval mode", () => {
    it("denies member", () => {
      expect(canApprove(makeUser("managed", "member"), "admin-only")).toBe(false);
    });

    it("denies admin", () => {
      expect(canApprove(makeUser("simple-key", "admin"), "admin-only")).toBe(false);
      expect(canApprove(makeUser("managed", "admin"), "admin-only")).toBe(false);
    });

    it("allows owner", () => {
      expect(canApprove(makeUser("simple-key", "owner"), "admin-only")).toBe(true);
      expect(canApprove(makeUser("managed", "owner"), "admin-only")).toBe(true);
      expect(canApprove(makeUser("byot", "owner"), "admin-only")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Per-action requiredRole override
  // -------------------------------------------------------------------------

  describe("with requiredRole override", () => {
    it("overrides manual default — requires owner", () => {
      expect(canApprove(makeUser("simple-key", "admin"), "manual", "owner")).toBe(false);
      expect(canApprove(makeUser("simple-key", "owner"), "manual", "owner")).toBe(true);
    });

    it("overrides admin-only default — requires admin", () => {
      expect(canApprove(makeUser("managed", "admin"), "admin-only", "admin")).toBe(true);
      expect(canApprove(makeUser("managed", "member"), "admin-only", "admin")).toBe(false);
    });

    it("member requiredRole allows all authenticated users", () => {
      expect(canApprove(makeUser("managed", "member"), "manual", "member")).toBe(true);
      expect(canApprove(makeUser("simple-key", "admin"), "manual", "member")).toBe(true);
      expect(canApprove(makeUser("byot", "owner"), "manual", "member")).toBe(true);
    });

    it("still denies undefined user even with member requiredRole", () => {
      expect(canApprove(undefined, "manual", "member")).toBe(false);
    });

    it("does not apply to auto mode", () => {
      expect(canApprove(makeUser("managed", "member"), "auto", "owner")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Auth mode default roles (no explicit role set)
  // -------------------------------------------------------------------------

  describe("with auth mode default roles (no explicit role)", () => {
    it("simple-key defaults to admin — can approve manual, blocked from admin-only", () => {
      const user = makeUser("simple-key"); // defaults to admin
      expect(canApprove(user, "manual")).toBe(true);
      expect(canApprove(user, "admin-only")).toBe(false);
    });

    it("managed defaults to member — blocked from manual and admin-only", () => {
      const user = makeUser("managed"); // defaults to member
      expect(canApprove(user, "manual")).toBe(false);
      expect(canApprove(user, "admin-only")).toBe(false);
    });

    it("byot defaults to member — blocked from manual and admin-only", () => {
      const user = makeUser("byot"); // defaults to member
      expect(canApprove(user, "manual")).toBe(false);
      expect(canApprove(user, "admin-only")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Full auth mode x role x approval mode matrix
// ---------------------------------------------------------------------------

describe("full permission matrix", () => {
  const modes = ["simple-key", "managed", "byot"] as const;
  const roles: AtlasRole[] = ["member", "admin", "owner", "platform_admin"];
  const approvalModes: ActionApprovalMode[] = ["auto", "manual", "admin-only"];

  // Expected results: [role][approvalMode] => boolean
  const expected: Record<AtlasRole, Record<ActionApprovalMode, boolean>> = {
    member: { auto: true, manual: false, "admin-only": false },
    admin: { auto: true, manual: true, "admin-only": false },
    owner: { auto: true, manual: true, "admin-only": true },
    platform_admin: { auto: true, manual: true, "admin-only": true },
  };

  for (const mode of modes) {
    for (const role of roles) {
      for (const approval of approvalModes) {
        it(`${mode}/${role} + ${approval} => ${expected[role][approval]}`, () => {
          const user = makeUser(mode, role);
          expect(canApprove(user, approval)).toBe(expected[role][approval]);
        });
      }
    }
  }
});
