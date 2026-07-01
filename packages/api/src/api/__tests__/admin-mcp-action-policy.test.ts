/**
 * #3509 — customer-admin MCP action policy route (ADR-0016 gate 1 backend).
 *
 * Drives the `adminMcpActionPolicy` sub-router directly with a mocked
 * `internalQuery` so the REAL store (`lib/mcp/action-policy.ts`) runs against
 * an in-memory table. Asserts the customer-owned wire contract:
 *   - GET lists every category, defaulting to `allowed`;
 *   - PUT blocks a category, persists it, audit-attributes the toggle, and the
 *     follow-up read reflects it;
 *   - a non-admin caller is denied (the perimeter holds);
 *   - no internal DB → 404.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// ── Auth + DB stubs (sub-router uses createAdminRouter → adminAuth) ──

let mockRole = "admin";
const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        mode: "managed",
        label: "Admin",
        role: mockRole,
        activeOrganizationId: "org-1",
        claims: { twoFactorEnabled: true },
      },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "managed",
  resetAuthModeCache: () => {},
}));

// ── In-memory mcp_action_policy table, driven through internalQuery ──

let mockHasInternalDB = true;
interface Row {
  category: string;
  status: string;
  updated_by: string | null;
  updated_at: string | null;
}
let table = new Map<string, Row>();

const mockInternalQuery = mock(async (sqlStr: string, params?: unknown[]) => {
  if (sqlStr.includes("INSERT INTO mcp_action_policy")) {
    const [orgId, category, status, updatedBy] = params as [string, string, string, string | null];
    void orgId;
    table.set(category, { category, status, updated_by: updatedBy, updated_at: "2026-06-13T00:00:00Z" });
    return [];
  }
  if (sqlStr.includes("FROM mcp_action_policy")) {
    // Dashboard read: all rows for the org (the route never calls the
    // blocked-only variant). Status filter, if present, is honoured.
    const onlyBlocked = sqlStr.includes("status = 'blocked'");
    return [...table.values()].filter((r) => !onlyBlocked || r.status === "blocked");
  }
  throw new Error(`unexpected SQL: ${sqlStr}`);
});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: () => Promise.resolve({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: mockInternalQuery,
  internalExecute: mock(() => {}),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

// ── Audit capture ──

interface CapturedAuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}
const mockLogAdminActionAwait: Mock<(entry: CapturedAuditEntry) => Promise<void>> =
  mock(async () => {});

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mock(() => {}),
    logAdminActionAwait: mockLogAdminActionAwait,
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// ── Import sub-router AFTER mocks ──

const { adminMcpActionPolicy } = await import("../routes/admin-mcp-action-policy");

async function request(method: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { Authorization: "Bearer test-key" } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return adminMcpActionPolicy.request("http://localhost/", init);
}

beforeEach(() => {
  mockRole = "admin";
  mockHasInternalDB = true;
  table = new Map();
  mockInternalQuery.mockClear();
  mockLogAdminActionAwait.mockClear();
});

describe("admin MCP action policy route (#3509)", () => {
  it("GET lists every category defaulting to allowed", async () => {
    const res = await request("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { category: string; status: string }[] };
    expect(body.entries.map((e) => e.category).sort()).toEqual(
      ["datasource", "integration", "policy", "raw_sql"],
    );
    expect(body.entries.every((e) => e.status === "allowed")).toBe(true);
  });

  it("PUT blocks a category, persists it, and the follow-up GET reflects it", async () => {
    const put = await request("PUT", { category: "datasource", status: "blocked" });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { entries: { category: string; status: string }[] };
    expect(putBody.entries.find((e) => e.category === "datasource")?.status).toBe("blocked");

    const get = await request("GET");
    const getBody = (await get.json()) as { entries: { category: string; status: string }[] };
    expect(getBody.entries.find((e) => e.category === "datasource")?.status).toBe("blocked");
  });

  it("PUT can disable raw_sql — the admin off-switch for raw executeSQL over CLI/MCP (#4095)", async () => {
    const put = await request("PUT", { category: "raw_sql", status: "blocked" });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { entries: { category: string; status: string }[] };
    expect(putBody.entries.find((e) => e.category === "raw_sql")?.status).toBe("blocked");
  });

  it("PUT audit-attributes the toggle with the category + status delta", async () => {
    await request("PUT", { category: "datasource", status: "blocked" });
    expect(mockLogAdminActionAwait).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminActionAwait.mock.calls[0]![0];
    expect(entry.actionType).toBe("mcp_action_policy.update");
    expect(entry.targetId).toBe("org-1");
    expect(entry.metadata).toMatchObject({
      category: "datasource",
      status: "blocked",
      previousStatus: "allowed",
    });
  });

  it("PUT rejects an unknown category at schema validation (422)", async () => {
    // The `category` enum is derived from the canonical category tuple, so an
    // unknown value is rejected by the validation hook before the handler runs.
    const res = await request("PUT", { category: "nonsense", status: "blocked" });
    expect(res.status).toBe(422);
  });

  it("denies a non-admin caller (perimeter holds)", async () => {
    mockRole = "member";
    const res = await request("GET");
    expect(res.status).toBe(403);
  });

  it("returns 404 when no internal database is configured", async () => {
    mockHasInternalDB = false;
    const res = await request("GET");
    expect(res.status).toBe(404);
  });
});
