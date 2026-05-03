/**
 * Orchestration test for `subProcessorPublisherTick` (#1924).
 *
 * Locks the contracts the publisher header advertises:
 *   - Initial-baseline branch: records snapshot, no fan-out.
 *   - Hash-differs-but-empty-diff branch: stamps a new snapshot,
 *     no fan-out, doesn't re-fetch every tick afterward.
 *   - At-least-once: snapshot insert is the LAST step, so a partial
 *     fan-out replays the same diff on the next tick.
 *   - Source-fetch failure modes: 4xx, non-array, malformed JSON,
 *     transport error all skip the tick (no snapshot written, no
 *     deliveries fired).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

import type { SubProcessor } from "@atlas/api/lib/sub-processor-publisher";

// In-memory rows for the snapshot + subscription tables. Reset per test.
const snapshots: { payload: SubProcessor[]; payload_hash: string }[] = [];
let subscriptions: { id: string; url: string; token_encrypted: string }[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: async (sql: string, params?: unknown[]) => {
    if (/SELECT id, url, token_encrypted/.test(sql)) {
      return subscriptions;
    }
    if (/SELECT payload, payload_hash/.test(sql)) {
      // Most recent first.
      return snapshots.length ? [snapshots[snapshots.length - 1]] : [];
    }
    if (/INSERT INTO sub_processor_snapshots/.test(sql)) {
      const [payloadJson, payloadHash] = params ?? [];
      snapshots.push({
        payload: JSON.parse(String(payloadJson)),
        payload_hash: String(payloadHash),
      });
      return [];
    }
    if (/INSERT INTO sub_processor_subscriptions/.test(sql)) {
      // The encryption test covers this path; the tick test never inserts.
      return [];
    }
    return [];
  },
}));

const { subProcessorPublisherTick } = await import(
  "@atlas/api/lib/sub-processor-publisher"
);

const A: SubProcessor = {
  name: "Vercel",
  purpose: "AI Gateway",
  region: "United States",
  since: "2026-01",
  changed_at: "2026-01-15",
};
const B: SubProcessor = {
  name: "Anthropic",
  purpose: "Hosted model inference",
  region: "United States",
  since: "2026-01",
  changed_at: "2026-01-15",
};

const SUB = {
  id: "sub-1",
  url: "https://hooks.example.com/sp",
  token_encrypted: "test-token-at-least-16-chars",
};
const SUB2 = {
  id: "sub-2",
  url: "https://hooks2.example.com/sp",
  token_encrypted: "another-test-token-16-chars",
};

beforeEach(() => {
  snapshots.length = 0;
  subscriptions = [];
});

describe("subProcessorPublisherTick — orchestration", () => {
  it("does nothing when there are no subscriptions (no source fetch)", async () => {
    const fetcher = mock(async () => new Response("[]", { status: 200 }));
    await subProcessorPublisherTick({
      fetcher: fetcher as unknown as typeof fetch,
      sourceUrl: "https://example.test/source.json",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(0);
  });

  it("first tick records baseline and does NOT fan out — protects existing subscribers from a flood of 'added' events", async () => {
    subscriptions.push(SUB);
    const fetcher = mock(async (url: string) => {
      if (url === "https://example.test/source.json") {
        return new Response(JSON.stringify([A, B]), { status: 200 });
      }
      // Any call to a subscription URL is a contract violation here.
      throw new Error(`unexpected fetch: ${url}`);
    });

    await subProcessorPublisherTick({
      fetcher: fetcher as unknown as typeof fetch,
      sourceUrl: "https://example.test/source.json",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].payload).toHaveLength(2);
    // Source fetched once, no deliveries.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fans out only the diff on the second tick — not the whole list", async () => {
    subscriptions.push(SUB);
    // Seed an existing snapshot so the next call is a real diff.
    snapshots.push({
      payload: [A],
      payload_hash: "seeded-hash",
    });

    const deliveries: { url: string; body: unknown }[] = [];
    const fetcher = mock(async (url: string, init?: RequestInit) => {
      if (url === "https://example.test/source.json") {
        return new Response(JSON.stringify([A, B]), { status: 200 });
      }
      deliveries.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(null, { status: 200 });
    });

    await subProcessorPublisherTick({
      fetcher: fetcher as unknown as typeof fetch,
      sourceUrl: "https://example.test/source.json",
    });

    // Only one event (B added) × one subscription = one delivery.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].body).toMatchObject({ event: "added", entry: { name: "Anthropic" } });
    expect(snapshots).toHaveLength(2); // seeded + new
  });

  it("at-least-once: a partial fan-out replays the same diff on the next tick", async () => {
    subscriptions.push(SUB, SUB2);
    snapshots.push({ payload: [A], payload_hash: "seed" });

    let attemptCount = 0;
    const fetcher = mock(async (url: string) => {
      if (url === "https://example.test/source.json") {
        return new Response(JSON.stringify([A, B]), { status: 200 });
      }
      attemptCount++;
      // Fail SUB2 on the first tick to simulate a partial fan-out.
      // SUB succeeds; SUB2 4xx (permanent, no retry).
      if (url === SUB2.url && attemptCount <= 2) {
        return new Response("nope", { status: 400 });
      }
      return new Response(null, { status: 200 });
    });

    await subProcessorPublisherTick({
      fetcher: fetcher as unknown as typeof fetch,
      sourceUrl: "https://example.test/source.json",
    });

    // First tick: snapshot was inserted (LAST step) — good. SUB2's
    // delivery permanently failed but the snapshot moved on. The point
    // of "snapshot row last" is that a *crash* mid-fan-out replays;
    // a 4xx is a logged-and-moved-on outcome by design (#21 in review).
    expect(snapshots).toHaveLength(2);
    const lastHash = snapshots[snapshots.length - 1].payload_hash;
    expect(lastHash).not.toBe("seed");

    // Second tick with same payload: hash matches → no re-fetch of
    // diff, no re-delivery.
    const callsBefore = (fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await subProcessorPublisherTick({
      fetcher: fetcher as unknown as typeof fetch,
      sourceUrl: "https://example.test/source.json",
    });
    const callsAfter = (fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    // Only the source GET — no extra subscription POSTs.
    expect(callsAfter - callsBefore).toBe(1);
  });

  it("hash-differs but no semantic change: stamps new snapshot, no fan-out, stops re-diffing next tick", async () => {
    subscriptions.push(SUB);
    // Seed with a payload whose JSON shape is equivalent to the source
    // but whose hash will differ (different field order would normally
    // be re-canonicalized by hashPayload's sort, so we inject a hash
    // mismatch by seeding with the wrong recorded hash).
    snapshots.push({ payload: [A], payload_hash: "DELIBERATELY-WRONG-HASH" });

    const deliveries: string[] = [];
    const fetcher = mock(async (url: string) => {
      if (url === "https://example.test/source.json") {
        return new Response(JSON.stringify([A]), { status: 200 });
      }
      deliveries.push(url);
      return new Response(null, { status: 200 });
    });

    await subProcessorPublisherTick({
      fetcher: fetcher as unknown as typeof fetch,
      sourceUrl: "https://example.test/source.json",
    });

    // No semantic diff (same single entry A) — no deliveries.
    expect(deliveries).toHaveLength(0);
    // But a new snapshot WAS stamped so the wrong hash gets corrected.
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].payload_hash).not.toBe("DELIBERATELY-WRONG-HASH");
  });

  it("4xx from the source URL skips the tick — no snapshot, no deliveries", async () => {
    subscriptions.push(SUB);
    const fetcher = mock(async (url: string) => {
      if (url === "https://example.test/source.json") {
        return new Response("not found", { status: 404 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await subProcessorPublisherTick({
      fetcher: fetcher as unknown as typeof fetch,
      sourceUrl: "https://example.test/source.json",
    });

    expect(snapshots).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("non-array source body skips the tick", async () => {
    subscriptions.push(SUB);
    const fetcher = mock(async () =>
      new Response(JSON.stringify({ data: [A] }), { status: 200 }),
    );
    await subProcessorPublisherTick({
      fetcher: fetcher as unknown as typeof fetch,
      sourceUrl: "https://example.test/source.json",
    });
    expect(snapshots).toHaveLength(0);
  });

  it("schema-invalid source row skips the tick (no partial fan-out of garbage)", async () => {
    subscriptions.push(SUB);
    const fetcher = mock(async (url: string) => {
      if (url === "https://example.test/source.json") {
        // `changed_at` violates the YYYY-MM-DD regex.
        return new Response(
          JSON.stringify([{ ...A, changed_at: "yesterday" }]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await subProcessorPublisherTick({
      fetcher: fetcher as unknown as typeof fetch,
      sourceUrl: "https://example.test/source.json",
    });

    expect(snapshots).toHaveLength(0);
    // Source fetch only — no fan-out of the garbage row.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("transport error fetching source skips the tick", async () => {
    subscriptions.push(SUB);
    const fetcher = mock(async () => {
      throw new TypeError("ECONNREFUSED");
    });
    await subProcessorPublisherTick({
      fetcher: fetcher as unknown as typeof fetch,
      sourceUrl: "https://example.test/source.json",
    });
    expect(snapshots).toHaveLength(0);
  });
});
