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
  pendingRefreshesRemaining,
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

  // #4325 — a post-publish async refresh is pending: the promoted definition is
  // live but its data hasn't refreshed, so the tile shows its retained data as
  // `stale` (never `fresh`) until the refresh lands.
  test("pending post-publish refresh with retained data → stale", () => {
    expect(resolveTileStatus({ hasData: true, everRun: true, pendingRefresh: true })).toBe("stale");
  });

  test("pending refresh on a card with no prior data → loading (being populated)", () => {
    expect(resolveTileStatus({ hasData: false, everRun: false, pendingRefresh: true })).toBe("loading");
  });

  test("an interactive render in flight beats a pending refresh", () => {
    expect(
      resolveTileStatus({ renderPhase: "loading", hasData: true, everRun: true, pendingRefresh: true }),
    ).toBe("loading");
  });

  test("a failed interactive render beats a pending refresh (stays stale/errored)", () => {
    expect(
      resolveTileStatus({ renderPhase: "error", hasData: true, everRun: true, pendingRefresh: true }),
    ).toBe("stale");
    expect(
      resolveTileStatus({ renderPhase: "error", hasData: false, everRun: true, pendingRefresh: true }),
    ).toBe("errored");
  });

  test("once the refresh settles (pendingRefresh cleared) the tile reads fresh", () => {
    expect(resolveTileStatus({ hasData: true, everRun: true, pendingRefresh: false })).toBe("fresh");
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

describe("pendingRefreshesRemaining", () => {
  test("a card whose cachedAt advanced past the baseline settles (drops out)", () => {
    const remaining = pendingRefreshesRemaining(
      new Set(["a", "b"]),
      [
        { id: "a", cachedAt: "2026-07-04T12:00:05.000Z" }, // advanced
        { id: "b", cachedAt: "2026-07-04T12:00:00.000Z" }, // unchanged
      ],
      { a: "2026-07-04T12:00:00.000Z", b: "2026-07-04T12:00:00.000Z" },
    );
    expect([...remaining]).toEqual(["b"]);
  });

  test("a newly-inserted card (baseline null) settles once cachedAt is populated", () => {
    const remaining = pendingRefreshesRemaining(
      new Set(["new"]),
      [{ id: "new", cachedAt: "2026-07-04T12:00:03.000Z" }],
      { new: null },
    );
    expect(remaining.size).toBe(0);
  });

  test("a still-empty inserted card stays pending (cachedAt still null)", () => {
    const remaining = pendingRefreshesRemaining(
      new Set(["new"]),
      [{ id: "new", cachedAt: null }],
      { new: null },
    );
    expect([...remaining]).toEqual(["new"]);
  });

  test("a card that disappeared from the board settles", () => {
    const remaining = pendingRefreshesRemaining(
      new Set(["gone"]),
      [{ id: "other", cachedAt: "2026-07-04T12:00:00.000Z" }],
      { gone: "2026-07-04T12:00:00.000Z" },
    );
    expect(remaining.size).toBe(0);
  });
});
