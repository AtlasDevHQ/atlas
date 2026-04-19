import { describe, expect, test } from "bun:test";
import { ApprovalRuleSchema, ApprovalRequestSchema } from "../approval";

const validRule = {
  id: "rule_1",
  orgId: "org_1",
  name: "Require approval for PII tables",
  ruleType: "table" as const,
  pattern: "users",
  threshold: null,
  enabled: true,
  createdAt: "2026-04-19T12:00:00.000Z",
  updatedAt: "2026-04-19T12:00:00.000Z",
};

const validCostRule = {
  ...validRule,
  id: "rule_2",
  name: "Flag expensive queries",
  ruleType: "cost" as const,
  pattern: "",
  threshold: 1000,
};

const validRequest = {
  id: "req_1",
  orgId: "org_1",
  ruleId: "rule_1",
  ruleName: "Require approval for PII tables",
  requesterId: "user_1",
  requesterEmail: "alice@example.com",
  querySql: "SELECT * FROM users",
  explanation: "Quarterly audit",
  connectionId: "conn_1",
  tablesAccessed: ["users"],
  columnsAccessed: ["users.email"],
  status: "pending" as const,
  reviewerId: null,
  reviewerEmail: null,
  reviewComment: null,
  reviewedAt: null,
  createdAt: "2026-04-19T12:00:00.000Z",
  expiresAt: "2026-04-20T12:00:00.000Z",
};

describe("happy-path parses", () => {
  test("ApprovalRuleSchema parses a table rule", () => {
    expect(ApprovalRuleSchema.parse(validRule)).toEqual(validRule);
  });

  test("ApprovalRuleSchema parses a cost rule with numeric threshold", () => {
    expect(ApprovalRuleSchema.parse(validCostRule)).toEqual(validCostRule);
  });

  test("ApprovalRequestSchema parses a pending request with null reviewer fields", () => {
    expect(ApprovalRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  test("ApprovalRequestSchema parses an anonymous request (null requesterEmail + explanation)", () => {
    const anon = { ...validRequest, requesterEmail: null, explanation: null };
    const parsed = ApprovalRequestSchema.parse(anon);
    expect(parsed.requesterEmail).toBeNull();
    expect(parsed.explanation).toBeNull();
  });

  test("ApprovalRequestSchema parses each non-pending status", () => {
    for (const status of ["approved", "denied", "expired"] as const) {
      const reviewed = {
        ...validRequest,
        status,
        reviewerId: "user_admin",
        reviewerEmail: "admin@example.com",
        reviewComment: "seen",
        reviewedAt: "2026-04-19T13:00:00.000Z",
      };
      expect(ApprovalRequestSchema.parse(reviewed).status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// Enum strict rejection — proves the drift risk the shared schema closes
//
// Web previously relaxed these to `z.string()`, so a backend that started
// emitting a new rule type or status would sail past parse at the admin
// page boundary and surface as undefined UI behavior downstream. The
// strict enum now matches the route layer and fails loudly at
// `useAdminFetch` time, surfacing a `schema_mismatch` banner with a
// request ID operators can correlate to logs.
// ---------------------------------------------------------------------------

describe("enum strict rejection", () => {
  test("unknown ruleType fails parse", () => {
    const drifted = { ...validRule, ruleType: "region" };
    expect(ApprovalRuleSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown status on ApprovalRequest fails parse", () => {
    const drifted = { ...validRequest, status: "pending_review" };
    expect(ApprovalRequestSchema.safeParse(drifted).success).toBe(false);
  });

  test("all APPROVAL_RULE_TYPES values parse", () => {
    for (const ruleType of ["table", "column", "cost"] as const) {
      expect(
        ApprovalRuleSchema.parse({ ...validRule, ruleType }).ruleType,
      ).toBe(ruleType);
    }
  });
});

describe("structural rejection", () => {
  test("ApprovalRuleSchema rejects missing id", () => {
    const { id: _id, ...missing } = validRule;
    expect(ApprovalRuleSchema.safeParse(missing).success).toBe(false);
  });

  test("ApprovalRuleSchema rejects string threshold", () => {
    const drifted = { ...validRule, threshold: "1000" };
    expect(ApprovalRuleSchema.safeParse(drifted).success).toBe(false);
  });

  test("ApprovalRequestSchema rejects missing querySql", () => {
    const { querySql: _querySql, ...missing } = validRequest;
    expect(ApprovalRequestSchema.safeParse(missing).success).toBe(false);
  });

  test("ApprovalRequestSchema rejects non-array tablesAccessed", () => {
    const drifted = { ...validRequest, tablesAccessed: "users,orders" };
    expect(ApprovalRequestSchema.safeParse(drifted).success).toBe(false);
  });
});
