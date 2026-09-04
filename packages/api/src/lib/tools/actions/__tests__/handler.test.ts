import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  handleAction,
  approveActionAsUser,
  denyActionAsUser,
  redispatchActionAsUser,
  approveAction,
  denyAction,
  rollbackAction,
  getAction,
  listPendingActions,
  buildActionRequest,
  getActionConfig,
  extractRollbackInfo,
  registerRollbackMethod,
  getRollbackMethod,
  defineActionExecutor,
  getActionExecutorForType,
  _resetActionExecutors,
  _undefineActionExecutor,
  _resetActionStore,
  ActionTimeoutError,
  type ActionExecutor,
  type ActionExecutionContext,
} from "../handler";
import type { ActionRequest, ActionToolResult } from "@atlas/api/lib/action-types";
import {
  loadConfig,
  _resetConfig,
  _setConfigForTest,
  type ResolvedConfig,
  type ActionsConfig,
} from "@atlas/api/lib/config";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { withRequestContext } from "@atlas/api/lib/logger";
import { _resetPool } from "@atlas/api/lib/db/internal";

/**
 * Register how `request`'s TYPE executes, then run it — the two halves
 * production does at module load and at request time respectively (#5570).
 *
 * `handleAction` takes no executor any more: the registry is keyed by
 * `action_type` and populated when the action's module loads, so any instance
 * can execute any approved row. These suites have no action module to load, so
 * they stage the registration themselves, right where the old `executeFn`
 * argument used to sit.
 */
function runAction(
  request: ActionRequest,
  executor: ActionExecutor,
  opts?: { conversationId?: string },
): Promise<ActionToolResult> {
  defineActionExecutor(request.actionType, executor);
  return handleAction(request, opts);
}

/**
 * Action handler tests — memory-only path (no DATABASE_URL).
 *
 * We delete DATABASE_URL and reset the pg pool so hasInternalDB() returns
 * false. All persistence goes through the in-memory Map fallback.
 */

const origDbUrl = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Shared fixtures for the resolution-verb and execution-context suites below
// (both formerly separate files; see their provenance headers).
// ---------------------------------------------------------------------------
const admin = createAtlasUser("admin-1", "simple-key", "admin@test.com", { role: "admin" });
const member = createAtlasUser("member-1", "simple-key", "member@test.com", { role: "member" });
// "admin-only" is a legacy name — it requires the OWNER role (permissions.ts).
const owner = createAtlasUser("owner-1", "simple-key", "owner@test.com", { role: "owner" });
// A SECOND owner, so an admin-only action requested by `owner` can still be
// approved by somebody — the separation-of-duties bar rules out only the
// requester, not the role.
const owner2 = createAtlasUser("owner-2", "simple-key", "owner2@test.com", { role: "owner" });

function setActions(actions: ActionsConfig): void {
  _setConfigForTest({
    datasources: {},
    tools: [],
    auth: "none",
    semanticLayer: "./semantic",
    maxTotalConnections: 20,
    actions,
    source: "env",
  } as ResolvedConfig);
}

async function seedPending(actionType: string, requestedBy: string): Promise<string> {
  const req = buildActionRequest({
    actionType,
    target: `target-${Math.random()}`,
    summary: "Test action",
    payload: {},
    reversible: false,
  });
  // Registered by TYPE, as an action module does at load (#5570).
  defineActionExecutor(actionType, async () => "done");
  await withRequestContext(
    { requestId: "req-seed", user: { id: requestedBy, label: `${requestedBy}@test.com`, mode: "simple-key" } },
    () => handleAction(req),
  );
  return req.id;
}

const REQUESTER_ORG = "org-tenant-a";
const APPROVER_ORG = "org-tenant-b";

function requester(orgId: string | null) {
  return {
    requestId: "req-requester",
    user: {
      id: "u-requester",
      label: "analyst@tenant-a.example",
      mode: "managed" as const,
      ...(orgId ? { activeOrganizationId: orgId } : {}),
    },
  };
}

function newRequest() {
  return buildActionRequest({
    actionType: "jira:create",
    target: "PROJ",
    summary: "Create JIRA ticket",
    payload: { summary: "s", description: "d" },
    reversible: true,
  });
}

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.ATLAS_ACTIONS_ENABLED;
  delete process.env.ATLAS_ACTION_APPROVAL;
  delete process.env.ATLAS_ACTION_TIMEOUT;
  _resetPool(null);
  _resetActionStore();
  _resetConfig();
});

afterEach(() => {
  delete process.env.ATLAS_ACTIONS_ENABLED;
  delete process.env.ATLAS_ACTION_APPROVAL;
  delete process.env.ATLAS_ACTION_TIMEOUT;
  if (origDbUrl) {
    process.env.DATABASE_URL = origDbUrl;
  } else {
    delete process.env.DATABASE_URL;
  }
  _resetPool(null);
  _resetActionStore();
  _resetConfig();
});

// ---------------------------------------------------------------------------
// buildActionRequest
// ---------------------------------------------------------------------------

describe("buildActionRequest()", () => {
  it("returns a request with UUID id and all fields", () => {
    const request = buildActionRequest({
      actionType: "slack:send",
      target: "#general",
      summary: "Send greeting to #general",
      payload: { channel: "C123", text: "Hello" },
      reversible: false,
    });

    expect(request.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(request.actionType).toBe("slack:send");
    expect(request.target).toBe("#general");
    expect(request.summary).toBe("Send greeting to #general");
    expect(request.payload).toEqual({ channel: "C123", text: "Hello" });
    expect(request.reversible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleAction — manual (default)
// ---------------------------------------------------------------------------

describe("handleAction()", () => {
  it("returns pending when approval mode is manual (default)", async () => {
    const request = buildActionRequest({
      actionType: "slack:send",
      target: "#general",
      summary: "Send message",
      payload: { text: "hi" },
      reversible: false,
    });

    const result = await withRequestContext(
      { requestId: "req-1", user: { id: "u1", label: "user@test.com", mode: "managed" } },
      () => runAction(request, async () => "done"),
    );

    expect(result.status).toBe("pending");
    expect(result.actionId).toBe(request.id);
    if (result.status === "pending") {
      expect(result.summary).toBe("Send message");
    }
  });

  it("auto-approves and executes when config sets auto approval", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "auto";
    await loadConfig("/tmp/handler-test-nonexistent");

    const request = buildActionRequest({
      actionType: "slack:send",
      target: "#general",
      summary: "Send message",
      payload: { text: "hi" },
      reversible: false,
    });

    const result = await withRequestContext(
      { requestId: "req-2", user: { id: "u1", label: "user@test.com", mode: "managed" } },
      () => runAction(request, async (payload) => ({ sent: true, text: payload.text })),
    );

    expect(result.status).toBe("auto_approved");
    expect(result.actionId).toBe(request.id);
    if (result.status === "auto_approved") {
      expect(result.result).toEqual({ sent: true, text: "hi" });
    }
  });

  it("returns error when auto-approve execution throws", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "auto";
    await loadConfig("/tmp/handler-test-nonexistent");

    const request = buildActionRequest({
      actionType: "slack:send",
      target: "#general",
      summary: "Send message",
      payload: { text: "hi" },
      reversible: false,
    });

    const result = await withRequestContext(
      { requestId: "req-3", user: { id: "u1", label: "user@test.com", mode: "managed" } },
      () =>
        runAction(request, async () => {
          throw new Error("Slack API down");
        }),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("Slack API down");
    }
  });

  it("persists the action to the in-memory store", async () => {
    const request = buildActionRequest({
      actionType: "test:action",
      target: "target-1",
      summary: "Test action",
      payload: { key: "val" },
      reversible: true,
    });

    await withRequestContext(
      { requestId: "req-4", user: { id: "u2", label: "admin@test.com", mode: "simple-key" } },
      () => runAction(request, async () => "ok"),
    );

    const stored = await getAction(request.id);
    expect(stored).not.toBeNull();
    expect(stored!.action_type).toBe("test:action");
    expect(stored!.status).toBe("pending");
    expect(stored!.requested_by).toBe("u2");
    expect(stored!.auth_mode).toBe("simple-key");
  });
});

// ---------------------------------------------------------------------------
// approveAction
// ---------------------------------------------------------------------------

describe("approveAction()", () => {
  it("approves a pending action and executes the function", async () => {
    const request = buildActionRequest({
      actionType: "slack:send",
      target: "#general",
      summary: "Send message",
      payload: { text: "hi" },
      reversible: false,
    });

    await withRequestContext({ requestId: "req-5" }, () =>
      runAction(request, async (payload) => ({ sent: true, text: payload.text })),
    );

    defineActionExecutor(request.actionType, async (payload) => ({ sent: true, text: payload.text }));
    const result = await approveAction(request.id, "admin-1");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("executed");
    expect(result!.approved_by).toBe("admin-1");
    expect(result!.result).toEqual({ sent: true, text: "hi" });
    expect(result!.executed_at).not.toBeNull();
  });

  it("returns null for an already-resolved action (CAS)", async () => {
    const request = buildActionRequest({
      actionType: "slack:send",
      target: "#general",
      summary: "Send message",
      payload: { text: "hi" },
      reversible: false,
    });

    await withRequestContext({ requestId: "req-6" }, () =>
      runAction(request, async () => "done"),
    );

    // First approval succeeds
    defineActionExecutor(request.actionType, async () => "ok");
    const first = await approveAction(request.id, "admin-1");
    expect(first).not.toBeNull();

    // Second approval fails (CAS — status is no longer "pending")
    defineActionExecutor(request.actionType, async () => "ok again");
    const second = await approveAction(request.id, "admin-2");
    expect(second).toBeNull();
  });

  it("returns failed entry when executor throws during approval", async () => {
    const request = buildActionRequest({
      actionType: "slack:send",
      target: "#general",
      summary: "Send message",
      payload: { text: "hi" },
      reversible: false,
    });

    await withRequestContext({ requestId: "req-7" }, () =>
      runAction(request, async () => "done"),
    );

    defineActionExecutor(request.actionType, async () => {
      throw new Error("execution failed");
    });
    const result = await approveAction(request.id, "admin-1");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("failed");
    expect(result!.error).toBe("execution failed");
  });

  it("executes with the type's registered executor — the caller supplies none", async () => {
    // The post-#5570 contract: `approveAction` looks the executor up by the
    // ROW's `action_type`, so a caller that never saw the request (a route
    // handler, another instance) needs to pass nothing.
    const request = buildActionRequest({
      actionType: "registered:action",
      target: "target",
      summary: "Test",
      payload: { n: 1 },
      reversible: false,
    });

    await withRequestContext({ requestId: "req-8" }, () =>
      runAction(request, async (payload) => ({ ran: true, n: payload.n })),
    );

    const result = await approveAction(request.id, "admin-1");
    expect(result!.status).toBe("executed");
    expect(result!.result).toEqual({ ran: true, n: 1 });
  });

  it("⭐ executes a row seeded before a RESTART — the gap #5570 closes", async () => {
    // The whole point of the type-keyed registry. `_resetActionExecutors`
    // drops every registration while leaving the rows, which is what a
    // process restart (or an approval landing on an instance that never took
    // the request) looks like from the handler's side. Under the old per-id
    // Map the lookup missed here and the row was stranded at `approved`
    // forever; under a type-keyed registry the action module re-registers at
    // boot and the row executes normally.
    const request = buildActionRequest({
      actionType: "restart:action",
      target: "target",
      summary: "Survives a restart",
      payload: { text: "hi" },
      reversible: false,
    });

    await withRequestContext({ requestId: "req-8b" }, () =>
      runAction(request, async () => "first process"),
    );

    _resetActionExecutors();
    expect(getActionExecutorForType("restart:action")).toBeUndefined();

    // Boot: the action's module loads and registers its type again.
    defineActionExecutor("restart:action", async (payload) => ({ text: payload.text }));

    const result = await approveAction(request.id, "admin-1");
    expect(result!.status).toBe("executed");
    expect(result!.result).toEqual({ text: "hi" });
  });

  it("approves WITHOUT executing when nothing registered the row's type", async () => {
    // The residual window the `approved_not_executed` outcome still names:
    // the row's type has no executor here at all (actions disabled on this
    // deploy, a plugin that failed to wire). The CAS still lands, so the row
    // leaves `pending` and sits at `approved` — recoverable only through the
    // admin re-dispatch verb.
    const request = buildActionRequest({
      actionType: "no-executor:action",
      target: "target",
      summary: "Test",
      payload: {},
      reversible: false,
    });

    await withRequestContext({ requestId: "req-8c" }, () =>
      runAction(request, async () => "done"),
    );
    _undefineActionExecutor("no-executor:action");

    const result = await approveAction(request.id, "admin-1");
    expect(result!.status).toBe("approved");
    expect(result!.executed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// denyAction
// ---------------------------------------------------------------------------

describe("denyAction()", () => {
  it("denies a pending action with a reason", async () => {
    const request = buildActionRequest({
      actionType: "slack:send",
      target: "#general",
      summary: "Send message",
      payload: { text: "hi" },
      reversible: false,
    });

    await withRequestContext({ requestId: "req-9" }, () =>
      runAction(request, async () => "done"),
    );

    const result = await denyAction(request.id, "admin-1", "Not approved by policy");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("denied");
    expect(result!.approved_by).toBe("admin-1");
    expect(result!.error).toBe("Not approved by policy");
    expect(result!.resolved_at).not.toBeNull();
  });

  it("denies without a reason", async () => {
    const request = buildActionRequest({
      actionType: "slack:send",
      target: "#general",
      summary: "Send message",
      payload: { text: "hi" },
      reversible: false,
    });

    await withRequestContext({ requestId: "req-10" }, () =>
      runAction(request, async () => "done"),
    );

    const result = await denyAction(request.id, "admin-1");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("denied");
    expect(result!.error).toBeNull();
  });

  it("returns null for an already-resolved action (CAS)", async () => {
    const request = buildActionRequest({
      actionType: "slack:send",
      target: "#general",
      summary: "Send message",
      payload: { text: "hi" },
      reversible: false,
    });

    await withRequestContext({ requestId: "req-11" }, () =>
      runAction(request, async () => "done"),
    );

    // First denial succeeds
    const first = await denyAction(request.id, "admin-1", "No");
    expect(first).not.toBeNull();

    // Second denial fails (CAS)
    const second = await denyAction(request.id, "admin-2", "Also no");
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAction
// ---------------------------------------------------------------------------

describe("getAction()", () => {
  it("returns action by ID", async () => {
    const request = buildActionRequest({
      actionType: "test:get",
      target: "t1",
      summary: "Get test",
      payload: { a: 1 },
      reversible: false,
    });

    await withRequestContext({ requestId: "req-12" }, () =>
      runAction(request, async () => "done"),
    );

    const action = await getAction(request.id);
    expect(action).not.toBeNull();
    expect(action!.id).toBe(request.id);
    expect(action!.action_type).toBe("test:get");
    expect(action!.payload).toEqual({ a: 1 });
  });

  it("returns null for unknown ID", async () => {
    const action = await getAction("nonexistent-id-12345");
    expect(action).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listPendingActions
// ---------------------------------------------------------------------------

describe("listPendingActions()", () => {
  it("lists pending actions", async () => {
    const r1 = buildActionRequest({
      actionType: "a:1",
      target: "t1",
      summary: "Action 1",
      payload: {},
      reversible: false,
    });
    const r2 = buildActionRequest({
      actionType: "a:2",
      target: "t2",
      summary: "Action 2",
      payload: {},
      reversible: false,
    });

    await withRequestContext({ requestId: "req-13" }, async () => {
      await runAction(r1, async () => "done");
      await runAction(r2, async () => "done");
    });

    const pending = await listPendingActions();
    expect(pending).toHaveLength(2);
    // Sorted by requested_at DESC
    expect(pending.map((p) => p.action_type)).toContain("a:1");
    expect(pending.map((p) => p.action_type)).toContain("a:2");
  });

  it("filters by status", async () => {
    const r1 = buildActionRequest({
      actionType: "a:1",
      target: "t1",
      summary: "Action 1",
      payload: {},
      reversible: false,
    });
    const r2 = buildActionRequest({
      actionType: "a:2",
      target: "t2",
      summary: "Action 2",
      payload: {},
      reversible: false,
    });

    await withRequestContext({ requestId: "req-14" }, async () => {
      await runAction(r1, async () => "done");
      await runAction(r2, async () => "done");
    });

    // Deny r1 so it has status "denied"
    await denyAction(r1.id, "admin", "No");

    // Only pending
    const pending = await listPendingActions({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].action_type).toBe("a:2");

    // Only denied
    const denied = await listPendingActions({ status: "denied" });
    expect(denied).toHaveLength(1);
    expect(denied[0].action_type).toBe("a:1");
  });

  it("returns empty array when no actions match", async () => {
    const pending = await listPendingActions();
    expect(pending).toEqual([]);
  });

  it("respects limit option", async () => {
    // Create 5 pending actions
    for (let i = 0; i < 5; i++) {
      const r = buildActionRequest({
        actionType: `a:${i}`,
        target: `t${i}`,
        summary: `Action ${i}`,
        payload: {},
        reversible: false,
      });
      await withRequestContext({ requestId: `req-limit-${i}` }, () =>
        runAction(r, async () => "done"),
      );
    }

    const limited = await listPendingActions({ limit: 3 });
    expect(limited).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getActionConfig
// ---------------------------------------------------------------------------

describe("getActionConfig()", () => {
  it("returns manual as default when no config is loaded", () => {
    const config = getActionConfig("slack:send");
    expect(config.approval).toBe("manual");
    expect(config.timeout).toBeUndefined();
    expect(config.maxPerConversation).toBeUndefined();
  });

  it("uses defaultApproval parameter as fallback when no config is loaded", () => {
    const config = getActionConfig("slack:send", "auto");
    expect(config.approval).toBe("auto");
  });

  it("applies config defaults when loaded from env", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "auto";
    await loadConfig("/tmp/handler-test-nonexistent");

    const config = getActionConfig("slack:send");
    expect(config.approval).toBe("auto");
  });

  it("config defaults override the defaultApproval parameter", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "auto";
    await loadConfig("/tmp/handler-test-nonexistent");

    // Even though we pass "manual" as defaultApproval, config says "auto"
    const config = getActionConfig("slack:send", "manual");
    expect(config.approval).toBe("auto");
  });

  it("per-action config override takes precedence over defaults", async () => {
    // Load config with defaults.approval = "manual" and "slack:send" = "auto"
    // We can't easily load a config file in tests, so we'll use loadConfig
    // which falls back to env vars. For per-action overrides, we need to
    // use a real config file. Instead, test getActionConfig with a loaded config.
    // Alternatively, use the env-based approach and then manually set a config.
    //
    // Since configFromEnv only sets defaults and doesn't support per-action
    // overrides via env, we test this using validateAndResolve + direct config.
    const { validateAndResolve, _resetConfig: resetCfg } = await import("@atlas/api/lib/config");
    resetCfg();

    // Simulate loading a config with per-action override
    const resolved = validateAndResolve({
      actions: {
        defaults: { approval: "manual" },
        "slack:send": { approval: "auto" },
      },
    });

    // Manually set the config by loading from env then overriding
    // We can't easily inject a config. Instead, test through loadConfig
    // with an atlas.config.ts file. For now, verify that validateAndResolve
    // correctly resolves the per-action config, which getActionConfig reads.
    expect(resolved.actions).toBeDefined();
    expect(resolved.actions!.defaults?.approval).toBe("manual");
    expect((resolved.actions!["slack:send"] as { approval: string }).approval).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// handleAction — admin-only
// ---------------------------------------------------------------------------

describe("handleAction() — admin-only", () => {
  it("returns pending when approval mode is admin-only", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "admin-only";
    await loadConfig("/tmp/handler-test-nonexistent");

    const request = buildActionRequest({
      actionType: "admin:action",
      target: "resource-1",
      summary: "Admin action",
      payload: { key: "val" },
      reversible: false,
    });

    const result = await withRequestContext(
      { requestId: "req-admin-1", user: { id: "u1", label: "user@test.com", mode: "managed" } },
      () => runAction(request, async () => "done"),
    );

    expect(result.status).toBe("pending");
    expect(result.actionId).toBe(request.id);
    if (result.status === "pending") {
      expect(result.summary).toBe("Admin action");
    }
  });
});

// ---------------------------------------------------------------------------
// handleAction — conversationId option
// ---------------------------------------------------------------------------

describe("handleAction() — conversationId", () => {
  it("persists conversationId when provided in opts", async () => {
    const request = buildActionRequest({
      actionType: "test:conv",
      target: "target-1",
      summary: "Test with conversationId",
      payload: {},
      reversible: false,
    });

    await withRequestContext(
      { requestId: "req-conv-1", user: { id: "u1", label: "user@test.com", mode: "managed" } },
      () => runAction(request, async () => "done", { conversationId: "conv-abc-123" }),
    );

    const stored = await getAction(request.id);
    expect(stored).not.toBeNull();
    expect(stored!.conversation_id).toBe("conv-abc-123");
  });

  it("conversation_id is null when opts.conversationId is not provided", async () => {
    const request = buildActionRequest({
      actionType: "test:no-conv",
      target: "target-2",
      summary: "No conversationId",
      payload: {},
      reversible: false,
    });

    await withRequestContext(
      { requestId: "req-conv-2", user: { id: "u1", label: "user@test.com", mode: "managed" } },
      () => runAction(request, async () => "done"),
    );

    const stored = await getAction(request.id);
    expect(stored).not.toBeNull();
    expect(stored!.conversation_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listPendingActions — userId filter
// ---------------------------------------------------------------------------

describe("listPendingActions() — userId filter", () => {
  it("filters actions by userId", async () => {
    const r1 = buildActionRequest({
      actionType: "a:user1",
      target: "t1",
      summary: "User 1 action",
      payload: {},
      reversible: false,
    });
    const r2 = buildActionRequest({
      actionType: "a:user2",
      target: "t2",
      summary: "User 2 action",
      payload: {},
      reversible: false,
    });

    await withRequestContext(
      { requestId: "req-u1", user: { id: "u1", label: "u1@test.com", mode: "managed" } },
      () => runAction(r1, async () => "done"),
    );
    await withRequestContext(
      { requestId: "req-u2", user: { id: "u2", label: "u2@test.com", mode: "managed" } },
      () => runAction(r2, async () => "done"),
    );

    const u1Actions = await listPendingActions({ userId: "u1" });
    expect(u1Actions).toHaveLength(1);
    expect(u1Actions[0].action_type).toBe("a:user1");
    expect(u1Actions[0].requested_by).toBe("u1");

    const u2Actions = await listPendingActions({ userId: "u2" });
    expect(u2Actions).toHaveLength(1);
    expect(u2Actions[0].action_type).toBe("a:user2");
    expect(u2Actions[0].requested_by).toBe("u2");
  });

  it("returns empty when userId has no matching actions", async () => {
    const r1 = buildActionRequest({
      actionType: "a:other",
      target: "t1",
      summary: "Other user",
      payload: {},
      reversible: false,
    });

    await withRequestContext(
      { requestId: "req-other", user: { id: "other", label: "other@test.com", mode: "managed" } },
      () => runAction(r1, async () => "done"),
    );

    const results = await listPendingActions({ userId: "nonexistent" });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ActionTimeoutError
// ---------------------------------------------------------------------------

describe("ActionTimeoutError", () => {
  it("stores the timeout duration and has the right message", () => {
    const err = new ActionTimeoutError({ message: "Action timed out after 5000ms", timeoutMs: 5000 });
    expect(err.message).toBe("Action timed out after 5000ms");
    expect(err.timeoutMs).toBe(5000);
    expect(err._tag).toBe("ActionTimeoutError");
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// handleAction — timeout enforcement (auto-approve)
// ---------------------------------------------------------------------------

describe("handleAction() — timeout enforcement", () => {
  it("transitions to timed_out when auto-approve execution exceeds timeout", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "auto";
    process.env.ATLAS_ACTION_TIMEOUT = "50";
    await loadConfig("/tmp/handler-test-nonexistent");

    const request = buildActionRequest({
      actionType: "slow:action",
      target: "target-1",
      summary: "Slow action",
      payload: { data: "test" },
      reversible: false,
    });

    const result = await withRequestContext(
      { requestId: "req-timeout-1", user: { id: "u1", label: "user@test.com", mode: "managed" } },
      () =>
        runAction(request, async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return "should not reach";
        }),
    );

    expect(result.status).toBe("timed_out");
    if (result.status === "timed_out") {
      expect(result.error).toBe("Action timed out after 50ms");
      expect(result.actionId).toBe(request.id);
    }

    // Verify persisted status
    const stored = await getAction(request.id);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("timed_out");
    expect(stored!.error).toBe("Action timed out after 50ms");
  });

  it("does not time out when execution completes within timeout", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "auto";
    process.env.ATLAS_ACTION_TIMEOUT = "5000";
    await loadConfig("/tmp/handler-test-nonexistent");

    const request = buildActionRequest({
      actionType: "fast:action",
      target: "target-2",
      summary: "Fast action",
      payload: { data: "test" },
      reversible: false,
    });

    const result = await withRequestContext(
      { requestId: "req-timeout-2", user: { id: "u1", label: "user@test.com", mode: "managed" } },
      () =>
        runAction(request, async () => ({ done: true })),
    );

    expect(result.status).toBe("auto_approved");
    if (result.status === "auto_approved") {
      expect(result.result).toEqual({ done: true });
    }
  });

  it("does not enforce timeout when no timeout is configured", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "auto";
    // No ATLAS_ACTION_TIMEOUT set
    await loadConfig("/tmp/handler-test-nonexistent");

    const request = buildActionRequest({
      actionType: "no-timeout:action",
      target: "target-3",
      summary: "No timeout configured",
      payload: {},
      reversible: false,
    });

    const result = await withRequestContext(
      { requestId: "req-timeout-3", user: { id: "u1", label: "user@test.com", mode: "managed" } },
      () =>
        runAction(request, async () => "completed"),
    );

    expect(result.status).toBe("auto_approved");
  });
});

// ---------------------------------------------------------------------------
// approveAction — timeout enforcement (manual approve)
// ---------------------------------------------------------------------------

describe("approveAction() — timeout enforcement", () => {
  it("transitions to timed_out when approved execution exceeds timeout", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_TIMEOUT = "50";
    await loadConfig("/tmp/handler-test-nonexistent");

    const request = buildActionRequest({
      actionType: "slow:manual",
      target: "target-1",
      summary: "Slow manual action",
      payload: { key: "val" },
      reversible: false,
    });

    await withRequestContext({ requestId: "req-approve-timeout-1" }, () =>
      runAction(request, async () => "done"),
    );

    defineActionExecutor(request.actionType, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "should not reach";
    });
    const result = await approveAction(request.id, "admin-1");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("timed_out");
    expect(result!.error).toBe("Action timed out after 50ms");

    // Verify persisted status
    const stored = await getAction(request.id);
    expect(stored!.status).toBe("timed_out");
  });
});

// ---------------------------------------------------------------------------
// getActionConfig — per-action timeout override
// ---------------------------------------------------------------------------

describe("getActionConfig() — timeout", () => {
  it("reads timeout from ATLAS_ACTION_TIMEOUT env var", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_TIMEOUT = "15000";
    await loadConfig("/tmp/handler-test-nonexistent");

    const config = getActionConfig("any:action");
    expect(config.timeout).toBe(15000);
  });

  it("per-action timeout overrides global defaults", async () => {
    const { validateAndResolve, _setConfigForTest } = await import("@atlas/api/lib/config");

    const resolved = validateAndResolve({
      actions: {
        defaults: { timeout: 60000 },
        "fast:action": { timeout: 5000 },
      },
    });
    _setConfigForTest(resolved);

    const globalConfig = getActionConfig("other:action");
    expect(globalConfig.timeout).toBe(60000);

    const overrideConfig = getActionConfig("fast:action");
    expect(overrideConfig.timeout).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// extractRollbackInfo
// ---------------------------------------------------------------------------

describe("extractRollbackInfo()", () => {
  it("returns RollbackInfo for valid result", () => {
    const result = {
      key: "PROJ-1",
      rollbackInfo: { method: "transition", params: { issueKey: "PROJ-1", targetStatus: "Closed" } },
    };
    const info = extractRollbackInfo(result);
    expect(info).toEqual({ method: "transition", params: { issueKey: "PROJ-1", targetStatus: "Closed" } });
  });

  it("returns null for null/undefined/primitives", () => {
    expect(extractRollbackInfo(null)).toBeNull();
    expect(extractRollbackInfo(undefined)).toBeNull();
    expect(extractRollbackInfo("string")).toBeNull();
    expect(extractRollbackInfo(42)).toBeNull();
    expect(extractRollbackInfo(true)).toBeNull();
  });

  it("returns null for object without rollbackInfo", () => {
    expect(extractRollbackInfo({})).toBeNull();
    expect(extractRollbackInfo({ key: "value" })).toBeNull();
  });

  it("returns null for non-object rollbackInfo", () => {
    expect(extractRollbackInfo({ rollbackInfo: null })).toBeNull();
    expect(extractRollbackInfo({ rollbackInfo: "string" })).toBeNull();
    expect(extractRollbackInfo({ rollbackInfo: 42 })).toBeNull();
  });

  it("returns null when method is not a string", () => {
    expect(extractRollbackInfo({ rollbackInfo: { method: 123, params: {} } })).toBeNull();
    expect(extractRollbackInfo({ rollbackInfo: { params: {} } })).toBeNull();
  });

  it("returns null when params is missing or not a plain object", () => {
    expect(extractRollbackInfo({ rollbackInfo: { method: "x" } })).toBeNull();
    expect(extractRollbackInfo({ rollbackInfo: { method: "x", params: null } })).toBeNull();
    expect(extractRollbackInfo({ rollbackInfo: { method: "x", params: "string" } })).toBeNull();
  });

  it("returns null when params is an array", () => {
    expect(extractRollbackInfo({ rollbackInfo: { method: "x", params: [1, 2, 3] } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rollback method registry
// ---------------------------------------------------------------------------

describe("registerRollbackMethod / getRollbackMethod", () => {
  it("registers and retrieves a handler", () => {
    const handler = async () => "ok";
    registerRollbackMethod("test:method", handler);
    expect(getRollbackMethod("test:method")).toBe(handler);
  });

  it("returns undefined for unregistered method", () => {
    expect(getRollbackMethod("nonexistent:method")).toBeUndefined();
  });

  it("is cleared by _resetActionStore", () => {
    registerRollbackMethod("temp:method", async () => "ok");
    _resetActionStore();
    expect(getRollbackMethod("temp:method")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rollbackAction
// ---------------------------------------------------------------------------

describe("rollbackAction()", () => {
  it("rolls back an executed action", async () => {
    const request = buildActionRequest({
      actionType: "jira:create",
      target: "PROJ",
      summary: "Create ticket",
      payload: { summary: "Test" },
      reversible: true,
    });

    // Create pending action, then approve+execute with rollback info
    await withRequestContext({ requestId: "req-rb-1" }, () =>
      runAction(request, async () => ({
        key: "PROJ-1",
        rollbackInfo: { method: "transition", params: { issueKey: "PROJ-1" } },
      })),
    );
    defineActionExecutor(request.actionType, async () => ({
      key: "PROJ-1",
      rollbackInfo: { method: "transition", params: { issueKey: "PROJ-1" } },
    }));
    await approveAction(request.id, "admin-1");

    // Verify it's executed with rollback_info
    const beforeRollback = await getAction(request.id);
    expect(beforeRollback!.status).toBe("executed");
    expect(beforeRollback!.rollback_info).not.toBeNull();

    const result = await rollbackAction(request.id, "admin-1");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rolled_back");
    expect(result!.resolved_at).not.toBeNull();

    // Verify persisted status
    const stored = await getAction(request.id);
    expect(stored!.status).toBe("rolled_back");
  });

  it("returns null for non-rollbackable status (pending)", async () => {
    const request = buildActionRequest({
      actionType: "test:action",
      target: "t1",
      summary: "Test",
      payload: {},
      reversible: true,
    });

    await withRequestContext({ requestId: "req-rb-2" }, () =>
      runAction(request, async () => "done"),
    );

    const result = await rollbackAction(request.id, "admin-1");
    expect(result).toBeNull();
  });

  it("returns null for unknown action ID", async () => {
    const result = await rollbackAction("nonexistent-id-12345", "admin-1");
    expect(result).toBeNull();
  });

  it("returns null when action has no rollback_info", async () => {
    const request = buildActionRequest({
      actionType: "test:no-rb",
      target: "t1",
      summary: "No rollback info",
      payload: {},
      reversible: false,
    });

    // Auto-approve with no rollback info in result
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "auto";
    const { loadConfig: lc } = await import("@atlas/api/lib/config");
    await lc("/tmp/handler-test-nonexistent");

    await withRequestContext({ requestId: "req-rb-3" }, () =>
      runAction(request, async () => ({ success: true })),
    );

    const stored = await getAction(request.id);
    expect(stored!.status).toBe("auto_approved");
    expect(stored!.rollback_info).toBeNull();

    const result = await rollbackAction(request.id, "admin-1");
    expect(result).toBeNull();
  });

  it("prevents double rollback (CAS)", async () => {
    const request = buildActionRequest({
      actionType: "jira:create",
      target: "PROJ",
      summary: "Create ticket",
      payload: { summary: "Test" },
      reversible: true,
    });

    await withRequestContext({ requestId: "req-rb-4" }, () =>
      runAction(request, async () => ({
        key: "PROJ-2",
        rollbackInfo: { method: "transition", params: { issueKey: "PROJ-2" } },
      })),
    );
    defineActionExecutor(request.actionType, async () => ({
      key: "PROJ-2",
      rollbackInfo: { method: "transition", params: { issueKey: "PROJ-2" } },
    }));
    await approveAction(request.id, "admin-1");

    const first = await rollbackAction(request.id, "admin-1");
    expect(first).not.toBeNull();
    expect(first!.status).toBe("rolled_back");

    const second = await rollbackAction(request.id, "admin-2");
    expect(second).toBeNull();
  });

  it("dispatches to registered rollback handler", async () => {
    let handlerCalled = false;
    let handlerParams: Record<string, unknown> = {};
    registerRollbackMethod("test:dispatch", async (params) => {
      handlerCalled = true;
      handlerParams = params;
    });

    const request = buildActionRequest({
      actionType: "test:dispatchable",
      target: "t1",
      summary: "Dispatchable",
      payload: { key: "val" },
      reversible: true,
    });

    await withRequestContext({ requestId: "req-rb-5" }, () =>
      runAction(request, async () => ({
        ok: true,
        rollbackInfo: { method: "test:dispatch", params: { myKey: "myVal" } },
      })),
    );
    defineActionExecutor(request.actionType, async () => ({
      ok: true,
      rollbackInfo: { method: "test:dispatch", params: { myKey: "myVal" } },
    }));
    await approveAction(request.id, "admin-1");

    await rollbackAction(request.id, "admin-1");
    expect(handlerCalled).toBe(true);
    expect(handlerParams).toEqual({ myKey: "myVal" });
  });

  it("stores error when rollback handler throws", async () => {
    registerRollbackMethod("test:failing", async () => {
      throw new Error("JIRA API unavailable");
    });

    const request = buildActionRequest({
      actionType: "test:failing-rb",
      target: "t1",
      summary: "Failing rollback",
      payload: {},
      reversible: true,
    });

    await withRequestContext({ requestId: "req-rb-6" }, () =>
      runAction(request, async () => ({
        rollbackInfo: { method: "test:failing", params: {} },
      })),
    );
    defineActionExecutor(request.actionType, async () => ({
      rollbackInfo: { method: "test:failing", params: {} },
    }));
    await approveAction(request.id, "admin-1");

    const result = await rollbackAction(request.id, "admin-1");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rolled_back");
    expect(result!.error).toBe("JIRA API unavailable");
  });

  it("stores error when no handler is registered for rollback method", async () => {
    const request = buildActionRequest({
      actionType: "test:no-handler",
      target: "t1",
      summary: "No handler",
      payload: {},
      reversible: true,
    });

    await withRequestContext({ requestId: "req-rb-7" }, () =>
      runAction(request, async () => ({
        rollbackInfo: { method: "unregistered:method", params: { a: 1 } },
      })),
    );
    defineActionExecutor(request.actionType, async () => ({
      rollbackInfo: { method: "unregistered:method", params: { a: 1 } },
    }));
    await approveAction(request.id, "admin-1");

    const result = await rollbackAction(request.id, "admin-1");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rolled_back");
    expect(result!.error).toContain("No rollback handler registered for method: unregistered:method");
  });
});

// ---------------------------------------------------------------------------
// Cross-org scoping (F-12 security invariant, 1.2.3 phase 2)
// ---------------------------------------------------------------------------
//
// Pending actions must be isolated by org_id. A user who approves / denies /
// rollbacks / views an action from a session active in a different workspace
// must see the action as not-found, never as an actionable row. The filter is
// NULL-safe so rows written before org-stamping existed remain accessible.

describe("cross-org scoping (F-12)", () => {
  async function seedOrgScoped(actionType: string, orgId: string, userId = "alice") {
    const request = buildActionRequest({
      actionType,
      target: `t-${Math.random()}`,
      summary: "Test action",
      payload: {},
      reversible: false,
    });
    await withRequestContext(
      {
        requestId: "req-seed",
        user: {
          id: userId,
          label: `${userId}@test.com`,
          mode: "simple-key",
          activeOrganizationId: orgId,
        },
      },
      () => runAction(request, async () => "done"),
    );
    return request.id;
  }

  it("handleAction stamps org_id from request context", async () => {
    const id = await seedOrgScoped("test:stamped", "org-A");
    // Read back without orgId filter — the row itself carries the stamp.
    const entry = await getAction(id);
    expect(entry).not.toBeNull();
    expect(entry!.org_id).toBe("org-A");
  });

  it("getAction returns null for cross-org caller", async () => {
    const id = await seedOrgScoped("test:xorg", "org-A");
    const fromOtherOrg = await getAction(id, "org-B");
    expect(fromOtherOrg).toBeNull();
    const fromOwnOrg = await getAction(id, "org-A");
    expect(fromOwnOrg).not.toBeNull();
  });

  it("getAction returns legacy (org_id=null) rows to any org (back-compat)", async () => {
    // Seed a row then null out org_id to simulate pre-F-12 data.
    const id = await seedOrgScoped("test:legacy", "org-A");
    const row = await getAction(id);
    row!.org_id = null;
    const fromAnyOrg = await getAction(id, "org-Z");
    expect(fromAnyOrg).not.toBeNull();
  });

  it("approveAction loses CAS for cross-org caller (returns null)", async () => {
    const id = await seedOrgScoped("test:xapprove", "org-A");
    defineActionExecutor("test:xapprove", async () => "ok");
    const result = await approveAction(id, "admin-1", "org-B");
    expect(result).toBeNull();
    // Row is still pending — the cross-org approve didn't touch it.
    const row = await getAction(id, "org-A");
    expect(row!.status).toBe("pending");
  });

  it("approveAction succeeds for same-org caller", async () => {
    const id = await seedOrgScoped("test:approve-ok", "org-A");
    defineActionExecutor("test:approve-ok", async () => "ok");
    const result = await approveAction(id, "admin-1", "org-A");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("executed");
  });

  it("denyAction loses CAS for cross-org caller (returns null)", async () => {
    const id = await seedOrgScoped("test:xdeny", "org-A");
    const result = await denyAction(id, "admin-1", "no", "org-B");
    expect(result).toBeNull();
    const row = await getAction(id, "org-A");
    expect(row!.status).toBe("pending");
  });

  it("rollbackAction returns null for cross-org caller", async () => {
    const id = await seedOrgScoped("test:xrollback", "org-A");
    // Approve in-org so the action becomes executed with rollback info.
    defineActionExecutor("test:xrollback", async () => ({
      key: "Z-1",
      rollbackInfo: { method: "m", params: {} },
    }));
    await approveAction(id, "admin-1", "org-A");

    const xorg = await rollbackAction(id, "admin-1", "org-B");
    expect(xorg).toBeNull();

    const same = await rollbackAction(id, "admin-1", "org-A");
    expect(same).not.toBeNull();
    expect(same!.status).toBe("rolled_back");
  });

  it("listPendingActions filters out cross-org rows", async () => {
    const idA = await seedOrgScoped("test:list-a", "org-A", "alice");
    const idB = await seedOrgScoped("test:list-b", "org-B", "bob");

    const fromA = await listPendingActions({ orgId: "org-A" });
    const fromAIds = fromA.map((e) => e.id);
    expect(fromAIds).toContain(idA);
    expect(fromAIds).not.toContain(idB);

    const fromB = await listPendingActions({ orgId: "org-B" });
    const fromBIds = fromB.map((e) => e.id);
    expect(fromBIds).toContain(idB);
    expect(fromBIds).not.toContain(idA);
  });
});

// ===========================================================================
// Formerly execution-context.test.ts — action execution context threading (#3766).
//
// `ActionExecutionContext.workspaceId` is what the credential resolver keys on,
// so which workspace reaches the executor is a multi-tenant boundary, not a
// convenience. The subtle case is the manual-approval path: the executor runs
// inside the APPROVER's request, so anything that read the ambient request
// context at execution time would let the approver's active workspace decide
// whose Jira the ticket lands in.
//
// ⚠️ Since #5570 that boundary has to hold across a RESTART as well. The
// executor is no longer a closure the requesting process stashed; it is rebuilt
// from the persisted row by whichever instance handles the approval or the
// re-dispatch. So "whose workspace" is now answered by `action_log.org_id` on a
// row, on a process that has never seen the request — which is exactly the
// shape the last describe block of this section pins.
// ===========================================================================

describe("auto-approved path", () => {
  it("hands the executor the requester's workspace", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "auto";
    await loadConfig("/tmp/execution-context-test-nonexistent");
    let seen: ActionExecutionContext | null = null;

    await withRequestContext(requester(REQUESTER_ORG), () =>
      runAction(newRequest(), async (_payload, ctx) => {
        seen = ctx;
        return "done";
      }),
    );

    expect(seen).not.toBeNull();
    expect(seen!.workspaceId).toBe(REQUESTER_ORG);
  });

  it("hands null when the request carries no active workspace", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "auto";
    await loadConfig("/tmp/execution-context-test-nonexistent");
    let seen: ActionExecutionContext | null = null;

    await withRequestContext(requester(null), () =>
      runAction(newRequest(), async (_payload, ctx) => {
        seen = ctx;
        return "done";
      }),
    );

    expect(seen!.workspaceId).toBeNull();
  });
});

describe("manual-approval path", () => {
  it("hands the executor the REQUESTER's workspace, not the approver's", async () => {
    // The regression this pins: resolving credentials from the ambient request
    // context at execution time would yield APPROVER_ORG here, and the ticket
    // would be created against tenant B's Jira for tenant A's action.
    let seen: ActionExecutionContext | null = null;
    const request = newRequest();

    const pending = await withRequestContext(requester(REQUESTER_ORG), () =>
      runAction(request, async (_payload, ctx) => {
        seen = ctx;
        return "done";
      }),
    );
    expect(pending.status).toBe("pending");
    expect(seen).toBeNull(); // not executed yet

    // Approve inside a DIFFERENT workspace's request context.
    await withRequestContext(
      {
        requestId: "req-approver",
        user: {
          id: "u-approver",
          label: "admin@tenant-b.example",
          mode: "managed",
          activeOrganizationId: APPROVER_ORG,
        },
      },
      () => approveAction(request.id, "u-approver"),
    );

    expect(seen).not.toBeNull();
    expect(seen!.workspaceId).toBe(REQUESTER_ORG);
    expect(seen!.workspaceId).not.toBe(APPROVER_ORG);
  });

  it("still passes the action's payload as the first argument", async () => {
    // The context is an ADDED second parameter — existing executors that only
    // read the payload must be unaffected.
    // Captured on an object rather than a `let`: TS's control-flow analysis
    // does not see an assignment made inside the executor closure, so a `let`
    // stays narrowed to `null` at the assertion below.
    const captured: { payload?: Record<string, unknown> } = {};
    const request = newRequest();

    await withRequestContext(requester(REQUESTER_ORG), () =>
      runAction(request, async (payload) => {
        captured.payload = payload;
        return "done";
      }),
    );
    await withRequestContext(requester(REQUESTER_ORG), () =>
      approveAction(request.id, "u-approver"),
    );

    expect(captured.payload).toEqual({ summary: "s", description: "d" });
  });
});

// ---------------------------------------------------------------------------
// Across a restart (#5570)
// ---------------------------------------------------------------------------

describe("post-restart execution — the row is the only input", () => {
  const REGISTRAR_ORG = "org-tenant-c";
  const approver = createAtlasUser("u-approver", "managed", "admin@tenant-b.example", {
    role: "admin",
  });

  /**
   * Everything the requesting process knew, gone: no executor registered for
   * any type. What survives is the persisted row — which is the point.
   */
  function restart(): void {
    _resetActionExecutors();
  }

  it("⭐ approver ≠ requester ≠ registering process, and the ROW's workspace still wins", async () => {
    // The acceptance criterion, spelled out as three distinct workspaces:
    //
    //   requester   → REQUESTER_ORG   (stamped on the row at request time)
    //   approver    → APPROVER_ORG    (the ambient context at execution time)
    //   registrar   → REGISTRAR_ORG   (the process that re-registered the type
    //                                  after the restart, in its own context)
    //
    // Only the first may reach the executor. Under the old per-id registry
    // this scenario could not even run — the approval found no executor and
    // the row stranded.
    let seen: ActionExecutionContext | null = null;
    const request = newRequest();

    const pending = await withRequestContext(requester(REQUESTER_ORG), () =>
      runAction(request, async () => "the first process, whose closure does not survive"),
    );
    expect(pending.status).toBe("pending");

    restart();

    // A different instance boots, in a third workspace's context, and its
    // action module registers the TYPE. It has never seen this request.
    await withRequestContext(
      { requestId: "req-boot", user: { id: "u-registrar", label: "boot", mode: "managed", activeOrganizationId: REGISTRAR_ORG } },
      async () => {
        defineActionExecutor("jira:create", async (_payload, ctx) => {
          seen = ctx;
          return "done";
        });
      },
    );

    // The approval lands there, inside the APPROVER's workspace.
    await withRequestContext(
      {
        requestId: "req-approver",
        user: { id: "u-approver", label: "admin@tenant-b.example", mode: "managed", activeOrganizationId: APPROVER_ORG },
      },
      () => approveAction(request.id, "u-approver"),
    );

    expect(seen).not.toBeNull();
    expect(seen!.workspaceId).toBe(REQUESTER_ORG);
    expect(seen!.workspaceId).not.toBe(APPROVER_ORG);
    expect(seen!.workspaceId).not.toBe(REGISTRAR_ORG);
  });

  it("⭐ re-dispatch resolves credentials from the row's workspace too", async () => {
    // A stranded row is the one case that reaches the re-dispatch verb, and it
    // is dispatched by a THIRD party — later, from their own workspace. If
    // anything read the ambient context there, tenant A's action would fire
    // with tenant B's credentials, which is the ADR-0046 boundary in its most
    // exposed form.
    let seen: ActionExecutionContext | null = null;
    const request = newRequest();

    await withRequestContext(requester(REQUESTER_ORG), () =>
      runAction(request, async () => "never runs"),
    );

    // Strand it: approved on an instance with no executor for the type.
    restart();
    await withRequestContext(requester(REQUESTER_ORG), () =>
      approveAction(request.id, "u-approver"),
    );
    expect((await approveAction(request.id, "u-approver"))).toBeNull(); // already left pending

    // The deploy that has the module loaded re-dispatches, from ITS workspace.
    defineActionExecutor("jira:create", async (_payload, ctx) => {
      seen = ctx;
      return "done";
    });
    const outcome = await withRequestContext(
      {
        requestId: "req-redispatch",
        user: { id: "u-approver", label: "admin@tenant-b.example", mode: "managed", activeOrganizationId: APPROVER_ORG },
      },
      () => redispatchActionAsUser(request.id, { user: approver, orgId: null }),
    );

    expect(outcome.kind).toBe("redispatched");
    expect(seen).not.toBeNull();
    expect(seen!.workspaceId).toBe(REQUESTER_ORG);
    expect(seen!.workspaceId).not.toBe(APPROVER_ORG);
  });
});

// ===========================================================================
// Formerly resolve-as-user.test.ts — the authorized resolution verbs,
// `approveActionAsUser` / `denyActionAsUser`.
//
// These are the seam both the single-action routes and bulk resolve through, so
// what belongs here is the outcome vocabulary itself: each refusal kind, the
// conflict arm, and above all the `approved` vs `approved_not_executed` split —
// the case where the CAS lands but nothing executes, so the row leaves
// `pending` and nothing will ever retry it on its own. Until the split existed,
// that state returned success-shaped and the approver was told the action went
// through.
//
// ⚠️ What reaches that arm NARROWED with #5570. It used to be the ordinary
// restart / other-instance case, because the registry was keyed by action ID and
// populated per request. The registry is now keyed by `action_type` and
// populated at module load, so a restart executes fine (pinned by the suites
// above). What is left is one residual: the row's TYPE has no executor on this
// instance at all — actions disabled on this deploy, a module that failed to
// import, a plugin that did not wire. The pin below says exactly that, and
// `redispatchActionAsUser` is the way out of it.
// ===========================================================================

describe("approveActionAsUser — the outcome vocabulary", () => {
  it("approves and executes when the executor is registered", async () => {
    const id = await seedPending("test:action", "alice");

    const outcome = await approveActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") throw new Error("unreachable");
    expect(outcome.entry.status).toBe("executed");
  });

  it("⭐ names the approved-but-never-executed state instead of shaping it as success", async () => {
    // The residual hazard, post-#5570: nothing on this instance knows how to
    // execute the row's action TYPE. The CAS still lands — the row is
    // approved and has left `pending` — but nothing runs, and nothing will
    // retry it on its own. The old interface returned the entry
    // success-shaped; the outcome kind makes the drop visible to every
    // caller, at compile time.
    const id = await seedPending("test:action", "alice");
    _undefineActionExecutor("test:action");

    const outcome = await approveActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("approved_not_executed");
    if (outcome.kind !== "approved_not_executed") throw new Error("unreachable");
    expect(outcome.entry.status).toBe("approved");
    // And the row really did leave pending — the part that makes this a trap.
    const row = await getAction(id);
    expect(row?.status).toBe("approved");
  });

  it("⭐ reaches that arm ONLY for an unregistered type — an unrelated type going missing is irrelevant", async () => {
    // The narrowing #5570 bought, stated as a test: the registry is keyed by
    // action type, so what another action type's module did or did not
    // register cannot decide whether THIS row executes. Under the old per-id
    // Map every row was its own registration and this distinction did not
    // exist.
    const id = await seedPending("test:action", "alice");
    _undefineActionExecutor("some:other-type");

    const outcome = await approveActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("approved");
  });

  it("returns not_found for an unknown id", async () => {
    const outcome = await approveActionAsUser("00000000-0000-4000-8000-000000000000", {
      user: admin,
      orgId: null,
    });
    expect(outcome.kind).toBe("not_found");
  });

  it("returns forbidden(role) for a member on an admin-only action", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", "alice");

    const outcome = await approveActionAsUser(id, { user: member, orgId: null });

    expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
    // Refused before any state changed.
    expect((await getAction(id))?.status).toBe("pending");
  });

  it("returns forbidden(self_approval) when the requester approves their own admin-only action", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", owner.id);

    const outcome = await approveActionAsUser(id, { user: owner, orgId: null });

    expect(outcome).toEqual({ kind: "forbidden", reason: "self_approval" });
  });

  it("returns conflict when the action is already resolved", async () => {
    const id = await seedPending("test:action", "alice");
    const first = await approveActionAsUser(id, { user: admin, orgId: null });
    expect(first.kind).toBe("approved");

    const second = await approveActionAsUser(id, { user: admin, orgId: null });
    expect(second.kind).toBe("conflict");
  });
});

describe("redispatchActionAsUser — the way out of approved_not_executed", () => {
  /** Strand a row exactly as `approved_not_executed` leaves one. */
  async function seedStranded(actionType: string): Promise<string> {
    const id = await seedPending(actionType, "alice");
    _undefineActionExecutor(actionType);
    const approved = await approveActionAsUser(id, { user: admin, orgId: null });
    expect(approved.kind).toBe("approved_not_executed");
    return id;
  }

  it("⭐ runs a stranded row once the type is registered again", async () => {
    const id = await seedStranded("test:stranded");
    // The deploy that has the action module loaded.
    defineActionExecutor("test:stranded", async () => ({ ran: "at last" }));

    const outcome = await redispatchActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("redispatched");
    if (outcome.kind !== "redispatched") throw new Error("unreachable");
    expect(outcome.entry.status).toBe("executed");
    expect(outcome.entry.result).toEqual({ ran: "at last" });
    expect((await getAction(id))?.status).toBe("executed");
  });

  it("⭐ a second re-dispatch cannot double-execute", async () => {
    // The CAS claim, from the caller's side. Two admins on the same stranded
    // row: one dispatch, one 409 — which for an action type that sends email
    // is the whole reason the claim exists.
    let runs = 0;
    const id = await seedStranded("test:double");
    defineActionExecutor("test:double", async () => {
      runs += 1;
      return "sent";
    });

    const first = await redispatchActionAsUser(id, { user: admin, orgId: null });
    const second = await redispatchActionAsUser(id, { user: admin, orgId: null });

    expect(first.kind).toBe("redispatched");
    expect(second.kind).toBe("conflict");
    expect(runs).toBe(1);
  });

  it("leaves the row UNTOUCHED when this instance still cannot execute the type", async () => {
    // The critical ordering: the registration check runs before the claim. If
    // it did not, this call would stamp the row and permanently refuse the
    // instance that actually has the type.
    const id = await seedStranded("test:still-missing");

    const outcome = await redispatchActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("unregistered_type");
    const row = await getAction(id);
    expect(row?.status).toBe("approved");
    expect(row?.executed_at).toBeNull();

    // ...and the row is still re-dispatchable once the module loads.
    defineActionExecutor("test:still-missing", async () => "ok");
    expect((await redispatchActionAsUser(id, { user: admin, orgId: null })).kind).toBe(
      "redispatched",
    );
  });

  it("refuses a row that is still pending — approve it, do not re-dispatch it", async () => {
    const id = await seedPending("test:action", "alice");

    const outcome = await redispatchActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("conflict");
    expect((await getAction(id))?.status).toBe("pending");
  });

  it("refuses a row that already ran", async () => {
    const id = await seedPending("test:action", "alice");
    expect((await approveActionAsUser(id, { user: admin, orgId: null })).kind).toBe("approved");

    const outcome = await redispatchActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("conflict");
    expect((await getAction(id))?.status).toBe("executed");
  });

  it("applies the approve bar — a member is refused before the row is touched", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", "alice");
    _undefineActionExecutor("admin:only");
    expect((await approveActionAsUser(id, { user: owner, orgId: null })).kind).toBe(
      "approved_not_executed",
    );
    defineActionExecutor("admin:only", async () => "ok");

    const outcome = await redispatchActionAsUser(id, { user: member, orgId: null });

    expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
    const row = await getAction(id);
    expect(row?.status).toBe("approved");
    expect(row?.executed_at).toBeNull();
  });

  it("⭐ keeps separation of duties — the requester cannot re-dispatch their own admin-only action", async () => {
    // Re-dispatch is the EXECUTION half of an approval. Letting the requester
    // trigger the side effect would reopen exactly what the approve path's
    // self-approval bar closes, one verb over.
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", owner.id);
    _undefineActionExecutor("admin:only");
    expect((await approveActionAsUser(id, { user: owner2, orgId: null })).kind).toBe(
      "approved_not_executed",
    );
    defineActionExecutor("admin:only", async () => "ok");

    const outcome = await redispatchActionAsUser(id, { user: owner, orgId: null });

    expect(outcome).toEqual({ kind: "forbidden", reason: "self_approval" });
  });

  it("returns not_found for an unknown id", async () => {
    const outcome = await redispatchActionAsUser("00000000-0000-4000-8000-000000000000", {
      user: admin,
      orgId: null,
    });
    expect(outcome.kind).toBe("not_found");
  });
});

describe("denyActionAsUser", () => {
  it("denies with the same refusal vocabulary and records the reason", async () => {
    const id = await seedPending("test:action", "alice");

    const outcome = await denyActionAsUser(id, { user: admin, orgId: null }, "not today");

    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("unreachable");
    expect(outcome.entry.status).toBe("denied");
    expect(outcome.entry.error).toBe("not today");
  });

  it("refuses a member on an admin-only action before any state changes", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", "alice");

    const outcome = await denyActionAsUser(id, { user: member, orgId: null });

    expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
    expect((await getAction(id))?.status).toBe("pending");
  });
});
