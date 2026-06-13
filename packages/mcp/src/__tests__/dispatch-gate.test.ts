/**
 * #3508 — MCP dispatch gate-order pipeline (ADR-0016).
 *
 * Pins the gate order (scope → RBAC → approval) and each branch:
 *   - gate 2 (mcp:write scope) denies a hosted mcp:read-only caller and is
 *     checked BEFORE RBAC; stdio (no clientId) is exempt;
 *   - gate 3 (RBAC) denies a non-admin actor with a `forbidden` envelope;
 *   - gate 4 (approval) routes a destructive action through the approval
 *     gate keyed on origin=mcp, returning the `approval_required` body when a
 *     rule matches, proceeding when none matches / already approved, and
 *     failing closed when the gate is unavailable.
 *
 * Gate 4 uses an injected stub `ApprovalGateShape` (no EE layer needed). A
 * final end-to-end test drives a stub admin tool through a real MCP client
 * to prove a tool wires the pipeline correctly.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import type { AtlasUser, AtlasRole } from "@atlas/api/lib/auth/types";
import type { ApprovalGateShape } from "@atlas/api/lib/effect/services";
import type { ApprovalRequest } from "@useatlas/types";
import { parseAtlasMcpToolError } from "@useatlas/types/mcp";
import type { McpActionCategory } from "@useatlas/types/mcp";
import type { McpActionPolicy } from "@atlas/api/lib/mcp/action-policy";
import {
  runMcpDispatchGate,
  type McpDispatchGateContext,
  type McpDispatchGateRequirements,
} from "../dispatch-gate.js";

const ORG = "org_test";

function actor(role: AtlasRole | undefined): AtlasUser {
  return createAtlasUser("user_1", "managed", "u@example.com", {
    ...(role !== undefined ? { role } : {}),
    activeOrganizationId: ORG,
  });
}

function getContentText(content: unknown): string {
  const arr = content as Array<{ type: string; text: string }>;
  return arr[0]?.text ?? "";
}

/** A pending approval request fixture — only `id` is read by the pipeline. */
function pendingRequest(id: string): ApprovalRequest {
  return {
    id,
    orgId: ORG,
    ruleId: "rule_1",
    ruleName: "MCP destructive",
    requesterId: "user_1",
    requesterEmail: "u@example.com",
    querySql: "delete datasource prod",
    explanation: "delete datasource prod",
    connectionGroupId: null,
    tablesAccessed: ["datasource:prod"],
    columnsAccessed: [],
    origin: "mcp",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    status: "pending",
    reviewerId: null,
    reviewerEmail: null,
    reviewComment: null,
    reviewedAt: null,
  };
}

/**
 * Build a stub `ApprovalGateShape`. The pipeline only calls
 * checkApprovalRequired / hasApprovedRequest / createApprovalRequest; the
 * rest die loudly if a refactor starts depending on them.
 */
function stubApprovalGate(opts: {
  required: boolean;
  alreadyApproved?: boolean;
  matchedRules?: { id: string; name: string }[];
  onCreate?: () => void;
  /** Simulate a DB defect (Effect.promise rejection) during the check read. */
  checkThrows?: boolean;
  /** Simulate a DB defect during the already-approved read. */
  hasApprovedThrows?: boolean;
}): ApprovalGateShape {
  const unused = () => Effect.die(new Error("approval gate method not used in this test"));
  return {
    available: true,
    checkApprovalRequired: () =>
      opts.checkThrows
        ? Effect.die(new Error("member-table read failed"))
        : Effect.succeed({
            required: opts.required,
            matchedRules: (opts.matchedRules ?? [{ id: "rule_1", name: "MCP destructive" }]) as never,
          }),
    hasApprovedRequest: () =>
      opts.hasApprovedThrows
        ? Effect.die(new Error("approval_queue read failed"))
        : Effect.succeed(opts.alreadyApproved ?? false),
    createApprovalRequest: () => {
      opts.onCreate?.();
      return Effect.succeed(pendingRequest("req_stub"));
    },
    listApprovalRules: unused,
    createApprovalRule: unused,
    updateApprovalRule: unused,
    deleteApprovalRule: unused,
    listApprovalRequests: unused,
    getApprovalRequest: unused,
    reviewApprovalRequest: unused,
    expireStaleRequests: unused,
    getPendingCount: unused,
  };
}

const baseCtx = (over: Partial<McpDispatchGateContext> = {}): McpDispatchGateContext => ({
  actor: actor("admin"),
  clientId: "claude-desktop",
  scopes: ["mcp:read", "mcp:write"],
  orgId: ORG,
  requesterId: "user_1",
  requesterEmail: "u@example.com",
  ...over,
});

const adminReqs: McpDispatchGateRequirements = {
  toolName: "stub_admin",
  requiresWrite: true,
  minRole: "admin",
};

/** Stub gate-1 policy: blocks exactly the listed categories. */
function stubActionPolicy(blocked: McpActionCategory[]): McpActionPolicy {
  const set = new Set<string>(blocked);
  return { isBlocked: (c) => set.has(c) };
}

/** Admin reqs that also carry a gate-1 action category. */
const datasourceReqs: McpDispatchGateRequirements = {
  ...adminReqs,
  toolName: "createDatasource",
  actionCategory: "datasource",
};

describe("runMcpDispatchGate — gate order + branches (#3508)", () => {
  it("gate 2: denies a hosted mcp:read-only caller (forbidden)", async () => {
    const res = await runMcpDispatchGate(baseCtx({ scopes: ["mcp:read"] }), adminReqs);
    expect(res?.isError).toBe(true);
    const env = parseAtlasMcpToolError(getContentText(res?.content));
    expect(env?.code).toBe("forbidden");
    expect(env?.message).toContain("mcp:write");
  });

  it("gate 3: denies a non-admin actor at RBAC (forbidden)", async () => {
    const res = await runMcpDispatchGate(baseCtx({ actor: actor("member") }), adminReqs);
    expect(res?.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res?.content))?.code).toBe("forbidden");
    expect(getContentText(res?.content)).toContain("admin");
  });

  it("order: scope is checked BEFORE RBAC (no-scope + non-admin → scope denial)", async () => {
    // A non-admin with NO mcp:write must be denied at gate 2 (scope), whose
    // message mentions mcp:write — proving scope runs before RBAC.
    const res = await runMcpDispatchGate(
      baseCtx({ actor: actor("member"), scopes: ["mcp:read"] }),
      adminReqs,
    );
    expect(parseAtlasMcpToolError(getContentText(res?.content))?.message).toContain("mcp:write");
  });

  it("stdio (no clientId) is scope-exempt but still RBAC-gated", async () => {
    // No clientId → gate 2 skipped; a member still fails gate 3.
    const denied = await runMcpDispatchGate(
      baseCtx({ clientId: undefined, scopes: undefined, actor: actor("member") }),
      adminReqs,
    );
    expect(parseAtlasMcpToolError(getContentText(denied?.content))?.code).toBe("forbidden");
    // An admin over stdio clears scope (exempt) + RBAC + non-destructive → proceeds.
    const ok = await runMcpDispatchGate(
      baseCtx({ clientId: undefined, scopes: undefined, actor: actor("admin") }),
      adminReqs,
    );
    expect(ok).toBeNull();
  });

  it("non-destructive admin tool clears all gates → proceeds (null)", async () => {
    const res = await runMcpDispatchGate(baseCtx(), adminReqs);
    expect(res).toBeNull();
  });

  it("gate 4: destructive action routes through approval when an origin=mcp rule matches", async () => {
    let created = false;
    const res = await runMcpDispatchGate(
      baseCtx(),
      { ...adminReqs, destructive: { resource: "datasource:prod", description: "delete datasource prod" } },
      { loadApprovalGate: async () => stubApprovalGate({ required: true, onCreate: () => { created = true; } }) },
    );
    expect(res?.isError).toBeFalsy();
    const body = JSON.parse(getContentText(res?.content));
    expect(body.approval_required).toBe(true);
    expect(body.approval_request_id).toBe("req_stub");
    expect(body.matched_rules).toContain("MCP destructive");
    expect(created).toBe(true);
  });

  it("gate 4: destructive action proceeds when no origin=mcp rule matches", async () => {
    const res = await runMcpDispatchGate(
      baseCtx(),
      { ...adminReqs, destructive: { resource: "datasource:prod", description: "delete datasource prod" } },
      { loadApprovalGate: async () => stubApprovalGate({ required: false }) },
    );
    expect(res).toBeNull();
  });

  it("gate 4: proceeds (no new request) when the requester was already approved", async () => {
    let created = false;
    const res = await runMcpDispatchGate(
      baseCtx(),
      { ...adminReqs, destructive: { resource: "datasource:prod", description: "delete datasource prod" } },
      { loadApprovalGate: async () => stubApprovalGate({ required: true, alreadyApproved: true, onCreate: () => { created = true; } }) },
    );
    expect(res).toBeNull();
    expect(created).toBe(false);
  });

  it("gate 4: fails closed (internal_error) when the approval gate is unavailable", async () => {
    const res = await runMcpDispatchGate(
      baseCtx(),
      { ...adminReqs, destructive: { resource: "datasource:prod", description: "delete datasource prod" } },
      { loadApprovalGate: async () => { throw new Error("EE layer not bound"); } },
    );
    expect(res?.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res?.content))?.code).toBe("internal_error");
  });

  it("gate 4: fails closed when checkApprovalRequired throws (DB defect, not just gate-load)", async () => {
    const res = await runMcpDispatchGate(
      baseCtx(),
      { ...adminReqs, destructive: { resource: "datasource:prod", description: "delete datasource prod" } },
      { loadApprovalGate: async () => stubApprovalGate({ required: true, checkThrows: true }) },
    );
    expect(res?.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res?.content))?.code).toBe("internal_error");
  });

  it("gate 4: fails closed when hasApprovedRequest throws (DB defect)", async () => {
    const res = await runMcpDispatchGate(
      baseCtx(),
      { ...adminReqs, destructive: { resource: "datasource:prod", description: "delete datasource prod" } },
      { loadApprovalGate: async () => stubApprovalGate({ required: true, hasApprovedThrows: true }) },
    );
    expect(res?.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res?.content))?.code).toBe("internal_error");
  });

  it("gate 4: denies a destructive action with no bound identity (guard runs before the approval check)", async () => {
    let checked = false;
    const res = await runMcpDispatchGate(
      baseCtx({ orgId: undefined }),
      { ...adminReqs, destructive: { resource: "datasource:prod", description: "delete datasource prod" } },
      { loadApprovalGate: async () => stubApprovalGate({ required: false, onCreate: () => { checked = true; } }) },
    );
    expect(res?.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res?.content))?.code).toBe("forbidden");
    expect(checked).toBe(false); // never reached the gate
  });
});

describe("runMcpDispatchGate — gate 1: MCP action policy kill-switch (#3509)", () => {
  it("blocks a tool whose action category is disabled for the workspace (forbidden)", async () => {
    const res = await runMcpDispatchGate(baseCtx(), datasourceReqs, {
      loadActionPolicy: async () => stubActionPolicy(["datasource"]),
    });
    expect(res?.isError).toBe(true);
    const env = parseAtlasMcpToolError(getContentText(res?.content));
    expect(env?.code).toBe("forbidden");
    expect(env?.message).toContain("datasource");
    expect(env?.message).toContain("disabled");
  });

  it("short-circuits BEFORE scope: a blocked category denies even a no-scope caller without a mcp:write message", async () => {
    // A hosted mcp:read-only caller would normally fail gate 2 (scope) with a
    // message mentioning mcp:write. With the category blocked, the gate-1
    // denial fires first — proving order. The message must NOT mention
    // mcp:write (that would mean gate 2 ran first).
    const res = await runMcpDispatchGate(
      baseCtx({ scopes: ["mcp:read"] }),
      datasourceReqs,
      { loadActionPolicy: async () => stubActionPolicy(["datasource"]) },
    );
    const env = parseAtlasMcpToolError(getContentText(res?.content));
    expect(env?.code).toBe("forbidden");
    expect(env?.message).not.toContain("mcp:write");
    expect(env?.message).toContain("datasource");
  });

  it("proceeds to the next gates when the category is NOT blocked (admin + write → null)", async () => {
    const res = await runMcpDispatchGate(baseCtx(), datasourceReqs, {
      loadActionPolicy: async () => stubActionPolicy(["integration"]),
    });
    expect(res).toBeNull();
  });

  it("lets a downstream gate still deny an unblocked category (gate 1 isn't the only gate)", async () => {
    // Category allowed, but a member fails gate 3 — gate 1 passing doesn't
    // shadow the RBAC denial.
    const res = await runMcpDispatchGate(
      baseCtx({ actor: actor("member") }),
      datasourceReqs,
      { loadActionPolicy: async () => stubActionPolicy([]) },
    );
    expect(parseAtlasMcpToolError(getContentText(res?.content))?.code).toBe("forbidden");
    expect(getContentText(res?.content)).toContain("admin");
  });

  it("fails closed (internal_error) when the policy lookup throws", async () => {
    const res = await runMcpDispatchGate(baseCtx(), datasourceReqs, {
      loadActionPolicy: async () => {
        throw new Error("policy table read failed");
      },
    });
    expect(res?.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res?.content))?.code).toBe("internal_error");
  });

  it("is a no-op for tools that declare no action category (existing tools unaffected)", async () => {
    let consulted = false;
    const res = await runMcpDispatchGate(baseCtx(), adminReqs, {
      loadActionPolicy: async () => {
        consulted = true;
        return stubActionPolicy(["datasource"]);
      },
    });
    expect(res).toBeNull();
    expect(consulted).toBe(false); // no category ⇒ gate 1 skipped entirely
  });

  it("is a no-op (skipped) when there is no bound workspace (orgId undefined)", async () => {
    // No workspace ⇒ no per-workspace policy to consult; later gates enforce
    // identity. With an admin + write + non-destructive reqs, the call proceeds.
    let consulted = false;
    const res = await runMcpDispatchGate(
      baseCtx({ orgId: undefined }),
      datasourceReqs,
      {
        loadActionPolicy: async () => {
          consulted = true;
          return stubActionPolicy(["datasource"]);
        },
      },
    );
    expect(consulted).toBe(false);
    expect(res).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a stub admin tool wired through the pipeline + a real client.
// ---------------------------------------------------------------------------

async function clientForStubAdminTool(ctx: McpDispatchGateContext): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  server.registerTool(
    "stub_admin",
    { title: "Stub admin tool", description: "No-op admin tool gated by the dispatch pipeline.", inputSchema: {} },
    async () => {
      const denied = await runMcpDispatchGate(ctx, adminReqs);
      if (denied) return denied;
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
    },
  );
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  return client;
}

describe("stub admin tool through the pipeline (#3508 e2e)", () => {
  it("denies a non-admin caller at RBAC", async () => {
    const client = await clientForStubAdminTool(baseCtx({ actor: actor("member") }));
    const res = await client.callTool({ name: "stub_admin", arguments: {} });
    expect(res.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("forbidden");
  });

  it("allows an admin with mcp:write", async () => {
    const client = await clientForStubAdminTool(baseCtx());
    const res = await client.callTool({ name: "stub_admin", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(getContentText(res.content)).toContain('"ok":true');
  });
});
