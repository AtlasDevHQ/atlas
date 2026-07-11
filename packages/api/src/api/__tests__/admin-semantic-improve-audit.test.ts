/**
 * Audit regression suite for `admin-semantic-improve.ts` — F-35 (#1790).
 *
 * Pins the write surfaces to the canonical
 * `ADMIN_ACTIONS.semantic.improve*` action types:
 *
 *   - POST /chat                     → `semantic.improve_draft`
 *   - POST /amendments/{id}/review   → `semantic.improve_apply` (approved)
 *                                      / `semantic.improve_reject` (rejected)
 *
 * (The in-memory `/proposals/{id}/(approve|reject)` routes and their
 * `semantic.improve_accept` action were deleted in #4503.)
 *
 * The DB-backed `/amendments/{id}/review` route is exercised end-to-end
 * through the Hono app. `/chat` is driven by mounting the router into a
 * minimal Hono host so the streaming SSE round-trip does not block the
 * test runner — the audit wire-up is identical.
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

const mockGetPendingAmendments: Mock<(orgId: string) => Promise<unknown[]>> =
  mock(async () => []);
const mockReviewSemanticAmendment: Mock<
  (id: string, orgId: string, decision: string, reviewer: string) => Promise<boolean>
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
    getPendingAmendments: mockGetPendingAmendments,
    reviewSemanticAmendment: mockReviewSemanticAmendment,
  },
});

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
void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(async () => ({
    toUIMessageStream: () =>
      new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() }),
    text: Promise.resolve("ok"),
  })),
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
 * `/chat` route while still exercising the router's real audit emissions.
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

beforeEach(() => {
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
  mockGetPendingAmendments.mockReset();
  mockGetPendingAmendments.mockImplementation(async () => []);
  mockReviewSemanticAmendment.mockReset();
  mockReviewSemanticAmendment.mockImplementation(async () => true);
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
});

// ---------------------------------------------------------------------------
// POST /amendments/{id}/review — improve_apply (approved) / improve_reject (rejected)
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/semantic-improve/amendments/:id/review — audit emission", () => {
  it("approved decision emits semantic.improve_apply with id + decision", async () => {
    mockGetPendingAmendments.mockImplementation(async () => [
      {
        id: "amd-1",
        source_entity: "events",
        description: "Update",
        confidence: 0.8,
        amendment_payload: {
          category: "coverage_gaps",
          amendmentType: "update_description",
          rationale: "text",
        },
        created_at: "2026-04-24T00:00:00Z",
      },
    ]);

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
    mockReviewSemanticAmendment.mockImplementation(async () => false);

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
