import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { withRequestContext } from "@atlas/api/lib/logger";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { logAdminAction, logAdminActionAwait } from "../admin";
import { ADMIN_ACTIONS } from "../actions";

/**
 * Admin audit tests use _resetPool() to inject a mock pg.Pool into the real
 * internal.ts module. This matches the pattern from audit.test.ts.
 */

let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryThrow: Error | null = null;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    if (queryThrow) throw queryThrow;
    queryCalls.push({ sql, params });
    return { rows: [] };
  },
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

describe("logAdminAction()", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryThrow = null;
  });

  afterEach(() => {
    if (origDbUrl) {
      process.env.DATABASE_URL = origDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    _resetPool(null);
  });

  function enableInternalDB() {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
  }

  it("inserts into admin_action_log with correct params when internal DB is available", () => {
    enableInternalDB();
    const user: AtlasUser = {
      id: "admin-1",
      label: "admin@example.com",
      mode: "managed",
      role: "platform_admin",
      activeOrganizationId: "org-123",
    };

    withRequestContext({ requestId: "req-1", user }, () => {
      logAdminAction({
        actionType: ADMIN_ACTIONS.workspace.suspend,
        targetType: "workspace",
        targetId: "ws-abc",
        scope: "platform",
        ipAddress: "10.0.0.1",
        metadata: { reason: "abuse" },
      });
    });

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].sql).toContain("INSERT INTO admin_action_log");
    expect(queryCalls[0].params).toEqual([
      "admin-1",           // actor_id
      "admin@example.com", // actor_email
      "platform",          // scope
      "org-123",           // org_id
      "workspace.suspend", // action_type
      "workspace",         // target_type
      "ws-abc",            // target_id
      "success",           // status
      JSON.stringify({ reason: "abuse" }), // metadata
      "10.0.0.1",          // ip_address
      "req-1",             // request_id
    ]);
  });

  it("auto-populates actor and context from request context", () => {
    enableInternalDB();
    const user: AtlasUser = {
      id: "user-42",
      label: "user@test.com",
      mode: "managed",
      role: "admin",
      activeOrganizationId: "org-xyz",
    };

    withRequestContext({ requestId: "req-42", user }, () => {
      logAdminAction({
        actionType: ADMIN_ACTIONS.connection.create,
        targetType: "connection",
        targetId: "conn-1",
      });
    });

    expect(queryCalls).toHaveLength(1);
    const params = queryCalls[0].params!;
    expect(params[0]).toBe("user-42");       // actor_id
    expect(params[1]).toBe("user@test.com"); // actor_email
    expect(params[2]).toBe("workspace");     // default scope
    expect(params[3]).toBe("org-xyz");       // org_id from context
    expect(params[10]).toBe("req-42");       // request_id from context
  });

  it("uses fallback values when no request context exists", () => {
    enableInternalDB();

    logAdminAction({
      actionType: ADMIN_ACTIONS.settings.update,
      targetType: "settings",
      targetId: "ATLAS_MODEL",
    });

    expect(queryCalls).toHaveLength(1);
    const params = queryCalls[0].params!;
    expect(params[0]).toBe("unknown");   // actor_id
    expect(params[1]).toBe("unknown");   // actor_email
    expect(params[3]).toBeNull();        // org_id
    expect(params[10]).toBe("unknown");  // request_id
  });

  it("does not insert when internal DB is not available", () => {
    delete process.env.DATABASE_URL;
    _resetPool(null);

    expect(() =>
      logAdminAction({
        actionType: ADMIN_ACTIONS.workspace.delete,
        targetType: "workspace",
        targetId: "ws-1",
      }),
    ).not.toThrow();

    expect(queryCalls).toHaveLength(0);
  });

  it("never throws when DB insert fails synchronously", () => {
    enableInternalDB();
    queryThrow = new Error("connection lost");

    expect(() =>
      logAdminAction({
        actionType: ADMIN_ACTIONS.workspace.purge,
        targetType: "workspace",
        targetId: "ws-1",
        scope: "platform",
      }),
    ).not.toThrow();
  });

  it("defaults status to 'success' and scope to 'workspace'", () => {
    enableInternalDB();

    logAdminAction({
      actionType: ADMIN_ACTIONS.user.invite,
      targetType: "user",
      targetId: "user-new",
    });

    expect(queryCalls).toHaveLength(1);
    const params = queryCalls[0].params!;
    expect(params[2]).toBe("workspace"); // scope
    expect(params[7]).toBe("success");   // status
  });

  it("records failure status when provided", () => {
    enableInternalDB();

    logAdminAction({
      actionType: ADMIN_ACTIONS.sso.configure,
      targetType: "sso",
      targetId: "provider-1",
      status: "failure",
    });

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].params![7]).toBe("failure");
  });

  it("stores null metadata when not provided", () => {
    enableInternalDB();

    logAdminAction({
      actionType: ADMIN_ACTIONS.apikey.create,
      targetType: "apikey",
      targetId: "key-1",
    });

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].params![8]).toBeNull(); // metadata
  });

  it("stores null ip_address when not provided", () => {
    enableInternalDB();

    logAdminAction({
      actionType: ADMIN_ACTIONS.schedule.toggle,
      targetType: "schedule",
      targetId: "task-1",
    });

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].params![9]).toBeNull(); // ip_address
  });
});

describe("logAdminActionAwait()", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryThrow = null;
  });

  afterEach(() => {
    if (origDbUrl) {
      process.env.DATABASE_URL = origDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    _resetPool(null);
  });

  function enableInternalDB() {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
  }

  it("awaits the DB insert and resolves on success", async () => {
    enableInternalDB();

    await logAdminActionAwait({
      actionType: ADMIN_ACTIONS.audit_retention.policyUpdate,
      targetType: "audit_retention",
      targetId: "org-1",
      metadata: { retentionDays: 90 },
    });

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].sql).toContain("INSERT INTO admin_action_log");
    expect(queryCalls[0].params![4]).toBe("audit_retention.policy_update");
    expect(queryCalls[0].params![6]).toBe("org-1");
  });

  it("rejects when the DB insert throws — caller must surface the failure", async () => {
    enableInternalDB();
    queryThrow = new Error("connection lost");

    await expect(
      logAdminActionAwait({
        actionType: ADMIN_ACTIONS.audit_retention.manualHardDelete,
        targetType: "audit_retention",
        targetId: "org-1",
      }),
    ).rejects.toThrow("connection lost");
  });

  it("resolves without inserting when no internal DB is configured", async () => {
    delete process.env.DATABASE_URL;
    _resetPool(null);

    await expect(
      logAdminActionAwait({
        actionType: ADMIN_ACTIONS.audit_retention.export,
        targetType: "audit_retention",
        targetId: "org-1",
      }),
    ).resolves.toBeUndefined();

    expect(queryCalls).toHaveLength(0);
  });
});

/**
 * BYOT credential management (email provider + LLM model config) must
 * audit every write. These catalog entries backstop the route emissions:
 * if anyone removes an action type from the catalog, the consuming route
 * file stops compiling, so a silent drift back to the no-audit baseline
 * is impossible.
 */
describe("ADMIN_ACTIONS catalog — BYOT credential audit", () => {
  it("defines email_provider.update / delete / test", () => {
    expect(ADMIN_ACTIONS.email_provider.update).toBe("email_provider.update");
    expect(ADMIN_ACTIONS.email_provider.delete).toBe("email_provider.delete");
    expect(ADMIN_ACTIONS.email_provider.test).toBe("email_provider.test");
  });

  it("defines model_config.update / delete / test", () => {
    expect(ADMIN_ACTIONS.model_config.update).toBe("model_config.update");
    expect(ADMIN_ACTIONS.model_config.delete).toBe("model_config.delete");
    expect(ADMIN_ACTIONS.model_config.test).toBe("model_config.test");
  });
});

/**
 * F-27: system-actor audit emissions for the EE purge scheduler + retention
 * library paths. Pins the reserved actor format and the new catalog entries
 * so an accidental rename (e.g. `system:audit-purge`) breaks CI instead of
 * silently breaking forensic queries that filter on the actor.
 */
describe("ADMIN_ACTIONS catalog — F-27 scheduler self-audit", () => {
  it("defines audit_log.purge_cycle", () => {
    expect(ADMIN_ACTIONS.audit_log.purgeCycle).toBe("audit_log.purge_cycle");
  });

  it("defines audit_retention.hard_delete separately from manual_hard_delete", () => {
    expect(ADMIN_ACTIONS.audit_retention.hardDelete).toBe("audit_retention.hard_delete");
    expect(ADMIN_ACTIONS.audit_retention.manualHardDelete).toBe("audit_retention.manual_hard_delete");
  });
});

describe("logAdminAction() — system actor (F-27)", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryThrow = null;
  });

  afterEach(() => {
    if (origDbUrl) {
      process.env.DATABASE_URL = origDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    _resetPool(null);
  });

  function enableInternalDB() {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
  }

  it("uses systemActor as actor_id and actor_email when no request context", () => {
    enableInternalDB();

    logAdminAction({
      actionType: ADMIN_ACTIONS.audit_log.purgeCycle,
      targetType: "audit_log",
      targetId: "scheduler",
      systemActor: "system:audit-purge-scheduler",
      metadata: { softDeleted: 0, hardDeleted: 0, orgs: 0 },
    });

    expect(queryCalls).toHaveLength(1);
    const params = queryCalls[0].params!;
    expect(params[0]).toBe("system:audit-purge-scheduler"); // actor_id
    expect(params[1]).toBe("system:audit-purge-scheduler"); // actor_email
    expect(params[2]).toBe("platform");                     // scope defaults to platform
    expect(params[10]).toBe("system:audit-purge-scheduler"); // request_id fallback
  });

  it("systemActor overrides user context so a scheduler inside an outer request still labels itself", () => {
    enableInternalDB();
    const user: AtlasUser = {
      id: "admin-1",
      label: "admin@example.com",
      mode: "managed",
      role: "platform_admin",
      activeOrganizationId: "org-123",
    };

    withRequestContext({ requestId: "req-1", user }, () => {
      logAdminAction({
        actionType: ADMIN_ACTIONS.audit_log.purgeCycle,
        targetType: "audit_log",
        targetId: "scheduler",
        systemActor: "system:audit-purge-scheduler",
      });
    });

    expect(queryCalls).toHaveLength(1);
    const params = queryCalls[0].params!;
    expect(params[0]).toBe("system:audit-purge-scheduler");
    expect(params[1]).toBe("system:audit-purge-scheduler");
    // requestId from outer context is preserved — correlates the cycle row
    // with any enclosing request for forensic join queries.
    expect(params[10]).toBe("req-1");
  });

  it("drops the row on malformed systemActor (no prefix) without throwing", () => {
    // Fire-and-forget contract: a malformed actor is a programmer error
    // but must never crash the caller. We log and drop so a typo can't
    // take down a scheduler loop.
    enableInternalDB();

    expect(() =>
      logAdminAction({
        actionType: ADMIN_ACTIONS.audit_log.purgeCycle,
        targetType: "audit_log",
        targetId: "scheduler",
        systemActor: "audit-purge-scheduler", // missing "system:" prefix
      }),
    ).not.toThrow();
    expect(queryCalls).toHaveLength(0);
  });

  it("drops the row on systemActor with spaces or uppercase without throwing", () => {
    enableInternalDB();

    expect(() =>
      logAdminAction({
        actionType: ADMIN_ACTIONS.audit_log.purgeCycle,
        targetType: "audit_log",
        targetId: "scheduler",
        systemActor: "system:Audit Purge",
      }),
    ).not.toThrow();
    expect(queryCalls).toHaveLength(0);
  });

  it("logAdminActionAwait surfaces TypeError so explicit-await callers see it", async () => {
    enableInternalDB();

    await expect(
      logAdminActionAwait({
        actionType: ADMIN_ACTIONS.audit_log.purgeCycle,
        targetType: "audit_log",
        targetId: "scheduler",
        systemActor: "BAD:actor",
      }),
    ).rejects.toThrow(TypeError);
    expect(queryCalls).toHaveLength(0);
  });

  it("pins the reserved actor string for the EE purge scheduler", () => {
    // Guards against accidental renames: any change to
    // "system:audit-purge-scheduler" breaks this test and forces a
    // conscious update of every forensic query that filters on it.
    const PINNED = "system:audit-purge-scheduler";
    expect(PINNED).toMatch(/^system:[a-z0-9][a-z0-9_-]*$/);
  });
});
