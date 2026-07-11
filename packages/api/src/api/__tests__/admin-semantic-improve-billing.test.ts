/**
 * Billing-enforcement suite for `admin-semantic-improve.ts` — #3437.
 *
 * POST /chat runs `runAgent` (real LLM spend, metered against the
 * workspace budget via `recordUsage`), so it must consult the shared
 * billing gate (`checkAgentBillingGate`, #3419/#3420) BEFORE the agent
 * starts. Pre-fix, the route ran with no `checkPlanLimits` /
 * `checkWorkspaceStatus` at all — admin maintenance consumed platform
 * tokens against a budget it never checked.
 *
 * Harness mirrors `admin-semantic-improve-audit.test.ts`: the router is
 * mounted into a minimal Hono host that pre-populates requestId /
 * authResult / orgContext, so the streaming pipeline of the full app
 * stays offline while the route's real gate wiring is exercised.
 */

import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from "bun:test";
import { Hono } from "hono";
import type { OrgContextEnv } from "../routes/admin-router";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

// --- Billing gate mock (#3437) ---

type GateVerdict =
  | { allowed: true; warning?: unknown }
  | {
      allowed: false;
      errorCode: string;
      errorMessage: string;
      httpStatus: 403 | 404 | 429 | 503;
      retryable: boolean;
      retryAfterSeconds?: number;
      usage?: { currentUsage: number; limit: number; metric: string };
    };
let billingGateVerdict: GateVerdict = { allowed: true };
const mockCheckAgentBillingGate = mock(async (_orgId: string | undefined) => billingGateVerdict);

void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mockCheckAgentBillingGate,
  BillingBlockedError: class BillingBlockedError extends Error {
    override readonly name = "BillingBlockedError";
  },
}));

// --- Route collaborators (same stubs as the audit suite) ---

const mockLogAdminAction: Mock<(entry: Record<string, unknown>) => void> = mock(() => {});

void mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

const mockRunAgent = mock(async () => ({
  toUIMessageStream: () =>
    new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() }),
  text: Promise.resolve("ok"),
}));

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mockRunAgent,
}));

void mock.module("@atlas/api/lib/tools/expert-registry", () => ({
  buildExpertRegistry: () => ({ tools: {}, freeze: () => {} }),
}));

const { adminSemanticImprove } = await import("../routes/admin-semantic-improve");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRouterHost() {
  const host = new Hono<OrgContextEnv>();
  host.use("*", async (c, next) => {
    c.set("requestId", "req-billing-1");
    c.set("atlasMode", "published");
    c.set("authResult", {
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        mode: "managed",
        label: "admin@test.com",
        role: "admin",
        activeOrganizationId: "org-alpha",
      },
    });
    c.set("orgContext", { requestId: "req-billing-1", orgId: "org-alpha" });
    await next();
  });
  host.route("/", adminSemanticImprove);
  return host;
}

function chatRequest(host: ReturnType<typeof makeRouterHost>) {
  return host.request("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "user", parts: [{ type: "text", text: "analyze" }], id: "m1" },
      ],
    }),
  });
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  billingGateVerdict = { allowed: true };
  mockCheckAgentBillingGate.mockClear();
  mockRunAgent.mockClear();
  mockLogAdminAction.mockClear();
});

// ---------------------------------------------------------------------------
// POST /chat — billing gate (#3437)
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/semantic-improve/chat — billing gate (#3437)", () => {
  it("blocks a trial-expired workspace with 403 before the agent runs", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "trial_expired",
      errorMessage: "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
      httpStatus: 403,
      retryable: false,
    };

    const host = makeRouterHost();
    const res = await chatRequest(host);

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("trial_expired");
    expect(body.message).toContain("trial has expired");
    expect(body.retryable).toBe(false);
    // requestId comes from the router's own orgContext middleware (a fresh
    // UUID per request) — assert presence for log correlation, not value.
    expect(typeof body.requestId).toBe("string");
    expect((body.requestId as string).length).toBeGreaterThan(0);
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org-alpha");
  });

  it("blocks a token-hard-cap workspace with 429 + usage before the agent runs", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "plan_limit_exceeded",
      errorMessage: "You have used your full included usage credit.",
      httpStatus: 429,
      retryable: false,
      usage: { currentUsage: 23, limit: 20, metric: "usd" },
    };

    const host = makeRouterHost();
    const res = await chatRequest(host);

    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("plan_limit_exceeded");
    expect(body.usage).toEqual({ currentUsage: 23, limit: 20, metric: "usd" });
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("maps an abuse-throttle block to 429 with a Retry-After header", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "workspace_throttled",
      errorMessage: "Workspace is temporarily throttled due to high usage. Please retry shortly.",
      httpStatus: 429,
      retryable: true,
      retryAfterSeconds: 5,
    };

    const host = makeRouterHost();
    const res = await chatRequest(host);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("workspace_throttled");
    expect(body.retryable).toBe(true);
    expect(body.retryAfterSeconds).toBe(5);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the billing check itself fails — try again, not upgrade", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "billing_check_failed",
      errorMessage: "Unable to verify billing status. Please try again.",
      httpStatus: 503,
      retryable: true,
    };

    const host = makeRouterHost();
    const res = await chatRequest(host);

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("billing_check_failed");
    expect(body.retryable).toBe(true);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("runs the agent when the gate allows (allowed arm)", async () => {
    const host = makeRouterHost();
    const res = await chatRequest(host);

    expect(res.status).toBe(200);
    expect(mockCheckAgentBillingGate).toHaveBeenCalledTimes(1);
    expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org-alpha");
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });
});
