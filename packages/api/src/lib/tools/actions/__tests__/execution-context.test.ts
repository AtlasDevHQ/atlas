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
 * Memory-only path (no DATABASE_URL), same as `handler.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  handleAction,
  approveAction,
  buildActionRequest,
  _resetActionStore,
  type ActionExecutionContext,
} from "../handler";
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
      handleAction(newRequest(), async (_payload, ctx) => {
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
      handleAction(newRequest(), async (_payload, ctx) => {
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
      handleAction(request, async (_payload, ctx) => {
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
      handleAction(request, async (payload) => {
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
