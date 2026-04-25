import { describe, expect, test } from "bun:test";
import { selectMostRecentDashboardId } from "../select-recent";

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
