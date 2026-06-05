import { describe, expect, it } from "bun:test";

import { categoryMatchesSelection } from "@/ui/lib/helpers";

// #3219 (Codex review) — the cross-filter selection value is stored normalized
// (a `date` drilldown keeps only `YYYY-MM-DD`), but chart/table cells can be raw
// timestamps. `categoryMatchesSelection` bridges that so the selected row / bar
// still highlights, while never producing a false positive for text/number cats.
describe("categoryMatchesSelection", () => {
  it("matches an exact string", () => {
    expect(categoryMatchesSelection("us", "us")).toBe(true);
  });

  it("matches a number cell against its string selection", () => {
    expect(categoryMatchesSelection(5, "5")).toBe(true);
  });

  it("matches an ISO timestamp cell against a normalized YYYY-MM-DD date filter", () => {
    expect(categoryMatchesSelection("2026-06-04T12:00:00Z", "2026-06-04")).toBe(true);
  });

  it("matches a space-separated timestamp against a normalized date filter", () => {
    expect(categoryMatchesSelection("2026-06-04 12:00:00", "2026-06-04")).toBe(true);
  });

  it("does not match a different day", () => {
    expect(categoryMatchesSelection("2026-06-04T12:00:00Z", "2026-06-05")).toBe(false);
  });

  it("does not match a non-selected text value", () => {
    expect(categoryMatchesSelection("emea", "us")).toBe(false);
  });

  it("does not treat a plain date prefix without a time component as a timestamp", () => {
    // A bare `YYYY-MM-DD` cell only matches its exact selection — the prefix
    // fallback requires a `T`/space separator, so this never over-matches.
    expect(categoryMatchesSelection("2026-06-04", "2026-06")).toBe(false);
  });

  it("treats null / undefined cells as the empty string", () => {
    expect(categoryMatchesSelection(null, "")).toBe(true);
    expect(categoryMatchesSelection(undefined, "us")).toBe(false);
  });
});
