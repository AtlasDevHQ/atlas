/**
 * #3044 — the Python sandbox egress allowlist must stay in lockstep with the
 * agent's in-scope REST datasources. `defaultResolveRestDatasource` reads the
 * request's `connectionGroupId` and threads it as `activeGroupId` into the
 * primary resolver, so a datasource scoped to a different environment group is
 * unreachable from Python too.
 *
 * The `?? null` is load-bearing: passing `undefined` (the omitted-arg path) would
 * DISABLE scoping in the resolver and re-leak the datasource — the exact bug
 * #3044 closes. This pins that the egress path always passes a defined value.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

// Controllable request context (default: none).
let mockReqCtx:
  | {
      user?: { activeOrganizationId?: string };
      connectionGroupId?: string;
      connectionId?: string;
      restExcludedDatasourceIds?: readonly string[];
    }
  | undefined;

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  getRequestContext: () => mockReqCtx,
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_n: string, _a: unknown, fn: () => Promise<unknown>) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

// The connection→group inference: a connection in `prod` resolves to it, an
// `ungrouped-conn` resolves to no group.
mock.module("@atlas/api/lib/env-routing/lookup", () => ({
  loadGroupRoutingContext: async (_orgId: string | undefined, currentMember: string) =>
    currentMember === "ungrouped-conn"
      ? { members: ["ungrouped-conn"], primaryMember: "ungrouped-conn", currentMember }
      : { groupId: "prod", members: [currentMember], primaryMember: currentMember, currentMember },
}));

// Capture how the egress path calls the primary resolver. Mock every export the
// import graph could touch (CLAUDE.md "Mock all exports").
let primaryCalls: Array<{ orgId: string; deps: unknown }> = [];
mock.module("@atlas/api/lib/openapi/workspace-datasource", () => ({
  resolveWorkspacePrimaryRestDatasource: async (orgId: string, deps: unknown) => {
    primaryCalls.push({ orgId, deps });
    return null;
  },
  resolveWorkspaceRestDatasources: async () => [],
  resolveWorkspaceRestDatasourcesOrThrow: async () => [],
  defaultQuery: async () => [],
  RestDatasourceReconnectError: class extends Error {},
}));

const { defaultResolveRestDatasource } = await import("../python");

describe("defaultResolveRestDatasource — env-scope lockstep (#3044)", () => {
  beforeEach(() => {
    mockReqCtx = undefined;
    primaryCalls = [];
  });

  it("threads the conversation's connectionGroupId as activeGroupId", async () => {
    mockReqCtx = { user: { activeOrganizationId: "org-1" }, connectionGroupId: "eu" };
    await defaultResolveRestDatasource();
    expect(primaryCalls).toHaveLength(1);
    expect(primaryCalls[0]!.orgId).toBe("org-1");
    expect(primaryCalls[0]!.deps).toEqual({ activeGroupId: "eu" });
  });

  it("infers the active group from connectionId when connectionGroupId is omitted", async () => {
    mockReqCtx = { user: { activeOrganizationId: "org-1" }, connectionId: "us-prod" };
    await defaultResolveRestDatasource();
    expect(primaryCalls[0]!.deps).toEqual({ activeGroupId: "prod" });
  });

  it("passes activeGroupId: null (NOT undefined) when the connection resolves to no group", async () => {
    mockReqCtx = { user: { activeOrganizationId: "org-1" }, connectionId: "ungrouped-conn" };
    await defaultResolveRestDatasource();
    expect(primaryCalls[0]!.deps).toEqual({ activeGroupId: null });
    // The distinction is load-bearing: `undefined` would disable scoping in the
    // resolver and re-leak a scoped datasource into the sandbox egress allowlist.
    expect((primaryCalls[0]!.deps as { activeGroupId: unknown }).activeGroupId).not.toBeUndefined();
  });

  it("passes activeGroupId: null when there is no group and no connection to infer from", async () => {
    mockReqCtx = { user: { activeOrganizationId: "org-1" } };
    await defaultResolveRestDatasource();
    expect(primaryCalls[0]!.deps).toEqual({ activeGroupId: null });
  });

  it("returns null without resolving when there is no active org", async () => {
    mockReqCtx = { connectionGroupId: "eu" };
    const result = await defaultResolveRestDatasource();
    expect(result).toBeNull();
    expect(primaryCalls).toHaveLength(0);
  });

  // #3066 — the sandbox egress allowlist must honour the conversation's REST
  // exclude-set too, or Python could probe a datasource the conversation
  // excluded (if it's the workspace primary).
  it("threads the conversation's REST exclude-set into the egress resolver (#3066)", async () => {
    mockReqCtx = {
      user: { activeOrganizationId: "org-1" },
      connectionGroupId: "eu",
      restExcludedDatasourceIds: ["ds-excluded"],
    };
    await defaultResolveRestDatasource();
    expect(primaryCalls[0]!.deps).toEqual({ activeGroupId: "eu", excluded: ["ds-excluded"] });
  });

  it("omits `excluded` when the conversation has no exclude-set (#3066)", async () => {
    mockReqCtx = { user: { activeOrganizationId: "org-1" }, connectionGroupId: "eu" };
    await defaultResolveRestDatasource();
    // No `excluded` key — the resolver excludes nothing for egress.
    expect(primaryCalls[0]!.deps).toEqual({ activeGroupId: "eu" });
  });
});
