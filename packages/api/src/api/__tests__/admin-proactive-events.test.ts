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
const mockLookupChannel: Mock<
  (workspaceId: string, messageId: string) => Promise<string | null>
> = mock(async () => "C-alpha");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realReview = require("@atlas/api/lib/proactive/classification-review") as typeof import("@atlas/api/lib/proactive/classification-review");
mock.module("@atlas/api/lib/proactive/classification-review", () => ({
  ...realReview,
  upsertClassificationReview: mockUpsertReview,
  lookupClassifyChannel: mockLookupChannel,
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
  mockLookupChannel.mockClear();
  mockLookupChannel.mockImplementation(async () => "C-alpha");
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
