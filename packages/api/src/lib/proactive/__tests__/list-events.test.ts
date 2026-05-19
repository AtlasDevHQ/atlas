/**
 * Unit tests for `listMeterEvents` + `summarizeReviewVerdicts` (#2622).
 *
 * Mocks `internalQuery` to capture the params each call passes through,
 * pins the cursor / limit / event-type filter contract, and verifies
 * the snake_case → camelCase normalisation (including the bigint-as-
 * string coercion `pg` emits for COUNT(*) results).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

interface QueryCall {
  sql: string;
  params: unknown[];
}
const calls: QueryCall[] = [];
let nextRows: unknown[] = [];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realInternal = require("@atlas/api/lib/db/internal");
mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => true,
  internalQuery: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    const next = nextRows;
    nextRows = [];
    return next;
  },
}));

const { listMeterEvents, summarizeReviewVerdicts, MAX_EVENT_PAGE_LIMIT } =
  await import("../answer-meter");

beforeEach(() => {
  calls.length = 0;
  nextRows = [];
});

afterEach(() => {
  calls.length = 0;
});

describe("listMeterEvents (#2622)", () => {
  it("threads workspaceId / cutoff / eventType / limit through the query", async () => {
    nextRows = [];
    await listMeterEvents("ws-1", {
      sinceMs: 30 * 24 * 60 * 60 * 1000,
      eventType: "classify",
      limit: 25,
    });
    expect(calls).toHaveLength(1);
    const params = calls[0]!.params;
    expect(params[0]).toBe("ws-1");
    // params[1] is the ISO cutoff; we just sanity-check the type.
    expect(typeof params[1]).toBe("string");
    expect(params[2]).toBe("classify");
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
    expect(params[5]).toBe(26); // limit + 1 to detect hasMore
  });

  it("clamps limit to MAX_EVENT_PAGE_LIMIT", async () => {
    nextRows = [];
    await listMeterEvents("ws-1", { sinceMs: 1000, limit: 9999 });
    expect(calls[0]!.params[5]).toBe(MAX_EVENT_PAGE_LIMIT + 1);
  });

  it("defaults to no eventType filter (empty string sentinel)", async () => {
    nextRows = [];
    await listMeterEvents("ws-1", { sinceMs: 1000 });
    expect(calls[0]!.params[2]).toBe("");
  });

  it("threads cursor (createdAt, id) when supplied", async () => {
    nextRows = [];
    await listMeterEvents("ws-1", {
      sinceMs: 1000,
      cursor: { createdAt: "2026-05-19T00:00:00.000Z", id: "uuid-1" },
    });
    expect(calls[0]!.params[3]).toBe("2026-05-19T00:00:00.000Z");
    expect(calls[0]!.params[4]).toBe("uuid-1");
  });

  it("normalises a meter row + verdict join into camelCase", async () => {
    nextRows = [
      {
        id: "row-1",
        workspace_id: "ws-1",
        channel_id: "C-1",
        message_id: "1700000000.000123",
        event_type: "classify",
        outcome: null,
        tokens: 42,
        cost_micro_usd: "1234",
        confidence: "0.85",
        actor_user_id: null,
        metadata: { action: "react", reason: "matched-question-shape" },
        created_at: "2026-05-19T00:00:00.000Z",
        review_verdict: "correct",
        review_note: "looked right",
        review_reviewer_user_id: "u-admin",
        review_created_at: "2026-05-19T01:00:00.000Z",
        review_updated_at: "2026-05-19T01:00:00.000Z",
      },
    ];
    const result = await listMeterEvents("ws-1", { sinceMs: 1000 });
    expect(result.events).toHaveLength(1);
    const event = result.events[0]!;
    expect(event.id).toBe("row-1");
    expect(event.channelId).toBe("C-1");
    expect(event.messageId).toBe("1700000000.000123");
    expect(event.confidence).toBe(0.85);
    expect(event.costMicroUsd).toBe(1234);
    expect(event.metadata).toEqual({
      action: "react",
      reason: "matched-question-shape",
    });
    expect(event.review).toEqual({
      verdict: "correct",
      note: "looked right",
      reviewerUserId: "u-admin",
      createdAt: "2026-05-19T01:00:00.000Z",
      updatedAt: "2026-05-19T01:00:00.000Z",
    });
  });

  it("returns review=null when no verdict has been recorded", async () => {
    nextRows = [
      {
        id: "row-1",
        workspace_id: "ws-1",
        channel_id: "C-1",
        message_id: "M-1",
        event_type: "classify",
        outcome: null,
        tokens: 0,
        cost_micro_usd: 0,
        confidence: 0.5,
        actor_user_id: null,
        metadata: {},
        created_at: "2026-05-19T00:00:00.000Z",
        review_verdict: null,
        review_note: null,
        review_reviewer_user_id: null,
        review_created_at: null,
        review_updated_at: null,
      },
    ];
    const result = await listMeterEvents("ws-1", { sinceMs: 1000 });
    expect(result.events[0]!.review).toBeNull();
  });

  it("emits a nextCursor when the DB returns limit+1 rows", async () => {
    // Three rows for limit=2 — the extra row drives hasMore.
    nextRows = [
      sampleRow("a", "2026-05-19T03:00:00.000Z"),
      sampleRow("b", "2026-05-19T02:00:00.000Z"),
      sampleRow("c", "2026-05-19T01:00:00.000Z"),
    ];
    const result = await listMeterEvents("ws-1", { sinceMs: 1000, limit: 2 });
    expect(result.events).toHaveLength(2);
    expect(result.nextCursor).toEqual({
      createdAt: "2026-05-19T02:00:00.000Z",
      id: "b",
    });
  });

  it("emits a null nextCursor when the page is exact-size", async () => {
    nextRows = [
      sampleRow("a", "2026-05-19T03:00:00.000Z"),
      sampleRow("b", "2026-05-19T02:00:00.000Z"),
    ];
    const result = await listMeterEvents("ws-1", { sinceMs: 1000, limit: 2 });
    expect(result.events).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("parses metadata when pg returns it as a JSON string", async () => {
    nextRows = [
      {
        ...sampleRow("a", "2026-05-19T03:00:00.000Z"),
        metadata: JSON.stringify({ action: "skip" }),
      },
    ];
    const result = await listMeterEvents("ws-1", { sinceMs: 1000 });
    expect(result.events[0]!.metadata).toEqual({ action: "skip" });
  });

  it("returns empty result with no DB call when no internal DB is wired", async () => {
    mock.module("@atlas/api/lib/db/internal", () => ({
      ...realInternal,
      hasInternalDB: () => false,
      internalQuery: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return [];
      },
    }));
    // Re-import so the listMeterEvents closure binds against the new
    // module factory.
    const refreshed = await import("../answer-meter");
    const result = await refreshed.listMeterEvents("ws-1", { sinceMs: 1000 });
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(calls).toHaveLength(0);
    // Restore for siblings.
    mock.module("@atlas/api/lib/db/internal", () => ({
      ...realInternal,
      hasInternalDB: () => true,
      internalQuery: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        const next = nextRows;
        nextRows = [];
        return next;
      },
    }));
  });
});

describe("summarizeReviewVerdicts (#2622)", () => {
  it("coerces bigint-as-string COUNT(*) results into numbers", async () => {
    nextRows = [
      {
        classify_count: "100",
        reviewed_count: "20",
        misfire_count: "3",
        correct_count: "15",
        unsure_count: "2",
      },
    ];
    const summary = await summarizeReviewVerdicts("ws-1", 1000);
    expect(summary.classifyCount).toBe(100);
    expect(summary.reviewedCount).toBe(20);
    expect(summary.misfireCount).toBe(3);
    expect(summary.correctCount).toBe(15);
    expect(summary.unsureCount).toBe(2);
  });

  it("returns zeros when the DB returns no rows", async () => {
    nextRows = [];
    const summary = await summarizeReviewVerdicts("ws-1", 1000);
    expect(summary).toEqual({
      classifyCount: 0,
      reviewedCount: 0,
      misfireCount: 0,
      correctCount: 0,
      unsureCount: 0,
    });
  });
});

function sampleRow(id: string, createdAt: string) {
  return {
    id,
    workspace_id: "ws-1",
    channel_id: "C-1",
    message_id: "M-" + id,
    event_type: "classify",
    outcome: null,
    tokens: 0,
    cost_micro_usd: 0,
    confidence: 0.5,
    actor_user_id: null,
    metadata: {},
    created_at: createdAt,
    review_verdict: null,
    review_note: null,
    review_reviewer_user_id: null,
    review_created_at: null,
    review_updated_at: null,
  };
}
