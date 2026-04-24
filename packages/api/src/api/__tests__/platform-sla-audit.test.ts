/**
 * Audit regression suite for `platform-sla.ts` — F-29 residuals (#1828).
 *
 * Pins the gap closed by this PR:
 *   - `POST /evaluate` → `sla.evaluate` (platform scope)
 *
 * The evaluate route runs the alert-evaluation pipeline on demand. Without
 * the audit row a compromised platform admin can burn SLA worker budget on
 * repeated evaluations (oracle for downstream notifier / webhook side
 * effects) with zero forensic trace. Metadata pins the new-alert count as
 * the shape — NOT the alert payload, which may carry workspace names that
 * are PII-adjacent at the platform scope.
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

// Mock the EE SLA module. `evaluateAlerts` is the only path this audit
// suite exercises; the other platformSLA handlers (thresholds, acknowledge)
// stay at their default no-ops since admin-connections-audit-style
// exclusion is covered by the `not.toHaveBeenCalled` assertions.
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
    // Pinned: audit MUST NOT include the alert payload — the workspace
    // name / id per alert is platform-scope PII-adjacent. Compliance
    // queries only need the count.
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

  it("does not emit when evaluateAlerts rejects with a domain error", async () => {
    // Short-circuit before the audit: consistent with the "don't log
    // actions that didn't happen" policy. Forensic queries see the
    // absence of a row — which IS the signal that the pipeline choked.
    mockEvaluateAlerts.mockImplementation(() =>
      Effect.die(new Error("SLA engine offline")),
    );

    const res = await app.fetch(
      platformRequest("POST", "/api/v1/platform/sla/evaluate"),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
