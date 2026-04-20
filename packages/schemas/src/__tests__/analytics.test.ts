import { describe, expect, test } from "bun:test";
import {
  AuditErrorsResponseSchema,
  AuditFrequentResponseSchema,
  AuditSlowResponseSchema,
  AuditUserStatsSchema,
  AuditUsersResponseSchema,
  AuditVolumeResponseSchema,
  ErrorGroupSchema,
  FrequentQuerySchema,
  SlowQuerySchema,
  TokenSummarySchema,
  TokenUserResponseSchema,
  TrendPointSchema,
  TrendsResponseSchema,
  UsageSummarySchema,
  UserTokenRowSchema,
  VolumePointSchema,
} from "../analytics";

describe("audit analytics", () => {
  test("VolumePointSchema parses a daily-volume row", () => {
    const row = { day: "2026-04-20", count: 1000, errors: 15 };
    expect(VolumePointSchema.parse(row)).toEqual(row);
  });

  test("SlowQuerySchema parses a slow-query row", () => {
    const row = { query: "SELECT *", avgDuration: 500, maxDuration: 2000, count: 10 };
    expect(SlowQuerySchema.parse(row)).toEqual(row);
  });

  test("FrequentQuerySchema parses a frequent-query row", () => {
    const row = { query: "SELECT 1", count: 1000, avgDuration: 10, errorCount: 3 };
    expect(FrequentQuerySchema.parse(row)).toEqual(row);
  });

  test("ErrorGroupSchema parses an error group", () => {
    const row = { error: "relation does not exist", count: 5 };
    expect(ErrorGroupSchema.parse(row)).toEqual(row);
  });

  test("AuditUserStatsSchema parses a user-stats row", () => {
    const row = {
      userId: "user_1",
      userEmail: "alice@example.com",
      count: 100,
      avgDuration: 250,
      errorCount: 2,
      errorRate: 0.02,
    };
    expect(AuditUserStatsSchema.parse(row)).toEqual(row);
  });

  test("AuditUserStatsSchema accepts null userEmail", () => {
    const row = { userId: "user_2", userEmail: null, count: 1, avgDuration: 1, errorCount: 0, errorRate: 0 };
    expect(AuditUserStatsSchema.parse(row)).toEqual(row);
  });

  test("response envelopes parse arrays", () => {
    expect(AuditVolumeResponseSchema.parse({ volume: [{ day: "2026-04-20", count: 1, errors: 0 }] }).volume).toHaveLength(1);
    expect(AuditSlowResponseSchema.parse({ queries: [] }).queries).toEqual([]);
    expect(AuditFrequentResponseSchema.parse({ queries: [] }).queries).toEqual([]);
    expect(AuditErrorsResponseSchema.parse({ errors: [] }).errors).toEqual([]);
    expect(AuditUsersResponseSchema.parse({ users: [] }).users).toEqual([]);
  });
});

describe("token usage", () => {
  test("TokenSummarySchema parses + requires ISO timestamps", () => {
    const row = {
      totalPromptTokens: 1000,
      totalCompletionTokens: 500,
      totalTokens: 1500,
      totalRequests: 50,
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-04-20T00:00:00.000Z",
    };
    expect(TokenSummarySchema.parse(row)).toEqual(row);
  });

  test("TokenSummarySchema rejects non-ISO from", () => {
    const drifted = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalRequests: 0,
      from: "last week",
      to: "2026-04-20T00:00:00.000Z",
    };
    expect(() => TokenSummarySchema.parse(drifted)).toThrow();
  });

  test("UserTokenRowSchema parses a user-token row", () => {
    const row = {
      userId: "user_1",
      userEmail: "alice@example.com",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      requestCount: 5,
    };
    expect(UserTokenRowSchema.parse(row)).toEqual(row);
  });

  test("TrendPointSchema parses a trend row", () => {
    const row = {
      day: "2026-04-20",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      requestCount: 5,
    };
    expect(TrendPointSchema.parse(row)).toEqual(row);
  });

  test("TrendsResponseSchema parses full trends", () => {
    const response = {
      trends: [],
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-04-20T00:00:00.000Z",
    };
    expect(TrendsResponseSchema.parse(response).trends).toEqual([]);
  });

  test("TokenUserResponseSchema parses user list", () => {
    expect(TokenUserResponseSchema.parse({ users: [] }).users).toEqual([]);
  });
});

describe("usage summary", () => {
  const validSummary = {
    workspaceId: "org_1",
    current: {
      queryCount: 100,
      tokenCount: 50000,
      activeUsers: 5,
      periodStart: "2026-04-01T00:00:00.000Z",
      periodEnd: "2026-04-20T00:00:00.000Z",
    },
    plan: {
      tier: "pro",
      displayName: "Pro",
      trialEndsAt: null,
    },
    limits: {
      tokenBudgetPerSeat: 1_000_000,
      totalTokenBudget: null,
      maxSeats: null,
      maxConnections: 10,
    },
    history: [
      { period_start: "2026-04-19", query_count: 50, token_count: 25000, active_users: 3 },
    ],
    users: [
      { user_id: "user_1", query_count: 10, token_count: 5000, login_count: 3 },
    ],
    hasStripe: true,
  };

  test("parses a full usage summary", () => {
    expect(UsageSummarySchema.parse(validSummary)).toEqual(validSummary);
  });

  test("accepts null trial end + limit fields", () => {
    const loose = {
      ...validSummary,
      plan: { ...validSummary.plan, trialEndsAt: null },
      limits: {
        tokenBudgetPerSeat: null,
        totalTokenBudget: null,
        maxSeats: null,
        maxConnections: null,
      },
    };
    expect(() => UsageSummarySchema.parse(loose)).not.toThrow();
  });

  test("rejects non-ISO periodStart", () => {
    const drifted = {
      ...validSummary,
      current: { ...validSummary.current, periodStart: "April 1st" },
    };
    expect(() => UsageSummarySchema.parse(drifted)).toThrow();
  });
});
