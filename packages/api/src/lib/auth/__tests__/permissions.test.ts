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
  return createAtlasUser(`user-${mode}`, mode, `${mode}-label`, role);
}

// ---------------------------------------------------------------------------
// getUserRole()
// ---------------------------------------------------------------------------

describe("getUserRole()", () => {
  it("returns explicit role when set", () => {
    expect(getUserRole(makeUser("simple-key", "admin"))).toBe("admin");
    expect(getUserRole(makeUser("managed", "analyst"))).toBe("analyst");
    expect(getUserRole(makeUser("byot", "viewer"))).toBe("viewer");
  });

  it("defaults to analyst for simple-key mode", () => {
    expect(getUserRole(makeUser("simple-key"))).toBe("analyst");
  });

  it("defaults to viewer for managed mode", () => {
    expect(getUserRole(makeUser("managed"))).toBe("viewer");
  });

  it("defaults to viewer for byot mode", () => {
    expect(getUserRole(makeUser("byot"))).toBe("viewer");
  });
});

// ---------------------------------------------------------------------------
// parseRole()
// ---------------------------------------------------------------------------

describe("parseRole()", () => {
  it("returns valid roles", () => {
    expect(parseRole("viewer")).toBe("viewer");
    expect(parseRole("analyst")).toBe("analyst");
    expect(parseRole("admin")).toBe("admin");
  });

  it("is case-insensitive", () => {
    expect(parseRole("ADMIN")).toBe("admin");
    expect(parseRole("Analyst")).toBe("analyst");
    expect(parseRole("VIEWER")).toBe("viewer");
  });

  it("trims whitespace", () => {
    expect(parseRole("  admin  ")).toBe("admin");
  });

  it("returns undefined for invalid values", () => {
    expect(parseRole("superadmin")).toBeUndefined();
    expect(parseRole("")).toBeUndefined();
    expect(parseRole(undefined)).toBeUndefined();
    expect(parseRole("root")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// canApprove() — core matrix
// ---------------------------------------------------------------------------

describe("canApprove()", () => {
  describe("with undefined user (no-auth mode)", () => {
    it("denies all approval modes (no user = no approval ability)", () => {
      // Even auto is denied because canApprove only runs on manual approval endpoints.
      // Auto-approved actions are auto-executed by handleAction — they never reach canApprove.
      expect(canApprove(undefined, "auto")).toBe(false);
      expect(canApprove(undefined, "manual")).toBe(false);
      expect(canApprove(undefined, "admin-only")).toBe(false);
    });
  });

  describe("auto approval mode", () => {
    it("allows all roles (no human approval needed)", () => {
      expect(canApprove(makeUser("managed", "viewer"), "auto")).toBe(true);
      expect(canApprove(makeUser("simple-key", "analyst"), "auto")).toBe(true);
      expect(canApprove(makeUser("byot", "admin"), "auto")).toBe(true);
    });
  });

  describe("manual approval mode", () => {
    it("denies viewer", () => {
      expect(canApprove(makeUser("managed", "viewer"), "manual")).toBe(false);
      expect(canApprove(makeUser("byot", "viewer"), "manual")).toBe(false);
    });

    it("allows analyst", () => {
      expect(canApprove(makeUser("simple-key", "analyst"), "manual")).toBe(true);
      expect(canApprove(makeUser("managed", "analyst"), "manual")).toBe(true);
      expect(canApprove(makeUser("byot", "analyst"), "manual")).toBe(true);
    });

    it("allows admin", () => {
      expect(canApprove(makeUser("simple-key", "admin"), "manual")).toBe(true);
      expect(canApprove(makeUser("managed", "admin"), "manual")).toBe(true);
      expect(canApprove(makeUser("byot", "admin"), "manual")).toBe(true);
    });
  });

  describe("admin-only approval mode", () => {
    it("denies viewer", () => {
      expect(canApprove(makeUser("managed", "viewer"), "admin-only")).toBe(false);
      expect(canApprove(makeUser("byot", "viewer"), "admin-only")).toBe(false);
    });

    it("denies analyst", () => {
      expect(canApprove(makeUser("simple-key", "analyst"), "admin-only")).toBe(false);
      expect(canApprove(makeUser("managed", "analyst"), "admin-only")).toBe(false);
      expect(canApprove(makeUser("byot", "analyst"), "admin-only")).toBe(false);
    });

    it("allows admin", () => {
      expect(canApprove(makeUser("simple-key", "admin"), "admin-only")).toBe(true);
      expect(canApprove(makeUser("managed", "admin"), "admin-only")).toBe(true);
      expect(canApprove(makeUser("byot", "admin"), "admin-only")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Per-action requiredRole override
  // -------------------------------------------------------------------------

  describe("with requiredRole override", () => {
    it("overrides manual default — requires admin", () => {
      // manual normally allows analyst, but requiredRole=admin blocks them
      expect(canApprove(makeUser("simple-key", "analyst"), "manual", "admin")).toBe(false);
      expect(canApprove(makeUser("simple-key", "admin"), "manual", "admin")).toBe(true);
    });

    it("overrides admin-only default — requires analyst", () => {
      // admin-only normally requires admin, but requiredRole=analyst lowers the bar
      expect(canApprove(makeUser("managed", "analyst"), "admin-only", "analyst")).toBe(true);
      expect(canApprove(makeUser("managed", "viewer"), "admin-only", "analyst")).toBe(false);
    });

    it("viewer requiredRole allows all authenticated users", () => {
      expect(canApprove(makeUser("managed", "viewer"), "manual", "viewer")).toBe(true);
      expect(canApprove(makeUser("simple-key", "analyst"), "manual", "viewer")).toBe(true);
      expect(canApprove(makeUser("byot", "admin"), "manual", "viewer")).toBe(true);
    });

    it("still denies undefined user even with viewer requiredRole", () => {
      expect(canApprove(undefined, "manual", "viewer")).toBe(false);
    });

    it("does not apply to auto mode", () => {
      // Auto mode always returns true regardless of requiredRole
      expect(canApprove(makeUser("managed", "viewer"), "auto", "admin")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Auth mode default roles (no explicit role set)
  // -------------------------------------------------------------------------

  describe("with auth mode default roles (no explicit role)", () => {
    it("simple-key defaults to analyst — can approve manual, blocked from admin-only", () => {
      const user = makeUser("simple-key"); // defaults to analyst
      expect(canApprove(user, "manual")).toBe(true);
      expect(canApprove(user, "admin-only")).toBe(false);
    });

    it("managed defaults to viewer — blocked from manual and admin-only", () => {
      const user = makeUser("managed"); // defaults to viewer
      expect(canApprove(user, "manual")).toBe(false);
      expect(canApprove(user, "admin-only")).toBe(false);
    });

    it("byot defaults to viewer — blocked from manual and admin-only", () => {
      const user = makeUser("byot"); // defaults to viewer
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
  const roles: AtlasRole[] = ["viewer", "analyst", "admin"];
  const approvalModes: ActionApprovalMode[] = ["auto", "manual", "admin-only"];

  // Expected results: [role][approvalMode] => boolean
  const expected: Record<AtlasRole, Record<ActionApprovalMode, boolean>> = {
    viewer: { auto: true, manual: false, "admin-only": false },
    analyst: { auto: true, manual: true, "admin-only": false },
    admin: { auto: true, manual: true, "admin-only": true },
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
