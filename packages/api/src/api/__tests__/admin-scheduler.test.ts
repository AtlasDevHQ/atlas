/**
 * Admin scheduler routes — wire-shape + manual-trigger error-surfacing
 * regression suite (#2284).
 *
 * Locks down:
 *   - `GET /tasks` lists the BYOT catalog refresh job with `running` mirrored
 *     from the in-process scheduler state.
 *   - `POST /tasks/byot-catalog-refresh/run` happy path returns 200 with the
 *     full `ByotRefreshCycleResult` shape.
 *   - `POST /run` when the cycle reports `status: "failure"` returns 500 with
 *     `requestId` — without this, the admin "Run now" button shows green on a
 *     real outage. Caught by silent-failure-hunter on review.
 *   - Permission gate is pinned via `permission-enforcement.test.ts` (see the
 *     `admin:settings` case added in the same PR).
 */

import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import type { ByotRefreshCycleResult } from "@useatlas/types";

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "platform_admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

// ---------------------------------------------------------------------------
// Scheduler module mock — every named export the admin route imports.
// ---------------------------------------------------------------------------

const mockIsRunning: Mock<() => boolean> = mock(() => true);
const mockTrigger: Mock<() => Promise<ByotRefreshCycleResult>> = mock(async () => ({
  status: "success",
  inspected: 0,
  refreshed: 0,
  failed: 0,
  skippedDecryptFailed: 0,
  skippedInBackoff: 0,
  skippedMissingKey: 0,
  skippedEeUnavailable: 0,
  skippedMalformedBundle: 0,
}));

mock.module("@atlas/api/lib/scheduler/byot-catalog-refresh", () => ({
  isByotCatalogRefreshSchedulerRunning: mockIsRunning,
  triggerByotCatalogRefreshCycle: mockTrigger,
  BYOT_CATALOG_REFRESH_ACTOR: "system:byot-catalog-refresh",
  // The route only imports the three above, but the "mock all named exports"
  // rule requires the rest to be stubbed so a partial-mock SyntaxError
  // doesn't leak into sibling tests.
  startByotCatalogRefreshScheduler: () => {},
  stopByotCatalogRefreshScheduler: () => {},
  runByotCatalogRefreshCycle: () => {
    throw new Error("unreachable in admin-scheduler tests");
  },
  _resetByotCatalogRefreshScheduler: () => {},
  _resetBackoffForTests: () => {},
  _resetEeProbeForTests: () => {},
  _computeBackoffMsForTests: () => 0,
}));

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

beforeEach(() => {
  mockIsRunning.mockClear();
  mockTrigger.mockClear();
});

function adminRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  });
}

describe("GET /api/v1/admin/scheduler/tasks", () => {
  it("lists the BYOT catalog refresh task with running mirrored from the in-process state", async () => {
    mockIsRunning.mockReturnValueOnce(true);
    const res = await app.fetch(adminRequest("GET", "/api/v1/admin/scheduler/tasks"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ id: string; running: boolean; systemActor: string }> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe("byot-catalog-refresh");
    expect(body.tasks[0].running).toBe(true);
    expect(body.tasks[0].systemActor).toBe("system:byot-catalog-refresh");
  });

  it("reports running=false when the scheduler is stopped", async () => {
    mockIsRunning.mockReturnValueOnce(false);
    const res = await app.fetch(adminRequest("GET", "/api/v1/admin/scheduler/tasks"));
    const body = (await res.json()) as { tasks: Array<{ running: boolean }> };
    expect(body.tasks[0].running).toBe(false);
  });
});

describe("POST /api/v1/admin/scheduler/tasks/byot-catalog-refresh/run", () => {
  it("returns 200 + the cycle result on a successful run", async () => {
    mockTrigger.mockResolvedValueOnce({
      status: "success",
      inspected: 5,
      refreshed: 3,
      failed: 1,
      skippedDecryptFailed: 1,
      skippedInBackoff: 0,
      skippedMissingKey: 0,
      skippedEeUnavailable: 0,
      skippedMalformedBundle: 0,
    });
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/scheduler/tasks/byot-catalog-refresh/run"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ByotRefreshCycleResult;
    expect(body.status).toBe("success");
    expect(body.inspected).toBe(5);
    expect(body.refreshed).toBe(3);
    expect(body.failed).toBe(1);
    expect(body.skippedDecryptFailed).toBe(1);
  });

  it("returns 500 + requestId when the cycle reports status: failure", async () => {
    // The cycle catches its own errors and returns `status: "failure"` (it
    // never throws); the admin route must translate that into a 500 so the
    // "Run now" button doesn't show green on a real outage.
    mockTrigger.mockResolvedValueOnce({
      status: "failure",
      inspected: 0,
      refreshed: 0,
      failed: 0,
      skippedDecryptFailed: 0,
      skippedInBackoff: 0,
      skippedMissingKey: 0,
      skippedEeUnavailable: 0,
      skippedMalformedBundle: 0,
      error: "connection refused",
    });
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/scheduler/tasks/byot-catalog-refresh/run"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string; requestId?: string };
    expect(body.error).toBe("cycle_failed");
    expect(body.message).toContain("connection refused");
    expect(body.requestId).toBeDefined();
  });

  it("returns 500 + requestId when the trigger wrapper itself rejects (defect path)", async () => {
    mockTrigger.mockRejectedValueOnce(new Error("Effect.runPromise defected"));
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/scheduler/tasks/byot-catalog-refresh/run"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();
  });
});
