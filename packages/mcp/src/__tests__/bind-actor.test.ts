/**
 * Tests for the `bindMcpActor` trust-boundary seam (#3603).
 *
 * The CRITICAL INVARIANT (ADR-0016 §platform_admin) is that the seam makes the
 * stdio-vs-hosted fork explicit WITHOUT erasing it:
 *
 *   - hosted MUST resolve the ORG role only — it passes `undefined` for the
 *     user-level role so a cross-tenant `platform_admin` is never auto-applied
 *     over a customer's workspace.
 *   - stdio MUST resolve the USER-LEVEL role — it passes the caller's
 *     `userRole` through so a `platform_admin` over the operator's own process
 *     keeps `platform_admin`.
 *
 * We mock `resolveEffectiveRole` and assert exactly what each arm forwards to
 * it — the byte-for-byte difference the ADR mandates.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { AtlasRole } from "@atlas/api/lib/auth/types";

// Capture every call to the shared role resolver so we can assert what each
// transport arm forwards. mock.module requires all exports be present.
const resolveCalls: Array<{
  userRole: AtlasRole | undefined;
  userId: string;
  activeOrganizationId: string | undefined;
}> = [];

mock.module("@atlas/api/lib/auth/effective-role", () => ({
  resolveEffectiveRole: (
    userRole: AtlasRole | undefined,
    userId: string,
    activeOrganizationId: string | undefined,
  ) => {
    resolveCalls.push({ userRole, userId, activeOrganizationId });
    // Echo back the role the resolver WOULD compute so the arms are
    // distinguishable: it returns the userRole it was given (the hosted arm
    // forces this to undefined; the stdio arm forwards the real value).
    return Promise.resolve(userRole);
  },
}));

const { resolveMcpActorRole } = await import("../bind-actor.js");

beforeEach(() => {
  resolveCalls.length = 0;
});

describe("resolveMcpActorRole — trust-boundary fork (#3603, ADR-0016)", () => {
  it("hosted arm withholds the user-level role (org role only — never platform_admin)", async () => {
    const role = await resolveMcpActorRole({
      transport: "hosted",
      userId: "user-1",
      activeOrganizationId: "org-1",
      // Even if a caller wrongly passed a platform_admin userRole, the hosted
      // arm must NOT forward it. (The type forbids it on hosted callers; this
      // proves the runtime behavior too.)
      userRole: "platform_admin",
    });

    expect(resolveCalls).toHaveLength(1);
    // The invariant: hosted forwards `undefined`, never the user-level role.
    expect(resolveCalls[0].userRole).toBeUndefined();
    expect(resolveCalls[0].userId).toBe("user-1");
    expect(resolveCalls[0].activeOrganizationId).toBe("org-1");
    // Echoed-back role is therefore undefined → downstream least-privilege.
    expect(role).toBeUndefined();
  });

  it("stdio arm forwards the user-level role (platform_admin survives)", async () => {
    const role = await resolveMcpActorRole({
      transport: "stdio",
      userId: "user-2",
      activeOrganizationId: "org-2",
      userRole: "platform_admin",
    });

    expect(resolveCalls).toHaveLength(1);
    // The invariant: stdio forwards the real user-level role.
    expect(resolveCalls[0].userRole).toBe("platform_admin");
    expect(role).toBe("platform_admin");
  });

  it("stdio arm forwards an org-level user role unchanged", async () => {
    await resolveMcpActorRole({
      transport: "stdio",
      userId: "user-3",
      activeOrganizationId: "org-3",
      userRole: "owner",
    });
    expect(resolveCalls[0].userRole).toBe("owner");
  });

  // #4043 / ADR-0025 — the cli (atlas-login device-flow) arm resolves the ORG
  // role only, exactly like hosted: a portable file-stored bearer must never
  // carry cross-tenant `platform_admin`, regardless of deploy mode.
  it("cli arm withholds the user-level role (org role only — never platform_admin)", async () => {
    const role = await resolveMcpActorRole({
      transport: "cli",
      userId: "user-4",
      activeOrganizationId: "org-4",
      // Even if a caller wrongly passed a platform_admin userRole, the cli arm
      // must NOT forward it.
      userRole: "platform_admin",
    });

    // The invariant: cli forwards `undefined`, never the user-level role.
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].userRole).toBeUndefined();
    expect(resolveCalls[0].userId).toBe("user-4");
    expect(resolveCalls[0].activeOrganizationId).toBe("org-4");
    // Mock returns the userRole it was given (undefined for the cli arm).
    expect(role).toBeUndefined();
  });
});
