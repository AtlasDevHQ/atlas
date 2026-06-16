import { describe, it, expect } from "bun:test";
import {
  decidePromoteDecay,
  type PromoteDecayCandidate,
  type PromoteDecayThresholds,
} from "../promote-decay";

const THRESHOLDS: PromoteDecayThresholds = {
  confidenceThreshold: 0.7,
  minRepetitions: 5,
  latencyBudgetMs: 1000,
  decayUnseenMs: 30 * 24 * 60 * 60 * 1000, // 30 days
};

// A fixed "now" so staleness math is deterministic (no Date.now()).
const NOW = Date.parse("2026-06-16T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function candidate(overrides: Partial<PromoteDecayCandidate>): PromoteDecayCandidate {
  return {
    id: "p-default",
    type: "query_pattern",
    status: "pending",
    confidence: 0.9,
    repetitionCount: 10,
    avgDurationMs: 200,
    lastSeenAt: daysAgo(1),
    autoPromoted: false,
    ...overrides,
  };
}

describe("decidePromoteDecay — promotion gate", () => {
  it("promotes a pending row that clears every gate", () => {
    const { promote, demote } = decidePromoteDecay([candidate({ id: "ok" })], THRESHOLDS, NOW);
    expect(promote).toEqual(["ok"]);
    expect(demote).toEqual([]);
  });

  it("does not promote below the confidence threshold", () => {
    const { promote } = decidePromoteDecay(
      [candidate({ id: "lowconf", confidence: 0.69 })],
      THRESHOLDS,
      NOW,
    );
    expect(promote).toEqual([]);
  });

  it("does not promote below the repetition floor", () => {
    const { promote } = decidePromoteDecay(
      [candidate({ id: "rare", repetitionCount: 4 })],
      THRESHOLDS,
      NOW,
    );
    expect(promote).toEqual([]);
  });

  it("does not promote when avg latency exceeds the budget", () => {
    const { promote } = decidePromoteDecay(
      [candidate({ id: "slow", avgDurationMs: 1001 })],
      THRESHOLDS,
      NOW,
    );
    expect(promote).toEqual([]);
  });

  it("promotes a row exactly at the latency budget (inclusive)", () => {
    const { promote } = decidePromoteDecay(
      [candidate({ id: "edge", avgDurationMs: 1000 })],
      THRESHOLDS,
      NOW,
    );
    expect(promote).toEqual(["edge"]);
  });

  it("does NOT promote a row whose latency was never measured (null avg)", () => {
    // Unmeasured latency must not be auto-amplified — conservative gate.
    const { promote } = decidePromoteDecay(
      [candidate({ id: "unmeasured", avgDurationMs: null })],
      THRESHOLDS,
      NOW,
    );
    expect(promote).toEqual([]);
  });

  it("ignores rows that are already approved for promotion", () => {
    const { promote } = decidePromoteDecay(
      [candidate({ id: "already", status: "approved" })],
      THRESHOLDS,
      NOW,
    );
    expect(promote).toEqual([]);
  });

  it("never promotes a semantic_amendment (stays human-reviewed)", () => {
    const { promote } = decidePromoteDecay(
      [candidate({ id: "amendment", type: "semantic_amendment" })],
      THRESHOLDS,
      NOW,
    );
    expect(promote).toEqual([]);
  });
});

describe("decidePromoteDecay — decay/demote gate", () => {
  it("demotes an auto-promoted row unseen past the decay window", () => {
    const { promote, demote } = decidePromoteDecay(
      [candidate({ id: "stale", status: "approved", autoPromoted: true, lastSeenAt: daysAgo(31) })],
      THRESHOLDS,
      NOW,
    );
    expect(demote).toEqual(["stale"]);
    expect(promote).toEqual([]);
  });

  it("keeps an auto-promoted row seen within the decay window", () => {
    const { demote } = decidePromoteDecay(
      [candidate({ id: "fresh", status: "approved", autoPromoted: true, lastSeenAt: daysAgo(29) })],
      THRESHOLDS,
      NOW,
    );
    expect(demote).toEqual([]);
  });

  it("never demotes a human-approved row, however stale", () => {
    // autoPromoted=false → a human vouched for it; only a human removes it.
    const { demote } = decidePromoteDecay(
      [candidate({ id: "human", status: "approved", autoPromoted: false, lastSeenAt: daysAgo(999) })],
      THRESHOLDS,
      NOW,
    );
    expect(demote).toEqual([]);
  });

  it("does not demote an auto-promoted row with no last_seen timestamp", () => {
    // Can't prove staleness without a timestamp — leave it alone.
    const { demote } = decidePromoteDecay(
      [candidate({ id: "noseen", status: "approved", autoPromoted: true, lastSeenAt: null })],
      THRESHOLDS,
      NOW,
    );
    expect(demote).toEqual([]);
  });

  it("does not demote a pending auto-promoted row (only approved rows decay)", () => {
    const { demote } = decidePromoteDecay(
      [candidate({ id: "pending-auto", status: "pending", autoPromoted: true, lastSeenAt: daysAgo(99) })],
      THRESHOLDS,
      NOW,
    );
    expect(demote).toEqual([]);
  });
});

describe("decidePromoteDecay — mixed batch", () => {
  it("partitions a batch into promote and demote sets in one pass", () => {
    const patterns = [
      candidate({ id: "promote-me" }),
      candidate({ id: "demote-me", status: "approved", autoPromoted: true, lastSeenAt: daysAgo(40) }),
      candidate({ id: "leave-me", status: "approved", autoPromoted: false, lastSeenAt: daysAgo(40) }),
      candidate({ id: "too-slow", avgDurationMs: 9999 }),
    ];
    const { promote, demote } = decidePromoteDecay(patterns, THRESHOLDS, NOW);
    expect(promote).toEqual(["promote-me"]);
    expect(demote).toEqual(["demote-me"]);
  });

  it("returns empty sets for an empty input", () => {
    expect(decidePromoteDecay([], THRESHOLDS, NOW)).toEqual({ promote: [], demote: [] });
  });
});
