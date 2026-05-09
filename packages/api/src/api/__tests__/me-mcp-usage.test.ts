/**
 * `/api/v1/me/mcp-usage` route tests (#2216).
 *
 * Surfaces live MCP rate-limit bucket state for the calling user's
 * OAuth clients so Settings → AI Agents can show "35/60 used this
 * minute" before a 429 lands. Tests pin:
 *
 *   - 200 returns `{ clients }` shaped per `MeMcpUsageResponseSchema`
 *   - One row per user-owned client; foreign clients never surface
 *   - `percentUsed` is clamped at 100 even when the bucket is over
 *   - `mcp_session.usage_read` audit row written on success
 *   - 401 unauth, empty payload when no active org, 404 when no DB
 *
 * Limiter state is reset between tests so the in-process `buckets`
 * map (per-replica, in-memory) doesn't leak across cases. Mocking
 * `listOAuthClients` keeps the test off the internal-DB path while
 * still exercising the route's per-client loop.
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

interface CapturedListCall {
  scope: { kind: "user"; userId: string; orgId: string };
}

interface MockOAuthClientRow {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: string;
  updatedAt: string | null;
  disabled: boolean;
  type: string | null;
  lastUsedAt: string | null;
  tokenCount: number;
  tokenState: "active" | "reconnect_required" | "revoked";
  rateLimitPerMinute: number | null;
  workspaceScope: "single" | "multi";
  grantedWorkspaceIds: string[];
}

const listCalls: CapturedListCall[] = [];
let mockListResult: MockOAuthClientRow[] = [];
let mockListThrow: Error | null = null;

const auditCalls: Array<{ actionType: string; metadata?: Record<string, unknown> }> = [];

// Mock the oauth-clients helper module wholesale (CLAUDE.md "Mock all
// exports" — listOAuthClients is one of several exports the route layer
// or its dependants might pull).
mock.module("@atlas/api/lib/auth/oauth-clients", () => ({
  listOAuthClients: async (scope: CapturedListCall["scope"] | { kind: "org"; orgId: string }) => {
    if (scope.kind !== "user") {
      throw new Error(`unexpected scope kind: ${scope.kind} — me-mcp-usage must always pass user scope`);
    }
    listCalls.push({ scope });
    if (mockListThrow) throw mockListThrow;
    return mockListResult;
  },
  // Other exports the route doesn't use but must be present for the
  // partial-mock SyntaxError trap.
  findOAuthClient: async () => null,
  revokeOAuthClient: async () => ({ status: "ok", access: 0, refresh: 0, consent: 0 }),
  setOAuthClientRateLimit: async () => undefined,
  MIN_OAUTH_CLIENT_RPM: 1,
  MAX_OAUTH_CLIENT_RPM: 3600,
}));

// Re-export ADMIN_ACTIONS verbatim from the catalog module so the spy
// preserves the catalog-as-source-of-truth contract — adding a new
// action only ever requires editing actions.ts. The spy itself
// captures action-type + metadata for the usage_read assertion.
import { ADMIN_ACTIONS } from "../../lib/audit/actions";

mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS,
  logAdminAction: (entry: {
    actionType: string;
    metadata?: Record<string, unknown>;
  }) => {
    auditCalls.push({ actionType: entry.actionType, metadata: entry.metadata });
  },
  logAdminActionAwait: async (entry: {
    actionType: string;
    metadata?: Record<string, unknown>;
  }) => {
    auditCalls.push({ actionType: entry.actionType, metadata: entry.metadata });
  },
}));

const mocks = createApiTestMocks({
  authUser: {
    id: "user-1",
    mode: "managed",
    label: "user@test.com",
    role: "member",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

const { app } = await import("../index");

// Reset limiter state between cases — the in-memory bucket map is a
// process-singleton so leakage between cases would cause weight sums
// to drift. Imported AFTER the app to mirror runtime ordering.
const {
  _resetClientRateLimitsForTests,
  _setClockForTests,
  checkClientRateLimit,
  setClientRateLimit,
} = await import("../../lib/rate-limit/oauth-client");

afterAll(() => mocks.cleanup());

function meRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
  });
}

function row(overrides: Partial<MockOAuthClientRow> = {}): MockOAuthClientRow {
  return {
    clientId: "claude-desktop",
    clientName: "Claude Desktop",
    redirectUris: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: null,
    disabled: false,
    type: "public",
    lastUsedAt: null,
    tokenCount: 1,
    tokenState: "active",
    rateLimitPerMinute: null,
    workspaceScope: "single",
    grantedWorkspaceIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  listCalls.length = 0;
  auditCalls.length = 0;
  mockListResult = [];
  mockListThrow = null;
  mocks.setMember("org-alpha");
  _resetClientRateLimitsForTests();
  _setClockForTests(null);
});

// ---------------------------------------------------------------------------
// GET /api/v1/me/mcp-usage
// ---------------------------------------------------------------------------

describe("GET /api/v1/me/mcp-usage", () => {
  it("returns one row per user-owned client with shape { clientId, currentMinuteWeightedRequests, ceiling, percentUsed, resetAt }", async () => {
    mockListResult = [row({ clientId: "claude-desktop" }), row({ clientId: "cursor" })];

    const res = await app.fetch(meRequest("/api/v1/me/mcp-usage"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clients: Array<{
        clientId: string;
        currentMinuteWeightedRequests: number;
        ceiling: number;
        percentUsed: number;
        resetAt: string;
      }>;
    };

    expect(body.clients).toHaveLength(2);
    expect(body.clients.map((c) => c.clientId).sort()).toEqual([
      "claude-desktop",
      "cursor",
    ]);
    for (const entry of body.clients) {
      expect(entry.currentMinuteWeightedRequests).toBe(0);
      expect(entry.ceiling).toBeGreaterThan(0);
      expect(entry.percentUsed).toBe(0);
      // resetAt is ISO 8601 string — easier for the UI than raw epoch ms.
      expect(typeof entry.resetAt).toBe("string");
      expect(Number.isNaN(Date.parse(entry.resetAt))).toBe(false);
    }
  });

  it("forwards the caller's userId + activeOrgId to listOAuthClients (cross-user isolation)", async () => {
    mockListResult = [row()];

    await app.fetch(meRequest("/api/v1/me/mcp-usage"));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.scope).toEqual({
      kind: "user",
      userId: "user-1",
      orgId: "org-alpha",
    });
  });

  it("reports the live weighted sum after admitted dispatches", async () => {
    mockListResult = [row({ clientId: "claude-desktop" })];
    // Simulate two executeSQL (weight 5 each) + one listEntities (weight 1) = 11.
    checkClientRateLimit({
      orgId: "org-alpha",
      clientId: "claude-desktop",
      userId: "user-1",
      toolName: "executeSQL",
    });
    checkClientRateLimit({
      orgId: "org-alpha",
      clientId: "claude-desktop",
      userId: "user-1",
      toolName: "executeSQL",
    });
    checkClientRateLimit({
      orgId: "org-alpha",
      clientId: "claude-desktop",
      userId: "user-1",
      toolName: "listEntities",
    });

    const res = await app.fetch(meRequest("/api/v1/me/mcp-usage"));
    const body = (await res.json()) as {
      clients: Array<{
        clientId: string;
        currentMinuteWeightedRequests: number;
        ceiling: number;
        percentUsed: number;
      }>;
    };
    const entry = body.clients.find((c) => c.clientId === "claude-desktop");
    expect(entry?.currentMinuteWeightedRequests).toBe(11);
    expect(entry?.ceiling).toBe(60);
    // 11 / 60 ≈ 18.33 → 18 (floor) or 19 (round); pin within 1 unit so
    // the test doesn't break under either rounding choice. The important
    // contract is "monotonically tracking the bucket", not the rounding.
    expect(entry?.percentUsed).toBeGreaterThanOrEqual(18);
    expect(entry?.percentUsed).toBeLessThanOrEqual(19);
  });

  it("clamps percentUsed at 100 even if a future limiter change permits over-fill", async () => {
    // Defense for the chip's display contract: a hypothetical regression
    // where the bucket reports 65 against a 60 ceiling would render as
    // "108%" without the clamp. The clamp lives at the route layer so
    // the wire shape is always 0..100; the server cannot return a
    // value the UI couldn't render.
    mockListResult = [
      row({ clientId: "claude-desktop", rateLimitPerMinute: 5 }),
    ];
    setClientRateLimit("org-alpha", "claude-desktop", { requestsPerMinute: 5 });
    // Hand-jam an over-budget state by recording five executeSQL hits of
    // weight 5 each — the limiter's denial path leaves the bucket with
    // exactly the admitted entries, so the only way to *exceed* the
    // ceiling on read would be a future limiter regression. Simulate it
    // by raising the limit, filling, and then lowering: the recorded
    // entries stay (the bucket is filtered by clock, not by ceiling).
    setClientRateLimit("org-alpha", "claude-desktop", { requestsPerMinute: 100 });
    for (let i = 0; i < 20; i++) {
      checkClientRateLimit({
        orgId: "org-alpha",
        clientId: "claude-desktop",
        userId: "user-1",
        toolName: "executeSQL",
      });
    }
    // 20 × 5 = 100 weighted entries in the bucket.
    setClientRateLimit("org-alpha", "claude-desktop", { requestsPerMinute: 5 });

    const res = await app.fetch(meRequest("/api/v1/me/mcp-usage"));
    const body = (await res.json()) as {
      clients: Array<{ percentUsed: number; currentMinuteWeightedRequests: number; ceiling: number }>;
    };
    const entry = body.clients[0];
    // Ceiling is 5; weighted sum is 100 — without clamp this would be 2000.
    expect(entry?.currentMinuteWeightedRequests).toBe(100);
    expect(entry?.ceiling).toBe(5);
    expect(entry?.percentUsed).toBe(100);
  });

  it("emits a single mcp_session.usage_read audit row per call with the peeked clientIds", async () => {
    mockListResult = [
      row({ clientId: "claude-desktop" }),
      row({ clientId: "cursor" }),
    ];

    await app.fetch(meRequest("/api/v1/me/mcp-usage"));
    const usageRows = auditCalls.filter(
      (c) => c.actionType === "mcp_session.usage_read",
    );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]?.metadata?.count).toBe(2);
    expect(usageRows[0]?.metadata?.clientIds).toEqual([
      "claude-desktop",
      "cursor",
    ]);
  });

  it("does NOT emit an audit row when the user has zero clients (low-noise)", async () => {
    mockListResult = [];

    const res = await app.fetch(meRequest("/api/v1/me/mcp-usage"));
    expect(res.status).toBe(200);
    const usageRows = auditCalls.filter(
      (c) => c.actionType === "mcp_session.usage_read",
    );
    expect(usageRows).toHaveLength(0);
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        status: 401,
        error: "Authentication required",
      }),
    );

    const res = await app.fetch(meRequest("/api/v1/me/mcp-usage"));
    expect(res.status).toBe(401);
    expect(listCalls).toHaveLength(0);
  });

  it("returns an empty payload when the user has no active organization", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "user@test.com",
          role: "member",
        },
      }),
    );

    const res = await app.fetch(meRequest("/api/v1/me/mcp-usage"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: unknown[] };
    expect(body.clients).toEqual([]);
    // No DB lookup attempted when there's no org.
    expect(listCalls).toHaveLength(0);
  });

  it("returns 500 with requestId when listOAuthClients throws", async () => {
    mockListThrow = new Error("internal db hiccup");

    const res = await app.fetch(meRequest("/api/v1/me/mcp-usage"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();
  });
});
