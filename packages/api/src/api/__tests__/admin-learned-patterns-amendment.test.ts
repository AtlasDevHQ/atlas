/**
 * Tests for the semantic_amendment YAML side-effect on the learned-patterns
 * approve paths (#3613).
 *
 * Approving a `type='semantic_amendment'` row — via the single PATCH route OR
 * the bulk-approve route — must rewrite the entity YAML through
 * `applyAmendmentToEntity` BEFORE the row's status flips to `approved`. The bug:
 * the bulk handler stamped `approved` with a raw UPDATE, so semantic amendments
 * went live in the DB while their YAML on disk + the in-memory layer stayed
 * stale until restart.
 *
 * These tests assert:
 *   1. bulk-approving a mix of query_pattern + semantic_amendment dispatches the
 *      YAML rewrite for ONLY the semantic row, with the inner `amendment` object
 *      (not the stored envelope);
 *   2. a failed YAML apply aborts the status update — the row never reaches
 *      `approved`;
 *   3. the single PATCH approve path applies the YAML side-effect too.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// --- Unified mocks ---

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
  },
});

// The approve paths delegate to the shared `applyAmendmentFromPayload` helper.
// Capture every invocation so each test can assert what the route dispatched
// (entity, group, raw payload). The helper's own envelope→AnalysisResult
// mapping — including pulling the INNER `amendment` object — is unit-tested in
// lib/semantic/expert/__tests__/apply-from-payload.test.ts. Default: resolve
// (apply succeeds); failure-path tests override the implementation.
const applyAmendmentFromPayload = mock(
  async (_params: {
    orgId: string | null;
    sourceEntity: string;
    connectionGroupId: string | null;
    rawPayload: unknown;
    requestId: string;
    label?: string;
  }): Promise<void> => {},
);

void mock.module("@atlas/api/lib/semantic/expert/apply", () => ({
  applyAmendmentFromPayload,
  // Other exports of the real module — keep them present so a transitive
  // `import { … }` never SyntaxErrors at load time.
  applyAmendmentToEntity: mock(async () => undefined),
  applyAmendment: mock((entity: Record<string, unknown>) => entity),
}));

// --- Import the app AFTER mocks ---

const { app } = await import("../index");

// --- Helpers ---

function req(method: string, urlPath: string, body?: unknown) {
  const url = `http://localhost/api/v1/admin/learned-patterns${urlPath}`;
  const init: RequestInit = { method, headers: { Authorization: "Bearer test" } };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}

/** Inner amendment object — the dimension that should land in the YAML. */
const INNER_AMENDMENT = { name: "region", sql: "region", type: "string", description: "Customer region" };

/** Full stored envelope, as written by proposeAmendment / the scheduler. */
const AMENDMENT_PAYLOAD = {
  entityName: "orders",
  amendmentType: "add_dimension",
  amendment: INNER_AMENDMENT,
  rationale: "Add a region dimension for geo breakdowns",
  category: "coverage_gaps",
  confidence: 0.9,
};

function semanticRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pat-sem",
    org_id: "org-1",
    type: "semantic_amendment",
    source_entity: "orders",
    connection_group_id: null,
    amendment_payload: AMENDMENT_PAYLOAD,
    status: "pending",
    ...overrides,
  };
}

function queryRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pat-query",
    org_id: "org-1",
    type: "query_pattern",
    pattern_sql: "SELECT COUNT(*) FROM orders",
    source_entity: "orders",
    amendment_payload: null,
    status: "pending",
    ...overrides,
  };
}

// --- Cleanup ---

afterAll(() => {
  mocks.cleanup();
});

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
  applyAmendmentFromPayload.mockReset();
  applyAmendmentFromPayload.mockImplementation(async () => {});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("learned-patterns semantic_amendment YAML side-effect (#3613)", () => {
  describe("POST /bulk", () => {
    it("applies the YAML rewrite for semantic_amendment rows and not query_pattern rows", async () => {
      // Per-id SELECT returns the matching row; UPDATE returns []. The handler
      // SELECTs `id, type, source_entity, amendment_payload, connection_group_id`.
      mocks.mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT")) {
          const id = (params?.[0] as string) ?? "";
          if (id === "pat-sem") return Promise.resolve([semanticRow()]);
          if (id === "pat-query") return Promise.resolve([queryRow()]);
          return Promise.resolve([]);
        }
        return Promise.resolve([]); // UPDATE
      });

      const res = await req("POST", "/bulk", { ids: ["pat-query", "pat-sem"], status: "approved" });
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.updated).toContain("pat-query");
      expect(body.updated).toContain("pat-sem");
      expect(body.errors).toBeUndefined();

      // The YAML rewrite was dispatched exactly once — for the semantic row only
      // — with the row's authoritative entity, group, and the raw payload (the
      // helper extracts the inner amendment; see apply-from-payload.test.ts).
      expect(applyAmendmentFromPayload).toHaveBeenCalledTimes(1);
      const [params] = applyAmendmentFromPayload.mock.calls[0];
      expect(params.orgId).toBe("org-1");
      expect(params.sourceEntity).toBe("orders");
      expect(params.connectionGroupId).toBeNull();
      expect(params.rawPayload).toEqual(AMENDMENT_PAYLOAD);
      expect(typeof params.requestId).toBe("string");
    });

    it("does NOT stamp approved when the YAML apply fails", async () => {
      applyAmendmentFromPayload.mockImplementation(async () => {
        throw new Error("entity not found");
      });

      const updateCalls: string[] = [];
      mocks.mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT")) {
          const id = (params?.[0] as string) ?? "";
          if (id === "pat-sem") return Promise.resolve([semanticRow()]);
          return Promise.resolve([]);
        }
        updateCalls.push(sql);
        return Promise.resolve([]);
      });

      const res = await req("POST", "/bulk", { ids: ["pat-sem"], status: "approved" });
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      // The failed apply is reported per-id; the row is NOT marked updated.
      expect(body.updated).not.toContain("pat-sem");
      expect(body.errors).toBeArray();
      expect(body.errors[0].id).toBe("pat-sem");
      // Critically: no UPDATE ran, so the row never reached status='approved'.
      expect(updateCalls.length).toBe(0);
    });

    it("does not invoke the YAML apply when bulk-rejecting a semantic_amendment", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT")) {
          const id = (params?.[0] as string) ?? "";
          if (id === "pat-sem") return Promise.resolve([semanticRow()]);
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const res = await req("POST", "/bulk", { ids: ["pat-sem"], status: "rejected" });
      expect(res.status).toBe(200);
      expect(applyAmendmentFromPayload).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /:id", () => {
    it("applies the YAML rewrite before updating status to approved", async () => {
      let sawUpdate = false;
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.startsWith("SELECT") || sql.includes("SELECT *")) {
          return Promise.resolve([semanticRow()]);
        }
        // UPDATE … RETURNING *
        sawUpdate = true;
        return Promise.resolve([semanticRow({ status: "approved", reviewed_by: "admin-1" })]);
      });

      const res = await req("PATCH", "/pat-sem", { status: "approved" });
      expect(res.status).toBe(200);
      expect(applyAmendmentFromPayload).toHaveBeenCalledTimes(1);
      expect(sawUpdate).toBe(true);
      const [params] = applyAmendmentFromPayload.mock.calls[0];
      expect(params.sourceEntity).toBe("orders");
      expect(params.rawPayload).toEqual(AMENDMENT_PAYLOAD);
    });

    it("returns 500 and does NOT update status when the YAML apply fails", async () => {
      applyAmendmentFromPayload.mockImplementation(async () => {
        throw new Error("entity not found");
      });

      const updateCalls: string[] = [];
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("UPDATE")) {
          updateCalls.push(sql);
          return Promise.resolve([semanticRow({ status: "approved" })]);
        }
        return Promise.resolve([semanticRow()]);
      });

      const res = await req("PATCH", "/pat-sem", { status: "approved" });
      expect(res.status).toBe(500);
      expect(updateCalls.length).toBe(0);
    });
  });
});
