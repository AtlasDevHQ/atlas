/**
 * Billing-enforcement suite for the wizard `/enrich` route (#4489).
 *
 * `POST /api/v1/wizard/enrich` runs `generateText` (real platform-token LLM
 * spend, metered against the workspace budget via `logUsageEvent`), so it must
 * consult the shared billing gate (`checkAgentBillingGate`, #3419/#3420) BEFORE
 * the model runs — exactly like the semantic-improve chat route (#3437). Pre-fix
 * the wizard had no billing references at all: a suspended / trial-expired /
 * over-budget workspace admin could burn platform tokens through the per-table
 * enrich loop, unmetered.
 *
 * Mirrors `admin-semantic-improve-billing.test.ts`: a mutable gate verdict drives
 * each block arm (403 / 429 / 429+Retry-After / 503) and asserts the mock LLM
 * NEVER fired and nothing was metered; the allowed arm asserts the LLM ran once
 * and a `token` usage event was recorded against the workspace budget.
 *
 * Harness is adapted from `wizard-enrich-mock-llm.test.ts` — the route is driven
 * end-to-end (auth → resolver → model → enrich engine) with the enrich model
 * resolved through the AtlasAiModel test layer, so the gate wiring is exercised
 * against the real route rather than a stub.
 */

import { describe, expect, it, beforeEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { createConnectionMock } from "@atlas/api/testing/connection";

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

// --- Mock LLM resolved through the AtlasAiModel test layer -------------------

const ENRICH_RESPONSE =
  "```yaml\ndescription: |\n  Enriched by the mock LLM.\nuse_cases:\n  - Analyze volume over time\n```";

const mockModel = new MockLanguageModelV3({
  doGenerate: async (_options: LanguageModelV3CallOptions) => ({
    content: [{ type: "text" as const, text: ENRICH_RESPONSE }],
    finishReason: { unified: "stop" as const, raw: "end_turn" },
    usage: {
      inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 30, text: 30, reasoning: 0 },
    },
    warnings: [],
  }),
});

const { createAiModelTestLayer, AtlasAiModel } = await import("@atlas/api/lib/effect/ai");
const aiTestLayer = createAiModelTestLayer({ model: mockModel as unknown as LanguageModel });
const layerModel = await Effect.runPromise(
  Effect.gen(function* () {
    const ai = yield* AtlasAiModel;
    return ai.model;
  }).pipe(Effect.provide(aiTestLayer)),
);

// --- Billing gate mock (#4489) — mutable verdict per test -------------------

type GateVerdict =
  | { allowed: true; warning?: unknown }
  | {
      allowed: false;
      errorCode: string;
      errorMessage: string;
      httpStatus: 403 | 404 | 429 | 503;
      retryable: boolean;
      retryAfterSeconds?: number;
      usage?: { currentUsage: number; limit: number; metric: string };
    };
let billingGateVerdict: GateVerdict = { allowed: true };
const mockCheckAgentBillingGate = mock(async (_orgId?: string) => billingGateVerdict);

void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mockCheckAgentBillingGate,
  BillingBlockedError: class BillingBlockedError extends Error {
    override readonly name = "BillingBlockedError";
  },
}));

// Metering spy — assert the token event on the allowed arm, and its ABSENCE on
// every block arm (the enrich never ran, so nothing is metered).
const mockLogUsageEvent = mock((_event: unknown) => {});
void mock.module("@atlas/api/lib/metering", () => ({
  logUsageEvent: mockLogUsageEvent,
  emitLoginEvent: async () => {},
  aggregateUsageSummary: async () => {},
  getCurrentPeriodUsage: async () => ({}),
  getUsageHistory: async () => [],
  getUsageBreakdown: async () => [],
}));

// --- Route collaborators ----------------------------------------------------

const mockConnectionHas: Mock<(id: string) => boolean> = mock(
  (id: string) => id === "analytics" || id === "default",
);
const mockConnectionDescribe: Mock<() => Array<{ id: string; dbType: string; status: string }>> = mock(
  () => [{ id: "analytics", dbType: "postgres", status: "healthy" }],
);

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      has: mockConnectionHas,
      describe: mockConnectionDescribe,
    },
    detectDBType: () => "postgres",
  }),
);

// Captures every internalQuery SQL so a block-arm test can assert the LLM-profile
// run (#4509) is NEVER recorded when the gate blocks before spend.
const enrichInternalQuerySqls: string[] = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
  internalQuery: async (sql: string) => {
    enrichInternalQuerySqls.push(sql);
    return [];
  },
  internalExecute: () => {},
  isInternalCircuitOpen: () => false,
  encryptSecret: (url: string) => `encrypted:${url}`,
  decryptSecret: (url: string) => url,
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  isPlaintextUrl: () => true,
  getEncryptionKey: () => null,
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  _resetEncryptionKeyCache: () => {},
  closeInternalDB: async () => {},
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

// Mutable so one test can drop `activeOrganizationId` (the self-hosted /
// no-workspace path where the gate is a no-op and metering records null).
let authUser: Record<string, unknown> = {
  id: "user-1",
  mode: "managed",
  label: "admin@test.com",
  role: "admin",
  activeOrganizationId: "org-alpha",
};
const mockAuthenticate = mock(() =>
  Promise.resolve({ authenticated: true, mode: "managed", user: authUser }),
);

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticate,
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "managed",
  resetAuthModeCache: () => {},
}));

void mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(),
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  _resetWhitelists: () => {},
}));

void mock.module("@atlas/api/lib/semantic/entities", () => ({
  upsertProfileStatus: mock(() => Promise.resolve()),
  listIncompleteProfileLayers: mock(() => Promise.resolve([])),
  DEMO_CONNECTION_ID: "__demo__",
  SEMANTIC_ENTITY_STATUSES: ["published", "draft", "draft_delete", "archived"] as const,
  bulkUpsertEntities: async () => 0,
  resolveGroupIdForConnection: async () => null,
  upsertEntity: async () => {},
  upsertDraftEntity: async () => {},
  upsertTombstone: async () => {},
  deleteDraftEntity: async () => false,
  listEntityRows: async () => [],
  listEntities: async () => [],
  listEntitiesWithOverlay: async () => [],
  getEntity: async () => null,
  deleteEntity: async () => false,
  countEntities: async () => 0,
  createVersion: async () => "",
  listVersions: async () => [],
  getVersion: async () => null,
  generateChangeSummary: async () => "",
  applyTombstones: async () => 0,
  promoteDraftEntities: async () => 0,
  archiveSingleConnection: async () => ({ ok: true as const, archived: 0 }),
  restoreSingleConnection: async () => ({ ok: true as const, restored: 0 }),
}));

void mock.module("@atlas/api/lib/semantic/sync", () => ({
  syncEntityToDisk: async () => {},
  syncEntityDeleteFromDisk: async () => {},
  syncAllEntitiesToDisk: async () => 0,
  getSemanticRoot: () => "/tmp/test-semantic",
  reconcileAllOrgs: async () => {},
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

void mock.module("@atlas/api/lib/plugins/hooks", () => ({ dispatchHook: async () => {} }));

void mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  getSettingAuto: () => undefined,
  getSettingLive: async () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  getAllSettingOverrides: async () => [],
  loadSettings: async () => 0,
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  _resetSettingsCache: () => {},
}));

void mock.module("@atlas/api/lib/security", () => ({
  getSecurityHeaders: () => ({}),
  applySecurityHeaders: () => {},
}));

import * as _providersActual from "@atlas/api/lib/providers";
void mock.module("@atlas/api/lib/providers", () => ({
  ..._providersActual,
  getModel: () => layerModel,
  getModelFromWorkspaceConfig: () => layerModel,
  getMissingModelConfig: () => ({ provider: "anthropic", missing: [] as string[] }),
}));

import * as _enterpriseLayerActual from "@atlas/api/lib/effect/enterprise-layer";
void mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  ..._enterpriseLayerActual,
  runEnterprise: async () => null,
}));

// Profiler seam — mechanical (no LLM). The wizard's /enrich re-profiles the one
// table before invoking the LLM enrich engine.
const mockProfile = mock(async () => ({
  profiles: [
    {
      table_name: "orders",
      object_type: "table" as const,
      row_count: 100,
      columns: [
        {
          name: "id",
          type: "integer",
          nullable: false,
          unique_count: 100,
          null_count: 0,
          sample_values: [],
          is_primary_key: true,
          is_foreign_key: false,
          fk_target_table: null,
          fk_target_column: null,
          is_enum_like: false,
          profiler_notes: [],
        },
      ],
      primary_key_columns: ["id"],
      foreign_keys: [],
      inferred_foreign_keys: [],
      profiler_notes: [],
      table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    },
  ],
  errors: [],
}));

void mock.module("@atlas/api/lib/datasources/profiling-connection", () => ({
  resolveProfilingConnection: async () => ({
    kind: "ok" as const,
    dbType: "postgres",
    querySchema: "public",
    connection: {
      dbType: "postgres",
      connectionGroupId: null,
      query: async () => ({ columns: [], rows: [] as Record<string, unknown>[] }),
      listObjects: async () => [{ name: "orders", type: "table" }],
      profile: mockProfile,
      close: async () => {},
    },
  }),
}));

// --- Import after mocks -----------------------------------------------------

const { wizard } = await import("../routes/wizard");
const { OpenAPIHono } = await import("@hono/zod-openapi");
import { validationHook } from "../routes/validation-hook";

const app = new OpenAPIHono({ defaultHook: validationHook });
app.route("/api/v1/wizard", wizard);

function enrichRequest() {
  return app.request("http://localhost/api/v1/wizard/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId: "analytics", tableName: "orders", yaml: "table: orders\n" }),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  billingGateVerdict = { allowed: true };
  authUser = {
    id: "user-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  };
  mockCheckAgentBillingGate.mockClear();
  mockLogUsageEvent.mockClear();
  mockProfile.mockClear();
  mockModel.doGenerateCalls.length = 0;
  enrichInternalQuerySqls.length = 0;
});

// ---------------------------------------------------------------------------
// POST /api/v1/wizard/enrich — billing gate (#4489)
// ---------------------------------------------------------------------------

describe("POST /api/v1/wizard/enrich — billing gate (#4489)", () => {
  it("blocks a trial-expired workspace with 403 before the model runs", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "trial_expired",
      errorMessage: "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
      httpStatus: 403,
      retryable: false,
    };

    const res = await enrichRequest();

    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error).toBe("trial_expired");
    expect(body.message).toContain("trial has expired");
    expect(body.retryable).toBe(false);
    expect(typeof body.requestId).toBe("string");
    expect((body.requestId as string).length).toBeGreaterThan(0);
    // Gate consulted with the caller's workspace; the model + metering never ran.
    expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org-alpha");
    expect(mockModel.doGenerateCalls.length).toBe(0);
    expect(mockProfile).not.toHaveBeenCalled();
    expect(mockLogUsageEvent).not.toHaveBeenCalled();
    // #4509 — a blocked enrich spends nothing, so it records NO LLM-profile run
    // (a "enriched N days ago" stamp for a run that never happened would be a lie).
    expect(enrichInternalQuerySqls.some((sql) => sql.includes("connection_profile_state"))).toBe(false);
  });

  it("blocks a token-hard-cap workspace with 429 + usage before the model runs", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "plan_limit_exceeded",
      errorMessage: "You have used your full included usage credit.",
      httpStatus: 429,
      retryable: false,
      usage: { currentUsage: 23, limit: 20, metric: "usd" },
    };

    const res = await enrichRequest();

    expect(res.status).toBe(429);
    // A hard-cap block is NOT a transient throttle — no Retry-After, unlike the
    // abuse-throttle arm below (that distinction drives the client's retry UX).
    expect(res.headers.get("Retry-After")).toBeNull();
    const body = await json(res);
    expect(body.error).toBe("plan_limit_exceeded");
    expect(body.usage).toEqual({ currentUsage: 23, limit: 20, metric: "usd" });
    expect(mockModel.doGenerateCalls.length).toBe(0);
    expect(mockLogUsageEvent).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the gate itself THROWS (contract violation) — no spend, no bypass", async () => {
    // Distinct from the returned-block 503 above: here the gate REJECTS. The
    // route's Effect.tryPromise+either must catch it and surface the same shaped,
    // retry-guided 503 — never a generic 500, and never a silent bypass that
    // would let the LLM spend. A regression awaiting the gate directly would
    // bubble a 500 or skip the gate, and this is the only arm that catches it.
    mockCheckAgentBillingGate.mockImplementationOnce(async () => {
      throw new Error("billing lookup exploded");
    });

    const res = await enrichRequest();

    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.error).toBe("billing_check_failed");
    expect(body.retryable).toBe(true);
    expect(typeof body.requestId).toBe("string");
    expect(mockModel.doGenerateCalls.length).toBe(0);
    expect(mockProfile).not.toHaveBeenCalled();
    expect(mockLogUsageEvent).not.toHaveBeenCalled();
  });

  it("maps an abuse-throttle block to 429 with a Retry-After header", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "workspace_throttled",
      errorMessage: "Workspace is temporarily throttled due to high usage. Please retry shortly.",
      httpStatus: 429,
      retryable: true,
      retryAfterSeconds: 5,
    };

    const res = await enrichRequest();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = await json(res);
    expect(body.error).toBe("workspace_throttled");
    expect(body.retryable).toBe(true);
    expect(body.retryAfterSeconds).toBe(5);
    expect(mockModel.doGenerateCalls.length).toBe(0);
    expect(mockLogUsageEvent).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the billing check itself fails — try again, not upgrade", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "billing_check_failed",
      errorMessage: "Unable to verify billing status. Please try again.",
      httpStatus: 503,
      retryable: true,
    };

    const res = await enrichRequest();

    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.error).toBe("billing_check_failed");
    expect(body.retryable).toBe(true);
    expect(mockModel.doGenerateCalls.length).toBe(0);
    expect(mockLogUsageEvent).not.toHaveBeenCalled();
  });

  it("runs the enrich and meters token usage when the gate allows (allowed arm)", async () => {
    const res = await enrichRequest();

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enriched).toBe(true);
    // Gate ran once against the workspace, then the model ran.
    expect(mockCheckAgentBillingGate).toHaveBeenCalledTimes(1);
    expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org-alpha");
    expect(mockModel.doGenerateCalls.length).toBe(1);
    // Token usage (mock LLM: 50 in + 30 out) metered against the workspace budget
    // as a `token` event — the budget denominator checkPlanLimits enforces.
    expect(mockLogUsageEvent).toHaveBeenCalledTimes(1);
    const event = mockLogUsageEvent.mock.calls[0][0] as {
      eventType: string;
      quantity: number;
      workspaceId: string | null;
      userId: string | null;
      weightedQuantity?: number | null;
      metadata?: Record<string, unknown>;
    };
    expect(event.eventType).toBe("token");
    expect(event.quantity).toBe(80);
    expect(event.workspaceId).toBe("org-alpha");
    expect(event.userId).toBe("user-1");
    expect(typeof event.weightedQuantity).toBe("number");
    // Metadata is load-bearing for billing attribution — assert the source tag,
    // table, and the input/output split (not just the total).
    expect(event.metadata).toMatchObject({
      source: "wizard_enrich",
      tableName: "orders",
      input: 50,
      output: 30,
    });
    expect(typeof (event.metadata as Record<string, unknown>).model).toBe("string");
  });

  it("no workspace (self-hosted / no orgId) — gate no-ops, run 200s, metering records a null workspace", async () => {
    // Drop the active org: the gate is invoked with `undefined` (a no-op pass on
    // self-hosted), the enrich still runs, and the token event is recorded with
    // workspaceId null rather than crashing on an unguarded orgId deref.
    authUser = { id: "user-1", mode: "managed", label: "admin@test.com", role: "admin" };

    const res = await enrichRequest();

    expect(res.status).toBe(200);
    expect(mockCheckAgentBillingGate).toHaveBeenCalledWith(undefined);
    expect(mockModel.doGenerateCalls.length).toBe(1);
    expect(mockLogUsageEvent).toHaveBeenCalledTimes(1);
    const event = mockLogUsageEvent.mock.calls[0][0] as { workspaceId: string | null; quantity: number };
    expect(event.workspaceId).toBeNull();
    expect(event.quantity).toBe(80);
  });
});
