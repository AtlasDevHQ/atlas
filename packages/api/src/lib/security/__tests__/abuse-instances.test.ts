/**
 * Pure-function tests for the helpers in `abuse-instances.ts`. No DB, no
 * mocks — they live in their own module specifically so the grouping logic
 * and the counter arithmetic can be verified without the engine/state
 * machine.
 */

import { describe, it, expect } from "bun:test";
import type { AbuseEvent, AbuseInstance } from "@useatlas/types";
import {
  createAbuseInstance,
  errorRatePct,
  splitIntoInstances,
} from "../abuse-instances";

function ev(overrides: Partial<AbuseEvent> & { createdAt: string }): AbuseEvent {
  return {
    id: `e-${overrides.createdAt}`,
    workspaceId: "ws-1",
    level: "warning",
    trigger: "query_rate",
    message: "",
    metadata: {},
    actor: "system",
    ...overrides,
  };
}

describe("splitIntoInstances", () => {
  it("returns empty current + empty priors when there are no events", () => {
    const { currentInstance, priorInstances } = splitIntoInstances([], 5);
    expect(currentInstance.events).toEqual([]);
    expect(currentInstance.endedAt).toBeNull();
    expect(currentInstance.peakLevel).toBe("none");
    expect(priorInstances).toEqual([]);
  });

  it("treats all events as current when workspace has never been reinstated", () => {
    // DB order: DESC by createdAt → newest first.
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:10:00Z", level: "throttled" }),
      ev({ createdAt: "2026-04-19T10:05:00Z", level: "warning" }),
    ];
    const { currentInstance, priorInstances } = splitIntoInstances(events, 5);
    expect(priorInstances).toEqual([]);
    expect(currentInstance.endedAt).toBeNull();
    expect(currentInstance.peakLevel).toBe("throttled");
    // Events are flipped to chronological for rendering.
    expect(currentInstance.events.map((e) => e.createdAt)).toEqual([
      "2026-04-19T10:05:00Z",
      "2026-04-19T10:10:00Z",
    ]);
  });

  it("splits prior instance from current when a reinstatement separates them", () => {
    // Chronological: warn → throttle → suspend → reinstate → warn → throttle
    // DB order: DESC by createdAt.
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T11:10:00Z", level: "throttled" }),
      ev({ createdAt: "2026-04-19T11:05:00Z", level: "warning" }),
      ev({
        createdAt: "2026-04-19T11:00:00Z",
        level: "none",
        trigger: "manual",
        actor: "admin-1",
      }),
      ev({ createdAt: "2026-04-19T10:15:00Z", level: "suspended" }),
      ev({ createdAt: "2026-04-19T10:10:00Z", level: "throttled" }),
      ev({ createdAt: "2026-04-19T10:05:00Z", level: "warning" }),
    ];
    const { currentInstance, priorInstances } = splitIntoInstances(events, 5);

    // Current: everything after the reinstatement, chronological.
    expect(currentInstance.endedAt).toBeNull();
    expect(currentInstance.peakLevel).toBe("throttled");
    expect(currentInstance.startedAt).toBe("2026-04-19T11:05:00Z");
    expect(currentInstance.events.map((e) => e.level)).toEqual(["warning", "throttled"]);

    // Prior: the closed instance. peakLevel = suspended, endedAt = reinstatement timestamp.
    expect(priorInstances).toHaveLength(1);
    const prior = priorInstances[0]!;
    expect(prior.peakLevel).toBe("suspended");
    expect(prior.endedAt).toBe("2026-04-19T11:00:00Z");
    expect(prior.startedAt).toBe("2026-04-19T10:05:00Z");
    // The reinstatement event itself is included as the closing event.
    expect(prior.events.map((e) => e.level)).toEqual([
      "warning",
      "throttled",
      "suspended",
      "none",
    ]);
  });

  it("returns prior instances newest-first", () => {
    // Three closed instances, no current activity.
    const events: AbuseEvent[] = [
      // Instance 3 (newest, closed)
      ev({
        createdAt: "2026-04-19T12:00:00Z",
        level: "none",
        trigger: "manual",
        actor: "admin-3",
      }),
      ev({ createdAt: "2026-04-19T11:55:00Z", level: "warning" }),
      // Instance 2 (closed)
      ev({
        createdAt: "2026-04-19T11:00:00Z",
        level: "none",
        trigger: "manual",
        actor: "admin-2",
      }),
      ev({ createdAt: "2026-04-19T10:55:00Z", level: "warning" }),
      // Instance 1 (oldest, closed)
      ev({
        createdAt: "2026-04-19T10:00:00Z",
        level: "none",
        trigger: "manual",
        actor: "admin-1",
      }),
      ev({ createdAt: "2026-04-19T09:55:00Z", level: "warning" }),
    ];
    const { currentInstance, priorInstances } = splitIntoInstances(events, 5);

    expect(currentInstance.events).toEqual([]);
    expect(priorInstances.map((p) => p.endedAt)).toEqual([
      "2026-04-19T12:00:00Z", // newest reinstatement first
      "2026-04-19T11:00:00Z",
      "2026-04-19T10:00:00Z",
    ]);
  });

  it("caps prior instances at priorLimit", () => {
    // Four closed instances, limit 2.
    const events: AbuseEvent[] = [];
    for (let i = 4; i >= 1; i--) {
      events.push(
        ev({
          createdAt: `2026-04-19T${String(10 + i).padStart(2, "0")}:00:00Z`,
          level: "none",
          trigger: "manual",
          actor: `admin-${i}`,
        }),
        ev({
          createdAt: `2026-04-19T${String(10 + i).padStart(2, "0")}:00:00Z`,
          level: "warning",
        }),
      );
    }
    const { priorInstances } = splitIntoInstances(events, 2);
    expect(priorInstances).toHaveLength(2);
  });

  it("computes peakLevel by escalation rank, not order of appearance", () => {
    // Events arrive warning → suspended → throttled chronologically. Peak is
    // still "suspended" even though a lower level arrives after it.
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:20:00Z", level: "throttled" }),
      ev({ createdAt: "2026-04-19T10:15:00Z", level: "suspended" }),
      ev({ createdAt: "2026-04-19T10:10:00Z", level: "warning" }),
    ];
    const { currentInstance } = splitIntoInstances(events, 5);
    expect(currentInstance.peakLevel).toBe("suspended");
  });

  it("does NOT treat a system-generated 'none' event as a reinstatement", () => {
    // Hypothetical corrupt row: level=none with trigger=query_rate. Only
    // manual-triggered 'none' is treated as a reinstatement boundary.
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:10:00Z", level: "throttled" }),
      ev({
        createdAt: "2026-04-19T10:05:00Z",
        level: "none",
        trigger: "query_rate",
      }),
      ev({ createdAt: "2026-04-19T10:00:00Z", level: "warning" }),
    ];
    const { priorInstances, currentInstance } = splitIntoInstances(events, 5);
    expect(priorInstances).toEqual([]);
    expect(currentInstance.events).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// errorRatePct — pure counter helper (#1638)
//
// The admin detail panel shows the error-rate percentage for the current
// sliding window. The arithmetic was previously inlined in `getAbuseDetail`,
// which made the "zero denominator" branch invisible to the type system and
// untestable without the whole engine. Extracting it as a pure helper locks
// down the invariants in one place.
//
// Rounding is 2 decimals (not 1) because the detail panel also uses the
// returned value for an "over threshold" boolean. Rounding to 1 decimal
// would silently flip that flag within ±0.05% of the threshold while the
// engine's own check still escalated on the unrounded fraction.
// ---------------------------------------------------------------------------

// `errorRatePct` returns a branded `Percentage` (#1685). `.toBe` with a
// plain number literal fails typecheck because the brand is nominally
// distinct; the tests below use `toBe<number>(literal)` to assert runtime
// numeric equality while leaving the compile-time brand intact. The brand
// itself is pinned separately in `packages/types/src/__tests__/percentage.test.ts`.
describe("errorRatePct", () => {
  it("returns 0 when totalCount is 0 (no baseline, avoids NaN)", () => {
    expect(errorRatePct(0, 0)).toBe<number>(0);
  });

  it("returns 0 when errorCount is 0 with a real baseline", () => {
    expect(errorRatePct(0, 50)).toBe<number>(0);
  });

  it("rounds a normal case to 2 decimal places", () => {
    // 1/3 * 100 = 33.333… → 33.33
    expect(errorRatePct(1, 3)).toBe<number>(33.33);
    // 2/3 * 100 = 66.666… → 66.67
    expect(errorRatePct(2, 3)).toBe<number>(66.67);
  });

  it("preserves threshold-boundary precision at the 2nd decimal", () => {
    // Guards the detail-panel "over threshold" boundary: with default
    // errorRateThreshold=0.5 (50%), a real rate of 50.04% (5004 / 10000)
    // must serialize as > 50 so the comparison against 0.5 stays true.
    // 1-decimal rounding silently flipped this flag off.
    expect(errorRatePct(5004, 10000)).toBe<number>(50.04);
    expect(errorRatePct(5004, 10000) / 100 > 0.5).toBe(true);
  });

  it("returns 100 for a fully-errored baseline", () => {
    expect(errorRatePct(10, 10)).toBe<number>(100);
  });

  it("clamps to 100 when errorCount exceeds totalCount (caller bug guard)", () => {
    // errorCount > totalCount is a caller bug — surfacing 150% would mislead
    // the admin more than capping at 100%.
    expect(errorRatePct(15, 10)).toBe<number>(100);
  });

  it("preserves precision for large counts", () => {
    // 1234 / 98765 ≈ 1.24943% → 1.25 (2-decimal)
    expect(errorRatePct(1234, 98765)).toBe<number>(1.25);
    // 12345 / 98765 ≈ 12.4994% → 12.5 (trailing zero collapsed by JS)
    expect(errorRatePct(12345, 98765)).toBe<number>(12.5);
  });

  it("throws on non-finite inputs (NaN, Infinity) rather than propagating NaN", () => {
    expect(() => errorRatePct(NaN, 10)).toThrow(/non-finite input/);
    expect(() => errorRatePct(10, NaN)).toThrow(/non-finite input/);
    expect(() => errorRatePct(Infinity, 10)).toThrow(/non-finite input/);
    expect(() => errorRatePct(10, Infinity)).toThrow(/non-finite input/);
  });

  it("throws on negative inputs rather than returning a negative percentage", () => {
    expect(() => errorRatePct(-1, 10)).toThrow(/negative input/);
    expect(() => errorRatePct(5, -10)).toThrow(/negative input/);
  });

  it("returns a finite number for the documented (5, 0) zero-denominator case", () => {
    const rate = errorRatePct(5, 0);
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBe<number>(0);
  });
});

// ---------------------------------------------------------------------------
// createAbuseInstance — factory for AbuseInstance invariants (#1644)
//
// Before this refactor the factory lived as a private helper inside the
// module, so the invariants (peakLevel == max(levels), endedAt non-null iff
// last event is a reinstatement, startedAt == first event's createdAt) were
// not enforceable at any public boundary. A fresh caller could hand-roll an
// `AbuseInstance` with a mismatched peakLevel and nothing would catch it.
// Promoting the factory to an exported single-constructor narrows the
// construction surface and makes each invariant directly unit-testable.
// ---------------------------------------------------------------------------

describe("createAbuseInstance", () => {
  it("returns the empty-instance shape when events are empty", () => {
    const inst = createAbuseInstance([]);
    // `toMatchObject` — the branded AbuseInstance's phantom symbol key
    // prevents `toEqual` against a plain object literal from typechecking
    // (#1684). The fields we care about are pinned below; the brand is
    // itself a compile-time invariant, not a runtime assertion.
    expect(inst).toMatchObject({
      startedAt: "",
      endedAt: null,
      peakLevel: "none",
      events: [],
    });
  });

  it("uses the first event's createdAt as startedAt", () => {
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:00:00Z", level: "warning" }),
      ev({ createdAt: "2026-04-19T10:05:00Z", level: "throttled" }),
    ];
    expect(createAbuseInstance(events).startedAt).toBe("2026-04-19T10:00:00Z");
  });

  it("leaves endedAt null for an open instance (no reinstatement)", () => {
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:00:00Z", level: "warning" }),
      ev({ createdAt: "2026-04-19T10:05:00Z", level: "throttled" }),
    ];
    expect(createAbuseInstance(events).endedAt).toBeNull();
  });

  it("sets endedAt to the reinstatement createdAt when the last event is manual 'none'", () => {
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:00:00Z", level: "warning" }),
      ev({ createdAt: "2026-04-19T10:10:00Z", level: "throttled" }),
      ev({
        createdAt: "2026-04-19T10:15:00Z",
        level: "none",
        trigger: "manual",
        actor: "admin-1",
      }),
    ];
    expect(createAbuseInstance(events).endedAt).toBe("2026-04-19T10:15:00Z");
  });

  it("ignores system-generated 'none' as a close boundary", () => {
    // Corrupt row: level=none with a non-manual trigger. Not a reinstatement.
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:00:00Z", level: "warning" }),
      ev({
        createdAt: "2026-04-19T10:05:00Z",
        level: "none",
        trigger: "query_rate",
      }),
    ];
    expect(createAbuseInstance(events).endedAt).toBeNull();
  });

  it("computes peakLevel by escalation rank, not order of appearance", () => {
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:00:00Z", level: "warning" }),
      ev({ createdAt: "2026-04-19T10:05:00Z", level: "suspended" }),
      ev({ createdAt: "2026-04-19T10:10:00Z", level: "throttled" }),
    ];
    expect(createAbuseInstance(events).peakLevel).toBe("suspended");
  });

  it("computes peakLevel = 'none' when all events are reinstatement-shaped", () => {
    const events: AbuseEvent[] = [
      ev({
        createdAt: "2026-04-19T10:00:00Z",
        level: "none",
        trigger: "manual",
        actor: "admin-1",
      }),
    ];
    expect(createAbuseInstance(events).peakLevel).toBe("none");
  });

  it("aliases the caller's events array (no defensive copy, no reorder)", () => {
    // Documented contract: the factory stores the input array by reference.
    // Callers must not mutate the array post-construction — doing so would
    // invalidate `peakLevel` / `endedAt` silently. This test pins the
    // aliasing so a future refactor to a defensive copy is a deliberate
    // decision, not an accidental one.
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:00:00Z", level: "warning" }),
      ev({ createdAt: "2026-04-19T10:05:00Z", level: "throttled" }),
    ];
    const inst = createAbuseInstance(events);
    expect(inst.events).toBe(events);
  });

  it("preserves insertion order when input is not chronological", () => {
    // Documented precondition: the factory does NOT sort. Callers own the
    // order. This test proves that — if it starts failing because a future
    // author added a sort, `splitIntoInstances` (which relies on reverse-
    // then-forward walk) will silently reprocess the same events differently.
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:10:00Z", level: "throttled" }), // newest first
      ev({ createdAt: "2026-04-19T10:00:00Z", level: "warning" }),
    ];
    const inst = createAbuseInstance(events);
    expect(inst.events.map((e) => e.createdAt)).toEqual([
      "2026-04-19T10:10:00Z",
      "2026-04-19T10:00:00Z",
    ]);
    // And startedAt follows events[0] even when it's the newest — this is
    // the "garbage in, garbage out" contract the docstring flags.
    expect(inst.startedAt).toBe("2026-04-19T10:10:00Z");
  });

  // Nominal brand enforcement (#1684) — the phantom `unique symbol` in
  // `@useatlas/types/abuse.ts` makes hand-rolled object literals fail
  // typecheck. `@ts-expect-error` is the regression guard: if a future
  // refactor relaxes the brand back to a structural interface, the lines
  // below will type-check and the directives will fail the build, flagging
  // the regression. Runtime assertions are irrelevant — this is a purely
  // compile-time invariant — but the test harness still evaluates the
  // expressions so TS sees them.
  it("rejects hand-rolled AbuseInstance literals at the type layer", () => {
    // @ts-expect-error hand-rolled shape must not satisfy AbuseInstance — use createAbuseInstance
    const handRolled: AbuseInstance = {
      startedAt: "2026-04-19T10:00:00Z",
      endedAt: null,
      peakLevel: "warning",
      events: [],
    };
    expect(handRolled).toBeTruthy();
  });

  it("accepts AbuseInstance values minted via the factory", () => {
    // Positive control: the factory's localized `as AbuseInstance` cast is
    // what allows this assignment. If this starts failing while the
    // hand-rolled test above starts passing, the brand is broken.
    const fromFactory: AbuseInstance = createAbuseInstance([]);
    expect(fromFactory.peakLevel).toBe("none");
  });
});
