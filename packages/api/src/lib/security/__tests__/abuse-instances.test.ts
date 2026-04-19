/**
 * Pure-function tests for `splitIntoInstances`. No DB, no mocks — the helper
 * lives in its own module specifically so the grouping logic can be verified
 * without the engine/state machine.
 */

import { describe, it, expect } from "bun:test";
import type { AbuseEvent } from "@useatlas/types";
import { splitIntoInstances } from "../abuse-instances";

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
