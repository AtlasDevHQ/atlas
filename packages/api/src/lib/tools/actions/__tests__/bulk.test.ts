import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  handleAction,
  buildActionRequest,
  _resetActionStore,
} from "../handler";
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
const viewer = createAtlasUser("viewer-1", "simple-key", "viewer@test.com", { role: "viewer" });

function setActions(actions: ActionsConfig): void {
  _setConfigForTest({
    datasources: {},
    tools: [],
    auth: { mode: "none" },
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

    const result = await bulkApproveActions({ ids: [id1, id2], user: admin });

    expect(result.updated.sort()).toEqual([id1, id2].sort());
    expect(result.notFound).toEqual([]);
    expect(result.forbidden).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("classifies missing ids as notFound", async () => {
    const existing = await seedPending("test:action", "alice");
    const ghost = "deadbeef-dead-beef-dead-beefdeadbeef";

    const result = await bulkApproveActions({ ids: [existing, ghost], user: admin });

    expect(result.updated).toEqual([existing]);
    expect(result.notFound).toEqual([ghost]);
  });

  it("classifies permission-blocked ids as forbidden", async () => {
    // Configure an action_type that requires admin approval
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", "alice");

    // Viewer lacks the admin role → forbidden
    const result = await bulkApproveActions({ ids: [id], user: viewer });

    expect(result.forbidden).toEqual([id]);
    expect(result.updated).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("blocks self-approval of admin-only actions (separation of duties)", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    // Admin requested the action → cannot self-approve
    const id = await seedPending("admin:only", admin.id);

    const result = await bulkApproveActions({ ids: [id], user: admin });

    expect(result.forbidden).toEqual([id]);
    expect(result.updated).toEqual([]);
  });

  it("reports already-resolved ids in errors (CAS conflict)", async () => {
    const id = await seedPending("test:action", "alice");

    // First approval transitions status to approved
    const first = await bulkApproveActions({ ids: [id], user: admin });
    expect(first.updated).toEqual([id]);

    // Second approval races with the now-resolved row
    const second = await bulkApproveActions({ ids: [id], user: admin });
    expect(second.updated).toEqual([]);
    expect(second.errors).toEqual([{ id, error: "Action has already been resolved." }]);
  });

  it("mixes all four buckets in one call", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const okId = await seedPending("test:action", "alice");
    const forbiddenId = await seedPending("admin:only", admin.id);
    const ghost = "deadbeef-dead-beef-dead-beefdeadbeef";

    // Pre-resolve one id to create a CAS conflict
    const resolvedId = await seedPending("test:action", "alice");
    await bulkApproveActions({ ids: [resolvedId], user: admin });

    const result = await bulkApproveActions({
      ids: [okId, forbiddenId, ghost, resolvedId],
      user: admin,
    });

    expect(result.updated).toEqual([okId]);
    expect(result.forbidden).toEqual([forbiddenId]);
    expect(result.notFound).toEqual([ghost]);
    expect(result.errors).toEqual([{ id: resolvedId, error: "Action has already been resolved." }]);
  });

  it("accepts an empty id list and returns empty buckets", async () => {
    const result = await bulkApproveActions({ ids: [], user: admin });
    expect(result.updated).toEqual([]);
    expect(result.notFound).toEqual([]);
    expect(result.forbidden).toEqual([]);
    expect(result.errors).toEqual([]);
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
      reason: "Not appropriate",
    });

    expect(result.updated.sort()).toEqual([id1, id2].sort());
    expect(result.errors).toEqual([]);
  });

  it("treats a second deny on the same id as an already-resolved conflict", async () => {
    const id = await seedPending("test:action", "alice");

    const first = await bulkDenyActions({ ids: [id], user: admin });
    expect(first.updated).toEqual([id]);

    const second = await bulkDenyActions({ ids: [id], user: admin });
    expect(second.updated).toEqual([]);
    expect(second.errors).toEqual([{ id, error: "Action has already been resolved." }]);
  });

  it("blocks permission-denied ids before calling denyAction", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", "alice");

    const result = await bulkDenyActions({ ids: [id], user: viewer });

    expect(result.forbidden).toEqual([id]);
    expect(result.updated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Limit
// ---------------------------------------------------------------------------

describe("BULK_ACTIONS_MAX", () => {
  it("matches the documented ceiling in the issue", () => {
    expect(BULK_ACTIONS_MAX).toBe(100);
  });
});
