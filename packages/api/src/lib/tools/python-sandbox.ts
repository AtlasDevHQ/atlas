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
 */

import type { PythonBackend, PythonResult } from "./python";
import { PYTHON_SECURITY_AND_SETUP, PYTHON_EXEC_AND_COLLECT } from "./python-wrapper";
import { randomUUID } from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";

const log = createLogger("python-sandbox");

/** Default Python execution timeout in ms. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum bytes to read from stdout/stderr (1 MB). */
const MAX_OUTPUT = 1024 * 1024;

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

/** Format an error for logging, with extra detail from @vercel/sandbox APIError. */
function sandboxErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const detail = err.message;
  const json = (err as unknown as Record<string, unknown>).json;
  const text = (err as unknown as Record<string, unknown>).text;
  if (json) {
    try {
      return `${detail} — response: ${JSON.stringify(json)}`;
    } catch {
      return `${detail} — response: [unserializable object]`;
    }
  }
  if (typeof text === "string" && text) return `${detail} — body: ${text.slice(0, 500)}`;
  return detail;
}

/** Scrub sensitive data from error messages before exposing. */
function safeError(detail: string): string {
  return SENSITIVE_PATTERNS.test(detail)
    ? "sandbox API error (details in server logs)"
    : detail;
}

// Sandbox base dir for relative paths
const SANDBOX_BASE = "/vercel/sandbox";

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

  async function getSandbox(): Promise<SandboxInstance> {
    let Sandbox: (typeof import("@vercel/sandbox"))["Sandbox"];
    try {
      ({ Sandbox } = await import("@vercel/sandbox"));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error({ err: detail }, "Failed to import @vercel/sandbox");
      throw new Error(
        "Vercel Sandbox runtime selected but @vercel/sandbox is not installed.",
        { cause: err },
      );
    }

    let sandbox: InstanceType<typeof Sandbox>;
    try {
      // Start with allow-all so pip can reach pypi.org during setup
      sandbox = await Sandbox.create({
        runtime: "python3.13",
        networkPolicy: "allow-all",
      });
    } catch (err) {
      const detail = sandboxErrorDetail(err);
      log.error({ err: detail }, "Python Sandbox.create() failed");
      throw new Error(
        `Failed to create Python Vercel Sandbox: ${safeError(detail)}.`,
        { cause: err },
      );
    }

    // Install data science packages (requires network access)
    let packagesInstalled = false;
    try {
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
    } catch (err) {
      const detail = sandboxErrorDetail(err);
      log.warn({ err: detail }, "pip install failed — continuing without data science packages");
    }

    // Lock down network before running any user code
    try {
      await sandbox.updateNetworkPolicy("deny-all");
    } catch (err) {
      const detail = sandboxErrorDetail(err);
      log.error({ err: detail }, "Failed to set deny-all network policy");
      try { await sandbox.stop(); } catch (stopErr) { log.warn({ err: stopErr instanceof Error ? stopErr.message : String(stopErr) }, "Failed to stop sandbox after network policy error"); }
      throw new Error(
        `Failed to lock down sandbox network: ${safeError(detail)}.`,
        { cause: err },
      );
    }

    return { sandbox, packagesInstalled };
  }

  function invalidate() {
    const old = sandboxPromise;
    sandboxPromise = null;
    if (old) {
      old.then(instance => instance.sandbox.stop()).catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to stop old Python sandbox during cleanup");
      });
    }
  }

  return {
    exec: async (code, data): Promise<PythonResult> => {
      if (!sandboxPromise) {
        sandboxPromise = getSandbox();
      }

      let instance: SandboxInstance;
      try {
        instance = await sandboxPromise;
      } catch (err) {
        invalidate();
        const detail = err instanceof Error ? err.message : String(err);
        return { success: false, error: detail };
      }

      const { sandbox } = instance;
      const execId = randomUUID();
      const resultMarker = `__ATLAS_RESULT_${execId}__`;
      const execDir = `exec-${execId}`;
      const chartDir = `${execDir}/charts`;
      const wrapperPath = `${execDir}/wrapper.py`;
      const codePath = `${execDir}/user_code.py`;
      const dataPath = `${execDir}/data.json`;

      try {
        // Create directories
        try {
          await sandbox.mkDir(execDir);
          await sandbox.mkDir(chartDir);
        } catch (err) {
          const detail = sandboxErrorDetail(err);
          log.error({ err: detail, execId }, "Failed to create exec dirs in sandbox");
          invalidate();
          return { success: false, error: `Sandbox infrastructure error: ${safeError(detail)}` };
        }

        // Write files
        const files: { path: string; content: Buffer }[] = [
          { path: wrapperPath, content: Buffer.from(PYTHON_WRAPPER) },
          { path: codePath, content: Buffer.from(code) },
        ];
        if (data) {
          files.push({ path: dataPath, content: Buffer.from(JSON.stringify(data)) });
        }

        try {
          await sandbox.writeFiles(files);
        } catch (err) {
          const detail = sandboxErrorDetail(err);
          log.error({ err: detail, execId }, "Failed to write Python files to sandbox");
          invalidate();
          return { success: false, error: `Sandbox infrastructure error: ${safeError(detail)}` };
        }

        // Build command args
        const pythonArgs = [
          `${SANDBOX_BASE}/${wrapperPath}`,
          `${SANDBOX_BASE}/${codePath}`,
        ];
        if (data) {
          pythonArgs.push(`${SANDBOX_BASE}/${dataPath}`);
        }

        // Execute with timeout enforcement
        const timeout = parseInt(
          process.env.ATLAS_PYTHON_TIMEOUT ?? String(DEFAULT_TIMEOUT_MS),
          10,
        ) || DEFAULT_TIMEOUT_MS;

        let result;
        try {
          const commandPromise = sandbox.runCommand({
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
          });
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Python execution timed out after ${timeout}ms`)), timeout),
          );
          result = await Promise.race([commandPromise, timeoutPromise]);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          if (detail.includes("timed out")) {
            log.warn({ execId, timeout }, "Python sandbox execution timed out");
            return { success: false, error: detail };
          }
          const fullDetail = sandboxErrorDetail(err);
          log.error({ err: fullDetail, execId }, "Sandbox runCommand failed for Python");
          invalidate();
          return {
            success: false,
            error: `Sandbox infrastructure error: ${safeError(fullDetail)}. Will retry with a fresh sandbox.`,
          };
        }

        let stdout: string;
        let stderr: string;
        try {
          [stdout, stderr] = await Promise.all([
            result.stdout(),
            result.stderr(),
          ]);
        } catch (err) {
          const detail = sandboxErrorDetail(err);
          log.error({ err: detail, execId }, "Failed to read stdout/stderr from sandbox");
          invalidate();
          return { success: false, error: `Failed to read execution output: ${safeError(detail)}` };
        }

        // Output size guard (matches nsjail's 1 MB limit)
        if (stdout.length > MAX_OUTPUT) {
          return {
            success: false,
            error: "Python output exceeded 1 MB limit — reduce print() output or use _atlas_table for large results.",
          };
        }

        log.debug(
          { execId, exitCode: result.exitCode, stdoutLen: stdout.length },
          "python sandbox execution finished",
        );

        // Extract structured result from the last marker line
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
              success: false,
              error: `Python produced unparseable output.${userOutput ? ` Output: ${userOutput.slice(0, 500)}` : ""} stderr: ${stderr.trim().slice(0, 500)}`,
            };
          }
        }

        // No structured result — process errored before the wrapper could emit one
        if (result.exitCode > 128) {
          const signal = result.exitCode - 128;
          const signalNames: Record<number, string> = {
            6: "SIGABRT", 9: "SIGKILL", 11: "SIGSEGV", 15: "SIGTERM",
          };
          const name = signalNames[signal] ?? `signal ${signal}`;
          if (signal === 9) {
            return { success: false, error: "Python execution killed (likely exceeded time or memory limit)" };
          }
          return {
            success: false,
            error: `Python process terminated by ${name}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
          };
        }

        return {
          success: false,
          error: stderr.trim() || `Python execution failed (exit code ${result.exitCode})`,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log.error({ err: detail, execId }, "Unexpected error in Python sandbox execution");
        invalidate();
        return { success: false, error: detail };
      }
    },
  };
}
