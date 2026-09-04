/**
 * The action permission matrix — roles × approval modes × approve/deny.
 *
 * This suite moved DOWN one layer when authorization moved out of the HTTP
 * routes into `approveActionAsUser` / `denyActionAsUser`
 * (`src/lib/tools/actions/handler.ts`). It used to drive the matrix through
 * the Hono app with the handler `mock.module`d, which the refactor made
 * vacuous — the routes no longer call `canApprove` themselves, and Bun's
 * mock.module cannot intercept the handler's module-internal calls anyway.
 * Route-level HTTP mapping (403/404/409 wire shapes) is
 * `src/api/__tests__/actions.test.ts`'s job; the verb↔route composition and
 * the full outcome vocabulary (conflict, approved_not_executed,
 * self_approval) are pinned in
 * `src/lib/tools/actions/__tests__/handler.test.ts` (the "Formerly resolve-as-user.test.ts" section). What THIS file
 * keeps is the matrix's subject, unchanged: the REAL `canApprove` against
 * real config resolution —
 * - member / admin / owner on manual and admin-only, both verbs
 * - simple-key default role (no explicit role ⇒ admin)
 * - per-action `requiredRole` config override
 * - no-auth mode (user undefined) can resolve nothing
 * - the same matrix across all three auth modes
 *
 * NOTE: "admin-only" is a legacy name — it requires the OWNER role
 * (`APPROVAL_MODE_MIN_ROLE` in `src/lib/auth/permissions.ts`).
 *
 * Memory-only path, on handler.test.ts's pattern: delete
 * DATABASE_URL + reset the pg pool so the in-memory store is exercised.
 * No mock.module.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  approveActionAsUser,
  denyActionAsUser,
  buildActionRequest,
  handleAction,
  defineActionExecutor,
  getAction,
  _resetActionStore,
} from "../actions/handler";
import { _resetConfig, _setConfigForTest, type ResolvedConfig, type ActionsConfig } from "@atlas/api/lib/config";
import { withRequestContext } from "@atlas/api/lib/logger";
import { _resetPool } from "@atlas/api/lib/db/internal";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import type { AtlasRole } from "@atlas/api/lib/auth/types";
import type { ActionApprovalMode } from "@atlas/api/lib/action-types";

const origDbUrl = process.env.DATABASE_URL;

const MANUAL = "test:manual";
const ADMIN_ONLY = "test:admin-only";

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

/** The two approval modes the matrix runs against, as per-action config. */
function setStandardActions(): void {
  setActions({
    [MANUAL]: { approval: "manual" },
    [ADMIN_ONLY]: { approval: "admin-only" },
  });
}

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.ATLAS_ACTIONS_ENABLED;
  delete process.env.ATLAS_ACTION_APPROVAL;
  _resetPool(null);
  _resetActionStore();
  _resetConfig();
  setStandardActions();
});

afterEach(() => {
  if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
  else delete process.env.DATABASE_URL;
  _resetPool(null);
  _resetActionStore();
  _resetConfig();
});

// Requested by a user distinct from every approver below, so the
// separation-of-duties arm (covered in handler.test.ts) never trips.
const REQUESTER = "requester-1";

const managedMember = createAtlasUser("member-1", "managed", "member@test.com", { role: "member" });
const simpleKeyAdmin = createAtlasUser("admin-1", "simple-key", "admin@test.com", { role: "admin" });
const byotAdmin = createAtlasUser("byot-admin-1", "byot", "byot-admin@test.com", { role: "admin" });
const managedOwner = createAtlasUser("owner-1", "managed", "owner@test.com", { role: "owner" });
// No explicit role — exercises the simple-key auth-mode default (admin).
const simpleKeyDefault = createAtlasUser("sk-default-1", "simple-key", "sk-default@test.com");

async function seedPending(actionType: string, requestedBy: string): Promise<string> {
  const req = buildActionRequest({
    actionType,
    target: `target-${Math.random()}`,
    summary: "Test action",
    payload: {},
    reversible: false,
  });
  // Registered by TYPE, as an action module does at load (#5570) — the seed's
  // own process is irrelevant to whether a later approval can execute it.
  defineActionExecutor(actionType, async () => "done");
  await withRequestContext(
    { requestId: "req-seed", user: { id: requestedBy, label: `${requestedBy}@test.com`, mode: "simple-key" } },
    () => handleAction(req),
  );
  return req.id;
}

describe("action permission matrix — the real canApprove through the resolution verbs", () => {
  // -------------------------------------------------------------------------
  // Member cannot resolve anything
  // -------------------------------------------------------------------------

  describe("member role", () => {
    it("cannot approve manual actions", async () => {
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: managedMember, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
      // Refused before any state changed.
      expect((await getAction(id))?.status).toBe("pending");
    });

    it("cannot approve admin-only actions", async () => {
      const id = await seedPending(ADMIN_ONLY, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: managedMember, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
      expect((await getAction(id))?.status).toBe("pending");
    });

    it("cannot deny manual actions", async () => {
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await denyActionAsUser(id, { user: managedMember, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
      expect((await getAction(id))?.status).toBe("pending");
    });

    it("cannot deny admin-only actions", async () => {
      const id = await seedPending(ADMIN_ONLY, REQUESTER);

      const outcome = await denyActionAsUser(id, { user: managedMember, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
      expect((await getAction(id))?.status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  // Admin can resolve manual, blocked from admin-only (owner-only)
  // -------------------------------------------------------------------------

  describe("admin role (simple-key)", () => {
    it("can approve manual actions", async () => {
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: simpleKeyAdmin, orgId: null });

      expect(outcome.kind).toBe("approved");
      if (outcome.kind !== "approved") throw new Error("unreachable");
      expect(outcome.entry.approved_by).toBe(simpleKeyAdmin.id);
    });

    it("cannot approve admin-only actions", async () => {
      const id = await seedPending(ADMIN_ONLY, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: simpleKeyAdmin, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
    });

    it("can deny manual actions", async () => {
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await denyActionAsUser(id, { user: simpleKeyAdmin, orgId: null });

      expect(outcome.kind).toBe("denied");
      if (outcome.kind !== "denied") throw new Error("unreachable");
      expect(outcome.entry.status).toBe("denied");
    });

    it("cannot deny admin-only actions", async () => {
      const id = await seedPending(ADMIN_ONLY, REQUESTER);

      const outcome = await denyActionAsUser(id, { user: simpleKeyAdmin, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
    });
  });

  describe("admin role (byot)", () => {
    it("can approve manual actions", async () => {
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: byotAdmin, orgId: null });

      expect(outcome.kind).toBe("approved");
    });

    it("cannot approve admin-only (owner-only) actions", async () => {
      const id = await seedPending(ADMIN_ONLY, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: byotAdmin, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
    });
  });

  // -------------------------------------------------------------------------
  // Owner — full permissions including admin-only
  // -------------------------------------------------------------------------

  describe("owner role", () => {
    it("can approve admin-only actions", async () => {
      const id = await seedPending(ADMIN_ONLY, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: managedOwner, orgId: null });

      expect(outcome.kind).toBe("approved");
      if (outcome.kind !== "approved") throw new Error("unreachable");
      expect(outcome.entry.approved_by).toBe(managedOwner.id);
    });

    it("can deny admin-only actions", async () => {
      const id = await seedPending(ADMIN_ONLY, REQUESTER);

      const outcome = await denyActionAsUser(id, { user: managedOwner, orgId: null });

      expect(outcome.kind).toBe("denied");
      if (outcome.kind !== "denied") throw new Error("unreachable");
      expect(outcome.entry.status).toBe("denied");
    });
  });

  // -------------------------------------------------------------------------
  // Simple-key mode defaults — no explicit role ⇒ admin
  // -------------------------------------------------------------------------

  describe("simple-key default role", () => {
    it("defaults to admin — can approve manual", async () => {
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: simpleKeyDefault, orgId: null });

      expect(outcome.kind).toBe("approved");
    });

    it("defaults to admin — blocked from admin-only (owner-only)", async () => {
      const id = await seedPending(ADMIN_ONLY, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: simpleKeyDefault, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
    });
  });

  // -------------------------------------------------------------------------
  // Per-action requiredRole config override
  // -------------------------------------------------------------------------

  describe("per-action requiredRole override", () => {
    it("requiredRole=owner blocks admin on manual action", async () => {
      setActions({ [MANUAL]: { approval: "manual", requiredRole: "owner" } });
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: simpleKeyAdmin, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
      expect((await getAction(id))?.status).toBe("pending");
    });

    it("requiredRole=admin allows admin on manual action", async () => {
      setActions({ [MANUAL]: { approval: "manual", requiredRole: "admin" } });
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: byotAdmin, orgId: null });

      expect(outcome.kind).toBe("approved");
    });

    it("requiredRole=member allows member on manual action", async () => {
      setActions({ [MANUAL]: { approval: "manual", requiredRole: "member" } });
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: managedMember, orgId: null });

      expect(outcome.kind).toBe("approved");
    });
  });

  // -------------------------------------------------------------------------
  // No-auth mode — user is undefined, actions require identity
  // -------------------------------------------------------------------------

  describe("no-auth mode (user is undefined)", () => {
    it("cannot approve manual actions", async () => {
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await approveActionAsUser(id, { user: undefined, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
      expect((await getAction(id))?.status).toBe("pending");
    });

    it("cannot deny manual actions", async () => {
      const id = await seedPending(MANUAL, REQUESTER);

      const outcome = await denyActionAsUser(id, { user: undefined, orgId: null });

      expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
      expect((await getAction(id))?.status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  // Auth mode × role × approval mode matrix (all 3 auth modes)
  //
  // Role decides, auth mode does not (with an explicit role set, the mode's
  // default-role fallback never engages) — the matrix pins that the outcome
  // is identical across simple-key / managed / byot.
  // -------------------------------------------------------------------------

  describe("cross-auth-mode matrix", () => {
    const modes = ["simple-key", "managed", "byot"] as const;
    const scenarios: Array<{
      role: AtlasRole;
      approval: ActionApprovalMode;
      allowed: boolean;
    }> = [
      // member: blocked from manual and admin-only
      { role: "member", approval: "manual", allowed: false },
      { role: "member", approval: "admin-only", allowed: false },
      // admin: can approve manual, blocked from admin-only (owner-only)
      { role: "admin", approval: "manual", allowed: true },
      { role: "admin", approval: "admin-only", allowed: false },
      // owner: can approve all
      { role: "owner", approval: "manual", allowed: true },
      { role: "owner", approval: "admin-only", allowed: true },
    ];

    for (const mode of modes) {
      for (const { role, approval, allowed } of scenarios) {
        it(`${mode}/${role} + ${approval} => ${allowed ? "approved" : "forbidden(role)"}`, async () => {
          const user = createAtlasUser(`${mode}-${role}`, mode, `${mode}-${role}@test.com`, { role });
          const actionType = approval === "admin-only" ? ADMIN_ONLY : MANUAL;
          const id = await seedPending(actionType, REQUESTER);

          const outcome = await approveActionAsUser(id, { user, orgId: null });

          if (allowed) {
            expect(outcome.kind).toBe("approved");
          } else {
            expect(outcome).toEqual({ kind: "forbidden", reason: "role" });
          }
        });
      }
    }
  });
});
