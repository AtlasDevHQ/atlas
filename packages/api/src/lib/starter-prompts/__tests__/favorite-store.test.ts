/**
 * Unit tests for `FavoritePromptStore` (#1475, PRD #1473).
 *
 * Covers:
 *   - listFavorites: ordering (position DESC, created_at DESC), scoping by user + org
 *   - createFavorite: cap enforcement, duplicate rejection, text trimming + length cap
 *   - deleteFavorite: 3-way result (ok / not_found / forbidden) on cross-user access
 *   - updateFavoritePosition: same 3-way result, position-only update
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
  listFavorites,
  createFavorite,
  deleteFavorite,
  updateFavoritePosition,
  FavoriteCapError,
  DuplicateFavoriteError,
  FAVORITE_TEXT_MAX_LENGTH,
} = await import("../favorite-store");

beforeEach(() => {
  hasInternalDBFixture = true;
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async () => [] as unknown[]);
});

// ── listFavorites ──────────────────────────────────────────────────────

describe("listFavorites", () => {
  it("returns empty array when internal DB is unavailable", async () => {
    hasInternalDBFixture = false;

    const result = await listFavorites("user-1", "org-1");

    expect(result).toEqual([]);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("scopes the query to (user_id, org_id) with position-then-creation ordering", async () => {
    mockInternalQuery.mockImplementation(async () => [
      { id: "f-1", user_id: "user-1", org_id: "org-1", text: "newest", position: 3, created_at: new Date("2026-04-17T00:00:00Z") },
      { id: "f-2", user_id: "user-1", org_id: "org-1", text: "older", position: 1, created_at: new Date("2026-04-10T00:00:00Z") },
    ]);

    const result = await listFavorites("user-1", "org-1");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "f-1", text: "newest", position: 3 });
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(params).toEqual(["user-1", "org-1"]);
    expect(sql).toContain("ORDER BY position DESC");
    expect(sql).toContain("user_id = $1");
    expect(sql).toContain("org_id = $2");
  });

  it("returns empty array when the user has no pins", async () => {
    mockInternalQuery.mockImplementation(async () => []);

    const result = await listFavorites("user-ghost", "org-1");

    expect(result).toEqual([]);
  });
});

// ── createFavorite ─────────────────────────────────────────────────────

describe("createFavorite", () => {
  it("rejects empty or whitespace-only text", async () => {
    await expect(
      createFavorite({ userId: "user-1", orgId: "org-1", text: "  " }, 10),
    ).rejects.toThrow(/text must not be empty/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("trims whitespace before the uniqueness check", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT")) return [{ count: "0" }];
      return [{
        id: "f-new",
        user_id: "user-1",
        org_id: "org-1",
        text: "pinned",
        position: 1,
        created_at: new Date(),
      }];
    });

    await createFavorite({ userId: "user-1", orgId: "org-1", text: "  pinned  " }, 10);

    const insertCall = mockInternalQuery.mock.calls.find(([sql]) => sql.includes("INSERT"));
    expect(insertCall).toBeDefined();
    const [, params] = insertCall!;
    expect(params?.[2]).toBe("pinned");
  });

  it("throws FavoriteCapError when at or above the cap", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT")) return [{ count: "10" }];
      throw new Error("should not reach INSERT");
    });

    await expect(
      createFavorite({ userId: "user-1", orgId: "org-1", text: "any" }, 10),
    ).rejects.toBeInstanceOf(FavoriteCapError);
  });

  it("throws DuplicateFavoriteError when the unique index rejects the insert", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT")) return [{ count: "1" }];
      const err = new Error("duplicate key value violates unique constraint \"uq_user_favorite_prompts\"") as Error & { code?: string };
      err.code = "23505";
      throw err;
    });

    await expect(
      createFavorite({ userId: "user-1", orgId: "org-1", text: "dup" }, 10),
    ).rejects.toBeInstanceOf(DuplicateFavoriteError);
  });

  it("rejects text longer than FAVORITE_TEXT_MAX_LENGTH", async () => {
    const tooLong = "x".repeat(FAVORITE_TEXT_MAX_LENGTH + 1);

    await expect(
      createFavorite({ userId: "user-1", orgId: "org-1", text: tooLong }, 10),
    ).rejects.toThrow(/too long/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("sets position to MAX(position)+1 in the INSERT so new pins sort first", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT")) return [{ count: "2" }];
      return [{
        id: "f-3",
        user_id: "user-1",
        org_id: "org-1",
        text: "fresh",
        position: 3,
        created_at: new Date(),
      }];
    });

    await createFavorite({ userId: "user-1", orgId: "org-1", text: "fresh" }, 10);

    const insertCall = mockInternalQuery.mock.calls.find(([sql]) => sql.includes("INSERT"));
    expect(insertCall).toBeDefined();
    const [sql] = insertCall!;
    expect(sql).toContain("COALESCE(MAX(position), 0) + 1");
  });

  it("throws when internal DB is unavailable (cannot create pins without state)", async () => {
    hasInternalDBFixture = false;

    await expect(
      createFavorite({ userId: "user-1", orgId: "org-1", text: "anything" }, 10),
    ).rejects.toThrow(/internal database/i);
  });
});

// ── deleteFavorite ─────────────────────────────────────────────────────

describe("deleteFavorite", () => {
  it("returns { status: 'not_found' } when no row matches the id", async () => {
    mockInternalQuery.mockImplementation(async () => []);

    const result = await deleteFavorite({ id: "missing", userId: "user-1", orgId: "org-1" });

    expect(result).toEqual({ status: "not_found" });
  });

  it("returns { status: 'forbidden' } when the row belongs to another user", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) return [{ user_id: "user-other", org_id: "org-1" }];
      throw new Error("should not reach DELETE");
    });

    const result = await deleteFavorite({ id: "f-1", userId: "user-1", orgId: "org-1" });

    expect(result).toEqual({ status: "forbidden" });
  });

  it("returns { status: 'ok' } after deleting the row owned by the user", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) return [{ user_id: "user-1", org_id: "org-1" }];
      return [{ id: "f-1" }];
    });

    const result = await deleteFavorite({ id: "f-1", userId: "user-1", orgId: "org-1" });

    expect(result).toEqual({ status: "ok" });
    // Both SELECT (guard) and DELETE (effect) should run
    expect(mockInternalQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("returns { status: 'not_found' } when internal DB is unavailable", async () => {
    hasInternalDBFixture = false;

    const result = await deleteFavorite({ id: "f-1", userId: "user-1", orgId: "org-1" });

    expect(result).toEqual({ status: "not_found" });
  });
});

// ── updateFavoritePosition ─────────────────────────────────────────────

describe("updateFavoritePosition", () => {
  it("returns { status: 'not_found' } when the row does not exist", async () => {
    mockInternalQuery.mockImplementation(async () => []);

    const result = await updateFavoritePosition({
      id: "missing",
      userId: "user-1",
      orgId: "org-1",
      position: 5,
    });

    expect(result).toEqual({ status: "not_found" });
  });

  it("returns { status: 'forbidden' } when the row belongs to another user", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) return [{ user_id: "user-other", org_id: "org-1" }];
      throw new Error("should not reach UPDATE");
    });

    const result = await updateFavoritePosition({
      id: "f-1",
      userId: "user-1",
      orgId: "org-1",
      position: 5,
    });

    expect(result).toEqual({ status: "forbidden" });
  });

  it("updates position and returns the refreshed row", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id")) return [{ user_id: "user-1", org_id: "org-1" }];
      return [{
        id: "f-1",
        user_id: "user-1",
        org_id: "org-1",
        text: "pinned",
        position: 5,
        created_at: new Date(),
      }];
    });

    const result = await updateFavoritePosition({
      id: "f-1",
      userId: "user-1",
      orgId: "org-1",
      position: 5,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.favorite.position).toBe(5);
      expect(result.favorite.id).toBe("f-1");
    }
  });

  it("rejects non-finite position at the boundary", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(
        updateFavoritePosition({ id: "f-1", userId: "user-1", orgId: "org-1", position: bad }),
      ).rejects.toThrow(/position/);
    }
  });
});
