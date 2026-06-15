/**
 * Wizard two-phase generate (#3621 AC#6) — E2E through the mock-LLM test layer.
 *
 * The main `wizard.test.ts` suite mocks `enrichEntityYaml`/`enrichSemanticLayer`
 * to no-ops, so it pins the route dispatch but never drives the LLM enrich phase.
 * This file complements it: it exercises the TWO-PHASE flow for a PLUGIN dbType
 * (ClickHouse) through `createAiModelTestLayer`'s mock LLM —
 *
 *   1. MECHANICAL generate (`/wizard/generate`) — no LLM call (the mock model's
 *      `doGenerate` MUST NOT fire).
 *   2. COST-GATED enrich (`/wizard/enrich`) — the REAL `enrichEntityYaml` runs
 *      `generateText({ model })` against the mock-LLM-test-layer model and merges
 *      the returned YAML.
 *
 * The model the route enriches with comes from `getModel()`; here that returns
 * the `AtlasAiModel` layer's mock `LanguageModel` (built via
 * `createAiModelTestLayer`), so the enrich phase is genuinely driven through the
 * Effect AI seam — not a `mock.module` stub of the enrich engine.
 *
 * Unlike `wizard.test.ts`, this file does NOT mock `@atlas/api/lib/semantic/enrich`
 * (the real engine runs) and resolves the model through the AI test layer.
 */

import { describe, expect, it, beforeEach, mock, type Mock } from "bun:test";
import { Effect, Layer } from "effect";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { createConnectionMock } from "@atlas/api/testing/connection";

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

// --- The mock LLM, resolved THROUGH createAiModelTestLayer (AC#6). ----------
// The enrichment prompt asks for description/use_cases/query_patterns; the mock
// returns a usable YAML block so the real `enrichEntityYaml` merges + reports
// `enriched: true`. `doGenerate` records its calls so the mechanical phase can
// assert the LLM never fired during /generate.
const ENRICH_RESPONSE =
  "```yaml\ndescription: |\n  Enriched by the mock LLM: ClickHouse orders.\nuse_cases:\n  - Analyze order volume over time\n```";

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

// Build the AtlasAiModel test layer with our working mock model, then resolve
// the model out of it synchronously so the (HTTP-shaped, non-Effect) wizard
// route's `getModel()` returns the SAME model the layer provides.
const { createAiModelTestLayer, AtlasAiModel } = await import("@atlas/api/lib/effect/ai");
const aiTestLayer = createAiModelTestLayer({ model: mockModel as unknown as LanguageModel });
const layerModel = await Effect.runPromise(
  Effect.gen(function* () {
    const ai = yield* AtlasAiModel;
    return ai.model;
  }).pipe(Effect.provide(aiTestLayer)),
);

// --- Module mocks the wizard route needs (no enrich-engine stub). -----------

const mockConnectionHas: Mock<(id: string) => boolean> = mock(
  (id: string) => id === "analytics" || id === "default",
);
const mockConnectionDescribe: Mock<() => Array<{ id: string; dbType: string; status: string }>> = mock(
  () => [{ id: "analytics", dbType: "clickhouse", status: "healthy" }],
);

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      has: mockConnectionHas,
      describe: mockConnectionDescribe,
    },
    detectDBType: (url?: string) => {
      const connStr = url ?? "";
      if (connStr.startsWith("postgresql://") || connStr.startsWith("postgres://")) return "postgres";
      if (connStr.startsWith("clickhouse://")) return "clickhouse";
      throw new Error("Unsupported database URL scheme");
    },
  }),
);

// A ClickHouse install: internal DB returns the encrypted-config row the wizard
// resolver decrypts. `decryptSecret`/`decryptSecretFields` pass values through.
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>> = mock(
  async () => [
    {
      config: { url: "clickhouse://localhost:8123/analytics", schema: "default" },
      schema_name: "default",
      config_schema: null,
    },
  ],
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
  internalQuery: mockInternalQuery,
  internalExecute: () => {},
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

const mockAuthenticate = mock(() =>
  Promise.resolve({
    authenticated: true,
    mode: "managed",
    user: {
      id: "user-1",
      mode: "managed",
      label: "admin@test.com",
      role: "admin",
      activeOrganizationId: "org-1",
    },
  }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticate,
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "managed",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
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

mock.module("@atlas/api/lib/semantic/entities", () => ({
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

mock.module("@atlas/api/lib/semantic/sync", () => ({
  syncEntityToDisk: async () => {},
  syncEntityDeleteFromDisk: async () => {},
  syncAllEntitiesToDisk: async () => 0,
  getSemanticRoot: () => "/tmp/test-semantic",
  reconcileAllOrgs: async () => {},
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({ dispatchHook: async () => {} }));

mock.module("@atlas/api/lib/settings", () => ({
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

mock.module("@atlas/api/lib/security", () => ({
  getSecurityHeaders: () => ({}),
  applySecurityHeaders: () => {},
}));

// Providers — `getModel()` returns the mock-LLM-test-layer model so the REAL
// enrich engine's `generateText({ model })` calls our `doGenerate` (AC#6). No
// missing config so the route's enrichment-availability gate passes.
import * as _providersActual from "@atlas/api/lib/providers";
mock.module("@atlas/api/lib/providers", () => ({
  ..._providersActual,
  getModel: () => layerModel,
  getModelFromWorkspaceConfig: () => layerModel,
  getMissingModelConfig: () => ({ provider: "anthropic", missing: [] as string[] }),
}));

// Enterprise layer — no per-workspace BYOT, fall through to the env provider.
import * as _enterpriseLayerActual from "@atlas/api/lib/effect/enterprise-layer";
mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  ..._enterpriseLayerActual,
  runEnterprise: async () => null,
}));

// Profiler seam — a ClickHouse plugin capability. The profiler is MECHANICAL
// (returns a fixed profile, makes NO LLM call); the wizard's generate/enrich
// routes call it, and only /enrich additionally invokes the LLM enrich engine.
const mockProfile = mock(async () => ({
  profiles: [
    {
      table_name: "orders",
      object_type: "table" as const,
      row_count: 100,
      columns: [
        {
          name: "id",
          type: "UInt64",
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
const mockListObjects = mock(async () => [{ name: "orders", type: "table" }]);

// One profiler home (#3657): the wizard resolves a LIVE connection whose
// introspection is bound to its creds. The clickhouse install resolves to a
// connection exposing the (mock) listObjects/profile capability.
mock.module("@atlas/api/lib/datasources/wizard-connection", () => ({
  resolveWizardConnection: async () => ({
    kind: "ok" as const,
    dbType: "clickhouse",
    querySchema: "default",
    connection: {
      dbType: "clickhouse",
      connectionGroupId: null,
      query: async () => ({ columns: [], rows: [] as Record<string, unknown>[] }),
      listObjects: mockListObjects,
      profile: mockProfile,
      close: async () => {},
    },
  }),
}));

// --- Import after mocks ---

const { wizard } = await import("../routes/wizard");
const { OpenAPIHono } = await import("@hono/zod-openapi");
import { validationHook } from "../routes/validation-hook";

const app = new OpenAPIHono({ defaultHook: validationHook });
app.route("/api/v1/wizard", wizard);

function postJson(path: string, body: Record<string, unknown>) {
  return app.request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("wizard two-phase generate via the mock-LLM test layer (#3621 AC#6, clickhouse)", () => {
  beforeEach(() => {
    mockProfile.mockClear();
    mockListObjects.mockClear();
    mockModel.doGenerateCalls.length = 0;
  });

  it("phase 1 — mechanical generate emits entity YAML and makes NO LLM call", async () => {
    const res = await postJson("/api/v1/wizard/generate", {
      connectionId: "analytics",
      tables: ["orders"],
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.dbType).toBe("clickhouse");
    const entities = data.entities as { tableName: string; yaml: string }[];
    expect(entities.length).toBe(1);
    expect(entities[0].tableName).toBe("orders");
    // Mechanical: the profiler ran, but the LLM (mock model) did NOT.
    expect(mockProfile).toHaveBeenCalledTimes(1);
    expect(mockModel.doGenerateCalls.length).toBe(0);
  });

  it("phase 2 — cost-gated enrich drives the REAL engine through the mock LLM", async () => {
    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "analytics",
      tableName: "orders",
      yaml: "table: orders\n",
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.tableName).toBe("orders");
    // The real enrich engine merged the mock LLM's YAML → enriched: true.
    expect(data.enriched).toBe(true);
    expect(typeof data.yaml).toBe("string");
    expect(data.yaml as string).toContain("Enriched by the mock LLM");
    // The enrich phase re-profiled (plugin seam) AND called the mock LLM exactly
    // once — the two-phase flow's LLM step genuinely ran through the AI test layer.
    expect(mockProfile).toHaveBeenCalledTimes(1);
    expect(mockModel.doGenerateCalls.length).toBe(1);
  });

  it("the AtlasAiModel test layer is the model source (sanity: layer resolves our mock)", async () => {
    // Belt-and-suspenders: the model the route enriches with is the SAME object
    // the createAiModelTestLayer Layer provides (AC#6 wires the LLM through it).
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* AtlasAiModel;
        return ai.model;
      }).pipe(Effect.provide(Layer.merge(aiTestLayer, Layer.empty))),
    );
    expect(resolved).toBe(layerModel);
  });
});
