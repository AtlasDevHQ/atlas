import { describe, it, expect, afterEach } from "bun:test";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { resetAuthInstance, canMintSCIMToken } from "../server";

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
