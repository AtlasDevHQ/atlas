/**
 * Tests for `POST /api/v1/execute-sql` (#4047 / ADR-0027, the sharpest of the
 * ADR-0025 §3 missing endpoints).
 *
 * The execute-sql REST endpoint runs ONE caller-authored SELECT through the
 * SHARED `runUserQueryPipeline` (`lib/tools/sql.ts`) — the REST-shaped sibling of
 * the agent loop — and returns `{columns, rows}`. These tests pin every
 * ADR-0027 acceptance criterion at the route seam (the pipeline itself owns the
 * 4-layer validation / whitelist / RLS / auto-LIMIT / audit, exercised by
 * sql.ts's own ~3,000-line suite):
 *
 *   - AC1 (pipeline reuse) — the route forwards `{ sql, connectionId? }` to
 *     `runUserQueryPipeline` and shapes its `ok` outcome to `{columns, rows}`;
 *     a `validation_failed` outcome (DML/DDL, multi-statement, non-whitelisted
 *     table, unparseable) becomes a 400 `invalid_sql`, never a silent skip.
 *   - AC1 billing parity (§1) — `checkAgentBillingGate` runs at the route before
 *     the pipeline; a block returns the billing envelope and the pipeline never
 *     runs. A gate throw fails closed to 503.
 *   - AC2 (member floor) — a `member` role reaches the pipeline (no admin floor).
 *   - AC3 (RLS fail-closed) — an `rls_failed` outcome maps to 403 `rls_blocked`.
 *   - AC4 (no whitelist-skip) — the route calls the standard
 *     `runUserQueryPipeline` (which always whitelist-validates SQL datasources);
 *     a regression guard pins the import + that no custom-validator bypass arg
 *     is threaded from the route.
 *   - AC5 (credential-derived isolation) — the body carries no org/workspace
 *     field; only `{ sql, connectionId? }` reaches the pipeline, and a
 *     no-bound-workspace credential is rejected with a 400 before the pipeline.
 *   - AC6 (audit origin) — the route binds `agentOrigin` (from the credential's
 *     `origin` claim, not hardcoded) + `actor.kind=human` into the request
 *     context the pipeline's audit row reads.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import type { UserQueryOutcome } from "@atlas/api/lib/tools/sql";

// ── Auth mock ──────────────────────────────────────────────────────────────

let fakeAuth: (AuthResult & { authenticated: true }) | null = null;

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve(
      fakeAuth ?? { authenticated: false, status: 401 as const, error: "anonymous" },
    ),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  isStrictRoutingEnabled: () => false,
}));

mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: async () => false,
}));

// Capture what the route binds into the request context so we can assert the
// origin + actor.kind audit triple (ADR-0027 sub-decision 6) actually flows.
let capturedContexts: Array<Record<string, unknown>> = [];

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (ctx: Record<string, unknown>, fn: () => unknown) => {
      capturedContexts.push(ctx);
      return fn();
    },
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

// ── Billing gate mock ────────────────────────────────────────────────────────
//
// Swapped per-test to exercise allow / block / throw. The real gate is
// integration-tested in lib/billing; here we only assert the route runs it
// before the pipeline and maps its verdict correctly.

type GateResult =
  | { allowed: true }
  | {
      allowed: false;
      errorCode: string;
      errorMessage: string;
      httpStatus: 403 | 404 | 429 | 503;
      retryable: boolean;
      retryAfterSeconds?: number;
    };

let gateImpl: (orgId: string | undefined) => Promise<GateResult> = async () => ({ allowed: true });
let gateCalls: Array<string | undefined> = [];

mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: (orgId: string | undefined) => {
    gateCalls.push(orgId);
    return gateImpl(orgId);
  },
}));

// ── MCP action policy mock (gate 1 — raw-SQL kill-switch, #4095) ──────────────
//
// The route now consults `loadMcpActionPolicy` for the `raw_sql` category before
// the pipeline (parity with the MCP `executeSQL` tool). Swap per-test to exercise
// allow / block / read-throw (fail-closed). Sentinel denial copy asserts the
// route surfaces the CENTRALIZED `mcpActionDenialCopy` (the real wording is pinned
// in action-policy.test.ts); mock ALL runtime exports so a sibling test loading the
// real module doesn't inherit a partial mock (CLAUDE.md mock-all-exports).
let rawSqlPolicy: "allow" | "block" | "throw" = "allow";
let policyCalls: Array<string> = [];
const ALL_CATEGORIES = ["datasource", "integration", "policy", "raw_sql"];

mock.module("@atlas/api/lib/mcp/action-policy", () => ({
  loadMcpActionPolicy: async (orgId: string) => {
    policyCalls.push(orgId);
    if (rawSqlPolicy === "throw") throw new Error("policy read boom");
    return { isBlocked: (c: string) => c === "raw_sql" && rawSqlPolicy === "block" };
  },
  mcpActionDenialCopy: (category: string) => ({
    message: `denied:${category}`,
    hint: `hint:${category}`,
  }),
  MCP_ACTION_CATEGORIES: ALL_CATEGORIES,
  MCP_ACTION_CATEGORY_META: [],
  isMcpActionCategory: (v: string) => ALL_CATEGORIES.includes(v),
  getMcpActionPolicyEntries: async () => [],
  setMcpActionCategoryStatus: async () => {},
}));

// ── runUserQueryPipeline mock ─────────────────────────────────────────────────
//
// Replace the shared pipeline so the route is tested without a live datasource.
// The route is a thin HTTP wrapper: it must forward exactly `{ sql, explanation,
// connectionId? }` and shape the discriminated outcome. `pipelineImpl` is
// swapped per-test to exercise ok / validation_failed / rls_failed / etc.

let pipelineImpl: (opts: {
  sql: string;
  explanation: string;
  connectionId?: string;
}) => Promise<UserQueryOutcome> = async () => ({
  kind: "ok",
  columns: ["n"],
  rows: [{ n: 1 }],
  rowCount: 1,
  executionMs: 3,
  truncated: false,
  maskingApplied: false,
});
let pipelineCalls: Array<Record<string, unknown>> = [];

mock.module("@atlas/api/lib/tools/sql", () => ({
  runUserQueryPipeline: (opts: { sql: string; explanation: string; connectionId?: string }) => {
    pipelineCalls.push(opts);
    return pipelineImpl(opts);
  },
  // Mock ALL named exports the module surfaces so a sibling test loading the
  // real module after this one doesn't inherit a partial mock (CLAUDE.md
  // mock-all-exports). The route only imports `runUserQueryPipeline`; the rest
  // are inert stubs.
  executeSQL: { description: "executeSQL", execute: async () => ({ success: true }) },
  validateSQL: async () => ({ valid: true, classification: { tablesAccessed: [], columnsAccessed: [] } }),
  parserDatabase: () => "PostgresQL",
  extractClassification: () => ({ tablesAccessed: [], columnsAccessed: [] }),
  buildSqlExecuteSpanAttrs: () => ({}),
}));

const { executeSql } = await import("../execute-sql");

function userAuth(
  opts: {
    orgId?: string | null;
    role?: "member" | "admin" | "owner";
    origin?: string;
    apiKey?: boolean;
  } = {},
): AuthResult & { authenticated: true } {
  const claims: Record<string, unknown> = {};
  if (opts.origin) claims.origin = opts.origin;
  if (opts.apiKey) claims.api_key = true;
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "user-1",
      mode: "managed",
      label: "user@test.dev",
      role: opts.role ?? "member",
      activeOrganizationId: opts.orgId === null ? undefined : opts.orgId ?? "org-1",
      ...(Object.keys(claims).length > 0 ? { claims } : {}),
    },
  };
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return executeSql.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  fakeAuth = null;
  capturedContexts = [];
  gateCalls = [];
  pipelineCalls = [];
  rawSqlPolicy = "allow";
  policyCalls = [];
  gateImpl = async () => ({ allowed: true });
  pipelineImpl = async () => ({
    kind: "ok",
    columns: ["n"],
    rows: [{ n: 1 }],
    rowCount: 1,
    executionMs: 3,
    truncated: false,
    maskingApplied: false,
  });
});

describe("POST /api/v1/execute-sql — auth + member floor (ADR-0027 §2)", () => {
  it("returns 401 when unauthenticated", async () => {
    fakeAuth = null;
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(401);
    expect(pipelineCalls).toHaveLength(0);
    expect(gateCalls).toHaveLength(0);
  });

  it("allows a member (member floor, no admin required)", async () => {
    fakeAuth = userAuth({ role: "member" });
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(200);
    expect(pipelineCalls).toHaveLength(1);
  });

  it("no escalation: a member's reach ≡ an owner's reach — identical pipeline call, no role gate (ADR-0027 §2)", async () => {
    // The whole point of the member floor: raw-SQL reach is identical regardless
    // of role — the whitelist/RLS/approval boundary is the same, the LLM's
    // self-restraint (the only thing raw SQL removes) was never a security
    // control. So the SAME SQL from a member and an owner must produce the SAME
    // forwarded pipeline call and the SAME 200 — no admin/owner privilege.
    fakeAuth = userAuth({ role: "member" });
    await post({ sql: "SELECT id FROM users" });
    fakeAuth = userAuth({ role: "owner" });
    await post({ sql: "SELECT id FROM users" });
    expect(pipelineCalls).toHaveLength(2);
    expect(pipelineCalls[0]).toEqual(pipelineCalls[1]);
    // Neither was rejected for role.
    expect(pipelineCalls[0]).toMatchObject({ sql: "SELECT id FROM users" });
  });
});

describe("POST /api/v1/execute-sql — raw-SQL kill-switch (gate 1, #4095)", () => {
  it("allows raw SQL through to the pipeline when the policy permits it (default enabled)", async () => {
    fakeAuth = userAuth();
    rawSqlPolicy = "allow";
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(200);
    expect(policyCalls).toEqual(["org-1"]);
    expect(pipelineCalls).toHaveLength(1);
  });

  it("blocks with 403 raw_sql_disabled (and never runs the pipeline) when an admin disabled raw SQL", async () => {
    fakeAuth = userAuth();
    rawSqlPolicy = "block";
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string; hint: string; requestId?: string };
    expect(body.error).toBe("raw_sql_disabled");
    // The route surfaces the centralized `mcpActionDenialCopy` (sentinel here;
    // real "use `atlas query`" wording pinned in action-policy.test.ts).
    expect(body.message).toBe("denied:raw_sql");
    expect(body.hint).toBe("hint:raw_sql");
    expect(body.requestId).toBeDefined();
    expect(pipelineCalls).toHaveLength(0);
  });

  it("fails closed to 503 action_policy_unavailable when the policy read throws", async () => {
    fakeAuth = userAuth();
    rawSqlPolicy = "throw";
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; retryable?: boolean; requestId?: string };
    expect(body.error).toBe("action_policy_unavailable");
    expect(body.retryable).toBe(true);
    expect(body.requestId).toBeDefined();
    expect(pipelineCalls).toHaveLength(0);
  });

  it("runs the policy gate AFTER billing — a billing block short-circuits before the policy check", async () => {
    fakeAuth = userAuth();
    rawSqlPolicy = "block";
    gateImpl = async () => ({
      allowed: false,
      errorCode: "trial_expired",
      errorMessage: "Trial expired.",
      httpStatus: 403,
      retryable: false,
    });
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    // Billing wins the ordering — the raw_sql block never fires, the policy is
    // never consulted, and the pipeline never runs.
    expect(body.error).toBe("trial_expired");
    expect(policyCalls).toHaveLength(0);
    expect(pipelineCalls).toHaveLength(0);
  });
});

describe("POST /api/v1/execute-sql — outcome → HTTP mapping is total", () => {
  // Pin every non-`ok` UserQueryOutcome arm → {status, error} so a wrong status
  // or wire code on any arm fails here rather than shipping silently.
  const cases: Array<{ outcome: UserQueryOutcome; status: number; error: string }> = [
    { outcome: { kind: "validation_failed", message: "x" }, status: 400, error: "invalid_sql" },
    {
      outcome: { kind: "plugin_rejected", message: "x" },
      status: 400,
      error: "plugin_rejected",
    },
    { outcome: { kind: "query_failed", message: "x" }, status: 400, error: "query_failed" },
    { outcome: { kind: "rls_failed", message: "x" }, status: 403, error: "rls_blocked" },
    {
      outcome: { kind: "approval_identity_missing", message: "x" },
      status: 401,
      error: "auth_required",
    },
    {
      outcome: { kind: "approval_unavailable", message: "x" },
      status: 503,
      error: "approval_unavailable",
    },
    { outcome: { kind: "rate_limited", message: "x" }, status: 429, error: "rate_limited" },
    {
      outcome: { kind: "concurrency_limited", message: "x" },
      status: 429,
      error: "concurrency_limited",
    },
    { outcome: { kind: "no_datasource", message: "x" }, status: 503, error: "no_datasource" },
    { outcome: { kind: "pool_exhausted", message: "x" }, status: 503, error: "pool_exhausted" },
    {
      outcome: { kind: "enterprise_unavailable", message: "x" },
      status: 503,
      error: "enterprise_load_failed",
    },
  ];

  for (const { outcome, status, error } of cases) {
    it(`maps ${outcome.kind} → ${status} ${error}`, async () => {
      fakeAuth = userAuth();
      pipelineImpl = async () => outcome;
      const res = await post({ sql: "SELECT 1" });
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error: string; requestId?: string };
      expect(body.error).toBe(error);
      // Every error envelope carries a requestId for log correlation.
      expect(body.requestId).toBeDefined();
    });
  }

  it("includes retryAfterMs on a rate_limited outcome when present", async () => {
    fakeAuth = userAuth();
    pipelineImpl = async () => ({ kind: "rate_limited", message: "slow", retryAfterMs: 5000 });
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { retryAfterMs?: number };
    expect(body.retryAfterMs).toBe(5000);
  });
});

describe("POST /api/v1/execute-sql — pipeline reuse (ADR-0027 AC1)", () => {
  it("forwards { sql, connectionId } to runUserQueryPipeline and returns {columns, rows}", async () => {
    fakeAuth = userAuth();
    pipelineImpl = async () => ({
      kind: "ok",
      columns: ["id", "name"],
      rows: [{ id: 1, name: "a" }],
      rowCount: 1,
      executionMs: 12,
      truncated: false,
      maskingApplied: false,
    });
    const res = await post({ sql: "SELECT id, name FROM users", connectionId: "warehouse" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
      executionMs: number;
      executedAt: string;
    };
    expect(body.columns).toEqual(["id", "name"]);
    expect(body.rows).toEqual([{ id: 1, name: "a" }]);
    expect(body.rowCount).toBe(1);
    expect(body.truncated).toBe(false);
    expect(typeof body.executedAt).toBe("string");
    // The route forwards exactly the SQL + connectionId; the explanation is the
    // route's own audit/approval surface description.
    expect(pipelineCalls).toHaveLength(1);
    expect(pipelineCalls[0]).toMatchObject({
      sql: "SELECT id, name FROM users",
      connectionId: "warehouse",
      explanation: "CLI raw SQL execution",
    });
  });

  it("omits connectionId when not supplied (pipeline defaults to the workspace datasource)", async () => {
    fakeAuth = userAuth();
    await post({ sql: "SELECT 1" });
    expect(pipelineCalls[0]).not.toHaveProperty("connectionId");
  });

  it("propagates the truncated row-cap flag from the pipeline", async () => {
    fakeAuth = userAuth();
    pipelineImpl = async () => ({
      kind: "ok",
      columns: ["n"],
      rows: [{ n: 1 }],
      rowCount: 1,
      executionMs: 1,
      truncated: true,
      maskingApplied: false,
    });
    const res = await post({ sql: "SELECT n FROM big" });
    const body = (await res.json()) as { truncated: boolean };
    expect(body.truncated).toBe(true);
  });

  it("maps a validation_failed outcome (DML/whitelist/unparseable) to 400 invalid_sql, never a silent skip", async () => {
    fakeAuth = userAuth();
    pipelineImpl = async () => ({
      kind: "validation_failed",
      message: 'Table "secrets" is not in the allowed list.',
    });
    const res = await post({ sql: "SELECT * FROM secrets" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_sql");
    expect(body.message).toContain("allowed list");
  });
});

describe("POST /api/v1/execute-sql — billing gate-0 (ADR-0027 §1)", () => {
  it("runs the billing gate BEFORE the pipeline", async () => {
    fakeAuth = userAuth({ orgId: "org-1" });
    await post({ sql: "SELECT 1" });
    expect(gateCalls).toEqual(["org-1"]);
    expect(pipelineCalls).toHaveLength(1);
  });

  it("blocks a suspended/trial-expired/plan-exhausted workspace before the pipeline runs", async () => {
    fakeAuth = userAuth();
    gateImpl = async () => ({
      allowed: false,
      errorCode: "trial_expired",
      errorMessage: "Your trial has expired.",
      httpStatus: 403,
      retryable: false,
    });
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("trial_expired");
    expect(body.message).toContain("trial");
    // The pipeline never ran — the gate short-circuited.
    expect(pipelineCalls).toHaveLength(0);
  });

  it("surfaces a throttle as 429 with retryAfterSeconds", async () => {
    fakeAuth = userAuth();
    gateImpl = async () => ({
      allowed: false,
      errorCode: "workspace_throttled",
      errorMessage: "Slow down.",
      httpStatus: 429,
      retryable: true,
      retryAfterSeconds: 30,
    });
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfterSeconds?: number };
    expect(body.error).toBe("workspace_throttled");
    expect(body.retryAfterSeconds).toBe(30);
    expect(pipelineCalls).toHaveLength(0);
  });

  it("fails CLOSED (503) when the gate throws — never an allow", async () => {
    fakeAuth = userAuth();
    gateImpl = async () => {
      throw new Error("billing infra down");
    };
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("billing_check_failed");
    expect(pipelineCalls).toHaveLength(0);
  });

  it("emits the gate's real 404 status (deleted workspace), NOT coerced to 403", async () => {
    // The gate's httpStatus is 403|404|429|503; a `workspace_deleted` block is a
    // 404. The route must surface 404 (declared in the responses map) so the CLI
    // client maps it to the distinct workspace_not_found remedy, not a generic
    // 403/request_failed.
    fakeAuth = userAuth();
    gateImpl = async () => ({
      allowed: false,
      errorCode: "workspace_deleted",
      errorMessage: "This workspace no longer exists.",
      httpStatus: 404,
      retryable: false,
    });
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("workspace_deleted");
    expect(body.message).toContain("no longer exists");
    expect(pipelineCalls).toHaveLength(0);
  });
});

describe("POST /api/v1/execute-sql — RLS fail-closed (ADR-0027 §3)", () => {
  it("maps an rls_failed outcome to 403 rls_blocked (never claim-less rows)", async () => {
    fakeAuth = userAuth();
    pipelineImpl = async () => ({
      kind: "rls_failed",
      message: "Row-level security is enabled but no usable claim was supplied.",
    });
    const res = await post({ sql: "SELECT * FROM orders" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rls_blocked");
  });
});

describe("POST /api/v1/execute-sql — approval classification (ADR-0027 §2)", () => {
  it("maps an approval_required outcome to 409 with the request id + matched rules", async () => {
    fakeAuth = userAuth();
    pipelineImpl = async () => ({
      kind: "approval_required",
      approvalRequestId: "appr-1",
      matchedRules: ["PII access"],
      message: "This query requires approval.",
    });
    const res = await post({ sql: "SELECT ssn FROM users" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      approvalRequestId: string;
      matchedRules: string[];
    };
    expect(body.error).toBe("approval_required");
    expect(body.approvalRequestId).toBe("appr-1");
    expect(body.matchedRules).toEqual(["PII access"]);
  });
});

describe("POST /api/v1/execute-sql — credential-derived isolation (ADR-0027 §5)", () => {
  it("ignores any org/workspace/connection-owner field in the request body", async () => {
    // The org is a property of the credential — a body-supplied org must not
    // change what runs or reach the pipeline.
    fakeAuth = userAuth({ orgId: "org-1" });
    const res = await post({
      sql: "SELECT 1",
      orgId: "org-2",
      workspaceId: "org-2",
      connectionOwner: "org-2",
    });
    expect(res.status).toBe(200);
    // Only sql/explanation reach the pipeline — no org/workspace/owner leaks in,
    // and connectionId is absent (the body didn't supply one).
    expect(pipelineCalls).toHaveLength(1);
    expect(Object.keys(pipelineCalls[0]).toSorted()).toEqual(["explanation", "sql"]);
    // The gate was keyed on the CREDENTIAL's org, not the body's.
    expect(gateCalls).toEqual(["org-1"]);
  });

  it("rejects a credential with no bound workspace with a 400 before the gate or pipeline", async () => {
    fakeAuth = userAuth({ orgId: null });
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("workspace");
    expect(gateCalls).toHaveLength(0);
    expect(pipelineCalls).toHaveLength(0);
  });

  it("maps a cross-workspace connection lookup miss to 503 connection_unavailable", async () => {
    // A connectionId from another workspace simply isn't found in this org's
    // registry → the pipeline surfaces connection_unavailable (ADR-0027 §5).
    fakeAuth = userAuth();
    pipelineImpl = async () => ({
      kind: "connection_unavailable",
      message: 'Connection "other-ws-conn" is not registered.',
      connectionId: "other-ws-conn",
    });
    const res = await post({ sql: "SELECT 1", connectionId: "other-ws-conn" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; connectionId: string };
    expect(body.error).toBe("connection_unavailable");
    expect(body.connectionId).toBe("other-ws-conn");
  });
});

describe("POST /api/v1/execute-sql — audit origin (ADR-0027 §6)", () => {
  it("binds agentOrigin=cli + actor.kind=human into the request context for a device-flow bearer", async () => {
    fakeAuth = userAuth({ origin: "cli" });
    await post({ sql: "SELECT 1" });
    const sqlCtx = capturedContexts.find((c) => c.actor !== undefined);
    expect(sqlCtx?.agentOrigin).toBe("cli");
    expect(sqlCtx?.actor).toEqual({ kind: "human" });
  });

  it("does NOT mislabel a non-cli session as cli (origin derived from claims, not hardcoded)", async () => {
    fakeAuth = userAuth({ origin: undefined }); // e.g. a web session
    await post({ sql: "SELECT 1" });
    const sqlCtx = capturedContexts.find((c) => c.actor !== undefined);
    expect(sqlCtx?.agentOrigin).toBeUndefined();
    expect(sqlCtx?.actor).toEqual({ kind: "human" });
  });

  it("stamps actor.kind=api_key for an unattended workspace API key (#4046 / ADR-0027 §6)", async () => {
    // The api-key auth path marks the resolved user with claims.api_key=true and
    // keeps origin=cli (the CLI transport). The audit must distinguish this
    // unattended key from a human device-flow login.
    fakeAuth = userAuth({ origin: "cli", apiKey: true });
    await post({ sql: "SELECT 1" });
    const sqlCtx = capturedContexts.find((c) => c.actor !== undefined);
    expect(sqlCtx?.agentOrigin).toBe("cli");
    expect(sqlCtx?.actor).toEqual({ kind: "api_key" });
  });

  it("re-threads the developer atlasMode through the inner bind (withRequestContext replaces, not merges)", async () => {
    // Regression guard: the inner withRequestContext is AsyncLocalStorage.run,
    // which REPLACES the context. Dropping atlasMode would silently downgrade a
    // developer-mode caller to the published overlay inside runUserQueryPipeline
    // (it reads reqCtx.atlasMode ?? "published" for connection visibility + the
    // whitelist scope). Use an owner + the developer-mode header so the
    // middleware resolves atlasMode="developer" (members always resolve to
    // published, which would mask the bug).
    fakeAuth = userAuth({ role: "owner" });
    await post({ sql: "SELECT 1" }, { "x-atlas-mode": "developer" });
    const sqlCtx = capturedContexts.find((c) => c.actor !== undefined);
    expect(sqlCtx?.atlasMode).toBe("developer");
  });
});

describe("POST /api/v1/execute-sql — request validation", () => {
  it("returns 422 for an empty sql string", async () => {
    fakeAuth = userAuth();
    const res = await post({ sql: "   " });
    expect(res.status).toBe(422);
    expect(pipelineCalls).toHaveLength(0);
  });

  it("returns 422 for a missing sql field", async () => {
    fakeAuth = userAuth();
    const res = await post({});
    expect(res.status).toBe(422);
    expect(pipelineCalls).toHaveLength(0);
  });

  it("returns 422 for sql over the max length bound", async () => {
    fakeAuth = userAuth();
    const res = await post({ sql: `SELECT ${"a".repeat(100_001)}` });
    expect(res.status).toBe(422);
    expect(pipelineCalls).toHaveLength(0);
  });

  it("returns 400 for a malformed JSON body", async () => {
    fakeAuth = userAuth();
    const res = await post("{ not json");
    expect(res.status).toBe(400);
  });
});
