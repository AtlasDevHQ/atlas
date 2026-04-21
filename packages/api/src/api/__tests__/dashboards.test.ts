/**
 * Unit tests for the dashboard REST routes.
 *
 * Uses mock.module() pattern from scheduled-tasks.test.ts.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  type Mock,
} from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";

// --- Auth mocks ---

const mockAuthenticateRequest: Mock<
  (req: Request) => Promise<AuthResult>
> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "simple-key" as const,
    user: { id: "u1", label: "test@test.com", mode: "simple-key" as const, role: "admin" as const, activeOrganizationId: "org-1" },
  }),
);

const mockCheckRateLimit: Mock<
  (key: string) => { allowed: boolean; retryAfterMs?: number }
> = mock(() => ({ allowed: true }));

const mockGetClientIP: Mock<(req: Request) => string | null> = mock(
  () => null,
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mockGetClientIP,
}));

// Skip EE IP allowlist check
const { Effect: EffectLib } = await import("effect");
mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: mock(() => EffectLib.succeed({ allowed: true })),
}));

// --- Dashboard CRUD mocks ---

const VALID_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const VALID_CARD_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

const mockDashboardData = {
  id: VALID_ID,
  orgId: "org-1",
  ownerId: "u1",
  title: "Revenue Dashboard",
  description: null,
  shareToken: null,
  shareExpiresAt: null,
  shareMode: "public",
  refreshSchedule: null,
  cardCount: 0,
  createdAt: "2026-04-04T00:00:00.000Z",
  updatedAt: "2026-04-04T00:00:00.000Z",
};

const mockCardData = {
  id: VALID_CARD_ID,
  dashboardId: VALID_ID,
  position: 0,
  title: "Total Revenue",
  sql: "SELECT SUM(amount) FROM orders",
  chartConfig: { type: "bar", categoryColumn: "month", valueColumns: ["total"] },
  cachedColumns: ["month", "total"],
  cachedRows: [{ month: "Jan", total: 1000 }],
  cachedAt: "2026-04-04T00:00:00.000Z",
  connectionId: null,
  createdAt: "2026-04-04T00:00:00.000Z",
  updatedAt: "2026-04-04T00:00:00.000Z",
};

const mockCreateDashboard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: mockDashboardData }),
);
const mockGetDashboard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: { ...mockDashboardData, cards: [] } }),
);
const mockListDashboards = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: { dashboards: [], total: 0 } }),
);
const mockUpdateDashboard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true }),
);
const mockDeleteDashboard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true }),
);
const mockAddCard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: mockCardData }),
);
const mockUpdateCard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true }),
);
const mockRemoveCard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true }),
);
const mockRefreshCard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true }),
);
const mockGetCard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: mockCardData }),
);
const mockShareDashboard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: { token: "share-token-123", expiresAt: null, shareMode: "public" } }),
);
const mockUnshareDashboard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true }),
);
const mockGetShareStatus = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: { shared: false, token: null, expiresAt: null, shareMode: "public" } }),
);
const mockGetSharedDashboard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: false, reason: "not_found" }),
);

mock.module("@atlas/api/lib/dashboards", () => ({
  createDashboard: mockCreateDashboard,
  getDashboard: mockGetDashboard,
  listDashboards: mockListDashboards,
  updateDashboard: mockUpdateDashboard,
  deleteDashboard: mockDeleteDashboard,
  addCard: mockAddCard,
  updateCard: mockUpdateCard,
  removeCard: mockRemoveCard,
  refreshCard: mockRefreshCard,
  getCard: mockGetCard,
  shareDashboard: mockShareDashboard,
  unshareDashboard: mockUnshareDashboard,
  getShareStatus: mockGetShareStatus,
  getSharedDashboard: mockGetSharedDashboard,
  setRefreshSchedule: mock(() => Promise.resolve({ ok: true })),
  getDashboardsDueForRefresh: mock(() => Promise.resolve([])),
  lockDashboardForRefresh: mock(() => Promise.resolve(false)),
  refreshDashboardCards: mock(() => Promise.resolve({ refreshed: 0, failed: 0, total: 0 })),
}));

// --- Other mocks required by app index.ts ---

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    }),
  ),
}));

mock.module("@atlas/api/lib/conversations", () => ({
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  getConversation: mock(() => Promise.resolve(null)),
  deleteConversation: mock(() => Promise.resolve(false)),
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  persistAssistantSteps: mock(() => {}),
  generateTitle: mock(() => "Test title"),
  starConversation: async () => false,
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  convertToNotebook: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  deleteBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  renameBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(),
  _resetWhitelists: () => {},
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
}));

mock.module("@atlas/api/lib/tools/sql", () => ({
  validateSQL: mock(() => ({ valid: true, classification: { type: "select" } })),
  extractClassification: mock(() => ({ type: "select" })),
  parserDatabase: mock(() => "PostgreSQL"),
  executeSQL: {},
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: () => [],
}));

mock.module("@atlas/api/lib/scheduler/engine", () => ({
  triggerTask: mock(() => Promise.resolve()),
  runTick: mock(() => Promise.resolve({ tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0 })),
  getScheduler: () => ({ start: () => {}, stop: () => {}, isRunning: () => false }),
  _resetScheduler: () => {},
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: mock(() => ({})),
  loadConfig: mock(() => Promise.resolve({})),
  configFromEnv: mock(() => ({})),
  initializeConfig: mock(() => Promise.resolve({})),
  _resetConfig: () => {},
}));

import { createConnectionMock } from "@atlas/api/testing/connection";
mock.module("@atlas/api/lib/db/connection", () => createConnectionMock());

// Import after all mocks
const { app } = await import("../index");

describe("dashboard routes", () => {
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "simple-key" as const,
      user: { id: "u1", label: "test@test.com", mode: "simple-key" as const, role: "admin" as const, activeOrganizationId: "org-1" },
    });
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockGetClientIP.mockReset();
    mockGetClientIP.mockReturnValue(null);

    // Reset dashboard mocks
    mockCreateDashboard.mockReset();
    mockCreateDashboard.mockResolvedValue({ ok: true, data: mockDashboardData });
    mockGetDashboard.mockReset();
    mockGetDashboard.mockResolvedValue({ ok: true, data: { ...mockDashboardData, cards: [] } });
    mockListDashboards.mockReset();
    mockListDashboards.mockResolvedValue({ ok: true, data: { dashboards: [], total: 0 } });
    mockUpdateDashboard.mockReset();
    mockUpdateDashboard.mockResolvedValue({ ok: true });
    mockDeleteDashboard.mockReset();
    mockDeleteDashboard.mockResolvedValue({ ok: true });
    mockAddCard.mockReset();
    mockAddCard.mockResolvedValue({ ok: true, data: mockCardData });
    mockUpdateCard.mockReset();
    mockUpdateCard.mockResolvedValue({ ok: true });
    mockRemoveCard.mockReset();
    mockRemoveCard.mockResolvedValue({ ok: true });
    mockRefreshCard.mockReset();
    mockRefreshCard.mockResolvedValue({ ok: true });
    mockGetCard.mockReset();
    mockGetCard.mockResolvedValue({ ok: true, data: mockCardData });
    mockShareDashboard.mockReset();
    mockShareDashboard.mockResolvedValue({ ok: true, data: { token: "share-token-123", expiresAt: null, shareMode: "public" } });
    mockUnshareDashboard.mockReset();
    mockUnshareDashboard.mockResolvedValue({ ok: true });
    mockGetShareStatus.mockReset();
    mockGetShareStatus.mockResolvedValue({ ok: true, data: { shared: false, token: null, expiresAt: null, shareMode: "public" } });
    mockGetSharedDashboard.mockReset();
    mockGetSharedDashboard.mockResolvedValue({ ok: false, reason: "not_found" });
  });

  afterEach(() => {
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/dashboards
  // -------------------------------------------------------------------------

  describe("GET /api/v1/dashboards", () => {
    it("returns 200 with dashboard list", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/dashboards"),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dashboards: unknown[]; total: number };
      expect(body.dashboards).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns 401 when unauthenticated", async () => {
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: false as const,
        mode: "simple-key" as const,
        status: 401 as const,
        error: "API key required",
      });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/dashboards"),
      );
      expect(response.status).toBe(401);
    });

    it("returns 429 when rate limited", async () => {
      mockCheckRateLimit.mockReturnValueOnce({
        allowed: false,
        retryAfterMs: 30000,
      });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/dashboards"),
      );
      expect(response.status).toBe(429);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/dashboards
  // -------------------------------------------------------------------------

  describe("POST /api/v1/dashboards", () => {
    it("returns 201 on valid create", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/dashboards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Revenue Dashboard" }),
        }),
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.title).toBe("Revenue Dashboard");
    });

    it("returns 422 for missing title", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/dashboards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(response.status).toBe(422);
    });

    it("returns 404 when no internal DB", async () => {
      mockCreateDashboard.mockResolvedValueOnce({ ok: false, reason: "no_db" });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/dashboards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Test" }),
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/dashboards/:id
  // -------------------------------------------------------------------------

  describe("GET /api/v1/dashboards/:id", () => {
    it("returns 200 with dashboard and cards", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { cards: unknown[] };
      expect(body.cards).toEqual([]);
    });

    it("returns 400 for invalid UUID", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/dashboards/not-a-uuid"),
      );
      expect(response.status).toBe(400);
    });

    it("returns 404 when not found", async () => {
      mockGetDashboard.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/dashboards/:id
  // -------------------------------------------------------------------------

  describe("PATCH /api/v1/dashboards/:id", () => {
    it("returns 200 on valid update", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Updated Title" }),
        }),
      );
      expect(response.status).toBe(200);
    });

    it("returns 404 when not found", async () => {
      mockUpdateDashboard.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "New Title" }),
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/dashboards/:id
  // -------------------------------------------------------------------------

  describe("DELETE /api/v1/dashboards/:id", () => {
    it("returns 204 on successful delete", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);
    });

    it("returns 404 when not found", async () => {
      mockDeleteDashboard.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/dashboards/:id/cards — add card
  // -------------------------------------------------------------------------

  describe("POST /api/v1/dashboards/:id/cards", () => {
    it("returns 201 on valid card add", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Total Revenue",
            sql: "SELECT SUM(amount) FROM orders",
            chartConfig: { type: "bar", categoryColumn: "month", valueColumns: ["total"] },
          }),
        }),
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.title).toBe("Total Revenue");
    });

    it("returns 422 for missing sql", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Test" }),
        }),
      );
      expect(response.status).toBe(422);
    });

    it("returns 404 when dashboard not found", async () => {
      mockGetDashboard.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Test",
            sql: "SELECT 1",
          }),
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/dashboards/:id/cards/:cardId — update card
  // -------------------------------------------------------------------------

  describe("PATCH /api/v1/dashboards/:id/cards/:cardId", () => {
    it("returns 200 on valid update", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Updated Card" }),
        }),
      );
      expect(response.status).toBe(200);
    });

    it("returns 404 when card not found", async () => {
      mockUpdateCard.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Updated" }),
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/dashboards/:id/cards/:cardId — remove card
  // -------------------------------------------------------------------------

  describe("DELETE /api/v1/dashboards/:id/cards/:cardId", () => {
    it("returns 204 on successful remove", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/dashboards/:id/cards/:cardId/refresh — refresh card
  // -------------------------------------------------------------------------

  describe("POST /api/v1/dashboards/:id/cards/:cardId/refresh", () => {
    it("returns 200 after refreshing card", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/refresh`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
    });

    it("returns 404 when card not found", async () => {
      mockGetCard.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/refresh`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/dashboards/:id/refresh — refresh all cards
  // -------------------------------------------------------------------------

  describe("POST /api/v1/dashboards/:id/refresh", () => {
    it("returns 200 with refresh summary", async () => {
      mockGetDashboard.mockResolvedValueOnce({
        ok: true,
        data: { ...mockDashboardData, cards: [mockCardData] },
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/refresh`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { refreshed: number; failed: number; total: number };
      expect(body.total).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Share / Unshare
  // -------------------------------------------------------------------------

  describe("POST /api/v1/dashboards/:id/share", () => {
    it("returns 200 with share token", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { token: string };
      expect(body.token).toBe("share-token-123");
    });

    // Regression for #1737 — the DB CHECK (chk_org_scoped_share, 0034)
    // forbids share_mode='org' with org_id=NULL, but the route should
    // return a structured 400 instead of surfacing a Postgres error when
    // shareDashboard reports `invalid_org_scope`.
    it("returns 400 when shareDashboard reports invalid_org_scope (#1737)", async () => {
      mockShareDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "invalid_org_scope",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shareMode: "org" }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_request");
      expect(body.message).toContain("no organization");
    });
  });

  describe("DELETE /api/v1/dashboards/:id/share", () => {
    it("returns 204 on unshare", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/share`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);
    });
  });

  describe("GET /api/v1/dashboards/:id/share", () => {
    it("returns 200 with share status", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/share`),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { shared: boolean };
      expect(body.shared).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Public shared endpoint
  // -------------------------------------------------------------------------

  describe("GET /api/public/dashboards/:token", () => {
    it("returns 404 when not found", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/public/dashboards/abc123def456ghi789jkl"),
      );
      expect(response.status).toBe(404);
    });

    it("returns 200 when shared dashboard exists", async () => {
      mockGetSharedDashboard.mockResolvedValueOnce({
        ok: true,
        data: {
          ...mockDashboardData,
          cards: [mockCardData],
          shareMode: "public",
        },
      });
      const response = await app.fetch(
        new Request("http://localhost/api/public/dashboards/abc123def456ghi789jkl"),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { title: string; cards: unknown[] };
      expect(body.title).toBe("Revenue Dashboard");
      expect(body.cards).toHaveLength(1);
    });

    it("returns 410 when share is expired", async () => {
      mockGetSharedDashboard.mockResolvedValueOnce({ ok: false, reason: "expired" });
      const response = await app.fetch(
        new Request("http://localhost/api/public/dashboards/abc123def456ghi789jkl"),
      );
      expect(response.status).toBe(410);
    });

    it("returns 404 for invalid token format", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/public/dashboards/short"),
      );
      expect(response.status).toBe(404);
    });

    // -----------------------------------------------------------------------
    // Org-scoped share regression tests (#1736 — F-01 class fail-open)
    //
    // Mirror the conversations.ts regression set from PR #1738: before the
    // fix, the route used a truthy-check (`result.data.orgId && ...`) that
    // short-circuited when the row had `orgId=null`, letting any authenticated
    // caller from any org read org-scoped dashboards. These pin the four
    // attack cases plus the positive control.
    // -----------------------------------------------------------------------

    it("returns 403 auth_required for org-scoped shares when unauthenticated (#1736)", async () => {
      mockGetSharedDashboard.mockResolvedValueOnce({
        ok: true,
        data: {
          ...mockDashboardData,
          orgId: "org-A",
          cards: [mockCardData],
          shareMode: "org",
        },
      });
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: false as const,
        mode: "simple-key" as const,
        status: 401,
        error: "no_credentials",
      });

      const response = await app.fetch(
        new Request("http://localhost/api/public/dashboards/abc123def456ghi789jkl"),
      );
      expect(response.status).toBe(403);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("auth_required");
      expect(body).not.toHaveProperty("cards");
      expect(body).not.toHaveProperty("title");
    });

    it("returns 403 forbidden for org-scoped shares when requester has no active org (#1736)", async () => {
      mockGetSharedDashboard.mockResolvedValueOnce({
        ok: true,
        data: {
          ...mockDashboardData,
          orgId: "org-A",
          cards: [mockCardData],
          shareMode: "org",
        },
      });
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: true as const,
        mode: "simple-key" as const,
        // No activeOrganizationId — freshly signed-up user with zero memberships
        user: { id: "u-orphan", label: "no-org@test.com", mode: "simple-key" as const, role: "member" as const },
      });

      const response = await app.fetch(
        new Request("http://localhost/api/public/dashboards/abc123def456ghi789jkl"),
      );
      expect(response.status).toBe(403);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden");
      expect(body).not.toHaveProperty("cards");
      expect(body).not.toHaveProperty("title");
    });

    it("returns 403 forbidden for org-scoped shares when requester belongs to a different org (#1736)", async () => {
      mockGetSharedDashboard.mockResolvedValueOnce({
        ok: true,
        data: {
          ...mockDashboardData,
          orgId: "org-A",
          cards: [mockCardData],
          shareMode: "org",
        },
      });
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: true as const,
        mode: "simple-key" as const,
        user: {
          id: "u-other",
          label: "other-org-user@test.com",
          mode: "simple-key" as const,
          role: "member" as const,
          activeOrganizationId: "org-B",
        },
      });

      const response = await app.fetch(
        new Request("http://localhost/api/public/dashboards/abc123def456ghi789jkl"),
      );
      expect(response.status).toBe(403);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden");
      expect(body).not.toHaveProperty("cards");
      expect(body).not.toHaveProperty("title");
    });

    it("returns 200 for org-scoped shares when requester belongs to the dashboard's org (#1736)", async () => {
      mockGetSharedDashboard.mockResolvedValueOnce({
        ok: true,
        data: {
          ...mockDashboardData,
          orgId: "org-A",
          cards: [mockCardData],
          shareMode: "org",
        },
      });
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: true as const,
        mode: "simple-key" as const,
        user: {
          id: "u-member",
          label: "org-a-member@test.com",
          mode: "simple-key" as const,
          role: "member" as const,
          activeOrganizationId: "org-A",
        },
      });

      const response = await app.fetch(
        new Request("http://localhost/api/public/dashboards/abc123def456ghi789jkl"),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as { title: string; cards: unknown[]; shareMode: string };
      expect(body.shareMode).toBe("org");
      expect(body.title).toBe("Revenue Dashboard");
      expect(body.cards).toHaveLength(1);
    });

    // Fail-closed regression for #1736 — the schema allows share_mode='org'
    // with org_id=NULL (createShareLink does not stamp orgId). Without a
    // fail-closed check, any authenticated caller could read such a row.
    it("returns 403 for org-scoped shares when the dashboard has no orgId (#1736)", async () => {
      mockGetSharedDashboard.mockResolvedValueOnce({
        ok: true,
        data: {
          ...mockDashboardData,
          orgId: null,
          cards: [mockCardData],
          shareMode: "org",
        },
      });
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: true as const,
        mode: "simple-key" as const,
        user: {
          id: "u-any",
          label: "any-user@test.com",
          mode: "simple-key" as const,
          role: "member" as const,
          activeOrganizationId: "org-A",
        },
      });

      const response = await app.fetch(
        new Request("http://localhost/api/public/dashboards/abc123def456ghi789jkl"),
      );
      expect(response.status).toBe(403);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden");
      expect(body).not.toHaveProperty("cards");
      expect(body).not.toHaveProperty("title");
    });
  });
});
