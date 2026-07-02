/**
 * Route-level tests for `admin-publish` — the atomic publish endpoint.
 *
 * The publish PHASES themselves are pinned by the content-mode registry tests
 * (`lib/content-mode/__tests__/registry.test.ts`) and the lib twin
 * (`lib/datasources/__tests__/mcp-lifecycle.test.ts`); here the registry is a
 * spy returning canned `PromotionReport[]`, so the assertions are about THIS
 * route's projection of the reports into the wire response (every promoted
 * surface — including `knowledgeDocuments`, v0.0.41), the audit metadata, and
 * the post-commit side effects (datasource reconcile, per-mode mirror bust).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { promotedCountsFromReports } from "@atlas/api/lib/content-mode/promoted";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

const CURRENT_ORG = "org-1";

// Canned per-table promotion reports the registry spy returns (mutable per test).
let REPORTS: Array<{ table: string; promoted: number; tombstonesApplied?: number }> = [];
// When set, runPublishPhases fails — exercises the rollback + 500 path.
let PHASES_THROW = false;

const txControl: string[] = [];
function fakeTxClient() {
  return {
    async query(sql: string): Promise<{ rows: unknown[] }> {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") txControl.push(sql);
      return { rows: [] };
    },
    release() {},
  };
}

const internalQuery = mock(async (): Promise<unknown[]> => []);
const reconcileCalls: string[] = [];
mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery }),
  getInternalDB: () => ({ connect: async () => fakeTxClient() }),
  reconcileWorkspaceDatasources: async (orgId: string) => {
    reconcileCalls.push(orgId);
    return { registered: 0, deregistered: 0 };
  },
}));

// Partial mock, justified: the route lazy-imports EXACTLY ONE symbol from
// `semantic/sync` (`invalidateOrgModeRoots`, the #4208 post-commit mirror
// bust) and nothing else in this file imports the module.
const invalidateCalls: string[] = [];
mock.module("@atlas/api/lib/semantic/sync", () => ({
  invalidateOrgModeRoots: (orgId: string) => {
    invalidateCalls.push(orgId);
  },
}));

mock.module("@atlas/api/lib/effect/hono", () => ({
  runHandler: async (_c: unknown, _label: string, fn: () => unknown) => fn(),
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const auditCalls: Array<{ actionType: string; metadata: Record<string, unknown> }> = [];
mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: { actionType: string; metadata: Record<string, unknown> }) => {
    auditCalls.push(entry);
  },
  ADMIN_ACTIONS: { mode: { publish: "mode.publish" } },
}));

// Partial mock, justified: this file's import graph reaches only the exports
// stubbed below (isolated runner; an unmocked export reached later fails
// loudly). The route projects reports → wire counts via the REAL
// `promotedCountsFromReports` (deep-path import stays unmocked) over a mini
// registry tuple that mirrors the production key↔table mapping — so these
// tests pin the actual projection, not a re-implementation of it.
mock.module("@atlas/api/lib/content-mode", () => ({
  CONTENT_MODE_TABLES: [
    { kind: "simple", key: "connections", table: "workspace_plugins" },
    { kind: "simple", key: "prompts", table: "prompt_collections" },
    { kind: "simple", key: "starterPrompts", table: "query_suggestions" },
    { kind: "simple", key: "knowledgeDocuments", table: "knowledge_documents" },
    { kind: "exotic", key: "semantic_entities", promotedKey: "entities" },
  ],
  promotedCountsFromReports,
  makeService: () => ({
    runPublishPhases: () =>
      Effect.try({
        try: () => {
          if (PHASES_THROW) throw new Error("phase boom");
          return REPORTS;
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }),
  }),
}));

mock.module("@atlas/api/lib/semantic/entities", () => ({
  archiveSingleConnection: async () => ({ status: "archived", entities: 0, prompts: 0 }),
  listIncompleteProfileLayers: async () => [],
  DEMO_CONNECTION_ID: "__demo__",
}));

mock.module("@atlas/api/lib/demo-industry", () => ({
  readDemoIndustry: () => ({ ok: true, value: null }),
}));

mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono(),
  requireOrgContext: () =>
    async (c: { set: (k: string, v: unknown) => void; get?: unknown }, next: () => Promise<void>) => {
      c.set("orgContext", { requestId: "test-req", orgId: CURRENT_ORG });
      c.set("authResult", { user: { id: "user-1" } });
      await next();
    },
}));

const { adminPublish } = await import("../admin-publish");

function publish(body: Record<string, unknown> = {}) {
  return adminPublish.request("/", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  REPORTS = [];
  PHASES_THROW = false;
  txControl.length = 0;
  reconcileCalls.length = 0;
  invalidateCalls.length = 0;
  auditCalls.length = 0;
  internalQuery.mockClear();
});

describe("POST /api/v1/admin/publish — promoted counts projection", () => {
  it("projects every per-table report into the wire response, knowledge included (#4206/v0.0.41)", async () => {
    REPORTS = [
      { table: "workspace_plugins", promoted: 1 },
      { table: "semantic_entities", promoted: 2, tombstonesApplied: 3 },
      { table: "prompt_collections", promoted: 4 },
      { table: "query_suggestions", promoted: 5 },
      { table: "knowledge_documents", promoted: 6 },
    ];
    const res = await publish();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      promoted: Record<string, number>;
      deleted: { entities: number };
    };
    expect(body.promoted).toEqual({
      connections: 1,
      entities: 2,
      prompts: 4,
      starterPrompts: 5,
      knowledgeDocuments: 6,
    });
    expect(body.deleted).toEqual({ entities: 3 });
    expect(txControl).toEqual(["BEGIN", "COMMIT"]);
  });

  it("a knowledge-documents-only publish is NOT reported as 'nothing promoted'", async () => {
    // A workspace whose only drafts are knowledge documents must not get back
    // an all-zero `promoted` block.
    REPORTS = [{ table: "knowledge_documents", promoted: 12 }];
    const res = await publish();
    const body = (await res.json()) as { promoted: Record<string, number> };
    expect(body.promoted.knowledgeDocuments).toBe(12);
    expect(Object.values(body.promoted).some((n) => n > 0)).toBe(true);
  });

  it("records every promoted surface in the audit metadata", async () => {
    REPORTS = [
      { table: "knowledge_documents", promoted: 7 },
      { table: "semantic_entities", promoted: 1, tombstonesApplied: 0 },
    ];
    const res = await publish();
    expect(res.status).toBe(200);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].metadata).toMatchObject({
      promotedKnowledgeDocuments: 7,
      promotedEntities: 1,
      promotedConnections: 0,
      promotedPrompts: 0,
      promotedStarterPrompts: 0,
    });
  });
});

describe("POST /api/v1/admin/publish — post-commit side effects (#3856 / #4208)", () => {
  it("reconciles datasources and busts the per-mode mirror after a committed publish", async () => {
    const res = await publish();
    expect(res.status).toBe(200);
    expect(reconcileCalls).toEqual([CURRENT_ORG]);
    expect(invalidateCalls).toEqual([CURRENT_ORG]);
  });

  it("rolls back and skips both side effects on a phase failure", async () => {
    PHASES_THROW = true;
    const res = await publish();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("publish_failed");
    expect(body.requestId).toBe("test-req");
    expect(txControl).toContain("ROLLBACK");
    expect(txControl).not.toContain("COMMIT");
    expect(reconcileCalls).toHaveLength(0);
    expect(invalidateCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });
});
