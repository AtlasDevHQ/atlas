/**
 * Signal-aware subprocess runner used by test-isolated.ts.
 *
 * Bun 1.3.13 can segfault (native crash) mid-run. The subprocess then exits
 * with a non-null signalCode (e.g. "SIGSEGV") rather than a clean non-zero
 * exit code. A clean non-zero code means a real test assertion failure.
 *
 * This module exports the retry logic as a pure function so it can be
 * unit-tested without running the full test-isolated.ts script.
 */

import { relative } from "node:path";

/**
 * Maximum number of times to retry a test file whose subprocess exits via a
 * crash signal (SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGTRAP). A clean non-zero
 * exit (real assertion failure) and non-crash signals (SIGKILL, SIGTERM) are
 * never retried.
 */
export const MAX_SIGNAL_RETRIES = 2;

/**
 * Signals that indicate a genuine native crash (e.g. Bun segfault). Only
 * these are eligible for retry. SIGKILL (OOM killer) and SIGTERM (CI cancel /
 * timeout) fall through to the normal failure path — retrying them masks OOM
 * and wastes the budget on cancelled jobs.
 */
export const CRASH_SIGNALS = new Set([
  "SIGSEGV",
  "SIGABRT",
  "SIGBUS",
  "SIGILL",
  "SIGTRAP",
]);

export interface RunResult {
  file: string;
  exitCode: number;
  /** Non-null when the subprocess was killed by a signal (e.g. "SIGSEGV"). */
  signalCode: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Number of signal-triggered retries that preceded this final result. */
  retries: number;
}

/** Minimal interface for a spawned process — matches Bun.spawn's return type. */
export interface SpawnedProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  exitCode: number | null;
  signalCode: string | null;
}

/**
 * Spawn `bun test <file>` in an isolated subprocess and return the result.
 * If the subprocess exits via a crash signal (SIGSEGV, SIGABRT, SIGBUS,
 * SIGILL, SIGTRAP), it is retried up to MAX_SIGNAL_RETRIES times. Non-crash
 * signals (SIGKILL, SIGTERM) and real assertion failures (clean non-zero exit)
 * are never retried.
 *
 * @param file   Absolute path to the test file to run.
 * @param cwd    Working directory for the subprocess.
 * @param env    Environment variables for the subprocess.
 * @param _spawn Spawn implementation — defaults to Bun.spawn. Pass a stub in
 *               tests to simulate signal-killed or assertion-failed subprocesses
 *               without spawning real processes.
 */
export async function runFileWithSignalRetry(
  file: string,
  cwd: string,
  env: Record<string, string | undefined>,
  _spawn: (
    args: string[],
    opts: {
      cwd: string;
      stdout: "pipe";
      stderr: "pipe";
      env: Record<string, string | undefined>;
    },
  ) => SpawnedProc = (args, opts) => Bun.spawn(args, opts),
): Promise<RunResult> {
  return runAttempt(file, cwd, env, _spawn, 0, 0);
}

async function runAttempt(
  file: string,
  cwd: string,
  env: Record<string, string | undefined>,
  _spawn: (
    args: string[],
    opts: {
      cwd: string;
      stdout: "pipe";
      stderr: "pipe";
      env: Record<string, string | undefined>;
    },
  ) => SpawnedProc,
  attempt: number,
  accumulatedMs: number,
): Promise<RunResult> {
  const start = performance.now();

  let proc: SpawnedProc;
  try {
    proc = _spawn(["bun", "test", file], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  \x1b[33mWARN\x1b[0m  spawn failed for ${relative(cwd, file)}: ${msg}`);
    return {
      file,
      exitCode: 1,
      signalCode: null,
      stdout: "",
      stderr: msg,
      durationMs: accumulatedMs + (performance.now() - start),
      retries: attempt,
    };
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;
  const exitCode = proc.exitCode ?? 1;
  const signalCode = proc.signalCode ?? null;
  const durationMs = performance.now() - start;

  // Only retry on genuine crash signals — SIGKILL (OOM) and SIGTERM (CI
  // cancel/timeout) must not be retried.
  if (signalCode !== null && CRASH_SIGNALS.has(signalCode) && attempt < MAX_SIGNAL_RETRIES) {
    const rel = relative(cwd, file);
    console.warn(
      `  \x1b[33mRETRY\x1b[0m  ${rel}  killed by signal ${signalCode} ` +
        `(retry ${attempt + 1} of ${MAX_SIGNAL_RETRIES}) — retrying…`,
    );
    const retried = await runAttempt(file, cwd, env, _spawn, attempt + 1, accumulatedMs + durationMs);
    return { ...retried, retries: retried.retries + 1, durationMs: retried.durationMs + durationMs };
  }

  return { file, exitCode, signalCode, stdout, stderr, durationMs: accumulatedMs + durationMs, retries: 0 };
}
