/**
 * Unit tests for `upsertClassificationReview` + `classifyEventExists`
 * (#2622). Mocks `internalQuery` so the test exercises the SQL params
 * + return-shape without a real Postgres pool.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

interface QueryCall {
  sql: string;
  params: unknown[];
}
const calls: QueryCall[] = [];
const queryResponses: unknown[][] = [];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realInternal = require("@atlas/api/lib/db/internal");
mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => true,
  internalQuery: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return queryResponses.shift() ?? [];
  },
}));

const {
  upsertClassificationReview,
  classifyEventExists,
  PROACTIVE_REVIEW_VERDICTS,
} = await import("../classification-review");

beforeEach(() => {
  calls.length = 0;
  queryResponses.length = 0;
});

describe("upsertClassificationReview (#2622)", () => {
  it("returns previousVerdict=null on first write", async () => {
    queryResponses.push([]); // SELECT prior → no row
    queryResponses.push([
      {
        workspace_id: "ws-1",
        message_id: "M-1",
        verdict: "misfire",
        reviewer_user_id: "u-admin",
        note: "false positive",
        created_at: "2026-05-19T01:00:00.000Z",
        updated_at: "2026-05-19T01:00:00.000Z",
      },
    ]);
    const result = await upsertClassificationReview({
      workspaceId: "ws-1",
      messageId: "M-1",
      verdict: "misfire",
      reviewerUserId: "u-admin",
      note: "false positive",
    });
    expect(result.verdict).toBe("misfire");
    expect(result.previousVerdict).toBeNull();
    expect(result.reviewerUserId).toBe("u-admin");
    expect(result.note).toBe("false positive");
    // SELECT happened before the upsert so we can surface previousVerdict.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toMatch(/SELECT verdict/i);
    expect(calls[1]!.sql).toMatch(/INSERT INTO proactive_classification_review/i);
  });

  it("surfaces the prior verdict on re-review", async () => {
    queryResponses.push([{ verdict: "correct" }]); // SELECT prior
    queryResponses.push([
      {
        workspace_id: "ws-1",
        message_id: "M-1",
        verdict: "misfire",
        reviewer_user_id: "u-admin",
        note: null,
        created_at: "2026-05-19T01:00:00.000Z",
        updated_at: "2026-05-19T02:00:00.000Z",
      },
    ]);
    const result = await upsertClassificationReview({
      workspaceId: "ws-1",
      messageId: "M-1",
      verdict: "misfire",
      reviewerUserId: "u-admin",
      note: null,
    });
    expect(result.previousVerdict).toBe("correct");
    expect(result.verdict).toBe("misfire");
  });

  it("rejects an unknown verdict before touching the DB", async () => {
    await expect(
      upsertClassificationReview({
        workspaceId: "ws-1",
        messageId: "M-1",
        // @ts-expect-error — deliberate invalid value
        verdict: "garbage",
        reviewerUserId: null,
        note: null,
      }),
    ).rejects.toThrow(/invalid verdict/);
    expect(calls).toHaveLength(0);
  });

  it("exports the verdict tuple consumed by zod + the CHECK constraint", () => {
    expect(PROACTIVE_REVIEW_VERDICTS).toEqual(["misfire", "correct", "unsure"]);
  });
});

describe("classifyEventExists (#2622)", () => {
  it("returns true when the classify row is present", async () => {
    queryResponses.push([{ exists: true }]);
    const exists = await classifyEventExists("ws-1", "M-1");
    expect(exists).toBe(true);
    expect(calls[0]!.sql).toMatch(/proactive_meter_events/i);
    expect(calls[0]!.sql).toMatch(/event_type = 'classify'/i);
    expect(calls[0]!.params).toEqual(["ws-1", "M-1"]);
  });

  it("returns false when no classify row exists for the message", async () => {
    queryResponses.push([]);
    const exists = await classifyEventExists("ws-1", "M-1");
    expect(exists).toBe(false);
  });
});
