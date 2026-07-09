/**
 * Route test for `GET /api/v1/admin/proactive/analytics` (#2296).
 *
 * The route reads `AnswerMeter.summary` via the Effect service. The
 * test stubs the `summarizeMeterEvents` export with `mock.module()` so
 * the route's `AnswerMeterLive` provider resolves to a fake summary
 * shape — keeping the test free of Postgres while still exercising the
 * full Hono → Effect → service path.
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
  ProactiveMeterEvent,
  ProactiveMeterSummary,
} from "@atlas/api/lib/proactive/answer-meter";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Default summary used across tests
// ---------------------------------------------------------------------------

const baseSummary: ProactiveMeterSummary = {
  classifyCount: 12,
  reactCount: 4,
  offerCount: 0,
  acceptCount: 0,
  feedbackByOutcome: {
    helpful: 2,
    "not-helpful": 1,
    "wrong-data": 0,
    "no-feedback": 0,
  },
  totalCostMicroUsd: 1500,
  byChannel: [
    {
      channelId: "C-alpha",
      classifyCount: 8,
      reactCount: 3,
      offerCount: 0,
      acceptCount: 0,
      feedbackByOutcome: {
        helpful: 2,
        "not-helpful": 1,
        "wrong-data": 0,
        "no-feedback": 0,
      },
      totalCostMicroUsd: 1100,
    },
    {
      channelId: "C-beta",
      classifyCount: 4,
      reactCount: 1,
      offerCount: 0,
      acceptCount: 0,
      feedbackByOutcome: emptyFeedback(),
      totalCostMicroUsd: 400,
    },
  ],
};

function emptyFeedback() {
  return {
    helpful: 0,
    "not-helpful": 0,
    "wrong-data": 0,
    "no-feedback": 0,
  };
}

// ---------------------------------------------------------------------------
// Proactive seams (post-#3999)
//
// The proactive implementation moved to `@atlas/ee/proactive`; the route
// now reaches the meter summary via the `AnswerMeter` Tag and the monthly
// quota via the composite `ProactiveService` Tag, both provided by the
// EELayer (mocked below). No per-lib-module mock — we supply test layers
// for the Tags. `mock.module()` factories must be sync (CLAUDE.md).
// ---------------------------------------------------------------------------

const mockSummary: Mock<
  (workspaceId: string, sinceMs: number) => Promise<ProactiveMeterSummary>
> = mock(async () => baseSummary);
const mockRecord: Mock<(event: ProactiveMeterEvent) => Promise<void>> = mock(
  async () => {},
);

interface QuotaStatusShape {
  monthlyClassifierCap: number | null;
  classifyCountThisMonth: number;
  capReached: boolean;
}

const baseQuota: QuotaStatusShape = {
  monthlyClassifierCap: null,
  classifyCountThisMonth: 0,
  capReached: false,
};

const mockQuotaStatus: Mock<
  (workspaceId: string) => Promise<QuotaStatusShape>
> = mock(async () => baseQuota);

// ---------------------------------------------------------------------------
// Enterprise gate + proactive Tags — the route yields `ProactiveGate`
// (gate), `AnswerMeter` (summary), and `ProactiveService` (quota) from
// EELayer. Default-on so the route reaches the meter; flip
// `enterpriseEnabled` to drive the 403 path.
// ---------------------------------------------------------------------------

let enterpriseEnabled = true;

// Module-top env setup — must be set before the dynamic imports below
// (the imported modules read env at module-load time). `??=` keeps the
// assignment hoisted; cross-file leakage under `bun test --parallel`
// (1.5.4 #2797) is bounded — the first file to load wins, no sibling
// overwrites. Files that need to restore env do so in their own
// afterAll; the `??=` here is the module-load contract, not teardown.
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";

// oxlint-disable-next-line @typescript-eslint/no-require-imports
const effectMod = require("effect") as typeof import("effect");

void mock.module("@atlas/ee/layers", () => {
  const { Layer, Effect: E } = effectMod;
  return {
    EELayer: Layer.unwrapEffect(
      E.sync(() => {
        // oxlint-disable-next-line @typescript-eslint/no-require-imports
        const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
        // oxlint-disable-next-line @typescript-eslint/no-require-imports
        const { EnterpriseError } = require("@atlas/api/lib/effect/errors") as typeof import("@atlas/api/lib/effect/errors");
        const gate = Layer.succeed(services.ProactiveGate, {
          requireEnabled: () =>
            enterpriseEnabled
              ? E.void
              : E.fail(
                  new EnterpriseError(
                    "Enterprise features (proactive-chat) are not enabled.",
                  ),
                ),
        });
        const meter = services.createAnswerMeterTestLayer({
          record: mockRecord,
          summary: mockSummary,
        });
        const proactive = services.createProactiveServiceTestLayer({
          getWorkspaceQuotaStatus: (workspaceId: string) =>
            E.promise(() => mockQuotaStatus(workspaceId)),
        });
        return Layer.mergeAll(gate, meter, proactive);
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
  mockSummary.mockClear();
  mockSummary.mockImplementation(async () => baseSummary);
  mockQuotaStatus.mockClear();
  mockQuotaStatus.mockImplementation(async () => baseQuota);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers: { Authorization: "Bearer test-key" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/proactive/analytics", () => {
  it("returns the summary payload with default 30-day window", async () => {
    const res = await app.fetch(
      adminRequest("/api/v1/admin/proactive/analytics"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      sinceMs: number;
      summary: ProactiveMeterSummary;
    };
    expect(body.workspaceId).toBe("org-alpha");
    expect(body.sinceMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(body.summary.classifyCount).toBe(12);
    expect(body.summary.reactCount).toBe(4);
    expect(body.summary.byChannel).toHaveLength(2);
    expect(mockSummary).toHaveBeenCalledTimes(1);
    expect(mockSummary.mock.calls[0]![0]).toBe("org-alpha");
  });

  it("parses since=7d into a 7-day lookback window", async () => {
    const res = await app.fetch(
      adminRequest("/api/v1/admin/proactive/analytics?since=7d"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sinceMs: number };
    expect(body.sinceMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(mockSummary.mock.calls[0]![1]).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("falls back to the 30-day default for an unparsable since param", async () => {
    const res = await app.fetch(
      adminRequest("/api/v1/admin/proactive/analytics?since=garbage"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sinceMs: number };
    expect(body.sinceMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("returns 403 enterprise_required when EE is disabled", async () => {
    enterpriseEnabled = false;
    const res = await app.fetch(
      adminRequest("/api/v1/admin/proactive/analytics"),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; error?: string };
    // Hono error classifier maps EnterpriseError to 403 with
    // `code: "enterprise_required"`.
    expect(body.code ?? body.error).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // #2301 — monthly quota cap surfaces on the analytics payload
  // -------------------------------------------------------------------------

  it("includes the quota block with capReached=false by default", async () => {
    const res = await app.fetch(
      adminRequest("/api/v1/admin/proactive/analytics"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      quota: {
        classifyCountThisMonth: number;
        monthlyClassifierCap: number | null;
        capReached: boolean;
      };
    };
    expect(body.quota).toEqual({
      classifyCountThisMonth: 0,
      monthlyClassifierCap: null,
      capReached: false,
    });
    expect(mockQuotaStatus).toHaveBeenCalledTimes(1);
    expect(mockQuotaStatus.mock.calls[0]![0]).toBe("org-alpha");
  });

  it("surfaces a non-null cap + current usage", async () => {
    mockQuotaStatus.mockImplementation(async () => ({
      monthlyClassifierCap: 1000,
      classifyCountThisMonth: 420,
      capReached: false,
    }));
    const res = await app.fetch(
      adminRequest("/api/v1/admin/proactive/analytics"),
    );
    const body = (await res.json()) as {
      quota: {
        classifyCountThisMonth: number;
        monthlyClassifierCap: number | null;
        capReached: boolean;
      };
    };
    expect(body.quota.monthlyClassifierCap).toBe(1000);
    expect(body.quota.classifyCountThisMonth).toBe(420);
    expect(body.quota.capReached).toBe(false);
  });

  it("flips capReached=true when the workspace is over its cap", async () => {
    mockQuotaStatus.mockImplementation(async () => ({
      monthlyClassifierCap: 50,
      classifyCountThisMonth: 50,
      capReached: true,
    }));
    const res = await app.fetch(
      adminRequest("/api/v1/admin/proactive/analytics"),
    );
    const body = (await res.json()) as {
      quota: { capReached: boolean };
    };
    expect(body.quota.capReached).toBe(true);
  });
});
