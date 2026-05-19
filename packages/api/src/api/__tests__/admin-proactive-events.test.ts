/**
 * Route tests for the classifier drill-down + verdict surfaces (#2622).
 *
 * `GET  /api/v1/admin/proactive/events`
 * `POST /api/v1/admin/proactive/events/:messageId/review`
 *
 * Pattern mirrors `admin-proactive-analytics.test.ts` — sync mock.module
 * factories, EE gate stub via the ProactiveGate Tag, standard
 * `createApiTestMocks`.
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
  ProactiveReviewSummary,
} from "@atlas/api/lib/proactive/answer-meter";
import type {
  UpsertReviewInput,
  UpsertReviewResult,
} from "@atlas/api/lib/proactive/classification-review";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Meter + review module mocks
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realAnswerMeter = require("@atlas/api/lib/proactive/answer-meter") as typeof import("@atlas/api/lib/proactive/answer-meter");
mock.module("@atlas/api/lib/proactive/answer-meter", () => ({
  ...realAnswerMeter,
  listMeterEvents: mockListEvents,
  summarizeReviewVerdicts: mockReviewSummary,
  AnswerMeterLive: realAnswerMeter.createAnswerMeterTestLayer({
    listEvents: mockListEvents,
    reviewSummary: mockReviewSummary,
  }),
}));

// classification-review — verdict upsert + classify-row existence guard.
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
const mockClassifyExists: Mock<
  (workspaceId: string, messageId: string) => Promise<boolean>
> = mock(async () => true);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realReview = require("@atlas/api/lib/proactive/classification-review") as typeof import("@atlas/api/lib/proactive/classification-review");
mock.module("@atlas/api/lib/proactive/classification-review", () => ({
  ...realReview,
  upsertClassificationReview: mockUpsertReview,
  classifyEventExists: mockClassifyExists,
}));

// Internal DB — `createApiTestMocks` owns the canonical
// `@atlas/api/lib/db/internal` mock for this file (it re-installs the
// mock during construction and exposes `mocks.hasInternalDB` as the
// per-test setter). We deliberately do NOT re-mock the module here
// because the later `mock.module()` call from `createApiTestMocks`
// would overwrite ours and the route would read the helper's value.

// ---------------------------------------------------------------------------
// Audit dual-write capture
// ---------------------------------------------------------------------------

interface ObservedAuditCall {
  actionType: string;
  targetType: string;
  targetId: string;
  scope?: "platform" | "workspace";
  metadata?: Record<string, unknown>;
}
const observedAuditCalls: ObservedAuditCall[] = [];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realAuditAdmin = require("@atlas/api/lib/audit/admin") as typeof import("@atlas/api/lib/audit/admin");
mock.module("@atlas/api/lib/audit/admin", () => ({
  ...realAuditAdmin,
  logAdminAction: (entry: ObservedAuditCall) => {
    observedAuditCalls.push(entry);
  },
}));

// ---------------------------------------------------------------------------
// Enterprise gate stub
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
// Boot test app
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
  mockClassifyExists.mockClear();
  mockClassifyExists.mockImplementation(async () => true);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GET /events
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

  it("encodes nextCursor as `<createdAt>|<id>`", async () => {
    mockListEvents.mockImplementationOnce(async () => ({
      events: baseEvents(),
      nextCursor: { createdAt: "2026-05-19T02:00:00.000Z", id: "row-2" },
    }));
    const res = await app.fetch(getEvents());
    const body = (await res.json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBe("2026-05-19T02:00:00.000Z|row-2");
  });

  it("decodes a cursor query param back into structured form", async () => {
    await app.fetch(
      getEvents(
        "/api/v1/admin/proactive/events?cursor=2026-05-19T02:00:00.000Z|row-2",
      ),
    );
    const options = mockListEvents.mock.calls[0]![1] as {
      cursor?: { createdAt: string; id: string };
    };
    expect(options.cursor).toEqual({
      createdAt: "2026-05-19T02:00:00.000Z",
      id: "row-2",
    });
  });

  it("returns 403 enterprise_required when EE is disabled", async () => {
    enterpriseEnabled = false;
    const res = await app.fetch(getEvents());
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /events/:messageId/review
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
      messageId: "1700000000.000123",
      verdict: "misfire",
      previousVerdict: null,
      note: "fp",
    });
  });

  it("returns 404 when no matching classify row exists", async () => {
    mockClassifyExists.mockImplementationOnce(async () => false);
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

  it("returns 404 when the internal DB is not configured (admin-router gate)", async () => {
    // `requireOrgContext()` middleware checks hasInternalDB() and 404s
    // before the route runs — we pin the gate at the middleware layer
    // here rather than at a route-level fallback (the route check would
    // be unreachable). Matches admin-proactive-public-dataset.test.ts.
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
