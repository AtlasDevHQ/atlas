/**
 * Per-tile status resolution (#4321 — the tile is the unit of trust).
 *
 * The render-helper is the single source of a tile's status, so the crux
 * behaviors are asserted here without mounting anything:
 *   - it returns the right status for each lifecycle input,
 *   - `errored` ≠ `empty` ≠ `never-run` (three distinct blank states),
 *   - a failed update resolves to `stale` (keep old data) — never a silent
 *     revert — while a failed FIRST render resolves to `errored`,
 *   - the age caption shifts muted → amber → red with the data's age.
 */
import { describe, expect, test } from "bun:test";
import {
  resolveTileStatus,
  statusShowsData,
  statusCanRetry,
  ageTone,
  tileCaptionTone,
  AGE_AMBER_MS,
  AGE_RED_MS,
} from "../tile-status";

describe("resolveTileStatus", () => {
  test("a render in flight → loading", () => {
    expect(resolveTileStatus({ renderPhase: "loading", hasData: true, everRun: true })).toBe("loading");
    // loading wins even before any data exists (a never-run card being rendered).
    expect(resolveTileStatus({ renderPhase: "loading", hasData: false, everRun: false })).toBe("loading");
  });

  test("a fresh render / snapshot with rows → fresh", () => {
    expect(resolveTileStatus({ renderPhase: "ok", hasData: true, everRun: true })).toBe("fresh");
    expect(resolveTileStatus({ renderPhase: undefined, hasData: true, everRun: true })).toBe("fresh");
  });

  test("a succeeded render with zero rows → empty (not never-run, not errored)", () => {
    expect(resolveTileStatus({ renderPhase: "ok", hasData: false, everRun: true })).toBe("empty");
    expect(resolveTileStatus({ renderPhase: undefined, hasData: false, everRun: true })).toBe("empty");
  });

  test("never rendered, no cache → never-run (distinct from empty)", () => {
    expect(resolveTileStatus({ renderPhase: undefined, hasData: false, everRun: false })).toBe("never-run");
  });

  test("a FAILED update that still has data → stale (never silently reverts)", () => {
    // The anti-silent-revert guarantee: an error phase over retained data keeps
    // the tile labeled-stale rather than passing the old number off as fresh.
    expect(resolveTileStatus({ renderPhase: "error", hasData: true, everRun: true })).toBe("stale");
  });

  test("a FAILED first render with no prior data → errored (distinct from stale/empty/never-run)", () => {
    expect(resolveTileStatus({ renderPhase: "error", hasData: false, everRun: false })).toBe("errored");
    expect(resolveTileStatus({ renderPhase: "error", hasData: false, everRun: true })).toBe("errored");
  });

  test("errored, empty, and never-run are three distinct statuses", () => {
    const errored = resolveTileStatus({ renderPhase: "error", hasData: false, everRun: true });
    const empty = resolveTileStatus({ renderPhase: "ok", hasData: false, everRun: true });
    const neverRun = resolveTileStatus({ renderPhase: undefined, hasData: false, everRun: false });
    expect(new Set([errored, empty, neverRun]).size).toBe(3);
    expect([errored, empty, neverRun]).toEqual(["errored", "empty", "never-run"]);
  });
});

describe("statusShowsData / statusCanRetry", () => {
  test("only fresh and stale keep rendering the data body", () => {
    expect(statusShowsData("fresh")).toBe(true);
    expect(statusShowsData("stale")).toBe(true);
    for (const s of ["loading", "empty", "errored", "never-run"] as const) {
      expect(statusShowsData(s)).toBe(false);
    }
  });

  test("only stale and errored offer a retry", () => {
    expect(statusCanRetry("stale")).toBe(true);
    expect(statusCanRetry("errored")).toBe(true);
    for (const s of ["loading", "fresh", "empty", "never-run"] as const) {
      expect(statusCanRetry(s)).toBe(false);
    }
  });
});

describe("ageTone — the color-shifting age caption", () => {
  const now = Date.UTC(2026, 6, 4, 12, 0, 0);
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  test("recent data is muted", () => {
    expect(ageTone(iso(0), now)).toBe("muted");
    expect(ageTone(iso(AGE_AMBER_MS - 1), now)).toBe("muted");
  });

  test("data past the amber threshold shifts to amber", () => {
    expect(ageTone(iso(AGE_AMBER_MS), now)).toBe("amber");
    expect(ageTone(iso(AGE_RED_MS - 1), now)).toBe("amber");
  });

  test("data past the red threshold shifts to red", () => {
    expect(ageTone(iso(AGE_RED_MS), now)).toBe("red");
    expect(ageTone(iso(AGE_RED_MS * 10), now)).toBe("red");
  });

  test("a null / unparseable timestamp is muted (nothing to age)", () => {
    expect(ageTone(null, now)).toBe("muted");
    expect(ageTone("not-a-date", now)).toBe("muted");
  });
});

describe("tileCaptionTone — status + age", () => {
  const now = Date.UTC(2026, 6, 4, 12, 0, 0);
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  test("errored is always red regardless of age", () => {
    expect(tileCaptionTone("errored", iso(0), now)).toBe("red");
    expect(tileCaptionTone("errored", null, now)).toBe("red");
  });

  test("stale is at least amber even when the retained data is recent", () => {
    expect(tileCaptionTone("stale", iso(0), now)).toBe("amber");
    // …and escalates to red as that data ages past the red threshold.
    expect(tileCaptionTone("stale", iso(AGE_RED_MS), now)).toBe("red");
  });

  test("fresh / empty follow the age tone", () => {
    expect(tileCaptionTone("fresh", iso(0), now)).toBe("muted");
    expect(tileCaptionTone("fresh", iso(AGE_AMBER_MS), now)).toBe("amber");
    expect(tileCaptionTone("empty", iso(AGE_RED_MS), now)).toBe("red");
  });
});
