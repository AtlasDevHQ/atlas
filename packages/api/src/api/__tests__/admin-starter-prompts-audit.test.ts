/**
 * Audit regression suite for `admin-starter-prompts.ts` — F-35 (#1790).
 *
 * Pins each moderation mutation (approve / hide / unhide / author) to the
 * canonical `ADMIN_ACTIONS.starter_prompt.*` action type and metadata
 * shape. Starter prompts are surfaced on first-run / empty-state
 * surfaces, so a workspace admin can reshape the landing experience for
 * every tenant user — this suite makes sure that never happens silently
 * again.
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

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
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

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

function suggestionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sug-1",
    org_id: "org-alpha",
    description: "How many users signed up last week?",
    pattern_sql: "SELECT 1",
    normalized_hash: "abc",
    tables_involved: "[]",
    primary_table: null,
    frequency: 5,
    clicked_count: 5,
    distinct_user_clicks: 5,
    score: 1.2,
    approval_status: "pending",
    status: "draft",
    approved_by: null,
    approved_at: null,
    last_seen_at: "2026-04-15T00:00:00.000Z",
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/starter-prompts/:id/approve
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/starter-prompts/:id/approve — audit emission", () => {
  it("emits starter_prompt.approve with id + name metadata on success", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-alpha" }];
      if (sql.includes("UPDATE")) {
        return [suggestionRow({ id: "sug-1", approval_status: "approved" })];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/starter-prompts/sug-1/approve"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("starter_prompt.approve");
    expect(entry.targetType).toBe("starter_prompt");
    expect(entry.targetId).toBe("sug-1");
    expect(entry.metadata).toMatchObject({
      id: "sug-1",
      name: "How many users signed up last week?",
    });
  });

  it("does not emit when the suggestion belongs to a different org (403)", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-other" }];
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/starter-prompts/sug-1/approve"),
    );
    expect(res.status).toBe(403);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("does not emit when the suggestion does not exist (404)", async () => {
    mocks.mockInternalQuery.mockImplementation(async () => []);

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/starter-prompts/missing/approve"),
    );
    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/starter-prompts/:id/hide
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/starter-prompts/:id/hide — audit emission", () => {
  it("emits starter_prompt.hide with id + name metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-alpha" }];
      if (sql.includes("UPDATE")) {
        return [suggestionRow({ id: "sug-1", approval_status: "hidden" })];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/starter-prompts/sug-1/hide"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("starter_prompt.hide");
    expect(entry.targetType).toBe("starter_prompt");
    expect(entry.targetId).toBe("sug-1");
    expect(entry.metadata).toMatchObject({
      id: "sug-1",
      name: "How many users signed up last week?",
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/starter-prompts/:id/unhide
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/starter-prompts/:id/unhide — audit emission", () => {
  it("emits starter_prompt.unhide with id + name metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-alpha" }];
      if (sql.includes("UPDATE")) {
        return [suggestionRow({ id: "sug-1", approval_status: "pending" })];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/starter-prompts/sug-1/unhide"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("starter_prompt.unhide");
    expect(entry.targetType).toBe("starter_prompt");
    expect(entry.targetId).toBe("sug-1");
    expect(entry.metadata).toMatchObject({
      id: "sug-1",
      name: "How many users signed up last week?",
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/starter-prompts/author
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/starter-prompts/author — audit emission", () => {
  it("emits starter_prompt.author_update with id + name metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO query_suggestions")) {
        return [
          suggestionRow({
            id: "authored-1",
            description: "What tables exist?",
            approval_status: "approved",
            status: "published",
            approved_by: "admin-1",
          }),
        ];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/starter-prompts/author", {
        text: "What tables exist?",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("starter_prompt.author_update");
    expect(entry.targetType).toBe("starter_prompt");
    expect(entry.targetId).toBe("authored-1");
    expect(entry.metadata).toMatchObject({
      id: "authored-1",
      name: "What tables exist?",
    });
  });

  it("does not emit on duplicate (409)", async () => {
    mocks.mockInternalQuery.mockImplementation(async () => {
      const err = new Error(
        "duplicate key value violates unique constraint",
      ) as Error & { code?: string };
      err.code = "23505";
      throw err;
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/starter-prompts/author", {
        text: "Dup",
      }),
    );
    expect(res.status).toBe(409);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
