/**
 * The authorized resolution verbs — `approveActionAsUser` / `denyActionAsUser`.
 *
 * These are the seam both the single-action routes and bulk resolve through,
 * so what belongs HERE is the outcome vocabulary itself: each refusal kind,
 * the conflict arm, and above all the `approved` vs `approved_not_executed`
 * split — the case where the CAS lands but no executor is registered in this
 * process (a restart, or another instance), the row leaves `pending`, and
 * nothing will ever retry it. Until the split existed, that state returned
 * success-shaped and the approver was told the action went through.
 *
 * Memory-only path, on handler.test.ts's pattern: delete DATABASE_URL +
 * reset the pg pool so the in-memory fallback is exercised. No mock.module.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  approveActionAsUser,
  denyActionAsUser,
  buildActionRequest,
  handleAction,
  getAction,
  _dropActionExecutor,
  _resetActionStore,
} from "../handler";
import { _resetConfig, _setConfigForTest, type ResolvedConfig, type ActionsConfig } from "@atlas/api/lib/config";
import { withRequestContext } from "@atlas/api/lib/logger";
import { _resetPool } from "@atlas/api/lib/db/internal";
import { createAtlasUser } from "@atlas/api/lib/auth/types";

const origDbUrl = process.env.DATABASE_URL;

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.ATLAS_ACTIONS_ENABLED;
  delete process.env.ATLAS_ACTION_APPROVAL;
  _resetPool(null);
  _resetActionStore();
  _resetConfig();
});

afterEach(() => {
  if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
  else delete process.env.DATABASE_URL;
  _resetPool(null);
  _resetActionStore();
  _resetConfig();
});

const admin = createAtlasUser("admin-1", "simple-key", "admin@test.com", { role: "admin" });
const member = createAtlasUser("member-1", "simple-key", "member@test.com", { role: "member" });
// "admin-only" is a legacy name — it requires the OWNER role (permissions.ts).
const owner = createAtlasUser("owner-1", "simple-key", "owner@test.com", { role: "owner" });

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

describe("approveActionAsUser — the outcome vocabulary", () => {
  it("approves and executes when the executor is registered", async () => {
    const id = await seedPending("test:action", "alice");

    const outcome = await approveActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") throw new Error("unreachable");
    expect(outcome.entry.status).toBe("executed");
  });

  it("⭐ names the approved-but-never-executed state instead of shaping it as success", async () => {
    // The hazard case: the row was requested by another process (or before a
    // restart), so this process holds no executor for it. The CAS still
    // lands — the row is approved and has left `pending` — but nothing runs
    // and nothing will retry it. The old interface returned the entry
    // success-shaped; the outcome kind makes the drop visible to every
    // caller, at compile time.
    const id = await seedPending("test:action", "alice");
    _dropActionExecutor(id);

    const outcome = await approveActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("approved_not_executed");
    if (outcome.kind !== "approved_not_executed") throw new Error("unreachable");
    expect(outcome.entry.status).toBe("approved");
    // And the row really did leave pending — the part that makes this a trap.
    const row = await getAction(id);
    expect(row?.status).toBe("approved");
  });

  it("returns not_found for an unknown id", async () => {
    const outcome = await approveActionAsUser("00000000-0000-4000-8000-000000000000", {
      user: admin,
      orgId: null,
    });
    expect(outcome.kind).toBe("not_found");
  });

  it("returns forbidden(role) for a member on an admin-only action", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", "alice");

    const outcome = await approveActionAsUser(id, { user: member, orgId: null });

    expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
    // Refused before any state changed.
    expect((await getAction(id))?.status).toBe("pending");
  });

  it("returns forbidden(self_approval) when the requester approves their own admin-only action", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", owner.id);

    const outcome = await approveActionAsUser(id, { user: owner, orgId: null });

    expect(outcome).toEqual({ kind: "forbidden", reason: "self_approval" });
  });

  it("returns conflict when the action is already resolved", async () => {
    const id = await seedPending("test:action", "alice");
    const first = await approveActionAsUser(id, { user: admin, orgId: null });
    expect(first.kind).toBe("approved");

    const second = await approveActionAsUser(id, { user: admin, orgId: null });
    expect(second.kind).toBe("conflict");
  });
});

describe("denyActionAsUser", () => {
  it("denies with the same refusal vocabulary and records the reason", async () => {
    const id = await seedPending("test:action", "alice");

    const outcome = await denyActionAsUser(id, { user: admin, orgId: null }, "not today");

    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("unreachable");
    expect(outcome.entry.status).toBe("denied");
    expect(outcome.entry.error).toBe("not today");
  });

  it("refuses a member on an admin-only action before any state changes", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", "alice");

    const outcome = await denyActionAsUser(id, { user: member, orgId: null });

    expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
    expect((await getAction(id))?.status).toBe("pending");
  });
});
