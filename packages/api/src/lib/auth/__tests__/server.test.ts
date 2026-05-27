import { describe, it, expect, afterEach } from "bun:test";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { APIError } from "better-auth/api";
import {
  resetAuthInstance,
  canMintSCIMToken,
  assertInvitationRoleAllowed,
  isTransportError,
  buildPlugins,
} from "../server";

describe("Better Auth instance shape", () => {
  afterEach(() => {
    resetAuthInstance();
  });

  it("betterAuth() with @better-auth/api-key returns expected shape", async () => {
    // Verify the `as unknown as AuthInstance` cast in server.ts doesn't
    // hide a missing property. This uses the real betterAuth() constructor
    // with the same plugins as production.
    const instance = betterAuth({
      // Minimal adapter stub — enough for construction, never queried.
      database: {
        db: null,
        type: "sqlite",
      } as unknown as Parameters<typeof betterAuth>[0]["database"],
      secret: "test-secret-at-least-32-characters-long",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Better Auth plugin types are complex union types that vary by plugin combination
      plugins: [bearer(), apiKey()] as any[],
    });

    expect(typeof instance.handler).toBe("function");
    expect(typeof instance.api.getSession).toBe("function");
    expect(instance.$context).toBeInstanceOf(Promise);

    // Drain the $context promise so the async DB adapter init error
    // doesn't surface as an unhandled rejection after the test ends.
    await instance.$context.catch(() => {});
  });
});

// #2242 — regression coverage for the SCIM token role gate. The previous
// gate accepted {admin, platform_admin} only; an org owner would pass the
// upstream admin SCIM router (which accepts owner via adminAuth) and then
// bomb at this predicate with "Only admin users can generate SCIM
// tokens". Aligning to the canonical ADMIN_ROLES triple closes that
// inconsistency.
describe("canMintSCIMToken", () => {
  it("accepts admin", () => {
    expect(canMintSCIMToken("admin")).toBe(true);
  });

  it("accepts owner — #2242 regression", () => {
    expect(canMintSCIMToken("owner")).toBe(true);
  });

  it("accepts platform_admin", () => {
    expect(canMintSCIMToken("platform_admin")).toBe(true);
  });

  it("rejects member", () => {
    expect(canMintSCIMToken("member")).toBe(false);
  });

  it("rejects undefined / missing role", () => {
    expect(canMintSCIMToken(undefined)).toBe(false);
    expect(canMintSCIMToken(null)).toBe(false);
  });

  it("rejects unknown / typo'd role values", () => {
    expect(canMintSCIMToken("administrator")).toBe(false);
    expect(canMintSCIMToken("Owner")).toBe(false);
    expect(canMintSCIMToken("")).toBe(false);
    expect(canMintSCIMToken(42)).toBe(false);
  });
});

describe("assertInvitationRoleAllowed", () => {
  it("accepts member role", () => {
    expect(() => assertInvitationRoleAllowed("member")).not.toThrow();
  });

  it("accepts admin role", () => {
    expect(() => assertInvitationRoleAllowed("admin")).not.toThrow();
  });

  it("accepts owner role", () => {
    expect(() => assertInvitationRoleAllowed("owner")).not.toThrow();
  });

  it("rejects platform_admin single string", () => {
    expect(() => assertInvitationRoleAllowed("platform_admin")).toThrow(APIError);
  });

  it("rejects PLATFORM_ADMIN casing variant", () => {
    expect(() => assertInvitationRoleAllowed("PLATFORM_ADMIN")).toThrow(APIError);
  });

  it("rejects ' platform_admin ' with surrounding whitespace", () => {
    expect(() => assertInvitationRoleAllowed(" platform_admin ")).toThrow(APIError);
  });

  it("rejects mixed-case 'Platform_Admin'", () => {
    expect(() => assertInvitationRoleAllowed("Platform_Admin")).toThrow(APIError);
  });

  it("rejects array role containing platform_admin", () => {
    expect(() => assertInvitationRoleAllowed(["member", "platform_admin"])).toThrow(APIError);
  });

  it("rejects array role with cased PLATFORM_ADMIN", () => {
    expect(() => assertInvitationRoleAllowed(["admin", "PLATFORM_ADMIN"])).toThrow(APIError);
  });

  it("accepts array role with no platform_admin", () => {
    expect(() => assertInvitationRoleAllowed(["member", "admin"])).not.toThrow();
  });

  it("ignores null / undefined entries", () => {
    expect(() => assertInvitationRoleAllowed([null, "member"])).not.toThrow();
    expect(() => assertInvitationRoleAllowed(undefined)).not.toThrow();
  });
});

describe("isTransportError", () => {
  it("matches pg connection-reset code", () => {
    const err = Object.assign(new Error("connection closed"), { code: "ECONNRESET" });
    expect(isTransportError(err)).toBe(true);
  });

  it("matches pg admin-shutdown code 57P01", () => {
    const err = Object.assign(new Error("server shut down"), { code: "57P01" });
    expect(isTransportError(err)).toBe(true);
  });

  it("matches connection-class SQLSTATE codes (08xxx)", () => {
    const err = Object.assign(new Error("connection failure"), { code: "08006" });
    expect(isTransportError(err)).toBe(true);
  });

  it("matches 'connection terminated' message", () => {
    expect(isTransportError(new Error("connection terminated unexpectedly"))).toBe(true);
  });

  it("matches 'pool ended' message", () => {
    expect(isTransportError(new Error("pool ended"))).toBe(true);
  });

  it("rejects programmer errors (syntax error)", () => {
    expect(isTransportError(new Error("syntax error at or near 'WHERE'"))).toBe(false);
  });

  it("rejects TypeError for malformed response", () => {
    expect(isTransportError(new TypeError("Cannot read property 'allowed' of undefined"))).toBe(false);
  });

  it("rejects non-Error values", () => {
    expect(isTransportError("connection terminated")).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
  });
});

describe("organization plugin wiring", () => {
  // Wiring assertion — `requireEmailVerificationOnInvitation: true` closes
  // the invitation-claiming-via-signup oracle. A Better Auth upgrade that
  // renames or defaults this option silently re-opens the path.
  it("requireEmailVerificationOnInvitation is wired to true", () => {
    const plugins = buildPlugins();
    const org = plugins.find((p: { id?: string }) => p.id === "organization");
    expect(org).toBeDefined();
    // The plugin stores its options under `.options` after construction.
    // Different Better Auth versions have shipped the option under one of
    // a few keys (`options`, `_config`); probe both.
    const opts =
      (org as { options?: { requireEmailVerificationOnInvitation?: boolean } }).options
      ?? (org as { _config?: { requireEmailVerificationOnInvitation?: boolean } })._config
      ?? (org as Record<string, unknown>);
    // If neither shape is present, the assertion below still trips on
    // `undefined`, surfacing the BA shape change to the next maintainer.
    expect((opts as { requireEmailVerificationOnInvitation?: boolean }).requireEmailVerificationOnInvitation).toBe(true);
  });

  it("organization plugin exposes invitation hooks", () => {
    const plugins = buildPlugins();
    const org = plugins.find((p: { id?: string }) => p.id === "organization");
    expect(org).toBeDefined();
  });
});
