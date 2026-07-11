/**
 * Tests for the semantic_amendment decision path on the learned-patterns
 * routes (#3613 → #4506).
 *
 * Amendment status decisions are owned by the decide seam
 * (`lib/semantic/expert/decide.ts`): the single PATCH route and the
 * bulk-status route must route every `semantic_amendment` approve/reject
 * through `decideAmendment` — never stamp an amendment's status with their
 * generic UPDATE. The seam claims the pending row, applies the YAML + version
 * snapshot, and stamps `approved` only on success; a failed apply has already
 * compensated the row back to pending when the error surfaces here.
 *
 * These tests assert:
 *   1. bulk-approving a mix of query_pattern + semantic_amendment routes ONLY
 *      the semantic row through the seam, with the reviewer's identity, and
 *      keeps the generic UPDATE for the query row;
 *   2. a failed seam apply is reported per-id and no generic UPDATE ever
 *      touches the amendment row;
 *   3. the single PATCH approve path routes through the seam too, and its
 *      generic UPDATE never carries a status SET for the amendment;
 *   4. a seam conflict (already reviewed / concurrently claimed) surfaces as
 *      409 on PATCH and a per-id error on bulk;
 *   5. an already-approved (applied) amendment can never be re-decided or
 *      un-approved through these routes.
 */

import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from "bun:test";
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

// The routes delegate amendment decisions to the decide seam. Capture every
// invocation; the seam's own claim/apply/stamp mechanics are covered in
// decide.test.ts and the review-route suite. Default: approve succeeds.
type DecideParams = {
  id: string;
  orgId: string | null;
  decision: "approved" | "rejected";
  reviewedBy: string;
  requestId: string;
};
type DecideOutcome = { kind: "approved" | "rejected" | "not_pending"; id: string };
const decideAmendment: Mock<(params: DecideParams) => Promise<DecideOutcome>> = mock(
  async (params) => ({ kind: params.decision, id: params.id }),
);

void mock.module("@atlas/api/lib/semantic/expert/decide", () => ({
  decideAmendment,
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
  decideAmendment.mockReset();
  decideAmendment.mockImplementation(async (params) => ({ kind: params.decision, id: params.id }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("learned-patterns semantic_amendment decisions route through the decide seam (#4506)", () => {
  describe("POST /bulk", () => {
    it("routes the semantic_amendment through the seam and keeps the generic UPDATE for query_pattern rows", async () => {
      const updateCalls: string[] = [];
      mocks.mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT")) {
          const id = (params?.[0] as string) ?? "";
          if (id === "pat-sem") return Promise.resolve([semanticRow()]);
          if (id === "pat-query") return Promise.resolve([queryRow()]);
          return Promise.resolve([]);
        }
        updateCalls.push(sql);
        return Promise.resolve([]); // UPDATE
      });

      const res = await req("POST", "/bulk", { ids: ["pat-query", "pat-sem"], status: "approved" });
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.updated).toContain("pat-query");
      expect(body.updated).toContain("pat-sem");
      expect(body.errors).toBeUndefined();

      // Exactly one seam decision — for the semantic row only — carrying the
      // reviewing admin's identity.
      expect(decideAmendment).toHaveBeenCalledTimes(1);
      const [params] = decideAmendment.mock.calls[0];
      expect(params).toMatchObject({
        id: "pat-sem",
        orgId: "org-1",
        decision: "approved",
        reviewedBy: "admin-1",
      });

      // The generic status UPDATE ran only for the query_pattern row — the
      // amendment's status is the seam's to write (#4506).
      const statusUpdates = updateCalls.filter((sql) => sql.includes("SET status"));
      expect(statusUpdates).toHaveLength(1);
    });

    it("reports a failed seam apply per-id and never runs the generic UPDATE for it", async () => {
      decideAmendment.mockImplementation(async () => {
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
      // (The seam has already compensated it back to pending.)
      expect(body.updated).not.toContain("pat-sem");
      expect(body.errors).toBeArray();
      expect(body.errors[0].id).toBe("pat-sem");
      // Critically: no UPDATE ran, so this handler never wrote the row's status.
      expect(updateCalls.length).toBe(0);
    });

    it("routes bulk-rejecting a semantic_amendment through the seam too", async () => {
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
      expect(decideAmendment).toHaveBeenCalledTimes(1);
      expect(decideAmendment.mock.calls[0][0]).toMatchObject({ id: "pat-sem", decision: "rejected" });
    });

    it("reports a seam conflict (concurrently reviewed) per-id", async () => {
      decideAmendment.mockImplementation(async (params) => ({ kind: "not_pending", id: params.id }));
      mocks.mockInternalQuery.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes("SELECT") ? [semanticRow()] : []),
      );

      const res = await req("POST", "/bulk", { ids: ["pat-sem"], status: "approved" });
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.updated).not.toContain("pat-sem");
      expect(body.errors[0].id).toBe("pat-sem");
      expect(body.errors[0].error).toContain("already reviewed");
    });

    it("refuses to re-decide an already-approved (applied) amendment", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes("SELECT") ? [semanticRow({ status: "approved" })] : []),
      );

      const res = await req("POST", "/bulk", { ids: ["pat-sem"], status: "rejected" });
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      // An applied change can never be stamped rejected (#4506).
      expect(body.updated).not.toContain("pat-sem");
      expect(body.errors[0].error).toContain("already approved and applied");
      expect(decideAmendment).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /:id", () => {
    it("routes the approve through the seam; the generic UPDATE carries no status SET", async () => {
      const updateSqls: string[] = [];
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.startsWith("SELECT") || sql.includes("SELECT *")) {
          return Promise.resolve([semanticRow()]);
        }
        // UPDATE … RETURNING *
        updateSqls.push(sql);
        return Promise.resolve([semanticRow({ status: "approved", reviewed_by: "admin-1" })]);
      });

      const res = await req("PATCH", "/pat-sem", { status: "approved" });
      expect(res.status).toBe(200);
      expect(decideAmendment).toHaveBeenCalledTimes(1);
      const [params] = decideAmendment.mock.calls[0];
      expect(params).toMatchObject({
        id: "pat-sem",
        orgId: "org-1",
        decision: "approved",
        reviewedBy: "admin-1",
      });
      // The handler's own UPDATE (response freshness) must NOT write status —
      // the seam already stamped it (#4506).
      for (const sql of updateSqls) {
        expect(sql).not.toContain("SET status");
        expect(sql).not.toContain("status =");
      }
    });

    it("returns 500 when the seam's apply fails (row already compensated to pending)", async () => {
      decideAmendment.mockImplementation(async () => {
        throw new Error("entity not found");
      });

      const statusUpdates: string[] = [];
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("UPDATE") && sql.includes("status")) {
          statusUpdates.push(sql);
          return Promise.resolve([semanticRow({ status: "approved" })]);
        }
        return Promise.resolve([semanticRow()]);
      });

      const res = await req("PATCH", "/pat-sem", { status: "approved" });
      expect(res.status).toBe(500);
      expect(statusUpdates.length).toBe(0);
    });

    it("returns 409 when the seam reports the row already reviewed / concurrently claimed", async () => {
      decideAmendment.mockImplementation(async (params) => ({ kind: "not_pending", id: params.id }));
      mocks.mockInternalQuery.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes("SELECT") ? [semanticRow()] : []),
      );

      const res = await req("PATCH", "/pat-sem", { status: "approved" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("conflict");
      expect(body.message).toContain("already reviewed");
    });

    it("returns 409 for any status change to an already-approved (applied) amendment", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes("SELECT") ? [semanticRow({ status: "approved" })] : []),
      );

      for (const status of ["rejected", "pending"] as const) {
        const res = await req("PATCH", "/pat-sem", { status });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { message: string };
        expect(body.message).toContain("already approved and applied");
      }
      expect(decideAmendment).not.toHaveBeenCalled();
    });

    it("presents an 'applying' (claimed) row as pending on the wire — the claim state never leaks", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("COUNT")) return Promise.resolve([{ count: "1" }]);
        if (sql.includes("SELECT *")) {
          return Promise.resolve([
            semanticRow({ status: "applying", created_at: "2026-07-10T00:00:00Z", updated_at: "2026-07-10T00:00:00Z" }),
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await req("GET", "/");
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.patterns[0].status).toBe("pending");
    });

    it("the ?status=pending filter includes 'applying' rows so a stranded claim stays findable (#4506)", async () => {
      const selects: string[] = [];
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        selects.push(sql);
        if (sql.includes("COUNT")) return Promise.resolve([{ count: "0" }]);
        return Promise.resolve([]);
      });

      const res = await req("GET", "/?status=pending");
      expect(res.status).toBe(200);
      // The filter must match the wire presentation (applying reads as
      // pending) — a raw `status = 'pending'` arm would hide a crash-stranded
      // claim from the one filter admins use to find pending work.
      expect(selects.some((s) => s.includes("status IN ('pending', 'applying')"))).toBe(true);
      // Other status filters stay parameterized and exact.
      selects.length = 0;
      const res2 = await req("GET", "/?status=approved");
      expect(res2.status).toBe(200);
      expect(selects.some((s) => s.includes("status = $"))).toBe(true);
    });

    it("reopens a rejected amendment (reconsider) before the seam approves it", async () => {
      const reopenSqls: Array<{ sql: string; params: unknown[] }> = [];
      mocks.mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT")) return Promise.resolve([semanticRow({ status: "rejected" })]);
        if (sql.includes("SET status = 'pending'")) {
          reopenSqls.push({ sql, params: params ?? [] });
          return Promise.resolve([{ id: "pat-sem" }]);
        }
        return Promise.resolve([semanticRow({ status: "approved" })]);
      });

      const res = await req("PATCH", "/pat-sem", { status: "approved" });
      expect(res.status).toBe(200);
      // Conditional reopen (rejected → pending) ran exactly once, then the seam
      // decided the reopened row.
      expect(reopenSqls).toHaveLength(1);
      expect(reopenSqls[0].sql).toContain("status = 'rejected'");
      expect(decideAmendment).toHaveBeenCalledTimes(1);
    });
  });
});
