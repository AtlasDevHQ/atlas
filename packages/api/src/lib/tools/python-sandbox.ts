/**
 * Vercel Sandbox backend for the Python execution tool.
 *
 * Uses @vercel/sandbox with runtime: "python3.13" to run Python code
 * in an ephemeral Firecracker microVM. Adapted from the explore-sandbox.ts
 * pattern but with a different lifecycle (lazy creation, package installation):
 * - Creates a Python 3.13 sandbox (initially allow-all for pip install)
 * - Installs data science packages, then locks down to deny-all
 * - Writes wrapper + user code to the sandbox filesystem
 * - Injects data via a JSON file (runCommand does not support stdin piping)
 * - Collects charts and structured output via result marker
 * - Unlike explore-sandbox.ts, the sandbox is created lazily and reused
 *   across calls (no explicit close/stop lifecycle — invalidation stops
 *   the old sandbox and creates a fresh one on next call)
 *
 * Only loaded when ATLAS_RUNTIME=vercel or running on the Vercel platform.
 *
 * Uses Effect.tryPromise for all async operations, Effect.timeout for
 * execution deadlines, Effect.retry with exponential backoff for transient
 * sandbox creation failures, and module-local tagged errors
 * (SandboxInfraError, SandboxTimeoutError) to distinguish recoverable
 * failure modes.
 */

import { Effect, Data, Duration, Schedule } from "effect";
import type { PythonBackend, PythonResult } from "./python";
import { PYTHON_SECURITY_AND_SETUP, PYTHON_EXEC_AND_COLLECT } from "./python-wrapper";
import { sandboxErrorDetail, safeError, MAX_OUTPUT } from "./backends/shared";
import { randomUUID } from "crypto";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("python-sandbox");

/** Default Python execution timeout in ms. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Packages to install in the sandbox. */
const DATA_SCIENCE_PACKAGES = [
  "pandas",
  "numpy",
  "matplotlib",
  "scipy",
  "scikit-learn",
  "statsmodels",
];

/**
 * Non-streaming Python wrapper for Vercel Sandbox. Composes shared fragments
 * (PYTHON_SECURITY_AND_SETUP, PYTHON_EXEC_AND_COLLECT) with file-based
 * data injection (argv[2]) since runCommand does not support stdin piping.
 */
const PYTHON_WRAPPER = `
import sys, json, io, base64, glob, os, ast

_marker = os.environ["ATLAS_RESULT_MARKER"]
_chart_dir = os.environ.get("ATLAS_CHART_DIR", "/tmp/charts")

def _report_error(msg):
    print(_marker + json.dumps({"success": False, "error": msg}))
    sys.exit(0)

${PYTHON_SECURITY_AND_SETUP}

# --- Data injection (from file, not stdin) ---
_atlas_data = None
if len(sys.argv) > 2:
    _data_file = sys.argv[2]
    if os.path.exists(_data_file):
        with open(_data_file) as f:
            _raw = f.read().strip()
            if _raw:
                _atlas_data = json.loads(_raw)

data = None
df = None
if _atlas_data:
    try:
        import pandas as pd
        df = pd.DataFrame(_atlas_data["rows"], columns=_atlas_data["columns"])
        data = df
    except ImportError:
        data = _atlas_data

${PYTHON_EXEC_AND_COLLECT}
`;

// Sandbox base dir for relative paths
const SANDBOX_BASE = "/vercel/sandbox";

// ── Local tagged errors ──────────────────────────────────────────────
// Module-internal errors for Effect control flow. Not part of the global
// AtlasError union — they're caught at the module boundary and mapped
// to PythonResult failure objects before leaving.

/** Infrastructure error — triggers sandbox invalidation. */
class SandboxInfraError extends Data.TaggedError("SandboxInfraError")<{
  readonly message: string;
}> {}

/** Timeout error — does NOT invalidate (the sandbox itself is healthy; only the execution was slow). */
class SandboxTimeoutError extends Data.TaggedError("SandboxTimeoutError")<{
  readonly message: string;
  readonly timeoutMs: number;
}> {}

// ── Retry schedule ──────────────────────────────────────────────────
// Exponential backoff for transient sandbox creation failures:
// up to 3 retries (4 total attempts) with delays of 100ms, 200ms, 400ms.

const CREATION_RETRY = Schedule.intersect(
  Schedule.exponential(Duration.millis(100)),
  Schedule.recurs(3),
);

/**
 * Create a Python sandbox backend using @vercel/sandbox.
 *
 * The sandbox is created lazily on first exec() call and reused for
 * subsequent calls. If the sandbox errors, the cached promise is discarded
 * (and the old sandbox stopped) so a fresh one is created on the next call.
 */
export function createPythonSandboxBackend(): PythonBackend {
  let sandboxPromise: Promise<SandboxInstance> | null = null;

  interface SandboxInstance {
    sandbox: InstanceType<(typeof import("@vercel/sandbox"))["Sandbox"]>;
    packagesInstalled: boolean;
  }

  /** Build an Effect program that creates and configures a sandbox. */
  function createSandboxEffect(): Effect.Effect<SandboxInstance, SandboxInfraError> {
    return Effect.gen(function* () {
      // 1. Import @vercel/sandbox
      const { Sandbox } = yield* Effect.tryPromise({
        try: () => import("@vercel/sandbox"),
        catch: (err) => {
          const detail = err instanceof Error ? err.message : String(err);
          log.error({ err: detail }, "Failed to import @vercel/sandbox");
          return new SandboxInfraError({
            message: "Vercel Sandbox runtime selected but @vercel/sandbox is not installed.",
          });
        },
      });

      // 2. Create sandbox with retry for transient failures
      const sandbox = yield* Effect.tryPromise({
        try: () =>
          Sandbox.create({ runtime: "python3.13", networkPolicy: "allow-all" }),
        catch: (err) => {
          const detail = sandboxErrorDetail(err);
          log.warn({ err: detail }, "Python Sandbox.create() attempt failed");
          return new SandboxInfraError({
            message: `Failed to create Python Vercel Sandbox: ${safeError(detail)}.`,
          });
        },
      }).pipe(
        Effect.retry(CREATION_RETRY),
        Effect.tapError((err) =>
          Effect.sync(() =>
            log.error({ err: err.message }, "Python Sandbox.create() failed after retries"),
          ),
        ),
      );

      // 3. Install data science packages (non-fatal — catch and continue)
      let packagesInstalled = false;
      yield* Effect.tryPromise({
        try: async () => {
          const result = await sandbox.runCommand({
            cmd: "pip",
            args: ["install", "--quiet", ...DATA_SCIENCE_PACKAGES],
            sudo: true,
          });
          if (result.exitCode === 0) {
            packagesInstalled = true;
            log.info("Python data science packages installed in sandbox");
          } else {
            const stderr = await result.stderr();
            log.warn(
              { exitCode: result.exitCode, stderr: stderr.slice(0, 500) },
              "pip install returned non-zero — some packages may be unavailable",
            );
          }
        },
        catch: (err) => {
          const detail = sandboxErrorDetail(err);
          log.warn({ err: detail }, "pip install failed — continuing without data science packages");
          return err instanceof Error ? err : new Error(String(err));
        },
      }).pipe(
        // intentionally non-fatal: pip failure is logged above, continue without packages
        Effect.catchAll(() => Effect.void),
      );

      // 4. Lock network — stop sandbox on failure via Effect.tapError
      yield* Effect.tryPromise({
        try: () => sandbox.updateNetworkPolicy("deny-all"),
        catch: (err) => {
          const detail = sandboxErrorDetail(err);
          log.error({ err: detail }, "Failed to set deny-all network policy");
          return new SandboxInfraError({
            message: `Failed to lock down sandbox network: ${safeError(detail)}.`,
          });
        },
      }).pipe(
        Effect.tapError(() =>
          Effect.tryPromise({
            try: () => sandbox.stop(),
            catch: (stopErr) =>
              stopErr instanceof Error ? stopErr : new Error(String(stopErr)),
          }).pipe(
            Effect.tapError((stopErr) =>
              Effect.sync(() =>
                log.warn(
                  { err: stopErr.message },
                  "Failed to stop sandbox after network policy error",
                ),
              ),
            ),
            // intentionally ignored: sandbox stop during cleanup is best-effort;
            // the SandboxInfraError from updateNetworkPolicy is the primary error
            Effect.ignore,
          ),
        ),
      );

      return { sandbox, packagesInstalled };
    });
  }

  /** Run the sandbox creation Effect, returning a Promise for caching. */
  function getSandbox(): Promise<SandboxInstance> {
    return Effect.runPromise(createSandboxEffect());
  }

  /** Discard the cached sandbox and stop the old one (fire-and-forget). */
  function invalidate() {
    const old = sandboxPromise;
    sandboxPromise = null;
    if (old) {
      old.then((instance) => instance.sandbox.stop()).catch((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to stop old Python sandbox during cleanup",
        );
      });
    }
  }

  return {
    exec: async (code, data): Promise<PythonResult> => {
      if (!sandboxPromise) {
        sandboxPromise = getSandbox();
      }

      const execId = randomUUID();
      const resultMarker = `__ATLAS_RESULT_${execId}__`;
      const execDir = `exec-${execId}`;
      const chartDir = `${execDir}/charts`;
      const wrapperPath = `${execDir}/wrapper.py`;
      const codePath = `${execDir}/user_code.py`;
      const dataPath = `${execDir}/data.json`;

      const timeout =
        parseInt(
          process.env.ATLAS_PYTHON_TIMEOUT ?? String(DEFAULT_TIMEOUT_MS),
          10,
        ) || DEFAULT_TIMEOUT_MS;

      // Capture the promise reference before entering the Effect program
      // to avoid a race where invalidate() nulls sandboxPromise mid-flight
      const cachedPromise = sandboxPromise;

      const program = Effect.gen(function* () {
        // 1. Resolve cached sandbox
        const instance = yield* Effect.tryPromise({
          try: () => cachedPromise,
          catch: (err) => {
            const detail = err instanceof Error ? err.message : String(err);
            return new SandboxInfraError({
              message: `Sandbox initialization failed: ${safeError(detail)}`,
            });
          },
        });

        const { sandbox } = instance;

        // 2. Create execution directories
        yield* Effect.tryPromise({
          try: async () => {
            await sandbox.mkDir(execDir);
            await sandbox.mkDir(chartDir);
          },
          catch: (err) => {
            const detail = sandboxErrorDetail(err);
            log.error({ err: detail, execId }, "Failed to create exec dirs in sandbox");
            return new SandboxInfraError({
              message: `Sandbox infrastructure error: ${safeError(detail)}`,
            });
          },
        });

        // 3. Write files
        const files: { path: string; content: Buffer }[] = [
          { path: wrapperPath, content: Buffer.from(PYTHON_WRAPPER) },
          { path: codePath, content: Buffer.from(code) },
        ];
        if (data) {
          files.push({ path: dataPath, content: Buffer.from(JSON.stringify(data)) });
        }

        yield* Effect.tryPromise({
          try: () => sandbox.writeFiles(files),
          catch: (err) => {
            const detail = sandboxErrorDetail(err);
            log.error({ err: detail, execId }, "Failed to write Python files to sandbox");
            return new SandboxInfraError({
              message: `Sandbox infrastructure error: ${safeError(detail)}`,
            });
          },
        });

        // 4. Execute Python (with timeout)
        const pythonArgs = [
          `${SANDBOX_BASE}/${wrapperPath}`,
          `${SANDBOX_BASE}/${codePath}`,
        ];
        if (data) {
          pythonArgs.push(`${SANDBOX_BASE}/${dataPath}`);
        }

        const cmdResult = yield* Effect.tryPromise({
          try: () =>
            sandbox.runCommand({
              cmd: "python3",
              args: pythonArgs,
              cwd: `${SANDBOX_BASE}/${execDir}`,
              env: {
                ATLAS_RESULT_MARKER: resultMarker,
                ATLAS_CHART_DIR: `${SANDBOX_BASE}/${chartDir}`,
                MPLBACKEND: "Agg",
                HOME: "/tmp",
                LANG: "C.UTF-8",
              },
            }),
          catch: (err) => {
            const detail = sandboxErrorDetail(err);
            log.error({ err: detail, execId }, "Sandbox runCommand failed for Python");
            return new SandboxInfraError({
              message: `Sandbox infrastructure error: ${safeError(detail)}. Will retry with a fresh sandbox.`,
            });
          },
        }).pipe(
          Effect.timeout(Duration.millis(timeout)),
          Effect.catchTag("TimeoutException", () => {
            log.warn({ execId, timeout }, "Python sandbox execution timed out");
            return Effect.fail(
              new SandboxTimeoutError({
                message: `Python execution timed out after ${timeout}ms`,
                timeoutMs: timeout,
              }),
            );
          }),
        );

        // 5. Read stdout/stderr
        const [stdout, stderr] = yield* Effect.tryPromise({
          try: () => Promise.all([cmdResult.stdout(), cmdResult.stderr()]),
          catch: (err) => {
            const detail = sandboxErrorDetail(err);
            log.error({ err: detail, execId }, "Failed to read stdout/stderr from sandbox");
            return new SandboxInfraError({
              message: `Failed to read execution output: ${safeError(detail)}`,
            });
          },
        });

        // 6. Output size guard (matches nsjail's 1 MB limit)
        if (stdout.length > MAX_OUTPUT) {
          return {
            success: false as const,
            error: "Python output exceeded 1 MB limit — reduce print() output or use _atlas_table for large results.",
          };
        }

        log.debug(
          { execId, exitCode: cmdResult.exitCode, stdoutLen: stdout.length },
          "python sandbox execution finished",
        );

        // 7. Extract structured result from the last marker line
        const lines = stdout.split("\n");
        const resultLine = lines.findLast((l) => l.startsWith(resultMarker));

        if (resultLine) {
          try {
            return JSON.parse(resultLine.slice(resultMarker.length)) as PythonResult;
          } catch (parseErr) {
            log.warn(
              { execId, resultLine: resultLine.slice(0, 500), parseError: String(parseErr) },
              "failed to parse Python result JSON",
            );
            const userOutput = stdout.split(resultMarker)[0].trim();
            return {
              success: false as const,
              error: `Python produced unparseable output.${userOutput ? ` Output: ${userOutput.slice(0, 500)}` : ""} stderr: ${stderr.trim().slice(0, 500)}`,
            };
          }
        }

        // 8. No structured result — process errored before the wrapper could emit one
        if (cmdResult.exitCode > 128) {
          const signal = cmdResult.exitCode - 128;
          const signalNames: Record<number, string> = {
            6: "SIGABRT",
            9: "SIGKILL",
            11: "SIGSEGV",
            15: "SIGTERM",
          };
          const name = signalNames[signal] ?? `signal ${signal}`;
          if (signal === 9) {
            return {
              success: false as const,
              error: "Python execution killed (likely exceeded time or memory limit)",
            };
          }
          return {
            success: false as const,
            error: `Python process terminated by ${name}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
          };
        }

        return {
          success: false as const,
          error: stderr.trim() || `Python execution failed (exit code ${cmdResult.exitCode})`,
        };
      });

      return Effect.runPromise(
        program.pipe(
          // Infrastructure errors: invalidate sandbox, return error result
          Effect.catchTag("SandboxInfraError", (err) =>
            Effect.sync(() => {
              invalidate();
              return { success: false as const, error: err.message };
            }),
          ),
          // Timeout errors: don't invalidate (sandbox is healthy, only the execution was slow)
          Effect.catchTag("SandboxTimeoutError", (err) =>
            Effect.succeed({ success: false as const, error: err.message }),
          ),
          // Unexpected defects: invalidate and return sanitized error
          Effect.catchAllDefect((defect) => {
            const detail = defect instanceof Error ? defect.message : String(defect);
            log.error({ err: detail, execId }, "Unexpected error in Python sandbox execution");
            invalidate();
            return Effect.succeed({
              success: false as const,
              error: `Unexpected Python sandbox error (${safeError(detail)}). Will retry with a fresh sandbox.`,
            });
          }),
        ),
      );
    },
  };
}
