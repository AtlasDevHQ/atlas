/**
 * Unit tests for `upsertSuggestion` — asserts the SQL contract that
 * CLI-populated rows land explicitly as `approval_status = 'pending'`
 * and `status = 'draft'` by default, and transition to
 * `approval_status = 'approved'` / `status = 'published'` when the
 * caller opts in via `autoApprove`.
 *
 * Regression guard for #1482: the migration defaults to pending/draft,
 * but relying on the default silently couples CLI behavior to schema
 * defaults. Writing the columns explicitly means a future `ALTER TABLE`
 * that changes the default cannot silently flip CLI-populated rows into
 * user-facing visibility.
 *
 * ON CONFLICT preserves prior approval / status so a repeated
 * `atlas learn` run never overrides an admin's hide or approve decision
 * on an existing row — that would re-surface content the admin already
 * reviewed. The `--auto-approve` operator flag affects new rows only.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/atlas_test";

import {
  upsertSuggestion,
  _resetPool,
  _resetCircuitBreaker,
} from "../internal";

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[] = [];

function makeStubPool(returnRow: { id: string; created: boolean } = { id: "sug-1", created: true }) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: [returnRow] };
    },
    async end() {},
    async connect() {
      return { query: async () => ({ rows: [returnRow] }), release() {} };
    },
    on() {},
  };
}

beforeEach(() => {
  captured = [];
  _resetCircuitBreaker();
  _resetPool(makeStubPool() as unknown as Parameters<typeof _resetPool>[0], null);
});

afterAll(() => {
  _resetPool(null, null);
  _resetCircuitBreaker();
  mock.restore();
});

const baseInput = {
  orgId: "org-1",
  description: "Count orders by status",
  patternSql: "SELECT status, COUNT(*) FROM orders GROUP BY status",
  normalizedHash: "abc123",
  tablesInvolved: ["orders"],
  primaryTable: "orders",
  frequency: 4,
  score: 3.5,
  lastSeenAt: new Date("2026-04-10T00:00:00Z"),
};

describe("upsertSuggestion — approval defaults", () => {
  it("writes approval_status and status columns explicitly (pending/draft by default)", async () => {
    await upsertSuggestion(baseInput);

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    // Both columns must appear in the column list — not rely on DB defaults.
    expect(sql).toMatch(/INSERT INTO query_suggestions[\s\S]*approval_status[\s\S]*status/);
    // Default values for a CLI-populated row are pending + draft so the
    // admin moderation queue is authoritative over visibility.
    expect(params).toContain("pending");
    expect(params).toContain("draft");
    expect(params).not.toContain("approved");
    expect(params).not.toContain("published");
  });

  it("writes approved/published when autoApprove is true", async () => {
    await upsertSuggestion({ ...baseInput, autoApprove: true });

    expect(captured).toHaveLength(1);
    const { params } = captured[0]!;
    expect(params).toContain("approved");
    expect(params).toContain("published");
    expect(params).not.toContain("pending");
    expect(params).not.toContain("draft");
  });

  it("preserves existing approval/status on ON CONFLICT (no override of admin state)", async () => {
    await upsertSuggestion(baseInput);
    const { sql } = captured[0]!;
    // ON CONFLICT DO UPDATE must touch only the metrics columns —
    // overriding approval_status would re-surface rows an admin hid,
    // and overriding status would clobber the mode-system lifecycle.
    expect(sql).toMatch(/ON CONFLICT[\s\S]*DO UPDATE/);
    const updateClause = sql.split("DO UPDATE")[1] ?? "";
    expect(updateClause).not.toMatch(/approval_status\s*=/);
    expect(updateClause).not.toMatch(/\bstatus\s*=/);
  });
});
