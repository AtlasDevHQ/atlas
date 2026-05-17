/**
 * Pure unit tests for `aggregateRows` — the rollup math behind
 * `AnswerMeter.summary`. No DB, no Effect runtime — every assertion is
 * against an in-memory row array.
 *
 * These tests pin the contract every admin analytics surface depends
 * on (and the eventual billing aggregator): given a stream of meter
 * rows, the rollup is correct.
 */

import { describe, expect, it } from "bun:test";
import { aggregateRows, type ProactiveMeterRow } from "../answer-meter";

function row(overrides: Partial<ProactiveMeterRow> = {}): ProactiveMeterRow {
  return {
    channel_id: overrides.channel_id ?? "C-default",
    event_type: overrides.event_type ?? "classify",
    outcome: overrides.outcome ?? null,
    cost_micro_usd: overrides.cost_micro_usd ?? 0,
  };
}

describe("aggregateRows", () => {
  it("returns an empty summary for an empty input", () => {
    const summary = aggregateRows([]);
    expect(summary.classifyCount).toBe(0);
    expect(summary.reactCount).toBe(0);
    expect(summary.offerCount).toBe(0);
    expect(summary.acceptCount).toBe(0);
    expect(summary.totalCostMicroUsd).toBe(0);
    expect(summary.byChannel).toEqual([]);
    expect(summary.feedbackByOutcome).toEqual({
      helpful: 0,
      "not-helpful": 0,
      "wrong-data": 0,
      "no-feedback": 0,
    });
  });

  it("counts each event type once into the top-level totals", () => {
    const rows: ProactiveMeterRow[] = [
      row({ event_type: "classify" }),
      row({ event_type: "classify" }),
      row({ event_type: "react" }),
      row({ event_type: "offer" }),
      row({ event_type: "accept" }),
    ];
    const summary = aggregateRows(rows);
    expect(summary.classifyCount).toBe(2);
    expect(summary.reactCount).toBe(1);
    expect(summary.offerCount).toBe(1);
    expect(summary.acceptCount).toBe(1);
  });

  it("breaks feedback out by outcome and ignores feedback rows in the bucket counters", () => {
    const rows: ProactiveMeterRow[] = [
      row({ event_type: "feedback", outcome: "helpful" }),
      row({ event_type: "feedback", outcome: "helpful" }),
      row({ event_type: "feedback", outcome: "not-helpful" }),
      row({ event_type: "feedback", outcome: "wrong-data" }),
      row({ event_type: "feedback", outcome: "no-feedback" }),
      row({ event_type: "feedback", outcome: null }),
    ];
    const summary = aggregateRows(rows);
    expect(summary.feedbackByOutcome.helpful).toBe(2);
    expect(summary.feedbackByOutcome["not-helpful"]).toBe(1);
    expect(summary.feedbackByOutcome["wrong-data"]).toBe(1);
    expect(summary.feedbackByOutcome["no-feedback"]).toBe(1);
    // No feedback rows leak into the typed bucket counters.
    expect(summary.classifyCount).toBe(0);
    expect(summary.reactCount).toBe(0);
  });

  it("sums cost across events into the workspace and per-channel totals", () => {
    const rows: ProactiveMeterRow[] = [
      row({ channel_id: "C-a", event_type: "classify", cost_micro_usd: 100 }),
      row({ channel_id: "C-a", event_type: "react", cost_micro_usd: 0 }),
      row({ channel_id: "C-b", event_type: "classify", cost_micro_usd: 200 }),
    ];
    const summary = aggregateRows(rows);
    expect(summary.totalCostMicroUsd).toBe(300);
    expect(summary.byChannel).toHaveLength(2);
    const a = summary.byChannel.find((c) => c.channelId === "C-a")!;
    const b = summary.byChannel.find((c) => c.channelId === "C-b")!;
    expect(a.totalCostMicroUsd).toBe(100);
    expect(b.totalCostMicroUsd).toBe(200);
  });

  it("preserves first-seen channel order in byChannel", () => {
    const rows: ProactiveMeterRow[] = [
      row({ channel_id: "C-b", event_type: "classify" }),
      row({ channel_id: "C-a", event_type: "classify" }),
      row({ channel_id: "C-c", event_type: "react" }),
      row({ channel_id: "C-a", event_type: "react" }),
    ];
    const summary = aggregateRows(rows);
    expect(summary.byChannel.map((c) => c.channelId)).toEqual([
      "C-b",
      "C-a",
      "C-c",
    ]);
  });

  it("rolls up per-channel counts independently", () => {
    const rows: ProactiveMeterRow[] = [
      row({ channel_id: "C-a", event_type: "classify" }),
      row({ channel_id: "C-a", event_type: "classify" }),
      row({ channel_id: "C-a", event_type: "react" }),
      row({ channel_id: "C-b", event_type: "classify" }),
      row({ channel_id: "C-b", event_type: "feedback", outcome: "helpful" }),
    ];
    const summary = aggregateRows(rows);
    const a = summary.byChannel.find((c) => c.channelId === "C-a")!;
    const b = summary.byChannel.find((c) => c.channelId === "C-b")!;
    expect(a.classifyCount).toBe(2);
    expect(a.reactCount).toBe(1);
    expect(a.feedbackByOutcome.helpful).toBe(0);
    expect(b.classifyCount).toBe(1);
    expect(b.feedbackByOutcome.helpful).toBe(1);
  });

  it("treats a missing cost as 0 without producing NaN", () => {
    const rows = [
      { channel_id: "C-a", event_type: "classify" as const, outcome: null, cost_micro_usd: undefined as unknown as number },
    ];
    const summary = aggregateRows(rows);
    expect(summary.totalCostMicroUsd).toBe(0);
    expect(Number.isFinite(summary.totalCostMicroUsd)).toBe(true);
  });
});
