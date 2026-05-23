/**
 * End-to-end disconnect → listener-gate contract test (#2656).
 *
 * The disconnect flow's load-bearing promise is:
 *
 *     After DELETE /api/v1/integrations/slack lands, the next Slack
 *     event from the disconnected workspace is silently skipped by
 *     the proactive listener — no classify, no agent, no error log.
 *
 * The listener short-circuits on `WorkspaceInstallGate.isWorkspaceInstallActive`
 * returning false. So the meaningful assertion is gate-level: with the
 * install row present the gate returns true; after DELETE removes the
 * row, the next gate call returns false WITHOUT logging a warning
 * (steady-state "not installed" must stay out of the structured log
 * per the gate's contract).
 *
 * Both flows reach internalQuery in the same process, so the test
 * keeps a tiny stateful in-memory store. The DELETE handler exercises
 * the real route plus the real two-store teardown order; the gate
 * exercises the real `isWorkspaceInstallActive` query path. Only the
 * two leaf functions (`internalQuery`, `deleteInstallation`) are
 * mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Context, Effect, Layer } from "effect";
import {
  MockInternalDB,
  makeMockInternalDBShimLayer,
} from "@atlas/api/testing/api-test-mocks";

// ── Auth — admin shape so adminAuthPreamble admits the request ───────

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        role: "admin",
        activeOrganizationId: "ws-disconnect-gate",
      },
    }),
  ),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

// ── Logger — capture warn calls so we can assert silent skip ─────────

const warnCalls: unknown[][] = [];

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  const logger = { info: noop, warn, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: () => Effect.succeed({ allowed: true }),
}));

// ── In-memory state — drives every internalQuery the test exercises ──

interface InstallState {
  installPresent: boolean;
  cacheClearedAt: number | null;
}

const state: InstallState = {
  installPresent: true,
  cacheClearedAt: null,
};

const mockInternalQuery = mock(async (sql: string, _params?: unknown[]): Promise<unknown[]> => {
  // Catalog row lookup (used by both the install route's catalog check
  // and the disconnect's catalog check).
  if (sql.includes("FROM plugin_catalog\n      WHERE slug = $1")) {
    return [{ slug: "slack", install_model: "oauth", enabled: true }];
  }
  // Install-row config lookup for teamId resolution (DELETE handler).
  // The substring is specific enough to avoid colliding with the gate
  // JOIN query below.
  if (sql.includes("SELECT config->>'team_id'")) {
    return state.installPresent ? [{ team_id: "T-listener-gate-1" }] : [];
  }
  // Install-row DELETE (DELETE handler step 2). Flips the in-memory
  // flag so the next gate read sees the missing row.
  if (sql.includes("DELETE FROM workspace_plugins")) {
    state.installPresent = false;
    return [];
  }
  // Gate JOIN — workspace_plugins ⋈ plugin_catalog ⋈ organization.
  // The gate's query is the only one that joins these three tables, so
  // the JOIN keyword is a sufficient discriminator.
  if (sql.includes("FROM workspace_plugins wp") && sql.includes("JOIN plugin_catalog pc")) {
    if (!state.installPresent) return [];
    return [
      {
        install_enabled: true,
        catalog_enabled: true,
        min_plan: "starter",
        plan_tier: "business",
      },
    ];
  }
  return [];
});

mock.module("@atlas/api/lib/db/internal", () => ({
  InternalDB: MockInternalDB,
  hasInternalDB: () => true,
  internalQuery: mockInternalQuery,
  internalExecute: mock(() => Promise.resolve()),
  makeInternalDBShimLayer: () => makeMockInternalDBShimLayer(mockInternalQuery, { available: true }),
  makeInternalDBLive: () => Layer.succeedContext(Context.empty()),
  createInternalDBTestLayer: () => makeMockInternalDBShimLayer(mockInternalQuery, { available: true }),
  getInternalDB: () => ({
    query: mockInternalQuery,
    connect: () => ({ query: mockInternalQuery, release: () => {} }),
    end: async () => {},
    on: () => {},
  }),
  closeInternalDB: async () => {},
  queryEffect: (sql: string, params?: unknown[]) =>
    Effect.tryPromise({
      try: () => mockInternalQuery(sql, params),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }),
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  findPatternBySQL: async () => null,
  insertLearnedPattern: () => {},
  insertSemanticAmendment: async () => {},
  getPendingAmendmentCount: async () => 0,
  getAutoApproveThreshold: () => 0.95,
  getAutoApproveTypes: () => new Set<string>(),
  getEncryptionKey: () => null,
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
  isPlaintextUrl: () => true,
  _resetEncryptionKeyCache: () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
}));

// ── Slack store — track that the chat_cache row was cleared first ────

const mockDeleteSlackInstallation = mock(async (_teamId: string): Promise<void> => {
  state.cacheClearedAt = Date.now();
});

mock.module("@atlas/api/lib/slack/store", () => ({
  deleteInstallation: mockDeleteSlackInstallation,
  getInstallation: mock(() => Promise.resolve(null)),
  getInstallationByOrg: mock(() => Promise.resolve(null)),
  saveInstallation: mock(() => Promise.resolve()),
  preserveOrgIdOnInstall: mock(() => Promise.resolve()),
  deleteInstallationByOrg: mock(() => Promise.resolve(false)),
  getBotToken: mock(() => Promise.resolve(null)),
  ENV_TEAM_ID: "env",
  KEY_PREFIX: "slack:installation:",
  FIELD: {
    botToken: "botToken",
    teamName: "teamName",
    orgId: "orgId",
    workspaceName: "workspaceName",
    installedAt: "installedAt",
    botUserId: "botUserId",
  },
}));

// ── Late imports (after every mock.module() above) ────────────────────

const ORIGINAL_ENV = { ...process.env };
process.env.ATLAS_CORS_ORIGIN = "https://app.atlas.example";

const { integrations } = await import("../integrations");
const { WorkspaceInstallGate } = await import(
  "@atlas/api/lib/integrations/install/workspace-install-gate"
);
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/integrations", integrations);

function request(path: string, init?: RequestInit) {
  return app.request(`http://localhost${path}`, init);
}

beforeAll(() => {});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

beforeEach(() => {
  state.installPresent = true;
  state.cacheClearedAt = null;
  warnCalls.length = 0;
  mockInternalQuery.mockClear();
  mockDeleteSlackInstallation.mockClear();
  // Restore the chat_cache delete impl in case a previous test
  // overrode it.
  mockDeleteSlackInstallation.mockImplementation(async () => {
    state.cacheClearedAt = Date.now();
  });
});

describe("DELETE /api/v1/integrations/slack → WorkspaceInstallGate transition", () => {
  it("gate returns true before disconnect, false after — silently (no warn)", async () => {
    // Before: install row present → gate admits the event.
    const before = await WorkspaceInstallGate.isWorkspaceInstallActive(
      "ws-disconnect-gate",
      "catalog:slack",
    );
    expect(before).toBe(true);

    // Disconnect — admin clicks the button.
    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });
    expect(res.status).toBe(200);

    // After: gate denies. The listener short-circuits on this verdict —
    // no classify, no agent, no rate-limit hit. Per the gate's contract
    // a steady-state "no install" denial must NOT warn (that path is
    // reserved for catalog drift / DB error, not the everyday absent
    // install). If the disconnect introduced a warn here, the listener
    // would fill the structured log every event a disconnected
    // workspace's bot is still mentioned in.
    const after = await WorkspaceInstallGate.isWorkspaceInstallActive(
      "ws-disconnect-gate",
      "catalog:slack",
    );
    expect(after).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

});

// Ordering (chat_cache before workspace_plugins) is asserted in
// `integrations.test.ts` via a shared `callOrder` spool — that test
// owns the ADR-0003 ordering contract. This file owns the listener
// contract: the gate must flip from true to false after disconnect,
// silently. Keeping the two assertions in separate files prevents
// either file from growing into a kitchen sink that no one wants to
// touch.
