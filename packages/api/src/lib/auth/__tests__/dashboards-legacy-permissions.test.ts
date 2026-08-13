/**
 * #5189 — the legacy (non-EE) role→permission mapping actually carries the
 * dashboards flags.
 *
 * This exists because the route-level suite could not prove it. Those tests
 * mock `checkPermission` at the `RolesPolicy` seam, so they exercise the GATE
 * and never reach the mapping behind it — measured: stripping both dashboards
 * flags out of `LEGACY_ROLE_PERMISSIONS` left `dashboards-permission.test.ts`
 * fully green (re-measured at 66/66 after round 2
 * added a test — the count moves, the property does not). The decision that a non-EE `member` can author dashboards was
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

describe("#5192 — the legacy mapping withholds dashboards:share from member", () => {
  // This is the non-EE half of the regression. `member` is the legacy analyst
  // persona on every self-hosted deploy without a `custom_roles` table, so this
  // mapping IS the authorization answer there — and #5190 handed it a
  // public-link-minting capability that had been admin-only.
  it("member cannot mint a public share link", async () => {
    const perms = await resolve("member");
    expect(perms.has("dashboards:share")).toBe(false);
    // …while keeping the authoring flag the same route still requires, so this
    // cannot pass by having taken dashboards away from `member` wholesale.
    expect(perms.has("dashboards:write")).toBe(true);
  });

  it("the unknown-role fall-through does not smuggle it in either", async () => {
    // The fall-through target IS `member`, so this is the same set — but the
    // path is different code, and a deleted EE custom role whose members still
    // carry its name arrives here rather than above.
    const perms = await resolve("data-scientist");
    expect(perms.has("dashboards:share")).toBe(false);
  });

  it("owner, admin and platform_admin do hold it", async () => {
    for (const role of ["owner", "admin", "platform_admin"]) {
      const perms = await resolve(role);
      expect(perms.has("dashboards:share"), `${role} should hold it`).toBe(true);
    }
  });
});

describe("#5189 round 2 — the lookup key is a free string", () => {
  it("does not resolve a prototype member as a role", async () => {
    // `role` carries EE custom-role names at runtime, so indexing the mapping
    // object exposed `Object.prototype` to it: `"toString"` returned a truthy
    // FUNCTION, which skipped the unknown-role warn and then threw inside
    // `new Set(...)` — surfacing as a 503 instead of the member fall-through.
    const perms = await resolve("toString");
    expect([...perms].sort()).toEqual([
      "dashboards:read",
      "dashboards:write",
      "query",
      "query:raw_data",
    ]);
  });

  it("does not resolve `constructor` either", async () => {
    const perms = await resolve("constructor");
    expect(perms.has("dashboards:read")).toBe(true);
    expect([...perms].filter((p) => p.startsWith("admin:"))).toEqual([]);
  });
});
