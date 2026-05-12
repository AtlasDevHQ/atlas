/**
 * Tests for /api/v1/me/preferences — the GET and PATCH role-gate behavior.
 *
 * The structural risk worth pinning here is that a non-admin caller cannot
 * persist `defaultLanding = 'admin'`. The UI hides the option, but a direct
 * `curl` would land on the route too; the 403 is the load-bearing gate.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";

// ── Auth mock ──────────────────────────────────────────────────────────────

let fakeAuth: (AuthResult & { authenticated: true }) | null = null;

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve(
      fakeAuth ?? { authenticated: false, status: 401 as const, error: "anonymous" },
    ),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  isStrictRoutingEnabled: () => false,
}));

mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: async () => false,
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

// ── DB mock ────────────────────────────────────────────────────────────────
//
// CLAUDE.md "Mock all exports" rule: any module that transitively imports
// from `db/internal` would otherwise hit `SyntaxError: Export named 'X' not
// found`. The stubs below cover the symbols me-trusted-devices's test set
// proves are enough for the route + middleware import graph.

let dbAvailable = true;
type UserRow = { id: string; default_landing: string };
let users: UserRow[] = [];
const queryLog: Array<{ sql: string; params: unknown[] }> = [];

mock.module("@atlas/api/lib/db/internal", () => {
  const notUsed = () => {
    throw new Error("internal.ts helper not used in this route");
  };
  return {
    hasInternalDB: () => dbAvailable,
    internalQuery: async (sql: string, params: unknown[]) => {
      queryLog.push({ sql, params });
      if (sql.startsWith("SELECT default_landing")) {
        const id = params[0] as string;
        const row = users.find((u) => u.id === id);
        return row ? [{ default_landing: row.default_landing }] : [];
      }
      if (sql.startsWith("UPDATE")) {
        const [value, id] = params as [string, string];
        const row = users.find((u) => u.id === id);
        if (row) row.default_landing = value;
        else users.push({ id, default_landing: value });
        return [];
      }
      return [];
    },
    getInternalDB: () => ({
      query: async () => ({ rows: [] }),
      connect: notUsed,
      end: async () => {},
      on: () => {},
    }),
    queryEffect: notUsed,
    internalExecute: () => {},
    closeInternalDB: async () => {},
    encryptUrl: (s: string) => s,
    decryptUrl: (s: string) => s,
    isPlaintextUrl: () => false,
    isInternalCircuitOpen: () => false,
    _resetPool: () => {},
    _resetCircuitBreaker: () => {},
    _setInternalCircuitOpenForTests: () => {},
    getAutoApproveThreshold: () => 1,
    getAutoApproveTypes: () => new Set<string>(),
    MANAGED_AUTH_MIGRATIONS: [],
    InternalDB: { Service: Symbol("InternalDB") },
    makeInternalDBLive: notUsed,
    makeInternalDBShimLayer: notUsed,
    createInternalDBTestLayer: notUsed,
    migrateInternalDB: async () => {},
    loadSavedConnections: async () => 0,
    findPatternBySQL: async () => null,
    insertLearnedPattern: () => {},
    insertSemanticAmendment: async () => {},
    getPendingAmendmentCount: async () => 0,
    getPendingAmendments: async () => [],
    reviewSemanticAmendment: async () => {},
    incrementPatternCount: () => {},
    getApprovedPatterns: async () => [],
    upsertSuggestion: async () => {},
    getSuggestionsByTables: async () => [],
    getPopularSuggestions: async () => [],
    incrementSuggestionClick: () => {},
    deleteSuggestion: async () => {},
    getAuditLogQueries: async () => [],
    getWorkspaceStatus: async () => null,
    getWorkspaceNamesByIds: async () => new Map<string, string>(),
    getWorkspaceDetails: async () => null,
    updateWorkspaceStatus: async () => {},
    updateWorkspacePlanTier: async () => {},
    getWorkspaceRegion: async () => null,
    setWorkspaceRegion: async () => {},
    cascadeWorkspaceDelete: async () => ({}),
    getWorkspaceHealthSummary: async () => ({}),
    updateWorkspaceByot: async () => {},
    setWorkspaceStripeCustomerId: async () => {},
    setWorkspaceTrialEndsAt: async () => {},
    hardDeleteWorkspace: async () => ({}),
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────────────

const { mePreferences } = await import("../me-preferences");

function userAuth(role: string | undefined): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: `user-${role ?? "none"}`,
      mode: "managed",
      label: `${role ?? "member"}@test.dev`,
      role: role as "admin" | "owner" | "platform_admin" | "member" | undefined,
      activeOrganizationId: "org-1",
    },
  };
}

async function getJson(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  fakeAuth = null;
  dbAvailable = true;
  users = [];
  queryLog.length = 0;
});

describe("GET /api/v1/me/preferences", () => {
  it("returns 401 when unauthenticated", async () => {
    fakeAuth = null;
    const res = await mePreferences.request("/", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the internal DB is not available", async () => {
    fakeAuth = userAuth("member");
    dbAvailable = false;
    const res = await mePreferences.request("/", { method: "GET" });
    expect(res.status).toBe(404);
    expect((await getJson(res)).error).toBe("not_available");
  });

  it("returns the persisted preference for the calling user", async () => {
    fakeAuth = userAuth("admin");
    users.push({ id: "user-admin", default_landing: "admin" });
    const res = await mePreferences.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await getJson(res)).toEqual({ defaultLanding: "admin" });
  });

  it("falls back to chat when the user row has no preference (new signup)", async () => {
    fakeAuth = userAuth("member");
    const res = await mePreferences.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await getJson(res)).toEqual({ defaultLanding: "chat" });
  });
});

describe("PATCH /api/v1/me/preferences", () => {
  function patch(body: unknown) {
    return mePreferences.request("/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects an unknown enum value with 422 via the Zod hook", async () => {
    fakeAuth = userAuth("admin");
    const res = await patch({ defaultLanding: "platform-admin" });
    expect(res.status).toBe(422);
  });

  it("allows a member to set defaultLanding = chat", async () => {
    fakeAuth = userAuth("member");
    const res = await patch({ defaultLanding: "chat" });
    expect(res.status).toBe(200);
    expect(await getJson(res)).toEqual({ defaultLanding: "chat" });
    const updates = queryLog.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updates.length).toBe(1);
    expect(updates[0].params).toEqual(["chat", "user-member"]);
  });

  it("rejects a member trying to set defaultLanding = admin with 403", async () => {
    fakeAuth = userAuth("member");
    const res = await patch({ defaultLanding: "admin" });
    expect(res.status).toBe(403);
    expect((await getJson(res)).error).toBe("forbidden");
    // Critical invariant: the bad write never reaches the DB.
    expect(queryLog.filter((q) => q.sql.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("allows an owner to set defaultLanding = admin", async () => {
    fakeAuth = userAuth("owner");
    const res = await patch({ defaultLanding: "admin" });
    expect(res.status).toBe(200);
    expect(await getJson(res)).toEqual({ defaultLanding: "admin" });
  });

  it("allows a platform_admin to set defaultLanding = admin", async () => {
    fakeAuth = userAuth("platform_admin");
    const res = await patch({ defaultLanding: "admin" });
    expect(res.status).toBe(200);
  });

  it("scopes the UPDATE to the calling user — no cross-user write", async () => {
    fakeAuth = userAuth("admin");
    users.push({ id: "victim", default_landing: "chat" });
    const res = await patch({ defaultLanding: "admin" });
    expect(res.status).toBe(200);
    const victim = users.find((u) => u.id === "victim");
    expect(victim?.default_landing).toBe("chat");
    const writer = users.find((u) => u.id === "user-admin");
    expect(writer?.default_landing).toBe("admin");
  });
});
