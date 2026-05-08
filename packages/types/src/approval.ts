/**
 * Approval workflow types shared across API, frontend, and SDK.
 *
 * Enterprise customers can configure approval rules that intercept sensitive
 * queries (by table, column, or cost threshold) and require sign-off before
 * execution.
 *
 * `ApprovalRule` and `ApprovalRequest` are discriminated unions — the
 * variants encode cross-field invariants at the wire layer so a malformed
 * row (e.g. a cost rule missing its threshold, or a pending request with a
 * populated reviewerId) is a compile-time error on construction and a
 * parse-time rejection on read. Before #1660 these invariants were
 * documented in the field JSDoc but not enforced structurally.
 */

// ── Rule types ──────────────────────────────────────────────────────

export const APPROVAL_RULE_TYPES = ["table", "column", "cost"] as const;
export type ApprovalRuleType = (typeof APPROVAL_RULE_TYPES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * Surface scope for approval rules (#2072). `'any'` preserves pre-2072
 * fires-for-every-request semantics; the others pin to a transport.
 *
 * Two derived enums share a single source of truth:
 *   - `APPROVAL_RULE_SURFACES` — values an admin can pin a rule to,
 *     including the `'any'` wildcard.
 *   - `APPROVAL_REQUEST_SURFACES` — values stamped on a created approval
 *     request to record where it originated. Derived from the rule
 *     enum by filtering out `'any'` because a real request always has
 *     a single concrete origin (or NULL when the caller didn't stamp).
 *
 * Both the runtime tuple (`.filter(...)`) and the type (`Exclude<>`)
 * are derived so a new transport added to `APPROVAL_RULE_SURFACES`
 * automatically propagates to the request-side enum, the SQL CHECK,
 * and every consumer. PR #2191 review surfaced an earlier shape where
 * the two were independently declared and could drift silently.
 */
export const APPROVAL_RULE_SURFACES = [
  "any",
  "chat",
  "mcp",
  "scheduler",
  "slack",
  "teams",
  "webhook",
] as const;
export type ApprovalRuleSurface = (typeof APPROVAL_RULE_SURFACES)[number];

export type ApprovalRequestSurface = Exclude<ApprovalRuleSurface, "any">;
export const APPROVAL_REQUEST_SURFACES = APPROVAL_RULE_SURFACES.filter(
  (s): s is ApprovalRequestSurface => s !== "any",
);

// ── Approval rule ───────────────────────────────────────────────────

/**
 * Fields common to every approval rule. The `ruleType`-keyed variants below
 * intersect with this base to produce the full `ApprovalRule` shape.
 */
interface ApprovalRuleBase {
  id: string;
  orgId: string;
  name: string;
  enabled: boolean;
  /** #2072 — origin surface this rule applies to. `'any'` (default) fires for every request. */
  surface: ApprovalRuleSurface;
  createdAt: string;
  updatedAt: string;
}

/**
 * Approval rule — three kinds, distinguished by `ruleType`.
 *
 * - `cost` rules match when estimated row count exceeds `threshold`; pattern
 *   is unused and stored as the empty string.
 * - `table` / `column` rules match when a query accesses a name matching
 *   `pattern`; threshold is unused and stored as null.
 *
 * The union encodes the "threshold XOR pattern" invariant at the type level
 * so handlers that construct a rule must name the variant explicitly.
 */
export type ApprovalRule = ApprovalRuleBase & (
  | { ruleType: "cost"; threshold: number; pattern: "" }
  | { ruleType: "table"; pattern: string; threshold: null }
  | { ruleType: "column"; pattern: string; threshold: null }
);

// ── Approval request (queue item) ───────────────────────────────────

/**
 * Fields common to every approval request — the query, requester, and
 * timing metadata. The `status`-keyed variants below intersect with this
 * base to encode reviewer-field nullness invariants.
 */
interface ApprovalRequestBase {
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
  /**
   * #2072 — origin surface of the request that produced this row. `null`
   * for legacy rows or callers that didn't stamp surface on the
   * RequestContext.
   */
  surface: ApprovalRequestSurface | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * Approval request — four lifecycle states. The reviewer-related columns
 * (`reviewerId`, `reviewerEmail`, `reviewComment`, `reviewedAt`) are only
 * populated after a reviewer takes action; the discriminated union encodes
 * this so `pending`/`expired` rows cannot construct with a reviewer set.
 */
export type ApprovalRequest = ApprovalRequestBase & (
  | {
      status: "pending";
      reviewerId: null;
      reviewerEmail: null;
      reviewComment: null;
      reviewedAt: null;
    }
  | {
      status: "approved";
      reviewerId: string;
      reviewerEmail: string | null;
      reviewComment: string | null;
      reviewedAt: string;
    }
  | {
      status: "denied";
      reviewerId: string;
      reviewerEmail: string | null;
      reviewComment: string | null;
      reviewedAt: string;
    }
  | {
      status: "expired";
      reviewerId: null;
      reviewerEmail: null;
      reviewComment: null;
      reviewedAt: null;
    }
);

// ── Request / response shapes ───────────────────────────────────────

/**
 * Create-rule request — mirrors the `ApprovalRule` discriminated union so
 * a cost rule without a threshold is a compile-time error, not a 400 from
 * runtime validation alone.
 */
export type CreateApprovalRuleRequest =
  | { ruleType: "cost"; threshold: number; name: string; pattern?: ""; enabled?: boolean; surface?: ApprovalRuleSurface }
  | { ruleType: "table"; pattern: string; name: string; threshold?: null; enabled?: boolean; surface?: ApprovalRuleSurface }
  | { ruleType: "column"; pattern: string; name: string; threshold?: null; enabled?: boolean; surface?: ApprovalRuleSurface };

export interface UpdateApprovalRuleRequest {
  name?: string;
  pattern?: string;
  threshold?: number | null;
  enabled?: boolean;
  surface?: ApprovalRuleSurface;
}

export interface ReviewApprovalRequest {
  action: "approve" | "deny";
  comment?: string;
}
