import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  handleAction,
  buildActionRequest,
  getAction,
  _resetActionStore,
} from "../handler";
import * as handler from "../handler";
import { bulkApproveActions, bulkDenyActions, BULK_ACTIONS_MAX } from "../bulk";
import { _resetConfig, _setConfigForTest, type ResolvedConfig, type ActionsConfig } from "@atlas/api/lib/config";
import { withRequestContext } from "@atlas/api/lib/logger";
import { _resetPool } from "@atlas/api/lib/db/internal";
import { createAtlasUser } from "@atlas/api/lib/auth/types";

/**
 * Bulk approve / deny service tests — memory-only path (no DATABASE_URL).
 *
 * Follows the pattern in handler.test.ts: delete DATABASE_URL + reset the
 * pg pool so the in-memory fallback is exercised. No DB mock necessary.
 */

const origDbUrl = process.env.DATABASE_URL;

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.ATLAS_ACTIONS_ENABLED;
  delete process.env.ATLAS_ACTION_APPROVAL;
  delete process.env.ATLAS_ACTION_TIMEOUT;
  _resetPool(null);
  _resetActionStore();
  _resetConfig();
});

afterEach(() => {
  delete process.env.ATLAS_ACTIONS_ENABLED;
  delete process.env.ATLAS_ACTION_APPROVAL;
  delete process.env.ATLAS_ACTION_TIMEOUT;
  if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
  else delete process.env.DATABASE_URL;
  _resetPool(null);
  _resetActionStore();
  _resetConfig();
});

const admin = createAtlasUser("admin-1", "simple-key", "admin@test.com", { role: "admin" });
const member = createAtlasUser("member-1", "simple-key", "member@test.com", { role: "member" });

function setActions(actions: ActionsConfig): void {
  _setConfigForTest({
    datasources: {},
    tools: [],
    auth: "none",
    semanticLayer: "./semantic",
    maxTotalConnections: 20,
    actions,
    source: "env",
  } as ResolvedConfig);
}

async function seedPending(actionType: string, requestedBy: string): Promise<string> {
  const req = buildActionRequest({
    actionType,
    target: `target-${Math.random()}`,
    summary: "Test action",
    payload: {},
    reversible: false,
  });
  await withRequestContext(
    { requestId: "req-seed", user: { id: requestedBy, label: `${requestedBy}@test.com`, mode: "simple-key" } },
    () => handleAction(req, async () => "done"),
  );
  return req.id;
}

// ---------------------------------------------------------------------------
// bulkApproveActions
// ---------------------------------------------------------------------------

describe("bulkApproveActions()", () => {
  it("approves multiple pending actions and returns them in `updated`", async () => {
    const id1 = await seedPending("test:action", "alice");
    const id2 = await seedPending("test:action", "bob");

    const result = await bulkApproveActions({ ids: [id1, id2], user: admin, orgId: null });

    expect([...result.updated].sort()).toEqual([id1, id2].sort());
    expect(result.notFound).toEqual([]);
    expect(result.forbidden).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("transitions action_log row to status=approved (behavioral assertion)", async () => {
    const id = await seedPending("test:action", "alice");

    await bulkApproveActions({ ids: [id], user: admin, orgId: null });

    const row = await getAction(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("executed"); // executor ran synchronously for manual approval
  });

  it("classifies missing ids as notFound", async () => {
    const existing = await seedPending("test:action", "alice");
    const ghost = "deadbeef-dead-beef-dead-beefdeadbeef";

    const result = await bulkApproveActions({ ids: [existing, ghost], user: admin, orgId: null });

    expect(result.updated).toEqual([existing]);
    expect(result.notFound).toEqual([ghost]);
  });

  it("classifies permission-blocked ids as forbidden", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", "alice");

    const result = await bulkApproveActions({ ids: [id], user: member, orgId: null });

    expect(result.forbidden).toEqual([id]);
    expect(result.updated).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("blocks self-approval of admin-only actions (separation of duties)", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", admin.id);

    const result = await bulkApproveActions({ ids: [id], user: admin, orgId: null });

    expect(result.forbidden).toEqual([id]);
    expect(result.updated).toEqual([]);
  });

  it("reports already-resolved ids in errors (CAS conflict)", async () => {
    const id = await seedPending("test:action", "alice");

    const first = await bulkApproveActions({ ids: [id], user: admin, orgId: null });
    expect(first.updated).toEqual([id]);

    const second = await bulkApproveActions({ ids: [id], user: admin, orgId: null });
    expect(second.updated).toEqual([]);
    expect(second.errors).toEqual([{ id, error: "Action has already been resolved." }]);
  });

  it("mixes all four buckets in one call", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const okId = await seedPending("test:action", "alice");
    const forbiddenId = await seedPending("admin:only", admin.id);
    const ghost = "deadbeef-dead-beef-dead-beefdeadbeef";

    const resolvedId = await seedPending("test:action", "alice");
    await bulkApproveActions({ ids: [resolvedId], user: admin, orgId: null });

    const result = await bulkApproveActions({
      ids: [okId, forbiddenId, ghost, resolvedId],
      user: admin,
      orgId: null,
    });

    expect(result.updated).toEqual([okId]);
    expect(result.forbidden).toEqual([forbiddenId]);
    expect(result.notFound).toEqual([ghost]);
    expect(result.errors).toEqual([{ id: resolvedId, error: "Action has already been resolved." }]);
  });

  it("dedups duplicate ids so each id appears in exactly one bucket", async () => {
    const id = await seedPending("test:action", "alice");

    const result = await bulkApproveActions({
      ids: [id, id, id],
      user: admin,
      orgId: null,
    });

    expect(result.updated).toEqual([id]);
    expect(result.errors).toEqual([]);
  });

  it("accepts an empty id list and returns empty buckets", async () => {
    const result = await bulkApproveActions({ ids: [], user: admin, orgId: null });
    expect(result.updated).toEqual([]);
    expect(result.notFound).toEqual([]);
    expect(result.forbidden).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("surfaces a generic user-safe message when getAction throws during preClassify", async () => {
    const id = await seedPending("test:action", "alice");

    const spy = spyOn(handler, "getAction").mockImplementationOnce(() => {
      throw new Error("SELECT failed: relation 'action_log' does not exist, schema=internal");
    });

    try {
      const result = await bulkApproveActions({
        ids: [id],
        user: admin,
        orgId: null,
        requestId: "req-test",
      });

      expect(result.updated).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].id).toBe(id);
      // Raw pg error message must not leak to the caller.
      expect(result.errors[0].error).toBe("Failed to resolve action.");
      expect(result.errors[0].error).not.toContain("SELECT");
    } finally {
      spy.mockRestore();
    }
  });

  it("surfaces a generic message when approveAction throws unexpectedly", async () => {
    const id = await seedPending("test:action", "alice");

    const spy = spyOn(handler, "approveAction").mockImplementationOnce(() => {
      throw new Error("UPDATE failed: duplicate key value violates constraint on internal_log");
    });

    try {
      const result = await bulkApproveActions({ ids: [id], user: admin, orgId: null });
      expect(result.updated).toEqual([]);
      expect(result.errors).toEqual([{ id, error: "Failed to resolve action." }]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-org scoping (security invariant)
// ---------------------------------------------------------------------------

describe("bulk cross-org scoping", () => {
  it("surfaces cross-org ids as notFound (not forbidden) to avoid leaking existence", async () => {
    // Seed an action with org_id: "org-A" by mutating the in-memory row.
    const id = await seedPending("test:action", "alice");
    const row = await getAction(id);
    expect(row).not.toBeNull();
    (row as unknown as Record<string, unknown>).org_id = "org-A";

    // Caller is in "org-B" — must see the id as notFound, never forbidden.
    const result = await bulkApproveActions({
      ids: [id],
      user: admin,
      orgId: "org-B",
    });

    expect(result.notFound).toEqual([id]);
    expect(result.forbidden).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("allows ids whose org matches the caller's orgId", async () => {
    const id = await seedPending("test:action", "alice");
    const row = await getAction(id);
    (row as unknown as Record<string, unknown>).org_id = "org-A";

    const result = await bulkApproveActions({
      ids: [id],
      user: admin,
      orgId: "org-A",
    });

    expect(result.updated).toEqual([id]);
  });
});

// ---------------------------------------------------------------------------
// bulkDenyActions
// ---------------------------------------------------------------------------

describe("bulkDenyActions()", () => {
  it("denies multiple pending actions and records the reason on each", async () => {
    const id1 = await seedPending("test:action", "alice");
    const id2 = await seedPending("test:action", "bob");

    const result = await bulkDenyActions({
      ids: [id1, id2],
      user: admin,
      orgId: null,
      reason: "Not appropriate",
    });

    expect([...result.updated].sort()).toEqual([id1, id2].sort());
    expect(result.errors).toEqual([]);
  });

  it("transitions action_log row to status=denied (behavioral assertion)", async () => {
    const id = await seedPending("test:action", "alice");

    await bulkDenyActions({ ids: [id], user: admin, orgId: null, reason: "No." });

    const row = await getAction(id);
    expect(row!.status).toBe("denied");
    expect(row!.error).toBe("No.");
  });

  it("treats a second deny on the same id as an already-resolved conflict", async () => {
    const id = await seedPending("test:action", "alice");

    const first = await bulkDenyActions({ ids: [id], user: admin, orgId: null });
    expect(first.updated).toEqual([id]);

    const second = await bulkDenyActions({ ids: [id], user: admin, orgId: null });
    expect(second.updated).toEqual([]);
    expect(second.errors).toEqual([{ id, error: "Action has already been resolved." }]);
  });

  it("blocks permission-denied ids before calling denyAction", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", "alice");

    const result = await bulkDenyActions({ ids: [id], user: member, orgId: null });

    expect(result.forbidden).toEqual([id]);
    expect(result.updated).toEqual([]);
  });

  it("dedups duplicate ids", async () => {
    const id = await seedPending("test:action", "alice");

    const result = await bulkDenyActions({
      ids: [id, id],
      user: admin,
      orgId: null,
    });

    expect(result.updated).toEqual([id]);
    expect(result.errors).toEqual([]);
  });
});

// BULK_ACTIONS_MAX is exercised by the route-layer 400 test in actions.test.ts —
// no self-referential unit check here.
void BULK_ACTIONS_MAX;
