/**
 * Tests for platform admin action log endpoint.
 *
 * Covers: GET /api/v1/platform/actions (pagination, auth, response shape).
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
      // Verify correct params are passed
      expect(params).toEqual([10, 20]);
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
});
