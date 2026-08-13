/**
 * #5189 — the legacy (non-EE) role→permission mapping actually carries the
 * dashboards flags.
 *
 * This exists because the route-level suite could not prove it. Those tests
 * mock `checkPermission` at the `RolesPolicy` seam, so they exercise the GATE
 * and never reach the mapping behind it — measured: stripping both dashboards
 * flags out of `LEGACY_ROLE_PERMISSIONS` left `dashboards-permission.test.ts`
 * at 64/64 green. The decision that a non-EE `member` can author dashboards was
 * unfalsified by anything until this file.
 *
 * It matters most on exactly the deploys that have no EE custom-role table:
 * self-hosted, where this mapping IS the authorization model.
 */

import { describe, it, expect, mock } from "bun:test";
import { Effect } from "effect";

// No internal DB → `resolvePermissions` takes the legacy branch without a DB
// read, which is the path a non-EE self-hosted deploy is always on.
//
// Spread the real module: `mock.module` REPLACES it wholesale, and a partial
// factory breaks every other consumer's import at load time rather than at the
// assertion (`internalQuery` is the one that surfaces first here).
const realInternal = await import("@atlas/api/lib/db/internal");
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => false,
}));

const { resolvePermissions } = await import("../permission-resolve");
const { PERMISSIONS } = await import("../permissions");

const resolve = (role: string) =>
  Effect.runPromise(
    resolvePermissions({
      id: "u1",
      label: "u@test.com",
      mode: "managed",
      role,
      activeOrganizationId: "org-1",
    } as never),
  );

describe("#5189 — legacy role mapping carries the dashboards flags", () => {
  it("member can read AND author dashboards", async () => {
    const perms = await resolve("member");
    expect(perms.has("dashboards:read")).toBe(true);
    expect(perms.has("dashboards:write")).toBe(true);
  });

  it("member still holds only its query flags beyond dashboards", async () => {
    // The decision was to ADD dashboards to `member`, not to widen it toward
    // admin. Asserting the exact set is what makes an accidental
    // `member: [...PERMISSIONS]` fail rather than pass more loudly.
    const perms = await resolve("member");
    expect([...perms].sort()).toEqual([
      "dashboards:read",
      "dashboards:write",
      "query",
      "query:raw_data",
    ]);
  });

  it("member holds no admin flag", async () => {
    const perms = await resolve("member");
    expect([...perms].filter((p) => p.startsWith("admin:"))).toEqual([]);
  });

  it("owner and admin still hold every flag, including the new pair", async () => {
    for (const role of ["owner", "admin", "platform_admin"]) {
      const perms = await resolve(role);
      expect([...perms].sort()).toEqual([...PERMISSIONS].sort());
    }
  });

  it("an unknown role falls through to member, dashboards included", async () => {
    // The mapping's documented fall-through. Without this a custom role name on
    // a non-EE deploy would silently lose dashboards access.
    const perms = await resolve("data-scientist");
    expect(perms.has("dashboards:read")).toBe(true);
    expect(perms.has("dashboards:write")).toBe(true);
  });
});
