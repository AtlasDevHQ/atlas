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
import { createHash } from "node:crypto";

// --- Logger mock (captures calls for #1743 redaction assertions) ---

type CapturedLog = { level: string; obj: Record<string, unknown>; msg: string };
const capturedLogs: CapturedLog[] = [];

function makeCapturingFn(level: string) {
  return (...args: unknown[]) => {
    const [first, second] = args;
    if (typeof first === "object" && first !== null) {
      capturedLogs.push({
        level,
        obj: first as Record<string, unknown>,
        msg: typeof second === "string" ? second : "",
      });
    } else {
      capturedLogs.push({
        level,
        obj: {},
        msg: typeof first === "string" ? first : "",
      });
    }
  };
}

const capturingLogger = {
  info: makeCapturingFn("info"),
  warn: makeCapturingFn("warn"),
  error: makeCapturingFn("error"),
  debug: makeCapturingFn("debug"),
  trace: makeCapturingFn("trace"),
  fatal: makeCapturingFn("fatal"),
  child: () => capturingLogger,
  level: "info",
  bindings: () => ({}),
};

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => capturingLogger,
  getLogger: () => capturingLogger,
  withRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [] as string[],
  setLogLevel: () => true,
  hashShareToken: (token: string) =>
    createHash("sha256").update(token).digest("hex").slice(0, 16),
}));

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

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mockGetClientIP,
}));

// Skip EE IP allowlist check
const { Effect: EffectLib } = await import("effect");
void mock.module("@atlas/ee/auth/ip-allowlist", () => ({
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
  parameters: [],
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
  connectionGroupId: null,
  createdAt: "2026-04-04T00:00:00.000Z",
  updatedAt: "2026-04-04T00:00:00.000Z",
};

// #3138 — a text / section-block card: no SQL, no chart, markdown `content`.
const mockTextCardData = {
  ...mockCardData,
  id: "00000000-0000-0000-0000-0000000000aa",
  title: "Top of funnel",
  kind: "text",
  sql: "",
  chartConfig: null,
  content: "## Top of funnel",
  cachedColumns: null,
  cachedRows: null,
  cachedAt: null,
};

// #4316 — a card as it appears in the PROJECTED shared-view DTO: no `sql`, no
// internal ids (`connectionGroupId`, `dashboardId`). Mirrors the output of
// `projectSharedDashboardView` in the lib (which is mocked here). The lib's own
// projection unit test proves the stripping against a full card; this fixture
// lets the route tests assert the route serializes the projection untouched.
const mockSharedCardData = {
  id: VALID_CARD_ID,
  position: 0,
  title: "Total Revenue",
  kind: "chart" as const,
  chartConfig: { type: "bar", categoryColumn: "month", valueColumns: ["total"] },
  content: null,
  annotations: [],
  cachedColumns: ["month", "total"],
  cachedRows: [{ month: "Jan", total: 1000 }],
  cachedAt: "2026-04-04T00:00:00.000Z",
  layout: null,
};

// Build the `{ ok: true, view, access }` shape `getSharedDashboard` now returns
// (#4316). `view` is the data-only snapshot the route serializes; `access`
// carries the internal `orgId` the route gates on but never emits.
function sharedViewResult(opts: {
  orgId?: string | null;
  shareMode?: "public" | "org";
  cards?: Array<Record<string, unknown>>;
  parameterSummary?: Array<{ label: string; displayValue: string }>;
} = {}) {
  const shareMode = opts.shareMode ?? "public";
  return {
    ok: true as const,
    view: {
      title: mockDashboardData.title,
      description: mockDashboardData.description,
      shareMode,
      cards: opts.cards ?? [mockSharedCardData],
      parameterSummary: opts.parameterSummary ?? [],
      createdAt: mockDashboardData.createdAt,
      updatedAt: mockDashboardData.updatedAt,
      lastRefreshAt: null,
    },
    access: { shareMode, orgId: opts.orgId ?? null },
  };
}

const mockCreateDashboard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: mockDashboardData }),
);
const mockGetDashboard = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: { ...mockDashboardData, cards: [] } }),
);
const mockListDashboards = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: { dashboards: [], total: 0 } }),
);
const mockUpdateDashboard = mock((..._args: unknown[]): Promise<unknown> =>
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
const mockShareDashboard = mock((..._args: unknown[]): Promise<unknown> =>
  Promise.resolve({ ok: true, data: { token: "share-token-123", expiresAt: null, shareMode: "public", rotated: false } }),
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
// #4537 — captured so tests can assert the caller's viewerId is threaded into
// the write-side gate (the PATCH refresh-schedule path).
const mockSetRefreshSchedule = mock((..._args: unknown[]): Promise<unknown> =>
  Promise.resolve({ ok: true }),
);

// #2424 — captured so individual tests can override with
// `mockResolvedValueOnce("not_found")` to exercise the 400 reject path.
const mockVerifyGroupBelongsToOrg = mock(
  (): Promise<"ok" | "not_found" | "no_db" | "error"> => Promise.resolve("ok"),
);

// #4325 — captured so the publish-route test can assert the async refresh is
// enqueued with the right ids (and exercise the fire-and-forget .catch path).
const mockRefreshDashboardCards = mock(
  (..._args: unknown[]): Promise<{ refreshed: number; failed: number; total: number }> =>
    Promise.resolve({ refreshed: 0, failed: 0, total: 0 }),
);

// Re-import the real CardLayoutSchema + rowToCard so the mock is otherwise complete
// per CLAUDE.md ("Mock all exports — partial mocks cause SyntaxError").
const realDashboards = await import("@atlas/api/lib/dashboards");

void mock.module("@atlas/api/lib/dashboards", () => ({
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
  // #4316 — the route imports neither directly (both run inside the mocked
  // getSharedDashboard), but mock ALL exports so a future direct call resolves
  // to the real projection, not undefined (CLAUDE.md mock-all-exports rule).
  projectSharedDashboardView: realDashboards.projectSharedDashboardView,
  buildSharedParameterSummary: realDashboards.buildSharedParameterSummary,
  resolveSharedSnapshotInstant: realDashboards.resolveSharedSnapshotInstant,
  resolveSharedDataInstant: realDashboards.resolveSharedDataInstant,
  setRefreshSchedule: mockSetRefreshSchedule,
  getDashboardsDueForRefresh: mock(() => Promise.resolve([])),
  lockDashboardForRefresh: mock(() => Promise.resolve(false)),
  refreshDashboardCards: mockRefreshDashboardCards,
  // #4325 — real versioning's rebaseDraft/publishDraft resolve this from the
  // (mocked) dashboards module; export it so a real path never hits undefined.
  loadDashboardUpdatedAtPrecise: mock(() =>
    Promise.resolve({ ok: true as const, updatedAt: "2026-05-17T00:00:00.000000+00" }),
  ),
  CardLayoutSchema: realDashboards.CardLayoutSchema,
  rowToCard: realDashboards.rowToCard,
}));

// #4315 — versioning mock. Keep everything REAL except the two DB-touching
// seams the direct-manipulation + draft-aware-execution routes call
// (`applyEditToDraft`, `loadDraft`). Drafts are unconditional (#4324), so the
// caller's userId drives routing: the direct-CRUD describes authenticate with
// an empty userId (published path, these spies never fire), the draft-first
// describe authenticates with a real userId.
const realVersioning = await import("@atlas/api/lib/dashboard-versioning");
type ApplyEditResult = import("@atlas/api/lib/dashboard-versioning").ApplyEditToDraftResult;
type DraftRowT = import("@atlas/api/lib/dashboard-versioning").DraftRow;
const mockApplyEditToDraft = mock(
  (..._args: unknown[]): Promise<ApplyEditResult> =>
    Promise.resolve({ ok: false, reason: "no_db" }),
);
const mockLoadDraft = mock(
  (..._args: unknown[]): Promise<DraftRowT | null> => Promise.resolve(null),
);
// #4554 — controllable fork for the GET /:id/draft route test (the real one
// opens a pg pool; a route-wiring test only needs the returned row).
const mockForkOrLoadDraft = mock(
  (..._args: unknown[]): Promise<DraftRowT | null> => Promise.resolve(null),
);
// #4325 — controllable publish so the route test can assert it returns
// `refreshingCardIds` and enqueues the async refresh (the real publishDraft
// opens a transaction, out of scope for a route-wiring test).
type PublishResultT = import("@atlas/api/lib/dashboard-versioning").PublishDraftResult;
const mockPublishDraft = mock(
  (..._args: unknown[]): Promise<PublishResultT> =>
    Promise.resolve({ ok: true, opsApplied: 1, refreshCardIds: [] }),
);
void mock.module("@atlas/api/lib/dashboard-versioning", () => ({
  ...realVersioning,
  applyEditToDraft: mockApplyEditToDraft,
  loadDraft: mockLoadDraft,
  forkOrLoadDraft: mockForkOrLoadDraft,
  publishDraft: mockPublishDraft,
}));

// #4554 — the draft-cache seam (ADR-0034 Decision 1). Controllable so the
// draft-aware refresh tests can assert the persist call + simulate failures,
// and the ?view=draft read tests can hand the route a populated cache.
type DraftCacheMapT = import("@atlas/api/lib/dashboard-draft-cache").DraftCardCacheMap;
type SaveDraftCacheResultT = import("@atlas/api/lib/dashboard-draft-cache").SaveDraftCardCacheResult;
const mockLoadDraftCardCache = mock(
  (..._args: unknown[]): Promise<DraftCacheMapT> => Promise.resolve(new Map()),
);
const mockSaveDraftCardCache = mock(
  (..._args: unknown[]): Promise<SaveDraftCacheResultT> =>
    Promise.resolve({ ok: true, cachedAt: "2026-07-16T00:00:00.000Z" }),
);
const mockSeedDraftCardCacheFromPublished = mock(
  (..._args: unknown[]): Promise<void> => Promise.resolve(),
);
void mock.module("@atlas/api/lib/dashboard-draft-cache", () => ({
  loadDraftCardCache: mockLoadDraftCardCache,
  saveDraftCardCache: mockSaveDraftCardCache,
  seedDraftCardCacheFromPublished: mockSeedDraftCardCacheFromPublished,
  EMPTY_DRAFT_CARD_CACHE: new Map(),
}));

// #2368 — bound-chat-context mocks for the new sessions endpoints.
// Real module exports must stay surface-complete (CLAUDE.md "Mock all
// exports — partial mocks cause SyntaxError"); copy the unmocked ones
// from the real module.
const realBoundChatContext = await import("@atlas/api/lib/bound-chat-context");

const mockListSessionsForDashboard = mock(
  (): Promise<import("@atlas/api/lib/bound-chat-context").BoundSessionSummary[]> =>
    Promise.resolve([]),
);

const mockGetSessionTranscript = mock(
  (): Promise<import("@atlas/api/lib/bound-chat-context").SessionTranscriptResult> =>
    Promise.resolve({ ok: false, reason: "not_found" }),
);

void mock.module("@atlas/api/lib/bound-chat-context", () => ({
  bindConversationToDashboard: realBoundChatContext.bindConversationToDashboard,
  resolveBoundDashboard: realBoundChatContext.resolveBoundDashboard,
  listSessionsForDashboard: mockListSessionsForDashboard,
  getSessionTranscript: mockGetSessionTranscript,
  buildCardSummary: realBoundChatContext.buildCardSummary,
  BOUND_AGENT_PROMPT_GUIDANCE: realBoundChatContext.BOUND_AGENT_PROMPT_GUIDANCE,
}));

// #2367 — screenshot pipeline mocks for the new route. Mock surface-complete
// (CLAUDE.md "Mock all exports") and let individual tests override per case.
type ScreenshotOptsMock = {
  dashboardId: string;
  userId: string;
  orgId: string | null | undefined;
  cookieHeader?: string | null;
};
const mockScreenshotDashboard = mock(
  (
    _opts: ScreenshotOptsMock,
  ): Promise<import("@atlas/api/lib/dashboard-screenshot").ScreenshotResult> =>
    Promise.resolve({
      ok: true as const,
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
      cached: false,
      durationMs: 7,
    }),
);
// #3211 — whole-dashboard export pipeline mock. Surface-complete; individual
// tests override `mockExportDashboard` per case.
type ExportOptsMock = {
  dashboardId: string;
  userId: string;
  orgId: string | null | undefined;
  format: "png" | "pdf";
  parameters?: Record<string, string | number | null> | null;
  cookieHeader?: string | null;
};
const mockExportDashboard = mock(
  (
    opts: ExportOptsMock,
  ): Promise<import("@atlas/api/lib/dashboard-screenshot").ExportResult> =>
    Promise.resolve(
      opts.format === "png"
        ? {
            ok: true as const,
            format: "png" as const,
            bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
            contentType: "image/png",
            filename: "revenue-overview-20260604-120000.png",
            title: "Revenue overview",
            partial: false,
            durationMs: 9,
          }
        : {
            ok: true as const,
            format: "pdf" as const,
            bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]), // "%PDF-"
            contentType: "application/pdf",
            filename: "revenue-overview-20260604-120000.pdf",
            title: "Revenue overview",
            partial: false,
            durationMs: 12,
          },
    ),
);
void mock.module("@atlas/api/lib/dashboard-screenshot", () => ({
  screenshotDashboard: mockScreenshotDashboard,
  exportDashboard: mockExportDashboard,
  invalidateDashboardScreenshot: () => {},
  closeScreenshotBrowser: async () => {},
  buildExportFilename: (title: string, format: "png" | "pdf") => `${title}.${format}`,
  _resetScreenshotCache: () => {},
  _screenshotCacheSize: () => 0,
  _setRenderFn: () => {},
  _setExportRenderFn: () => {},
}));

// --- Other mocks required by app index.ts ---

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    }),
  ),
}));

void mock.module("@atlas/api/lib/conversations", () => ({
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
  // F-77 step-cap helpers — chat.ts imports both via the shared module.
  reserveConversationBudget: mock(() => Promise.resolve({ status: "ok" as const, totalStepsBefore: 0 })),
  settleConversationSteps: mock(() => {}),
  resolveGroupForConnection: mock(() => Promise.resolve(null)),
  verifyGroupBelongsToOrg: mockVerifyGroupBelongsToOrg,
  updateConversationRoutingMode: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationRestExcluded: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationRestFocus: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationGroupReach: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationAnswerStyle: mock(() => Promise.resolve({ ok: true as const })),
  resolveRoutingMode: mock((m: "auto" | "pin" | "all" | null | undefined = null) => m ?? "pin"),
}));

void mock.module("@atlas/api/lib/semantic", () => ({
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

void mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
}));

type UserQueryOutcomeMock = import("@atlas/api/lib/tools/sql").UserQueryOutcome;
const mockRunUserQueryPipeline: Mock<(opts: { sql: string; connectionId?: string; explanation: string; parameters?: Record<string, string | number | null> }) => Promise<UserQueryOutcomeMock>> = mock(
  async () =>
    ({
      kind: "ok" as const,
      columns: ["month", "total"],
      rows: [{ month: "Jan", total: 1000 }],
      rowCount: 1,
      executionMs: 5,
      truncated: false,
      maskingApplied: false,
    }) as UserQueryOutcomeMock,
);

void mock.module("@atlas/api/lib/tools/sql", () => ({
  validateSQL: mock(async () => ({ valid: true, classification: { type: "select" } })),
  extractClassification: mock(() => ({ type: "select" })),
  parserDatabase: mock(() => "PostgreSQL"),
  executeSQL: {},
  runUserQueryPipeline: mockRunUserQueryPipeline,
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

void mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: () => [],
}));

void mock.module("@atlas/api/lib/scheduler/engine", () => ({
  triggerTask: mock(() => Promise.resolve()),
  runTick: mock(() => Promise.resolve({ tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0 })),
  getScheduler: () => ({ start: () => {}, stop: () => {}, isRunning: () => false }),
  _resetScheduler: () => {},
}));

void mock.module("@atlas/api/lib/config", () => ({
  getConfig: mock(() => ({})),
  loadConfig: mock(() => Promise.resolve({})),
  configFromEnv: mock(() => ({})),
  initializeConfig: mock(() => Promise.resolve({})),
  _resetConfig: () => {},
}));

import { createConnectionMock } from "@atlas/api/testing/connection";
// #4318 — controllable so the preview-card org-check tests can force a
// connection out of the caller's org (returns false → route 403s).
const mockIsConnectionVisibleInMode = mock(
  (..._args: unknown[]): Promise<boolean> => Promise.resolve(true),
);
void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({ isConnectionVisibleInMode: mockIsConnectionVisibleInMode }),
);

// Import after all mocks. The dynamic import avoids hoisting routes/dashboards.ts
// past the mock.module() calls — a static `import` would load the module before
// the logger mock applies, leaving the public-rate-limit warn going through
// real pino and the route logs uncaptured.
const { app } = await import("../index");
// Reset the public-share rate limiter between tests so the new shared
// anonymous-bucket ceiling (F-73) does not exhaust across the suite.
const { _resetDashboardRateLimit, PUBLIC_RATE_MAX } = await import("../routes/dashboards");

describe("dashboard routes", () => {
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    // Drafts are UNCONDITIONAL (#4324). An authenticated (userId-carrying)
    // caller routes direct-manipulation CRUD edits to the per-user draft —
    // covered by the `draft-first routing (#4315)` describe below. The
    // direct-published CRUD-forwarding + validation contract is the DEFENSIVE
    // no-userId fall-through in `shouldRouteToDraft` (an `auth: none` single
    // operator); the CRUD-mutation describes below opt into that via
    // `directCrudAuth()`. This default auth carries a real userId (screenshot /
    // export / sessions need one).
    capturedLogs.length = 0;
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
    _resetDashboardRateLimit();

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
    mockApplyEditToDraft.mockReset();
    mockApplyEditToDraft.mockResolvedValue({ ok: false, reason: "no_db" });
    mockLoadDraft.mockReset();
    mockLoadDraft.mockResolvedValue(null);
    mockForkOrLoadDraft.mockReset();
    mockForkOrLoadDraft.mockResolvedValue(null);
    mockLoadDraftCardCache.mockReset();
    mockLoadDraftCardCache.mockResolvedValue(new Map());
    mockSaveDraftCardCache.mockReset();
    mockSaveDraftCardCache.mockResolvedValue({ ok: true, cachedAt: "2026-07-16T00:00:00.000Z" });
    mockSeedDraftCardCacheFromPublished.mockReset();
    mockSeedDraftCardCacheFromPublished.mockResolvedValue(undefined);
    mockShareDashboard.mockReset();
    mockShareDashboard.mockResolvedValue({ ok: true, data: { token: "share-token-123", expiresAt: null, shareMode: "public", rotated: false } });
    mockUnshareDashboard.mockReset();
    mockUnshareDashboard.mockResolvedValue({ ok: true });
    mockGetShareStatus.mockReset();
    mockGetShareStatus.mockResolvedValue({ ok: true, data: { shared: false, token: null, expiresAt: null, shareMode: "public" } });
    mockGetSharedDashboard.mockReset();
    mockGetSharedDashboard.mockResolvedValue({ ok: false, reason: "not_found" });
    mockSetRefreshSchedule.mockReset();
    mockSetRefreshSchedule.mockResolvedValue({ ok: true });
    mockRunUserQueryPipeline.mockReset();
    mockRunUserQueryPipeline.mockResolvedValue({
      kind: "ok",
      columns: ["month", "total"],
      rows: [{ month: "Jan", total: 1000 }],
      rowCount: 1,
      executionMs: 5,
      truncated: false,
      maskingApplied: false,
    });
    // #4318 — default: every connection is in the caller's org (visible).
    mockIsConnectionVisibleInMode.mockReset();
    mockIsConnectionVisibleInMode.mockResolvedValue(true);
    mockListSessionsForDashboard.mockReset();
    mockListSessionsForDashboard.mockResolvedValue([]);
    mockGetSessionTranscript.mockReset();
    mockGetSessionTranscript.mockResolvedValue({ ok: false, reason: "not_found" });
  });

  afterEach(() => {
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  // Drafts are unconditional (#4324), so a direct-manipulation CRUD edit only
  // hits the published helpers on the DEFENSIVE no-userId path (`auth: none`
  // single operator). The CRUD-mutation describes below opt into that path by
  // authenticating with an empty user id (`shouldRouteToDraft` → false), so
  // they keep asserting the direct-published forwarding + validation contract.
  // The userId-carrying (draft-routed) behavior is covered separately by the
  // `draft-first routing (#4315)` describe.
  function directCrudAuth() {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "simple-key" as const,
      user: { id: "", label: "operator", mode: "simple-key" as const, role: "admin" as const, activeOrganizationId: "org-1" },
    });
  }

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
    beforeEach(directCrudAuth);
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

    it("threads the caller's viewerId into the parameter + schedule writes (#4537)", async () => {
      // The write-side first-publish gate lives in the lib SQL; the route's
      // contribution is passing the acting identity through. Without it a
      // same-org non-owner could write to a colleague's never-published board.
      mockAuthenticateRequest.mockResolvedValue({
        authenticated: true as const,
        mode: "simple-key" as const,
        user: { id: "u1", label: "test@test.com", mode: "simple-key" as const, role: "admin" as const, activeOrganizationId: "org-1" },
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parameters: [{ key: "date_from", type: "date", default: null, label: "From" }],
            refreshSchedule: "0 * * * *",
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(mockSetRefreshSchedule).toHaveBeenCalledTimes(1);
      expect(mockSetRefreshSchedule.mock.calls[0]?.[1]).toEqual({ orgId: "org-1", viewerId: "u1" });
      expect(mockUpdateDashboard).toHaveBeenCalledTimes(1);
      expect(mockUpdateDashboard.mock.calls[0]?.[1]).toEqual({ orgId: "org-1", viewerId: "u1" });
    });

    it("rejects a parameter update that orphans a card's placeholder (#2267)", async () => {
      const cardWithParam = { ...mockCardData, sql: "SELECT * FROM orders WHERE created_at >= :date_from" };
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: { ...mockDashboardData, cards: [cardWithParam] } });
      mockUpdateDashboard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: [] }), // removes :date_from
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_parameters");
      expect(body.message).toContain(":date_from");
      expect(mockUpdateDashboard).not.toHaveBeenCalled();
    });

    it("fails the PATCH with requestId when the orphan-guard pre-read errors — never writes parameters blind (#4539)", async () => {
      // A transient getDashboard failure must NOT skip the guard and fall
      // through to the write: that can drop a :placeholder a card still
      // references, 400-ing every subsequent render.
      mockGetDashboard.mockResolvedValueOnce({ ok: false, reason: "error" });
      mockUpdateDashboard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: [] }),
        }),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("internal_error");
      expect(typeof body.requestId).toBe("string");
      expect(mockUpdateDashboard).not.toHaveBeenCalled();
    });

    it("maps a not_found pre-read to 404 without writing parameters (#4539)", async () => {
      mockGetDashboard.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      mockUpdateDashboard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: [] }),
        }),
      );
      expect(response.status).toBe(404);
      expect(mockUpdateDashboard).not.toHaveBeenCalled();
    });

    it("allows a parameter update that still declares all card placeholders", async () => {
      const cardWithParam = { ...mockCardData, sql: "SELECT * FROM orders WHERE created_at >= :date_from" };
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: { ...mockDashboardData, cards: [cardWithParam] } });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parameters: [{ key: "date_from", type: "date", default: "now - 30 days", label: "From" }],
          }),
        }),
      );
      expect(response.status).toBe(200);
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

    it("threads the caller's viewerId into deleteDashboard (#4537)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);
      expect(mockDeleteDashboard).toHaveBeenCalledWith(VALID_ID, { orgId: "org-1", viewerId: "u1" });
    });

    it("a userless caller is stopped by the org gate and never reaches deleteDashboard (#4537)", async () => {
      // `viewerId: undefined` would bypass the write gate (the system
      // opt-out), and the handlers' `user?.id ?? "anonymous"` fallback is
      // only defense-in-depth: this router's requireOrgContext() rejects a
      // user-less caller outright. Pin that fail-closed ordering — if the
      // middleware ever starts admitting user-less requests, this fails and
      // forces the fallback semantics to be re-examined.
      mockAuthenticateRequest.mockResolvedValue({
        authenticated: true as const,
        mode: "none" as const,
        user: undefined,
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(400);
      expect(mockDeleteDashboard).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/dashboards/:id/cards — add card
  // -------------------------------------------------------------------------

  describe("POST /api/v1/dashboards/:id/cards", () => {
    beforeEach(directCrudAuth);
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

    it("returns 400 for an autoComparison KPI card whose SQL omits the date window (#3207)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Revenue",
            // No :date_from / :date_to — the prior-period shift would be a no-op.
            sql: "SELECT SUM(amount) AS total FROM orders",
            chartConfig: {
              type: "kpi",
              categoryColumn: "total",
              valueColumns: ["total"],
              kpi: { autoComparison: true },
            },
          }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_request");
      expect(body.message).toMatch(/autoComparison/i);
      expect(mockAddCard).not.toHaveBeenCalled();
    });

    it("forwards event annotations to addCard (#3209)", async () => {
      const annotations = [
        { x: "2026-01-15", label: "Launch", color: "#10b981" },
        { x: "2026-03-01", label: "Campaign" },
      ];
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Weekly signups",
            sql: "SELECT week, COUNT(*) AS signups FROM users GROUP BY week",
            chartConfig: { type: "line", categoryColumn: "week", valueColumns: ["signups"] },
            annotations,
          }),
        }),
      );
      expect(response.status).toBe(201);
      const addArgs = mockAddCard.mock.calls[0] as unknown as [{ annotations?: unknown }];
      expect(addArgs[0].annotations).toEqual(annotations);
    });

    it("returns 422 for a malformed annotations body and never calls addCard (#3209)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Weekly signups",
            sql: "SELECT 1",
            // Each annotation requires a non-empty `label`; this one omits it.
            annotations: [{ x: "2026-01-15" }],
          }),
        }),
      );
      expect(response.status).toBe(422);
      expect(mockAddCard).not.toHaveBeenCalled();
    });

    it("returns 422 when annotations exceed the bounded count and never calls addCard (#3209)", async () => {
      const tooMany = Array.from({ length: 21 }, (_, i) => ({ x: `${i}`, label: `e${i}` }));
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "T", sql: "SELECT 1", annotations: tooMany }),
        }),
      );
      expect(response.status).toBe(422);
      expect(mockAddCard).not.toHaveBeenCalled();
    });

    it("returns 400 when connectionGroupId belongs to a different org (#2424)", async () => {
      // The route looks up the dashboard's org, then verifies the supplied
      // connection_group_id is owned by that org. A "not_found" verdict from
      // verifyGroupBelongsToOrg means the group exists in some other tenant
      // (or doesn't exist at all) — either way, persisting it would write
      // a cross-org pointer onto the card.
      mockVerifyGroupBelongsToOrg.mockResolvedValueOnce("not_found");
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Test",
            sql: "SELECT 1",
            connectionGroupId: "g_other_org_group",
          }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_connection_group");
    });

    // #4318 — REST/draft parity: a text / section card is creatable via REST.
    it("creates a text card via REST, forwarding content (no sql) to addCard", async () => {
      mockAddCard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Section", kind: "text", content: "## Top of funnel" }),
        }),
      );
      expect(response.status).toBe(201);
      const addArgs = mockAddCard.mock.calls[0] as unknown as [{ content?: string | null; sql: string }];
      expect(addArgs[0].content).toBe("## Top of funnel");
      // A text card stores sql = '' and never reaches the SQL pipeline.
      expect(addArgs[0].sql).toBe("");
    });

    it("returns 422 for a text card with no content and never calls addCard (#4318)", async () => {
      mockAddCard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Section", kind: "text" }),
        }),
      );
      expect(response.status).toBe(422);
      expect(mockAddCard).not.toHaveBeenCalled();
    });

    it("returns 422 for a text card that also carries sql and never calls addCard (#4318)", async () => {
      mockAddCard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Section", kind: "text", content: "# H", sql: "SELECT 1" }),
        }),
      );
      expect(response.status).toBe(422);
      expect(mockAddCard).not.toHaveBeenCalled();
    });

    it("returns 422 for a chart card that carries content and never calls addCard (#4318)", async () => {
      mockAddCard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // kind defaults to "chart"; `content` is only valid on a text card.
          body: JSON.stringify({ title: "Revenue", sql: "SELECT 1", content: "# nope" }),
        }),
      );
      expect(response.status).toBe(422);
      expect(mockAddCard).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/dashboards/:id/cards/:cardId — update card
  // -------------------------------------------------------------------------

  describe("PATCH /api/v1/dashboards/:id/cards/:cardId", () => {
    beforeEach(directCrudAuth);
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

    it("forwards event annotations to updateCard, incl. [] to clear (#3209)", async () => {
      const annotations = [{ x: "2026-01-15", label: "Launch" }];
      const setResp = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ annotations }),
        }),
      );
      expect(setResp.status).toBe(200);
      const setArgs = mockUpdateCard.mock.calls[0] as unknown as [string, string, { annotations?: unknown }];
      expect(setArgs[2].annotations).toEqual(annotations);

      mockUpdateCard.mockClear();
      const clearResp = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ annotations: [] }),
        }),
      );
      expect(clearResp.status).toBe(200);
      const clearArgs = mockUpdateCard.mock.calls[0] as unknown as [string, string, { annotations?: unknown }];
      expect(clearArgs[2].annotations).toEqual([]);
    });

    // #4318 — REST/draft parity: a card's SQL is editable via REST.
    it("forwards a card-SQL edit to updateCard (#4318)", async () => {
      mockUpdateCard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT COUNT(*) FROM orders" }),
        }),
      );
      expect(response.status).toBe(200);
      const args = mockUpdateCard.mock.calls[0] as unknown as [string, string, { sql?: string }];
      expect(args[2].sql).toBe("SELECT COUNT(*) FROM orders");
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/dashboards/:id/cards/:cardId — remove card
  // -------------------------------------------------------------------------

  describe("DELETE /api/v1/dashboards/:id/cards/:cardId", () => {
    beforeEach(directCrudAuth);
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
  // POST /api/v1/dashboards/preview-card — chat-canvas preview
  // -------------------------------------------------------------------------

  describe("POST /api/v1/dashboards/preview-card", () => {
    it("returns 200 with columns + rows for a valid SELECT", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT month, total FROM revenue" }),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { columns: string[]; rowCount: number };
      expect(body.columns).toEqual(["month", "total"]);
      expect(body.rowCount).toBe(1);
    });

    it("returns 401 when unauthenticated", async () => {
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: false as const,
        mode: "none" as const,
        status: 401 as const,
        error: "Authentication required.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1" }),
        }),
      );
      expect(response.status).toBe(401);
    });

    it("returns 403 when authenticated but not admin", async () => {
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: true as const,
        mode: "simple-key" as const,
        user: { id: "u1", label: "test@test.com", mode: "simple-key" as const, role: "member" as const, activeOrganizationId: "org-1" },
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1" }),
        }),
      );
      expect(response.status).toBe(403);
    });

    it("returns 400 invalid_sql when the pipeline rejects mutation SQL", async () => {
      mockRunUserQueryPipeline.mockResolvedValueOnce({
        kind: "validation_failed",
        message: "SQL must be SELECT-only — found INSERT/UPDATE/DELETE/DDL keyword.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "DROP TABLE companies" }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_sql");
      expect(body.message).toContain("SELECT-only");
    });

    it("returns 400 invalid_sql when a non-whitelisted table is referenced", async () => {
      mockRunUserQueryPipeline.mockResolvedValueOnce({
        kind: "validation_failed",
        message: 'Table "secret_audit" is not in the semantic layer for connection "default".',
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT * FROM secret_audit" }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_sql");
    });

    it("returns 400 invalid_sql on semicolon-chained statements", async () => {
      mockRunUserQueryPipeline.mockResolvedValueOnce({
        kind: "validation_failed",
        message: "Multiple SQL statements detected — only one statement per query.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1; DROP TABLE companies" }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_sql");
    });

    it("returns 409 approval_required when the pipeline gates the query", async () => {
      mockRunUserQueryPipeline.mockResolvedValueOnce({
        kind: "approval_required",
        approvalRequestId: "req-123",
        matchedRules: ["Finance — read"],
        message: 'Approval required. Rule: "Finance — read".',
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT * FROM revenue" }),
        }),
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string; approvalRequestId: string };
      expect(body.error).toBe("approval_required");
      expect(body.approvalRequestId).toBe("req-123");
    });

    it("returns 503 connection_unavailable when the source is offline", async () => {
      mockRunUserQueryPipeline.mockResolvedValueOnce({
        kind: "connection_unavailable",
        connectionId: "default",
        message: "Connection \"default\" is not registered.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1" }),
        }),
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("connection_unavailable");
    });

    it("returns 429 when the source rate limit is hit", async () => {
      mockRunUserQueryPipeline.mockResolvedValueOnce({
        kind: "rate_limited",
        message: "Rate limit exceeded for connection \"default\".",
        retryAfterMs: 1500,
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1" }),
        }),
      );
      expect(response.status).toBe(429);
      const body = (await response.json()) as { error: string; retryAfterMs: number };
      expect(body.error).toBe("rate_limited");
      expect(body.retryAfterMs).toBe(1500);
    });

    it("threads connectionId through to the pipeline", async () => {
      mockRunUserQueryPipeline.mockClear();
      await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1", connectionId: "analytics-replica" }),
        }),
      );
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
      const callArgs = mockRunUserQueryPipeline.mock.calls[0][0];
      expect(callArgs).toMatchObject({ sql: "SELECT 1", connectionId: "analytics-replica" });
    });

    // #4318 — preview-card verifies a client-supplied connectionId belongs to
    // the caller's org BEFORE executing (parity with addCard's group check).
    it("rejects a connectionId outside the caller's org with 403, never executing (#4318)", async () => {
      mockRunUserQueryPipeline.mockClear();
      // The connection is not visible in the caller's workspace.
      mockIsConnectionVisibleInMode.mockResolvedValueOnce(false);
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1", connectionId: "other-org-conn" }),
        }),
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("connection_forbidden");
      // Fail closed: the SQL never reached the pipeline.
      expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
      // The org check was actually consulted with the caller's org + connection.
      expect(mockIsConnectionVisibleInMode).toHaveBeenCalledTimes(1);
      const [orgArg, connArg] = mockIsConnectionVisibleInMode.mock.calls[0] as unknown as [string, string, string];
      expect(orgArg).toBe("org-1");
      expect(connArg).toBe("other-org-conn");
    });

    it("executes when the connectionId is in the caller's org (#4318)", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockIsConnectionVisibleInMode.mockResolvedValueOnce(true);
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1", connectionId: "in-org-conn" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
    });

    it("skips the org check when no connectionId is supplied (#4318)", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockIsConnectionVisibleInMode.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/preview-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(mockIsConnectionVisibleInMode).not.toHaveBeenCalled();
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
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

    // #3138 — a text card has no SQL; refresh returns it unchanged.
    it("returns a text card unchanged without touching the query pipeline", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockGetCard.mockResolvedValueOnce({ ok: true, data: mockTextCardData });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/refresh`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      expect((await response.json() as { kind: string }).kind).toBe("text");
      expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
      expect(mockRefreshCard).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/dashboards/:id/cards/:cardId/render — parameter-aware render
  // -------------------------------------------------------------------------

  describe("POST /api/v1/dashboards/:id/cards/:cardId/render", () => {
    const paramDashboard = {
      ...mockDashboardData,
      parameters: [
        { key: "date_from", type: "date", default: "now - 30 days", label: "From" },
        { key: "q", type: "text", default: null, label: "Search" },
      ],
      cards: [],
    };
    const paramCard = {
      ...mockCardData,
      sql: "SELECT * FROM orders WHERE created_at >= :date_from AND note = :q",
    };

    it("forwards supplied parameter values to the pipeline (bound, never interpolated)", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: paramDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: paramCard });
      // An injection-shaped value for a free-text parameter.
      const malicious = "x'; DROP TABLE orders; --";

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { date_from: "2026-01-01", q: malicious } }),
        }),
      );

      expect(response.status).toBe(200);
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
      const callArgs = mockRunUserQueryPipeline.mock.calls[0][0];
      // The card SQL passed to the pipeline keeps its :placeholders — the value
      // is NOT spliced into the query text.
      expect(callArgs.sql).toContain(":date_from");
      expect(callArgs.sql).toContain(":q");
      expect(callArgs.sql).not.toContain("DROP TABLE");
      // The malicious value travels only via the parameters map (→ bind array).
      expect(callArgs.parameters).toMatchObject({ date_from: "2026-01-01", q: malicious });
    });

    it("falls back to defaults for omitted parameters", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: paramDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: paramCard });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { q: "paid" } }),
        }),
      );

      expect(response.status).toBe(200);
      const callArgs = mockRunUserQueryPipeline.mock.calls[0][0];
      // date_from defaulted (a resolved ISO date), q supplied.
      expect(callArgs.parameters?.q).toBe("paid");
      expect(callArgs.parameters?.date_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    // #4318 — a body-less POST falls back to parameter defaults (mirrors the
    // export route's `?? {}`) rather than throwing a 500 on `undefined`.
    it("renders with parameter defaults when the request has no body (never 500) (#4318)", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: paramDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: paramCard });

      // No body, no Content-Type — the body-less case that previously 500'd.
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
        }),
      );

      expect(response.status).toBe(200);
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
      const callArgs = mockRunUserQueryPipeline.mock.calls[0][0];
      // Every parameter resolved to its default: date_from → an ISO date, q → its
      // declared null default.
      expect(callArgs.parameters?.date_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(callArgs.parameters?.q).toBeNull();
    });

    it("rejects an invalid parameter value with 400 (never reaches the pipeline)", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: paramDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: paramCard });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { date_from: "not-a-date" } }),
        }),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_parameters");
      expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
    });

    // #3138 — a text card has no query; render returns an empty result set
    // and never reaches the SQL pipeline (an empty `sql` would otherwise be
    // rejected by the validator).
    it("returns an empty result set for a text card, never reaching SQL", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: { ...mockDashboardData, cards: [] } });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: mockTextCardData });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        columns: [], rows: [], truncated: false, rowCount: 0, executionMs: 0,
      });
      expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
    });

    // #3137 — a KPI card with a comparisonSql runs a SECOND query through the
    // same pipeline (bound, same params) and returns it as `comparison`.
    const kpiCard = {
      ...mockCardData,
      sql: "SELECT 'Revenue' AS label, SUM(amount) AS total FROM orders WHERE created_at >= :date_from",
      chartConfig: {
        type: "kpi",
        categoryColumn: "label",
        valueColumns: ["total"],
        kpi: {
          valueFormat: "currency",
          comparisonSql: "SELECT SUM(amount) AS total FROM orders WHERE created_at < :date_from",
          comparisonLabel: "vs. prior period",
        },
      },
    };

    it("runs comparisonSql as a second bound query and returns it as `comparison`", async () => {
      mockRunUserQueryPipeline.mockReset();
      // Dispatch on the SQL so the two parallel pipeline calls get distinct rows.
      mockRunUserQueryPipeline.mockImplementation(async (opts) => {
        const total = opts.sql.includes("< :date_from") ? 1000000 : 1200000;
        return {
          kind: "ok" as const,
          columns: ["label", "total"],
          rows: [{ label: "Revenue", total }],
          rowCount: 1,
          executionMs: 4,
          truncated: false,
          maskingApplied: false,
        };
      });
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: paramDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: kpiCard });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { date_from: "2026-01-01" } }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        rows: { total: number }[];
        comparison: { columns: string[]; rows: { total: number }[] } | null;
      };
      // Primary value.
      expect(body.rows[0].total).toBe(1200000);
      // Comparison block carries the prior-period query result.
      expect(body.comparison).not.toBeNull();
      expect(body.comparison?.rows[0].total).toBe(1000000);
      // Both queries ran; the comparison bound the SAME parameter value.
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(2);
      const comparisonCall = mockRunUserQueryPipeline.mock.calls.find((c) =>
        c[0].sql.includes("< :date_from"),
      );
      expect(comparisonCall?.[0].sql).toContain("< :date_from");
      expect(comparisonCall?.[0].parameters).toMatchObject({ date_from: "2026-01-01" });
    });

    // #3207 — autoComparison re-runs the card's OWN sql with the date window
    // shifted back one period (no hand-written comparisonSql).
    const autoKpiDashboard = {
      ...mockDashboardData,
      parameters: [
        { key: "date_from", type: "date", default: "now - 30 days", label: "From" },
        { key: "date_to", type: "date", default: "now", label: "To" },
      ],
      cards: [],
    };
    const autoKpiCard = {
      ...mockCardData,
      sql: "SELECT SUM(amount) AS total FROM orders WHERE created_at >= :date_from AND created_at < :date_to",
      chartConfig: {
        type: "kpi",
        categoryColumn: "label",
        valueColumns: ["total"],
        kpi: { valueFormat: "currency", autoComparison: true, comparisonLabel: "vs. prior period" },
      },
    };

    it("runs the card's own sql against the shifted prior window for autoComparison", async () => {
      mockRunUserQueryPipeline.mockReset();
      // Dispatch on the bound date_from: prior window starts earlier.
      mockRunUserQueryPipeline.mockImplementation(async (opts) => {
        const total = opts.parameters?.date_from === "2026-01-04" ? 1000000 : 1200000;
        return {
          kind: "ok" as const,
          columns: ["total"],
          rows: [{ total }],
          rowCount: 1,
          executionMs: 4,
          truncated: false,
          maskingApplied: false,
        };
      });
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: autoKpiDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: autoKpiCard });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // [Feb 1, Mar 1) is a 28-day window → prior [Jan 4, Feb 1).
          body: JSON.stringify({ parameters: { date_from: "2026-02-01", date_to: "2026-03-01" } }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        rows: { total: number }[];
        comparison: { rows: { total: number }[] } | null;
      };
      expect(body.rows[0].total).toBe(1200000);
      expect(body.comparison?.rows[0].total).toBe(1000000);
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(2);
      const comparisonCall = mockRunUserQueryPipeline.mock.calls.find(
        (c) => c[0].parameters?.date_from === "2026-01-04",
      );
      // Same SQL as the primary; only the bound window moved.
      expect(comparisonCall?.[0].sql).toBe(autoKpiCard.sql);
      expect(comparisonCall?.[0].parameters).toMatchObject({ date_from: "2026-01-04", date_to: "2026-02-01" });
    });

    it("omits `comparison` for autoComparison when the window can't be derived (inverted range)", async () => {
      mockRunUserQueryPipeline.mockReset();
      mockRunUserQueryPipeline.mockImplementation(async () => ({
        kind: "ok" as const,
        columns: ["total"],
        rows: [{ total: 1200000 }],
        rowCount: 1,
        executionMs: 4,
        truncated: false,
        maskingApplied: false,
      }));
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: autoKpiDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: autoKpiCard });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // from after to → no derivable prior period.
          body: JSON.stringify({ parameters: { date_from: "2026-03-01", date_to: "2026-02-01" } }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect("comparison" in body).toBe(false);
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
    });

    it("omits `comparison` for a KPI card with no comparisonSql", async () => {
      mockRunUserQueryPipeline.mockClear();
      const noComparison = {
        ...kpiCard,
        chartConfig: { type: "kpi", categoryColumn: "label", valueColumns: ["total"], kpi: { valueFormat: "currency" } },
      };
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: paramDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: noComparison });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { date_from: "2026-01-01" } }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect("comparison" in body).toBe(false);
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
    });

    it("degrades `comparison` to null (primary still rendered) when the comparison query fails", async () => {
      mockRunUserQueryPipeline.mockReset();
      mockRunUserQueryPipeline.mockImplementation(async (opts) => {
        if (opts.sql.includes("< :date_from")) {
          return { kind: "validation_failed" as const, message: "comparison blew up" };
        }
        return {
          kind: "ok" as const,
          columns: ["label", "total"],
          rows: [{ label: "Revenue", total: 1200000 }],
          rowCount: 1,
          executionMs: 4,
          truncated: false,
          maskingApplied: false,
        };
      });
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: paramDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: kpiCard });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { date_from: "2026-01-01" } }),
        }),
      );

      // Primary succeeded → 200 with rows; comparison degraded to null.
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        rows: { total: number }[];
        comparison: unknown;
      };
      expect(body.rows[0].total).toBe(1200000);
      expect(body.comparison).toBeNull();
    });

    it("degrades to null (does not 500 the primary) when the comparison query THROWS a defect", async () => {
      mockRunUserQueryPipeline.mockReset();
      // An unexpected defect (not a typed PipelineError) on the comparison path
      // must not reject Promise.all and take down the primary render.
      mockRunUserQueryPipeline.mockImplementation(async (opts) => {
        if (opts.sql.includes("< :date_from")) {
          throw new Error("connection pool exploded");
        }
        return {
          kind: "ok" as const,
          columns: ["label", "total"],
          rows: [{ label: "Revenue", total: 1200000 }],
          rowCount: 1,
          executionMs: 4,
          truncated: false,
          maskingApplied: false,
        };
      });
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: paramDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: kpiCard });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { date_from: "2026-01-01" } }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { rows: { total: number }[]; comparison: unknown };
      expect(body.rows[0].total).toBe(1200000);
      expect(body.comparison).toBeNull();
    });

    // -----------------------------------------------------------------------
    // #3210 — `?format=csv` streams the SAME parameter-bound result as a CSV
    // attachment. It reuses the identical pipeline (no second SQL path), so
    // auto-LIMIT + param binding + auth all still apply.
    // -----------------------------------------------------------------------

    it("streams the rendered rows as a text/csv attachment for format=csv", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: paramDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: paramCard });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?format=csv`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { date_from: "2026-01-01", q: "paid" } }),
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/csv");
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("attachment");
      // Filename derives from the card title ("Total Revenue") + a UTC stamp.
      expect(disposition).toMatch(/filename="total-revenue-\d{8}-\d{6}\.csv"/);
      // Header row + one data row, CRLF-separated (matches the default mock outcome).
      expect(await response.text()).toBe("month,total\r\nJan,1000");
    });

    it("binds the supplied parameters on the CSV path (never string-interpolated)", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: paramDashboard });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: paramCard });
      const malicious = "x'; DROP TABLE orders; --";

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?format=csv`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { date_from: "2026-01-01", q: malicious } }),
        }),
      );

      expect(response.status).toBe(200);
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
      const callArgs = mockRunUserQueryPipeline.mock.calls[0][0];
      expect(callArgs.sql).toContain(":q");
      expect(callArgs.sql).not.toContain("DROP TABLE");
      expect(callArgs.parameters).toMatchObject({ date_from: "2026-01-01", q: malicious });
    });

    it("surfaces auto-LIMIT truncation via the X-Atlas-Truncated header", async () => {
      mockRunUserQueryPipeline.mockReset();
      mockRunUserQueryPipeline.mockResolvedValueOnce({
        kind: "ok",
        columns: ["month", "total"],
        rows: [{ month: "Jan", total: 1000 }],
        rowCount: 1000,
        executionMs: 5,
        truncated: true,
        maskingApplied: false,
      });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: mockCardData });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?format=csv`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-atlas-truncated")).toBe("1");
      expect(response.headers.get("x-atlas-row-count")).toBe("1000");
    });

    it("neutralizes formula-injection cells in the streamed CSV", async () => {
      mockRunUserQueryPipeline.mockReset();
      mockRunUserQueryPipeline.mockResolvedValueOnce({
        kind: "ok",
        columns: ["label", "amount"],
        // A spreadsheet would execute `=HYPERLINK(...)` on open — it must be
        // emitted as text (`'=…`). The negative number stays a real number.
        rows: [{ label: "=HYPERLINK(\"http://evil\")", amount: -5 }],
        rowCount: 1,
        executionMs: 5,
        truncated: false,
        maskingApplied: false,
      });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: mockCardData });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?format=csv`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        }),
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      // The dangerous cell is force-text-quoted (`'` prefix), the number isn't.
      expect(text).toBe("label,amount\r\n\"'=HYPERLINK(\"\"http://evil\"\")\",-5");
    });

    it("rejects format=csv for a text card with 400 (no tabular data)", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockGetDashboard.mockResolvedValueOnce({ ok: true, data: { ...mockDashboardData, cards: [] } });
      mockGetCard.mockResolvedValueOnce({ ok: true, data: mockTextCardData });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?format=csv`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        }),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("not_exportable");
      expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
    });

    it("attaches CORS expose-headers to the raw CSV response (readable cross-origin)", async () => {
      // A handler-returned raw Response does NOT inherit the middleware's
      // `c.header()` CORS headers, so the route must spread them on. Without
      // this, a cross-origin deploy can't read the file or X-Atlas-Truncated.
      mockGetCard.mockResolvedValueOnce({ ok: true, data: mockCardData });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?format=csv`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
          body: JSON.stringify({ parameters: {} }),
        }),
      );

      expect(response.status).toBe(200);
      const expose = response.headers.get("access-control-expose-headers") ?? "";
      expect(expose).toContain("X-Atlas-Truncated");
      expect(expose).toContain("Content-Disposition");
    });

    it("enforces the same auth gate on the CSV path (401 when unauthenticated)", async () => {
      mockAuthenticateRequest.mockReset();
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: false as const,
        mode: "simple-key" as const,
        status: 401 as const,
        error: "API key required",
      });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?format=csv`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        }),
      );

      expect(response.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/dashboards/:id/refresh — refresh all cards
  // -------------------------------------------------------------------------

  describe("POST /api/v1/dashboards/:id/refresh", () => {
    it("returns 200 with refresh summary including empty errors[]", async () => {
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
      const body = (await response.json()) as {
        refreshed: number; failed: number; total: number; errors: { cardId: string }[];
      };
      expect(body.total).toBe(1);
      expect(body.refreshed).toBe(1);
      expect(body.failed).toBe(0);
      expect(body.errors).toEqual([]);
    });

    // #3138 — a text card is counted in `total` but is never refreshed or
    // failed (it has no SQL to run).
    it("skips text cards in the bulk refresh — counted in total, never refreshed/failed", async () => {
      mockRunUserQueryPipeline.mockClear();
      mockGetDashboard.mockResolvedValueOnce({
        ok: true,
        data: { ...mockDashboardData, cards: [mockCardData, mockTextCardData] },
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/refresh`, { method: "POST" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        refreshed: number; failed: number; total: number; errors: unknown[];
      };
      expect(body.total).toBe(2);
      expect(body.refreshed).toBe(1);
      expect(body.failed).toBe(0);
      expect(body.errors).toEqual([]);
      // Only the chart card hit the pipeline.
      expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
    });

    it("surfaces per-card errors in the response payload when a card fails", async () => {
      mockGetDashboard.mockResolvedValueOnce({
        ok: true,
        data: { ...mockDashboardData, cards: [mockCardData, { ...mockCardData, id: "c2", title: "Bad card" }] },
      });
      mockRunUserQueryPipeline.mockResolvedValueOnce({
        kind: "ok",
        columns: ["x"], rows: [], rowCount: 0, executionMs: 1, truncated: false, maskingApplied: false,
      });
      mockRunUserQueryPipeline.mockResolvedValueOnce({
        kind: "validation_failed",
        message: 'Table "deprecated_table" is not in the semantic layer.',
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/refresh`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        refreshed: number; failed: number; total: number;
        errors: { cardId: string; cardTitle: string; reason: string; message: string }[];
      };
      expect(body.total).toBe(2);
      expect(body.refreshed).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].cardTitle).toBe("Bad card");
      expect(body.errors[0].reason).toBe("validation_failed");
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
      // #4537 — the acting identity must reach the write-side gate.
      expect(mockShareDashboard.mock.calls[0]?.[1]).toEqual({ orgId: "org-1", viewerId: "u1" });
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

    // -----------------------------------------------------------------------
    // Fail-closed on share config (#4317)
    //
    // A PRESENT-yet-invalid body must return 400 and NEVER fall through to the
    // safe defaults — the old parse-then-swallow path silently downgraded an
    // org-intended share to `shareMode: "public"`. The load-bearing assertion
    // is that `shareDashboard` is never reached on an invalid body, so no
    // downgraded share can be written.
    // -----------------------------------------------------------------------

    it("returns 400 and never shares when the body is malformed JSON (#4317)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ this is not json",
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_request");
      expect(mockShareDashboard).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid shareMode and never downgrades to public (#4317)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shareMode: "everyone" }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_request");
      // Critical: the invalid body must NOT reach shareDashboard — if it did,
      // the org-intended share would be written as public.
      expect(mockShareDashboard).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid expiresIn and never shares (#4317)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shareMode: "org", expiresIn: "forever" }),
        }),
      );
      expect(response.status).toBe(400);
      expect(mockShareDashboard).not.toHaveBeenCalled();
    });

    it("uses safe defaults for an empty body and forwards rotate=false (#4317)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/share`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      expect(mockShareDashboard).toHaveBeenCalledTimes(1);
      const opts = mockShareDashboard.mock.calls[0]?.[2] as { rotate?: boolean } | undefined;
      expect(opts?.rotate).toBe(false);
    });

    it("forwards an explicit rotate=true to shareDashboard (#4317)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shareMode: "public", rotate: true }),
        }),
      );
      expect(response.status).toBe(200);
      const opts = mockShareDashboard.mock.calls[0]?.[2] as { rotate?: boolean } | undefined;
      expect(opts?.rotate).toBe(true);
    });

    // Positive control for the accept path: a VALID org body must reach
    // shareDashboard with shareMode:"org" — proving the org intent is preserved
    // end-to-end, not just that invalid bodies are rejected (#4317).
    it("forwards a valid shareMode=org to shareDashboard (never dropped to public) (#4317)", async () => {
      mockShareDashboard.mockResolvedValueOnce({
        ok: true,
        data: { token: "org-share-tok", expiresAt: null, shareMode: "org", rotated: false },
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shareMode: "org", expiresIn: "24h" }),
        }),
      );
      expect(response.status).toBe(200);
      const opts = mockShareDashboard.mock.calls[0]?.[2] as { shareMode?: string; expiresIn?: string | null } | undefined;
      expect(opts?.shareMode).toBe("org");
      expect(opts?.expiresIn).toBe("24h");
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
      // #4537 — the acting identity must reach the write-side gate.
      expect(mockUnshareDashboard).toHaveBeenCalledWith(VALID_ID, { orgId: "org-1", viewerId: "u1" });
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
      // #4537 — status carries the share token; the viewer gates the read.
      expect(mockGetShareStatus).toHaveBeenCalledWith(VALID_ID, { orgId: "org-1", viewerId: "u1" });
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
      mockGetSharedDashboard.mockResolvedValueOnce(
        sharedViewResult({
          shareMode: "public",
          cards: [mockSharedCardData],
          parameterSummary: [
            { label: "Date", displayValue: "2026-06-01" },
            { label: "Region", displayValue: "All" },
          ],
        }),
      );
      const response = await app.fetch(
        new Request("http://localhost/api/public/dashboards/abc123def456ghi789jkl"),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        title: string;
        cards: Array<Record<string, unknown>>;
        parameterSummary: Array<{ label: string; displayValue: string }>;
      };
      expect(body.title).toBe("Revenue Dashboard");
      expect(body.cards).toHaveLength(1);

      // #4316 — the data-only projection: no query internals reach the wire.
      // Absent at the dashboard level: owner/org ids, share token, refresh cron,
      // and the live parameter DEFINITIONS.
      for (const leaked of ["ownerId", "orgId", "shareToken", "refreshSchedule", "parameters", "id"]) {
        expect(body).not.toHaveProperty(leaked);
      }
      // Absent at the card level: raw SQL + internal ids.
      for (const card of body.cards) {
        for (const leaked of ["sql", "connectionGroupId", "dashboardId"]) {
          expect(card).not.toHaveProperty(leaked);
        }
      }
      // Present: the frozen, display-only parameter summary — { label, displayValue }
      // only, no keys/definitions/controls.
      expect(body.parameterSummary).toEqual([
        { label: "Date", displayValue: "2026-06-01" },
        { label: "Region", displayValue: "All" },
      ]);
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
    // Rate-limit per real viewer identity (#4317)
    //
    // The shared page is server-rendered and forwards the viewer's
    // x-forwarded-for, so `getClientIP` resolves the real viewer. Each viewer
    // must get its OWN bucket — exhausting one viewer must not rate-limit a
    // different viewer (the pre-fix bug collapsed every viewer into the single
    // web-server-IP bucket).
    // -----------------------------------------------------------------------

    it("rate-limits per real viewer identity, not one shared bucket (#4317)", async () => {
      // Resolve the viewer from the forwarded header, mirroring getClientIP
      // when ATLAS_TRUST_PROXY is set.
      mockGetClientIP.mockImplementation((req: Request) => req.headers.get("x-forwarded-for"));

      const hitAsViewer = (viewer: string) =>
        app.fetch(
          new Request("http://localhost/api/public/dashboards/abc123def456ghi789jkl", {
            headers: { "x-forwarded-for": viewer },
          }),
        );

      // PUBLIC_RATE_MAX requests / viewer / minute — the (MAX+1)th for viewer-A
      // trips the limiter (requests below the ceiling fall through to the
      // not_found default → 404, never 429).
      let lastStatus = 0;
      for (let i = 0; i < PUBLIC_RATE_MAX + 1; i++) {
        lastStatus = (await hitAsViewer("viewer-a")).status;
      }
      expect(lastStatus).toBe(429);

      // A DIFFERENT viewer is unaffected — the bucket keys on the viewer, not a
      // single shared web-server bucket.
      const viewerB = await hitAsViewer("viewer-b");
      expect(viewerB.status).not.toBe(429);
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
      mockGetSharedDashboard.mockResolvedValueOnce(
        sharedViewResult({ orgId: "org-A", shareMode: "org" }),
      );
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
      mockGetSharedDashboard.mockResolvedValueOnce(
        sharedViewResult({ orgId: "org-A", shareMode: "org" }),
      );
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
      mockGetSharedDashboard.mockResolvedValueOnce(
        sharedViewResult({ orgId: "org-A", shareMode: "org" }),
      );
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
      mockGetSharedDashboard.mockResolvedValueOnce(
        sharedViewResult({
          orgId: "org-A",
          shareMode: "org",
          parameterSummary: [{ label: "Region", displayValue: "All" }],
        }),
      );
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

      const body = (await response.json()) as {
        title: string;
        cards: Array<Record<string, unknown>>;
        shareMode: string;
        parameterSummary: Array<{ label: string; displayValue: string }>;
      };
      expect(body.shareMode).toBe("org");
      expect(body.title).toBe("Revenue Dashboard");
      expect(body.cards).toHaveLength(1);

      // #4316 — the org (authenticated) mode gets the SAME data-only projection
      // as public: no query internals, and the frozen parameter summary present.
      // The route reads `access.orgId` for gating but serializes only `view`, so
      // the org id can't ride along on the authenticated branch either.
      for (const leaked of ["ownerId", "orgId", "shareToken", "refreshSchedule", "parameters", "id"]) {
        expect(body).not.toHaveProperty(leaked);
      }
      for (const card of body.cards) {
        for (const leaked of ["sql", "connectionGroupId", "dashboardId"]) {
          expect(card).not.toHaveProperty(leaked);
        }
      }
      expect(body.parameterSummary).toEqual([{ label: "Region", displayValue: "All" }]);
    });

    // Fail-closed regression for #1736 — the schema allows share_mode='org'
    // with org_id=NULL (createShareLink does not stamp orgId). Without a
    // fail-closed check, any authenticated caller could read such a row.
    it("returns 403 for org-scoped shares when the dashboard has no orgId (#1736)", async () => {
      mockGetSharedDashboard.mockResolvedValueOnce(
        sharedViewResult({ orgId: null, shareMode: "org" }),
      );
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

    // -----------------------------------------------------------------------
    // Share token log redaction (#1743)
    //
    // Share tokens are bearer credentials. Logs on the public share route
    // must carry `tokenHash` (first 16 hex of SHA-256), never the raw token.
    // -----------------------------------------------------------------------

    // Global check: no log line emitted during this request carries the raw
    // token in its object payload or message string. Catches future log sites
    // that might log the token under a different msg string — the targeted
    // `.find()` assertions would silently miss those regressions.
    function assertNoRawTokenInAnyLog(rawToken: string) {
      for (const entry of capturedLogs) {
        expect(JSON.stringify(entry.obj)).not.toContain(rawToken);
        expect(entry.msg).not.toContain(rawToken);
      }
    }

    it("redacts share token in auth-failure log (#1743)", async () => {
      const rawToken = "abc123def456ghi789jkl";
      mockGetSharedDashboard.mockResolvedValueOnce(
        sharedViewResult({ orgId: "org-A", shareMode: "org" }),
      );
      mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.reject(new Error("session store unavailable")),
      );

      await app.fetch(
        new Request(`http://localhost/api/public/dashboards/${rawToken}`),
      );

      const authFailLog = capturedLogs.find(
        (l) =>
          l.level === "error" &&
          l.msg === "Auth check failed for org-scoped dashboard share",
      );
      expect(authFailLog).toBeDefined();
      expect(authFailLog!.obj.tokenHash).toMatch(/^[0-9a-f]{16}$/);
      expect(authFailLog!.obj.token).toBeUndefined();
      assertNoRawTokenInAnyLog(rawToken);
    });

    it("redacts share token and records actor in denial log (#1743)", async () => {
      const rawToken = "abc123def456ghi789jkl";
      mockGetSharedDashboard.mockResolvedValueOnce(
        sharedViewResult({ orgId: "org-A", shareMode: "org" }),
      );
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

      await app.fetch(
        new Request(`http://localhost/api/public/dashboards/${rawToken}`),
      );

      const denialLog = capturedLogs.find(
        (l) =>
          l.level === "warn" &&
          l.msg.startsWith("Org-scoped dashboard share access denied"),
      );
      expect(denialLog).toBeDefined();
      expect(denialLog!.obj.tokenHash).toMatch(/^[0-9a-f]{16}$/);
      expect(denialLog!.obj.token).toBeUndefined();
      expect(denialLog!.obj.actorUserId).toBe("u-other");
      expect(denialLog!.obj.actorOrgId).toBe("org-B");
      assertNoRawTokenInAnyLog(rawToken);
    });

    it("redacts share token in DB-error log (#1743)", async () => {
      const rawToken = "abc123def456ghi789jkl";
      mockGetSharedDashboard.mockResolvedValueOnce({ ok: false, reason: "error" });

      await app.fetch(
        new Request(`http://localhost/api/public/dashboards/${rawToken}`),
      );

      const dbErrorLog = capturedLogs.find(
        (l) =>
          l.level === "error" &&
          l.msg === "Public dashboard fetch failed due to DB error",
      );
      expect(dbErrorLog).toBeDefined();
      expect(dbErrorLog!.obj.tokenHash).toMatch(/^[0-9a-f]{16}$/);
      expect(dbErrorLog!.obj.token).toBeUndefined();
      assertNoRawTokenInAnyLog(rawToken);
    });

    it("redacts share token in denial log when actor has no active org (#1743)", async () => {
      const rawToken = "abc123def456ghi789jkl";
      mockGetSharedDashboard.mockResolvedValueOnce(
        sharedViewResult({ orgId: "org-A", shareMode: "org" }),
      );
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: true as const,
        mode: "simple-key" as const,
        // No activeOrganizationId — freshly signed-up user with zero memberships
        user: {
          id: "u-orphan",
          label: "no-org@test.com",
          mode: "simple-key" as const,
          role: "member" as const,
        },
      });

      await app.fetch(
        new Request(`http://localhost/api/public/dashboards/${rawToken}`),
      );

      const denialLog = capturedLogs.find(
        (l) =>
          l.level === "warn" &&
          l.msg.startsWith("Org-scoped dashboard share access denied"),
      );
      expect(denialLog).toBeDefined();
      expect(denialLog!.obj.tokenHash).toMatch(/^[0-9a-f]{16}$/);
      expect(denialLog!.obj.actorUserId).toBe("u-orphan");
      expect(denialLog!.obj.actorOrgId).toBeUndefined();
      assertNoRawTokenInAnyLog(rawToken);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/dashboards/:id/sessions  (#2368 — History tab list)
  // -------------------------------------------------------------------------

  describe("GET /api/v1/dashboards/:id/sessions", () => {
    it("returns 400 for an invalid dashboard id", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/dashboards/not-a-uuid/sessions"),
      );
      expect(response.status).toBe(400);
      // Listing must not be reached when the id is malformed
      expect(mockListSessionsForDashboard).not.toHaveBeenCalled();
    });

    it("returns 404 when the dashboard is missing (org-scoped lookup fails) and never lists sessions cross-org", async () => {
      mockGetDashboard.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/sessions`),
      );
      expect(response.status).toBe(404);
      // Critical: org-scoping is enforced via getDashboard. If the dashboard
      // is not visible to this org we must NOT proceed to list sessions —
      // otherwise a guessed dashboardId leaks bound sessions across orgs.
      expect(mockListSessionsForDashboard).not.toHaveBeenCalled();
    });

    it("returns 200 with sessions when the dashboard is in the caller's org", async () => {
      mockListSessionsForDashboard.mockResolvedValueOnce([
        {
          conversationId: "11111111-1111-1111-1111-111111111111",
          userId: "u-author",
          title: "Edited the trend",
          createdAt: "2026-05-17T10:00:00Z",
          updatedAt: "2026-05-17T10:30:00Z",
          messageCount: 6,
        },
        {
          conversationId: "22222222-2222-2222-2222-222222222222",
          userId: null,
          title: null,
          createdAt: "2026-05-16T08:00:00Z",
          updatedAt: "2026-05-16T08:05:00Z",
          messageCount: 0,
        },
      ]);
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/sessions`),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { sessions: Array<Record<string, unknown>> };
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions[0]!.conversationId).toBe("11111111-1111-1111-1111-111111111111");
      expect(body.sessions[0]!.messageCount).toBe(6);
      // Org-scoping is the gate — assert the module was called with caller's org.
      expect(mockListSessionsForDashboard).toHaveBeenCalledWith(VALID_ID, "org-1");
    });

    it("returns 401 when authentication fails", async () => {
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: false as const,
        mode: "simple-key" as const,
        status: 401 as const,
        error: "API key required",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/sessions`),
      );
      expect(response.status).toBe(401);
      expect(mockListSessionsForDashboard).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/dashboards/:id/sessions/:sessionId (#2368 — transcript)
  // -------------------------------------------------------------------------

  describe("GET /api/v1/dashboards/:id/sessions/:sessionId", () => {
    const VALID_SESSION_ID = "33333333-3333-3333-3333-333333333333";

    it("returns 400 for invalid id formats", async () => {
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/sessions/not-a-uuid`,
        ),
      );
      expect(response.status).toBe(400);
      expect(mockGetSessionTranscript).not.toHaveBeenCalled();
    });

    it("returns 404 when the dashboard is missing without leaking session existence", async () => {
      mockGetDashboard.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/sessions/${VALID_SESSION_ID}`,
        ),
      );
      expect(response.status).toBe(404);
      // Org gate fires first — we must never fetch a transcript when the
      // dashboard isn't visible to this org. Otherwise an attacker could
      // probe which sessionIds exist by varying dashboardId.
      expect(mockGetSessionTranscript).not.toHaveBeenCalled();
    });

    it("returns 404 when the session isn't bound to this dashboard", async () => {
      mockGetSessionTranscript.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/sessions/${VALID_SESSION_ID}`,
        ),
      );
      expect(response.status).toBe(404);
      // Still passed the dashboard gate but the module rejected the binding
      expect(mockGetSessionTranscript).toHaveBeenCalledWith(
        VALID_ID,
        VALID_SESSION_ID,
        "org-1",
      );
    });

    it("returns the transcript when the caller is workspace-scoped (not just the author)", async () => {
      mockGetSessionTranscript.mockResolvedValueOnce({
        ok: true,
        data: {
          conversationId: VALID_SESSION_ID,
          dashboardId: VALID_ID,
          // Author is a DIFFERENT user from the caller — workspace-wide read
          // means the request still succeeds. Regression guard against a
          // future refactor that swaps to per-user ownership.
          userId: "someone-else",
          title: "Refactored the trend cards",
          createdAt: "2026-05-17T10:00:00Z",
          updatedAt: "2026-05-17T10:30:00Z",
          messages: [
            {
              id: "msg-1",
              conversationId: VALID_SESSION_ID,
              role: "user",
              content: [{ type: "text", text: "make card 3 a bar chart" }],
              createdAt: "2026-05-17T10:00:01Z",
            },
            {
              id: "msg-2",
              conversationId: VALID_SESSION_ID,
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              createdAt: "2026-05-17T10:00:05Z",
            },
          ],
        },
      });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/sessions/${VALID_SESSION_ID}`,
        ),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        conversationId: string;
        userId: string;
        messages: Array<Record<string, unknown>>;
      };
      expect(body.conversationId).toBe(VALID_SESSION_ID);
      expect(body.userId).toBe("someone-else");
      expect(body.messages).toHaveLength(2);
      expect(mockGetSessionTranscript).toHaveBeenCalledWith(
        VALID_ID,
        VALID_SESSION_ID,
        "org-1",
      );
    });

    it("returns 500 with requestId when the module surface errors", async () => {
      mockGetSessionTranscript.mockResolvedValueOnce({ ok: false, reason: "error" });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/sessions/${VALID_SESSION_ID}`,
        ),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { requestId?: string; error: string };
      expect(body.error).toBe("internal_error");
      expect(typeof body.requestId).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/dashboards/:id/screenshot  (#2367 — vision tool)
  // -------------------------------------------------------------------------

  describe("GET /api/v1/dashboards/:id/screenshot", () => {
    it("returns 400 for an invalid dashboard id (renderer never reached)", async () => {
      mockScreenshotDashboard.mockClear();
      const response = await app.fetch(
        new Request("http://localhost/api/v1/dashboards/not-a-uuid/screenshot"),
      );
      expect(response.status).toBe(400);
      expect(mockScreenshotDashboard).not.toHaveBeenCalled();
    });

    it("returns 200 with a PNG body and cache headers on success", async () => {
      mockScreenshotDashboard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/screenshot`, {
          headers: { cookie: "atlas-session=abc" },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-atlas-screenshot-cached")).toBe("0");
      // Forwards user identity + cookie to the renderer — required so
      // the headless browser can authenticate without a fresh sign-in.
      const call = mockScreenshotDashboard.mock.calls[0]![0]!;
      expect(call).toMatchObject({
        dashboardId: VALID_ID,
        userId: "u1",
        orgId: "org-1",
        cookieHeader: "atlas-session=abc",
      });
      const body = await response.arrayBuffer();
      expect(body.byteLength).toBeGreaterThan(0);
      const bytes = new Uint8Array(body);
      // PNG magic
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50);
    });

    it("attaches CORS headers to the raw screenshot response (readable cross-origin)", async () => {
      // A handler-returned raw Response does NOT inherit the middleware's
      // `c.header()` CORS headers, so the route must spread them on. Without
      // Access-Control-Allow-Origin a cross-origin browser blocks the image
      // download entirely (the screenshot's own X-Atlas-* headers aren't in
      // the expose list, so Allow-Origin is the load-bearing one here) (#3222).
      mockScreenshotDashboard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/screenshot`, {
          headers: { Origin: "https://app.example.com" },
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).not.toBeNull();
      expect(response.headers.get("access-control-expose-headers")).not.toBeNull();
    });

    it("returns 404 when the dashboard is not in the caller's org", async () => {
      mockScreenshotDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "dashboard_not_found",
        message: "Dashboard not found.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/screenshot`),
      );
      expect(response.status).toBe(404);
    });

    it("returns 503 when the headless browser is not installed", async () => {
      mockScreenshotDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "browser_unavailable",
        message:
          "Headless browser is not installed in this deployment. Screenshots are disabled.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/screenshot`),
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("browser_unavailable");
      expect(typeof body.requestId).toBe("string");
    });

    it("returns 500 with requestId when render_failed bubbles up", async () => {
      mockScreenshotDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "render_failed",
        message: "Could not render dashboard screenshot. Try again or simplify the dashboard.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/screenshot`),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("render_failed");
      expect(typeof body.requestId).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/dashboards/:id/export  (#3211 — whole-dashboard PNG/PDF)
  // -------------------------------------------------------------------------

  describe("POST /api/v1/dashboards/:id/export", () => {
    it("returns 400 for an invalid dashboard id (renderer never reached)", async () => {
      mockExportDashboard.mockClear();
      const response = await app.fetch(
        new Request("http://localhost/api/v1/dashboards/not-a-uuid/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );
      expect(response.status).toBe(400);
      expect(mockExportDashboard).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated (admin-gated)", async () => {
      mockExportDashboard.mockClear();
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: false as const,
        mode: "none" as const,
        status: 401 as const,
        error: "Authentication required.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );
      expect(response.status).toBe(401);
      expect(mockExportDashboard).not.toHaveBeenCalled();
    });

    it("returns 403 when authenticated but not admin", async () => {
      mockExportDashboard.mockClear();
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: true as const,
        mode: "simple-key" as const,
        user: { id: "u1", label: "test@test.com", mode: "simple-key" as const, role: "member" as const, activeOrganizationId: "org-1" },
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );
      expect(response.status).toBe(403);
      expect(mockExportDashboard).not.toHaveBeenCalled();
    });

    it("returns 400 invalid_parameters when an override fails its declared type", async () => {
      mockExportDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "invalid_parameters",
        message: 'Parameter "since" expects a date (YYYY-MM-DD), got "not-a-date".',
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf", parameters: { since: "not-a-date" } }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("invalid_parameters");
      expect(typeof body.requestId).toBe("string");
    });

    it("returns a PDF attachment with the partial header on success (default format)", async () => {
      mockExportDashboard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: "atlas-session=abc" },
          // No `format` field — handler defaults to PDF.
          body: JSON.stringify({ parameters: { region: "us" } }),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toContain("attachment");
      expect(response.headers.get("content-disposition")).toContain(".pdf");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-atlas-export-partial")).toBe("0");
      // Observability metadata — the mock reports durationMs: 12 for PDF.
      expect(response.headers.get("x-atlas-export-duration-ms")).toBe("12");

      // Forwards identity + cookie + format + the caller's current parameters.
      const call = mockExportDashboard.mock.calls[0]![0]!;
      expect(call).toMatchObject({
        dashboardId: VALID_ID,
        userId: "u1",
        orgId: "org-1",
        format: "pdf",
        parameters: { region: "us" },
        cookieHeader: "atlas-session=abc",
      });

      const body = new Uint8Array(await response.arrayBuffer());
      // "%PDF-" magic
      expect(body[0]).toBe(0x25);
      expect(body[1]).toBe(0x50);
    });

    it("returns a PNG attachment when format=png is requested", async () => {
      mockExportDashboard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "png" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-disposition")).toContain(".png");
      const call = mockExportDashboard.mock.calls[0]![0]!;
      expect(call.format).toBe("png");
    });

    it("surfaces a partial render via the X-Atlas-Export-Partial header", async () => {
      mockExportDashboard.mockResolvedValueOnce({
        ok: true,
        format: "pdf",
        bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
        contentType: "application/pdf",
        filename: "demo-20260604-120000.pdf",
        title: "Demo",
        partial: true,
        durationMs: 30,
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-atlas-export-partial")).toBe("1");
    });

    it("attaches CORS expose-headers to the raw export response (readable cross-origin)", async () => {
      // A handler-returned raw Response does NOT inherit the middleware's
      // `c.header()` CORS headers, so the route must spread them on. Without
      // this, a cross-origin deploy can't read the file, and the browser never
      // exposes X-Atlas-Export-Partial / Content-Disposition to JS (#3222).
      mockExportDashboard.mockResolvedValueOnce({
        ok: true,
        format: "pdf",
        bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
        contentType: "application/pdf",
        filename: "demo-20260604-120000.pdf",
        title: "Demo",
        partial: false,
        durationMs: 30,
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );

      expect(response.status).toBe(200);
      const expose = response.headers.get("access-control-expose-headers") ?? "";
      expect(expose).toContain("X-Atlas-Export-Partial");
      expect(expose).toContain("Content-Disposition");
    });

    it("returns 404 when the dashboard is not in the caller's org", async () => {
      mockExportDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "dashboard_not_found",
        message: "Dashboard not found.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("not_found");
      expect(typeof body.requestId).toBe("string");
    });

    it("returns 503 not_available + Retry-After when the internal DB is unavailable", async () => {
      mockExportDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "no_db",
        message: "Dashboard export requires an internal database.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("not_available");
      expect(typeof body.requestId).toBe("string");
    });

    it("returns 503 dashboard_unavailable + Retry-After when the lookup fails (not a 404)", async () => {
      // Load-bearing: an infra outage during lookup must NOT masquerade as a
      // 404 (missing dashboard) or a 500 (render bug).
      mockExportDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "dashboard_unavailable",
        message: "Could not load the dashboard for export. The database may be temporarily unavailable — try again.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("dashboard_unavailable");
      expect(typeof body.requestId).toBe("string");
    });

    it("returns 503 when the headless browser is not installed", async () => {
      mockExportDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "browser_unavailable",
        message: "Headless browser is not installed in this deployment. Dashboard export is disabled.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );
      expect(response.status).toBe(503);
      // browser_unavailable is a permanent deploy-config condition — unlike the
      // transient 503s it must NOT carry Retry-After.
      expect(response.headers.get("retry-after")).toBeNull();
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("browser_unavailable");
      expect(typeof body.requestId).toBe("string");
    });

    it("returns 504 with requestId + Retry-After when the export times out", async () => {
      mockExportDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "export_timeout",
        message: "Dashboard export timed out. Try again, or reduce the number of tiles on the dashboard.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );
      expect(response.status).toBe(504);
      expect(response.headers.get("retry-after")).toBe("5");
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("export_timeout");
      expect(typeof body.requestId).toBe("string");
    });

    it("returns 500 with requestId when render_failed bubbles up", async () => {
      mockExportDashboard.mockResolvedValueOnce({
        ok: false,
        reason: "render_failed",
        message: "Could not render the dashboard for export. Try again or simplify the dashboard.",
      });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "pdf" }),
        }),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("render_failed");
      expect(typeof body.requestId).toBe("string");
    });

    it("rejects an unknown format with a 422 (schema validation)", async () => {
      mockExportDashboard.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "svg" }),
        }),
      );
      // Body fails the `z.enum(["png","pdf"])` schema → validationHook → 422.
      expect(response.status).toBe(422);
      expect(mockExportDashboard).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // #4315 — draft-first editing spine. With drafts ON + a real user, every
  // direct-manipulation edit routes to the caller's DRAFT; nothing but publish
  // writes the published tables. Draft-aware execution runs the draft's SQL.
  // -------------------------------------------------------------------------
  describe("draft-first routing (#4315)", () => {
    const DASH_WITH_CARD = {
      ...mockDashboardData,
      cards: [mockCardData],
    };
    const draftView = {
      ...mockDashboardData,
      lastRefreshAt: null,
      nextRefreshAt: null,
      cards: [],
    };

    beforeEach(() => {
      // Parent auth already carries a real userId (u1) → CRUD edits route to
      // the per-user draft. That's exactly what this suite asserts.
      mockGetDashboard.mockResolvedValue({ ok: true, data: DASH_WITH_CARD });
      mockApplyEditToDraft.mockResolvedValue({
        ok: true,
        snapshot: {
          dashboardId: VALID_ID,
          title: "Revenue Dashboard",
          description: null,
          cards: [],
        },
        // Test fixture: `mockDashboardData` carries `cardCount` (a list-view
        // field) and the route only echoes the view back, so cast at the
        // boundary rather than reconstruct the full wire type.
        view: draftView as unknown as Extract<ApplyEditResult, { ok: true }>["view"],
      });
    });

    it("PATCH /:id routes a rename to the draft, never the published table", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Renamed" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(mockApplyEditToDraft).toHaveBeenCalledTimes(1);
      const [, , change] = mockApplyEditToDraft.mock.calls[0] as unknown as [
        string,
        unknown,
        { kind: string; title?: string },
      ];
      expect(change).toMatchObject({ kind: "updateMeta", title: "Renamed" });
      // The published title was NOT touched.
      expect(mockUpdateDashboard).not.toHaveBeenCalled();
    });

    it("POST /:id/cards stages the new card into the draft (published addCard not called)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "New card",
            sql: "SELECT 1",
            chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
          }),
        }),
      );
      expect(response.status).toBe(201);
      expect(mockApplyEditToDraft).toHaveBeenCalledTimes(1);
      const [, , change] = mockApplyEditToDraft.mock.calls[0] as unknown as [
        string,
        unknown,
        { kind: string; card?: { title: string; sql: string } },
      ];
      expect(change.kind).toBe("addCard");
      expect(change.card).toMatchObject({ title: "New card", sql: "SELECT 1" });
      expect(mockAddCard).not.toHaveBeenCalled();
    });

    // #4318 — a text card creates via REST into the draft: content carried,
    // sql = '' (a text card never touches the SQL pipeline).
    it("POST /:id/cards stages a TEXT card into the draft with content + empty sql (#4318)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Section", kind: "text", content: "## Funnel" }),
        }),
      );
      expect(response.status).toBe(201);
      expect(mockApplyEditToDraft).toHaveBeenCalledTimes(1);
      const [, , change] = mockApplyEditToDraft.mock.calls[0] as unknown as [
        string,
        unknown,
        { kind: string; card?: { content?: string | null; sql: string } },
      ];
      expect(change.kind).toBe("addCard");
      expect(change.card).toMatchObject({ content: "## Funnel", sql: "" });
      expect(mockAddCard).not.toHaveBeenCalled();
    });

    // #4318 — a card-SQL edit routes to the draft's updateCard change.
    it("PATCH /:id/cards/:cardId routes a SQL edit to the draft updateCard change (#4318)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 42" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(mockApplyEditToDraft).toHaveBeenCalledTimes(1);
      const [, , change] = mockApplyEditToDraft.mock.calls[0] as unknown as [
        string,
        unknown,
        { kind: string; cardId: string; updates: { sql?: string } },
      ];
      expect(change).toMatchObject({ kind: "updateCard", cardId: VALID_CARD_ID });
      expect(change.updates).toMatchObject({ sql: "SELECT 42" });
      expect(mockUpdateCard).not.toHaveBeenCalled();
    });

    it("PATCH /:id/cards/:cardId updates the draft card (published updateCard not called)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Edited" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(mockApplyEditToDraft).toHaveBeenCalledTimes(1);
      const [, , change] = mockApplyEditToDraft.mock.calls[0] as unknown as [
        string,
        unknown,
        { kind: string; cardId: string; updates: { title?: string } },
      ];
      expect(change).toMatchObject({ kind: "updateCard", cardId: VALID_CARD_ID });
      expect(change.updates).toMatchObject({ title: "Edited" });
      expect(mockUpdateCard).not.toHaveBeenCalled();
    });

    it("DELETE /:id/cards/:cardId removes from the draft (published removeCard not called)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);
      expect(mockApplyEditToDraft).toHaveBeenCalledTimes(1);
      const [, , change] = mockApplyEditToDraft.mock.calls[0] as unknown as [
        string,
        unknown,
        { kind: string; cardId: string },
      ];
      expect(change).toMatchObject({ kind: "removeCard", cardId: VALID_CARD_ID });
      expect(mockRemoveCard).not.toHaveBeenCalled();
    });

    it("returns 503 and never publishes when the draft store is unavailable", async () => {
      mockApplyEditToDraft.mockResolvedValueOnce({ ok: false, reason: "no_db" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "New card",
            sql: "SELECT 1",
            chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
          }),
        }),
      );
      expect(response.status).toBe(503);
      // Critically: it did NOT silently fall back to writing published.
      expect(mockAddCard).not.toHaveBeenCalled();
    });

    // #4325 — async refresh-on-publish. The route promotes definitions, returns
    // `refreshingCardIds`, and ENQUEUES a background refresh scoped to exactly
    // the changed cards. It must never block the response on query execution.
    it("POST /:id/draft/publish returns refreshingCardIds and enqueues the async refresh scoped to them", async () => {
      mockPublishDraft.mockResolvedValueOnce({
        ok: true,
        opsApplied: 2,
        refreshCardIds: ["card-1", "card-2"],
      });
      mockRefreshDashboardCards.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/draft/publish`, { method: "POST" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { refreshingCardIds: string[] };
      expect(body.refreshingCardIds).toEqual(["card-1", "card-2"]);
      // Refresh enqueued exactly once, scoped to the changed cards.
      expect(mockRefreshDashboardCards).toHaveBeenCalledTimes(1);
      const [dashId, opts] = mockRefreshDashboardCards.mock.calls[0] as [
        string,
        { onlyCardIds: Set<string> },
      ];
      expect(dashId).toBe(VALID_ID);
      expect([...opts.onlyCardIds].sort()).toEqual(["card-1", "card-2"]);
    });

    it("POST /:id/draft/publish does NOT enqueue a refresh when no card data changed", async () => {
      mockPublishDraft.mockResolvedValueOnce({ ok: true, opsApplied: 1, refreshCardIds: [] });
      mockRefreshDashboardCards.mockClear();
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/draft/publish`, { method: "POST" }),
      );
      expect(response.status).toBe(200);
      expect(mockRefreshDashboardCards).not.toHaveBeenCalled();
    });

    // The fire-and-forget refresh must be caught (logged, not thrown) — a failed
    // refresh leaves tiles stale + retryable, it never fails the publish.
    it("POST /:id/draft/publish still returns 200 when the async refresh rejects", async () => {
      mockPublishDraft.mockResolvedValueOnce({ ok: true, opsApplied: 1, refreshCardIds: ["card-1"] });
      mockRefreshDashboardCards.mockRejectedValueOnce(new Error("refresh boom"));
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/draft/publish`, { method: "POST" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("render?view=draft executes the DRAFT card's SQL, not the published SQL", async () => {
      mockLoadDraft.mockResolvedValue({
        userId: "u1",
        dashboardId: VALID_ID,
        snapshot: {
          dashboardId: VALID_ID,
          title: "Revenue Dashboard",
          description: null,
          cards: [
            {
              id: VALID_CARD_ID,
              position: 0,
              title: "Total Revenue",
              sql: "SELECT draft_only_sql",
              chartConfig: null,
              connectionGroupId: null,
              layout: null,
            },
          ],
        },
        baseline: {
          dashboardId: VALID_ID,
          title: "Revenue Dashboard",
          description: null,
          cards: [],
        },
        publishedBaselineAt: mockDashboardData.updatedAt,
        createdAt: mockDashboardData.updatedAt,
        updatedAt: mockDashboardData.updatedAt,
      });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?view=draft`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parameters: {} }),
          },
        ),
      );
      expect(response.status).toBe(200);
      expect(mockRunUserQueryPipeline).toHaveBeenCalled();
      const runArg = mockRunUserQueryPipeline.mock.calls[0][0];
      expect(runArg.sql).toBe("SELECT draft_only_sql");
    });

    it("refresh?view=draft runs the draft SQL and does NOT persist to the published cache", async () => {
      mockLoadDraft.mockResolvedValue({
        userId: "u1",
        dashboardId: VALID_ID,
        snapshot: {
          dashboardId: VALID_ID,
          title: "Revenue Dashboard",
          description: null,
          cards: [
            {
              id: VALID_CARD_ID,
              position: 0,
              title: "Total Revenue",
              sql: "SELECT draft_refresh_sql",
              chartConfig: null,
              connectionGroupId: null,
              layout: null,
            },
          ],
        },
        baseline: {
          dashboardId: VALID_ID,
          title: "Revenue Dashboard",
          description: null,
          cards: [],
        },
        publishedBaselineAt: mockDashboardData.updatedAt,
        createdAt: mockDashboardData.updatedAt,
        updatedAt: mockDashboardData.updatedAt,
      });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/refresh?view=draft`,
          { method: "POST" },
        ),
      );
      expect(response.status).toBe(200);
      const runArg = mockRunUserQueryPipeline.mock.calls[0][0];
      expect(runArg.sql).toBe("SELECT draft_refresh_sql");
      // The invariant: a draft refresh never writes the published card cache.
      expect(mockRefreshCard).not.toHaveBeenCalled();
      // #4554 — the result persists to the caller's DRAFT CACHE (so it
      // survives a page reload), keyed by the holder + dashboard + card.
      expect(mockSaveDraftCardCache).toHaveBeenCalledTimes(1);
      expect(mockSaveDraftCardCache).toHaveBeenCalledWith("u1", VALID_ID, VALID_CARD_ID, {
        columns: ["month", "total"],
        rows: [{ month: "Jan", total: 1000 }],
      });
      const body = (await response.json()) as {
        id: string;
        cachedColumns: string[];
        cachedRows: Record<string, unknown>[];
        cachedAt: string | null;
      };
      expect(body.id).toBe(VALID_CARD_ID);
      expect(body.cachedColumns).toEqual(["month", "total"]);
      expect(body.cachedRows).toEqual([{ month: "Jan", total: 1000 }]);
      // The response's capture instant is the PERSISTED one — payload and
      // stored row can never disagree.
      expect(body.cachedAt).toBe("2026-07-16T00:00:00.000Z");
    });

    // #4554 — a draft-ONLY (never-published) card is fully operable: the draft
    // resolution runs BEFORE the published-card existence gate, so no 404.
    const draftOnlyRow = {
      userId: "u1",
      dashboardId: VALID_ID,
      snapshot: {
        dashboardId: VALID_ID,
        title: "Revenue Dashboard",
        description: null,
        cards: [
          {
            id: VALID_CARD_ID,
            position: 0,
            title: "Draft-only card",
            sql: "SELECT draft_only_card_sql",
            chartConfig: null,
            connectionGroupId: null,
            layout: null,
          },
        ],
      },
      baseline: { dashboardId: VALID_ID, title: "Revenue Dashboard", description: null, cards: [] },
      publishedBaselineAt: mockDashboardData.updatedAt,
      createdAt: mockDashboardData.updatedAt,
      updatedAt: mockDashboardData.updatedAt,
    };

    it("refresh?view=draft succeeds for a DRAFT-ONLY card — no 404 from the published gate (#4554)", async () => {
      mockLoadDraft.mockResolvedValue(draftOnlyRow);
      // The card does NOT exist in the published table.
      mockGetCard.mockResolvedValue({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/refresh?view=draft`,
          { method: "POST" },
        ),
      );
      expect(response.status).toBe(200);
      const runArg = mockRunUserQueryPipeline.mock.calls[0][0];
      expect(runArg.sql).toBe("SELECT draft_only_card_sql");
      // The override path never even consults the published-card gate.
      expect(mockGetCard).not.toHaveBeenCalled();
      // Persisted to the draft cache; the published cache untouched.
      expect(mockSaveDraftCardCache).toHaveBeenCalledTimes(1);
      expect(mockRefreshCard).not.toHaveBeenCalled();
    });

    it("render?view=draft succeeds for a DRAFT-ONLY card — no 404 from the published gate (#4554)", async () => {
      mockLoadDraft.mockResolvedValue(draftOnlyRow);
      mockGetCard.mockResolvedValue({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?view=draft`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parameters: {} }),
          },
        ),
      );
      expect(response.status).toBe(200);
      const runArg = mockRunUserQueryPipeline.mock.calls[0][0];
      expect(runArg.sql).toBe("SELECT draft_only_card_sql");
      expect(mockGetCard).not.toHaveBeenCalled();
      // Render is ephemeral — neither cache is written.
      expect(mockSaveDraftCardCache).not.toHaveBeenCalled();
      expect(mockRefreshCard).not.toHaveBeenCalled();
    });

    it("a caller WITHOUT the draft cannot execute a draft-only card — 404, nothing runs (#4554)", async () => {
      // view=draft but the caller has no draft row (loadDraft is keyed by the
      // CALLER's userId — another user's draft is structurally unreachable).
      mockLoadDraft.mockResolvedValue(null);
      mockGetCard.mockResolvedValue({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/refresh?view=draft`,
          { method: "POST" },
        ),
      );
      // Falls through to the published path → the card doesn't exist there →
      // "Card not found" now means not-in-draft-AND-not-published.
      expect(response.status).toBe(404);
      expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
      expect(mockSaveDraftCardCache).not.toHaveBeenCalled();
    });

    it("refresh?view=draft returns 409 draft_gone when the draft vanished mid-refresh (#4554)", async () => {
      mockLoadDraft.mockResolvedValue(draftOnlyRow);
      // The draft was published/discarded while the query ran — a client-state
      // race, not a server fault: distinct machine-readable code, not a 500.
      mockSaveDraftCardCache.mockResolvedValue({ ok: false, reason: "no_draft" });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/refresh?view=draft`,
          { method: "POST" },
        ),
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("draft_gone");
      expect(typeof body.requestId).toBe("string");
      expect(mockRefreshCard).not.toHaveBeenCalled();
    });

    it("refresh?view=draft returns 500 with requestId on a transient persist failure (#4554)", async () => {
      mockLoadDraft.mockResolvedValue(draftOnlyRow);
      mockSaveDraftCardCache.mockResolvedValue({ ok: false, reason: "error" });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/refresh?view=draft`,
          { method: "POST" },
        ),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string; requestId?: string };
      expect(body.error).toBe("internal_error");
      expect(typeof body.requestId).toBe("string");
      // Never silently return unpersisted rows as if they were saved.
      expect(mockRefreshCard).not.toHaveBeenCalled();
    });

    it("GET /:id/draft materializes the view from the DRAFT CACHE (#4554)", async () => {
      mockForkOrLoadDraft.mockResolvedValue(draftOnlyRow);
      mockLoadDraftCardCache.mockResolvedValue(
        new Map([
          [
            VALID_CARD_ID,
            {
              cachedColumns: ["month"],
              cachedRows: [{ month: "Mar" }],
              cachedAt: "2026-07-11T00:00:00.000Z",
            },
          ],
        ]),
      );
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/draft`),
      );
      expect(response.status).toBe(200);
      expect(mockLoadDraftCardCache).toHaveBeenCalledWith("u1", VALID_ID);
      const body = (await response.json()) as {
        view: {
          cards: Array<{
            cachedColumns: string[] | null;
            cachedRows: Record<string, unknown>[] | null;
            cachedAt: string | null;
          }>;
        };
      };
      expect(body.view.cards).toHaveLength(1);
      expect(body.view.cards[0].cachedColumns).toEqual(["month"]);
      expect(body.view.cards[0].cachedRows).toEqual([{ month: "Mar" }]);
      expect(body.view.cards[0].cachedAt).toBe("2026-07-11T00:00:00.000Z");
    });

    it("GET /:id?view=draft materializes card data from the DRAFT CACHE (#4554)", async () => {
      mockLoadDraft.mockResolvedValue(draftOnlyRow);
      mockLoadDraftCardCache.mockResolvedValue(
        new Map([
          [
            VALID_CARD_ID,
            {
              cachedColumns: ["month"],
              cachedRows: [{ month: "Feb" }],
              cachedAt: "2026-07-10T00:00:00.000Z",
            },
          ],
        ]),
      );
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}?view=draft`),
      );
      expect(response.status).toBe(200);
      expect(mockLoadDraftCardCache).toHaveBeenCalledWith("u1", VALID_ID);
      const body = (await response.json()) as {
        cards: Array<{
          id: string;
          cachedColumns: string[] | null;
          cachedRows: Record<string, unknown>[] | null;
          cachedAt: string | null;
        }>;
      };
      expect(body.cards).toHaveLength(1);
      expect(body.cards[0].cachedColumns).toEqual(["month"]);
      expect(body.cards[0].cachedRows).toEqual([{ month: "Feb" }]);
      expect(body.cards[0].cachedAt).toBe("2026-07-10T00:00:00.000Z");
    });

    it("render?view=draft 404s when the card was removed in the draft (never runs published)", async () => {
      // A draft exists, but its snapshot no longer contains VALID_CARD_ID.
      mockLoadDraft.mockResolvedValue({
        userId: "u1",
        dashboardId: VALID_ID,
        snapshot: { dashboardId: VALID_ID, title: "Revenue Dashboard", description: null, cards: [] },
        baseline: { dashboardId: VALID_ID, title: "Revenue Dashboard", description: null, cards: [] },
        publishedBaselineAt: mockDashboardData.updatedAt,
        createdAt: mockDashboardData.updatedAt,
        updatedAt: mockDashboardData.updatedAt,
      });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?view=draft`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parameters: {} }),
          },
        ),
      );
      expect(response.status).toBe(404);
      // Critically: it did NOT silently run the published card under the draft view.
      expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
    });

    it("refresh?view=draft 404s when the card was removed in the draft", async () => {
      mockLoadDraft.mockResolvedValue({
        userId: "u1",
        dashboardId: VALID_ID,
        snapshot: { dashboardId: VALID_ID, title: "Revenue Dashboard", description: null, cards: [] },
        baseline: { dashboardId: VALID_ID, title: "Revenue Dashboard", description: null, cards: [] },
        publishedBaselineAt: mockDashboardData.updatedAt,
        createdAt: mockDashboardData.updatedAt,
        updatedAt: mockDashboardData.updatedAt,
      });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/refresh?view=draft`,
          { method: "POST" },
        ),
      );
      expect(response.status).toBe(404);
      expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
    });

    it("CSV export with view=draft streams the DRAFT card's data", async () => {
      mockLoadDraft.mockResolvedValue({
        userId: "u1",
        dashboardId: VALID_ID,
        snapshot: {
          dashboardId: VALID_ID,
          title: "Revenue Dashboard",
          description: null,
          cards: [
            {
              id: VALID_CARD_ID,
              position: 0,
              title: "Total Revenue",
              sql: "SELECT draft_csv_sql",
              chartConfig: null,
              connectionGroupId: null,
              layout: null,
            },
          ],
        },
        baseline: { dashboardId: VALID_ID, title: "Revenue Dashboard", description: null, cards: [] },
        publishedBaselineAt: mockDashboardData.updatedAt,
        createdAt: mockDashboardData.updatedAt,
        updatedAt: mockDashboardData.updatedAt,
      });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}/render?format=csv&view=draft`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parameters: {} }),
          },
        ),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/csv");
      // The CSV ran the DRAFT SQL, not the published SQL.
      const runArg = mockRunUserQueryPipeline.mock.calls[0][0];
      expect(runArg.sql).toBe("SELECT draft_csv_sql");
    });

    it("PATCH /:id with ONLY parameters writes the live row (never the draft)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: [{ key: "region", type: "text", label: "Region" }] }),
        }),
      );
      expect(response.status).toBe(200);
      // Parameters are operational metadata (ADR-0029) — they stay on the live
      // row and NEVER route to the draft snapshot.
      expect(mockUpdateDashboard).toHaveBeenCalledTimes(1);
      expect(mockApplyEditToDraft).not.toHaveBeenCalled();
    });

    it("PATCH /:id with {title, parameters} splits: title→draft, parameters→live row", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Renamed",
            parameters: [{ key: "region", type: "text", label: "Region" }],
          }),
        }),
      );
      expect(response.status).toBe(200);
      // parameters → live row
      expect(mockUpdateDashboard).toHaveBeenCalledTimes(1);
      const [, , updates] = mockUpdateDashboard.mock.calls[0] as unknown as [
        string,
        unknown,
        { parameters?: unknown; title?: string },
      ];
      expect(updates).toHaveProperty("parameters");
      expect(updates).not.toHaveProperty("title");
      // title → draft
      expect(mockApplyEditToDraft).toHaveBeenCalledTimes(1);
      const [, , change] = mockApplyEditToDraft.mock.calls[0] as unknown as [
        string,
        unknown,
        { kind: string; title?: string },
      ];
      expect(change).toMatchObject({ kind: "updateMeta", title: "Renamed" });
    });

    it("maps applyEditToDraft unknown_card → 404 and save_failed → 500", async () => {
      mockApplyEditToDraft.mockResolvedValueOnce({ ok: false, reason: "unknown_card", cardId: VALID_CARD_ID });
      const r404 = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Edited" }),
        }),
      );
      expect(r404.status).toBe(404);

      mockApplyEditToDraft.mockResolvedValueOnce({ ok: false, reason: "save_failed" });
      const r500 = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards/${VALID_CARD_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Edited" }),
        }),
      );
      expect(r500.status).toBe(500);
    });

    it("maps applyEditToDraft load_failed → 500 (transient, distinct from no_db 503)", async () => {
      mockApplyEditToDraft.mockResolvedValueOnce({ ok: false, reason: "load_failed" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "New card",
            sql: "SELECT 1",
            chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
          }),
        }),
      );
      expect(response.status).toBe(500);
      expect(mockAddCard).not.toHaveBeenCalled();
    });

  });

  // #4555 — the single-edit-mechanism undo route. Destructive bound-editor ops
  // apply straight to the draft; the UI POSTs the inverse edit here.
  describe("POST /:id/draft/undo (#4555)", () => {
    const DASH_WITH_CARD = { ...mockDashboardData, cards: [mockCardData] };
    const draftView = {
      ...mockDashboardData,
      lastRefreshAt: null,
      nextRefreshAt: null,
      cards: [],
    };
    const restoreCard = {
      id: VALID_CARD_ID,
      position: 0,
      title: "Total Revenue",
      sql: "SELECT SUM(amount) FROM orders",
      chartConfig: { type: "bar", categoryColumn: "month", valueColumns: ["total"] },
      connectionGroupId: null,
      layout: null,
    };

    beforeEach(() => {
      mockGetDashboard.mockResolvedValue({ ok: true, data: DASH_WITH_CARD });
      mockLoadDraft.mockResolvedValue(null);
      mockApplyEditToDraft.mockResolvedValue({
        ok: true,
        snapshot: { dashboardId: VALID_ID, title: "Revenue Dashboard", description: null, cards: [] },
        view: draftView as unknown as Extract<ApplyEditResult, { ok: true }>["view"],
      });
    });

    it("restore_card re-adds the removed card via an addCard draft edit (204)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/draft/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "restore_card", card: restoreCard }),
        }),
      );
      expect(response.status).toBe(204);
      expect(mockApplyEditToDraft).toHaveBeenCalledTimes(1);
      const [, , change] = mockApplyEditToDraft.mock.calls[0] as unknown as [
        string,
        unknown,
        { kind: string; card?: { id: string; sql: string; content: unknown; annotations: unknown } },
      ];
      expect(change.kind).toBe("addCard");
      // Same id → the card's lingering draft-cache rows are revived on restore.
      expect(change.card).toMatchObject({ id: VALID_CARD_ID, sql: "SELECT SUM(amount) FROM orders" });
      // Optional fields defaulted so the snapshot card is well-formed.
      expect(change.card?.content).toBeNull();
      expect(change.card?.annotations).toEqual([]);
    });

    it("restore_card is idempotent — a card already in the draft is a no-op (no re-add)", async () => {
      mockLoadDraft.mockResolvedValue({
        snapshot: { dashboardId: VALID_ID, title: "x", description: null, cards: [{ id: VALID_CARD_ID }] },
      } as unknown as Awaited<ReturnType<typeof mockLoadDraft>>);
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/draft/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "restore_card", card: restoreCard }),
        }),
      );
      expect(response.status).toBe(204);
      // The card was already present → no duplicate-id addCard.
      expect(mockApplyEditToDraft).not.toHaveBeenCalled();
    });

    it("revert_sql restores the prior SQL via an updateCard draft edit (204)", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/draft/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "revert_sql", cardId: VALID_CARD_ID, sql: "SELECT 1" }),
        }),
      );
      expect(response.status).toBe(204);
      expect(mockApplyEditToDraft).toHaveBeenCalledTimes(1);
      const [, , change] = mockApplyEditToDraft.mock.calls[0] as unknown as [
        string,
        unknown,
        { kind: string; cardId: string; updates: { sql?: string } },
      ];
      expect(change).toMatchObject({ kind: "updateCard", cardId: VALID_CARD_ID });
      expect(change.updates).toMatchObject({ sql: "SELECT 1" });
    });

    it("rejects an invalid dashboard id (400) without touching the draft", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/not-a-uuid/draft/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "revert_sql", cardId: VALID_CARD_ID, sql: "SELECT 1" }),
        }),
      );
      expect(response.status).toBe(400);
      expect(mockApplyEditToDraft).not.toHaveBeenCalled();
    });

    it("refuses when the dashboard is not readable (cross-org probe guard) without applying", async () => {
      // getDashboard runs BEFORE the draft write, so an out-of-org / missing
      // dashboard 404s here rather than leaking existence via the draft path.
      mockGetDashboard.mockResolvedValue({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/draft/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "revert_sql", cardId: VALID_CARD_ID, sql: "SELECT 1" }),
        }),
      );
      expect(response.status).toBe(404);
      expect(mockApplyEditToDraft).not.toHaveBeenCalled();
    });

    it("maps an applyEditToDraft unknown_card failure to 404", async () => {
      mockApplyEditToDraft.mockResolvedValue({ ok: false, reason: "unknown_card", cardId: VALID_CARD_ID });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/dashboards/${VALID_ID}/draft/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "revert_sql", cardId: VALID_CARD_ID, sql: "SELECT 1" }),
        }),
      );
      expect(response.status).toBe(404);
    });
  });
});
