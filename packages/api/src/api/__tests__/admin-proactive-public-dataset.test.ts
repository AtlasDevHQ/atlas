/**
 * Route tests for `/api/v1/admin/proactive/public-dataset/*` (#2297).
 *
 * Stubs the public-dataset module exports with `mock.module()` so the
 * route's Effect-bound helpers resolve to scripted responses. The
 * enterprise gate is flipped via the same mock pattern as
 * `admin-proactive-analytics.test.ts` so the EE off path lands on a
 * typed `EnterpriseError` rather than chasing global env state.
 */

import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  type Mock,
} from "bun:test";
import type {
  PublicDatasetEntry,
  PublicRefusedRollupRow,
} from "@atlas/api/lib/proactive/public-dataset";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Public-dataset module mock
// ---------------------------------------------------------------------------

const mockGetAllowlist: Mock<(workspaceId: string) => Promise<PublicDatasetEntry[]>> = mock(
  async () => [],
);
const mockAddEntry: Mock<
  (workspaceId: string, entityName: string, denyMetrics?: string[]) => Promise<void>
> = mock(async () => {});
const mockRemoveEntry: Mock<
  (workspaceId: string, entityName: string) => Promise<{ removed: boolean }>
> = mock(async () => ({ removed: true }));
const mockSummarizeRefused: Mock<
  (workspaceId: string, sinceMs: number) => Promise<PublicRefusedRollupRow[]>
> = mock(async () => []);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPublicDataset = require("@atlas/api/lib/proactive/public-dataset") as typeof import("@atlas/api/lib/proactive/public-dataset");

mock.module("@atlas/api/lib/proactive/public-dataset", () => ({
  ...realPublicDataset,
  getAllowlist: mockGetAllowlist,
  addEntry: mockAddEntry,
  removeEntry: mockRemoveEntry,
  summarizePublicRefused: mockSummarizeRefused,
}));

// ---------------------------------------------------------------------------
// Enterprise gate — post-#2572 (slice 10/11) the route yields the
// `ProactiveGate` Tag from EELayer. Default-on; flip to drive the 403 path.
// ---------------------------------------------------------------------------

let enterpriseEnabled = true;

process.env.ATLAS_ENTERPRISE_ENABLED = "true";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const effectMod = require("effect") as typeof import("effect");

mock.module("@atlas/ee/layers", () => {
  const { Layer, Effect: E } = effectMod;
  return {
    EELayer: Layer.unwrapEffect(
      E.sync(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { EnterpriseError } = require("@atlas/api/lib/effect/errors") as typeof import("@atlas/api/lib/effect/errors");
        return Layer.succeed(services.ProactiveGate, {
          enabled: true,
          requireEnabled: () =>
            enterpriseEnabled
              ? effectMod.Effect.void
              : effectMod.Effect.fail(
                  new EnterpriseError(
                    "Enterprise features (proactive-chat) are not enabled.",
                  ),
                ),
        });
      }),
    ),
  };
});

// ---------------------------------------------------------------------------
// Standard API mocks
// ---------------------------------------------------------------------------

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

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

beforeEach(() => {
  mocks.hasInternalDB = true;
  enterpriseEnabled = true;
  mockGetAllowlist.mockClear();
  mockGetAllowlist.mockImplementation(async () => []);
  mockAddEntry.mockClear();
  mockAddEntry.mockImplementation(async () => {});
  mockRemoveEntry.mockClear();
  mockRemoveEntry.mockImplementation(async () => ({ removed: true }));
  mockSummarizeRefused.mockClear();
  mockSummarizeRefused.mockImplementation(async () => []);
});

function adminGET(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers: { Authorization: "Bearer test-key" },
  });
}

function adminBody(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/proactive/public-dataset", () => {
  it("returns the allowlist for the active workspace", async () => {
    mockGetAllowlist.mockImplementation(async () => [
      { entityName: "marketing.users", denyMetrics: [] },
      { entityName: "finance.revenue", denyMetrics: ["amount_cents"] },
    ]);
    const res = await app.fetch(
      adminGET("/api/v1/admin/proactive/public-dataset/"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: PublicDatasetEntry[] };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].entityName).toBe("marketing.users");
    expect(body.entries[1].denyMetrics).toEqual(["amount_cents"]);
    expect(mockGetAllowlist).toHaveBeenCalledTimes(1);
    expect(mockGetAllowlist.mock.calls[0]![0]).toBe("org-alpha");
  });

  it("returns 404 when no internal DB is configured (admin-router gate)", async () => {
    // `requireOrgContext()` short-circuits with 404 before the route
    // runs when `hasInternalDB()` is false; the test asserts the gate
    // rather than the route-level fallback to keep behaviour pinned
    // at the middleware layer.
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      adminGET("/api/v1/admin/proactive/public-dataset/"),
    );
    expect(res.status).toBe(404);
    expect(mockGetAllowlist).not.toHaveBeenCalled();
  });

  it("returns 403 when enterprise is disabled", async () => {
    enterpriseEnabled = false;
    const res = await app.fetch(
      adminGET("/api/v1/admin/proactive/public-dataset/"),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/admin/proactive/public-dataset", () => {
  it("upserts an entry with denyMetrics", async () => {
    const res = await app.fetch(
      adminBody("POST", "/api/v1/admin/proactive/public-dataset/", {
        entityName: "marketing.users",
        denyMetrics: ["email"],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublicDatasetEntry;
    expect(body.entityName).toBe("marketing.users");
    expect(body.denyMetrics).toEqual(["email"]);
    expect(mockAddEntry).toHaveBeenCalledTimes(1);
    const call = mockAddEntry.mock.calls[0]!;
    expect(call[0]).toBe("org-alpha");
    expect(call[1]).toBe("marketing.users");
    expect(call[2]).toEqual(["email"]);
  });

  it("defaults denyMetrics to [] when omitted", async () => {
    const res = await app.fetch(
      adminBody("POST", "/api/v1/admin/proactive/public-dataset/", {
        entityName: "finance.revenue",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublicDatasetEntry;
    expect(body.denyMetrics).toEqual([]);
    expect(mockAddEntry.mock.calls[0]![2]).toEqual([]);
  });

  it("returns 422 for an empty entityName", async () => {
    const res = await app.fetch(
      adminBody("POST", "/api/v1/admin/proactive/public-dataset/", {
        entityName: "",
      }),
    );
    expect(res.status).toBe(422);
    expect(mockAddEntry).not.toHaveBeenCalled();
  });

  it("returns 404 when no internal DB is configured (admin-router gate)", async () => {
    // See list test above — the admin-router middleware gates here, not
    // the route handler.
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      adminBody("POST", "/api/v1/admin/proactive/public-dataset/", {
        entityName: "marketing.users",
      }),
    );
    expect(res.status).toBe(404);
    expect(mockAddEntry).not.toHaveBeenCalled();
  });

  it("returns 403 when enterprise is disabled", async () => {
    enterpriseEnabled = false;
    const res = await app.fetch(
      adminBody("POST", "/api/v1/admin/proactive/public-dataset/", {
        entityName: "marketing.users",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/v1/admin/proactive/public-dataset/:entityName", () => {
  it("deletes an entry when present", async () => {
    mockRemoveEntry.mockImplementation(async () => ({ removed: true }));
    const res = await app.fetch(
      adminBody(
        "DELETE",
        "/api/v1/admin/proactive/public-dataset/marketing.users",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(mockRemoveEntry).toHaveBeenCalledTimes(1);
    expect(mockRemoveEntry.mock.calls[0]![1]).toBe("marketing.users");
  });

  it("returns 404 when the entry was already gone", async () => {
    mockRemoveEntry.mockImplementation(async () => ({ removed: false }));
    const res = await app.fetch(
      adminBody(
        "DELETE",
        "/api/v1/admin/proactive/public-dataset/marketing.users",
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when enterprise is disabled", async () => {
    enterpriseEnabled = false;
    const res = await app.fetch(
      adminBody(
        "DELETE",
        "/api/v1/admin/proactive/public-dataset/marketing.users",
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/admin/proactive/public-dataset/refused", () => {
  it("returns the discoverability rollup with default 30-day window", async () => {
    mockSummarizeRefused.mockImplementation(async () => [
      { entityName: "finance.revenue", count: 12 },
      { entityName: "marketing.users", count: 4 },
    ]);
    const res = await app.fetch(
      adminGET("/api/v1/admin/proactive/public-dataset/refused"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sinceMs: number;
      rollup: PublicRefusedRollupRow[];
    };
    expect(body.sinceMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(body.rollup).toHaveLength(2);
    expect(body.rollup[0].entityName).toBe("finance.revenue");
    expect(body.rollup[0].count).toBe(12);
  });

  it("parses since=7d into a 7-day lookback window", async () => {
    const res = await app.fetch(
      adminGET("/api/v1/admin/proactive/public-dataset/refused?since=7d"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sinceMs: number };
    expect(body.sinceMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(mockSummarizeRefused.mock.calls[0]![1]).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it("returns 403 when enterprise is disabled", async () => {
    enterpriseEnabled = false;
    const res = await app.fetch(
      adminGET("/api/v1/admin/proactive/public-dataset/refused"),
    );
    expect(res.status).toBe(403);
  });
});
