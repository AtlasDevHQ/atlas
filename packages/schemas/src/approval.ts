/**
 * Approval-workflow wire-format schemas.
 *
 * Single source of truth for the admin approval surface
 * (`/api/v1/admin/approval`). The route layer imports these for OpenAPI
 * response validation; the web layer imports them for `useAdminFetch`
 * response parsing.
 *
 * `ApprovalRuleSchema` and `ApprovalRequestSchema` are `z.discriminatedUnion`
 * over `ruleType` / `status` — matching the shape of `ApprovalRule` and
 * `ApprovalRequest` in `@useatlas/types` (#1660). The variants encode the
 * cross-field invariants the handler layer already enforced at
 * construction time: cost rules require a threshold, table/column rules
 * require a pattern; pending/expired requests cannot carry reviewer
 * metadata; approved/denied requests must have a reviewer stamped.
 *
 * Every variant uses `satisfies z.ZodType<T>` against the matching
 * @useatlas/types branch so a field rename there breaks this file at
 * compile time instead of passing through to runtime.
 *
 * Strict `z.enum(TUPLE)` on the discriminator literal matches the
 * `@hono/zod-openapi` extractor's expectations — it cannot serialize
 * `ZodCatch` wrappers (#1653) — and keeps the generated OpenAPI spec
 * describing the genuine output shape.
 */
import { z } from "zod";
import {
  APPROVAL_RULE_TYPES,
  APPROVAL_STATUSES,
  type ApprovalRule,
  type ApprovalRequest,
} from "@useatlas/types";

const RuleTypeEnum = z.enum(APPROVAL_RULE_TYPES);
const StatusEnum = z.enum(APPROVAL_STATUSES);

// ---------------------------------------------------------------------------
// ApprovalRule — discriminated on `ruleType`
// ---------------------------------------------------------------------------

const ApprovalRuleBaseShape = {
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

const CostRuleSchema = z.object({
  ...ApprovalRuleBaseShape,
  ruleType: z.literal("cost"),
  threshold: z.number(),
  pattern: z.literal(""),
});

const TableRuleSchema = z.object({
  ...ApprovalRuleBaseShape,
  ruleType: z.literal("table"),
  pattern: z.string(),
  threshold: z.null(),
});

const ColumnRuleSchema = z.object({
  ...ApprovalRuleBaseShape,
  ruleType: z.literal("column"),
  pattern: z.string(),
  threshold: z.null(),
});

export const ApprovalRuleSchema = z.discriminatedUnion("ruleType", [
  CostRuleSchema,
  TableRuleSchema,
  ColumnRuleSchema,
]) satisfies z.ZodType<ApprovalRule>;

// `RuleTypeEnum` is exported so existing callers that narrowed against the
// tuple don't have to re-import from `@useatlas/types`.
export { RuleTypeEnum };

// ---------------------------------------------------------------------------
// ApprovalRequest — discriminated on `status`
// ---------------------------------------------------------------------------

const ApprovalRequestBaseShape = {
  id: z.string(),
  orgId: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  requesterId: z.string(),
  requesterEmail: z.string().nullable(),
  querySql: z.string(),
  explanation: z.string().nullable(),
  connectionId: z.string(),
  tablesAccessed: z.array(z.string()),
  columnsAccessed: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string(),
};

const PendingRequestSchema = z.object({
  ...ApprovalRequestBaseShape,
  status: z.literal("pending"),
  reviewerId: z.null(),
  reviewerEmail: z.null(),
  reviewComment: z.null(),
  reviewedAt: z.null(),
});

const ApprovedRequestSchema = z.object({
  ...ApprovalRequestBaseShape,
  status: z.literal("approved"),
  reviewerId: z.string(),
  reviewerEmail: z.string().nullable(),
  reviewComment: z.string().nullable(),
  reviewedAt: z.string(),
});

const DeniedRequestSchema = z.object({
  ...ApprovalRequestBaseShape,
  status: z.literal("denied"),
  reviewerId: z.string(),
  reviewerEmail: z.string().nullable(),
  reviewComment: z.string().nullable(),
  reviewedAt: z.string(),
});

const ExpiredRequestSchema = z.object({
  ...ApprovalRequestBaseShape,
  status: z.literal("expired"),
  reviewerId: z.null(),
  reviewerEmail: z.null(),
  reviewComment: z.null(),
  reviewedAt: z.null(),
});

export const ApprovalRequestSchema = z.discriminatedUnion("status", [
  PendingRequestSchema,
  ApprovedRequestSchema,
  DeniedRequestSchema,
  ExpiredRequestSchema,
]) satisfies z.ZodType<ApprovalRequest>;

export { StatusEnum };
