/**
 * Vercel Sandbox backend for the Python execution tool.
 *
 * Uses @vercel/sandbox with runtime: "python3.13" to run Python code
 * in an ephemeral Firecracker microVM. Mirrors the pattern in
 * explore-sandbox.ts but adapted for Python execution:
 * - Creates a Python 3.13 sandbox with deny-all network policy
 * - Installs data science packages (pandas, numpy, matplotlib, etc.)
 * - Writes wrapper + user code to the sandbox filesystem
 * - Injects data via a JSON file (stdin not supported by runCommand)
 * - Collects charts and structured output via result marker
 *
 * Only loaded when ATLAS_RUNTIME=vercel or running on the Vercel platform.
 */

import type { PythonBackend, PythonResult } from "./python";
import { randomUUID } from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";

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
 * Python wrapper script — same logic as sidecar/nsjail PYTHON_WRAPPER.
 *
 * Reads user code from argv[1], data from a JSON file (argv[2] if present),
 * runs in an isolated namespace, collects charts + structured output.
 */
const PYTHON_WRAPPER = `
import sys, json, io, base64, glob, os, ast

_marker = os.environ["ATLAS_RESULT_MARKER"]
_chart_dir = os.environ.get("ATLAS_CHART_DIR", "/tmp/charts")

# --- Import guard ---
_BLOCKED_MODULES = {
    "subprocess", "os", "socket", "shutil", "sys", "ctypes", "importlib",
    "code", "signal", "multiprocessing", "threading", "pty", "fcntl",
    "termios", "resource", "posixpath",
    "http", "urllib", "requests", "httpx", "aiohttp", "webbrowser",
    "pickle", "tempfile", "pathlib",
}
_BLOCKED_BUILTINS = {
    "compile", "exec", "eval", "__import__", "open", "breakpoint",
    "getattr", "globals", "locals", "vars", "dir", "delattr", "setattr",
}

_user_code = open(sys.argv[1]).read()
try:
    _tree = ast.parse(_user_code)
except SyntaxError as e:
    print(_marker + json.dumps({"success": False, "error": f"SyntaxError: {e.msg} (line {e.lineno})"}))
    sys.exit(0)

_blocked = None
for _node in ast.walk(_tree):
    if _blocked:
        break
    if isinstance(_node, ast.Import):
        for _alias in _node.names:
            _mod = _alias.name.split('.')[0]
            if _mod in _BLOCKED_MODULES:
                _blocked = f'Blocked import: "{_mod}" is not allowed'
                break
    elif isinstance(_node, ast.ImportFrom):
        if _node.module:
            _mod = _node.module.split('.')[0]
            if _mod in _BLOCKED_MODULES:
                _blocked = f'Blocked import: "{_mod}" is not allowed'
    elif isinstance(_node, ast.Call):
        _name = None
        if isinstance(_node.func, ast.Name):
            _name = _node.func.id
        elif isinstance(_node.func, ast.Attribute):
            _name = _node.func.attr
        if _name and _name in _BLOCKED_BUILTINS:
            _blocked = f'Blocked builtin: "{_name}()" is not allowed'

if _blocked:
    print(_marker + json.dumps({"success": False, "error": _blocked}))
    sys.exit(0)

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

# Configure matplotlib for headless rendering
try:
    import matplotlib
    matplotlib.use('Agg')
except ImportError:
    pass

os.makedirs(_chart_dir, exist_ok=True)

def chart_path(n=0):
    return os.path.join(_chart_dir, f"chart_{n}.png")

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

# --- Collect results ---
_charts = []
for f in sorted(glob.glob(os.path.join(_chart_dir, "chart_*.png"))):
    with open(f, "rb") as fh:
        _charts.append({"base64": base64.b64encode(fh.read()).decode(), "mimeType": "image/png"})

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

if _charts:
    _result["charts"] = _charts

print(_marker + json.dumps(_result), file=_old_stdout)
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
 * subsequent calls. If the sandbox errors, it is torn down and a fresh
 * one is created on the next call.
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
      sandbox = await Sandbox.create({
        runtime: "python3.13",
        networkPolicy: "deny-all",
      });
    } catch (err) {
      const detail = sandboxErrorDetail(err);
      log.error({ err: detail }, "Python Sandbox.create() failed");
      throw new Error(
        `Failed to create Python Vercel Sandbox: ${safeError(detail)}.`,
        { cause: err },
      );
    }

    // Install data science packages
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

    return { sandbox, packagesInstalled };
  }

  function invalidate() {
    sandboxPromise = null;
  }

  return {
    exec: async (code, data): Promise<PythonResult> => {
      // Lazy-init the sandbox
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

        // Execute
        const timeout = parseInt(
          process.env.ATLAS_PYTHON_TIMEOUT ?? String(DEFAULT_TIMEOUT_MS),
          10,
        ) || DEFAULT_TIMEOUT_MS;

        let result;
        try {
          result = await sandbox.runCommand({
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
        } catch (err) {
          const detail = sandboxErrorDetail(err);
          log.error({ err: detail, execId }, "Sandbox runCommand failed for Python");
          invalidate();
          return {
            success: false,
            error: `Sandbox infrastructure error: ${safeError(detail)}. Will retry with a fresh sandbox.`,
          };
        }

        const [stdout, stderr] = await Promise.all([
          result.stdout(),
          result.stderr(),
        ]);

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
          } catch {
            log.warn(
              { execId, resultLine: resultLine.slice(0, 500) },
              "failed to parse Python result JSON",
            );
            return {
              success: false,
              error: `Python produced unparseable output. stderr: ${stderr.trim().slice(0, 500)}`,
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
