/**
 * Audit analytics + token usage + usage summary wire schemas.
 *
 * These are web-only read-side shapes — audit analytics endpoints
 * (`/api/v1/admin/audit/{volume,slow,frequent,errors,users}`), token usage
 * (`/api/v1/admin/token-usage`), and the billing-adjacent usage summary
 * (`/api/v1/admin/usage`). The interfaces themselves aren't published via
 * `@useatlas/types` because nothing outside the admin surface consumes
 * them; `satisfies z.ZodType<T>` against local interfaces still guards
 * structural drift.
 *
 * Timestamp fields go through `IsoTimestampSchema` (#1697).
 */
import { z } from "zod";
import { IsoTimestampSchema } from "./common";

// ---------------------------------------------------------------------------
// Audit analytics
// ---------------------------------------------------------------------------

interface VolumePoint {
  day: string;
  count: number;
  errors: number;
}
interface SlowQuery {
  query: string;
  avgDuration: number;
  maxDuration: number;
  count: number;
}
interface FrequentQuery {
  query: string;
  count: number;
  avgDuration: number;
  errorCount: number;
}
interface ErrorGroup {
  error: string;
  count: number;
}
interface AuditUserStats {
  userId: string;
  userEmail?: string | null;
  count: number;
  avgDuration: number;
  errorCount: number;
  errorRate: number;
}

export const VolumePointSchema = z.object({
  day: z.string(),
  count: z.number(),
  errors: z.number(),
}) satisfies z.ZodType<VolumePoint, unknown>;

export const SlowQuerySchema = z.object({
  query: z.string(),
  avgDuration: z.number(),
  maxDuration: z.number(),
  count: z.number(),
}) satisfies z.ZodType<SlowQuery, unknown>;

export const FrequentQuerySchema = z.object({
  query: z.string(),
  count: z.number(),
  avgDuration: z.number(),
  errorCount: z.number(),
}) satisfies z.ZodType<FrequentQuery, unknown>;

export const ErrorGroupSchema = z.object({
  error: z.string(),
  count: z.number(),
}) satisfies z.ZodType<ErrorGroup, unknown>;

export const AuditUserStatsSchema = z.object({
  userId: z.string(),
  userEmail: z.string().nullable().optional(),
  count: z.number(),
  avgDuration: z.number(),
  errorCount: z.number(),
  errorRate: z.number(),
}) satisfies z.ZodType<AuditUserStats, unknown>;

export const AuditVolumeResponseSchema = z.object({
  volume: z.array(VolumePointSchema),
});

export const AuditSlowResponseSchema = z.object({
  queries: z.array(SlowQuerySchema),
});

export const AuditFrequentResponseSchema = z.object({
  queries: z.array(FrequentQuerySchema),
});

export const AuditErrorsResponseSchema = z.object({
  errors: z.array(ErrorGroupSchema),
});

export const AuditUsersResponseSchema = z.object({
  users: z.array(AuditUserStatsSchema),
});

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

interface TokenSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalRequests: number;
  from: string;
  to: string;
}
interface UserTokenRow {
  userId: string;
  userEmail?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}
interface TrendPoint {
  day: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}

export const TokenSummarySchema = z.object({
  totalPromptTokens: z.number(),
  totalCompletionTokens: z.number(),
  totalTokens: z.number(),
  totalRequests: z.number(),
  from: IsoTimestampSchema,
  to: IsoTimestampSchema,
}) satisfies z.ZodType<TokenSummary, unknown>;

export const UserTokenRowSchema = z.object({
  userId: z.string(),
  userEmail: z.string().nullable().optional(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  requestCount: z.number(),
}) satisfies z.ZodType<UserTokenRow, unknown>;

export const TrendPointSchema = z.object({
  day: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  requestCount: z.number(),
}) satisfies z.ZodType<TrendPoint, unknown>;

export const TrendsResponseSchema = z.object({
  trends: z.array(TrendPointSchema),
  from: IsoTimestampSchema,
  to: IsoTimestampSchema,
});

export const TokenUserResponseSchema = z.object({
  users: z.array(UserTokenRowSchema),
});

// ---------------------------------------------------------------------------
// Usage summary
// ---------------------------------------------------------------------------

const DailyUsagePointSchema = z.object({
  period_start: z.string(),
  query_count: z.number(),
  token_count: z.number(),
  active_users: z.number(),
});

const UserUsageRowSchema = z.object({
  user_id: z.string(),
  query_count: z.number(),
  token_count: z.number(),
  login_count: z.number(),
});

export const UsageSummarySchema = z.object({
  workspaceId: z.string(),
  current: z.object({
    queryCount: z.number(),
    tokenCount: z.number(),
    activeUsers: z.number(),
    periodStart: IsoTimestampSchema,
    periodEnd: IsoTimestampSchema,
  }),
  plan: z.object({
    tier: z.string(),
    displayName: z.string(),
    trialEndsAt: IsoTimestampSchema.nullable(),
  }),
  limits: z.object({
    tokenBudgetPerSeat: z.number().nullable(),
    totalTokenBudget: z.number().nullable(),
    maxSeats: z.number().nullable(),
    maxConnections: z.number().nullable(),
  }),
  history: z.array(DailyUsagePointSchema),
  users: z.array(UserUsageRowSchema),
  hasStripe: z.boolean(),
});
