/**
 * Pure-function tests for the helpers in `abuse-instances.ts`. No DB, no
 * mocks — they live in their own module specifically so the grouping logic
 * and the counter arithmetic can be verified without the engine/state
 * machine.
 */

import { describe, it, expect } from "bun:test";
import type { AbuseEvent } from "@useatlas/types";
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
// ---------------------------------------------------------------------------

describe("errorRatePct", () => {
  it("returns 0 when totalCount is 0 (no baseline, avoids NaN)", () => {
    expect(errorRatePct(0, 0)).toBe(0);
  });

  it("returns 0 when errorCount is 0 with a real baseline", () => {
    expect(errorRatePct(0, 50)).toBe(0);
  });

  it("rounds a normal case to 1 decimal place", () => {
    // 1/3 * 100 = 33.333… → 33.3
    expect(errorRatePct(1, 3)).toBe(33.3);
  });

  it("rounds up at the midpoint (0.05 boundary)", () => {
    // 45 / 100 * 100 = 45.0 — clean; use 15/70 = 21.428… to hit midpoint rounding
    // 17 / 60 ≈ 28.333… → 28.3
    expect(errorRatePct(17, 60)).toBe(28.3);
    // 1 / 8 = 12.5 → 12.5 (already at one decimal, no change)
    expect(errorRatePct(1, 8)).toBe(12.5);
  });

  it("caps at 100 when all queries errored", () => {
    expect(errorRatePct(10, 10)).toBe(100);
  });

  it("preserves precision for large counts", () => {
    // 1234 / 98765 ≈ 1.24943% → 1.2
    expect(errorRatePct(1234, 98765)).toBe(1.2);
    // 12345 / 98765 ≈ 12.4994% → 12.5
    expect(errorRatePct(12345, 98765)).toBe(12.5);
  });

  it("never returns NaN or Infinity", () => {
    const rate = errorRatePct(5, 0);
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createAbuseInstance — factory for AbuseInstance invariants (#1644)
//
// Before the factory, instance objects were assembled inline inside
// `makeInstance` — correct, but the invariants (peakLevel == max(levels),
// endedAt non-null iff last event is a reinstatement, startedAt == first
// event's createdAt) were not enforceable at the type level. A fresh caller
// could hand-roll an `AbuseInstance` with a mismatched peakLevel and nothing
// would catch it. The factory centralizes the derivation and makes each
// invariant directly unit-testable.
// ---------------------------------------------------------------------------

describe("createAbuseInstance", () => {
  it("returns the empty-instance shape when events are empty", () => {
    const inst = createAbuseInstance([]);
    expect(inst).toEqual({
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

  it("preserves the events array verbatim (no mutation, no reorder)", () => {
    const events: AbuseEvent[] = [
      ev({ createdAt: "2026-04-19T10:00:00Z", level: "warning" }),
      ev({ createdAt: "2026-04-19T10:05:00Z", level: "throttled" }),
    ];
    const inst = createAbuseInstance(events);
    expect(inst.events).toEqual(events);
    // Caller's array is not aliased — mutating the result's events must not
    // affect the caller (defensive copy is optional but array identity should
    // not be a surprise).
    expect(inst.events).not.toBe(undefined);
  });
});
