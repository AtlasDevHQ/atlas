import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Mirror managed.test.ts: stub the internal-DB adapter BEFORE the
// SUT is imported so its transitive `hasInternalDB` / `internalQuery`
// references resolve to these closures.
let mockHasInternalDB = false;
let mockInternalQuery: (sql: string, params: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: (sql: string, params: unknown[]) => mockInternalQuery(sql, params),
}));

import { resolveEffectiveRole } from "../effective-role";
import { buildCustomSessionPayload } from "../server";

describe("resolveEffectiveRole()", () => {
  beforeEach(() => {
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
  });

  afterEach(() => {
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
  });

  it("returns the userRole as-is when no active org", async () => {
    const r = await resolveEffectiveRole("admin", "usr_1", undefined);
    expect(r).toBe("admin");
  });

  it("returns the userRole as-is when internal DB is unavailable", async () => {
    mockHasInternalDB = false;
    const r = await resolveEffectiveRole("member", "usr_1", "org_1");
    expect(r).toBe("member");
  });

  it("merges to the org member role when it outranks user.role — org admin > 'user'", async () => {
    // The bug: signup defaults user.role to "user"/undefined; the invite
    // accept sets member.role="admin". Without this merge, useUserRole
    // sees "user" and hides the gear icon.
    mockHasInternalDB = true;
    mockInternalQuery = () => Promise.resolve([{ role: "admin" }]);
    const r = await resolveEffectiveRole(undefined, "usr_1", "org_1");
    expect(r).toBe("admin");
  });

  it("keeps the user-level role when it outranks the org role — platform_admin > org admin", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => Promise.resolve([{ role: "admin" }]);
    const r = await resolveEffectiveRole("platform_admin", "usr_1", "org_1");
    expect(r).toBe("platform_admin");
  });

  it("returns the userRole when no member row exists", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => Promise.resolve([]);
    const r = await resolveEffectiveRole("member", "usr_1", "org_1");
    expect(r).toBe("member");
  });

  it("ignores invalid org role strings (fail-safe to userRole)", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => Promise.resolve([{ role: "garbage" }]);
    const r = await resolveEffectiveRole("member", "usr_1", "org_1");
    expect(r).toBe("member");
  });

  it("fails open to userRole on a DB error", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => Promise.reject(new Error("connection lost"));
    const r = await resolveEffectiveRole("admin", "usr_1", "org_1");
    expect(r).toBe("admin");
  });
});

describe("buildCustomSessionPayload()", () => {
  beforeEach(() => {
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
  });

  afterEach(() => {
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
  });

  it("stamps effectiveRole on user without touching the native role", async () => {
    // The regression case behind this PR: matt's user.role stayed at the
    // signup default ("user") while member.role landed as "admin" via the
    // invitation. customSession must surface the merged value as
    // effectiveRole AND leave user.role intact so Better Auth's own admin
    // endpoints still gate on system role.
    mockHasInternalDB = true;
    mockInternalQuery = () => Promise.resolve([{ role: "admin" }]);
    const out = await buildCustomSessionPayload({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture, mirrors Better Auth's User shape minimally
      user: { id: "usr_matt", email: "matt@useatlas.dev", role: "user" } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture, mirrors Better Auth's Session shape minimally
      session: { id: "sess_1", userId: "usr_matt", activeOrganizationId: "org_1" } as any,
    });
    const u = out.user as Record<string, unknown>;
    expect(u.role).toBe("user");
    expect(u.effectiveRole).toBe("admin");
  });

  it("returns effectiveRole: null when no role could be resolved", async () => {
    // No active org and no user.role — both sides empty. null (not
    // undefined) so the field is explicitly serialized over JSON.
    const out = await buildCustomSessionPayload({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
      user: { id: "usr_1", email: "a@b.com" } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
      session: { id: "sess_1", userId: "usr_1" } as any,
    });
    expect((out.user as Record<string, unknown>).effectiveRole).toBeNull();
  });

  it("strips a comma-suffixed user.role to the first segment before merging", async () => {
    // Better Auth admin plugin supports multi-role strings; Atlas uses
    // only the first segment, mirroring validateManaged's existing logic.
    mockHasInternalDB = true;
    mockInternalQuery = () => Promise.resolve([]);
    const out = await buildCustomSessionPayload({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
      user: { id: "usr_1", email: "a@b.com", role: "admin,extra" } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
      session: { id: "sess_1", userId: "usr_1", activeOrganizationId: "org_1" } as any,
    });
    expect((out.user as Record<string, unknown>).effectiveRole).toBe("admin");
  });
});
