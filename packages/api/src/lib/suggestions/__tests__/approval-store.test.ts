/**
 * Unit tests for the admin approval-store mutations.
 *
 * Covers:
 *   - approveSuggestion: sets approval_status, approved_by, approved_at;
 *     3-way result (ok / not_found / forbidden) on cross-org access
 *   - hideSuggestion / unhideSuggestion: same 3-way result; unhide flips
 *     approved OR hidden back to pending without losing history
 *   - createApprovedSuggestion: trims text, rejects empty, duplicates
 *     surface as DuplicateSuggestionError (409 at route layer), new rows
 *     emit with approval_status='approved' + status='published' + approved_by
 *   - short-circuit when internal DB is unavailable
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

const mockInternalQuery = mock(
  async (_sql: string, _params?: unknown[]) => [] as unknown[],
);
let hasInternalDBFixture = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasInternalDBFixture,
  internalQuery: mockInternalQuery,
}));

const {
  approveSuggestion,
  hideSuggestion,
  unhideSuggestion,
  createApprovedSuggestion,
  DuplicateSuggestionError,
  InvalidSuggestionTextError,
  SUGGESTION_TEXT_MAX_LENGTH,
} = await import("../approval-store");

beforeEach(() => {
  hasInternalDBFixture = true;
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async () => [] as unknown[]);
});

// ── approveSuggestion ──────────────────────────────────────────────────

describe("approveSuggestion", () => {
  it("returns not_found when internal DB is unavailable", async () => {
    hasInternalDBFixture = false;

    const result = await approveSuggestion({
      id: "sug-1",
      orgId: "org-1",
      userId: "admin-1",
    });

    expect(result).toEqual({ status: "not_found" });
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns not_found when the row does not exist", async () => {
    mockInternalQuery.mockImplementation(async () => []);

    const result = await approveSuggestion({
      id: "missing",
      orgId: "org-1",
      userId: "admin-1",
    });

    expect(result).toEqual({ status: "not_found" });
  });

  it("returns forbidden when the row belongs to a different org", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-other" }];
      return [];
    });

    const result = await approveSuggestion({
      id: "sug-1",
      orgId: "org-1",
      userId: "admin-1",
    });

    expect(result).toEqual({ status: "forbidden" });
  });

  it("stamps approval_status, approved_by, approved_at and returns the row", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-1" }];
      if (sql.includes("UPDATE")) {
        return [
          {
            id: "sug-1",
            org_id: "org-1",
            description: "Pattern",
            pattern_sql: "SELECT 1",
            normalized_hash: "h",
            tables_involved: "[]",
            primary_table: null,
            frequency: 1,
            clicked_count: 1,
            distinct_user_clicks: 3,
            score: 1,
            approval_status: "approved",
            status: "draft",
            approved_by: "admin-1",
            approved_at: "2026-04-17T00:00:00.000Z",
            last_seen_at: "2026-04-15T00:00:00.000Z",
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-17T00:00:00.000Z",
          },
        ];
      }
      return [];
    });

    const result = await approveSuggestion({
      id: "sug-1",
      orgId: "org-1",
      userId: "admin-1",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.suggestion.approvalStatus).toBe("approved");
    expect(result.suggestion.approvedBy).toBe("admin-1");

    const updateCall = mockInternalQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE"),
    );
    expect(updateCall).toBeDefined();
    const [sql, params] = updateCall!;
    expect(sql).toContain("approval_status = 'approved'");
    expect(sql).toContain("approved_by = ");
    expect(sql).toContain("approved_at = NOW()");
    expect(sql).toContain("WHERE id = $1 AND org_id = ");
    expect(params).toEqual(["sug-1", "admin-1", "org-1"]);
  });
});

// ── hideSuggestion ─────────────────────────────────────────────────────

describe("hideSuggestion", () => {
  it("returns not_found when the row does not exist", async () => {
    mockInternalQuery.mockImplementation(async () => []);

    const result = await hideSuggestion({ id: "missing", orgId: "org-1" });

    expect(result).toEqual({ status: "not_found" });
  });

  it("returns forbidden when the row belongs to a different org", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-other" }];
      return [];
    });

    const result = await hideSuggestion({ id: "sug-1", orgId: "org-1" });

    expect(result).toEqual({ status: "forbidden" });
  });

  it("flips approval_status to hidden without touching approved_by", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-1" }];
      if (sql.includes("UPDATE")) {
        return [
          {
            id: "sug-1",
            org_id: "org-1",
            description: "Pattern",
            pattern_sql: "SELECT 1",
            normalized_hash: "h",
            tables_involved: "[]",
            primary_table: null,
            frequency: 1,
            clicked_count: 1,
            distinct_user_clicks: 3,
            score: 1,
            approval_status: "hidden",
            status: "published",
            approved_by: "admin-prior",
            approved_at: "2026-04-01T00:00:00.000Z",
            last_seen_at: "2026-04-15T00:00:00.000Z",
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-17T00:00:00.000Z",
          },
        ];
      }
      return [];
    });

    const result = await hideSuggestion({ id: "sug-1", orgId: "org-1" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.suggestion.approvalStatus).toBe("hidden");
    // History preservation: approved_by/approved_at are not reset by hide.
    expect(result.suggestion.approvedBy).toBe("admin-prior");

    const updateCall = mockInternalQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE"),
    );
    const [sql] = updateCall!;
    expect(sql).toContain("approval_status = 'hidden'");
    expect(sql).not.toContain("approved_by =");
    expect(sql).not.toContain("approved_at =");
  });
});

// ── unhideSuggestion ───────────────────────────────────────────────────

describe("unhideSuggestion", () => {
  it("returns not_found when the row does not exist", async () => {
    mockInternalQuery.mockImplementation(async () => []);

    const result = await unhideSuggestion({ id: "missing", orgId: "org-1" });

    expect(result).toEqual({ status: "not_found" });
  });

  it("returns forbidden when the row belongs to a different org", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-other" }];
      return [];
    });

    const result = await unhideSuggestion({ id: "sug-1", orgId: "org-1" });

    expect(result).toEqual({ status: "forbidden" });
  });

  it("flips approval_status back to pending so the row can re-enter review", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT org_id")) return [{ org_id: "org-1" }];
      if (sql.includes("UPDATE")) {
        return [
          {
            id: "sug-1",
            org_id: "org-1",
            description: "Pattern",
            pattern_sql: "SELECT 1",
            normalized_hash: "h",
            tables_involved: "[]",
            primary_table: null,
            frequency: 1,
            clicked_count: 1,
            distinct_user_clicks: 3,
            score: 1,
            approval_status: "pending",
            status: "draft",
            approved_by: null,
            approved_at: null,
            last_seen_at: "2026-04-15T00:00:00.000Z",
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-17T00:00:00.000Z",
          },
        ];
      }
      return [];
    });

    const result = await unhideSuggestion({ id: "sug-1", orgId: "org-1" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.suggestion.approvalStatus).toBe("pending");

    const updateCall = mockInternalQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE"),
    );
    const [sql] = updateCall!;
    expect(sql).toContain("approval_status = 'pending'");
  });
});

// ── createApprovedSuggestion ───────────────────────────────────────────

describe("createApprovedSuggestion", () => {
  it("rejects empty / whitespace-only text with InvalidSuggestionTextError", async () => {
    await expect(
      createApprovedSuggestion({
        orgId: "org-1",
        userId: "admin-1",
        text: "   ",
      }),
    ).rejects.toBeInstanceOf(InvalidSuggestionTextError);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects text longer than SUGGESTION_TEXT_MAX_LENGTH", async () => {
    const tooLong = "a".repeat(SUGGESTION_TEXT_MAX_LENGTH + 1);

    await expect(
      createApprovedSuggestion({
        orgId: "org-1",
        userId: "admin-1",
        text: tooLong,
      }),
    ).rejects.toBeInstanceOf(InvalidSuggestionTextError);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("creates a row with approval_status=approved, status=published, approved_by set", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO query_suggestions")) {
        return [
          {
            id: "new-sug",
            org_id: "org-1",
            description: "Admin-authored question",
            pattern_sql: "",
            normalized_hash: "hash123",
            tables_involved: "[]",
            primary_table: null,
            frequency: 0,
            clicked_count: 0,
            distinct_user_clicks: 0,
            score: 0,
            approval_status: "approved",
            status: "published",
            approved_by: "admin-1",
            approved_at: "2026-04-17T00:00:00.000Z",
            last_seen_at: "2026-04-17T00:00:00.000Z",
            created_at: "2026-04-17T00:00:00.000Z",
            updated_at: "2026-04-17T00:00:00.000Z",
          },
        ];
      }
      return [];
    });

    const suggestion = await createApprovedSuggestion({
      orgId: "org-1",
      userId: "admin-1",
      text: "Admin-authored question",
    });

    expect(suggestion.approvalStatus).toBe("approved");
    expect(suggestion.status).toBe("published");
    expect(suggestion.approvedBy).toBe("admin-1");
    expect(suggestion.description).toBe("Admin-authored question");

    const insertCall = mockInternalQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT"),
    );
    expect(insertCall).toBeDefined();
    const [sql] = insertCall!;
    expect(sql).toContain("'approved'");
    expect(sql).toContain("'published'");
  });

  it("trims whitespace before insertion and uses the trimmed text", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO query_suggestions")) {
        return [
          {
            id: "new-sug",
            org_id: "org-1",
            description: "trimmed question",
            pattern_sql: "",
            normalized_hash: "hash123",
            tables_involved: "[]",
            primary_table: null,
            frequency: 0,
            clicked_count: 0,
            distinct_user_clicks: 0,
            score: 0,
            approval_status: "approved",
            status: "published",
            approved_by: "admin-1",
            approved_at: "2026-04-17T00:00:00.000Z",
            last_seen_at: "2026-04-17T00:00:00.000Z",
            created_at: "2026-04-17T00:00:00.000Z",
            updated_at: "2026-04-17T00:00:00.000Z",
          },
        ];
      }
      return [];
    });

    await createApprovedSuggestion({
      orgId: "org-1",
      userId: "admin-1",
      text: "   trimmed question   ",
    });

    const insertCall = mockInternalQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT"),
    );
    const [, params] = insertCall!;
    const paramList = params as unknown[];
    // description param must be the trimmed text, not the whitespace-padded original.
    expect(paramList).toContain("trimmed question");
    expect(paramList).not.toContain("   trimmed question   ");
  });

  it("surfaces PG unique-violation as DuplicateSuggestionError", async () => {
    mockInternalQuery.mockImplementation(async () => {
      const err = new Error("duplicate key value violates unique constraint") as Error & {
        code?: string;
      };
      err.code = "23505";
      throw err;
    });

    await expect(
      createApprovedSuggestion({
        orgId: "org-1",
        userId: "admin-1",
        text: "clashing text",
      }),
    ).rejects.toBeInstanceOf(DuplicateSuggestionError);
  });
});
