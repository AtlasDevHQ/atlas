import { describe, expect, test } from "bun:test";
import { renderSurface, type ActionError } from "../action-error-state";

/**
 * `renderSurface` is the honesty guard for the cockpit (#4574): it decides where
 * a pinned mutation error renders from the action + which overlays are open.
 * The load-bearing cases are the *orphaned* ones — a sheet/delete error whose
 * target overlay was dismissed mid-flight, or replaced by a different item.
 * Those must fall back to the always-mounted page banner so a late failure is
 * never swallowed behind, or mis-rendered into, the wrong surface.
 */

const err = (action: ActionError["action"]): ActionError => ({
  error: { message: "boom" },
  action,
});

describe("renderSurface", () => {
  test("null error → null (nothing renders)", () => {
    expect(renderSurface(null, "lp-1", "lp-1")).toBeNull();
  });

  test("a row-menu status error always renders on the page", () => {
    expect(
      renderSurface(err({ kind: "status", id: "lp-1", status: "approved", surface: "page" }), null, null),
    ).toBe("page");
  });

  test("a sheet status error renders in the sheet only while that pattern's sheet is open", () => {
    const e = err({ kind: "status", id: "lp-1", status: "approved", surface: "sheet" });
    expect(renderSurface(e, "lp-1", null)).toBe("sheet");
  });

  test("a sheet error falls back to the page when the sheet was dismissed mid-flight", () => {
    const e = err({ kind: "status", id: "lp-1", status: "approved", surface: "sheet" });
    // openSheetId null → the sheet closed before the failure landed.
    expect(renderSurface(e, null, null)).toBe("page");
  });

  test("a sheet error falls back to the page when a DIFFERENT pattern's sheet is open", () => {
    const e = err({ kind: "status", id: "lp-1", status: "approved", surface: "sheet" });
    // Prevents pattern A's error rendering inside — and retrying from — B's sheet.
    expect(renderSurface(e, "lp-2", null)).toBe("page");
  });

  test("a delete error renders in the dialog only while that pattern's dialog is open", () => {
    const e = err({ kind: "delete", id: "lp-1" });
    expect(renderSurface(e, null, "lp-1")).toBe("delete");
  });

  test("a delete error falls back to the page when the dialog is closed or targets another item", () => {
    const e = err({ kind: "delete", id: "lp-1" });
    expect(renderSurface(e, null, null)).toBe("page");
    expect(renderSurface(e, null, "lp-2")).toBe("page");
  });

  test("a bulk error always renders on the page", () => {
    expect(renderSurface(err({ kind: "bulk", status: "rejected" }), "lp-1", "lp-1")).toBe("page");
  });
});
