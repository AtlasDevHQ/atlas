import { describe, expect, test } from "bun:test";
import {
  selectMostRecentDashboardId,
  selectNextAfterDelete,
  sortDashboardsByRecent,
} from "../select-recent";

describe("selectMostRecentDashboardId", () => {
  test("returns null on empty list", () => {
    expect(selectMostRecentDashboardId([])).toBeNull();
  });

  test("picks the dashboard with the latest updatedAt", () => {
    const id = selectMostRecentDashboardId([
      { id: "a", updatedAt: "2026-04-20T10:00:00Z" },
      { id: "b", updatedAt: "2026-04-25T10:00:00Z" },
      { id: "c", updatedAt: "2026-04-22T10:00:00Z" },
    ]);
    expect(id).toBe("b");
  });

  test("breaks ties on identical updatedAt by id ascending", () => {
    const id = selectMostRecentDashboardId([
      { id: "z", updatedAt: "2026-04-25T10:00:00Z" },
      { id: "a", updatedAt: "2026-04-25T10:00:00Z" },
      { id: "m", updatedAt: "2026-04-25T10:00:00Z" },
    ]);
    expect(id).toBe("a");
  });

  test("does not mutate the input", () => {
    const input = [
      { id: "a", updatedAt: "2026-04-20T10:00:00Z" },
      { id: "b", updatedAt: "2026-04-25T10:00:00Z" },
    ];
    const snapshot = JSON.stringify(input);
    selectMostRecentDashboardId(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("sortDashboardsByRecent", () => {
  test("returns a new array, not the original", () => {
    const input = [{ id: "a", updatedAt: "2026-04-20T10:00:00Z" }];
    const out = sortDashboardsByRecent(input);
    expect(out).not.toBe(input);
  });

  test("orders newest-first with id-asc tiebreak", () => {
    const out = sortDashboardsByRecent([
      { id: "z", updatedAt: "2026-04-20T10:00:00Z" },
      { id: "a", updatedAt: "2026-04-25T10:00:00Z" },
      { id: "m", updatedAt: "2026-04-25T10:00:00Z" },
    ]);
    expect(out.map((d) => d.id)).toEqual(["a", "m", "z"]);
  });
});

describe("selectNextAfterDelete", () => {
  test("returns null when only the deleted dashboard remains", () => {
    expect(
      selectNextAfterDelete(
        [{ id: "a", updatedAt: "2026-04-25T10:00:00Z" }],
        "a",
      ),
    ).toBeNull();
  });

  test("returns null on empty list", () => {
    expect(selectNextAfterDelete([], "a")).toBeNull();
  });

  test("picks the most-recent surviving dashboard after the delete", () => {
    const id = selectNextAfterDelete(
      [
        { id: "a", updatedAt: "2026-04-20T10:00:00Z" },
        { id: "b", updatedAt: "2026-04-25T10:00:00Z" },
        { id: "c", updatedAt: "2026-04-22T10:00:00Z" },
      ],
      "b",
    );
    expect(id).toBe("c");
  });

  test("filters by id even when the list still contains a stale row matching deletedId", () => {
    // Mirrors the real cache-races-the-fetch scenario the helper guards.
    const id = selectNextAfterDelete(
      [
        { id: "deleted", updatedAt: "2026-04-25T10:00:00Z" },
        { id: "next", updatedAt: "2026-04-24T10:00:00Z" },
      ],
      "deleted",
    );
    expect(id).toBe("next");
  });

  test("breaks ties on identical updatedAt by id ascending", () => {
    const id = selectNextAfterDelete(
      [
        { id: "z", updatedAt: "2026-04-25T10:00:00Z" },
        { id: "a", updatedAt: "2026-04-25T10:00:00Z" },
        { id: "deleted", updatedAt: "2026-04-25T10:00:00Z" },
      ],
      "deleted",
    );
    expect(id).toBe("a");
  });
});
