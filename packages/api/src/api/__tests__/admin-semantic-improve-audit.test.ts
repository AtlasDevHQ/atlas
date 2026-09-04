/**
 * Audit + billing-gate regression suite for `admin-semantic-improve.ts`.
 *
 * Audit — F-35 (#1790). Pins the write surfaces to the canonical
 * `ADMIN_ACTIONS.semantic.improve*` action types:
 *
 *   - POST /chat                        → `semantic.improve_draft`
 *   - POST /amendments/{id}/review      → `semantic.improve_apply` (approved)
 *                                         / `semantic.improve_reject` (rejected)
 *   - POST /amendments/{id}/reconsider  → `semantic.improve_reconsider` (#4512)
 *
 * (The in-memory `/proposals/{id}/(approve|reject)` routes and their
 * `semantic.improve_accept` action were deleted in #4503.)
 *
 * Billing — #3437. POST /chat runs `runAgent` (real LLM spend, metered
 * against the workspace budget via `recordUsage`), so it must consult the
 * shared billing gate (`checkAgentBillingGate`, #3419/#3420) BEFORE the
 * agent starts. Pre-fix, the route ran with no `checkPlanLimits` /
 * `checkWorkspaceStatus` at all — admin maintenance consumed platform
 * tokens against a budget it never checked. The gate is mocked here with
 * a mutable verdict; the audit tests run under the default `allowed` arm.
 *
 * The DB-backed `/amendments/{id}/review` route is exercised end-to-end
 * through the Hono app. `/chat` is driven by mounting the router into a
 * minimal Hono host so the streaming SSE round-trip does not block the
 * test runner — the audit + gate wire-up is identical.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { Hono } from "hono";
import type { OrgContextEnv } from "../routes/admin-router";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// The review route delegates to the decide seam (#4506); the seam's DB
// surface is the claim helpers, so the audit tests drive those. Defaults
// model a decidable pending row (claim wins / reject wins).
const mockClaimPendingAmendment: Mock<
  (id: string, orgId: string | null, claimedBy: string) => Promise<Record<string, unknown> | null>
> = mock(async (id: string) => ({
  id,
  source_entity: "events",
  connection_group_id: null,
  amendment_payload: {
    category: "coverage_gaps",
    amendmentType: "update_description",
    amendment: { field: "table", description: "Updated" },
    rationale: "text",
  },
  claimed_at: "2026-07-10T00:00:00+00",
}));
const mockStampClaimedAmendmentApproved: Mock<(id: string) => Promise<boolean>> =
  mock(async () => true);
const mockReleaseClaimedAmendment: Mock<(id: string, reason: string) => Promise<boolean>> =
  mock(async () => true);
const mockRejectPendingAmendment: Mock<
  (id: string, orgId: string | null, rejectedBy: string) => Promise<boolean>
> = mock(async () => true);
const mockReconsiderRejectedAmendment: Mock<
  (id: string, orgId: string | null) => Promise<boolean>
> = mock(async () => true);

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
  internal: {
    claimPendingAmendment: mockClaimPendingAmendment,
    stampClaimedAmendmentApproved: mockStampClaimedAmendmentApproved,
    releaseClaimedAmendment: mockReleaseClaimedAmendment,
    rejectPendingAmendment: mockRejectPendingAmendment,
    reconsiderRejectedAmendment: mockReconsiderRejectedAmendment,
  },
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

interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});

void mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// Stub YAML apply so the approved branch does not touch the filesystem.
void mock.module("@atlas/api/lib/semantic/expert/apply", () => ({
  applyAmendmentToEntity: mock(async () => undefined),
  applyAmendmentFromPayload: mock(async () => undefined),
}));

// Stub the agent runner — /chat awaits runAgent and then emits the audit row.
// Named so the billing-gate tests can assert it never ran on a blocked arm.
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

const { app } = await import("../index");
const { adminSemanticImprove } = await import(
  "../routes/admin-semantic-improve"
);

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function findAuditCall(actionType: string): AuditEntry | undefined {
  return mockLogAdminAction.mock.calls
    .map(([entry]) => entry)
    .find((entry) => entry.actionType === actionType);
}

/**
 * Mount the router into a minimal Hono host that pre-populates the
 * request context (requestId + atlasMode + authResult + orgContext). This
 * avoids bringing the full app's streaming pipeline online for the
 * `/chat` route while still exercising the router's real audit emissions
 * and gate wiring.
 */
function makeRouterHost() {
  const host = new Hono<OrgContextEnv>();
  host.use("*", async (c, next) => {
    c.set("requestId", "req-test-1");
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
    c.set("orgContext", {
      requestId: "req-test-1",
      orgId: "org-alpha",
    });
    await next();
  });
  host.route("/", adminSemanticImprove);
  return host;
}

function hostRequest(
  host: ReturnType<typeof makeRouterHost>,
  method: string,
  path: string,
  body?: unknown,
) {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return host.request(path, init);
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
  mockClaimPendingAmendment.mockClear();
  mockStampClaimedAmendmentApproved.mockClear();
  mockStampClaimedAmendmentApproved.mockImplementation(async () => true);
  mockReleaseClaimedAmendment.mockClear();
  mockRejectPendingAmendment.mockClear();
  mockRejectPendingAmendment.mockImplementation(async () => true);
  mockReconsiderRejectedAmendment.mockClear();
  mockReconsiderRejectedAmendment.mockImplementation(async () => true);
});

// ---------------------------------------------------------------------------
// POST /chat — improve_draft
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/semantic-improve/chat — audit emission", () => {
  it("emits semantic.improve_draft anchored on the requestId (no session ids, #4503)", async () => {
    const host = makeRouterHost();
    const res = await hostRequest(host, "POST", "/chat", {
      messages: [
        { role: "user", parts: [{ type: "text", text: "analyze" }], id: "m1" },
      ],
    });
    expect(res.status).toBe(200);
    // The deleted session subsystem's wire field must not resurface.
    expect(res.headers.get("x-session-id")).toBeNull();

    const entry = findAuditCall("semantic.improve_draft");
    expect(entry).toBeDefined();
    expect(entry!.targetType).toBe("semantic");
    // requireOrgContext mints a fresh requestId per request (the host-set
    // one is overwritten), so assert shape + consistency rather than value:
    // the row's target IS the request correlation handle.
    expect(typeof entry!.targetId).toBe("string");
    expect(entry!.targetId.length).toBeGreaterThan(0);
    expect(entry!.metadata).toMatchObject({ requestId: entry!.targetId, messageCount: 1 });
    expect(entry!.metadata).not.toHaveProperty("sessionId");
  });

  it("ignores the legacy sessionId body field from stale clients (deploy-overlap window)", async () => {
    // ChatRequestSchema is non-strict, so a cached web bundle still sending
    // the deleted `sessionId` field degrades gracefully (stripped) instead
    // of 400ing mid-deploy. A future `.strict()` change would break stale
    // clients — this pin makes that a conscious decision.
    const host = makeRouterHost();
    const res = await hostRequest(host, "POST", "/chat", {
      messages: [
        { role: "user", parts: [{ type: "text", text: "analyze" }], id: "m1" },
      ],
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-session-id")).toBeNull();
  });
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

// ---------------------------------------------------------------------------
// POST /amendments/{id}/review — improve_apply (approved) / improve_reject (rejected)
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/semantic-improve/amendments/:id/review — audit emission", () => {
  it("approved decision emits semantic.improve_apply with id + decision", async () => {
    const res = await app.fetch(
      adminRequest(
        "POST",
        "/api/v1/admin/semantic-improve/amendments/amd-1/review",
        { decision: "approved" },
      ),
    );
    expect(res.status).toBe(200);

    const entry = findAuditCall("semantic.improve_apply");
    expect(entry).toBeDefined();
    expect(entry!.targetType).toBe("semantic");
    expect(entry!.targetId).toBe("amd-1");
    expect(entry!.metadata).toMatchObject({ id: "amd-1", decision: "approved" });
    expect(findAuditCall("semantic.improve_reject")).toBeUndefined();
  });

  it("rejected decision emits semantic.improve_reject with id + decision", async () => {
    const res = await app.fetch(
      adminRequest(
        "POST",
        "/api/v1/admin/semantic-improve/amendments/amd-2/review",
        { decision: "rejected" },
      ),
    );
    expect(res.status).toBe(200);

    const entry = findAuditCall("semantic.improve_reject");
    expect(entry).toBeDefined();
    expect(entry!.targetType).toBe("semantic");
    expect(entry!.targetId).toBe("amd-2");
    expect(entry!.metadata).toMatchObject({ id: "amd-2", decision: "rejected" });
    expect(findAuditCall("semantic.improve_apply")).toBeUndefined();
  });

  it("does not emit when the amendment is missing (404)", async () => {
    mockRejectPendingAmendment.mockImplementation(async () => false);

    const res = await app.fetch(
      adminRequest(
        "POST",
        "/api/v1/admin/semantic-improve/amendments/amd-missing/review",
        { decision: "rejected" },
      ),
    );
    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /amendments/{id}/reconsider — improve_reconsider (#4512)
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/semantic-improve/amendments/:id/reconsider — audit emission", () => {
  it("emits semantic.improve_reconsider with the amendment id when a rejection is lifted", async () => {
    const res = await app.fetch(
      adminRequest(
        "POST",
        "/api/v1/admin/semantic-improve/amendments/amd-9/reconsider",
      ),
    );
    expect(res.status).toBe(200);

    const entry = findAuditCall("semantic.improve_reconsider");
    expect(entry).toBeDefined();
    expect(entry!.targetType).toBe("semantic");
    expect(entry!.targetId).toBe("amd-9");
    expect(entry!.metadata).toMatchObject({ id: "amd-9" });
    // Reconsider is its own intent — never conflated with a reject/apply review.
    expect(findAuditCall("semantic.improve_reject")).toBeUndefined();
    expect(findAuditCall("semantic.improve_apply")).toBeUndefined();
  });

  it("does not emit when the row is not currently rejected (404)", async () => {
    mockReconsiderRejectedAmendment.mockImplementation(async () => false);

    const res = await app.fetch(
      adminRequest(
        "POST",
        "/api/v1/admin/semantic-improve/amendments/amd-missing/reconsider",
      ),
    );
    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
