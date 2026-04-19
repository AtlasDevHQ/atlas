/**
 * Approval-workflow wire-format schemas.
 *
 * Single source of truth for the admin approval surface
 * (`/api/v1/admin/approval`). The route layer imports these for OpenAPI
 * response validation; the web layer imports them for `useAdminFetch`
 * response parsing. Before #1648, each layer kept its own Zod copy —
 * with the route enforcing strict `z.enum(...)` while the web copy
 * silently relaxed `ruleType` / `status` to `z.string()`. That
 * asymmetry is exactly the drift surface this package exists to close.
 *
 * The enum tuples (`APPROVAL_RULE_TYPES`, `APPROVAL_STATUSES`) come from
 * `@useatlas/types` so adding a new rule type or status to the TS union
 * propagates here without manual duplication.
 *
 * Every schema uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) so
 * a field rename in `@useatlas/types` breaks this file at compile time
 * instead of passing through to runtime.
 *
 * Strict `z.enum(TUPLE)` matches the `@hono/zod-openapi` extractor's
 * expectations — it cannot serialize `ZodCatch` wrappers (#1653) — and
 * keeps the generated OpenAPI spec describing the genuine output shape.
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

export const ApprovalRuleSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  ruleType: RuleTypeEnum,
  pattern: z.string(),
  threshold: z.number().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<ApprovalRule>;

export const ApprovalRequestSchema = z.object({
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
  status: StatusEnum,
  reviewerId: z.string().nullable(),
  reviewerEmail: z.string().nullable(),
  reviewComment: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
}) satisfies z.ZodType<ApprovalRequest>;
