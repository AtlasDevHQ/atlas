/**
 * Pure-helper coverage for the canvas-mount draft render (#4557) — the run/skip
 * policy gate, the never-run selection, the ok/err phase mapping, and the
 * bounded fan-out that keeps a wide board from stampeding the datasource.
 */
import { describe, expect, test } from "bun:test";
import {
  MOUNT_RENDER_CONCURRENCY,
  flipLoadingToError,
  mountRenderPhaseFor,
  runBounded,
  selectMountRenderCards,
  shouldRunMountRender,
} from "../mount-render";
import type { CardRenderEntry } from "../dashboard-card-render";
import type { DashboardCard } from "@/ui/lib/types";

function card(overrides: Partial<DashboardCard> & { id: string }): DashboardCard {
  return {
    dashboardId: "dash-1",
    position: 0,
    title: overrides.id,
    kind: "chart",
    sql: "SELECT 1",
    chartConfig: null,
    content: null,
    annotations: [],
    cachedColumns: null,
    cachedRows: null,
    cachedAt: null,
    connectionGroupId: null,
    layout: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("shouldRunMountRender (#4557)", () => {
  const base = { showDraftView: true, hasDashboard: true, overridesActive: false };

  test("runs when the draft view is shown, the board is loaded, and no overrides are active", () => {
    expect(shouldRunMountRender(base)).toBe(true);
  });

  test("does NOT run on a published-only view (AC: published-only unaffected)", () => {
    expect(shouldRunMountRender({ ...base, showDraftView: false })).toBe(false);
  });

  test("does NOT run before the board has loaded", () => {
    expect(shouldRunMountRender({ ...base, hasDashboard: false })).toBe(false);
  });

  test("does NOT run when parameter overrides are active (the bar batch renders every card)", () => {
    expect(shouldRunMountRender({ ...base, overridesActive: true })).toBe(false);
  });
});

describe("mountRenderPhaseFor (#4557)", () => {
  test("a successful render maps to the `ok` phase", () => {
    const entry: CardRenderEntry = { cardId: "a", ok: true, columns: ["x"], rows: [{ x: 1 }] };
    expect(mountRenderPhaseFor(entry)).toBe("ok");
  });

  test("a failed render maps to the `error` phase (→ errored tile + retry, no silent blank)", () => {
    const entry: CardRenderEntry = { cardId: "a", ok: false, error: "boom" };
    expect(mountRenderPhaseFor(entry)).toBe("error");
  });
});

describe("flipLoadingToError (#4557)", () => {
  test("flips only the still-loading ids to error", () => {
    const phases = { a: "loading", b: "ok", c: "loading" } as const;
    expect(flipLoadingToError(phases, ["a", "b", "c"])).toEqual({ a: "error", b: "ok", c: "error" });
  });

  test("leaves already-settled ids untouched and returns a fresh object", () => {
    const phases = { a: "ok", b: "error" } as const;
    const out = flipLoadingToError(phases, ["a", "b"]);
    expect(out).toEqual({ a: "ok", b: "error" });
    expect(out).not.toBe(phases);
  });

  test("ignores ids absent from the phase map", () => {
    expect(flipLoadingToError({ a: "loading" }, ["missing"])).toEqual({ a: "loading" });
  });
});

describe("selectMountRenderCards (#4557)", () => {
  test("selects a never-run chart card (no cache, not yet attempted)", () => {
    const cards = [card({ id: "a", cachedAt: null })];
    expect(selectMountRenderCards(cards, new Set()).map((c) => c.id)).toEqual(["a"]);
  });

  test("selects a card with an undefined cachedAt (loose `== null` catches both null and undefined)", () => {
    // `cachedAt` is `string | null` on the wire, but the loose null-check is
    // deliberate — a future `=== null` "cleanup" would wrongly skip this card.
    const cards = [card({ id: "a", cachedAt: undefined as unknown as null })];
    expect(selectMountRenderCards(cards, new Set()).map((c) => c.id)).toEqual(["a"]);
  });

  test("excludes an already-seeded card (cachedAt set) — does not re-execute on mount", () => {
    const cards = [card({ id: "seeded", cachedAt: "2026-07-17T00:00:00.000Z" })];
    expect(selectMountRenderCards(cards, new Set())).toEqual([]);
  });

  test("excludes a text/section card — it has no SQL to render", () => {
    const cards = [card({ id: "note", kind: "text", sql: "", content: "# hi", cachedAt: null })];
    expect(selectMountRenderCards(cards, new Set())).toEqual([]);
  });

  test("excludes a card already attempted this session — no auto-retry loop", () => {
    const cards = [card({ id: "a", cachedAt: null })];
    expect(selectMountRenderCards(cards, new Set(["a"]))).toEqual([]);
  });

  test("selects only the never-run subset of a mixed board", () => {
    const cards = [
      card({ id: "seeded", cachedAt: "2026-07-17T00:00:00.000Z" }),
      card({ id: "never-run-1", cachedAt: null }),
      card({ id: "note", kind: "text", sql: "", content: "x", cachedAt: null }),
      card({ id: "never-run-2", cachedAt: null }),
      card({ id: "attempted", cachedAt: null }),
    ];
    expect(selectMountRenderCards(cards, new Set(["attempted"])).map((c) => c.id)).toEqual([
      "never-run-1",
      "never-run-2",
    ]);
  });
});

describe("runBounded (#4557)", () => {
  test("runs every item", async () => {
    const seen: number[] = [];
    await runBounded([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await runBounded(items, 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually overlapped, not serialized
  });

  test("clamps a limit below 1 to a single worker", async () => {
    let inFlight = 0;
    let peak = 0;
    await runBounded([1, 2, 3], 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  test("handles an empty list without spawning a worker", async () => {
    let calls = 0;
    await runBounded([], MOUNT_RENDER_CONCURRENCY, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("propagates a rejecting task rather than swallowing it", () => {
    return expect(
      runBounded([1], 1, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
