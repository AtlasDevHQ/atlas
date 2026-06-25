/**
 * Unit tests for the demo tracking data layer (#3931) — the pure fold/join
 * logic behind /platform/demo, exercised directly (no HTTP, no DB mock).
 * `demo.ts` has no module-load side effects, so the real `demoUserId` hash is
 * used to key the leads↔usage join authentically.
 */

import { describe, it, expect } from "bun:test";
import { demoUserId } from "@atlas/api/lib/demo";
import {
  foldUsage,
  weightedAvgLatency,
  assembleLeads,
  assembleMetrics,
  assembleTranscript,
  type UsageRow,
  type LeadRow,
  type ConvCountRow,
} from "@atlas/api/lib/demo-tracking";

const HAIKU = "anthropic/claude-haiku-4.5";

function usage(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    user_id: "demo:abc",
    model: HAIKU,
    provider: "gateway",
    turns: 1,
    prompt_tokens: "0",
    completion_tokens: "0",
    cache_read_tokens: "0",
    cache_write_tokens: "0",
    avg_latency_ms: null,
    latency_count: 0,
    ...overrides,
  };
}

describe("weightedAvgLatency", () => {
  it("weights by latency_count, not a plain average", () => {
    // (1000*1 + 2000*3) / (1+3) = 1750, not (1000+2000)/2 = 1500.
    expect(
      weightedAvgLatency([
        { avg: 1000, count: 1 },
        { avg: 2000, count: 3 },
      ]),
    ).toBe(1750);
  });

  it("skips rows with null avg or zero count", () => {
    expect(
      weightedAvgLatency([
        { avg: null, count: 5 },
        { avg: 9999, count: 0 },
        { avg: 2000, count: 2 },
      ]),
    ).toBe(2000);
  });

  it("returns null when no row contributes a latency sample", () => {
    expect(weightedAvgLatency([])).toBeNull();
    expect(weightedAvgLatency([{ avg: null, count: 0 }])).toBeNull();
  });
});

describe("foldUsage", () => {
  it("sums token buckets and coerces bigint-string columns", () => {
    const folded = foldUsage([
      usage({ turns: 2, prompt_tokens: "1000", completion_tokens: "200", cache_read_tokens: "50" }),
    ]);
    expect(folded.turns).toBe(2);
    expect(folded.promptTokens).toBe(1000);
    expect(folded.completionTokens).toBe(200);
    expect(folded.cacheReadTokens).toBe(50);
  });

  it("coerces a non-numeric token column to 0 (defensive)", () => {
    const folded = foldUsage([usage({ prompt_tokens: "not-a-number" })]);
    expect(folded.promptTokens).toBe(0);
    expect(Number.isFinite(folded.estimatedCostUsd ?? 0)).toBe(true);
  });

  it("partial estimate: mixed priced + unpriced → non-null cost, costComplete=false", () => {
    const folded = foldUsage([
      usage({ model: HAIKU, prompt_tokens: "1000000", completion_tokens: "0" }), // $1
      usage({ model: "some-unknown-model", prompt_tokens: "1000000" }), // unpriced
    ]);
    // Cost is the haiku-only figure — NOT null, NOT zero.
    expect(folded.estimatedCostUsd).toBeCloseTo(1, 6);
    expect(folded.costComplete).toBe(false);
  });

  it("all models unpriced → estimatedCostUsd null (distinct from $0), costComplete=false", () => {
    const folded = foldUsage([usage({ model: "mystery", prompt_tokens: "1000" })]);
    expect(folded.estimatedCostUsd).toBeNull();
    expect(folded.costComplete).toBe(false);
  });

  it("empty → zeroed rollup, null cost, costComplete=true, null latency", () => {
    const folded = foldUsage([]);
    expect(folded).toEqual({
      turns: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      avgLatencyMs: null,
      estimatedCostUsd: null,
      costComplete: true,
    });
  });
});

describe("assembleLeads", () => {
  const alice = "alice@example.com";
  const aliceUid = demoUserId(alice);

  const leadRows: LeadRow[] = [
    {
      email: alice,
      session_count: 3,
      created_at: "2026-06-01T00:00:00.000Z",
      last_active_at: "2026-06-10T00:00:00.000Z",
    },
  ];

  it("keys usage to email by hashed user_id and drops orphaned usage rows", () => {
    const usageRows: UsageRow[] = [
      usage({ user_id: aliceUid, turns: 2, prompt_tokens: "1000", completion_tokens: "200", avg_latency_ms: 1500, latency_count: 2 }),
      // Orphan: a demo conversation whose lead was deleted — must NOT resurrect.
      usage({ user_id: "demo:orphaned", turns: 9, prompt_tokens: "9999" }),
    ];
    const convCounts: ConvCountRow[] = [{ user_id: aliceUid, conversation_count: 1 }];

    const leads = assembleLeads(leadRows, usageRows, convCounts);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.email).toBe(alice);
    expect(leads[0]!.conversationCount).toBe(1);
    expect(leads[0]!.usage.turns).toBe(2); // orphan's 9 turns excluded
    expect(leads[0]!.usage.promptTokens).toBe(1000);
    expect(leads[0]!.usage.avgLatencyMs).toBe(1500);
    // usage rollup must NOT carry the internal costComplete flag.
    expect("costComplete" in leads[0]!.usage).toBe(false);
  });

  it("folds multiple models for one lead and weights latency across them", () => {
    const usageRows: UsageRow[] = [
      usage({ user_id: aliceUid, model: HAIKU, turns: 1, prompt_tokens: "1000000", avg_latency_ms: 1000, latency_count: 1 }),
      usage({ user_id: aliceUid, model: "anthropic/claude-sonnet-4.6", turns: 3, prompt_tokens: "1000000", avg_latency_ms: 2000, latency_count: 3 }),
    ];
    const leads = assembleLeads(leadRows, usageRows, []);
    expect(leads[0]!.usage.turns).toBe(4);
    expect(leads[0]!.usage.promptTokens).toBe(2_000_000);
    expect(leads[0]!.usage.avgLatencyMs).toBe(1750); // count-weighted
    // haiku $1 + sonnet $3 over 1M input each = $4.
    expect(leads[0]!.usage.estimatedCostUsd).toBeCloseTo(4, 6);
  });

  it("a lead with no demo turns gets a zeroed rollup and null cost", () => {
    const leads = assembleLeads(leadRows, [], []);
    expect(leads[0]!.usage.turns).toBe(0);
    expect(leads[0]!.usage.estimatedCostUsd).toBeNull();
    expect(leads[0]!.conversationCount).toBe(0);
  });
});

describe("assembleMetrics", () => {
  it("totals equal the sum of per-model costs (per-model GROUP BY is load-bearing)", () => {
    const perModel: UsageRow[] = [
      usage({ model: HAIKU, turns: 2, prompt_tokens: "1000000" }), // $1
      usage({ model: "anthropic/claude-sonnet-4.6", turns: 1, prompt_tokens: "1000000" }), // $3
    ];
    const metrics = assembleMetrics(perModel, [{ lead_count: 5, session_count: 12 }]);
    expect(metrics.leadCount).toBe(5);
    expect(metrics.sessionCount).toBe(12);
    expect(metrics.totals.turns).toBe(3);
    expect(metrics.totals.estimatedCostUsd).toBeCloseTo(4, 6);
    expect(metrics.totals.costComplete).toBe(true);
    expect(metrics.perModel).toHaveLength(2);
    const sumPerModel = metrics.perModel.reduce((s, m) => s + (m.estimatedCostUsd ?? 0), 0);
    expect(metrics.totals.estimatedCostUsd).toBeCloseTo(sumPerModel, 9);
  });

  it("flags costComplete=false when one model is unpriced but keeps the priced partial", () => {
    const perModel: UsageRow[] = [
      usage({ model: HAIKU, turns: 1, prompt_tokens: "1000000" }), // $1
      usage({ model: "mystery", turns: 1, prompt_tokens: "1000000" }), // unpriced
    ];
    const metrics = assembleMetrics(perModel, [{ lead_count: 0, session_count: 0 }]);
    expect(metrics.totals.costComplete).toBe(false);
    expect(metrics.totals.estimatedCostUsd).toBeCloseTo(1, 6);
  });

  it("defaults lead/session counts to 0 when the counts query returns no row", () => {
    const metrics = assembleMetrics([], []);
    expect(metrics.leadCount).toBe(0);
    expect(metrics.sessionCount).toBe(0);
    expect(metrics.totals.turns).toBe(0);
    expect(metrics.perModel).toEqual([]);
  });
});

describe("assembleTranscript", () => {
  it("groups messages under their conversation, preserving conversation order", () => {
    const t = assembleTranscript(
      "alice@example.com",
      [
        { id: "c2", title: "Second", created_at: "2026-06-02T00:00:00.000Z" },
        { id: "c1", title: null, created_at: "2026-06-01T00:00:00.000Z" },
      ],
      [
        { conversation_id: "c1", role: "user", content: [{ type: "text", text: "hi" }], created_at: "2026-06-01T00:00:01.000Z" },
        { conversation_id: "c2", role: "user", content: "q", created_at: "2026-06-02T00:00:01.000Z" },
        { conversation_id: "c2", role: "assistant", content: "a", created_at: "2026-06-02T00:00:02.000Z" },
      ],
    );
    expect(t.email).toBe("alice@example.com");
    expect(t.conversations.map((c) => c.id)).toEqual(["c2", "c1"]); // order preserved
    expect(t.conversations[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(t.conversations[1]!.messages).toHaveLength(1);
  });

  it("a conversation with no messages gets an empty array", () => {
    const t = assembleTranscript("x@y.com", [{ id: "c1", title: "T", created_at: "2026-06-01T00:00:00.000Z" }], []);
    expect(t.conversations[0]!.messages).toEqual([]);
  });

  it("no conversations → empty list", () => {
    expect(assembleTranscript("x@y.com", [], []).conversations).toEqual([]);
  });
});
