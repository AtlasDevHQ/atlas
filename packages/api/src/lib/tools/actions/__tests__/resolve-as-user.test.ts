/**
 * The authorized resolution verbs — `approveActionAsUser` / `denyActionAsUser`.
 *
 * These are the seam both the single-action routes and bulk resolve through,
 * so what belongs HERE is the outcome vocabulary itself: each refusal kind,
 * the conflict arm, and above all the `approved` vs `approved_not_executed`
 * split — the case where the CAS lands but nothing executes, so the row
 * leaves `pending` and nothing will ever retry it on its own. Until the split
 * existed, that state returned success-shaped and the approver was told the
 * action went through.
 *
 * ⚠️ What reaches that arm NARROWED with #5570. It used to be the ordinary
 * restart / other-instance case, because the registry was keyed by action ID
 * and populated per request. The registry is now keyed by `action_type` and
 * populated at module load, so a restart executes fine (pinned in
 * `handler.test.ts` and `execution-context.test.ts`). What is left is one
 * residual: the row's TYPE has no executor on this instance at all — actions
 * disabled on this deploy, a module that failed to import, a plugin that did
 * not wire. The pin below says exactly that, and `redispatchActionAsUser` is
 * the way out of it.
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
  defineActionExecutor,
  redispatchActionAsUser,
  _undefineActionExecutor,
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
// A SECOND owner, so an admin-only action requested by `owner` can still be
// approved by somebody — the separation-of-duties bar rules out only the
// requester, not the role.
const owner2 = createAtlasUser("owner-2", "simple-key", "owner2@test.com", { role: "owner" });

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
  // Registered by TYPE, as an action module does at load (#5570).
  defineActionExecutor(actionType, async () => "done");
  await withRequestContext(
    { requestId: "req-seed", user: { id: requestedBy, label: `${requestedBy}@test.com`, mode: "simple-key" } },
    () => handleAction(req),
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
    // The residual hazard, post-#5570: nothing on this instance knows how to
    // execute the row's action TYPE. The CAS still lands — the row is
    // approved and has left `pending` — but nothing runs, and nothing will
    // retry it on its own. The old interface returned the entry
    // success-shaped; the outcome kind makes the drop visible to every
    // caller, at compile time.
    const id = await seedPending("test:action", "alice");
    _undefineActionExecutor("test:action");

    const outcome = await approveActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("approved_not_executed");
    if (outcome.kind !== "approved_not_executed") throw new Error("unreachable");
    expect(outcome.entry.status).toBe("approved");
    // And the row really did leave pending — the part that makes this a trap.
    const row = await getAction(id);
    expect(row?.status).toBe("approved");
  });

  it("⭐ reaches that arm ONLY for an unregistered type — an unrelated type going missing is irrelevant", async () => {
    // The narrowing #5570 bought, stated as a test: the registry is keyed by
    // action type, so what another action type's module did or did not
    // register cannot decide whether THIS row executes. Under the old per-id
    // Map every row was its own registration and this distinction did not
    // exist.
    const id = await seedPending("test:action", "alice");
    _undefineActionExecutor("some:other-type");

    const outcome = await approveActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("approved");
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

describe("redispatchActionAsUser — the way out of approved_not_executed", () => {
  /** Strand a row exactly as `approved_not_executed` leaves one. */
  async function seedStranded(actionType: string): Promise<string> {
    const id = await seedPending(actionType, "alice");
    _undefineActionExecutor(actionType);
    const approved = await approveActionAsUser(id, { user: admin, orgId: null });
    expect(approved.kind).toBe("approved_not_executed");
    return id;
  }

  it("⭐ runs a stranded row once the type is registered again", async () => {
    const id = await seedStranded("test:stranded");
    // The deploy that has the action module loaded.
    defineActionExecutor("test:stranded", async () => ({ ran: "at last" }));

    const outcome = await redispatchActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("redispatched");
    if (outcome.kind !== "redispatched") throw new Error("unreachable");
    expect(outcome.entry.status).toBe("executed");
    expect(outcome.entry.result).toEqual({ ran: "at last" });
    expect((await getAction(id))?.status).toBe("executed");
  });

  it("⭐ a second re-dispatch cannot double-execute", async () => {
    // The CAS claim, from the caller's side. Two admins on the same stranded
    // row: one dispatch, one 409 — which for an action type that sends email
    // is the whole reason the claim exists.
    let runs = 0;
    const id = await seedStranded("test:double");
    defineActionExecutor("test:double", async () => {
      runs += 1;
      return "sent";
    });

    const first = await redispatchActionAsUser(id, { user: admin, orgId: null });
    const second = await redispatchActionAsUser(id, { user: admin, orgId: null });

    expect(first.kind).toBe("redispatched");
    expect(second.kind).toBe("conflict");
    expect(runs).toBe(1);
  });

  it("leaves the row UNTOUCHED when this instance still cannot execute the type", async () => {
    // The critical ordering: the registration check runs before the claim. If
    // it did not, this call would stamp the row and permanently refuse the
    // instance that actually has the type.
    const id = await seedStranded("test:still-missing");

    const outcome = await redispatchActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("unregistered_type");
    const row = await getAction(id);
    expect(row?.status).toBe("approved");
    expect(row?.executed_at).toBeNull();

    // ...and the row is still re-dispatchable once the module loads.
    defineActionExecutor("test:still-missing", async () => "ok");
    expect((await redispatchActionAsUser(id, { user: admin, orgId: null })).kind).toBe(
      "redispatched",
    );
  });

  it("refuses a row that is still pending — approve it, do not re-dispatch it", async () => {
    const id = await seedPending("test:action", "alice");

    const outcome = await redispatchActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("conflict");
    expect((await getAction(id))?.status).toBe("pending");
  });

  it("refuses a row that already ran", async () => {
    const id = await seedPending("test:action", "alice");
    expect((await approveActionAsUser(id, { user: admin, orgId: null })).kind).toBe("approved");

    const outcome = await redispatchActionAsUser(id, { user: admin, orgId: null });

    expect(outcome.kind).toBe("conflict");
    expect((await getAction(id))?.status).toBe("executed");
  });

  it("applies the approve bar — a member is refused before the row is touched", async () => {
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", "alice");
    _undefineActionExecutor("admin:only");
    expect((await approveActionAsUser(id, { user: owner, orgId: null })).kind).toBe(
      "approved_not_executed",
    );
    defineActionExecutor("admin:only", async () => "ok");

    const outcome = await redispatchActionAsUser(id, { user: member, orgId: null });

    expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
    const row = await getAction(id);
    expect(row?.status).toBe("approved");
    expect(row?.executed_at).toBeNull();
  });

  it("⭐ keeps separation of duties — the requester cannot re-dispatch their own admin-only action", async () => {
    // Re-dispatch is the EXECUTION half of an approval. Letting the requester
    // trigger the side effect would reopen exactly what the approve path's
    // self-approval bar closes, one verb over.
    setActions({ "admin:only": { approval: "admin-only" } });
    const id = await seedPending("admin:only", owner.id);
    _undefineActionExecutor("admin:only");
    expect((await approveActionAsUser(id, { user: owner2, orgId: null })).kind).toBe(
      "approved_not_executed",
    );
    defineActionExecutor("admin:only", async () => "ok");

    const outcome = await redispatchActionAsUser(id, { user: owner, orgId: null });

    expect(outcome).toEqual({ kind: "forbidden", reason: "self_approval" });
  });

  it("returns not_found for an unknown id", async () => {
    const outcome = await redispatchActionAsUser("00000000-0000-4000-8000-000000000000", {
      user: admin,
      orgId: null,
    });
    expect(outcome.kind).toBe("not_found");
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
