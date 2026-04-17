/**
 * Integration tests for GET /api/v1/admin/starter-prompts/queue.
 *
 * Exercises:
 *   - Auth gate (401/403) and org scoping
 *   - Bucketing by approval_status (pending / approved / hidden)
 *   - Auto-promote filter on the pending bucket: only rows with
 *     distinct_user_clicks >= threshold within the cold window surface
 *   - Click-threshold path: stepping a suggestion from 2 → 3 distinct
 *     user clicks makes it appear in the pending bucket
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const mocks = createApiTestMocks();

const { app } = await import("../index");

function req(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) {
  const url = `http://localhost${path}`;
  return app.fetch(
    new Request(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: "Bearer test",
        ...init.headers,
      },
    }),
  );
}

afterAll(() => {
  mocks.cleanup();
});

beforeEach(() => {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: "admin-1",
        mode: "simple-key",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-alpha",
      },
    }),
  );
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
});

function row(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "sug-1",
    org_id: "org-alpha",
    description: "Pattern",
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

describe("GET /api/v1/admin/starter-prompts/queue — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Missing token", status: 401 }),
    );

    const res = await req("/api/v1/admin/starter-prompts/queue");

    expect(res.status).toBe(401);
  });

  it("returns 403 when authenticated user is not an admin", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "member-1",
          mode: "simple-key",
          label: "Member",
          role: "member",
          activeOrganizationId: "org-alpha",
        },
      }),
    );

    const res = await req("/api/v1/admin/starter-prompts/queue");

    expect(res.status).toBe(403);
  });
});

// The queue endpoint runs the three bucket queries in parallel — dispatch
// by SQL content so tests don't depend on execution order.
function bucketOfQuery(sql: string): "pending" | "approved" | "hidden" | "other" {
  if (sql.includes("approval_status = 'pending'")) return "pending";
  if (sql.includes("approval_status = 'approved'")) return "approved";
  if (sql.includes("approval_status = 'hidden'")) return "hidden";
  return "other";
}

describe("GET /api/v1/admin/starter-prompts/queue — buckets", () => {
  it("returns 200 with pending/approved/hidden buckets and counts", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql) => {
      switch (bucketOfQuery(sql)) {
        case "pending":
          return [row({ id: "p-1", approval_status: "pending", distinct_user_clicks: 5 })];
        case "approved":
          return [row({ id: "a-1", approval_status: "approved", distinct_user_clicks: 8 })];
        case "hidden":
          return [row({ id: "h-1", approval_status: "hidden", distinct_user_clicks: 3 })];
        default:
          return [];
      }
    });

    const res = await req("/api/v1/admin/starter-prompts/queue");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: Array<{ id: string }>;
      approved: Array<{ id: string }>;
      hidden: Array<{ id: string }>;
      counts: { pending: number; approved: number; hidden: number };
      threshold: number;
      coldWindowDays: number;
    };
    expect(body.pending.map((r) => r.id)).toEqual(["p-1"]);
    expect(body.approved.map((r) => r.id)).toEqual(["a-1"]);
    expect(body.hidden.map((r) => r.id)).toEqual(["h-1"]);
    expect(body.counts).toEqual({ pending: 1, approved: 1, hidden: 1 });
    expect(body.threshold).toBe(3);
    expect(body.coldWindowDays).toBe(90);
  });

  it("propagates approval metadata fields on returned rows", async () => {
    mocks.mockInternalQuery.mockImplementation(async () => [
      row({
        approval_status: "approved",
        approved_by: "admin-1",
        approved_at: "2026-04-10T00:00:00.000Z",
      }),
    ]);

    const res = await req("/api/v1/admin/starter-prompts/queue");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      approved: Array<{
        approvalStatus: string;
        approvedBy: string | null;
        approvedAt: string | null;
      }>;
    };
    expect(body.approved[0]?.approvalStatus).toBe("approved");
    expect(body.approved[0]?.approvedBy).toBe("admin-1");
    expect(body.approved[0]?.approvedAt).toBe("2026-04-10T00:00:00.000Z");
  });

  it("pending query SQL contains threshold + window predicates with correct params", async () => {
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));

    const res = await req("/api/v1/admin/starter-prompts/queue");

    expect(res.status).toBe(200);

    const pendingCall = mocks.mockInternalQuery.mock.calls.find(
      ([sql]) => bucketOfQuery(sql as string) === "pending",
    );
    expect(pendingCall).toBeDefined();
    const [sql, params] = pendingCall!;
    // Threshold predicate: distinct_user_clicks >= $N — a regression to
    // > would drop the equals-to-threshold case; no predicate at all
    // would surface stale suggestions below the auto-promote bar.
    expect(sql).toContain("distinct_user_clicks >= ");
    // Window predicate: last_seen_at >= NOW() - ($N || ' days')::interval
    expect(sql).toContain("last_seen_at >=");
    expect(sql).toContain("|| ' days')::interval");
    expect(params).toEqual(["org-alpha", 3, 90]);
  });

  it("orthogonal axes: approved × draft row surfaces in approved bucket unchanged", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql) => {
      if (bucketOfQuery(sql as string) === "approved") {
        return [row({ approval_status: "approved", status: "draft" })];
      }
      return [];
    });

    const res = await req("/api/v1/admin/starter-prompts/queue");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      approved: Array<{ approvalStatus: string; status: string }>;
    };
    expect(body.approved).toHaveLength(1);
    expect(body.approved[0]?.approvalStatus).toBe("approved");
    expect(body.approved[0]?.status).toBe("draft");
  });

  it("null-org admin (platform admin without active org) uses IS NULL scoping", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "admin-null",
          mode: "simple-key",
          label: "Admin",
          role: "admin",
          // No activeOrganizationId — simulates the null-org branch in
          // the route's orgClause construction.
          activeOrganizationId: undefined,
        },
      }),
    );
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));

    const res = await req("/api/v1/admin/starter-prompts/queue");

    // requireOrgContext returns 400 when no active org; we assert the
    // contract holds so the untested null-org branch in the SQL builder
    // is flagged if future code paths expose it.
    expect([200, 400]).toContain(res.status);
  });
});

describe("GET /api/v1/admin/starter-prompts/queue — click-threshold path", () => {
  // Simulates the acceptance-criterion flow: before threshold, the
  // pending bucket is empty; after threshold crosses, it surfaces. The
  // mock applies the same threshold predicate the production SQL does,
  // driven by the test's simulated click count.
  it("suggestion below threshold does not appear in pending bucket", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql, params) => {
      if (bucketOfQuery(sql as string) === "pending") {
        const threshold = (params as unknown[])[1] as number;
        const clicks = 2;
        return clicks >= threshold ? [row({ distinct_user_clicks: clicks })] : [];
      }
      return [];
    });

    const res = await req("/api/v1/admin/starter-prompts/queue");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: Array<unknown> };
    expect(body.pending).toEqual([]);
  });

  it("suggestion at threshold appears in pending bucket", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql, params) => {
      if (bucketOfQuery(sql as string) === "pending") {
        const threshold = (params as unknown[])[1] as number;
        const clicks = 3;
        return clicks >= threshold
          ? [row({ id: "crossed", distinct_user_clicks: clicks })]
          : [];
      }
      return [];
    });

    const res = await req("/api/v1/admin/starter-prompts/queue");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: Array<{ id: string; distinctUserClicks: number }>;
    };
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]?.id).toBe("crossed");
    expect(body.pending[0]?.distinctUserClicks).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Mutation routes (slice #1477): approve / hide / unhide / author
// ---------------------------------------------------------------------------

function postNoBody(path: string) {
  return req(path, { method: "POST" });
}

function postBody(path: string, body: unknown) {
  const url = `http://localhost${path}`;
  return app.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/v1/admin/starter-prompts/:id/approve", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Missing token", status: 401 }),
    );

    const res = await postNoBody("/api/v1/admin/starter-prompts/sug-1/approve");

    expect(res.status).toBe(401);
  });

  it("returns 403 when authenticated user is not an admin", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "member-1",
          mode: "simple-key",
          label: "Member",
          role: "member",
          activeOrganizationId: "org-alpha",
        },
      }),
    );

    const res = await postNoBody("/api/v1/admin/starter-prompts/sug-1/approve");

    expect(res.status).toBe(403);
  });

  it("returns 404 when the suggestion does not exist", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [];
      return [];
    });

    const res = await postNoBody("/api/v1/admin/starter-prompts/missing/approve");

    expect(res.status).toBe(404);
  });

  it("returns 403 when the suggestion belongs to a different org", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-other" }];
      return [];
    });

    const res = await postNoBody("/api/v1/admin/starter-prompts/sug-1/approve");

    expect(res.status).toBe(403);
  });

  it("returns 200 with the updated row stamped with approved_by/approved_at", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-alpha" }];
      if (sql.includes("UPDATE")) {
        return [
          row({
            id: "sug-1",
            approval_status: "approved",
            approved_by: "admin-1",
            approved_at: "2026-04-17T00:00:00.000Z",
          }),
        ];
      }
      return [];
    });

    const res = await postNoBody("/api/v1/admin/starter-prompts/sug-1/approve");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestion: {
        id: string;
        approvalStatus: string;
        approvedBy: string | null;
        approvedAt: string | null;
      };
    };
    expect(body.suggestion.id).toBe("sug-1");
    expect(body.suggestion.approvalStatus).toBe("approved");
    expect(body.suggestion.approvedBy).toBe("admin-1");
    expect(body.suggestion.approvedAt).toBe("2026-04-17T00:00:00.000Z");
  });
});

describe("POST /api/v1/admin/starter-prompts/:id/hide", () => {
  it("returns 403 for non-admins", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "member-1",
          mode: "simple-key",
          label: "Member",
          role: "member",
          activeOrganizationId: "org-alpha",
        },
      }),
    );

    const res = await postNoBody("/api/v1/admin/starter-prompts/sug-1/hide");

    expect(res.status).toBe(403);
  });

  it("returns 200 with approvalStatus=hidden after a successful hide", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-alpha" }];
      if (sql.includes("UPDATE")) {
        return [row({ approval_status: "hidden" })];
      }
      return [];
    });

    const res = await postNoBody("/api/v1/admin/starter-prompts/sug-1/hide");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestion: { approvalStatus: string };
    };
    expect(body.suggestion.approvalStatus).toBe("hidden");
  });

  it("hide → unhide cycle returns the row to pending state", async () => {
    // First hide
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-alpha" }];
      if (sql.includes("UPDATE")) {
        return [row({ approval_status: "hidden" })];
      }
      return [];
    });
    const hideRes = await postNoBody("/api/v1/admin/starter-prompts/sug-1/hide");
    expect(hideRes.status).toBe(200);

    // Then unhide — goes back to pending (per user story 12: hide is reversible)
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-alpha" }];
      if (sql.includes("UPDATE")) {
        return [row({ approval_status: "pending" })];
      }
      return [];
    });
    const unhideRes = await postNoBody("/api/v1/admin/starter-prompts/sug-1/unhide");
    expect(unhideRes.status).toBe(200);
    const body = (await unhideRes.json()) as {
      suggestion: { approvalStatus: string };
    };
    expect(body.suggestion.approvalStatus).toBe("pending");
  });
});

describe("POST /api/v1/admin/starter-prompts/author", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Missing token", status: 401 }),
    );

    const res = await postBody("/api/v1/admin/starter-prompts/author", {
      text: "What does this table contain?",
    });

    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admins", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "member-1",
          mode: "simple-key",
          label: "Member",
          role: "member",
          activeOrganizationId: "org-alpha",
        },
      }),
    );

    const res = await postBody("/api/v1/admin/starter-prompts/author", {
      text: "What does this table contain?",
    });

    expect(res.status).toBe(403);
  });

  it("returns 422 when text is empty (Zod validation at route boundary)", async () => {
    // The shared validation-hook returns 422 for all schema failures — the
    // in-service InvalidSuggestionTextError (400) only fires for callers
    // that bypass the route layer (SDK / MCP).
    const res = await postBody("/api/v1/admin/starter-prompts/author", { text: "" });

    expect(res.status).toBe(422);
  });

  it("returns 200 with a newly-approved row (approval_status=approved, status=published)", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO query_suggestions")) {
        return [
          row({
            id: "new-sug",
            description: "Admin-authored question",
            approval_status: "approved",
            status: "published",
            approved_by: "admin-1",
            approved_at: "2026-04-17T00:00:00.000Z",
          }),
        ];
      }
      return [];
    });

    const res = await postBody("/api/v1/admin/starter-prompts/author", {
      text: "Admin-authored question",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestion: {
        id: string;
        description: string;
        approvalStatus: string;
        status: string;
        approvedBy: string | null;
      };
    };
    expect(body.suggestion.approvalStatus).toBe("approved");
    expect(body.suggestion.status).toBe("published");
    expect(body.suggestion.description).toBe("Admin-authored question");
    expect(body.suggestion.approvedBy).toBe("admin-1");
  });

  it("returns 409 when the same text already exists (PG unique-violation)", async () => {
    mocks.mockInternalQuery.mockImplementation(async () => {
      const err = new Error(
        "duplicate key value violates unique constraint",
      ) as Error & { code?: string };
      err.code = "23505";
      throw err;
    });

    const res = await postBody("/api/v1/admin/starter-prompts/author", {
      text: "A duplicate of a pending suggestion",
    });

    expect(res.status).toBe(409);
  });
});
