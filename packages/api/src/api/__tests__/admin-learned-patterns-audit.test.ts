/**
 * Governance-parity audit suite for `admin-learned-patterns.ts` — #4580
 * (PRD #4570).
 *
 * Pins every write route to the canonical `ADMIN_ACTIONS.pattern.*` vocabulary
 * and the metadata shape forensic queries expect. The two governance gaps this
 * PRD closes:
 *   1. Bulk decisions were forensically SILENT — a bulk approve/reject of up to
 *      100 patterns wrote no audit rows. They now write ONE row per decided
 *      pattern using the SAME `pattern.approve` / `pattern.reject` vocabulary as
 *      the single-decision PATCH path (one vocabulary per concept now that
 *      amendments are folded out of this route, #4569).
 *   2. Description-only edits changed the human-facing text other reviewers
 *      trust with no trace. They now write a `pattern.update_description` row.
 *
 * Test pattern modeled on `admin-prompts-audit.test.ts` (F-35).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Mocks — set up before app import
// ---------------------------------------------------------------------------

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-1",
  },
});

interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});

void mock.module("@atlas/api/lib/audit", async () => {
  // Mock every barrel export (docs/development/testing.md "Mock all exports"):
  // spread the real `ADMIN_ACTIONS` + error-scrub helpers so a transitive
  // `import { errorMessage }` never SyntaxErrors at app-load time; only the two
  // write functions are spied.
  const actions = await import("@atlas/api/lib/audit/actions");
  const scrub = await import("@atlas/api/lib/audit/error-scrub");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actions.ADMIN_ACTIONS,
    errorMessage: scrub.errorMessage,
    causeToError: scrub.causeToError,
  };
});

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(method: string, urlPath: string, body?: unknown) {
  const url = `http://localhost/api/v1/admin/learned-patterns${urlPath}`;
  const init: RequestInit = { method, headers: { Authorization: "Bearer test" } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}

function auditCalls(actionType?: string): AuditEntry[] {
  const all = mockLogAdminAction.mock.calls.map((c) => c[0]!);
  return actionType ? all.filter((e) => e.actionType === actionType) : all;
}

function mockRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pat-1",
    org_id: "org-1",
    pattern_sql: "SELECT COUNT(*) FROM orders",
    description: "Order count",
    source_entity: "orders",
    source_queries: ["audit-1"],
    confidence: 0.8,
    repetition_count: 5,
    status: "pending",
    proposed_by: "agent",
    reviewed_by: null,
    created_at: "2026-03-18T00:00:00Z",
    updated_at: "2026-03-18T00:00:00Z",
    reviewed_at: null,
    type: "query_pattern",
    amendment_payload: null,
    connection_group_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "admin@test.com", role: "admin", activeOrganizationId: "org-1" },
    }),
  );
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
});

// ---------------------------------------------------------------------------
// PATCH /:id — description-only edit audit (#4580 AC: description edit audited)
// ---------------------------------------------------------------------------

describe("PATCH /:id — description edit audit (#4580)", () => {
  function mockExistThenUpdate(updatedOverrides: Record<string, unknown>) {
    let call = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve([mockRow()]); // existence SELECT
      return Promise.resolve([mockRow(updatedOverrides)]); // UPDATE RETURNING *
    });
  }

  it("emits pattern.update_description on a description-only edit", async () => {
    mockExistThenUpdate({ description: "Updated" });
    const res = await req("PATCH", "/pat-1", { description: "Updated" });
    expect(res.status).toBe(200);

    const desc = auditCalls("pattern.update_description");
    expect(desc).toHaveLength(1);
    expect(desc[0].targetType).toBe("pattern");
    expect(desc[0].targetId).toBe("pat-1");
    expect(desc[0].metadata).toMatchObject({ patternId: "pat-1" });
    // A description-only edit is not a decision — no approve/reject row.
    expect(auditCalls("pattern.approve")).toHaveLength(0);
    expect(auditCalls("pattern.reject")).toHaveLength(0);
  });

  it("does NOT emit update_description when only status changes", async () => {
    mockExistThenUpdate({ status: "approved", reviewed_by: "admin-1", reviewed_at: "2026-03-18T00:00:00Z" });
    const res = await req("PATCH", "/pat-1", { status: "approved" });
    expect(res.status).toBe(200);

    expect(auditCalls("pattern.update_description")).toHaveLength(0);
    expect(auditCalls("pattern.approve")).toHaveLength(1);
  });

  it("emits BOTH rows when a PATCH changes description AND status (two governance events)", async () => {
    mockExistThenUpdate({ description: "Updated", status: "approved", reviewed_by: "admin-1" });
    const res = await req("PATCH", "/pat-1", { description: "Updated", status: "approved" });
    expect(res.status).toBe(200);

    expect(auditCalls("pattern.update_description")).toHaveLength(1);
    expect(auditCalls("pattern.approve")).toHaveLength(1);
    expect(auditCalls("pattern.reject")).toHaveLength(0);
  });

  it("emits pattern.approve / pattern.reject with patternId metadata on a status decision", async () => {
    mockExistThenUpdate({ status: "rejected", reviewed_by: "admin-1" });
    const res = await req("PATCH", "/pat-1", { status: "rejected" });
    expect(res.status).toBe(200);
    const reject = auditCalls("pattern.reject");
    expect(reject).toHaveLength(1);
    expect(reject[0].targetType).toBe("pattern");
    expect(reject[0].targetId).toBe("pat-1");
    expect(reject[0].metadata).toMatchObject({ patternId: "pat-1" });
  });

  it("writes NO audit row when the pattern does not exist (404)", async () => {
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const res = await req("PATCH", "/missing", { description: "Updated" });
    expect(res.status).toBe(404);
    expect(auditCalls()).toHaveLength(0);
  });

  it("emits ONLY update_description when a PATCH edits description AND un-approves to pending", async () => {
    // An un-approve (approved → pending) is not an approve/reject decision, so
    // description + pending emits the description row and NO decision row.
    mockExistThenUpdate({ description: "Updated", status: "pending", reviewed_by: "admin-1" });
    const res = await req("PATCH", "/pat-1", { description: "Updated", status: "pending" });
    expect(res.status).toBe(200);
    expect(auditCalls("pattern.update_description")).toHaveLength(1);
    expect(auditCalls("pattern.approve")).toHaveLength(0);
    expect(auditCalls("pattern.reject")).toHaveLength(0);
  });

  it("writes NO audit row when the row is deleted before the update lands (404)", async () => {
    // Existence check passes, but the UPDATE ... RETURNING * comes back empty
    // (a concurrent delete). Audit fires only after a confirmed mutation.
    let call = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve([mockRow()]); // existence
      return Promise.resolve([]); // UPDATE returns nothing
    });
    const res = await req("PATCH", "/pat-1", { description: "Updated" });
    expect(res.status).toBe(404);
    expect(auditCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — audit (existing behavior, pinned for completeness)
// ---------------------------------------------------------------------------

describe("DELETE /:id — audit", () => {
  it("emits pattern.delete with patternId metadata", async () => {
    let call = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve([mockRow()]);
      return Promise.resolve([]);
    });
    const res = await req("DELETE", "/pat-1");
    expect(res.status).toBe(200);
    const del = auditCalls("pattern.delete");
    expect(del).toHaveLength(1);
    expect(del[0].targetId).toBe("pat-1");
    expect(del[0].metadata).toMatchObject({ patternId: "pat-1" });
  });
});

// ---------------------------------------------------------------------------
// POST /bulk — one audit row per decided pattern (#4580 AC: bulk audit rows)
// ---------------------------------------------------------------------------

describe("POST /bulk — audit rows (#4580)", () => {
  it("writes ONE pattern.approve row per updated pattern, with matching targetIds", async () => {
    // Every existence SELECT finds the row; every UPDATE succeeds.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) return Promise.resolve([{ id: "x", type: "query_pattern" }]);
      return Promise.resolve([]);
    });

    const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-2", "pat-3"], status: "approved" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[] };
    expect(body.updated).toEqual(["pat-1", "pat-2", "pat-3"]);

    const approve = auditCalls("pattern.approve");
    expect(approve).toHaveLength(3);
    expect(approve.map((e) => e.targetId).sort()).toEqual(["pat-1", "pat-2", "pat-3"]);
    for (const e of approve) {
      expect(e.targetType).toBe("pattern");
      expect(e.metadata).toMatchObject({ patternId: e.targetId });
    }
    // Bulk uses the SAME vocabulary as single decisions — never a distinct
    // "bulk" action type.
    expect(auditCalls("pattern.reject")).toHaveLength(0);
  });

  it("uses pattern.reject vocabulary for a bulk reject", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) return Promise.resolve([{ id: "x", type: "query_pattern" }]);
      return Promise.resolve([]);
    });
    const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-2"], status: "rejected" });
    expect(res.status).toBe(200);
    expect(auditCalls("pattern.reject")).toHaveLength(2);
    expect(auditCalls("pattern.approve")).toHaveLength(0);
  });

  it("audits ONLY the ids that changed — notFound ids leave no row", async () => {
    let selectCall = 0;
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        selectCall++;
        // First id exists, second is missing.
        return Promise.resolve(selectCall === 1 ? [{ id: "pat-1", type: "query_pattern" }] : []);
      }
      return Promise.resolve([]);
    });

    const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-missing"], status: "approved" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[]; notFound: string[] };
    expect(body.updated).toEqual(["pat-1"]);
    expect(body.notFound).toEqual(["pat-missing"]);

    const approve = auditCalls("pattern.approve");
    expect(approve).toHaveLength(1);
    expect(approve[0].targetId).toBe("pat-1");
  });

  it("writes NO audit rows when nothing was updated", async () => {
    // Every SELECT is empty → all notFound, zero updated.
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const res = await req("POST", "/bulk", { ids: ["a", "b"], status: "approved" });
    expect(res.status).toBe(200);
    expect(auditCalls()).toHaveLength(0);
  });

  it("audits only the succeeding id when a sibling's UPDATE throws mid-bulk", async () => {
    // Both ids pass the existence check; the UPDATE for "pat-err" throws. The
    // erroring id lands in `errors` with NO audit row; its sibling succeeds and
    // gets exactly one.
    mocks.mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT")) return Promise.resolve([{ id: "x", type: "query_pattern" }]);
      // UPDATE — params are [status, reviewerId, id].
      if ((params as unknown[])[2] === "pat-err") return Promise.reject(new Error("update boom"));
      return Promise.resolve([]);
    });

    const res = await req("POST", "/bulk", { ids: ["pat-ok", "pat-err"], status: "approved" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[]; errors?: Array<{ id: string }> };
    expect(body.updated).toEqual(["pat-ok"]);
    expect(body.errors?.map((e) => e.id)).toEqual(["pat-err"]);

    const approve = auditCalls("pattern.approve");
    expect(approve).toHaveLength(1);
    expect(approve[0].targetId).toBe("pat-ok");
  });
});
