/**
 * Tests for migration write-lock check.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

let mockHasInternalDB = true;
let mockQueryResults: Record<string, unknown[]> = {};
let mockQueryError: Error | null = null;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: () => Promise.resolve({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: (sql: string, _params: unknown[]) => {
    if (mockQueryError) return Promise.reject(mockQueryError);
    for (const [key, value] of Object.entries(mockQueryResults)) {
      if (sql.includes(key)) return Promise.resolve(value);
    }
    return Promise.resolve([]);
  },
  internalExecute: () => {},
  getWorkspaceRegion: () => Promise.resolve(null),
  setWorkspaceRegion: () => Promise.resolve({ assigned: true }),
  insertSemanticAmendment: async () => "mock-amendment-id",
}));

// ── Import after mocks ──────────────────────────────────────────────

const { isWorkspaceMigrating } = await import("../readonly");

// ── Helpers ─────────────────────────────────────────────────────────

function resetMocks() {
  mockHasInternalDB = true;
  mockQueryResults = {};
  mockQueryError = null;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("isWorkspaceMigrating", () => {
  beforeEach(resetMocks);

  it("returns false when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await isWorkspaceMigrating("org-1");
    expect(result).toBe(false);
  });

  it("returns false when no active migration exists", async () => {
    const result = await isWorkspaceMigrating("org-1");
    expect(result).toBe(false);
  });

  it("returns true when workspace has an in_progress migration", async () => {
    mockQueryResults["status = 'in_progress'"] = [{ id: "mig-1" }];
    const result = await isWorkspaceMigrating("org-1");
    expect(result).toBe(true);
  });

  it("propagates database errors", async () => {
    mockQueryError = new Error("connection refused");
    await expect(isWorkspaceMigrating("org-1")).rejects.toThrow("connection refused");
  });
});
