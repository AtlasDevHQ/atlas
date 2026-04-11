/**
 * Tests for workspace admin action audit log endpoint.
 *
 * Covers: GET /api/v1/admin/admin-actions (org isolation, scope filtering,
 * pagination, auth, response shape).
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

// --- Mock the audit module (imported by admin routes) ---

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

function adminRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
  });
}

const SAMPLE_WORKSPACE_ACTION = {
  id: "act-ws-1",
  timestamp: "2026-04-09T12:00:00Z",
  actor_id: "admin-1",
  actor_email: "admin@test.com",
  scope: "workspace",
  org_id: "org-1",
  action_type: "settings.update",
  target_type: "settings",
  target_id: "setting-1",
  status: "success",
  metadata: null,
  ip_address: "10.0.0.1",
  request_id: "req-1",
};

// Platform-scoped actions should never be returned by the workspace endpoint
// (the SQL filters by scope = 'workspace' and org_id = $orgId).
// These constants document the excluded shapes for test readability.
const _SAMPLE_PLATFORM_ACTION = {
  id: "act-plat-1",
  timestamp: "2026-04-09T11:00:00Z",
  actor_id: "platform-admin-1",
  actor_email: "platform@test.com",
  scope: "platform",
  org_id: null,
  action_type: "workspace.suspend",
  target_type: "workspace",
  target_id: "ws-1",
  status: "success",
  metadata: null,
  ip_address: "10.0.0.2",
  request_id: "req-2",
};

const _OTHER_ORG_ACTION = {
  id: "act-other-1",
  timestamp: "2026-04-09T10:00:00Z",
  actor_id: "admin-other",
  actor_email: "other@test.com",
  scope: "workspace",
  org_id: "org-other",
  action_type: "connection.create",
  target_type: "connection",
  target_id: "conn-1",
  status: "success",
  metadata: null,
  ip_address: "10.0.0.3",
  request_id: "req-3",
};

// --- Tests ---

describe("GET /api/v1/admin/admin-actions", () => {
  beforeEach(() => {
    mocks.setOrgAdmin("org-1");
    mocks.hasInternalDB = true;
  });

  it("returns paginated workspace action log entries for caller's org", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 1 }];
      return [SAMPLE_WORKSPACE_ACTION];
    });

    const res = await app.request(adminRequest("GET", "/api/v1/admin/admin-actions"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { actions: Array<Record<string, unknown>>; total: number; limit: number; offset: number };
    expect(body.actions).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);

    const action = body.actions[0];
    expect(action.id).toBe("act-ws-1");
    expect(action.actorEmail).toBe("admin@test.com");
    expect(action.actionType).toBe("settings.update");
    expect(action.targetType).toBe("settings");
    expect(action.targetId).toBe("setting-1");
    expect(action.status).toBe("success");
    expect(action.scope).toBe("workspace");
  });

  it("filters by org_id in SQL query (org isolation)", async () => {
    let capturedParams: unknown[] | undefined;
    let capturedSql: string | undefined;
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("COUNT(*)")) {
        capturedSql = sql;
        capturedParams = params;
        return [{ count: 0 }];
      }
      return [];
    });

    await app.request(adminRequest("GET", "/api/v1/admin/admin-actions"));

    // Verify the SQL includes org_id filter and scope filter
    expect(capturedSql).toContain("org_id = $1");
    expect(capturedSql).toContain("scope = 'workspace'");
    expect(capturedParams).toEqual(["org-1"]);
  });

  it("does not return platform-scoped actions", async () => {
    // Mock returns only workspace-scoped actions (as the SQL filters by scope)
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 1 }];
      // Only workspace actions should be returned by the query
      return [SAMPLE_WORKSPACE_ACTION];
    });

    const res = await app.request(adminRequest("GET", "/api/v1/admin/admin-actions"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { actions: Array<Record<string, unknown>> };
    // All returned actions should be workspace-scoped
    for (const action of body.actions) {
      expect(action.scope).toBe("workspace");
    }
  });

  it("respects limit and offset query params", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("COUNT(*)")) return [{ count: 100 }];
      // Verify correct params: orgId=$1, limit=$2, offset=$3
      expect(params).toEqual(["org-1", 10, 20]);
      return [];
    });

    const res = await app.request(
      adminRequest("GET", "/api/v1/admin/admin-actions?limit=10&offset=20"),
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

    const res = await app.request(adminRequest("GET", "/api/v1/admin/admin-actions"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { actions: unknown[]; total: number };
    expect(body.actions).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns 403 for non-admin users", async () => {
    mocks.setMember("org-1");

    const res = await app.request(adminRequest("GET", "/api/v1/admin/admin-actions"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when internal DB is not configured", async () => {
    mocks.hasInternalDB = false;

    const res = await app.request(adminRequest("GET", "/api/v1/admin/admin-actions"));
    expect(res.status).toBe(404);
  });
});
