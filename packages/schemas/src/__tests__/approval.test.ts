import { describe, expect, test } from "bun:test";
import { ApprovalRuleSchema, ApprovalRequestSchema } from "../approval";

const validTableRule = {
  id: "rule_1",
  orgId: "org_1",
  name: "Require approval for PII tables",
  ruleType: "table" as const,
  pattern: "users",
  threshold: null,
  enabled: true,
  // #2072 — 'any' is the migration default and preserves pre-2072
  // fires-everywhere semantics. Surface-scoped variants are exercised
  // in the dedicated describe block below.
  surface: "any" as const,
  createdAt: "2026-04-19T12:00:00.000Z",
  updatedAt: "2026-04-19T12:00:00.000Z",
};

const validColumnRule = {
  ...validTableRule,
  id: "rule_col",
  ruleType: "column" as const,
  pattern: "ssn",
  threshold: null,
};

const validCostRule = {
  ...validTableRule,
  id: "rule_2",
  name: "Flag expensive queries",
  ruleType: "cost" as const,
  pattern: "" as const,
  threshold: 1000,
};

const pendingRequest = {
  id: "req_1",
  orgId: "org_1",
  ruleId: "rule_1",
  ruleName: "Require approval for PII tables",
  requesterId: "user_1",
  requesterEmail: "alice@example.com",
  querySql: "SELECT * FROM users",
  explanation: "Quarterly audit",
  connectionGroupId: "g_prod",
  tablesAccessed: ["users"],
  columnsAccessed: ["users.email"],
  // #2072 — null is the legacy / unstamped default. A specific surface
  // ("chat" / "mcp" / etc.) is asserted in the new surface block below.
  surface: null,
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
    expect(ApprovalRuleSchema.parse(validTableRule)).toEqual(validTableRule);
  });

  test("ApprovalRuleSchema parses a column rule", () => {
    expect(ApprovalRuleSchema.parse(validColumnRule)).toEqual(validColumnRule);
  });

  test("ApprovalRuleSchema parses a cost rule with numeric threshold", () => {
    expect(ApprovalRuleSchema.parse(validCostRule)).toEqual(validCostRule);
  });

  test("ApprovalRequestSchema parses a pending request with null reviewer fields", () => {
    expect(ApprovalRequestSchema.parse(pendingRequest)).toEqual(pendingRequest);
  });

  test("ApprovalRequestSchema parses an anonymous pending request", () => {
    const anon = { ...pendingRequest, requesterEmail: null, explanation: null };
    const parsed = ApprovalRequestSchema.parse(anon);
    expect(parsed.requesterEmail).toBeNull();
    expect(parsed.explanation).toBeNull();
  });

  test("ApprovalRequestSchema parses approved/denied with reviewer stamped", () => {
    for (const status of ["approved", "denied"] as const) {
      const reviewed = {
        ...pendingRequest,
        status,
        reviewerId: "user_admin",
        reviewerEmail: "admin@example.com",
        reviewComment: "seen",
        reviewedAt: "2026-04-19T13:00:00.000Z",
      };
      expect(ApprovalRequestSchema.parse(reviewed).status).toBe(status);
    }
  });

  test("ApprovalRequestSchema parses expired with null reviewer fields", () => {
    const expired = { ...pendingRequest, status: "expired" as const };
    expect(ApprovalRequestSchema.parse(expired).status).toBe("expired");
  });

  test("ApprovalRequestSchema parses denied with null reviewComment", () => {
    const denied = {
      ...pendingRequest,
      status: "denied" as const,
      reviewerId: "user_admin",
      reviewerEmail: "admin@example.com",
      reviewComment: null,
      reviewedAt: "2026-04-19T13:00:00.000Z",
    };
    expect(ApprovalRequestSchema.parse(denied).reviewComment).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-field invariants — the point of the discriminated union.
// Before #1660 these were documented but not enforced: a cost rule
// missing its threshold, or a pending request carrying a reviewer ID,
// would parse cleanly. The discriminated union turns those drift
// combinations into parse failures.
// ---------------------------------------------------------------------------

describe("cross-field invariants", () => {
  test("cost rule with null threshold fails parse", () => {
    const drifted = { ...validCostRule, threshold: null };
    expect(ApprovalRuleSchema.safeParse(drifted).success).toBe(false);
  });

  test("cost rule with non-empty pattern fails parse", () => {
    const drifted = { ...validCostRule, pattern: "users" };
    expect(ApprovalRuleSchema.safeParse(drifted).success).toBe(false);
  });

  test("table rule with non-null threshold fails parse", () => {
    const drifted = { ...validTableRule, threshold: 42 };
    expect(ApprovalRuleSchema.safeParse(drifted).success).toBe(false);
  });

  test("pending request with populated reviewerId fails parse", () => {
    const drifted = { ...pendingRequest, reviewerId: "user_admin" };
    expect(ApprovalRequestSchema.safeParse(drifted).success).toBe(false);
  });

  test("pending request with populated reviewedAt fails parse", () => {
    const drifted = { ...pendingRequest, reviewedAt: "2026-04-19T13:00:00.000Z" };
    expect(ApprovalRequestSchema.safeParse(drifted).success).toBe(false);
  });

  test("approved request without reviewerId fails parse", () => {
    const drifted = {
      ...pendingRequest,
      status: "approved" as const,
      reviewerId: null,
      reviewedAt: "2026-04-19T13:00:00.000Z",
    };
    expect(ApprovalRequestSchema.safeParse(drifted).success).toBe(false);
  });

  test("approved request without reviewedAt fails parse", () => {
    const drifted = {
      ...pendingRequest,
      status: "approved" as const,
      reviewerId: "user_admin",
      reviewedAt: null,
    };
    expect(ApprovalRequestSchema.safeParse(drifted).success).toBe(false);
  });

  test("expired request with populated reviewerId fails parse", () => {
    const drifted = {
      ...pendingRequest,
      status: "expired" as const,
      reviewerId: "user_admin",
    };
    expect(ApprovalRequestSchema.safeParse(drifted).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enum strict rejection — the drift surface the shared schema closes
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
    const drifted = { ...validTableRule, ruleType: "region" };
    expect(ApprovalRuleSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown status on ApprovalRequest fails parse", () => {
    const drifted = { ...pendingRequest, status: "pending_review" };
    expect(ApprovalRequestSchema.safeParse(drifted).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Surface enum (#2072) — admin can pin a rule to a single transport, and
// the request row records its origin. The schemas reject typos before
// they reach the rule evaluator (which would silently mismatch every
// request and leave the operator wondering why the rule didn't fire).
// ---------------------------------------------------------------------------

describe("surface enum (#2072)", () => {
  test("ApprovalRuleSchema parses every documented rule surface", () => {
    for (const surface of ["any", "chat", "mcp", "scheduler", "slack", "teams", "webhook"] as const) {
      const rule = { ...validTableRule, surface };
      expect(ApprovalRuleSchema.parse(rule).surface).toBe(surface);
    }
  });

  test("ApprovalRuleSchema rejects unknown rule surface", () => {
    const drifted = { ...validTableRule, surface: "msc" };
    expect(ApprovalRuleSchema.safeParse(drifted).success).toBe(false);
  });

  test("ApprovalRuleSchema rejects null rule surface (rules must always pin a value)", () => {
    const drifted = { ...validTableRule, surface: null };
    expect(ApprovalRuleSchema.safeParse(drifted).success).toBe(false);
  });

  test("ApprovalRequestSchema parses every documented request surface plus null", () => {
    for (const surface of ["chat", "mcp", "scheduler", "slack", "teams", "webhook", null] as const) {
      const req = { ...pendingRequest, surface };
      expect(ApprovalRequestSchema.parse(req).surface).toBe(surface);
    }
  });

  test("ApprovalRequestSchema rejects 'any' on a request row (rule-only value)", () => {
    // 'any' is the rule-side wildcard. A REQUEST always originated from
    // a single surface — emitting 'any' here would be a writer bug.
    const drifted = { ...pendingRequest, surface: "any" };
    expect(ApprovalRequestSchema.safeParse(drifted).success).toBe(false);
  });
});

describe("structural rejection", () => {
  test("ApprovalRuleSchema rejects missing id", () => {
    const { id: _id, ...missing } = validTableRule;
    expect(ApprovalRuleSchema.safeParse(missing).success).toBe(false);
  });

  test("ApprovalRuleSchema (cost) rejects string threshold", () => {
    const drifted = { ...validCostRule, threshold: "1000" };
    expect(ApprovalRuleSchema.safeParse(drifted).success).toBe(false);
  });

  test("ApprovalRequestSchema rejects missing querySql", () => {
    const { querySql: _querySql, ...missing } = pendingRequest;
    expect(ApprovalRequestSchema.safeParse(missing).success).toBe(false);
  });

  test("ApprovalRequestSchema rejects non-array tablesAccessed", () => {
    const drifted = { ...pendingRequest, tablesAccessed: "users,orders" };
    expect(ApprovalRequestSchema.safeParse(drifted).success).toBe(false);
  });
});
