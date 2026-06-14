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
 * signal (native crash). A clean non-zero exit (real assertion failure) is
 * never retried.
 */
export const MAX_SIGNAL_RETRIES = 2;

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

/**
 * Spawn `bun test <file>` in an isolated subprocess and return the result.
 * If the subprocess exits via a signal (native crash), it is retried up to
 * MAX_SIGNAL_RETRIES times. A real assertion failure (clean non-zero exit)
 * is never retried.
 *
 * @param file  Absolute path to the test file to run.
 * @param cwd   Working directory for the subprocess.
 * @param env   Environment variables for the subprocess.
 */
export async function runFileWithSignalRetry(
  file: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<RunResult> {
  return runAttempt(file, cwd, env, 0);
}

async function runAttempt(
  file: string,
  cwd: string,
  env: Record<string, string | undefined>,
  attempt: number,
): Promise<RunResult> {
  const start = performance.now();
  const proc = Bun.spawn(["bun", "test", file], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;
  const exitCode = proc.exitCode ?? 1;
  const signalCode = proc.signalCode ?? null;
  const durationMs = performance.now() - start;

  // A subprocess killed by a signal (native crash, e.g. Bun SIGSEGV) is
  // distinguishable from a real assertion failure: the former has a non-null
  // signalCode while the latter exits cleanly with a non-zero exit code.
  // Retry signal-killed runs up to MAX_SIGNAL_RETRIES times so that a
  // transient Bun crash doesn't permanently fail the shard.
  if (signalCode !== null && attempt < MAX_SIGNAL_RETRIES) {
    const rel = relative(cwd, file);
    console.warn(
      `  \x1b[33mRETRY\x1b[0m  ${rel}  killed by signal ${signalCode} ` +
        `(attempt ${attempt + 1}/${MAX_SIGNAL_RETRIES}) — retrying…`,
    );
    const retried = await runAttempt(file, cwd, env, attempt + 1);
    return { ...retried, retries: retried.retries + 1 };
  }

  return { file, exitCode, signalCode, stdout, stderr, durationMs, retries: 0 };
}
