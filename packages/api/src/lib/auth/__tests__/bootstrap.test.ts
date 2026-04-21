import { describe, it, expect } from "bun:test";
import { computeBootstrapRole } from "../server";

/**
 * Regression tests for #1728 / F-02 — the bootstrap platform_admin race.
 *
 * Before 1.2.3 the "no admin exists → promote first signup to platform_admin"
 * branch fired unconditionally. Any unauthenticated visitor could POST to
 * /api/auth/sign-up/email on a fresh deployment and claim platform_admin in
 * a single request. These tests pin the current safe behavior so future
 * refactors don't reintroduce the race.
 */
describe("computeBootstrapRole", () => {
  const countZero = () => Promise.resolve(0);
  const countOne = () => Promise.resolve(1);

  it("promotes when ATLAS_ADMIN_EMAIL matches the user email (case-insensitive)", async () => {
    const decision = await computeBootstrapRole(
      { email: "Admin@Example.Com" },
      {
        adminEmail: "admin@example.com",
        allowFirstSignupAdmin: false,
        internalDbAvailable: true,
        countExistingAdmins: countZero,
      },
    );

    expect(decision.promote).toBe(true);
    if (decision.promote) expect(decision.role).toBe("platform_admin");
  });

  it("promotes when ATLAS_ADMIN_EMAIL matches after trimming whitespace", async () => {
    const decision = await computeBootstrapRole(
      { email: "  admin@example.com  " },
      {
        adminEmail: "admin@example.com",
        allowFirstSignupAdmin: false,
        internalDbAvailable: true,
        countExistingAdmins: countZero,
      },
    );

    expect(decision.promote).toBe(true);
  });

  it("does NOT promote when the email doesn't match ATLAS_ADMIN_EMAIL", async () => {
    const decision = await computeBootstrapRole(
      { email: "attacker@evil.invalid" },
      {
        adminEmail: "admin@example.com",
        allowFirstSignupAdmin: false,
        internalDbAvailable: true,
        countExistingAdmins: countZero,
      },
    );

    expect(decision.promote).toBe(false);
  });

  it("does NOT promote when ATLAS_ADMIN_EMAIL is set but the user email is missing", async () => {
    const decision = await computeBootstrapRole(
      { email: null },
      {
        adminEmail: "admin@example.com",
        allowFirstSignupAdmin: false,
        internalDbAvailable: true,
        countExistingAdmins: countZero,
      },
    );

    expect(decision.promote).toBe(false);
  });

  // ----- F-02 regression: the attacker's happy path must fail ---------------

  it("F-02: does NOT promote an arbitrary signup when ATLAS_ADMIN_EMAIL is unset and the opt-in flag is off", async () => {
    const decision = await computeBootstrapRole(
      { email: "attacker@evil.invalid" },
      {
        adminEmail: undefined,
        allowFirstSignupAdmin: false, // the fix: default false
        internalDbAvailable: true,
        countExistingAdmins: countZero, // zero admins — this USED to auto-promote
      },
    );

    expect(decision.promote).toBe(false);
    expect(decision.reason).toContain("ATLAS_ALLOW_FIRST_SIGNUP_ADMIN");
  });

  it("F-02: opt-in fallback does NOT promote when the DB is unreachable", async () => {
    // Paranoid: even with the opt-in flag on, an attacker shouldn't get
    // platform_admin just because our DB probe can't prove no admin exists.
    // internalDbAvailable=false represents the signal that we cannot trust
    // the probe. The implementation also treats a throwing probe as fail-closed
    // (caught by the outer hook try/catch and logged).
    const decision = await computeBootstrapRole(
      { email: "attacker@evil.invalid" },
      {
        adminEmail: undefined,
        allowFirstSignupAdmin: true, // opt-in ON so we test the DB-availability guard
        internalDbAvailable: false,
        countExistingAdmins: () => {
          throw new Error("probe should not be called when internalDbAvailable=false");
        },
      },
    );

    expect(decision.promote).toBe(false);
  });

  // ----- Opt-in fallback path still works (CI, ephemeral demos) -------------

  it("promotes when the opt-in flag is set AND no admin exists AND DB is available", async () => {
    const decision = await computeBootstrapRole(
      { email: "first-user@demo.test" },
      {
        adminEmail: undefined,
        allowFirstSignupAdmin: true,
        internalDbAvailable: true,
        countExistingAdmins: countZero,
      },
    );

    expect(decision.promote).toBe(true);
    if (decision.promote) {
      expect(decision.role).toBe("platform_admin");
      expect(decision.reason).toContain("first-signup fallback");
    }
  });

  it("does NOT promote via the opt-in fallback when an admin already exists", async () => {
    const decision = await computeBootstrapRole(
      { email: "second-user@demo.test" },
      {
        adminEmail: undefined,
        allowFirstSignupAdmin: true,
        internalDbAvailable: true,
        countExistingAdmins: countOne,
      },
    );

    expect(decision.promote).toBe(false);
    expect(decision.reason).toContain("admin already exists");
  });

  it("does NOT promote via the opt-in fallback when the internal DB is not available", async () => {
    // Without a DB we can't prove there's no existing admin, so refuse.
    const decision = await computeBootstrapRole(
      { email: "first-user@demo.test" },
      {
        adminEmail: undefined,
        allowFirstSignupAdmin: true,
        internalDbAvailable: false,
        countExistingAdmins: countZero,
      },
    );

    expect(decision.promote).toBe(false);
  });

  it("ATLAS_ADMIN_EMAIL match takes precedence over the opt-in fallback", async () => {
    const decision = await computeBootstrapRole(
      { email: "admin@example.com" },
      {
        adminEmail: "admin@example.com",
        allowFirstSignupAdmin: true,
        internalDbAvailable: true,
        countExistingAdmins: countOne, // existing admin — fallback would skip
      },
    );

    expect(decision.promote).toBe(true);
    if (decision.promote) expect(decision.reason).toBe("ATLAS_ADMIN_EMAIL match");
  });
});
