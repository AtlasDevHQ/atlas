/**
 * Tests for platform admin action log endpoints.
 *
 * Covers: GET /api/v1/platform/actions (pagination, auth, response shape, filters)
 *         GET /api/v1/platform/actions/export (CSV export, headers, truncation)
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// --- Unified mocks ---

const mocks = createApiTestMocks();

// --- Mock the audit module (imported by platform-admin) ---

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mock(() => {}),
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: {
    workspace: { suspend: "workspace.suspend", unsuspend: "workspace.unsuspend", delete: "workspace.delete", purge: "workspace.purge", changePlan: "workspace.change_plan" },
    domain: { register: "domain.register", verify: "domain.verify", delete: "domain.delete" },
    residency: { assign: "residency.assign" },
    sla: { updateThresholds: "sla.update_thresholds", acknowledgeAlert: "sla.acknowledge_alert" },
    backup: { create: "backup.create", verify: "backup.verify", requestRestore: "backup.request_restore", confirmRestore: "backup.confirm_restore", updateConfig: "backup.update_config" },
    settings: { update: "settings.update" },
    connection: { create: "connection.create", update: "connection.update", delete: "connection.delete" },
    user: { invite: "user.invite", remove: "user.remove", changeRole: "user.change_role" },
    sso: { configure: "sso.configure", update: "sso.update", delete: "sso.delete", test: "sso.test" },
    semantic: { createEntity: "semantic.create_entity", updateEntity: "semantic.update_entity", deleteEntity: "semantic.delete_entity", updateMetric: "semantic.update_metric", updateGlossary: "semantic.update_glossary" },
    pattern: { approve: "pattern.approve", reject: "pattern.reject", delete: "pattern.delete" },
    integration: { enable: "integration.enable", disable: "integration.disable", configure: "integration.configure" },
    schedule: { create: "schedule.create", update: "schedule.update", delete: "schedule.delete", toggle: "schedule.toggle" },
    apikey: { create: "apikey.create", revoke: "apikey.revoke" },
    approval: { approve: "approval.approve", deny: "approval.deny" },
  },
}));

mock.module("@atlas/api/lib/audit/admin", () => ({
  logAdminAction: mock(() => {}),
  logAdminActionAwait: mock(async () => {}),
}));

mock.module("@atlas/api/lib/audit/actions", () => ({
  ADMIN_ACTIONS: {
    workspace: { suspend: "workspace.suspend" },
  },
}));

// --- Import app after mocks ---

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// --- Helpers ---

function platformRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
  });
}

const SAMPLE_ACTION = {
  id: "act-1",
  timestamp: "2026-04-07T12:00:00Z",
  actor_id: "admin-1",
  actor_email: "admin@test.com",
  scope: "platform",
  org_id: null,
  action_type: "workspace.suspend",
  target_type: "workspace",
  target_id: "ws-1",
  status: "success",
  metadata: null,
  ip_address: "10.0.0.1",
  request_id: "req-1",
};

// --- Tests ---

describe("GET /api/v1/platform/actions", () => {
  beforeEach(() => {
    mocks.setPlatformAdmin();
    mocks.hasInternalDB = true;
  });

  it("returns paginated action log entries", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 1 }];
      return [SAMPLE_ACTION];
    });

    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { actions: Array<Record<string, unknown>>; total: number; limit: number; offset: number };
    expect(body.actions).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);

    const action = body.actions[0];
    expect(action.id).toBe("act-1");
    expect(action.actorEmail).toBe("admin@test.com");
    expect(action.actionType).toBe("workspace.suspend");
    expect(action.targetType).toBe("workspace");
    expect(action.targetId).toBe("ws-1");
    expect(action.status).toBe("success");
    expect(action.scope).toBe("platform");
  });

  it("respects limit and offset query params", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("COUNT(*)")) return [{ count: 100 }];
      // Verify correct params: limit and offset are last
      const pArr = params ?? [];
      expect(pArr[pArr.length - 2]).toBe(10);
      expect(pArr[pArr.length - 1]).toBe(20);
      return [];
    });

    const res = await app.request(
      platformRequest("GET", "/api/v1/platform/actions?limit=10&offset=20"),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { actions: unknown[]; total: number; limit: number; offset: number };
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(20);
    expect(body.total).toBe(100);
  });

  it("returns empty list when no actions exist", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      return [];
    });

    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { actions: unknown[]; total: number };
    expect(body.actions).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns 403 for non-platform-admin users", async () => {
    mocks.setOrgAdmin("org-1");

    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when internal DB is not configured", async () => {
    mocks.hasInternalDB = false;

    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions"));
    expect(res.status).toBe(404);
  });

  it("passes actor filter to SQL query", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      capturedSql = sql;
      capturedParams = params ?? [];
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      return [];
    });

    await app.request(platformRequest("GET", "/api/v1/platform/actions?actor=admin"));
    expect(capturedSql).toContain("actor_email ILIKE");
    expect(capturedParams).toContain("%admin%");
  });

  it("passes actionType filter to SQL query", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      capturedSql = sql;
      capturedParams = params ?? [];
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      return [];
    });

    await app.request(platformRequest("GET", "/api/v1/platform/actions?actionType=settings.update"));
    expect(capturedSql).toContain("action_type =");
    expect(capturedParams).toContain("settings.update");
  });

  it("passes date range filters to SQL query", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      capturedSql = sql;
      capturedParams = params ?? [];
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      return [];
    });

    await app.request(platformRequest("GET", "/api/v1/platform/actions?from=2026-01-01&to=2026-03-01"));
    expect(capturedSql).toContain("timestamp >=");
    expect(capturedSql).toContain("timestamp <=");
    expect(capturedParams).toContain("2026-01-01");
    expect(capturedParams).toContain("2026-03-01");
  });

  it("passes metadata search filter to SQL query", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      capturedSql = sql;
      capturedParams = params ?? [];
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      return [];
    });

    await app.request(platformRequest("GET", "/api/v1/platform/actions?search=test-data"));
    expect(capturedSql).toContain("metadata::text ILIKE");
    expect(capturedParams).toContain("%test-data%");
  });

  it("composes multiple filters together", async () => {
    let capturedSql = "";
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      capturedSql = sql;
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      return [];
    });

    await app.request(platformRequest("GET", "/api/v1/platform/actions?actor=admin&actionType=settings.update&targetType=settings"));
    expect(capturedSql).toContain("actor_email ILIKE");
    expect(capturedSql).toContain("action_type =");
    expect(capturedSql).toContain("target_type =");
  });

  it("returns 400 for invalid date filter", async () => {
    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions?from=not-a-date"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/platform/actions/export", () => {
  beforeEach(() => {
    mocks.setPlatformAdmin();
    mocks.hasInternalDB = true;
  });

  it("returns CSV with correct Content-Type header", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 1 }];
      return [SAMPLE_ACTION];
    });

    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  });

  it("returns CSV with correct Content-Disposition header", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 1 }];
      return [SAMPLE_ACTION];
    });

    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions/export"));
    expect(res.status).toBe(200);
    const disposition = res.headers.get("Content-Disposition");
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("platform-actions-");
    expect(disposition).toContain(".csv");
  });

  it("includes CSV header row and data rows", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 1 }];
      return [SAMPLE_ACTION];
    });

    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions/export"));
    const csv = await res.text();
    const lines = csv.split("\n");
    expect(lines[0]).toBe("timestamp,actor_email,action_type,target_type,target_id,scope,org_id,status,metadata,ip_address,request_id");
    expect(lines[1]).toContain("admin@test.com");
    expect(lines[1]).toContain("workspace.suspend");
  });

  it("sets truncation headers when over 10,000 rows", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 15000 }];
      return [SAMPLE_ACTION];
    });

    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBe("true");
    expect(res.headers.get("X-Total-Count")).toBe("15000");
  });

  it("does not set truncation headers when under limit", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 5 }];
      return [SAMPLE_ACTION];
    });

    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBeNull();
    expect(res.headers.get("X-Total-Count")).toBeNull();
  });

  it("applies filters to CSV export", async () => {
    let capturedSql = "";
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      capturedSql = sql;
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      return [];
    });

    await app.request(platformRequest("GET", "/api/v1/platform/actions/export?actor=admin&actionType=settings.update"));
    expect(capturedSql).toContain("actor_email ILIKE");
    expect(capturedSql).toContain("action_type =");
  });

  it("returns 403 for non-platform-admin", async () => {
    mocks.setOrgAdmin("org-1");
    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions/export"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when internal DB is not configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.request(platformRequest("GET", "/api/v1/platform/actions/export"));
    expect(res.status).toBe(404);
  });
});
