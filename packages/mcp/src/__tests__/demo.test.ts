/**
 * The anonymous demo door — `/mcp/demo` (#5604).
 *
 *   1. Every refusal fails closed with a request id: demo off, no/invalid
 *      bearer, unresolvable demo workspace, a token or session row pinned to a
 *      different workspace, an MCP session driven by a bearer that did not
 *      create it.
 *   2. The surface is exactly `searchAtlas`, `executeSQL`, `shareEmail` —
 *      less than the email demo, never more.
 *   3. Both anonymous budgets (per IP, per minted identity) refuse a tool
 *      call BEFORE the body runs, with a `rate_limited` envelope.
 *   4. A delivered answer is counted; an error envelope is not.
 *   5. `shareEmail` is refused before the first answer.
 *
 * The lib's DB-backed seams are injected (`DemoMcpDeps`); the token is signed
 * for real so the bearer path is the production one.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { getRequestContext } from "@atlas/api/lib/logger";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseAtlasMcpToolError } from "@useatlas/types/mcp";

// ── Module-scope mocks (every named export, per testing.md) ─────────────

// The request-context frame the tool body actually runs in — what
// `resolveExecutionTarget`, `loadOrgWhitelist` and the connection-visibility
// gate read. Captured here because the shared dispatch opens its own frame
// per call, and what the door stamped has to survive it: the `connectionId`
// pin, and the `atlasMode` both whitelist readers must agree on (#5626).
let executeSqlFrame: ReturnType<typeof getRequestContext>;
const mockExecuteSQLExecute = mock<(...args: unknown[]) => Promise<unknown>>(async () => {
  executeSqlFrame = getRequestContext();
  return {
    success: true,
    explanation: "Count orders",
    row_count: 1,
    columns: ["count"],
    rows: [{ count: 42 }],
    truncated: false,
  };
});
const notInDemoTest = (name: string) => () => {
  throw new Error(`${name} called from demo test — only executeSQL.execute is exercised here`);
};
void mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: { description: "Execute SQL", execute: mockExecuteSQLExecute },
  // Every other named export, as throw-on-call stubs (testing.md: mock all
  // exports — a partial mock leaks across files under the in-process runner).
  MAX_SQL_LEN: 100_000,
  extractClassification: notInDemoTest("extractClassification"),
  parserDatabase: notInDemoTest("parserDatabase"),
  validateSQL: notInDemoTest("validateSQL"),
  buildSqlExecuteSpanAttrs: notInDemoTest("buildSqlExecuteSpanAttrs"),
  runSqlPipelineEffect: notInDemoTest("runSqlPipelineEffect"),
  runUserQueryPipeline: notInDemoTest("runUserQueryPipeline"),
}));

const { BRAIN_TOOL_REASONS: REAL_BRAIN_TOOL_REASONS } = await import(
  "@atlas/api/lib/tools/search-brain"
);
const mockSearchBrainExecute = mock<(...args: unknown[]) => Promise<unknown>>(async () => ({
  results: [],
  neighbors: [],
  stores: {
    attested: { queried: true, matched: 0, truncated: false },
    "on-record": { queried: true, matched: 0, truncated: false },
    document: { queried: true, matched: 0, truncated: false },
  },
  tensionsTruncated: false,
}));
void mock.module("@atlas/api/lib/tools/search-brain", () => ({
  BRAIN_TOOL_REASONS: REAL_BRAIN_TOOL_REASONS,
  SEARCH_BRAIN_DESCRIPTION: "Search the Company Atlas",
  normalizeSearchInput: (input: Record<string, unknown>) => input,
  searchBrain: { description: "Search the Company Atlas", execute: mockSearchBrainExecute },
}));

void mock.module("@atlas/api/lib/mcp/action-policy", () => ({
  loadMcpActionPolicy: async () => ({ isBlocked: () => false }),
  mcpActionDenialCopy: (category: string) => ({
    message: `MCP '${category}' actions are disabled for this workspace by an administrator.`,
    hint: "A workspace admin can re-enable this category under Admin → MCP action policy.",
  }),
  MCP_ACTION_CATEGORIES: ["datasource", "integration", "policy", "raw_sql"],
  MCP_ACTION_CATEGORY_META: [],
  isMcpActionCategory: (v: string) => ["datasource", "integration", "policy", "raw_sql"].includes(v),
  getMcpActionPolicyEntries: async () => [],
  setMcpActionCategoryStatus: async () => {},
}));

void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: async () => ({ allowed: true }),
  BillingBlockedError: class BillingBlockedError extends Error {
    override readonly name = "BillingBlockedError";
  },
}));

import {
  signAnonymousDemoToken,
  type AnonymousDemoLimitResult,
  type AnonymousDemoSession,
  type CaptureAnonymousDemoEmailResult,
  type DemoWorkspaceResolution,
} from "@atlas/api/lib/demo-anonymous";
import { createDemoMcpRouter, type DemoMcpDeps } from "../demo.js";

// ── Fixtures ────────────────────────────────────────────────────────────

const ORIG_SECRET = process.env.BETTER_AUTH_SECRET;
beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-at-least-32-chars-long";
});
afterAll(() => {
  if (ORIG_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIG_SECRET;
});

const WS = "org_demo";
const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SID_B = "bbbbbbbb-0000-4000-8000-000000000002";

function session(id: string, overrides: Partial<AnonymousDemoSession> = {}): AnonymousDemoSession {
  return {
    id,
    workspaceId: WS,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    answerCount: 0,
    emailCapturedAt: null,
    ...overrides,
  };
}

function tokenFor(sid: string, ws = WS): string {
  return signAnonymousDemoToken(sid, ws, 60_000)!.token;
}

interface Harness {
  deps: DemoMcpDeps;
  sessions: Map<string, AnonymousDemoSession>;
  limitCalls: Array<{ ip: string | null; sessionId: string | null }>;
  answers: string[];
  setVerdict: (v: AnonymousDemoLimitResult) => void;
  setEmail: (v: CaptureAnonymousDemoEmailResult) => void;
}

/** Injected seams; the token verifier is the production one unless a test overrides it. */
function makeHarness(overrides: Partial<DemoMcpDeps> = {}): Harness {
  const sessions = new Map<string, AnonymousDemoSession>([
    [SID_A, session(SID_A)],
    [SID_B, session(SID_B)],
  ]);
  const limitCalls: Harness["limitCalls"] = [];
  const answers: string[] = [];
  let verdict: AnonymousDemoLimitResult = { allowed: true };
  let email: CaptureAnonymousDemoEmailResult = { ok: false, reason: "answer_required" };
  const deps: DemoMcpDeps = {
    demoEnabled: () => true,
    resolveWorkspace: async (): Promise<DemoWorkspaceResolution> => ({ ok: true, id: WS, slug: "novamart-demo" }),
    loadSession: async (id) => sessions.get(id) ?? null,
    checkLimits: async (input) => {
      limitCalls.push(input);
      return verdict;
    },
    recordAnswer: async (id) => {
      answers.push(id);
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, answerCount: s.answerCount + 1 });
    },
    captureEmail: async () => email,
    ...overrides,
  };
  return {
    deps,
    sessions,
    limitCalls,
    answers,
    setVerdict: (v) => { verdict = v; },
    setEmail: (v) => { email = v; },
  };
}

function appFor(deps: DemoMcpDeps): Hono {
  const app = new Hono();
  app.route("/mcp/demo", createDemoMcpRouter(deps));
  return app;
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1.0" } },
});

async function rawInit(app: Hono, headers: Record<string, string>, path = "/mcp/demo"): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: INIT_BODY,
  });
}

// ── Refusals ────────────────────────────────────────────────────────────

describe("/mcp/demo — refusals fail closed with a request id", () => {
  it("404s when demo mode is off, before reading any bearer", async () => {
    const h = makeHarness({ demoEnabled: () => false });
    const res = await rawInit(appFor(h.deps), { Authorization: `Bearer ${tokenFor(SID_A)}` });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("not_found");
    expect(body.requestId).toBeTruthy();
  });

  it("401 missing_bearer with a mint hint", async () => {
    const h = makeHarness();
    const res = await rawInit(appFor(h.deps), {});
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; hint: string; requestId: string };
    expect(body.error).toBe("missing_bearer");
    expect(body.hint).toContain("init --demo");
    expect(body.requestId).toBeTruthy();
  });

  it("401 invalid_bearer for a garbage or expired token, and for an EMAIL demo token", async () => {
    const h = makeHarness();
    const app = appFor(h.deps);
    expect((await rawInit(app, { Authorization: "Bearer nope" })).status).toBe(401);
    const expired = signAnonymousDemoToken(SID_A, WS, -1)!.token;
    expect((await rawInit(app, { Authorization: `Bearer ${expired}` })).status).toBe(401);
    const { signDemoToken } = await import("@atlas/api/lib/demo");
    const emailToken = signDemoToken("visitor@example.com")!.token;
    const res = await rawInit(app, { Authorization: `Bearer ${emailToken}` });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_bearer");
  });

  it.each([
    ["no_internal_db"],
    ["not_found"],
    ["lookup_failed"],
  ] as const)("503 demo_workspace_unavailable when the demo workspace is unresolved (%s)", async (reason) => {
    const h = makeHarness({ resolveWorkspace: async () => ({ ok: false, reason }) });
    const res = await rawInit(appFor(h.deps), { Authorization: `Bearer ${tokenFor(SID_A)}` });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("demo_workspace_unavailable");
    expect(body.requestId).toBeTruthy();
  });

  it("403 workspace_mismatch when the TOKEN was minted for a different workspace", async () => {
    const h = makeHarness();
    const res = await rawInit(appFor(h.deps), { Authorization: `Bearer ${tokenFor(SID_A, "org_other")}` });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("workspace_mismatch");
    expect(body.requestId).toBeTruthy();
  });

  it("403 workspace_mismatch when the SESSION ROW is pinned to a different workspace", async () => {
    const h = makeHarness();
    h.sessions.set(SID_A, session(SID_A, { workspaceId: "org_other" }));
    const res = await rawInit(appFor(h.deps), { Authorization: `Bearer ${tokenFor(SID_A)}` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("workspace_mismatch");
  });

  it("401 unknown_session / session_expired, and 503 auth_unavailable when the lookup throws", async () => {
    const h = makeHarness();
    const app = appFor(h.deps);
    h.sessions.delete(SID_A);
    let res = await rawInit(app, { Authorization: `Bearer ${tokenFor(SID_A)}` });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_session");

    h.sessions.set(SID_A, session(SID_A, { expiresAt: new Date(Date.now() - 1) }));
    res = await rawInit(app, { Authorization: `Bearer ${tokenFor(SID_A)}` });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("session_expired");

    const failing = makeHarness({ loadSession: async () => { throw new Error("db down"); } });
    res = await rawInit(appFor(failing.deps), { Authorization: `Bearer ${tokenFor(SID_A)}` });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("auth_unavailable");
    expect(body.requestId).toBeTruthy();
  });

  it("429s a NEW session when either anonymous budget is exhausted (a token cannot flood the session cap)", async () => {
    const h = makeHarness();
    h.setVerdict({ allowed: false, bucket: "ip", retryAfterMs: 30_000 });
    const res = await rawInit(appFor(h.deps), { Authorization: `Bearer ${tokenFor(SID_A)}` });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    const body = (await res.json()) as { error: string; requestId: string; retryAfterSeconds: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBe(30);
    expect(body.requestId).toBeTruthy();
    expect(h.limitCalls.at(-1)).toEqual({ ip: null, sessionId: SID_A });
  });

  it("answers on the legacy /sse alias too", async () => {
    const h = makeHarness();
    const res = await rawInit(appFor(h.deps), { Authorization: `Bearer ${tokenFor(SID_A)}` }, "/mcp/demo/sse");
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });
});

// ── The live surface ────────────────────────────────────────────────────

interface Live {
  client: Client;
  close: () => Promise<void>;
  url: string;
  sessionId: () => string | undefined;
}

async function connect(app: Hono, token: string, extraHeaders: Record<string, string> = {}): Promise<Live> {
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: app.fetch });
  const url = `http://127.0.0.1:${server.port}/mcp/demo`;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...extraHeaders } },
  });
  const client = new Client({ name: "demo-test", version: "0.0.1" });
  await client.connect(transport);
  return {
    client,
    url,
    sessionId: () => transport.sessionId,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.stop(true);
    },
  };
}

function toolErrorOf(result: { isError?: boolean; content: unknown }) {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return parseAtlasMcpToolError(text);
}

describe("/mcp/demo — the anonymous principal's reach", () => {
  const opened: Live[] = [];
  afterEach(async () => {
    for (const live of opened.splice(0)) await live.close();
    mockExecuteSQLExecute.mockClear();
    executeSqlFrame = undefined;
    mockSearchBrainExecute.mockClear();
  });

  it("exposes exactly searchAtlas, executeSQL and shareEmail — no explore, no semantic tools, no prompts", async () => {
    const h = makeHarness();
    const live = await connect(appFor(h.deps), tokenFor(SID_A));
    opened.push(live);
    const { tools } = await live.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["searchAtlas", "executeSQL", "shareEmail"]);
    const caps = live.client.getServerCapabilities();
    expect(caps?.prompts).toBeUndefined();
    expect(caps?.resources).toBeUndefined();
  });

  it("runs executeSQL for the demo workspace, charges BOTH budgets, and counts the answer", async () => {
    const h = makeHarness();
    const live = await connect(appFor(h.deps), tokenFor(SID_A), { "x-forwarded-for": "203.0.113.5" });
    opened.push(live);
    const result = await live.client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT count(*) FROM orders", explanation: "count" },
    });
    expect(result.isError).toBeFalsy();
    expect(mockExecuteSQLExecute).toHaveBeenCalledTimes(1);
    // The visitor sent only `sql`; the door targets the demo install, never
    // the registry's `"default"` (which SaaS never admits).
    const args = mockExecuteSQLExecute.mock.calls[0]?.[0] as { connectionId?: string };
    expect(args.connectionId).toBe("__demo__");
    // ...and the frame the body ran in carries the same pin, so
    // `resolveExecutionTarget` reads the call as the all-sources self target.
    expect(executeSqlFrame?.connectionId).toBe("__demo__");
    // The door is published-only. `loadOrgWhitelist` reads this mode off the
    // frame; with it dropped it loads every status, drafts included, while
    // the connection gate stays published — the split #5626 closes.
    expect(executeSqlFrame?.atlasMode).toBe("published");
    // The gate consulted the limits with this session's identity.
    expect(h.limitCalls.length).toBeGreaterThanOrEqual(1);
    expect(h.limitCalls.at(-1)?.sessionId).toBe(SID_A);
    expect(h.answers).toEqual([SID_A]);
  });

  it("passes an explicit executeSQL connectionId through untouched", async () => {
    const h = makeHarness();
    const live = await connect(appFor(h.deps), tokenFor(SID_A));
    opened.push(live);
    const result = await live.client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "probe", connectionId: "warehouse" },
    });
    expect(result.isError).toBeFalsy();
    const args = mockExecuteSQLExecute.mock.calls[0]?.[0] as { connectionId?: string };
    expect(args.connectionId).toBe("warehouse");
  });

  it("refuses at the per-IDENTITY budget BEFORE the body runs, with a rate_limited envelope", async () => {
    const h = makeHarness();
    const live = await connect(appFor(h.deps), tokenFor(SID_A));
    opened.push(live);
    h.setVerdict({ allowed: false, bucket: "identity", retryAfterMs: 4200 });
    const result = await live.client.callTool({
      name: "searchAtlas",
      arguments: { query: "who owns the ETL" },
    });
    expect(result.isError).toBe(true);
    const err = toolErrorOf(result as { isError?: boolean; content: unknown });
    expect(err?.code).toBe("rate_limited");
    expect(err?.retry_after).toBe(5);
    expect(mockSearchBrainExecute).not.toHaveBeenCalled();
    expect(h.answers).toEqual([]);
  });

  it("refuses at the per-IP budget BEFORE the body runs, with a rate_limited envelope", async () => {
    const h = makeHarness();
    const live = await connect(appFor(h.deps), tokenFor(SID_A));
    opened.push(live);
    h.setVerdict({ allowed: false, bucket: "ip", retryAfterMs: 1000 });
    const result = await live.client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "probe" },
    });
    expect(result.isError).toBe(true);
    const err = toolErrorOf(result as { isError?: boolean; content: unknown });
    expect(err?.code).toBe("rate_limited");
    expect(err?.hint).toContain("client IP");
    expect(mockExecuteSQLExecute).not.toHaveBeenCalled();
    expect(h.answers).toEqual([]);
  });

  it("does not count an error envelope as an answer", async () => {
    const h = makeHarness();
    mockExecuteSQLExecute.mockResolvedValueOnce({ success: false, error: "Table not in whitelist: secrets" });
    const live = await connect(appFor(h.deps), tokenFor(SID_A));
    opened.push(live);
    const result = await live.client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT * FROM secrets", explanation: "probe" },
    });
    expect(result.isError).toBe(true);
    expect(h.answers).toEqual([]);
  });

  it("shareEmail is refused before the first answer and accepted after it", async () => {
    const h = makeHarness();
    const live = await connect(appFor(h.deps), tokenFor(SID_A));
    opened.push(live);

    const before = await live.client.callTool({ name: "shareEmail", arguments: { email: "v@example.com" } });
    expect(before.isError).toBe(true);
    const err = toolErrorOf(before as { isError?: boolean; content: unknown });
    expect(err?.code).toBe("validation_failed");
    expect(err?.message).toContain("after the first answer");

    h.setEmail({ ok: true, returning: false });
    const after = await live.client.callTool({ name: "shareEmail", arguments: { email: "v@example.com" } });
    expect(after.isError).toBeFalsy();
    expect((after.content as Array<{ text: string }>)[0]?.text).toContain("recorded");
  });

  it("refuses an MCP session driven by a bearer that did not create it (session_not_owned)", async () => {
    const h = makeHarness();
    const app = appFor(h.deps);
    const live = await connect(app, tokenFor(SID_A));
    opened.push(live);
    const mcpSessionId = live.sessionId();
    expect(mcpSessionId).toBeTruthy();

    const res = await fetch(live.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tokenFor(SID_B)}`,
        "mcp-session-id": mcpSessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("session_not_owned");
    expect(body.requestId).toBeTruthy();
  });
});
