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
 * - Reads the structured result + chart PNGs back off the sandbox FS via the
 *   v2 sandbox.fs API (readFileToBuffer / readdir), not a stdout result marker
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
import type { SandboxNetworkPolicy } from "./backends/network-allowlist";
import type { VercelSandboxAccessOverride } from "./explore-sandbox";
import { PYTHON_SECURITY_AND_SETUP } from "./python-wrapper";
import { sandboxErrorDetail, safeError, MAX_OUTPUT } from "./backends/shared";
import { vercelSandboxAccess } from "./backends/detect";
import { randomUUID } from "crypto";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("python-sandbox");

/**
 * Per-request configuration for the Vercel Python sandbox. Derived server-side
 * from the request's resolved REST datasource (see `python.ts`); none of it
 * comes from the agent's `code`. Absent fields preserve the pre-#2927
 * behavior: `deny-all` network.
 */
export interface PythonSandboxOptions {
  /**
   * Network policy to lock down to AFTER the package-install step (which needs
   * `allow-all`). Defaults to `"deny-all"` — the safe baseline for SQL-only
   * (non-REST) workloads. For a REST datasource this is the per-tenant host
   * allowlist from {@link networkPolicyFromAllowlist} (layer 0, #2927): egress
   * is bounded to the datasource host(s), with NO credential injected (the
   * authenticated read path stays the host-side `executeRestOperation` tool).
   */
  readonly networkPolicy?: SandboxNetworkPolicy;
  /**
   * Explicit Vercel API credentials for sandbox creation — the BYOC per-org
   * path (#3410). When provided they replace the operator-level env-var
   * detection entirely (never merged with it, per the #2850 seam), mirroring
   * explore-sandbox.ts's `accessOverride`. The token is RedactedSecret-
   * branded: revealed only at `Sandbox.create`, serializes to "[REDACTED]".
   */
  readonly access?: VercelSandboxAccessOverride;
  /**
   * Applied to provider error text before it is logged or embedded in error
   * messages. The BYOC path supplies an exact-match scrub of the org's
   * stored credential values: a provider error that echoes the rejected key
   * (e.g. a 401 on `Sandbox.create`) must not land in operator logs — this
   * module logs before the BYOC result wrapper ever sees the error (#3413).
   * Defaults to identity (the operator path logs its own provider's errors).
   */
  readonly scrubErrorDetail?: (detail: string) => string;
}

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
 * Non-streaming Python wrapper for Vercel Sandbox. Composes the shared security
 * fragment (PYTHON_SECURITY_AND_SETUP) with file-based data injection (argv[2],
 * since runCommand does not support stdin piping).
 *
 * Result transport diverges from the shared PYTHON_EXEC_AND_COLLECT fragment
 * (used by the nsjail/sidecar backends): instead of smuggling the structured
 * result back through a `__ATLAS_RESULT_<id>__` stdout marker, this wrapper
 * writes the result JSON to ATLAS_RESULT_FILE and leaves chart PNGs as files in
 * _chart_dir. The host reads both off the sandbox FS via the v2 sandbox.fs API
 * (readdir + readFileToBuffer). Charts are NOT base64-embedded here — they are
 * read as raw artifacts host-side.
 */
const PYTHON_WRAPPER = `
import sys, json, io, os, ast

_chart_dir = os.environ.get("ATLAS_CHART_DIR", "/tmp/charts")
_result_file = os.environ["ATLAS_RESULT_FILE"]

def _report_error(msg):
    with open(_result_file, "w") as _rf:
        _rf.write(json.dumps({"success": False, "error": msg}))
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

# --- Execute user code in isolated namespace ---
_old_stdout = sys.stdout
sys.stdout = _captured = io.StringIO()

_user_ns = {"chart_path": chart_path, "data": data, "df": df}
_atlas_error = None
try:
    exec(_user_code, _user_ns)
except Exception as e:
    _atlas_error = f"{type(e).__name__}: {e}"

_output = _captured.getvalue()
sys.stdout = _old_stdout

# --- Build structured result (charts stay as PNG files, read host-side) ---
_result = {"success": _atlas_error is None}
if _output.strip():
    _result["output"] = _output.strip()
if _atlas_error:
    _result["error"] = _atlas_error

if "_atlas_table" in _user_ns:
    _result["table"] = _user_ns["_atlas_table"]

if "_atlas_chart" in _user_ns:
    _ac = _user_ns["_atlas_chart"]
    if isinstance(_ac, dict):
        _result["rechartsCharts"] = [_ac]
    elif isinstance(_ac, list):
        _result["rechartsCharts"] = _ac

with open(_result_file, "w") as _rf:
    _rf.write(json.dumps(_result))
`;

// Sandbox base dir for relative paths
const SANDBOX_BASE = "/vercel/sandbox";

/** Shared 1 MB output-guard message (matches nsjail's MAX_OUTPUT rejection). */
const OUTPUT_TOO_LARGE_ERROR =
  "Python output exceeded 1 MB limit — reduce print() output or use _atlas_table for large results.";

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
export function createPythonSandboxBackend(
  options: PythonSandboxOptions = {},
): PythonBackend {
  let sandboxPromise: Promise<SandboxInstance> | null = null;

  // The network policy this per-request backend locks down to. Captured here
  // (not read from any shared/global state) so the egress allowlist is scoped
  // to exactly the request that created this backend — tenant A's backend can
  // never carry tenant B's host (#2927, layer 0).
  const lockdownPolicy: SandboxNetworkPolicy = options.networkPolicy ?? "deny-all";

  // Per-org BYOC access override (#3410), captured for the same per-request
  // scoping reason: this backend can only ever create sandboxes on the
  // account whose credentials it was constructed with.
  const accessOverride = options.access;

  // Provider error text passes through this before any log or message —
  // see PythonSandboxOptions.scrubErrorDetail (#3413).
  const scrubDetail = options.scrubErrorDetail ?? ((detail: string) => detail);

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

      // 2. Create sandbox with retry for transient failures. A BYOC access
      // override (per-org credentials, #3410) takes precedence and is used
      // verbatim. Otherwise: off-Vercel (e.g. Railway) requires explicit
      // VERCEL_TEAM_ID/VERCEL_PROJECT_ID/VERCEL_TOKEN; on Vercel proper,
      // OIDC handles auth and `access` is undefined.
      const access = accessOverride ?? vercelSandboxAccess();
      const explicitAccess = access
        ? {
            teamId: access.teamId,
            projectId: access.projectId,
            token: access.token.reveal(),
          }
        : undefined;
      const sandbox = yield* Effect.tryPromise({
        try: () =>
          Sandbox.create({
            runtime: "python3.13",
            networkPolicy: "allow-all",
            // v2 persists (snapshots) by default — force ephemeral so
            // per-request code/data/chart files never land in Vercel
            // snapshot storage after the sandbox is stopped.
            persistent: false,
            ...(explicitAccess ?? {}),
          }),
        catch: (err) => {
          const detail = scrubDetail(sandboxErrorDetail(err));
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
          const detail = scrubDetail(sandboxErrorDetail(err));
          log.warn({ err: detail }, "pip install failed — continuing without data science packages");
          return err instanceof Error ? err : new Error(String(err));
        },
      }).pipe(
        // intentionally non-fatal: pip failure is logged above, continue without packages
        Effect.catchAll(() => Effect.void),
      );

      // 4. Lock network — narrow from the install-time allow-all to the
      // per-request policy (deny-all by default; the REST datasource host
      // allowlist when a datasource is active — #2927 layer 0). Stop sandbox on
      // failure via Effect.tapError. The policy carries no credential (egress is
      // opened, auth is not — see network-allowlist.ts), and the log emits only
      // the non-secret shape (mode + host count).
      yield* Effect.tryPromise({
        try: () => sandbox.updateNetworkPolicy(lockdownPolicy),
        catch: (err) => {
          const detail = scrubDetail(sandboxErrorDetail(err));
          log.error({ err: detail }, "Failed to set sandbox network policy");
          return new SandboxInfraError({
            message: `Failed to lock down sandbox network: ${safeError(detail)}.`,
          });
        },
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            log.info(
              {
                mode: typeof lockdownPolicy === "string" ? lockdownPolicy : "allowlist",
                allowedHosts:
                  typeof lockdownPolicy === "string"
                    ? 0
                    : Object.keys(lockdownPolicy.allow ?? {}).length,
              },
              "Python sandbox network policy locked down",
            ),
          ),
        ),
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
      const execDir = `exec-${execId}`;
      const chartDir = `${execDir}/charts`;
      const wrapperPath = `${execDir}/wrapper.py`;
      const codePath = `${execDir}/user_code.py`;
      const dataPath = `${execDir}/data.json`;
      const resultPath = `${execDir}/result.json`;
      const chartDirAbs = `${SANDBOX_BASE}/${chartDir}`;
      const resultPathAbs = `${SANDBOX_BASE}/${resultPath}`;

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
            const detail = scrubDetail(sandboxErrorDetail(err));
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
            const detail = scrubDetail(sandboxErrorDetail(err));
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
                ATLAS_RESULT_FILE: resultPathAbs,
                ATLAS_CHART_DIR: chartDirAbs,
                MPLBACKEND: "Agg",
                HOME: "/tmp",
                LANG: "C.UTF-8",
              },
            }),
          catch: (err) => {
            const detail = scrubDetail(sandboxErrorDetail(err));
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

        // 5. Read stderr — used only when the wrapper produced no result file
        // (the process crashed / was signalled before it could write one).
        const stderr = yield* Effect.tryPromise({
          try: () => cmdResult.stderr(),
          catch: (err) => {
            const detail = scrubDetail(sandboxErrorDetail(err));
            log.error({ err: detail, execId }, "Failed to read stderr from sandbox");
            return new SandboxInfraError({
              message: `Failed to read execution output: ${safeError(detail)}`,
            });
          },
        });

        // 6. Read the structured result the wrapper wrote to the sandbox FS
        // (v2 readFileToBuffer) — replaces the stdout result-marker parse.
        const resultBuffer = yield* Effect.tryPromise({
          try: () => sandbox.readFileToBuffer({ path: resultPathAbs }),
          catch: (err) => {
            const detail = scrubDetail(sandboxErrorDetail(err));
            log.error({ err: detail, execId }, "Failed to read result file from sandbox");
            return new SandboxInfraError({
              message: `Failed to read execution output: ${safeError(detail)}`,
            });
          },
        });

        if (resultBuffer) {
          // 7. Output size guard (matches nsjail's 1 MB limit). Bound the
          // structured-result buffer first, then result + charts combined
          // (step 8) so the total payload returned to the agent stays bounded —
          // the same cap the stdout marker enforced before #3126.
          if (resultBuffer.length > MAX_OUTPUT) {
            return { success: false as const, error: OUTPUT_TOO_LARGE_ERROR };
          }

          let parsed: PythonResult;
          try {
            parsed = JSON.parse(resultBuffer.toString()) as PythonResult;
          } catch (parseErr) {
            log.warn(
              { execId, parseError: String(parseErr) },
              "failed to parse Python result JSON",
            );
            return {
              success: false as const,
              error: `Python produced unparseable output.${stderr.trim() ? ` stderr: ${stderr.trim().slice(0, 500)}` : ""}`,
            };
          }

          // 8. Collect chart artifacts directly off the sandbox FS (readdir +
          // readFileToBuffer), base64-encoding host-side. The wrapper leaves
          // chart PNGs as files rather than embedding them in the result.
          const chartBuffers = yield* Effect.tryPromise({
            try: async () => {
              const names = await sandbox.fs.readdir(chartDirAbs);
              const pngs = names.filter((n) => /^chart_.*\.png$/.test(n)).sort();
              // Reads are independent — fan out rather than awaiting serially.
              const bufs = await Promise.all(
                pngs.map((name) =>
                  sandbox.readFileToBuffer({ path: `${chartDirAbs}/${name}` }),
                ),
              );
              return bufs.filter((buf): buf is Buffer => buf !== null);
            },
            catch: (err) => {
              const detail = scrubDetail(sandboxErrorDetail(err));
              log.error({ err: detail, execId }, "Failed to read chart artifacts from sandbox");
              return new SandboxInfraError({
                message: `Failed to read chart artifacts: ${safeError(detail)}`,
              });
            },
          });

          const chartsB64 = chartBuffers.map((b) => b.toString("base64"));
          const totalBytes =
            resultBuffer.length + chartsB64.reduce((n, s) => n + s.length, 0);
          if (totalBytes > MAX_OUTPUT) {
            return { success: false as const, error: OUTPUT_TOO_LARGE_ERROR };
          }

          log.debug(
            {
              execId,
              exitCode: cmdResult.exitCode,
              resultLen: resultBuffer.length,
              charts: chartsB64.length,
            },
            "python sandbox execution finished",
          );

          if (parsed.success && chartsB64.length > 0) {
            parsed.charts = chartsB64.map((b64) => ({
              base64: b64,
              mimeType: "image/png" as const,
            }));
          }
          return parsed;
        }

        // 9. No result file — the process crashed / was signalled before the
        // wrapper could write one.
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
            const detail = scrubDetail(defect instanceof Error ? defect.message : String(defect));
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
