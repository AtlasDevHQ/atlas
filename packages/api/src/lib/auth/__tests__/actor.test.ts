/**
 * Tests for `lib/auth/actor.ts` — F-54 / F-55 actor resolution.
 *
 * `loadActorUser` resolves a real user (used by the scheduler executor)
 * and merges the user-level role with their org membership role. The
 * scheduler test only verifies that the executor passes whatever the
 * helper returns to `executeAgentQuery({ actor })`, so this file is the
 * only place the role-elevation + branch logic is pinned.
 *
 * `botActorUser` is a pure synthetic-identity factory; tested for shape
 * because the id format is what audit rows and approval requests carry.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

const internalQueryCalls: { sql: string; params: unknown[] }[] = [];
let nextRows: Record<string, unknown>[][] = [];
let hasInternalDBValue = true;
let internalQueryError: Error | null = null;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasInternalDBValue,
  internalQuery: async (sql: string, params?: unknown[]) => {
    internalQueryCalls.push({ sql, params: params ?? [] });
    if (internalQueryError) throw internalQueryError;
    return nextRows.shift() ?? [];
  },
}));

const { loadActorUser, botActorUser } = await import("../actor");

beforeEach(() => {
  internalQueryCalls.length = 0;
  nextRows = [];
  hasInternalDBValue = true;
  internalQueryError = null;
});

describe("loadActorUser", () => {
  it("returns null when the user row no longer exists (deleted account)", async () => {
    nextRows = [[]]; // user lookup → empty
    const actor = await loadActorUser("user-deleted", "org-1");
    expect(actor).toBeNull();
  });

  it("returns null when no internal DB is configured", async () => {
    hasInternalDBValue = false;
    const actor = await loadActorUser("user-1", "org-1");
    expect(actor).toBeNull();
    // Never queried — short-circuited at the hasInternalDB() guard
    expect(internalQueryCalls).toHaveLength(0);
  });

  it("rethrows DB errors so callers can distinguish from a deleted user", async () => {
    // F-54 silent-failure-hunter follow-up: previously this caught and
    // returned null, so a transient DB error told the operator to
    // recreate the task ("owner could not be resolved"). Now the caller
    // sees the underlying DB error and the run fails as transient — a
    // retry on the next scheduler tick succeeds when the DB recovers.
    internalQueryError = new Error("connection refused");
    await expect(loadActorUser("user-1", "org-1")).rejects.toThrow(/connection refused/);
  });

  it("builds an AtlasUser with email as label and the explicit org id", async () => {
    nextRows = [
      [{ id: "user-1", email: "alice@example.com", role: "admin" }],
      [], // member lookup empty — keep user-level role
    ];
    const actor = await loadActorUser("user-1", "org-1");
    expect(actor).not.toBeNull();
    expect(actor?.id).toBe("user-1");
    expect(actor?.label).toBe("alice@example.com");
    expect(actor?.mode).toBe("managed");
    expect(actor?.role).toBe("admin");
    expect(actor?.activeOrganizationId).toBe("org-1");
    expect(actor?.claims?.sub).toBe("user-1");
    expect(actor?.claims?.org_id).toBe("org-1");
  });

  it("falls back to the user id when email is null", async () => {
    nextRows = [
      [{ id: "user-2", email: null, role: "member" }],
      [],
    ];
    const actor = await loadActorUser("user-2", null);
    expect(actor?.label).toBe("user-2");
    expect(actor?.activeOrganizationId).toBeUndefined();
  });

  it("elevates a user-level 'member' role to 'owner' via org membership", async () => {
    // The scheduler creator may have a low user-level role but be the org
    // owner via the `member` table. Effective role must reflect the higher
    // of the two so approval / governance checks see the real privilege.
    nextRows = [
      [{ id: "user-3", email: "owner@example.com", role: "member" }],
      [{ role: "owner" }],
    ];
    const actor = await loadActorUser("user-3", "org-3");
    expect(actor?.role).toBe("owner");
  });

  it("does not downgrade a higher user-level role", async () => {
    nextRows = [
      [{ id: "user-4", email: "platform@example.com", role: "platform_admin" }],
      [{ role: "member" }],
    ];
    const actor = await loadActorUser("user-4", "org-4");
    expect(actor?.role).toBe("platform_admin");
  });

  it("ignores invalid org membership role and keeps the user-level role", async () => {
    nextRows = [
      [{ id: "user-5", email: "bad@example.com", role: "admin" }],
      [{ role: "totally-invalid" }],
    ];
    const actor = await loadActorUser("user-5", "org-5");
    expect(actor?.role).toBe("admin");
  });

  it("skips the member lookup when no orgId is provided", async () => {
    nextRows = [
      [{ id: "user-6", email: "no-org@example.com", role: "admin" }],
    ];
    const actor = await loadActorUser("user-6", null);
    expect(actor?.role).toBe("admin");
    expect(actor?.activeOrganizationId).toBeUndefined();
    // Only one query — the user lookup. Member table never touched.
    expect(internalQueryCalls).toHaveLength(1);
    expect(internalQueryCalls[0].sql).toContain('FROM "user"');
  });
});

describe("botActorUser", () => {
  it("formats the synthetic id as `<platform>-bot:<externalId>`", () => {
    const actor = botActorUser({ platform: "slack", externalId: "T123", orgId: "org-1" });
    expect(actor.id).toBe("slack-bot:T123");
    expect(actor.label).toBe("slack-bot:T123");
    expect(actor.mode).toBe("simple-key");
    expect(actor.role).toBe("member");
    expect(actor.activeOrganizationId).toBe("org-1");
    expect(actor.claims?.chat_platform).toBe("slack");
    expect(actor.claims?.external_id).toBe("T123");
    expect(actor.claims?.org_id).toBe("org-1");
  });

  it("appends the external user id when provided so per-user audit trails survive", () => {
    const actor = botActorUser({ platform: "slack", externalId: "T123", orgId: "org-1", externalUserId: "U456" });
    expect(actor.id).toBe("slack-bot:T123:U456");
    expect(actor.claims?.external_user_id).toBe("U456");
  });

  it("supports teams and discord platforms", () => {
    expect(botActorUser({ platform: "teams", externalId: "tenant-99", orgId: "org-2" }).id).toBe("teams-bot:tenant-99");
    expect(botActorUser({ platform: "discord", externalId: "guild-7", orgId: "org-3" }).id).toBe("discord-bot:guild-7");
  });
});
