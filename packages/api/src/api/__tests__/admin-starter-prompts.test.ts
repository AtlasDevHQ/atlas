/**
 * Integration tests for GET /api/v1/admin/starter-prompts/queue (#1476).
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

describe("GET /api/v1/admin/starter-prompts/queue — buckets", () => {
  it("returns 200 with pending/approved/hidden buckets and counts", async () => {
    // Three sequential queryEffect calls — pending, approved, hidden.
    let call = 0;
    mocks.mockInternalQuery.mockImplementation(async () => {
      call++;
      if (call === 1)
        return [row({ id: "p-1", approval_status: "pending", distinct_user_clicks: 5 })];
      if (call === 2)
        return [row({ id: "a-1", approval_status: "approved", distinct_user_clicks: 8 })];
      if (call === 3)
        return [row({ id: "h-1", approval_status: "hidden", distinct_user_clicks: 3 })];
      return [];
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

  it("pending query filters by threshold and window via SQL parameters", async () => {
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));

    const res = await req("/api/v1/admin/starter-prompts/queue");

    expect(res.status).toBe(200);
    // First call is the pending bucket — params: [orgId, threshold, coldWindowDays]
    const [, params] = mocks.mockInternalQuery.mock.calls[0]!;
    expect(params).toEqual(["org-alpha", 3, 90]);
  });
});

describe("GET /api/v1/admin/starter-prompts/queue — click-threshold path", () => {
  // Simulates the full flow: before threshold, the pending bucket is
  // empty for this suggestion; after threshold crosses, it appears. The
  // SQL layer is mocked, so the assertion is on the threshold filter
  // being applied (the mock returns whatever matches, driven by the
  // test's click count).
  it("suggestion below threshold does not appear in pending bucket", async () => {
    mocks.mockInternalQuery.mockImplementation(async (_sql, params) => {
      // Pending bucket call — threshold filter simulated here
      const pendingCall =
        params && params.length === 3 && typeof params[1] === "number";
      if (pendingCall) {
        const threshold = params[1] as number;
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
    mocks.mockInternalQuery.mockImplementation(async (_sql, params) => {
      const pendingCall =
        params && params.length === 3 && typeof params[1] === "number";
      if (pendingCall) {
        const threshold = params[1] as number;
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
