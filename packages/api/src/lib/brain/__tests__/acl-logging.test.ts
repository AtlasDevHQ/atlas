/**
 * The "log" half of #4768's first acceptance criterion — "unknown/malformed
 * grant ⇒ row invisible **and logged**, never visible" (ADR-0036 §Access
 * control).
 *
 * Split into its own file because it needs `mock.module("@atlas/api/lib/logger")`
 * installed before the module under test is imported, and the sibling files
 * deliberately run without any module mocking at all.
 *
 * Why this file exists rather than trusting the log calls to stay put: every
 * `log.warn` in `acl.ts` could be deleted and the other two suites would stay
 * green, because the ENFORCEMENT is structural (a `(FALSE)` clause, an empty
 * token set) and entirely independent of the reporting. The most consequential
 * line is the audit-override one: that log is the ONLY artifact of a
 * workspace-wide grant bypass, and an unlogged privilege escalation is exactly
 * the failure "deny + log" is written to prevent.
 *
 * Spy installed via `mock.module` before the dynamic import, mirroring
 * `lib/__tests__/config-deploy-mode-warning.test.ts` (which mocks only the
 * four exports its own graph touches). Every VALUE export of `lib/logger.ts`
 * is stubbed here instead, per the mock-all-exports rule: a partial factory
 * works right up until some module in the import graph reaches one of the
 * missing names, and then fails at link time with `Export named 'X' not found`
 * in a file that has nothing to do with this one.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const logCalls: LogCall[] = [];

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    error: (payload: unknown, message: string) => logCalls.push({ level: "error", payload, message }),
    warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
    info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
    debug: (payload: unknown, message: string) => logCalls.push({ level: "debug", payload, message }),
  }),
  getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, level: "info" }),
  setLogLevel: () => true,
  getRequestContext: () => undefined,
  // The rest of lib/logger.ts's value exports. Unused by this file's graph
  // today; present so widening that graph can't break the link.
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (obj: unknown) => obj,
  hashShareToken: (token: string) => token,
}));

const {
  aclVisibilityClause,
  isVisibleTo,
  logGrantAnomalies,
  resolvePrincipalContext,
  impliedRoles,
} = await import("@atlas/api/lib/brain/acl");
type BrainPrincipalContext = Awaited<ReturnType<typeof resolvePrincipalContext>>;

const WS = "ws-acl-log";

function ctx(partial: Partial<Extract<BrainPrincipalContext, { origin: "authenticated" }>> = {}) {
  return {
    origin: "authenticated" as const,
    workspaceId: WS,
    userId: "user-1",
    role: "member" as const,
    audienceIds: [] as readonly string[],
    ...partial,
  };
}

const warns = () => logCalls.filter((c) => c.level === "warn");
const payloads = () => warns().map((c) => c.payload as Record<string, unknown>);

beforeEach(() => {
  logCalls.length = 0;
});

describe("reader-side denies are logged (#4768)", () => {
  it("logs when an unresolved reader is denied, and says an override was attempted", () => {
    const clause = aclVisibilityClause(
      { origin: "unresolved", workspaceId: WS, userId: null, role: null, audienceIds: [] },
      { table: "brain_facts", paramIndex: 1, override: { reason: "sneaky" }, requestId: "req-9" },
    );
    expect(clause.decision).toBe("deny-all");
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.message).toContain("identity could not be resolved");
    // Attempted privilege escalation must be visible in the deny line —
    // otherwise an operator reading it cannot tell that somebody also tried to
    // invoke a workspace-wide ACL bypass.
    expect(payloads()[0]).toMatchObject({
      overrideRequested: true,
      requestId: "req-9",
      table: "brain_facts",
    });
  });

  it("logs when a context carries no workspace, with the request id", () => {
    aclVisibilityClause(ctx({ workspaceId: "" }), {
      table: "brain_episodes",
      paramIndex: 1,
      requestId: "req-10",
    });
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.message).toContain("no workspace");
    expect(payloads()[0]).toMatchObject({ requestId: "req-10", overrideRequested: false });
  });

  it("logs when a reader is asked about a row outside their workspace", () => {
    expect(
      isVisibleTo({ table: "brain_facts", workspaceId: "other-ws", visibleTo: ["org"] }, ctx()),
    ).toBe(false);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.message).toContain("outside the reader's workspace");
    expect(payloads()[0]).toMatchObject({ rowWorkspaceId: "other-ws", readerWorkspaceId: WS });
  });

  it("does not log on the ordinary allow and deny paths", () => {
    // A grant that simply doesn't match is not an anomaly — logging it would
    // make the signal useless at any real read volume.
    expect(
      isVisibleTo({ table: "brain_facts", workspaceId: WS, visibleTo: ["role:admin"] }, ctx()),
    ).toBe(false);
    expect(
      isVisibleTo({ table: "brain_facts", workspaceId: WS, visibleTo: ["org"] }, ctx()),
    ).toBe(true);
    aclVisibilityClause(ctx(), { table: "brain_facts", paramIndex: 1 });
    expect(warns()).toHaveLength(0);
  });

  it("logs an unknown org role instead of throwing an unattributed TypeError", () => {
    expect(impliedRoles("superuser" as unknown as "owner")).toEqual([]);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.message).toContain("unknown org role");
  });
});

describe("the audit override is always recorded (#4768)", () => {
  it("logs every granted override with actor, workspace, and reason", () => {
    const clause = aclVisibilityClause(ctx({ role: "admin" }), {
      table: "brain_episodes",
      paramIndex: 1,
      override: { reason: "GDPR subject access request" },
      requestId: "req-11",
    });
    expect(clause.decision).toBe("audit-override");
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.message).toContain("per-grant visibility bypassed");
    expect(payloads()[0]).toMatchObject({
      table: "brain_episodes",
      workspaceId: WS,
      userId: "user-1",
      role: "admin",
      reason: "GDPR subject access request",
      requestId: "req-11",
    });
  });

  it("logs every refused override too", () => {
    aclVisibilityClause(ctx({ role: "member" }), {
      table: "brain_facts",
      paramIndex: 1,
      override: { reason: "let me in" },
    });
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.message).toContain("audit override refused");
    expect(payloads()[0]).toMatchObject({ reason: "let me in", role: "member" });
  });
});

describe("stored-side grant anomalies are logged (#4768)", () => {
  it("logs the malformed tokens of a grant that otherwise passes", () => {
    // The case that actually bites: `['user:abc', 'everyone']` passes the
    // predicate on its valid token while the author believed `everyone` was
    // doing something.
    logGrantAnomalies(["user:abc", "everyone"], {
      table: "brain_facts",
      rowId: "fact-1",
      workspaceId: WS,
      requestId: "req-12",
    });
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.message).toContain("outside the grammar");
    expect(payloads()[0]).toMatchObject({
      rowId: "fact-1",
      malformed: ["everyone"],
      usablePrincipals: 1,
      requestId: "req-12",
    });
  });

  it("stays silent on a clean grant", () => {
    logGrantAnomalies(["org", "user:abc"], {
      table: "brain_facts",
      rowId: "fact-2",
      workspaceId: WS,
    });
    expect(warns()).toHaveLength(0);
  });
});

describe("resolution-side anomalies are logged (#4768)", () => {
  const db = { query: async () => ({ rows: [] as unknown[] }) };

  it("logs an authenticated request with no user id", async () => {
    const resolved = await resolvePrincipalContext(db, {
      workspaceId: WS,
      mode: "managed",
      userId: undefined,
      resolvedRole: { role: "admin", orgId: WS },
      requestId: "req-13",
    });
    expect(resolved.origin).toBe("unresolved");
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.message).toContain("no user id");
    expect(payloads()[0]).toMatchObject({ requestId: "req-13" });
  });

  it("logs a role resolved against a different org than the read target", async () => {
    const resolved = await resolvePrincipalContext(db, {
      workspaceId: WS,
      mode: "managed",
      userId: "user-1",
      resolvedRole: { role: "owner", orgId: "some-other-org" },
      requestId: "req-14",
    });
    expect(resolved.role).toBeNull();
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.message).toContain("different org than the read target");
    expect(payloads()[0]).toMatchObject({
      roleResolvedForOrgId: "some-other-org",
      workspaceId: WS,
    });
  });

  it("logs when audience rows are dropped by narrowing", async () => {
    // `audience_id` is `text NOT NULL`, so a dropped row can only mean the
    // query or the row shape changed. Silently returning fewer memberships
    // would strip a reader's audience grants with no signal — the same silent
    // downgrade this function refuses to perform on a DB error.
    const drifted = { query: async () => ({ rows: [{ aud: "eng" }, { audience_id: "exec" }] }) };
    const resolved = await resolvePrincipalContext(drifted, {
      workspaceId: WS,
      mode: "managed",
      userId: "user-1",
      resolvedRole: { role: "member", orgId: WS },
      requestId: "req-15",
    });
    expect(resolved.audienceIds).toEqual(["exec"]);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.message).toContain("membership query shape changed");
    expect(payloads()[0]).toMatchObject({ returned: 2, usable: 1, requestId: "req-15" });
  });

  it("logs an unrecognised principal origin", () => {
    const rogue = { ...ctx(), origin: "service" } as unknown as Parameters<
      typeof aclVisibilityClause
    >[0];
    expect(aclVisibilityClause(rogue, { table: "brain_facts", paramIndex: 1 }).decision).toBe(
      "deny-all",
    );
    // Two lines: the `principalTokens` default, then the clause's own backstop
    // — which is the arm that makes an out-of-union origin observable at all.
    expect(warns().map((w) => w.message)).toEqual([
      expect.stringContaining("unrecognised principal origin"),
      expect.stringContaining("resolved to no principals"),
    ]);
  });

  it("logs an unrecognised auth mode", async () => {
    const resolved = await resolvePrincipalContext(db, {
      workspaceId: WS,
      mode: "quantum" as unknown as "managed",
      userId: "user-1",
      resolvedRole: undefined,
    });
    expect(resolved.origin).toBe("unresolved");
    expect(warns()[0]!.message).toContain("unrecognised auth mode");
  });
});
