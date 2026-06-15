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
import { buildCustomSessionPayload, canGenerateSCIMToken } from "../server";

describe("resolveEffectiveRole()", () => {
  // #2890 model: effectiveRole = user.role === "platform_admin"
  //                              ? "platform_admin" : member.role.
  // No more max(user.role, member.role) precedence merge.
  let queryCalls = 0;
  beforeEach(() => {
    queryCalls = 0;
    mockHasInternalDB = false;
    mockInternalQuery = () => { queryCalls++; return Promise.resolve([]); };
  });

  afterEach(() => {
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
  });

  it("returns the userRole as-is when no active org", async () => {
    const r = await resolveEffectiveRole("member", "usr_1", undefined);
    expect(r).toBe("member");
  });

  it("returns the userRole as-is when internal DB is unavailable", async () => {
    mockHasInternalDB = false;
    const r = await resolveEffectiveRole("member", "usr_1", "org_1");
    expect(r).toBe("member");
  });

  it("resolves to member.role when user.role is not platform_admin — org admin", async () => {
    // signup defaults user.role to "user"/undefined; the invite accept sets
    // member.role="admin". member.role is the single source of truth for
    // tenant admin-ness, so it surfaces regardless of the user-level value.
    mockHasInternalDB = true;
    mockInternalQuery = () => { queryCalls++; return Promise.resolve([{ role: "admin" }]); };
    const r = await resolveEffectiveRole(undefined, "usr_1", "org_1");
    expect(r).toBe("admin");
  });

  it("resolves to member.role for a plain org member", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => { queryCalls++; return Promise.resolve([{ role: "member" }]); };
    const r = await resolveEffectiveRole(undefined, "usr_1", "org_1");
    expect(r).toBe("member");
  });

  it("member.role wins over a non-platform user.role (no max precedence)", async () => {
    // Pins the #2890 model change: under the OLD max(user.role, member.role)
    // a legacy user.role="admin" with member.role="member" returned "admin".
    // Now member.role is authoritative for everything except platform_admin,
    // so this resolves DOWN to "member".
    mockHasInternalDB = true;
    mockInternalQuery = () => { queryCalls++; return Promise.resolve([{ role: "member" }]); };
    const r = await resolveEffectiveRole("admin", "usr_1", "org_1");
    expect(r).toBe("member");
  });

  it("platform_admin short-circuits and never hits the member table", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => { queryCalls++; return Promise.resolve([{ role: "member" }]); };
    const r = await resolveEffectiveRole("platform_admin", "usr_1", "org_1");
    expect(r).toBe("platform_admin");
    expect(queryCalls).toBe(0);
  });

  it("returns the userRole when no member row exists", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => { queryCalls++; return Promise.resolve([]); };
    const r = await resolveEffectiveRole("member", "usr_1", "org_1");
    expect(r).toBe("member");
  });

  it("ignores invalid org role strings (fail-safe to userRole)", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => { queryCalls++; return Promise.resolve([{ role: "garbage" }]); };
    const r = await resolveEffectiveRole("member", "usr_1", "org_1");
    expect(r).toBe("member");
  });

  it("fails closed to undefined on a DB error (intrinsic, caller-independent)", async () => {
    // Non-platform role so resolution actually reaches the member-table
    // lookup (platform_admin short-circuits before the try/catch). The lookup
    // was attempted and threw, so we don't know the tenant role → least
    // privilege (`undefined`), regardless of the passed `userRole`.
    mockHasInternalDB = true;
    mockInternalQuery = () => { queryCalls++; return Promise.reject(new Error("connection lost")); };
    expect(await resolveEffectiveRole("member", "usr_1", "org_1")).toBeUndefined();
    // Even a privileged userRole is NOT retained through a brownout — the
    // fail-closed direction no longer depends on the caller passing a non-admin
    // default.
    expect(await resolveEffectiveRole("admin", "usr_1", "org_1")).toBeUndefined();
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

describe("canGenerateSCIMToken()", () => {
  // #2890: the SCIM-token hook only sees the raw user.role (now only ever
  // platform_admin), so authorization must resolve the effective grant from
  // member.role. Tenant admins/owners must still be able to mint.
  beforeEach(() => {
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
  });
  afterEach(() => {
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
  });

  it("platform_admin is authorized without a member lookup", async () => {
    let queried = false;
    mockHasInternalDB = true;
    mockInternalQuery = () => { queried = true; return Promise.resolve([]); };
    expect(await canGenerateSCIMToken("platform_admin", "usr_1")).toBe(true);
    expect(queried).toBe(false);
  });

  it("an org admin/owner (member.role) is authorized even though raw role is not admin", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => Promise.resolve([{ ok: 1 }]);
    // raw role is the post-#2890 signup default — admin-ness comes from member.role
    expect(await canGenerateSCIMToken("member", "usr_owner")).toBe(true);
  });

  it("a plain member (no admin/owner member row) is denied", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => Promise.resolve([]);
    expect(await canGenerateSCIMToken("member", "usr_plain")).toBe(false);
  });

  it("fails closed when the member lookup errors", async () => {
    mockHasInternalDB = true;
    mockInternalQuery = () => Promise.reject(new Error("db down"));
    expect(await canGenerateSCIMToken("member", "usr_1")).toBe(false);
  });

  it("without an internal DB falls back to the raw-role predicate", async () => {
    mockHasInternalDB = false;
    expect(await canGenerateSCIMToken("admin", "usr_1")).toBe(true);
    expect(await canGenerateSCIMToken("member", "usr_1")).toBe(false);
  });
});
