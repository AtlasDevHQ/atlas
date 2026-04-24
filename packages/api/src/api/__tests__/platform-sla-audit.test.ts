// Metadata pins `newAlertCount` only — alert payloads carry workspace
// names that are PII-adjacent at the platform scope.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { Effect } from "effect";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Mocks — declared before the app import
// ---------------------------------------------------------------------------

const mocks = createApiTestMocks({
  authUser: {
    id: "platform-admin-1",
    mode: "managed",
    label: "platform@test.com",
    role: "platform_admin",
    activeOrganizationId: "org-platform",
  },
  authMode: "managed",
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

const mockEvaluateAlerts: Mock<() => Effect.Effect<Array<Record<string, unknown>>, unknown, never>> =
  mock(() => Effect.succeed([]));

mock.module("@atlas/ee/sla/index", () => ({
  getAllWorkspaceSLA: () => Effect.succeed([]),
  getWorkspaceSLADetail: () => Effect.succeed({}),
  getAlerts: () => Effect.succeed([]),
  getThresholds: () => Effect.succeed({ latencyP99Ms: 1000, errorRatePct: 0.01 }),
  updateThresholds: () => Effect.succeed(undefined),
  acknowledgeAlert: () => Effect.succeed(true),
  evaluateAlerts: mockEvaluateAlerts,
}));

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function platformRequest(method: string, path: string, body?: unknown): Request {
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

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setPlatformAdmin("org-platform");
  mockLogAdminAction.mockClear();
  mockEvaluateAlerts.mockClear();
  mockEvaluateAlerts.mockImplementation(() => Effect.succeed([]));
});

// ---------------------------------------------------------------------------
// POST /evaluate
// ---------------------------------------------------------------------------

describe("POST /api/v1/platform/sla/evaluate — audit emission (F-29 residuals)", () => {
  it("emits sla.evaluate with platform scope + zero-alert count on empty evaluation", async () => {
    mockEvaluateAlerts.mockImplementation(() => Effect.succeed([]));

    const res = await app.fetch(
      platformRequest("POST", "/api/v1/platform/sla/evaluate"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("sla.evaluate");
    expect(entry.targetType).toBe("sla");
    expect(entry.targetId).toBe("default");
    expect(entry.scope).toBe("platform");
    expect(entry.metadata).toMatchObject({ newAlertCount: 0 });
  });

  it("emits sla.evaluate with newAlertCount matching fired alerts", async () => {
    mockEvaluateAlerts.mockImplementation(() =>
      Effect.succeed([
        { id: "alert-1", workspace: "org-a" },
        { id: "alert-2", workspace: "org-b" },
        { id: "alert-3", workspace: "org-c" },
      ]),
    );

    const res = await app.fetch(
      platformRequest("POST", "/api/v1/platform/sla/evaluate"),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({ newAlertCount: 3 });
    expect(typeof entry.metadata?.newAlertCount).toBe("number");
    // Alert payload MUST stay out of metadata — workspace names are
    // platform-scope PII-adjacent.
    expect(entry.metadata).not.toHaveProperty("newAlerts");
    expect(entry.metadata).not.toHaveProperty("alerts");
  });

  it("threads x-forwarded-for into ipAddress", async () => {
    const req = new Request(
      "http://localhost/api/v1/platform/sla/evaluate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
          "x-forwarded-for": "203.0.113.9",
        },
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(lastAuditCall().ipAddress).toBe("203.0.113.9");
  });

  it("emits failure-status sla.evaluate when evaluateAlerts rejects", async () => {
    mockEvaluateAlerts.mockImplementation(() =>
      Effect.fail(new Error("SLA engine offline")),
    );

    const res = await app.fetch(
      platformRequest("POST", "/api/v1/platform/sla/evaluate"),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("sla.evaluate");
    expect(entry.scope).toBe("platform");
    expect(entry.status).toBe("failure");
    expect(typeof entry.metadata?.error).toBe("string");
  });
});
