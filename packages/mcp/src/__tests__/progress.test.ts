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
  OperationCancelledError,
  type McpRequestExtra,
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
});
