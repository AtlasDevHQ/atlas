/**
 * Unit tests for the unified workspace-entitlement resolver (WS1 of #3986).
 *
 * This module is the SSOT for "what plan tier is this workspace on, and is it an
 * operator?" — extracted from two byte-identical copies in the integration
 * route files. Every other test that touches the resolver mocks it out, so its
 * own branches (self-hosted short-circuit, row-not-found, tier narrowing,
 * operator coercion) are pinned here directly against a stubbed `internalQuery`.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// --- Mocks ---

let mockRows: unknown[] = [];
let mockInternalQueryShouldThrow = false;
let mockQueryCallCount = 0;
let lastSql: string | undefined;

const actualInternal = await import("@atlas/api/lib/db/internal");
mock.module("@atlas/api/lib/db/internal", () => ({
  ...actualInternal,
  internalQuery: async (sql: string) => {
    mockQueryCallCount++;
    lastSql = sql;
    if (mockInternalQueryShouldThrow) throw new Error("internal db error");
    return mockRows;
  },
}));

const { getWorkspaceEntitlement } = await import("../workspace-entitlement");

beforeEach(() => {
  mockRows = [];
  mockInternalQueryShouldThrow = false;
  mockQueryCallCount = 0;
  lastSql = undefined;
});

describe("getWorkspaceEntitlement", () => {
  it("short-circuits the `self-hosted` sentinel WITHOUT querying", async () => {
    const result = await getWorkspaceEntitlement("self-hosted");
    expect(result).toEqual({ planTier: null, isOperator: false });
    expect(mockQueryCallCount).toBe(0);
  });

  it("returns the safe default when no organization row is found", async () => {
    mockRows = [];
    const result = await getWorkspaceEntitlement("org_missing");
    expect(result).toEqual({ planTier: null, isOperator: false });
    expect(mockQueryCallCount).toBe(1);
  });

  it("narrows a known plan_tier and reads the operator flag", async () => {
    mockRows = [{ plan_tier: "business", is_operator_workspace: true }];
    const result = await getWorkspaceEntitlement("org_biz");
    expect(result).toEqual({ planTier: "business", isOperator: true });
  });

  it("narrows a legacy / unknown plan_tier string to null (fails closed)", async () => {
    mockRows = [{ plan_tier: "enterprise", is_operator_workspace: false }];
    const result = await getWorkspaceEntitlement("org_legacy");
    expect(result.planTier).toBeNull();
  });

  it("coerces a non-`true` is_operator_workspace (null) to false", async () => {
    // Defends the `=== true` strictness: a NULL column must NOT admit the
    // operator bypass. A truthy check would be a privilege-escalation bug.
    mockRows = [{ plan_tier: "pro", is_operator_workspace: null }];
    const result = await getWorkspaceEntitlement("org_null_op");
    expect(result).toEqual({ planTier: "pro", isOperator: false });
  });

  it("queries the organization table by id", async () => {
    mockRows = [{ plan_tier: "starter", is_operator_workspace: false }];
    await getWorkspaceEntitlement("org_x");
    expect(lastSql).toContain("FROM organization");
    expect(lastSql).toContain("plan_tier");
    expect(lastSql).toContain("is_operator_workspace");
  });

  it("propagates a lookup error (callers fail closed on the rejection)", async () => {
    mockInternalQueryShouldThrow = true;
    await expect(getWorkspaceEntitlement("org_err")).rejects.toThrow(
      "internal db error",
    );
  });
});
