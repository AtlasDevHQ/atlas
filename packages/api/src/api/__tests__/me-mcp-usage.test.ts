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
 *
 * Also hosts the `/api/v1/me/mcp-prompts` suite, formerly
 * `me-mcp-prompts.test.ts` — same router, byte-identical
 * `createApiTestMocks` config, disjoint `mock.module` targets.
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

interface CapturedAuditEntry {
  actionType: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
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

const auditCalls: CapturedAuditEntry[] = [];

// Mock the oauth-clients helper module wholesale (CLAUDE.md "Mock all
// exports" — listOAuthClients is one of several exports the route layer
// or its dependants might pull).
void mock.module("@atlas/api/lib/auth/oauth-clients", () => ({
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

// Re-export ADMIN_ACTIONS, errorMessage, and causeToError from the
// canonical audit module so this mock factory stays in lockstep with
// the real one — me-load-test.ts (and any future module loaded by
// the test app boot) imports `errorMessage` from the same path, and
// a partial mock would surface as a `SyntaxError: Export named
// 'errorMessage' not found` (CLAUDE.md "Mock all exports").
import { ADMIN_ACTIONS } from "../../lib/audit/actions";
import { errorMessage, causeToError } from "../../lib/audit/error-scrub";

interface CapturableAuditEntry {
  actionType: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

function capture(entry: CapturableAuditEntry): void {
  auditCalls.push({
    actionType: entry.actionType,
    ...(entry.targetType !== undefined ? { targetType: entry.targetType } : {}),
    ...(entry.targetId !== undefined ? { targetId: entry.targetId } : {}),
    ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
  });
}

void mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS,
  errorMessage,
  causeToError,
  logAdminAction: (entry: CapturableAuditEntry) => capture(entry),
  logAdminActionAwait: async (entry: CapturableAuditEntry) => capture(entry),
}));


// ---------------------------------------------------------------------------
// `/api/v1/me/mcp-prompts` — formerly `me-mcp-prompts.test.ts` (#2179).
//
// Merged here because it drives the same `/api/v1/me/*` router with a
// byte-identical `createApiTestMocks` config, and its only `mock.module` target
// (`@atlas/mcp/prompts/listing`) is disjoint from this file's
// (`lib/auth/oauth-clients`, `lib/audit`) — neither route reaches the other's
// mocked module, so one shared mock set serves both suites.
//
// The HTTP endpoint and the MCP server's `prompts/list` handler both delegate
// to `listMcpPrompts` in `@atlas/mcp/prompts/listing` so the Settings → AI
// Agents preview block can show what an agent will see without round-tripping
// through MCP. These tests pin:
//
//   - 200 returns `{ prompts, canonicalGate }` shape, source bucketed
//   - canonicalGate envelope present + reason key when gated off
//   - Workspace isolation: route hands `user.activeOrganizationId` to the
//     listing module; cross-workspace bleed would require the route to read a
//     different field
//   - 401 unauth, 200-empty when no active org, 500 with requestId on listing
//     failure
//
// The mock replaces `@atlas/mcp/prompts/listing` wholesale — listing.ts has its
// own unit tests in packages/mcp; this file proves the route forwards correctly
// without re-exercising the registry / gating / scanner stack.
// ---------------------------------------------------------------------------

interface CapturedPromptListCall {
  workspaceId?: string;
}

const promptListCalls: CapturedPromptListCall[] = [];

let mockPromptListResult: {
  prompts: Array<{
    name: string;
    description?: string;
    arguments: Array<{ name: string; description: string; required: boolean }>;
    source: "builtin" | "canonical" | "semantic" | "library";
  }>;
  canonicalGate: {
    exposed: boolean;
    toggle: "always" | "never" | "auto";
    reason: "toggle-never" | "no-demo-signal" | "signal-unavailable" | null;
  };
} = {
  prompts: [],
  canonicalGate: { exposed: false, toggle: "auto", reason: "no-demo-signal" },
};

let mockPromptListThrow: Error | null = null;

// CLAUDE.md "Mock all exports": registry.ts imports BUILTIN_TEMPLATES /
// loadSemanticPrompts / loadLibraryPrompts from this same module path,
// and the API server's startup `try { import("@atlas/mcp/hosted") }`
// transitively loads registry — a partial mock here would surface as a
// `SyntaxError: Export named '<x>' not found` in the index startup log
// (visible but non-fatal) and could break unrelated test files that
// share the loader cache.
void mock.module("@atlas/mcp/prompts/listing", () => ({
  listMcpPrompts: async (opts: { workspaceId?: string }) => {
    promptListCalls.push({ ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {})});
    if (mockPromptListThrow) throw mockPromptListThrow;
    return mockPromptListResult;
  },
  BUILTIN_TEMPLATES: [],
  loadSemanticPrompts: () => [],
  loadLibraryPrompts: async () => [],
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
    // Forensic-pivot fields: a refactor that swapped `targetId` to
    // the org id (a plausible "improvement") would silently break the
    // "show me every per-user usage peek" admin query that filters on
    // `target_type = 'mcp_session' AND actor_id = target_id`.
    expect(usageRows[0]?.targetType).toBe("mcp_session");
    expect(usageRows[0]?.targetId).toBe("user-1");
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

beforeEach(() => {
  promptListCalls.length = 0;
  mockPromptListThrow = null;
});

// ---------------------------------------------------------------------------
// GET /api/v1/me/mcp-prompts
// ---------------------------------------------------------------------------

describe("GET /api/v1/me/mcp-prompts", () => {
  it("returns the prompt list shape with source bucketing and gate envelope", async () => {
    mockPromptListResult = {
      prompts: [
        {
          name: "revenue-trend",
          description: "Revenue trends",
          arguments: [
            { name: "period", description: "p", required: true },
          ],
          source: "builtin",
        },
        {
          name: "canonical-monthly-revenue",
          description: "Canonical: monthly revenue",
          arguments: [],
          source: "canonical",
        },
        {
          name: "entity-orders-monthly",
          description: "Monthly orders",
          arguments: [],
          source: "semantic",
        },
        {
          name: "library-1",
          description: "[Adoption] Adoption?",
          arguments: [],
          source: "library",
        },
      ],
      canonicalGate: { exposed: true, toggle: "always", reason: null },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as typeof mockPromptListResult;
    expect(body.prompts.map((p) => p.name)).toEqual([
      "revenue-trend",
      "canonical-monthly-revenue",
      "entity-orders-monthly",
      "library-1",
    ]);
    expect(body.canonicalGate).toEqual({
      exposed: true,
      toggle: "always",
      reason: null,
    });

    // Source counts surface 1-1 from listMcpPrompts so the preview block
    // can group without re-deriving from name prefixes.
    const counts = body.prompts.reduce<Record<string, number>>((acc, p) => {
      acc[p.source] = (acc[p.source] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({
      builtin: 1,
      canonical: 1,
      semantic: 1,
      library: 1,
    });

    // Discriminated-union arms reach the wire: the builtin entry keeps
    // its arg metadata, every derived entry lands as `arguments: []`.
    // A regression that flattened the route's narrowing would surface
    // here as `arguments: undefined` on the derived arms.
    const builtin = body.prompts.find((p) => p.source === "builtin");
    expect(builtin?.arguments).toEqual([
      { name: "period", description: "p", required: true },
    ]);
    for (const source of ["canonical", "semantic", "library"] as const) {
      const entry = body.prompts.find((p) => p.source === source);
      expect(entry?.arguments).toEqual([]);
    }
  });

  it("forwards the caller's active workspace id to listMcpPrompts", async () => {
    mockPromptListResult = {
      prompts: [],
      canonicalGate: { exposed: false, toggle: "auto", reason: "no-demo-signal" },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);
    expect(promptListCalls).toHaveLength(1);
    expect(promptListCalls[0]?.workspaceId).toBe("org-alpha");
  });

  it("does NOT leak prompts across workspaces — workspaceId is the active org, not a query param", async () => {
    // Cross-tenant probe attempt: the route signature has no body / query
    // for `workspaceId`. Even if a regression added one, the test would
    // fail because `promptListCalls[0].workspaceId` must equal the auth user's
    // activeOrganizationId, not the smuggled value.
    const res = await app.fetch(
      meRequest("/api/v1/me/mcp-prompts?workspaceId=org-beta"),
    );
    expect(res.status).toBe(200);
    expect(promptListCalls[0]?.workspaceId).toBe("org-alpha");
    expect(promptListCalls[0]?.workspaceId).not.toBe("org-beta");
  });

  it("includes the gate envelope with reason='toggle-never' when canonical prompts are gated off", async () => {
    mockPromptListResult = {
      prompts: [
        {
          name: "revenue-trend",
          description: "Revenue trends",
          arguments: [],
          source: "builtin",
        },
      ],
      canonicalGate: { exposed: false, toggle: "never", reason: "toggle-never" },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof mockPromptListResult;
    expect(body.canonicalGate.exposed).toBe(false);
    expect(body.canonicalGate.toggle).toBe("never");
    expect(body.canonicalGate.reason).toBe("toggle-never");
    // Closed gate hides canonical entries — the UI banner replaces them.
    expect(body.prompts.filter((p) => p.source === "canonical")).toEqual([]);
  });

  it("includes the gate envelope with reason='no-demo-signal' on auto without demo signals", async () => {
    mockPromptListResult = {
      prompts: [],
      canonicalGate: { exposed: false, toggle: "auto", reason: "no-demo-signal" },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof mockPromptListResult;
    expect(body.canonicalGate).toEqual({
      exposed: false,
      toggle: "auto",
      reason: "no-demo-signal",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        status: 401,
        error: "Authentication required",
      }),
    );

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(401);
    expect(promptListCalls).toHaveLength(0);
  });

  it("returns an empty payload when the user has no active organization (graceful)", async () => {
    // No active org: the listing pipeline still runs (built-ins are
    // workspace-independent), but canonical gate fails closed because the
    // demo signals require a workspaceId. The listing module already
    // tolerates `workspaceId: undefined`; the route forwards it as-is.
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "user@test.com",
          role: "member",
          // no activeOrganizationId
        },
      }),
    );

    mockPromptListResult = {
      prompts: [],
      canonicalGate: { exposed: false, toggle: "auto", reason: "no-demo-signal" },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);
    expect(promptListCalls[0]?.workspaceId).toBeUndefined();
  });

  it("ignores a smuggled `workspaceId` query param even when the user has no active org", async () => {
    // Defense-in-depth for tenant isolation. The route reads
    // `user.activeOrganizationId` directly today, so a `?workspaceId=`
    // query param has no effect — but a future regression that fell
    // back to `c.req.query("workspaceId")` when `activeOrganizationId`
    // is undefined would tenant-bleed canonical prompts to anyone who
    // could guess an org id. This test pins the contract: an unbound
    // user always forwards `undefined`, never the smuggled value.
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

    const res = await app.fetch(
      meRequest("/api/v1/me/mcp-prompts?workspaceId=org-victim"),
    );
    expect(res.status).toBe(200);
    expect(promptListCalls[0]?.workspaceId).toBeUndefined();
    expect(promptListCalls[0]?.workspaceId).not.toBe("org-victim");
  });

  it("forwards the new 'signal-unavailable' reason when canonical gate probes error", async () => {
    // Distinguishes the operator-facing internal-DB outage signal from
    // "this isn't a demo workspace." The route is a passthrough so this
    // is mostly a wire-compat check — the Zod schema must accept the
    // new enum value end-to-end.
    mockPromptListResult = {
      prompts: [],
      canonicalGate: {
        exposed: false,
        toggle: "auto",
        reason: "signal-unavailable",
      },
    };

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof mockPromptListResult;
    expect(body.canonicalGate.reason).toBe("signal-unavailable");
  });

  it("returns 500 with requestId when listMcpPrompts throws", async () => {
    mockPromptListThrow = new Error("scanEntities exploded");

    const res = await app.fetch(meRequest("/api/v1/me/mcp-prompts"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();
  });
});
