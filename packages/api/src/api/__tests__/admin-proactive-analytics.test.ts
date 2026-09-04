/**
 * Route tests for the EE-gated proactive admin surfaces that reach their
 * implementation through the `EELayer` Tags (post-#3999):
 *
 *   - `GET  /api/v1/admin/proactive/analytics`                (#2296, #2301)
 *   - `GET  /api/v1/admin/proactive/events`                   (#2622)
 *   - `POST /api/v1/admin/proactive/events/:messageId/review` (#2622)
 *   - `/api/v1/admin/proactive/public-dataset/*`              (#2297)
 *
 * The routes read `AnswerMeter` (summary / listEvents / reviewSummary) and
 * the composite `ProactiveService` (quota, review upsert, allowlist CRUD,
 * refused rollup) via Effect Tags, all provided by one mocked `EELayer`
 * below — keeping the tests free of Postgres while still exercising the full
 * Hono → Effect → service path. The enterprise gate is a `ProactiveGate`
 * stub flipped via `enterpriseEnabled`, so the EE-off path lands on a typed
 * `EnterpriseError` rather than chasing global env state. `mock.module()`
 * factories must be sync (CLAUDE.md).
 *
 * The workspace / channels surfaces (`admin-proactive.test.ts`) mount the
 * sub-router with hand-rolled mocks and stay in their own file.
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
  ListEventsResult,
  ProactiveEventRow,
  ProactiveMeterEvent,
  ProactiveMeterSummary,
  ProactiveReviewSummary,
} from "@atlas/api/lib/proactive/answer-meter";
import type {
  PublicDatasetEntry,
  PublicRefusedRollupRow,
  UpsertReviewInput,
  UpsertReviewResult,
} from "@atlas/api/lib/proactive/types";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Analytics — default summary + quota used across tests
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
// Events — meter + review fixtures
// ---------------------------------------------------------------------------

function baseEvents(): ProactiveEventRow[] {
  return [
    {
      id: "row-1",
      workspaceId: "org-alpha",
      channelId: "C-alpha",
      messageId: "1700000000.000123",
      eventType: "classify",
      outcome: null,
      tokens: 42,
      costMicroUsd: 1200,
      confidence: 0.85,
      actorUserId: null,
      metadata: { action: "react", reason: "matched-question-shape" },
      createdAt: "2026-05-19T03:00:00.000Z",
      review: null,
    },
    {
      id: "row-2",
      workspaceId: "org-alpha",
      channelId: "C-alpha",
      messageId: "1700000000.000124",
      eventType: "classify",
      outcome: null,
      tokens: 41,
      costMicroUsd: 1100,
      confidence: 0.72,
      actorUserId: null,
      metadata: { action: "skip", reason: "low-confidence" },
      createdAt: "2026-05-19T02:00:00.000Z",
      review: {
        verdict: "correct",
        note: null,
        reviewerUserId: "u-1",
        createdAt: "2026-05-19T02:30:00.000Z",
        updatedAt: "2026-05-19T02:30:00.000Z",
      },
    },
  ];
}

const baseReviewSummary: ProactiveReviewSummary = {
  classifyCount: 12,
  reviewedCount: 4,
  misfireCount: 1,
  correctCount: 2,
  unsureCount: 1,
};

const mockListEvents: Mock<
  (workspaceId: string, options: unknown) => Promise<ListEventsResult>
> = mock(async () => ({ events: baseEvents(), nextCursor: null }));

const mockReviewSummary: Mock<
  (workspaceId: string, sinceMs: number) => Promise<ProactiveReviewSummary>
> = mock(async () => baseReviewSummary);

// classification-review — verdict upsert + classify-row existence guard.
// After #3999 these reach the route through the `ProactiveService` Tag
// (provided by the mocked EELayer below) rather than a per-module mock.
const mockUpsertReview: Mock<
  (input: UpsertReviewInput) => Promise<UpsertReviewResult>
> = mock(async (input) => ({
  workspaceId: input.workspaceId,
  messageId: input.messageId,
  verdict: input.verdict,
  reviewerUserId: input.reviewerUserId,
  note: input.note,
  previousVerdict: null,
  createdAt: "2026-05-19T03:00:00.000Z",
  updatedAt: "2026-05-19T03:00:00.000Z",
}));
const mockLookupChannel: Mock<
  (workspaceId: string, messageId: string) => Promise<string | null>
> = mock(async () => "C-alpha");

// Internal DB — `createApiTestMocks` owns the canonical
// `@atlas/api/lib/db/internal` mock for this file (it re-installs the
// mock during construction and exposes `mocks.hasInternalDB` as the
// per-test setter). We deliberately do NOT re-mock the module here
// because the later `mock.module()` call from `createApiTestMocks`
// would overwrite ours and the route would read the helper's value.

// ---------------------------------------------------------------------------
// Public-dataset fns — supplied through the mocked EELayer below (no
// per-lib-module mock), same as the meter/review seams.
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

// ---------------------------------------------------------------------------
// Audit dual-write capture (events review route)
// ---------------------------------------------------------------------------

interface ObservedAuditCall {
  actionType: string;
  targetType: string;
  targetId: string;
  scope?: "platform" | "workspace";
  metadata?: Record<string, unknown>;
}
const observedAuditCalls: ObservedAuditCall[] = [];

// oxlint-disable-next-line @typescript-eslint/no-require-imports
const realAuditAdmin = require("@atlas/api/lib/audit/admin") as typeof import("@atlas/api/lib/audit/admin");
void mock.module("@atlas/api/lib/audit/admin", () => ({
  ...realAuditAdmin,
  logAdminAction: (entry: ObservedAuditCall) => {
    observedAuditCalls.push(entry);
  },
}));

// ---------------------------------------------------------------------------
// Enterprise gate + proactive Tags — the routes yield `ProactiveGate`
// (gate), `AnswerMeter` (summary / events) and `ProactiveService` (quota,
// review, allowlist) from EELayer. Default-on so the routes reach the
// services; flip `enterpriseEnabled` to drive the 403 path.
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
          listEvents: mockListEvents,
          reviewSummary: mockReviewSummary,
        });
        const proactive = services.createProactiveServiceTestLayer({
          getWorkspaceQuotaStatus: (workspaceId: string) =>
            E.promise(() => mockQuotaStatus(workspaceId)),
          lookupClassifyChannel: (workspaceId: string, messageId: string) =>
            E.promise(() => mockLookupChannel(workspaceId, messageId)),
          upsertClassificationReview: (input) =>
            E.promise(() => mockUpsertReview(input)),
          getAllowlist: (workspaceId: string) =>
            E.promise(() => mockGetAllowlist(workspaceId)),
          addEntry: (workspaceId: string, entityName: string, denyMetrics: string[]) =>
            E.promise(() => mockAddEntry(workspaceId, entityName, denyMetrics)),
          removeEntry: (workspaceId: string, entityName: string) =>
            E.promise(() => mockRemoveEntry(workspaceId, entityName)),
          summarizePublicRefused: (workspaceId: string, sinceMs: number) =>
            E.promise(() => mockSummarizeRefused(workspaceId, sinceMs)),
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
  observedAuditCalls.length = 0;
  mockSummary.mockClear();
  mockSummary.mockImplementation(async () => baseSummary);
  mockQuotaStatus.mockClear();
  mockQuotaStatus.mockImplementation(async () => baseQuota);
  mockListEvents.mockClear();
  mockListEvents.mockImplementation(async () => ({
    events: baseEvents(),
    nextCursor: null,
  }));
  mockReviewSummary.mockClear();
  mockReviewSummary.mockImplementation(async () => baseReviewSummary);
  mockUpsertReview.mockClear();
  mockUpsertReview.mockImplementation(async (input) => ({
    workspaceId: input.workspaceId,
    messageId: input.messageId,
    verdict: input.verdict,
    reviewerUserId: input.reviewerUserId,
    note: input.note,
    previousVerdict: null,
    createdAt: "2026-05-19T03:00:00.000Z",
    updatedAt: "2026-05-19T03:00:00.000Z",
  }));
  mockLookupChannel.mockClear();
  mockLookupChannel.mockImplementation(async () => "C-alpha");
  mockGetAllowlist.mockClear();
  mockGetAllowlist.mockImplementation(async () => []);
  mockAddEntry.mockClear();
  mockAddEntry.mockImplementation(async () => {});
  mockRemoveEntry.mockClear();
  mockRemoveEntry.mockImplementation(async () => ({ removed: true }));
  mockSummarizeRefused.mockClear();
  mockSummarizeRefused.mockImplementation(async () => []);
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

function getEvents(path = "/api/v1/admin/proactive/events"): Request {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers: { Authorization: "Bearer test-key" },
  });
}

function postReview(messageId: string, body: unknown): Request {
  return new Request(
    `http://localhost/api/v1/admin/proactive/events/${messageId}/review`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

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
// GET /analytics
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

// ---------------------------------------------------------------------------
// GET /events (#2622)
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/proactive/events", () => {
  it("returns the events page + review summary by default", async () => {
    const res = await app.fetch(getEvents());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      sinceMs: number;
      events: ProactiveEventRow[];
      nextCursor: string | null;
      reviewSummary: ProactiveReviewSummary;
    };
    expect(body.workspaceId).toBe("org-alpha");
    expect(body.sinceMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(body.events).toHaveLength(2);
    expect(body.events[0]!.messageId).toBe("1700000000.000123");
    expect(body.reviewSummary.misfireCount).toBe(1);
    expect(mockListEvents).toHaveBeenCalledTimes(1);
    expect(mockListEvents.mock.calls[0]![0]).toBe("org-alpha");
  });

  it("threads since= and eventType= into the meter call", async () => {
    await app.fetch(
      getEvents("/api/v1/admin/proactive/events?since=7d&eventType=react"),
    );
    expect(mockListEvents.mock.calls[0]![1]).toMatchObject({
      sinceMs: 7 * 24 * 60 * 60 * 1000,
      eventType: "react",
    });
  });

  it("ignores unknown eventType values (treated as no filter)", async () => {
    await app.fetch(
      getEvents("/api/v1/admin/proactive/events?eventType=garbage"),
    );
    const options = mockListEvents.mock.calls[0]![1] as { eventType?: string };
    expect(options.eventType).toBeUndefined();
  });

  it("encodes nextCursor as `<createdAt>|<uuid>`", async () => {
    const ROW_ID = "550e8400-e29b-41d4-a716-446655440000";
    mockListEvents.mockImplementationOnce(async () => ({
      events: baseEvents(),
      nextCursor: { createdAt: "2026-05-19T02:00:00.000Z", id: ROW_ID },
    }));
    const res = await app.fetch(getEvents());
    const body = (await res.json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBe(`2026-05-19T02:00:00.000Z|${ROW_ID}`);
  });

  it("decodes a well-formed cursor query param back into structured form", async () => {
    const ROW_ID = "550e8400-e29b-41d4-a716-446655440000";
    await app.fetch(
      getEvents(
        `/api/v1/admin/proactive/events?cursor=2026-05-19T02:00:00.000Z|${ROW_ID}`,
      ),
    );
    const options = mockListEvents.mock.calls[0]![1] as {
      cursor?: { createdAt: string; id: string };
    };
    expect(options.cursor).toEqual({
      createdAt: "2026-05-19T02:00:00.000Z",
      id: ROW_ID,
    });
  });

  // Cursor decoder fallbacks — each malformed shape should NOT 400; the
  // route should silently fall back to first-page (cursor=null upstream)
  // and emit a warn line (not asserted here — just the behavioural fallback).
  for (const [label, cursor] of [
    ["missing separator", "justatimestamp"],
    ["empty timestamp half", "|550e8400-e29b-41d4-a716-446655440000"],
    ["empty id half", "2026-05-19T02:00:00.000Z|"],
    ["unparseable timestamp", "not-a-date|550e8400-e29b-41d4-a716-446655440000"],
    ["non-UUID id", "2026-05-19T02:00:00.000Z|row-2"],
    ["truncated UUID", "2026-05-19T02:00:00.000Z|550e8400-e29b-41d4"],
  ] as const) {
    it(`falls back to first page when cursor is malformed: ${label}`, async () => {
      const res = await app.fetch(
        getEvents(
          `/api/v1/admin/proactive/events?cursor=${encodeURIComponent(cursor)}`,
        ),
      );
      expect(res.status).toBe(200);
      const options = mockListEvents.mock.calls[0]![1] as {
        cursor?: { createdAt: string; id: string } | null;
      };
      expect(options.cursor ?? null).toBeNull();
    });
  }

  it("round-trips encode → decode for a real UUID cursor", async () => {
    const ROW_ID = "11111111-2222-3333-4444-555555555555";
    mockListEvents.mockImplementationOnce(async () => ({
      events: baseEvents(),
      nextCursor: { createdAt: "2026-05-19T02:00:00.000Z", id: ROW_ID },
    }));
    const firstRes = await app.fetch(getEvents());
    const { nextCursor } = (await firstRes.json()) as { nextCursor: string };
    expect(nextCursor).not.toBeNull();
    mockListEvents.mockClear();
    await app.fetch(
      getEvents(
        `/api/v1/admin/proactive/events?cursor=${encodeURIComponent(nextCursor)}`,
      ),
    );
    const options = mockListEvents.mock.calls[0]![1] as {
      cursor?: { createdAt: string; id: string };
    };
    expect(options.cursor).toEqual({
      createdAt: "2026-05-19T02:00:00.000Z",
      id: ROW_ID,
    });
  });

  it("returns 403 enterprise_required when EE is disabled", async () => {
    enterpriseEnabled = false;
    const res = await app.fetch(getEvents());
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /events/:messageId/review (#2622)
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/proactive/events/:messageId/review", () => {
  it("upserts the verdict and writes a proactive.review audit row", async () => {
    const res = await app.fetch(
      postReview("1700000000.000123", { verdict: "misfire", note: "fp" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as UpsertReviewResult;
    expect(body.verdict).toBe("misfire");
    expect(body.note).toBe("fp");
    expect(mockUpsertReview).toHaveBeenCalledTimes(1);
    expect(mockUpsertReview.mock.calls[0]![0]).toMatchObject({
      workspaceId: "org-alpha",
      messageId: "1700000000.000123",
      verdict: "misfire",
      note: "fp",
    });

    const reviewAudit = observedAuditCalls.find(
      (c) => c.actionType === "proactive.review",
    );
    expect(reviewAudit).toBeDefined();
    expect(reviewAudit!.targetId).toBe("1700000000.000123");
    expect(reviewAudit!.scope).toBe("workspace");
    expect(reviewAudit!.metadata).toMatchObject({
      workspaceId: "org-alpha",
      channelId: "C-alpha",
      messageId: "1700000000.000123",
      verdict: "misfire",
      previousVerdict: null,
      note: "fp",
    });
  });

  it("stamps previousVerdict on the audit row when relabelling", async () => {
    mockUpsertReview.mockImplementationOnce(async (input) => ({
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      verdict: input.verdict,
      reviewerUserId: input.reviewerUserId,
      note: input.note,
      previousVerdict: "correct",
      createdAt: "2026-05-19T01:00:00.000Z",
      updatedAt: "2026-05-19T03:00:00.000Z",
    }));
    await app.fetch(
      postReview("1700000000.000123", { verdict: "misfire" }),
    );
    const audit = observedAuditCalls.find(
      (c) => c.actionType === "proactive.review",
    );
    expect(audit!.metadata).toMatchObject({
      verdict: "misfire",
      previousVerdict: "correct",
    });
  });

  it("returns 404 when no matching classify row exists", async () => {
    mockLookupChannel.mockImplementationOnce(async () => null);
    const res = await app.fetch(
      postReview("ghost-msg", { verdict: "misfire" }),
    );
    expect(res.status).toBe(404);
    expect(mockUpsertReview).not.toHaveBeenCalled();
    expect(
      observedAuditCalls.find((c) => c.actionType === "proactive.review"),
    ).toBeUndefined();
  });

  it("returns 400 on an invalid verdict", async () => {
    const res = await app.fetch(
      postReview("1700000000.000123", { verdict: "garbage" }),
    );
    expect(res.status).toBe(400);
    expect(mockUpsertReview).not.toHaveBeenCalled();
  });

  it("returns 400 when note exceeds 1024 characters (privacy floor)", async () => {
    const note = "x".repeat(1025);
    const res = await app.fetch(
      postReview("1700000000.000123", { verdict: "misfire", note }),
    );
    expect(res.status).toBe(400);
    expect(mockUpsertReview).not.toHaveBeenCalled();
  });

  it("returns 404 when the internal DB is not configured (admin-router gate)", async () => {
    // `requireOrgContext()` middleware checks hasInternalDB() and 404s
    // before the route runs — we pin the gate at the middleware layer
    // here rather than at a route-level fallback (the route check would
    // be unreachable). Matches the public-dataset tests below.
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      postReview("1700000000.000123", { verdict: "misfire" }),
    );
    expect(res.status).toBe(404);
    expect(mockUpsertReview).not.toHaveBeenCalled();
  });

  it("returns 403 enterprise_required when EE is disabled", async () => {
    enterpriseEnabled = false;
    const res = await app.fetch(
      postReview("1700000000.000123", { verdict: "misfire" }),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// /public-dataset/* (#2297)
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
