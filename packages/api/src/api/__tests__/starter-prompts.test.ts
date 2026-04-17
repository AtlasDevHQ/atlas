/**
 * Integration tests for GET /api/v1/starter-prompts (#1474).
 *
 * Exercises the route wiring end-to-end: auth gate → config → resolver →
 * response shape. The resolver itself has thorough unit coverage in
 * packages/api/src/lib/starter-prompts/__tests__/resolver.test.ts; here
 * we cover the HTTP contract.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ── Module mocks (must run before importing the app) ────────────────────

const mocks = createApiTestMocks();

// Controls the demo-industry read per test.
let demoIndustryFixture: string | undefined;
mock.module("@atlas/api/lib/settings", () => ({
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  getSetting: () => undefined,
  getSettingAuto: (key: string) =>
    key === "ATLAS_DEMO_INDUSTRY" ? demoIndustryFixture : undefined,
  getSettingLive: async () => undefined,
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

// Import the app AFTER mocks.
const { app } = await import("../index");

function req(path: string, headers: Record<string, string> = {}) {
  const url = `http://localhost${path}`;
  return app.fetch(
    new Request(url, {
      method: "GET",
      headers: { Authorization: "Bearer test", ...headers },
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
        id: "user-1",
        mode: "simple-key",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-1",
      },
    }),
  );
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
  demoIndustryFixture = undefined;
});

describe("GET /api/v1/starter-prompts", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
    );

    const res = await req("/api/v1/starter-prompts");

    expect(res.status).toBe(401);
  });

  it("returns empty list when no demo industry is set (cold-start)", async () => {
    demoIndustryFixture = undefined;

    const res = await req("/api/v1/starter-prompts");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.prompts).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns library prompts for the workspace's demo industry", async () => {
    demoIndustryFixture = "cybersecurity";
    mocks.mockInternalQuery.mockImplementation(async () => [
      { id: "item-1", question: "How many open incidents this week?" },
      { id: "item-2", question: "Which hosts have unpatched CVEs?" },
    ]);

    const res = await req("/api/v1/starter-prompts");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompts: Array<{ id: string; text: string; provenance: string }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.prompts).toEqual([
      { id: "item-1", text: "How many open incidents this week?", provenance: "library" },
      { id: "item-2", text: "Which hosts have unpatched CVEs?", provenance: "library" },
    ]);
  });

  it("honors limit query parameter (clamped to 50)", async () => {
    demoIndustryFixture = "ecommerce";

    await req("/api/v1/starter-prompts?limit=100");

    // Resolver clamps to 50 before calling internalQuery
    const sqlCalls = mocks.mockInternalQuery.mock.calls;
    expect(sqlCalls.length).toBeGreaterThan(0);
    const [, params] = sqlCalls[0]!;
    // Expected params order: industry, orgId, coldWindowDays, limit
    expect(params![3]).toBe(50);
  });

  it("defaults to limit=6 when no query parameter is provided", async () => {
    demoIndustryFixture = "ecommerce";

    await req("/api/v1/starter-prompts");

    const sqlCalls = mocks.mockInternalQuery.mock.calls;
    expect(sqlCalls.length).toBeGreaterThan(0);
    const [, params] = sqlCalls[0]!;
    expect(params![3]).toBe(6);
  });
});
