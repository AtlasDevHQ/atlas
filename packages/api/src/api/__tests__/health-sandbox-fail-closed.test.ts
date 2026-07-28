/**
 * #4828 — `/api/health` must report a fail-closed sandbox as an OUTAGE, not as a
 * healthy-but-unsandboxed `just-bash` deploy.
 *
 * `deploy/api/atlas.config.ts` pins `priority: ["vercel-sandbox"]` with no
 * `just-bash`, so staging and all three prod regions are PINNED fail-closed
 * (the posture, not the outage — the distinction this file exists to keep). Drop
 * `VERCEL_TOKEN` on one regional service — a per-service Railway secret that
 * shared vars do not inherit — and explore throws on every request. Health used
 * to describe that region as `backend: "just-bash"`, `isolated: false`,
 * `sandbox.status: "degraded"`: a working deployment with weak isolation, which
 * is the precise opposite of a totally broken one.
 *
 * Separate from health.test.ts because Bun's mock.module() is process-global and
 * irreversible — this file needs `getExploreBackendType()` to return
 * "fail-closed" instead of "just-bash".
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
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Mocks (must register before importing the app) ---

const mockValidateEnvironment: Mock<() => Promise<{ message: string; code: string }[]>> =
  mock(() => Promise.resolve([]));

const mockGetStartupWarnings: Mock<() => string[]> = mock(() => []);

void mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mockValidateEnvironment,
  getStartupWarnings: mockGetStartupWarnings,
}));

void mock.module("@atlas/api/lib/db/connection", () => {
  const mockDBConn = {
    query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
    close: async () => {},
  };
  return createConnectionMock({
    getDB: () => mockDBConn,
    connections: {
      get: () => mockDBConn,
      getDefault: () => mockDBConn,
      list: () => [],
      describe: () => [],
      getForOrg: () => mockDBConn,
    },
    resolveDatasourceUrl: () => process.env.ATLAS_DATASOURCE_URL || null,
  });
});

void mock.module("@atlas/api/lib/providers", () => ({
  getDefaultProvider: () => "anthropic",
  // demo.ts (mounted via the app) statically imports getModelForConfig — it
  // must be present so the mock links, even though the anthropic default
  // resolves no demo override and never calls it. (#3931)
  getModelForConfig: () => ({ model: {}, providerType: "anthropic", modelId: "claude-test" }),
}));

void mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["companies"]),
  _resetWhitelists: () => {},
}));

// Key mock: the resolver reports that NO backend will construct.
void mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "fail-closed",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
}));

void mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: {
    name: "createJiraTicket",
    description: "Mock",
    tool: { type: "function" },
    actionType: "jira:create",
    reversible: true,
    defaultApproval: "manual",
    requiredCredentials: ["JIRA_BASE_URL"],
  },
  sendEmailReport: {
    name: "sendEmailReport",
    description: "Mock",
    tool: { type: "function" },
    actionType: "email:send",
    reversible: false,
    defaultApproval: "admin-only",
    requiredCredentials: ["RESEND_API_KEY"],
  },
}));

void mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  persistAssistantSteps: mock(() => {}),
  // F-77 step-cap helpers — chat.ts imports both via @atlas/api/lib/conversations.
  reserveConversationBudget: mock(() => Promise.resolve({ status: 'ok' as const, totalStepsBefore: 0 })),
  settleConversationSteps: mock(() => {}),
  getConversation: mock(() => Promise.resolve(null)),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve(false)),
  starConversation: async () => false,
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  resolveGroupForConnection: mock(() => Promise.resolve(null)),
  verifyGroupBelongsToOrg: mock(() => Promise.resolve("ok")),
  // #4351 — the single conversation-scope write path. No-op success by
  // default; tests that exercise a picker toggle override locally.
  updateConversationScope: mock(() => Promise.resolve({ ok: true as const })),
}));

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() =>
    Promise.resolve({
      authenticated: true as const,
      mode: "none" as const,
      user: undefined,
    }),
  ),
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
}));

// Import after all mocks are registered
const { app } = await import("../index");

// --- Tests ---

describe("GET /api/health — fail-closed sandbox (#4828)", () => {
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.DATABASE_URL;
    mockValidateEnvironment.mockReset();
    mockValidateEnvironment.mockResolvedValue([]);
    mockGetStartupWarnings.mockReset();
    mockGetStartupWarnings.mockReturnValue([]);
  });

  afterEach(() => {
    if (origDatasource !== undefined) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
  });

  async function health(): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await app.fetch(new Request("http://localhost/api/health"));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("names fail-closed rather than collapsing it into just-bash", async () => {
    const { body } = await health();
    const explore = (body.checks as Record<string, unknown>).explore as Record<string, unknown>;

    expect(explore.backend).toBe("fail-closed");
    // Not `true`. Nothing unsandboxed runs, so `true` is arguably defensible —
    // but this is the field monitors alert on, and a totally broken explore tool
    // must not read as green.
    expect(explore.isolated).toBe(false);
  });

  it("reports the sandbox component as down, not degraded", async () => {
    const { body } = await health();
    const sandbox = (body.components as Record<string, unknown>).sandbox as Record<
      string,
      unknown
    >;

    // `degraded` was the old answer and it means "weakened but working".
    expect(sandbox.status).toBe("down");
    expect(sandbox.backend).toBe("fail-closed");
    expect(String(sandbox.message)).toContain("refused");
    // The old message actively misdescribed the deployment.
    expect(String(sandbox.message)).not.toContain("No sandbox isolation");
  });

  it("promotes the top-level status to degraded without 503-ing the region", async () => {
    const { status, body } = await health();

    // A silent `ok` was the reporting failure: the region looked healthy while
    // explore was 100% down.
    expect(body.status).toBe("degraded");
    // But NOT `error`. 503 pulls the region out of the load balancer, and that
    // path is reserved for the datasource / SaaS internal DB (#1981). Chat, SQL
    // and every other route still serve correctly here — one broken tool is not
    // grounds for taking the region down.
    expect(status).toBe(200);
  });
});
