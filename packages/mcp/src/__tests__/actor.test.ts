/**
 * #1858 — MCP actor binding (mirrors F-54 / F-55 from PR #1860).
 *
 * MCP previously called `executeSQL.execute()` with no `withRequestContext`
 * frame and no actor. The defensive `identityMissing` check in
 * `ee/src/governance/approval.ts` now correctly fail-closes MCP queries
 * when any approval rule exists, but the user-facing message ("approve via
 * the Atlas web app") doesn't apply to MCP — there is no Atlas session.
 *
 * `resolveMcpActor()` is the new boot-time actor resolver. The four cells
 * of (bound | unbound) × (rules | no rules) are pinned below; partial-
 * binding and user-not-found are also covered as fail-loud regressions on
 * the new error messages.
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";

const ORIGINAL_ENV = {
  ATLAS_MCP_USER_ID: process.env.ATLAS_MCP_USER_ID,
  ATLAS_MCP_ORG_ID: process.env.ATLAS_MCP_ORG_ID,
  DATABASE_URL: process.env.DATABASE_URL,
};

function setEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(): void {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    setEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
}

const mockLoadActorUser = mock<
  (userId: string, orgId: string | null) => Promise<unknown>
>(async () => null);
const mockAnyApprovalRuleEnabled = mock<() => Effect.Effect<boolean, never>>(
  () => Effect.succeed(false),
);
const mockInternalQuery = mock<
  (sql: string, params?: unknown[]) => Promise<unknown[]>
>(async () => []);

mock.module("@atlas/api/lib/auth/actor", () => ({
  loadActorUser: mockLoadActorUser,
}));

mock.module("@atlas/ee/governance/approval", () => ({
  anyApprovalRuleEnabled: mockAnyApprovalRuleEnabled,
}));

// `internalQuery` is overridden via spread (CLAUDE.md "Mock all exports")
// so the membership-check (`userIsMemberOf`) can be driven without
// breaking sibling test files that need the real `@atlas/api/lib/db/internal`
// surface (encryption helpers, pool lifecycle, etc.).
const realInternal = await import("@atlas/api/lib/db/internal");
mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: mockInternalQuery,
}));

const { resolveMcpActor, MCP_BINDING_ERROR_MESSAGE, MCP_PARTIAL_BINDING_ERROR, MCP_USER_NOT_FOUND_ERROR, MCP_USER_NOT_MEMBER_ERROR } = await import("../actor.js");

describe("resolveMcpActor", () => {
  beforeEach(() => {
    setEnv("ATLAS_MCP_USER_ID", undefined);
    setEnv("ATLAS_MCP_ORG_ID", undefined);
    setEnv("DATABASE_URL", undefined);
    mockLoadActorUser.mockReset();
    mockAnyApprovalRuleEnabled.mockReset();
    mockInternalQuery.mockReset();
    // `mockReset()` wipes implementations — restore safe defaults so any
    // test path that doesn't explicitly stub these mocks still produces a
    // valid value. Necessary because `bun:test` shares `mock.module`
    // state across test files: `prompts.test.ts:33` overrides
    // `@atlas/api/lib/db/internal` with a `hasInternalDB` decoupled
    // from `process.env.DATABASE_URL`, so depending on file load order
    // the rule-lookup path can run even when DATABASE_URL is unset.
    // Without the default impl, `Effect.runPromise(undefined)` rejects
    // with `op._op` and the catch in `rulesExist` fail-closes,
    // breaking the trusted-transport tests.
    mockAnyApprovalRuleEnabled.mockImplementation(() => Effect.succeed(false));
    mockInternalQuery.mockImplementation(async () => [{ exists: 1 }]);
  });

  afterEach(() => {
    restoreEnv();
  });

  it("bound + rules — resolves the bound user", async () => {
    setEnv("ATLAS_MCP_USER_ID", "u_123");
    setEnv("ATLAS_MCP_ORG_ID", "org_abc");
    setEnv("DATABASE_URL", "postgres://x");
    mockLoadActorUser.mockResolvedValueOnce({
      id: "u_123",
      mode: "managed",
      label: "user@example.com",
      role: "admin",
      activeOrganizationId: "org_abc",
    });

    const actor = await resolveMcpActor();

    expect(actor.id).toBe("u_123");
    expect(actor.activeOrganizationId).toBe("org_abc");
    // I2: pin that loadActorUser's mode flows through unaltered. A refactor
    // that wrapped the loaded user in a fresh `createAtlasUser` with a
    // different mode would silently break audit attribution.
    expect(actor.mode).toBe("managed");
    expect(mockLoadActorUser).toHaveBeenCalledWith("u_123", "org_abc");
    // G4: bound path returns before rule lookup — symmetric with the
    // "bound + no rules" test below. A refactor that hoists the rule
    // check above binding would silently regress this.
    expect(mockAnyApprovalRuleEnabled).not.toHaveBeenCalled();
  });

  it("bound + no rules — resolves the bound user (no rule lookup needed)", async () => {
    setEnv("ATLAS_MCP_USER_ID", "u_123");
    setEnv("ATLAS_MCP_ORG_ID", "org_abc");
    mockLoadActorUser.mockResolvedValueOnce({
      id: "u_123",
      mode: "managed",
      label: "user@example.com",
      role: "member",
      activeOrganizationId: "org_abc",
    });

    const actor = await resolveMcpActor();

    expect(actor.id).toBe("u_123");
    // When the operator binds, we skip the rule lookup — binding signals
    // the deployment intent regardless of whether any rule currently exists.
    expect(mockAnyApprovalRuleEnabled).not.toHaveBeenCalled();
  });

  it("unbound + rules — fails loud at startup with the new error message", async () => {
    setEnv("DATABASE_URL", "postgres://x");
    mockAnyApprovalRuleEnabled.mockImplementation(() => Effect.succeed(true));

    await expect(resolveMcpActor()).rejects.toThrow(MCP_BINDING_ERROR_MESSAGE);
    expect(mockLoadActorUser).not.toHaveBeenCalled();
  });

  it("unbound + no rules — returns synthetic system:mcp actor", async () => {
    mockAnyApprovalRuleEnabled.mockImplementation(() => Effect.succeed(false));

    const actor = await resolveMcpActor();

    expect(actor.id).toBe("system:mcp");
    expect(actor.mode).toBe("simple-key");
    expect(actor.role).toBe("member");
    expect(mockLoadActorUser).not.toHaveBeenCalled();
  });

  // The short-circuit optimization (`!hasInternalDB() → return false`) is
  // not asserted here via `mockAnyApprovalRuleEnabled.not.toHaveBeenCalled()`
  // because `bun:test` shares `mock.module` state across files: a sibling
  // test (`prompts.test.ts:33`) overrides the `@atlas/api/lib/db/internal`
  // mock with a custom `hasInternalDB` whose return is decoupled from
  // `process.env.DATABASE_URL`. In that environment the rule-lookup path
  // does run, even with no DB set. The behaviour we actually care about
  // is that the trusted-transport actor is returned regardless of the
  // path taken — that's what's pinned below. With the safe default impl
  // for `mockAnyApprovalRuleEnabled` (`Effect.succeed(false)`) set in
  // `beforeEach`, both the short-circuit branch AND the full rule-lookup
  // branch end up returning `system:mcp`.
  it("unbound + no internal DB — returns system:mcp", async () => {
    const actor = await resolveMcpActor();

    expect(actor.id).toBe("system:mcp");
    expect(actor.activeOrganizationId).toBeUndefined();
  });

  it("partial binding (only ATLAS_MCP_USER_ID) — fails loud", async () => {
    setEnv("ATLAS_MCP_USER_ID", "u_123");

    await expect(resolveMcpActor()).rejects.toThrow(MCP_PARTIAL_BINDING_ERROR);
  });

  it("partial binding (only ATLAS_MCP_ORG_ID) — fails loud", async () => {
    setEnv("ATLAS_MCP_ORG_ID", "org_abc");

    await expect(resolveMcpActor()).rejects.toThrow(MCP_PARTIAL_BINDING_ERROR);
  });

  it("bound but user does not exist — fails loud at startup", async () => {
    setEnv("ATLAS_MCP_USER_ID", "u_deleted");
    setEnv("ATLAS_MCP_ORG_ID", "org_abc");
    mockLoadActorUser.mockResolvedValueOnce(null);

    await expect(resolveMcpActor()).rejects.toThrow(MCP_USER_NOT_FOUND_ERROR);
  });

  it("rule-lookup transient failure — fails closed (treats as rules exist)", async () => {
    setEnv("DATABASE_URL", "postgres://x");
    mockAnyApprovalRuleEnabled.mockImplementation(() =>
      // The real `anyApprovalRuleEnabled` swallows DB errors and fail-closes
      // to `true`. Stub a defect (`Effect.die`) so `Effect.runPromise`
      // rejects — `rulesExist`'s catch then treats it as "rules exist",
      // same fail-closed posture.
      Effect.die(new Error("DB connection refused")),
    );

    await expect(resolveMcpActor()).rejects.toThrow(MCP_BINDING_ERROR_MESSAGE);
  });

  it("bound + user not a member of bound org — fails loud", async () => {
    setEnv("ATLAS_MCP_USER_ID", "u_alice");
    setEnv("ATLAS_MCP_ORG_ID", "org_other");
    setEnv("DATABASE_URL", "postgres://x");
    mockLoadActorUser.mockResolvedValueOnce({
      id: "u_alice",
      mode: "managed",
      label: "alice@example.com",
      role: "admin",
      activeOrganizationId: "org_other",
    });
    // Membership check returns no rows.
    mockInternalQuery.mockImplementationOnce(async () => []);

    await expect(resolveMcpActor()).rejects.toThrow(MCP_USER_NOT_MEMBER_ERROR);
  });

  it("bound + member-lookup DB error — propagates (no silent reject)", async () => {
    setEnv("ATLAS_MCP_USER_ID", "u_bob");
    setEnv("ATLAS_MCP_ORG_ID", "org_abc");
    setEnv("DATABASE_URL", "postgres://x");
    mockLoadActorUser.mockResolvedValueOnce({
      id: "u_bob",
      mode: "managed",
      label: "bob@example.com",
      role: "member",
      activeOrganizationId: "org_abc",
    });
    mockInternalQuery.mockImplementationOnce(async () => {
      throw new Error("connection refused");
    });

    // Propagates the underlying error — operator sees "connection refused"
    // and can distinguish from MCP_USER_NOT_MEMBER_ERROR.
    await expect(resolveMcpActor()).rejects.toThrow("connection refused");
  });

  // G5: pin the realistic mis-config (operator sets the binding env vars
  // but forgets DATABASE_URL). In production `loadActorUser` returns null
  // when `!hasInternalDB()` (packages/api/src/lib/auth/actor.ts:64), so
  // resolveMcpActor fails with MCP_USER_NOT_FOUND_ERROR before reaching
  // the membership check. A future refactor that lets loadActorUser
  // synthesize an actor without a DB would silently make MCP boot with a
  // foreign actor, no test failing — this test fails it visibly.
  it("bound + no internal DB — fails loud with USER_NOT_FOUND (loadActorUser short-circuits)", async () => {
    setEnv("ATLAS_MCP_USER_ID", "u_123");
    setEnv("ATLAS_MCP_ORG_ID", "org_abc");
    // DATABASE_URL unset → real loadActorUser returns null → membership
    // check is unreachable. Mock matches that production behaviour.
    mockLoadActorUser.mockResolvedValueOnce(null);

    await expect(resolveMcpActor()).rejects.toThrow(MCP_USER_NOT_FOUND_ERROR);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  // Code-reviewer #2: trusted-transport actor must flow through the
  // approval gate's `requesterId` short-circuit (ee/governance/approval.ts
  // line ~495), not the `identityMissing` branch. A future refactor that
  // tightens `requesterId` to non-synthetic ids would silently break
  // trusted-transport. Pinning the actor's *shape* here so anyone changing
  // the gate sees the dependency.
  it("trusted-transport actor has shape compatible with the requesterId fallthrough path", async () => {
    const actor = await resolveMcpActor();
    expect(actor.id).toBe("system:mcp");
    // The gate reads `getRequestContext()?.user?.id` as `requesterId`.
    // A non-empty id is the sole precondition for the fallthrough branch.
    expect(actor.id.length).toBeGreaterThan(0);
    // No org claim — that's the trusted-transport contract; queries proceed
    // because no org-scoped rule can match an unbound org.
    expect(actor.activeOrganizationId).toBeUndefined();
    // I1: pin `mode` here so a refactor that flips the synthetic actor
    // off `simple-key` (the no-Better-Auth-session signal) doesn't quietly
    // break audit attribution or downstream auth-mode branching.
    expect(actor.mode).toBe("simple-key");
  });
});
