/**
 * Audit regression suite for `admin-semantic-improve.ts` — F-35 (#1790).
 *
 * Pins the four write surfaces to the canonical
 * `ADMIN_ACTIONS.semantic.improve*` action types:
 *
 *   - POST /chat                     → `semantic.improve_draft`
 *   - POST /proposals/{id}/approve   → `semantic.improve_accept`
 *   - POST /proposals/{id}/reject    → `semantic.improve_reject`
 *   - POST /amendments/{id}/review   → `semantic.improve_apply` (approved)
 *                                      / `semantic.improve_reject` (rejected)
 *
 * The DB-backed `/amendments/{id}/review` route is exercised end-to-end
 * through the Hono app. The in-memory proposal surface (`/chat` +
 * `/proposals/{id}/(approve|reject)`) is driven by mounting the router
 * into a minimal Hono host so the streaming SSE round-trip in `/chat`
 * does not block the test runner — the audit wire-up is identical.
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

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// Stub YAML apply so the approved branch does not touch the filesystem.
mock.module("@atlas/api/lib/semantic/expert/apply", () => ({
  applyAmendmentToEntity: mock(async () => undefined),
}));

// Seed `createSession` to return one proposal so /proposals/0/(approve|reject)
// resolve. `recordDecision` / `getSessionSummary` / `buildSessionContext`
// match the real shape enough for the routes under test.
interface MinimalProposal {
  readonly entityName: string;
  readonly category: string;
  readonly amendmentType: string;
  readonly amendment: Record<string, unknown>;
  readonly rationale: string;
  readonly confidence: number;
  readonly impact: number;
  readonly score: number;
  readonly testQuery?: string;
}

const SEEDED_PROPOSAL: MinimalProposal = {
  entityName: "events",
  category: "coverage_gaps",
  amendmentType: "update_description",
  amendment: { description: "Updated" },
  rationale: "Sample proposal",
  confidence: 0.9,
  impact: 0.5,
  score: 0.7,
};

mock.module("@atlas/api/lib/semantic/expert", () => ({
  createSession: () => ({
    proposals: [SEEDED_PROPOSAL],
    currentIndex: 0,
    reviewed: [] as { result: MinimalProposal; decision: string; decidedAt: Date }[],
    messages: [],
    rejectedKeys: new Set<string>(),
    startedAt: new Date(),
  }),
  recordDecision: (
    session: {
      currentIndex: number;
      proposals: readonly MinimalProposal[];
      reviewed: { result: MinimalProposal; decision: string; decidedAt: Date }[];
    },
    decision: "accepted" | "rejected" | "skipped",
  ) => {
    const current = session.proposals[session.currentIndex];
    if (current) session.reviewed.push({ result: current, decision, decidedAt: new Date() });
    session.currentIndex += 1;
  },
  getSessionSummary: () => ({ total: 1, accepted: 0, rejected: 0, skipped: 0, remaining: 1 }),
  buildSessionContext: () => "",
}));

// Stub the agent runner — /chat awaits runAgent and then emits the audit row.
mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(async () => ({
    toUIMessageStream: () =>
      new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() }),
    text: Promise.resolve("ok"),
  })),
}));

mock.module("@atlas/api/lib/tools/expert-registry", () => ({
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
 * `/chat` and `/proposals/{id}/*` routes while still exercising the
 * router's real audit emissions.
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
  it("emits semantic.improve_draft on new chat session", async () => {
    const host = makeRouterHost();
    const res = await hostRequest(host, "POST", "/chat", {
      messages: [
        { role: "user", parts: [{ type: "text", text: "analyze" }], id: "m1" },
      ],
    });
    expect(res.status).toBe(200);

    const entry = findAuditCall("semantic.improve_draft");
    expect(entry).toBeDefined();
    expect(entry!.targetType).toBe("semantic");
    expect(entry!.metadata).toMatchObject({ resumed: false });
    expect(typeof entry!.metadata?.sessionId).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// POST /proposals/{id}/approve — improve_accept
// POST /proposals/{id}/reject  — improve_reject
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/semantic-improve/proposals/{id}/approve — audit", () => {
  it("emits semantic.improve_accept with proposalIndex + entityName + amendmentType", async () => {
    const host = makeRouterHost();
    // First create a session via /chat
    const chatRes = await hostRequest(host, "POST", "/chat", {
      messages: [
        { role: "user", parts: [{ type: "text", text: "seed" }], id: "m1" },
      ],
    });
    expect(chatRes.status).toBe(200);
    mockLogAdminAction.mockClear();

    const res = await hostRequest(host, "POST", "/proposals/0/approve");
    expect(res.status).toBe(200);

    const entry = findAuditCall("semantic.improve_accept");
    expect(entry).toBeDefined();
    expect(entry!.targetType).toBe("semantic");
    expect(entry!.metadata).toMatchObject({
      proposalIndex: 0,
      entityName: "events",
      amendmentType: "update_description",
    });
  });
});

describe("POST /api/v1/admin/semantic-improve/proposals/{id}/reject — audit", () => {
  it("emits semantic.improve_reject with proposalIndex + entityName", async () => {
    const host = makeRouterHost();
    const chatRes = await hostRequest(host, "POST", "/chat", {
      messages: [
        { role: "user", parts: [{ type: "text", text: "seed" }], id: "m1" },
      ],
    });
    expect(chatRes.status).toBe(200);
    mockLogAdminAction.mockClear();

    const res = await hostRequest(host, "POST", "/proposals/0/reject");
    expect(res.status).toBe(200);

    const entry = findAuditCall("semantic.improve_reject");
    expect(entry).toBeDefined();
    expect(entry!.targetType).toBe("semantic");
    expect(entry!.metadata).toMatchObject({
      proposalIndex: 0,
      entityName: "events",
    });
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
