/**
 * Linear action tests (#5554).
 *
 * Mirrors `jira.test.ts`, with one addition the pilot did not need: Linear is
 * NET-NEW on the seam, so the "reads no env var" case is not a regression
 * guard for a port that already happened — it is the property that has to hold
 * from the first commit, and the one a future `process.env.LINEAR_API_KEY`
 * convenience read would break.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock handler module so we don't hit real DB / auth
// ---------------------------------------------------------------------------

let lastHandleActionCall: { request: unknown; executeFn: unknown } | null = null;

void mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  buildActionRequest: (params: Record<string, unknown>) => ({
    id: "test-action-id",
    ...params,
  }),
  handleAction: async (request: unknown, executeFn: unknown) => {
    lastHandleActionCall = { request, executeFn };
    return { status: "pending", actionId: "test-action-id", summary: "test" };
  },
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

/** Every `(target, workspaceId)` the action asked the resolver for, in order. */
const resolverCalls: Array<{ target: string; workspaceId: string | null | undefined }> = [];

/**
 * Partial mock of the credential resolver, deliberately: `linear.ts` is the
 * only module in this file's reachable graph that imports from it (the handler
 * is mocked above), and it imports exactly this one symbol — so the "Export
 * named 'X' not found" failure mode cannot fire. The ladder itself is the
 * resolver suite's subject; here the only question is whether the action calls
 * it with the ACTION's workspace and stays out of `process.env`.
 */
void mock.module("@atlas/api/lib/tools/actions/credentials/resolver", () => ({
  resolveCredentialsFor: async (
    spec: { target: string },
    ctx: { workspaceId: string | null },
  ) => {
    resolverCalls.push({ target: spec.target, workspaceId: ctx.workspaceId });
    return { LINEAR_API_KEY: "lin_api_tenant-key" };
  },
}));

const { executeLinearCreate, createLinearTicket } = await import(
  "@atlas/api/lib/tools/actions/linear"
);

/**
 * A complete credential set. `executeLinearCreate` takes credentials as an
 * ARGUMENT and never reads `process.env` — the resolver owns the workspace →
 * self-host-env ladder — so these tests build the set directly rather than
 * staging env vars.
 */
function creds(overrides: Record<string, string | undefined> = {}) {
  return {
    LINEAR_API_KEY: "lin_api_tenant-key",
    ...overrides,
  } as Parameters<typeof executeLinearCreate>[1];
}

// ---------------------------------------------------------------------------
// Env snapshot + fetch mock
// ---------------------------------------------------------------------------

const ENV_KEYS = ["LINEAR_API_KEY", "LINEAR_DEFAULT_TEAM_KEY"] as const;

const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

/** Every GraphQL POST the module made, in order. */
let calls: Array<{ url: string; init: RequestInit | undefined; body: Record<string, unknown> }> = [];

/**
 * Queue one response per fetch. Linear needs two calls when a team key is in
 * play (team lookup, then the mutation), so responses are consumed in order and
 * the last one repeats if the queue runs dry.
 */
function installFetchMock(responses: Array<{ status: number; body: unknown }>) {
  const queue = [...responses];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const parsedBody = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
    calls.push({
      url: typeof input === "string" ? input : (input as Request).url,
      init,
      body: parsedBody,
    });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function installFetchMockRaw(response: { status: number; text: string }) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : (input as Request).url,
      init,
      body: {},
    });
    return new Response(response.text, { status: response.status });
  }) as typeof globalThis.fetch;
}

/** The `input` variable of the last `issueCreate` mutation POSTed. */
function lastIssueInput(): Record<string, unknown> {
  const mutation = calls.filter((c) => String(c.body.query).includes("issueCreate")).at(-1);
  if (!mutation) throw new Error("no issueCreate mutation was POSTed");
  return (mutation.body.variables as { input: Record<string, unknown> }).input;
}

/** The `Authorization` header of the nth GraphQL POST. */
function authHeaderOf(index: number): string | undefined {
  const call = calls[index];
  if (!call) throw new Error(`no GraphQL call at index ${index}`);
  return (call.init?.headers as Record<string, string> | undefined)?.Authorization;
}

const TEAM_LOOKUP_OK = {
  status: 200,
  body: { data: { teams: { nodes: [{ id: "team-uuid-1" }] } } },
};
const ISSUE_CREATE_OK = {
  status: 200,
  body: {
    data: {
      issueCreate: {
        success: true,
        issue: {
          id: "issue-uuid-1",
          identifier: "ENG-42",
          url: "https://linear.app/acme/issue/ENG-42",
        },
      },
    },
  },
};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  lastHandleActionCall = null;
  calls = [];
  resolverCalls.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
    else delete process.env[key];
  }
});

// ---------------------------------------------------------------------------
// AtlasAction metadata
// ---------------------------------------------------------------------------

describe("createLinearTicket — metadata", () => {
  it("has the correct actionType", () => {
    expect(createLinearTicket.actionType).toBe("linear:create");
  });

  it("is reversible", () => {
    expect(createLinearTicket.reversible).toBe(true);
  });

  it("defaults to manual approval", () => {
    expect(createLinearTicket.defaultApproval).toBe("manual");
  });

  it("declares no global required credentials (they are per-workspace)", () => {
    // `validateActionCredentials()` checks this list against the GLOBAL
    // process.env, a question that has no meaningful answer for a
    // per-workspace target. Configuration status lives on the workspace Admin
    // surface (`getActionTargetStatus`) instead.
    expect(createLinearTicket.requiredCredentials).toEqual([]);
  });

  it("has a name distinct from the install-backed createLinearIssue tool", () => {
    // Both create Linear issues; they resolve credentials from different
    // stores and only one is approval-gated, so the model has to be able to
    // tell them apart. A shared name would also make one shadow the other in
    // the registry merge.
    expect(createLinearTicket.name).toBe("createLinearTicket");
    expect(createLinearTicket.name).not.toBe("createLinearIssue");
  });

  it("has a description", () => {
    expect(createLinearTicket.description).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// executeLinearCreate — raw API call
// ---------------------------------------------------------------------------

describe("executeLinearCreate", () => {
  it("posts issueCreate to Linear's GraphQL endpoint with the credential's key", async () => {
    installFetchMock([ISSUE_CREATE_OK]);

    const result = await executeLinearCreate(
      { title: "Bug report", description: "Something is broken" },
      creds(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.linear.app/graphql");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(authHeaderOf(0)).toBe("Bearer lin_api_tenant-key");
    expect(lastIssueInput().title).toBe("Bug report");
    expect(lastIssueInput().description).toBe("Something is broken");
    expect(result).toEqual({
      id: "issue-uuid-1",
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42",
    });
  });

  it("reads no LINEAR_* env var, even when every one of them is set", async () => {
    // The property the seam exists for: a tenant's action must never pick up
    // the deployment's globals. Only the resolver may consult env, and only on
    // self-hosted.
    process.env.LINEAR_API_KEY = "lin_api_operator-key";
    process.env.LINEAR_DEFAULT_TEAM_KEY = "OPS";

    installFetchMock([ISSUE_CREATE_OK]);

    await executeLinearCreate(
      { title: "Test", description: "Desc" },
      creds({ LINEAR_API_KEY: "lin_api_tenant-key" }),
    );

    const auth = authHeaderOf(0);
    expect(auth).toBe("Bearer lin_api_tenant-key");
    expect(auth).not.toContain("operator");
    // The operator's default team must not have been consulted either — with
    // no team named anywhere, exactly one call (the mutation) is made.
    expect(calls).toHaveLength(1);
    expect(lastIssueInput().teamId).toBeUndefined();
  });

  it("resolves an explicit team key to a team id before creating", async () => {
    installFetchMock([TEAM_LOOKUP_OK, ISSUE_CREATE_OK]);

    await executeLinearCreate(
      { title: "Test", description: "Desc", teamKey: "ENG" },
      creds(),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.variables).toEqual({ key: "ENG" });
    expect(lastIssueInput().teamId).toBe("team-uuid-1");
  });

  it("falls back to the credential set's default team when none is provided", async () => {
    installFetchMock([TEAM_LOOKUP_OK, ISSUE_CREATE_OK]);

    await executeLinearCreate(
      { title: "Test", description: "Desc" },
      creds({ LINEAR_DEFAULT_TEAM_KEY: "DEFAULT" }),
    );

    expect(calls[0]!.body.variables).toEqual({ key: "DEFAULT" });
    expect(lastIssueInput().teamId).toBe("team-uuid-1");
  });

  it("prefers an explicit team key over the credential set's default", async () => {
    installFetchMock([TEAM_LOOKUP_OK, ISSUE_CREATE_OK]);

    await executeLinearCreate(
      { title: "Test", description: "Desc", teamKey: "ENG" },
      creds({ LINEAR_DEFAULT_TEAM_KEY: "DEFAULT" }),
    );

    expect(calls[0]!.body.variables).toEqual({ key: "ENG" });
  });

  it("fails rather than silently filing on another team when the key does not resolve", async () => {
    // The install-backed tool degrades to the key owner's default team here.
    // An approval-gated action must not: a human approved a card naming ENG.
    installFetchMock([{ status: 200, body: { data: { teams: { nodes: [] } } } }]);

    await expect(
      executeLinearCreate({ title: "Test", description: "Desc", teamKey: "ENG" }, creds()),
    ).rejects.toThrow('Linear team "ENG" was not found');

    // No mutation was attempted.
    expect(calls.filter((c) => String(c.body.query).includes("issueCreate"))).toHaveLength(0);
  });

  it("omits priority and labelIds when not provided", async () => {
    installFetchMock([ISSUE_CREATE_OK]);

    await executeLinearCreate({ title: "Test", description: "Desc" }, creds());

    expect(lastIssueInput().priority).toBeUndefined();
    expect(lastIssueInput().labelIds).toBeUndefined();
  });

  it("passes priority and labelIds through when provided", async () => {
    installFetchMock([ISSUE_CREATE_OK]);

    await executeLinearCreate(
      {
        title: "Test",
        description: "Desc",
        priority: 1,
        labelIds: ["11111111-1111-4111-8111-111111111111"],
      },
      creds(),
    );

    expect(lastIssueInput().priority).toBe(1);
    expect(lastIssueInput().labelIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("throws on a GraphQL error without exposing the API key", async () => {
    installFetchMock([
      { status: 200, body: { errors: [{ message: "Team not authorized for this actor." }] } },
    ]);

    try {
      await executeLinearCreate({ title: "Test", description: "Desc" }, creds());
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("Linear API error");
      expect(message).toContain("not authorized");
      expect(message).not.toContain("lin_api_tenant-key");
    }
  });

  it("names the rotation surface on a rejected key, without echoing it", async () => {
    installFetchMockRaw({ status: 401, text: "authentication failed" });

    try {
      await executeLinearCreate({ title: "Test", description: "Desc" }, creds());
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("HTTP 401");
      expect(message).toContain("rotate it");
      expect(message).not.toContain("lin_api_tenant-key");
    }
  });

  it("handles non-JSON error responses", async () => {
    installFetchMockRaw({ status: 500, text: "Internal Server Error" });

    await expect(
      executeLinearCreate({ title: "Test", description: "Desc" }, creds()),
    ).rejects.toThrow("HTTP 500");
  });

  it("throws when the success response is not valid JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })) as unknown as typeof globalThis.fetch;

    await expect(
      executeLinearCreate({ title: "Test", description: "Desc" }, creds()),
    ).rejects.toThrow("response could not be parsed");
  });

  it("throws when issueCreate reports success without an issue", async () => {
    installFetchMock([{ status: 200, body: { data: { issueCreate: { success: false } } } }]);

    await expect(
      executeLinearCreate({ title: "Test", description: "Desc" }, creds()),
    ).rejects.toThrow("response could not be parsed");
  });



});

// ---------------------------------------------------------------------------
// Tool execute — integration with handleAction
// ---------------------------------------------------------------------------

describe("createLinearTicket — tool execute", () => {
  it("calls handleAction with the right actionType and payload", async () => {
    // The env default must NOT decide the approval card's target — the default
    // team is per-workspace and resolves at execution time.
    process.env.LINEAR_DEFAULT_TEAM_KEY = "FALLBACK";

    const aiTool = createLinearTicket.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { title: "Test issue", description: "Details here" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    expect(lastHandleActionCall).not.toBeNull();
    const request = lastHandleActionCall!.request as Record<string, unknown>;
    expect(request.actionType).toBe("linear:create");
    expect(request.target).toBe("(workspace default team)");
    expect(request.target).not.toBe("FALLBACK");
    expect(request.reversible).toBe(true);
    expect((request.payload as Record<string, unknown>).title).toBe("Test issue");
  });

  it("uses the explicit team key as the approval-card target when provided", async () => {
    process.env.LINEAR_DEFAULT_TEAM_KEY = "FALLBACK";

    const aiTool = createLinearTicket.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { title: "Explicit team", description: "Details", teamKey: "ENG" },
      { toolCallId: "test-call-2", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    const request = lastHandleActionCall!.request as Record<string, unknown>;
    expect(request.target).toBe("ENG");
    expect((request.payload as Record<string, unknown>).teamKey).toBe("ENG");
  });

  it("resolves credentials from the ACTION's workspace and returns rollback metadata", async () => {
    installFetchMock([ISSUE_CREATE_OK]);

    const aiTool = createLinearTicket.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };
    await aiTool.execute(
      { title: "Rollback", description: "Details" },
      { toolCallId: "test-call-3", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    // `handleAction` is mocked, so drive the executor it was handed. This is
    // the seam that matters: the executor takes the workspace from the
    // execution CONTEXT, never from the ambient request — a manual-approval
    // action runs inside the approver's request.
    const execute = lastHandleActionCall!.executeFn as (
      payload: Record<string, unknown>,
      ctx: { workspaceId: string | null },
    ) => Promise<Record<string, unknown>>;

    const result = await execute(
      { title: "Rollback", description: "Details" },
      { workspaceId: "ws-tenant-1" },
    );

    expect(resolverCalls).toEqual([{ target: "linear", workspaceId: "ws-tenant-1" }]);
    expect(authHeaderOf(0)).toBe("Bearer lin_api_tenant-key");
    expect(result.id).toBe("issue-uuid-1");
    expect(result.rollbackInfo).toEqual({
      method: "archive",
      params: { issueId: "issue-uuid-1" },
    });
  });
});
