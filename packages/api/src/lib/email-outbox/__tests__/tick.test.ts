/**
 * Per-tick orchestrator: snapshot → gauges → threshold warn → flush.
 * Driven with structural stubs (no Effect runtime, no OTel, no pino) —
 * exactly the Layer-handoff contract: layers.ts builds the deps,
 * runEmailOutboxTick does the work.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }),
}));

const { runEmailOutboxTick } = await import("../tick");
const { OutboxWarnRateLimiter } = await import("../depth");
type EmailOutboxDB = import("../outbox").EmailOutboxDB;
type EmailDispatcher = import("../outbox").EmailDispatcher;

const SNAPSHOT_ROW = { pending_count: "3", dead_count: "1", oldest_pending_at: null };

/**
 * Stub DB recording the order of SQL kinds so we can assert the
 * snapshot happens before the claim.
 */
function makeDb(claimRows: Array<Record<string, unknown>> = []): {
  db: EmailOutboxDB;
  order: string[];
} {
  const order: string[] = [];
  const db: EmailOutboxDB = {
    async query<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
      // CLAIM_SQL also contains `SELECT id FROM email_outbox`, so match
      // the UPDATE form first and key the snapshot off its unique
      // `COUNT(*) FILTER` aggregate.
      if (/UPDATE email_outbox\s+SET status = 'in_flight'/i.test(sql)) {
        order.push("claim");
        return claimRows as unknown as T[];
      }
      if (/COUNT\(\*\) FILTER/i.test(sql)) {
        order.push("snapshot");
        return [SNAPSHOT_ROW] as unknown as T[];
      }
      order.push("other");
      return [] as unknown as T[];
    },
  };
  return { db, order };
}

function gauge() {
  const values: number[] = [];
  return { record: (v: number) => values.push(v), values };
}

const okDispatcher: EmailDispatcher = async () => ({ kind: "ok" });

describe("runEmailOutboxTick", () => {
  test("snapshots before flushing and records both gauges", async () => {
    const { db, order } = makeDb([]);
    const pendingGauge = gauge();
    const deadGauge = gauge();
    const result = await runEmailOutboxTick({
      db,
      dispatcher: okDispatcher,
      batchLimit: 10,
      limiter: new OutboxWarnRateLimiter(100),
      pendingGauge,
      deadGauge,
      logger: { warn() {} },
    });
    expect(order[0]).toBe("snapshot");
    expect(order).toContain("claim");
    expect(order.indexOf("snapshot")).toBeLessThan(order.indexOf("claim"));
    expect(pendingGauge.values).toEqual([3]);
    expect(deadGauge.values).toEqual([1]);
    expect(result.snapshot.pending).toBe(3);
    expect(result.flush.claimed).toBe(0);
    expect(result.warned).toBe(false);
  });

  test("emits the depth warning when the limiter trips", async () => {
    const { db } = makeDb([]);
    const warnings: Array<{ data: Record<string, unknown>; msg: string }> = [];
    const result = await runEmailOutboxTick({
      db,
      dispatcher: okDispatcher,
      batchLimit: 10,
      // threshold 1, pending=3 → trips; injected now far past the
      // interval so the first warn fires.
      limiter: new OutboxWarnRateLimiter(1),
      pendingGauge: gauge(),
      deadGauge: gauge(),
      logger: { warn: (data, msg) => warnings.push({ data, msg }) },
      now: () => 10_000_000,
    });
    expect(result.warned).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].data.event).toBe("email_outbox.depth_threshold_warn");
  });

  test("propagates a snapshot failure and does NOT record gauges (no-silent-zero invariant)", async () => {
    // If the depth snapshot throws (e.g. a sticky pool failure), the tick
    // must propagate so the caller records tick_failed and the gauges keep
    // their last value — resetting them to 0 would make a broken queue
    // look healthy. Assert the throw propagates and neither gauge fired.
    const pendingGauge = gauge();
    const deadGauge = gauge();
    const db: EmailOutboxDB = {
      async query<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
        if (/COUNT\(\*\) FILTER/i.test(sql)) throw new Error("pool exploded");
        return [] as unknown as T[];
      },
    };
    await expect(
      runEmailOutboxTick({
        db,
        dispatcher: okDispatcher,
        batchLimit: 10,
        limiter: new OutboxWarnRateLimiter(100),
        pendingGauge,
        deadGauge,
        logger: { warn() {} },
      }),
    ).rejects.toThrow(/pool exploded/);
    expect(pendingGauge.values).toEqual([]);
    expect(deadGauge.values).toEqual([]);
  });

  test("dispatches claimed rows through flushBatch", async () => {
    const { db } = makeDb([
      {
        id: "row-1",
        email_type: "password-reset",
        // payload is stored as a string (encryptSecret output; plaintext
        // passthrough with no key) and decrypted+parsed by coerceMessage.
        payload: JSON.stringify({ to: "a@b.co", subject: "s", html: "h" }),
        org_id: null,
        expires_at: null,
        attempts: 1,
      },
    ]);
    const result = await runEmailOutboxTick({
      db,
      dispatcher: okDispatcher,
      batchLimit: 10,
      limiter: new OutboxWarnRateLimiter(100),
      pendingGauge: gauge(),
      deadGauge: gauge(),
      logger: { warn() {} },
    });
    expect(result.flush.claimed).toBe(1);
    expect(result.flush.ok).toBe(1);
  });
});
