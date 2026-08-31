/**
 * Action execution context threading (#3766).
 *
 * `ActionExecutionContext.workspaceId` is what the credential resolver keys
 * on, so which workspace reaches the executor is a multi-tenant boundary, not
 * a convenience. The subtle case — and the reason this file exists separately
 * from `handler.test.ts` — is the manual-approval path: the executor runs
 * inside the APPROVER's request, so anything that read the ambient request
 * context at execution time would let the approver's active workspace decide
 * whose Jira the ticket lands in.
 *
 * ⚠️ Since #5570 that boundary has to hold across a RESTART as well. The
 * executor is no longer a closure the requesting process stashed; it is
 * rebuilt from the persisted row by whichever instance handles the approval or
 * the re-dispatch. So "whose workspace" is now answered by `action_log.org_id`
 * on a row, on a process that has never seen the request — which is exactly
 * the shape the last describe block below pins.
 *
 * Memory-only path (no DATABASE_URL), same as `handler.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  handleAction,
  approveAction,
  buildActionRequest,
  defineActionExecutor,
  redispatchActionAsUser,
  _resetActionExecutors,
  _resetActionStore,
  type ActionExecutionContext,
  type ActionExecutor,
} from "../handler";
import type { ActionRequest, ActionToolResult } from "@atlas/api/lib/action-types";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { loadConfig, _resetConfig } from "@atlas/api/lib/config";
import { withRequestContext } from "@atlas/api/lib/logger";
import { _resetPool } from "@atlas/api/lib/db/internal";

const origDbUrl = process.env.DATABASE_URL;

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

/**
 * Register how `request`'s TYPE executes, then run it — `handler.test.ts`'s
 * helper, and for its reason (#5570): `handleAction` takes no executor, so a
 * suite with no action module to load stages the registration itself.
 */
function runAction(
  request: ActionRequest,
  executor: ActionExecutor,
  opts?: { conversationId?: string },
): Promise<ActionToolResult> {
  defineActionExecutor(request.actionType, executor);
  return handleAction(request, opts);
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
  _resetPool(null);
  _resetActionStore();
  _resetConfig();
});

afterEach(() => {
  delete process.env.ATLAS_ACTIONS_ENABLED;
  delete process.env.ATLAS_ACTION_APPROVAL;
  if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
  else delete process.env.DATABASE_URL;
  _resetPool(null);
  _resetActionStore();
  _resetConfig();
});

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
