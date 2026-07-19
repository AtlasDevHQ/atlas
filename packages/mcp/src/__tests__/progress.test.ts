/**
 * Unit tests for the progress + cancellation seam (#3500).
 *
 * Exercises the shared wrapper directly with a minimal fake `extra` so the
 * progress-token gating and the cancellation race are covered independently
 * of any tool. The end-to-end progress/cancel paths over a real
 * Client/Server are asserted in tools.test.ts / semantic-tools.test.ts.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  withProgressAndCancellation,
  startHeartbeat,
  OperationCancelledError,
  type McpRequestExtra,
  type ProgressReporter,
} from "../progress.js";

interface ProgressParams {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

/** Minimal `extra` double capturing emitted progress notifications. */
function fakeExtra(opts: {
  progressToken?: string | number;
  signal?: AbortSignal;
}): { extra: McpRequestExtra; progress: ProgressParams[] } {
  const progress: ProgressParams[] = [];
  const sendNotification = mock(async (n: { method: string; params?: ProgressParams }) => {
    if (n.method === "notifications/progress" && n.params) progress.push(n.params);
  });
  const extra = {
    signal: opts.signal ?? new AbortController().signal,
    requestId: 1,
    sendNotification,
    sendRequest: mock(async () => ({})),
    ...(opts.progressToken != null ? { _meta: { progressToken: opts.progressToken } } : {}),
  } as unknown as McpRequestExtra;
  return { extra, progress };
}

describe("withProgressAndCancellation", () => {
  it("emits a start (0) and final progress when a token is supplied", async () => {
    const { extra, progress } = fakeExtra({ progressToken: "tok" });
    const result = await withProgressAndCancellation(extra, { total: 3 }, async (reporter) => {
      await reporter.report(2, { message: "halfway" });
      return "ok";
    });

    expect(result).toBe("ok");
    expect(progress.map((p) => p.progress)).toEqual([0, 2, 3]);
    expect(progress.every((p) => p.progressToken === "tok")).toBe(true);
    expect(progress.at(-1)?.total).toBe(3);
  });

  it("is a no-op (no notifications) without a progressToken", async () => {
    const { extra, progress } = fakeExtra({});
    const result = await withProgressAndCancellation(extra, {}, async (reporter) => {
      await reporter.report(1);
      return 42;
    });
    expect(result).toBe(42);
    expect(progress).toEqual([]);
  });

  it("throws OperationCancelledError when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { extra } = fakeExtra({ signal: ac.signal });
    await expect(
      withProgressAndCancellation(extra, {}, async () => "never"),
    ).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("rejects with OperationCancelledError when aborted mid-flight", async () => {
    const ac = new AbortController();
    const { extra } = fakeExtra({ signal: ac.signal });
    const pending = withProgressAndCancellation(
      extra,
      {},
      // Work that never resolves on its own — only the abort ends it.
      () => new Promise<never>(() => {}),
    );
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("does not produce an unhandled rejection when work wins the race and abort fires after (#3584a)", async () => {
    // Regression for #3584: the cancellation promise rejected after `finally`
    // removed the abort listener (work won the race) and had no handler,
    // producing an unhandled rejection. The fix: `.catch(() => {})` on the
    // cancellation promise so the rejection is always consumed.
    const ac = new AbortController();
    const { extra } = fakeExtra({ signal: ac.signal });

    // Collect any unhandled rejections that fire during this test.
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", handler);

    try {
      // Work completes synchronously via Promise.resolve so it always wins.
      // Abort fires AFTER `withProgressAndCancellation` has returned, simulating
      // the "work wins then abort fires" race.
      const result = await withProgressAndCancellation(
        extra,
        {},
        async () => "done",
      );
      expect(result).toBe("done");

      // Abort after the work is done — this fires the cancellation promise
      // rejection, which must be silently swallowed by the `.catch`.
      ac.abort();

      // Give any microtask / unhandled-rejection detection a tick to fire.
      await new Promise((r) => setTimeout(r, 20));

      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", handler);
    }
  });
});

describe("startHeartbeat (#4734)", () => {
  /** Capture reporter.report calls into a list. */
  function captureReporter(): {
    reporter: ProgressReporter;
    reports: { progress: number; message?: string }[];
  } {
    const reports: { progress: number; message?: string }[] = [];
    const reporter: ProgressReporter = {
      report: async (progress, o) => {
        reports.push({ progress, ...(o?.message ? { message: o.message } : {}) });
      },
    };
    return { reporter, reports };
  }

  it("emits a bounded, strictly-increasing (<1) progress sequence until stopped", async () => {
    const { reporter, reports } = captureReporter();
    const stop = startHeartbeat(reporter, { intervalMs: 5, message: "still working" });
    await new Promise((r) => setTimeout(r, 32));
    stop();
    const countAtStop = reports.length;

    // Several intervals elapsed → multiple heartbeats.
    expect(countAtStop).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < reports.length; i++) {
      expect(reports[i].progress).toBeGreaterThan(0);
      expect(reports[i].progress).toBeLessThan(1); // bounded below the final(1)
      if (i > 0) expect(reports[i].progress).toBeGreaterThan(reports[i - 1].progress);
    }
    expect(reports[0].message).toBe("still working");

    // Stop clears the timer — no further emits.
    await new Promise((r) => setTimeout(r, 20));
    expect(reports.length).toBe(countAtStop);
  });

  it("omits the message field when none is supplied", async () => {
    const { reporter, reports } = captureReporter();
    const stop = startHeartbeat(reporter, { intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 16));
    stop();
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports.every((r) => r.message === undefined)).toBe(true);
  });

  it("stays monotonic through withProgressAndCancellation's final emit", async () => {
    // The wrapper emits start(0) then final(total ?? 1); the heartbeat's
    // bounded-below-1 values must never break that ordering.
    const { extra, progress } = fakeExtra({ progressToken: "tok" });
    const result = await withProgressAndCancellation(
      extra,
      { endMessage: "done" },
      async (reporter) => {
        const stop = startHeartbeat(reporter, { intervalMs: 5 });
        await new Promise((r) => setTimeout(r, 24));
        stop();
        return "ok";
      },
    );
    expect(result).toBe("ok");
    const values = progress.map((p) => p.progress);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(1);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });
});
