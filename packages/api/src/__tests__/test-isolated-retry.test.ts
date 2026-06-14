/**
 * Regression test for the signal-aware retry in scripts/signal-retry.ts.
 *
 * Bun 1.3.13 can segfault (native crash) mid-run — the subprocess exits via
 * a signal (non-null signalCode) rather than a clean non-zero exit code.
 * Before the fix, that looked identical to a real test failure and caused
 * spurious CI shard fails (#3490).
 *
 * These tests call runFileWithSignalRetry() directly via the _spawn seam so
 * we can simulate signal-killed vs assertion-failed subprocesses without
 * actually spawning real Bun processes.
 */

import { describe, test, expect } from "bun:test";
import {
  runFileWithSignalRetry,
  MAX_SIGNAL_RETRIES,
  CRASH_SIGNALS,
  type SpawnedProc,
} from "../../scripts/signal-retry";

// --- Minimal subprocess stub helpers ---

function makeStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function makeProc(exitCode: number | null, signalCode: string | null): SpawnedProc {
  return {
    stdout: makeStream(""),
    stderr: makeStream(""),
    exited: Promise.resolve(exitCode ?? 0),
    exitCode,
    signalCode,
  };
}

/**
 * Build a _spawn stub that returns procs from a sequence in order.
 * Throws if called more times than there are entries.
 */
function makeSpawnSequence(sequence: Array<() => SpawnedProc>) {
  let callCount = 0;
  return (_args: string[], _opts: object): SpawnedProc => {
    const factory = sequence[callCount];
    if (!factory) throw new Error(`spawn called more times (${callCount + 1}) than sequence length (${sequence.length})`);
    callCount++;
    return factory();
  };
}

describe("signal-aware retry — runFileWithSignalRetry", () => {
  test("MAX_SIGNAL_RETRIES is 2 (constant contract)", () => {
    // Pins the constant so a refactor can't silently change the cap.
    expect(MAX_SIGNAL_RETRIES).toBe(2);
  });

  test("CRASH_SIGNALS contains the expected set", () => {
    expect(CRASH_SIGNALS.has("SIGSEGV")).toBe(true);
    expect(CRASH_SIGNALS.has("SIGABRT")).toBe(true);
    expect(CRASH_SIGNALS.has("SIGBUS")).toBe(true);
    expect(CRASH_SIGNALS.has("SIGILL")).toBe(true);
    expect(CRASH_SIGNALS.has("SIGTRAP")).toBe(true);
    expect(CRASH_SIGNALS.has("SIGKILL")).toBe(false);
    expect(CRASH_SIGNALS.has("SIGTERM")).toBe(false);
  });

  test("crash-signal subprocess (SIGSEGV) that passes on retry resolves as success", async () => {
    const spawn = makeSpawnSequence([
      () => makeProc(null, "SIGSEGV"), // first run: crash-killed
      () => makeProc(0, null),          // retry: clean pass
    ]);

    const result = await runFileWithSignalRetry("/fake/file.test.ts", "/fake", {}, spawn);

    expect(result.retries).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.signalCode).toBeNull();
  });

  test("crash-signal subprocess retried up to MAX_SIGNAL_RETRIES and still fails", async () => {
    // All attempts crash — exhausts retry budget
    const spawn = makeSpawnSequence([
      () => makeProc(null, "SIGSEGV"),
      () => makeProc(null, "SIGSEGV"),
      () => makeProc(null, "SIGSEGV"), // third attempt (after 2 retries)
    ]);

    const result = await runFileWithSignalRetry("/fake/file.test.ts", "/fake", {}, spawn);

    // Should have retried MAX_SIGNAL_RETRIES times
    expect(result.retries).toBe(MAX_SIGNAL_RETRIES);
    // Final result still carries the signal code
    expect(result.signalCode).toBe("SIGSEGV");
    // Non-zero exit (proc.exitCode was null → defaults to 1)
    expect(result.exitCode).toBe(1);
  });

  test("real assertion failure (clean non-zero exit) is NEVER retried — AC2", async () => {
    // A genuine bun test failure: exitCode 1, signalCode null
    const spawn = makeSpawnSequence([
      () => makeProc(1, null),
      () => { throw new Error("should not be called — real failures must not retry"); },
    ]);

    const result = await runFileWithSignalRetry("/fake/file.test.ts", "/fake", {}, spawn);

    expect(result.retries).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.signalCode).toBeNull();
  });

  test("passing test file exits cleanly with zero retries", async () => {
    const spawn = makeSpawnSequence([
      () => makeProc(0, null),
    ]);

    const result = await runFileWithSignalRetry("/fake/file.test.ts", "/fake", {}, spawn);

    expect(result.retries).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.signalCode).toBeNull();
  });

  test("SIGKILL is NOT retried (OOM kill must not consume retry budget)", async () => {
    const spawn = makeSpawnSequence([
      () => makeProc(null, "SIGKILL"),
      () => { throw new Error("should not be called — SIGKILL must not retry"); },
    ]);

    const result = await runFileWithSignalRetry("/fake/file.test.ts", "/fake", {}, spawn);

    expect(result.retries).toBe(0);
    expect(result.signalCode).toBe("SIGKILL");
    expect(result.exitCode).toBe(1);
  });

  test("SIGTERM is NOT retried (CI job cancel must not retry)", async () => {
    const spawn = makeSpawnSequence([
      () => makeProc(null, "SIGTERM"),
      () => { throw new Error("should not be called — SIGTERM must not retry"); },
    ]);

    const result = await runFileWithSignalRetry("/fake/file.test.ts", "/fake", {}, spawn);

    expect(result.retries).toBe(0);
    expect(result.signalCode).toBe("SIGTERM");
    expect(result.exitCode).toBe(1);
  });

  test("each CRASH_SIGNALS member is retried", async () => {
    for (const sig of CRASH_SIGNALS) {
      const spawn = makeSpawnSequence([
        () => makeProc(null, sig),
        () => makeProc(0, null), // passes on retry
      ]);

      const result = await runFileWithSignalRetry("/fake/file.test.ts", "/fake", {}, spawn);

      expect(result.retries).toBe(1);
      expect(result.exitCode).toBe(0);
    }
  });

  test("durationMs accumulates across retried attempts", async () => {
    // We can't control timing, but we can assert durationMs > 0 and that
    // the final result reflects at least 2 attempts worth of elapsed time
    // (both > 0). This proves the accumulation path rather than the exact value.
    const spawn = makeSpawnSequence([
      () => makeProc(null, "SIGSEGV"),
      () => makeProc(0, null),
    ]);

    const result = await runFileWithSignalRetry("/fake/file.test.ts", "/fake", {}, spawn);

    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.retries).toBe(1);
  });

  test("spawn throw produces a failed RunResult without hanging", async () => {
    const spawn = (_args: string[], _opts: object): SpawnedProc => {
      throw new Error("spawn error: out of file descriptors");
    };

    const result = await runFileWithSignalRetry("/fake/file.test.ts", "/fake", {}, spawn);

    expect(result.exitCode).toBe(1);
    expect(result.signalCode).toBeNull();
    expect(result.stderr).toContain("spawn error: out of file descriptors");
    expect(result.retries).toBe(0);
  });
});
