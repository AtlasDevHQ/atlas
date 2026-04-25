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

// Only the two helpers `actor.ts` reaches for outside its own dynamic
// import surface get mocked. We deliberately avoid mocking
// `@atlas/api/lib/db/internal` — partial-export mocks leak into sibling
// test files (CLAUDE.md "Mock all exports"). `hasInternalDB` keys on
// `process.env.DATABASE_URL` so toggling that env var is enough to drive
// the rule-lookup branch.
mock.module("@atlas/api/lib/auth/actor", () => ({
  loadActorUser: mockLoadActorUser,
}));

mock.module("@atlas/ee/governance/approval", () => ({
  anyApprovalRuleEnabled: mockAnyApprovalRuleEnabled,
}));

const { resolveMcpActor, MCP_BINDING_ERROR_MESSAGE, MCP_PARTIAL_BINDING_ERROR, MCP_USER_NOT_FOUND_ERROR } = await import("../actor.js");

describe("resolveMcpActor", () => {
  beforeEach(() => {
    setEnv("ATLAS_MCP_USER_ID", undefined);
    setEnv("ATLAS_MCP_ORG_ID", undefined);
    setEnv("DATABASE_URL", undefined);
    mockLoadActorUser.mockReset();
    mockAnyApprovalRuleEnabled.mockReset();
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
    expect(mockLoadActorUser).toHaveBeenCalledWith("u_123", "org_abc");
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

  it("unbound + no internal DB — returns system:mcp without rule lookup", async () => {
    // DATABASE_URL unset → hasInternalDB() is false → rule lookup is skipped.
    const actor = await resolveMcpActor();

    expect(actor.id).toBe("system:mcp");
    expect(mockAnyApprovalRuleEnabled).not.toHaveBeenCalled();
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
      // to `true`. Stub the dynamic import itself rejecting (a transient
      // load failure inside the EE bundle) — actor.ts catches and treats
      // as "rules exist", same fail-closed posture.
      Effect.die(new Error("DB connection refused")),
    );

    await expect(resolveMcpActor()).rejects.toThrow(MCP_BINDING_ERROR_MESSAGE);
  });
});
