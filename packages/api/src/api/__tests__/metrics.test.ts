/**
 * Tests for the POST /api/v1/metrics/{id}/run route (#4048).
 *
 * Mounts the `metrics` router standalone and mocks the four seams it touches
 * (auth admission, billing gate-0, the shared metric resolver, and the shared
 * SQL pipeline) so the route's gate ordering, outcome→HTTP mapping, and
 * credential-derived audit context are tested without a live datasource.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import type {
  MetricRunResolution,
} from "@atlas/api/lib/semantic/metric-run";
import type { UserQueryOutcome } from "@atlas/api/lib/tools/sql";

// --- Auth admission -------------------------------------------------------

const mockAuthenticateRequest: Mock<(req: Request) => Promise<AuthResult>> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "managed" as const,
    user: {
      id: "user-1",
      mode: "managed",
      label: "Alice",
      role: "member",
      activeOrganizationId: "org-1",
      claims: { sub: "user-1", org_id: "org-1", origin: "cli" },
    },
  } as unknown as AuthResult),
);
const mockCheckRateLimit: Mock<(key: string) => { allowed: boolean; retryAfterMs?: number }> = mock(
  () => ({ allowed: true }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  internalQuery: async () => [],
  internalExecute: async () => {},
  getInternalDB: () => ({}),
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
  _resetPool: () => {},
}));

// --- Billing gate-0 -------------------------------------------------------

type GateResult =
  | { allowed: true }
  | {
      allowed: false;
      errorCode: string;
      errorMessage: string;
      httpStatus: number;
      retryable: boolean;
      retryAfterSeconds?: number;
    };
const mockCheckAgentBillingGate: Mock<(orgId: string | undefined) => Promise<GateResult>> = mock(
  () => Promise.resolve({ allowed: true }),
);
mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mockCheckAgentBillingGate,
}));

// --- Shared metric resolver ----------------------------------------------

const mockResolveMetricRun: Mock<() => Promise<MetricRunResolution>> = mock(() =>
  Promise.resolve({
    kind: "ok" as const,
    metric: {
      id: "total_gmv",
      label: "Total GMV",
      description: "Gross merchandise value",
      sql: "SELECT 42 AS total_gmv",
      type: null,
      aggregation: null,
      unit: null,
      source: "default",
      binding: null,
    },
    targetConnectionId: undefined,
  }),
);
mock.module("@atlas/api/lib/semantic/metric-run", () => ({
  resolveMetricRun: mockResolveMetricRun,
  DEFAULT_SEMANTIC_GROUP: "default",
}));

// --- Shared SQL pipeline --------------------------------------------------

// Capture the request context the route binds via the REAL withRequestContext
// (AsyncLocalStorage) by reading getRequestContext() inside the pipeline mock,
// plus the opts the route forwards (sql + connectionId).
type PipelineOpts = { sql: string; explanation: string; connectionId?: string };
let capturedContext: { agentOrigin?: unknown; actorKind?: unknown } = {};
let capturedOpts: PipelineOpts | undefined;
const mockRunUserQueryPipeline: Mock<(opts: PipelineOpts) => Promise<UserQueryOutcome>> = mock(
  async (opts: PipelineOpts) => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    const ctx = getRequestContext();
    capturedContext = { agentOrigin: ctx?.agentOrigin, actorKind: ctx?.actor?.kind };
    capturedOpts = opts;
    return {
      kind: "ok" as const,
      columns: ["total_gmv"],
      rows: [{ total_gmv: 42 }],
      rowCount: 1,
      executionMs: 3,
      truncated: false,
      maskingApplied: false,
    };
  },
);
mock.module("@atlas/api/lib/tools/sql", () => ({
  runUserQueryPipeline: mockRunUserQueryPipeline,
}));

// Mount ONLY the metrics router on a fresh app — keeps the test's import
// graph to the route's own dependencies (no whole-app boot), so the
// tools/sql mock below only has to satisfy the route's dynamic import.
const { OpenAPIHono } = await import("@hono/zod-openapi");
const { metrics } = await import("../routes/metrics");
const app = new OpenAPIHono();
app.route("/api/v1/metrics", metrics);

function runMetricRequest(
  id: string,
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://localhost/api/v1/metrics/${id}/run`, {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

beforeEach(() => {
  mockCheckAgentBillingGate.mockReset();
  mockCheckAgentBillingGate.mockResolvedValue({ allowed: true });
  mockResolveMetricRun.mockReset();
  mockResolveMetricRun.mockResolvedValue({
    kind: "ok",
    metric: {
      id: "total_gmv",
      label: "Total GMV",
      description: "Gross merchandise value",
      sql: "SELECT 42 AS total_gmv",
      type: null,
      aggregation: null,
      unit: null,
      source: "default",
      binding: null,
    },
    targetConnectionId: undefined,
  });
  mockRunUserQueryPipeline.mockReset();
  // Default impl captures the bound request context (origin/actor) + the
  // forwarded opts, then returns a single-cell ok outcome. Tests needing a
  // different outcome use mockResolvedValueOnce so this capturing default stays
  // in place.
  mockRunUserQueryPipeline.mockImplementation(async (opts: PipelineOpts) => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    const ctx = getRequestContext();
    capturedContext = { agentOrigin: ctx?.agentOrigin, actorKind: ctx?.actor?.kind };
    capturedOpts = opts;
    return {
      kind: "ok" as const,
      columns: ["total_gmv"],
      rows: [{ total_gmv: 42 }],
      rowCount: 1,
      executionMs: 3,
      truncated: false,
      maskingApplied: false,
    };
  });
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: true as const,
    mode: "managed" as const,
    user: {
      id: "user-1",
      mode: "managed",
      label: "Alice",
      role: "member",
      activeOrganizationId: "org-1",
      claims: { sub: "user-1", org_id: "org-1", origin: "cli" },
    },
  } as unknown as AuthResult);
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  capturedContext = {};
  capturedOpts = undefined;
});

describe("POST /api/v1/metrics/{id}/run", () => {
  it("runs a metric and returns the scalar value for a single-cell result", async () => {
    const res = await app.fetch(runMetricRequest("total_gmv"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("total_gmv");
    expect(body.label).toBe("Total GMV");
    expect(body.value).toBe(42);
    expect(body.columns).toEqual(["total_gmv"]);
    expect(body.sql).toBe("SELECT 42 AS total_gmv");
  });

  it("returns the full row set as value for a multi-row result", async () => {
    mockRunUserQueryPipeline.mockResolvedValueOnce({
      kind: "ok",
      columns: ["region", "gmv"],
      rows: [
        { region: "us", gmv: 10 },
        { region: "eu", gmv: 20 },
      ],
      rowCount: 2,
      executionMs: 4,
      truncated: false,
      maskingApplied: false,
    });
    const res = await app.fetch(runMetricRequest("gmv_by_region"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.value)).toBe(true);
    expect((body.value as unknown[]).length).toBe(2);
  });

  it("requires authentication (401 when the bearer is rejected)", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false as const,
      mode: "managed" as const,
      status: 401,
      error: "Invalid token",
    } as unknown as AuthResult);
    const res = await app.fetch(runMetricRequest("total_gmv"));
    expect(res.status).toBe(401);
  });

  it("blocks with the billing status when gate-0 denies (solvency)", async () => {
    mockCheckAgentBillingGate.mockResolvedValue({
      allowed: false,
      errorCode: "trial_expired",
      errorMessage: "Your trial has expired.",
      httpStatus: 403,
      retryable: false,
    });
    const res = await app.fetch(runMetricRequest("total_gmv"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("trial_expired");
    // The pipeline must NOT run once billing blocks.
    expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown metric", async () => {
    mockResolveMetricRun.mockResolvedValue({ kind: "unknown_metric", id: "nope" });
    const res = await app.fetch(runMetricRequest("nope"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unknown_metric");
  });

  it("rejects a non-empty filters set with 400", async () => {
    mockResolveMetricRun.mockResolvedValue({ kind: "filters_unsupported" });
    const res = await app.fetch(runMetricRequest("total_gmv", { filters: { region: "us" } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
  });

  it("rejects a connection outside the metric's group with 400", async () => {
    mockResolveMetricRun.mockResolvedValue({
      kind: "wrong_connection",
      metricId: "prod_signups",
      group: "prod",
      metricConnectionId: "prod",
      connectionId: "eu-staging",
    });
    const res = await app.fetch(runMetricRequest("prod_signups", { connectionId: "eu-staging" }));
    expect(res.status).toBe(400);
  });

  it("maps an RLS failure to 403", async () => {
    mockRunUserQueryPipeline.mockResolvedValueOnce({
      kind: "rls_failed",
      message: "RLS claim missing.",
    });
    const res = await app.fetch(runMetricRequest("total_gmv"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("rls_blocked");
  });

  it("maps an approval requirement to 409", async () => {
    mockRunUserQueryPipeline.mockResolvedValueOnce({
      kind: "approval_required",
      approvalRequestId: "appr-1",
      matchedRules: ["rule-1"],
      message: "Approval needed.",
    });
    const res = await app.fetch(runMetricRequest("total_gmv"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("approval_required");
    expect(body.approvalRequestId).toBe("appr-1");
  });

  it("binds origin=cli + actor.kind=human into the pipeline context", async () => {
    await app.fetch(runMetricRequest("total_gmv"));
    expect(capturedContext.agentOrigin).toBe("cli");
    expect(capturedContext.actorKind).toBe("human");
  });

  it("passes the resolved org through to the billing gate (credential-derived isolation)", async () => {
    await app.fetch(runMetricRequest("total_gmv"));
    expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org-1");
  });

  it("runs the metric's authoritative SQL exactly as defined (AC #2)", async () => {
    await app.fetch(runMetricRequest("total_gmv"));
    // The route must forward the metric's verbatim SQL to the pipeline, not a
    // re-derived or rewritten query.
    expect(capturedOpts?.sql).toBe("SELECT 42 AS total_gmv");
  });

  it("forwards the resolver's targetConnectionId to the pipeline (group routing, AC #2)", async () => {
    mockResolveMetricRun.mockResolvedValueOnce({
      kind: "ok",
      metric: {
        id: "prod_signups",
        label: "Prod Signups",
        description: null,
        sql: "SELECT COUNT(*) AS signups FROM users",
        type: null,
        aggregation: null,
        unit: null,
        source: "prod",
        binding: null,
      },
      targetConnectionId: "prod",
    });
    await app.fetch(runMetricRequest("prod_signups"));
    expect(capturedOpts?.connectionId).toBe("prod");
  });

  it("rejects a credential with no bound workspace with a 400 bad_request", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: "user-1",
        mode: "managed",
        label: "Alice",
        role: "member",
        // No activeOrganizationId — a multi-workspace login pending the picker.
        claims: { sub: "user-1", origin: "cli" },
      },
    } as unknown as AuthResult);
    const res = await app.fetch(runMetricRequest("total_gmv"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("bad_request");
    // Must NOT reach the billing gate or the pipeline with an undefined org.
    expect(mockCheckAgentBillingGate).not.toHaveBeenCalled();
    expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
  });

  it("fails closed to 503 when the billing gate throws (never an opaque 500 / allow)", async () => {
    mockCheckAgentBillingGate.mockRejectedValueOnce(new Error("DB down"));
    const res = await app.fetch(runMetricRequest("total_gmv"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("billing_check_failed");
    // The pipeline must NOT run when billing can't be verified.
    expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
  });

  it("maps a connection_unavailable outcome to 503 with the connection id", async () => {
    mockRunUserQueryPipeline.mockResolvedValueOnce({
      kind: "connection_unavailable",
      message: "Datasource unreachable.",
      connectionId: "prod",
    });
    const res = await app.fetch(runMetricRequest("total_gmv"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("connection_unavailable");
    expect(body.connectionId).toBe("prod");
  });
});
