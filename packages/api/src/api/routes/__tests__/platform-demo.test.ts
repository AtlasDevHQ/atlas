/**
 * Platform demo tracking route integration tests (#3931).
 *
 * Covers config GET/PUT, leads rollup, transcript drill-in, and the
 * token/cache/latency metrics rollup end-to-end via a mounted Hono test app.
 * The Hono → Effect bridge is stubbed to inject RequestContext; `queryEffect`
 * and the demo config getters are stubbed per-test, so routes are exercised
 * without a real Postgres.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as crypto from "crypto";
import { Effect } from "effect";

// ── Mockable state ──────────────────────────────────────────────────

let hasDB = true;
type Stub = (
  sql: string,
  params: unknown[] | undefined,
) => Promise<Record<string, unknown>[]>;
let queryStub: Stub = async () => [];
let queryCalls: { sql: string; params: unknown[] | undefined }[] = [];

let demoConfig = {
  model: "",
  maxSteps: 10,
  rpm: 10,
  effectiveModel: "anthropic/claude-haiku-4.5" as string | null,
};

interface CapturedSetSetting {
  key: string;
  value: string;
}
let setSettingCalls: CapturedSetSetting[] = [];

interface CapturedAudit {
  actionType: string;
  targetType: string;
  targetId: string;
  scope?: string;
  metadata?: Record<string, unknown>;
}
let auditCalls: CapturedAudit[] = [];

// Real demoUserId hash so the leads/usage JS join keys line up.
function realDemoUserId(email: string): string {
  const normalized = email.toLowerCase().trim();
  const hash = crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
  return `demo:${hash}`;
}

// ── Mock side modules BEFORE importing the route ────────────────────

mock.module("@atlas/api/lib/db/internal", () => {
  const internalQuery = async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    return queryStub(sql, params);
  };
  return {
    hasInternalDB: () => hasDB,
    internalQuery,
    queryEffect: (sql: string, params?: unknown[]) =>
      Effect.tryPromise({
        try: () => internalQuery(sql, params),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }),
    getInternalDB: () => null,
    internalExecute: async () => undefined,
  };
});

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS: {
    settings: { update: "settings.update" },
  },
  logAdminAction: (entry: CapturedAudit) => {
    auditCalls.push(entry);
  },
  logAdminActionAwait: async (entry: CapturedAudit) => {
    auditCalls.push(entry);
  },
}));

mock.module("@atlas/api/lib/settings", () => ({
  setSetting: async (key: string, value: string) => {
    setSettingCalls.push({ key, value });
  },
  // Other consumers in the real import graph (e.g. effect/services) read these
  // lazily; stub the full surface so module load doesn't trip "Export not
  // found". The demo routes never call them (demo.ts is mocked above).
  getSettingAuto: () => undefined,
  getSetting: async () => undefined,
  getSettingSync: () => undefined,
  getSettingsForAdmin: () => [],
  getSettingDefinition: () => undefined,
  deleteSetting: async () => {},
  isSaasModeForGuard: () => false,
  invalidateSettingsCache: () => {},
  refreshSettingsCache: async () => {},
  SaasImmutableSettingError: class SaasImmutableSettingError extends Error {},
}));

// Mock the full demo.ts export surface (mock-all-exports). Only `demoUserId`
// (real hash, so the leads/usage join keys line up) and `getDemoConfig` are
// exercised by these routes; the rest are harmless stubs so nothing in the
// import graph resolves a demo export to `undefined`.
mock.module("@atlas/api/lib/demo", () => ({
  demoUserId: realDemoUserId,
  getDemoConfig: () => demoConfig,
  getDemoModelRaw: () => demoConfig.model,
  getDemoModelId: () => demoConfig.effectiveModel,
  getDemoMaxSteps: () => demoConfig.maxSteps,
  getDemoRpmLimit: () => demoConfig.rpm,
  isDemoEnabled: () => true,
  demoRunAgentModelParams: () => ({}),
  signDemoToken: () => "",
  verifyDemoToken: () => null,
  checkDemoRateLimit: async () => ({ allowed: true }),
  resetDemoRateLimits: async () => {},
  DEMO_CLEANUP_INTERVAL_MS: 60_000,
  demoCleanupTick: async () => {},
  captureDemoLead: async () => ({}),
  countDemoConversations: async () => 0,
}));

// Bypass the platform-admin auth + MFA middleware so we exercise handler
// logic, not auth plumbing (same passthrough pattern as platform-crm-outbox).
import { createMiddleware } from "hono/factory";
const passthrough = createMiddleware(async (_c, next) => {
  await next();
});

const middlewareMock = {
  adminAuth: passthrough,
  adminAuthAllowApiKey: passthrough,
  platformAdminAuth: passthrough,
  requestContext: passthrough,
  standardAuth: passthrough,
  withRequestId: passthrough,
};
mock.module("./routes/middleware", () => middlewareMock);
mock.module("../middleware", () => middlewareMock);
mock.module("@atlas/api/api/routes/middleware", () => middlewareMock);
mock.module("../admin-mfa-required", () => ({ mfaRequired: passthrough }));
mock.module("./routes/admin-mfa-required", () => ({ mfaRequired: passthrough }));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  getClientIP: () => "198.51.100.7",
  checkRateLimit: () => ({ allowed: true }),
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
  authenticateRequest: async () => ({
    authenticated: true,
    user: {
      id: "test-platform-admin",
      mode: "managed",
      label: "platform@test.com",
      role: "platform_admin",
      activeOrganizationId: "test-org",
    },
    mode: "managed",
  }),
  _setValidatorOverrides: () => {},
  _setSSOEnforcementOverride: () => {},
  _setAuditEnforcementBlockOverride: () => {},
}));

mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: async (
    _c: unknown,
    program: Effect.Effect<unknown, unknown, unknown>,
    _opts?: unknown,
  ) => {
    const services = await import("@atlas/api/lib/effect/services");
    const layer = services.createRequestContextTestLayer({
      requestId: "test-req-id",
    });
    return Effect.runPromise(
      (program as Effect.Effect<unknown, unknown, never>).pipe(
        Effect.provide(layer),
      ),
    );
  },
}));

// ── Import the route AFTER all mocks ────────────────────────────────

const { platformDemo } = await import("../platform-demo");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/platform/demo", platformDemo);

const BASE = "http://localhost/api/v1/platform/demo";

// ── Fixtures ────────────────────────────────────────────────────────

const ALICE = "alice@example.com";
const ALICE_UID = realDemoUserId(ALICE);

beforeEach(() => {
  hasDB = true;
  queryStub = async () => [];
  queryCalls = [];
  setSettingCalls = [];
  auditCalls = [];
  demoConfig = {
    model: "",
    maxSteps: 10,
    rpm: 10,
    effectiveModel: "anthropic/claude-haiku-4.5",
  };
});

afterEach(() => {
  queryCalls = [];
  setSettingCalls = [];
  auditCalls = [];
});

// ── GET /config ─────────────────────────────────────────────────────

describe("GET /config", () => {
  test("returns the resolved demo config", async () => {
    demoConfig = {
      model: "anthropic/claude-sonnet-4.6",
      maxSteps: 25,
      rpm: 5,
      effectiveModel: "anthropic/claude-sonnet-4.6",
    };
    const res = await app.request(`${BASE}/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      model: "anthropic/claude-sonnet-4.6",
      maxSteps: 25,
      rpm: 5,
      effectiveModel: "anthropic/claude-sonnet-4.6",
    });
  });

  test("404 when no internal DB", async () => {
    hasDB = false;
    const res = await app.request(`${BASE}/config`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_available");
  });
});

// ── PUT /config ─────────────────────────────────────────────────────

describe("PUT /config", () => {
  // `app.request` returns `Response | Promise<Response>`; an async wrapper
  // normalizes the union to a single awaited `Promise<Response>`.
  async function put(body: unknown): Promise<Response> {
    return app.request(`${BASE}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("writes all three settings + audits, returns resolved config", async () => {
    const res = await put({
      model: "anthropic/claude-haiku-4.5",
      maxSteps: 12,
      rpm: 8,
    });
    expect(res.status).toBe(200);
    const keys = setSettingCalls.map((s) => s.key).sort();
    expect(keys).toEqual([
      "ATLAS_DEMO_MAX_STEPS",
      "ATLAS_DEMO_MODEL",
      "ATLAS_DEMO_RATE_LIMIT_RPM",
    ]);
    const byKey = Object.fromEntries(setSettingCalls.map((s) => [s.key, s.value]));
    expect(byKey.ATLAS_DEMO_MODEL).toBe("anthropic/claude-haiku-4.5");
    expect(byKey.ATLAS_DEMO_MAX_STEPS).toBe("12");
    expect(byKey.ATLAS_DEMO_RATE_LIMIT_RPM).toBe("8");
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.actionType).toBe("settings.update");
    expect(auditCalls[0]?.scope).toBe("platform");
  });

  test("trims the model before persisting; blank clears the override", async () => {
    await put({ model: "   ", maxSteps: 10, rpm: 10 });
    const byKey = Object.fromEntries(setSettingCalls.map((s) => [s.key, s.value]));
    expect(byKey.ATLAS_DEMO_MODEL).toBe("");
  });

  test("response reflects the re-read resolved config, not the raw write", async () => {
    // The handler re-reads getDemoConfig() after writing so a blank model
    // resolves to effectiveModel (e.g. the gateway Haiku default). Pin that the
    // 200 body is the resolved config, not an echo of the request body.
    demoConfig = { model: "", maxSteps: 7, rpm: 4, effectiveModel: "resolved-sentinel" };
    const res = await put({ model: "", maxSteps: 7, rpm: 4 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { effectiveModel: string }).effectiveModel).toBe(
      "resolved-sentinel",
    );
  });

  test("422 on out-of-range maxSteps (validationHook)", async () => {
    const res = await put({ model: "", maxSteps: 9999, rpm: 10 });
    expect(res.status).toBe(422);
    expect(setSettingCalls).toHaveLength(0);
  });

  test("404 when no internal DB", async () => {
    hasDB = false;
    const res = await put({ model: "", maxSteps: 10, rpm: 10 });
    expect(res.status).toBe(404);
    expect(setSettingCalls).toHaveLength(0);
  });
});

// ── GET /leads ──────────────────────────────────────────────────────

describe("GET /leads", () => {
  function wireLeads(): void {
    queryStub = async (sql: string) => {
      if (sql.includes("FROM demo_leads") && sql.includes("ORDER BY last_active_at")) {
        return [
          {
            email: ALICE,
            session_count: 3,
            created_at: "2026-06-01T00:00:00.000Z",
            last_active_at: "2026-06-10T00:00:00.000Z",
          },
        ];
      }
      if (sql.includes("GROUP BY c.user_id, tu.model")) {
        return [
          {
            user_id: ALICE_UID,
            model: "anthropic/claude-haiku-4.5",
            provider: "gateway",
            turns: 2,
            prompt_tokens: "1000",
            completion_tokens: "200",
            cache_read_tokens: "0",
            cache_write_tokens: "0",
            avg_latency_ms: 1500,
            latency_count: 2,
          },
        ];
      }
      if (sql.includes("conversation_count")) {
        return [{ user_id: ALICE_UID, conversation_count: 1 }];
      }
      return [];
    };
  }

  test("joins per-email usage + cost + latency by hashed user id", async () => {
    wireLeads();
    const res = await app.request(`${BASE}/leads`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      leads: Array<{
        email: string;
        sessionCount: number;
        conversationCount: number;
        usage: {
          turns: number;
          promptTokens: number;
          completionTokens: number;
          avgLatencyMs: number | null;
          estimatedCostUsd: number | null;
        };
      }>;
    };
    expect(body.leads).toHaveLength(1);
    const lead = body.leads[0]!;
    expect(lead.email).toBe(ALICE);
    expect(lead.sessionCount).toBe(3);
    expect(lead.conversationCount).toBe(1);
    expect(lead.usage.turns).toBe(2);
    expect(lead.usage.promptTokens).toBe(1000);
    expect(lead.usage.completionTokens).toBe(200);
    expect(lead.usage.avgLatencyMs).toBe(1500);
    // Haiku: 1000 input * $1/MTok + 200 output * $5/MTok = $0.002.
    expect(lead.usage.estimatedCostUsd).toBeCloseTo(0.002, 9);
  });

  test("a lead with no demo turns reports a zeroed rollup", async () => {
    queryStub = async (sql: string) => {
      if (sql.includes("FROM demo_leads") && sql.includes("ORDER BY last_active_at")) {
        return [
          {
            email: ALICE,
            session_count: 1,
            created_at: "2026-06-01T00:00:00.000Z",
            last_active_at: "2026-06-01T00:00:00.000Z",
          },
        ];
      }
      return [];
    };
    const res = await app.request(`${BASE}/leads`);
    const body = (await res.json()) as {
      leads: Array<{ usage: { turns: number; estimatedCostUsd: number | null }; conversationCount: number }>;
    };
    expect(body.leads[0]!.usage.turns).toBe(0);
    expect(body.leads[0]!.usage.estimatedCostUsd).toBeNull();
    expect(body.leads[0]!.conversationCount).toBe(0);
  });

  test("404 when no internal DB", async () => {
    hasDB = false;
    const res = await app.request(`${BASE}/leads`);
    expect(res.status).toBe(404);
  });
});

// ── GET /metrics ────────────────────────────────────────────────────

describe("GET /metrics", () => {
  test("rolls up tokens/cache/latency + estimated cost, aggregate + per-model", async () => {
    queryStub = async (sql: string) => {
      if (sql.includes("GROUP BY tu.model, tu.provider")) {
        return [
          {
            user_id: "",
            model: "anthropic/claude-haiku-4.5",
            provider: "gateway",
            turns: 4,
            prompt_tokens: "2000",
            completion_tokens: "400",
            cache_read_tokens: "100",
            cache_write_tokens: "0",
            avg_latency_ms: 1200,
            latency_count: 4,
          },
        ];
      }
      if (sql.includes("lead_count")) {
        return [{ lead_count: 2, session_count: 7 }];
      }
      return [];
    };
    const res = await app.request(`${BASE}/metrics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      leadCount: number;
      sessionCount: number;
      totals: { turns: number; promptTokens: number; estimatedCostUsd: number | null; costComplete: boolean };
      perModel: Array<{ model: string | null; turns: number; estimatedCostUsd: number | null }>;
    };
    expect(body.leadCount).toBe(2);
    expect(body.sessionCount).toBe(7);
    expect(body.totals.turns).toBe(4);
    expect(body.totals.promptTokens).toBe(2000);
    expect(body.totals.costComplete).toBe(true);
    expect(body.totals.estimatedCostUsd).not.toBeNull();
    expect(body.perModel).toHaveLength(1);
    expect(body.perModel[0]!.model).toBe("anthropic/claude-haiku-4.5");
  });

  test("flags costComplete=false when a model is unpriced", async () => {
    queryStub = async (sql: string) => {
      if (sql.includes("GROUP BY tu.model, tu.provider")) {
        return [
          {
            user_id: "",
            model: "some-unknown-model",
            provider: "openai-compatible",
            turns: 1,
            prompt_tokens: "100",
            completion_tokens: "10",
            cache_read_tokens: "0",
            cache_write_tokens: "0",
            avg_latency_ms: null,
            latency_count: 0,
          },
        ];
      }
      if (sql.includes("lead_count")) {
        return [{ lead_count: 0, session_count: 0 }];
      }
      return [];
    };
    const res = await app.request(`${BASE}/metrics`);
    const body = (await res.json()) as {
      totals: { estimatedCostUsd: number | null; costComplete: boolean; avgLatencyMs: number | null };
    };
    expect(body.totals.costComplete).toBe(false);
    expect(body.totals.estimatedCostUsd).toBeNull();
    expect(body.totals.avgLatencyMs).toBeNull();
  });

  test("404 when no internal DB", async () => {
    hasDB = false;
    const res = await app.request(`${BASE}/metrics`);
    expect(res.status).toBe(404);
  });
});

// ── GET /transcript ─────────────────────────────────────────────────

describe("GET /transcript", () => {
  test("returns conversations with messages grouped, keyed by hashed email", async () => {
    const convId = "00000000-0000-4000-8000-000000000001";
    queryStub = async (sql: string, params) => {
      if (sql.includes("FROM conversations") && sql.includes("ORDER BY created_at DESC")) {
        // The email is hashed to the synthetic user id before querying.
        expect(params?.[0]).toBe(ALICE_UID);
        return [{ id: convId, title: "Demo chat", created_at: "2026-06-02T00:00:00.000Z" }];
      }
      if (sql.includes("FROM messages")) {
        return [
          { conversation_id: convId, role: "user", content: [{ type: "text", text: "hi" }], created_at: "2026-06-02T00:00:01.000Z" },
          { conversation_id: convId, role: "assistant", content: [{ type: "text", text: "hello" }], created_at: "2026-06-02T00:00:02.000Z" },
        ];
      }
      return [];
    };
    const res = await app.request(`${BASE}/transcript?email=${encodeURIComponent(ALICE)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      conversations: Array<{ id: string; messages: Array<{ role: string }> }>;
    };
    expect(body.email).toBe(ALICE);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("skips the messages query when the lead has no demo conversations", async () => {
    queryStub = async () => [];
    const res = await app.request(`${BASE}/transcript?email=${encodeURIComponent(ALICE)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations).toEqual([]);
    // Only the conversations query ran — no messages query for zero ids.
    expect(queryCalls.some((q) => q.sql.includes("FROM messages"))).toBe(false);
  });

  test("422 on a malformed email (validationHook)", async () => {
    const res = await app.request(`${BASE}/transcript?email=not-an-email`);
    expect(res.status).toBe(422);
  });

  test("404 when no internal DB", async () => {
    hasDB = false;
    const res = await app.request(`${BASE}/transcript?email=${encodeURIComponent(ALICE)}`);
    expect(res.status).toBe(404);
  });
});
