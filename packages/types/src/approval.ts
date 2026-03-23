/**
 * Approval workflow types shared across API, frontend, and SDK.
 *
 * Enterprise customers can configure approval rules that intercept sensitive
 * queries (by table, column, or cost threshold) and require sign-off before
 * execution.
 */

// ── Rule types ──────────────────────────────────────────────────────

export const APPROVAL_RULE_TYPES = ["table", "column", "cost"] as const;
export type ApprovalRuleType = (typeof APPROVAL_RULE_TYPES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// ── Approval rule ───────────────────────────────────────────────────

export interface ApprovalRule {
  id: string;
  orgId: string;
  name: string;
  ruleType: ApprovalRuleType;
  /** For table rules: table name pattern. For column rules: column name pattern. For cost: unused. */
  pattern: string;
  /** For cost rules: threshold value. Null for table/column rules. */
  threshold: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Approval request (queue item) ───────────────────────────────────

export interface ApprovalRequest {
  id: string;
  orgId: string;
  ruleId: string;
  ruleName: string;
  requesterId: string;
  requesterEmail: string | null;
  /** The SQL query awaiting approval. */
  querySql: string;
  explanation: string | null;
  connectionId: string;
  tablesAccessed: string[];
  columnsAccessed: string[];
  status: ApprovalStatus;
  reviewerId: string | null;
  reviewerEmail: string | null;
  reviewComment: string | null;
  reviewedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

// ── Request / response shapes ───────────────────────────────────────

export interface CreateApprovalRuleRequest {
  name: string;
  ruleType: ApprovalRuleType;
  pattern: string;
  threshold?: number | null;
  enabled?: boolean;
}

export interface UpdateApprovalRuleRequest {
  name?: string;
  pattern?: string;
  threshold?: number | null;
  enabled?: boolean;
}

export interface ReviewApprovalRequest {
  action: "approve" | "deny";
  comment?: string;
}
