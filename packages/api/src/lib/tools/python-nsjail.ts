/**
 * nsjail backend for the Python execution tool.
 *
 * Uses nsjail (Linux namespaces) to run Python code in a sandboxed process.
 * Follows the same pattern as explore-nsjail.ts but with Python-specific
 * configuration: bind-mounted Python runtime, data injection via stdin,
 * chart collection from tmpfs, and higher resource limits.
 *
 * Security: no network (nsjail default), no host secrets, runs as nobody
 * (65534:65534), code + data injected via tmpfs files and stdin.
 */

import type { PythonBackend, PythonResult } from "./python";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("python-nsjail");

/** Maximum bytes to read from stdout/stderr (1 MB). */
const MAX_OUTPUT = 1024 * 1024;

/** Default Python execution timeout in seconds. */
const DEFAULT_TIME_LIMIT = 30;

/** Default memory limit in MB. */
const DEFAULT_MEMORY_LIMIT = 512;

/** Default max processes. */
const DEFAULT_NPROC = 16;

/**
 * Python wrapper script — same logic as the sidecar's PYTHON_WRAPPER.
 *
 * Handles: import guard (sidecar-side enforcement), data injection
 * (JSON on stdin → DataFrame/dict), stdout capture, chart collection
 * (PNG files + Recharts dicts), and structured output via result marker.
 */
const PYTHON_WRAPPER = `
import sys, json, io, base64, glob, os, ast

_marker = os.environ["ATLAS_RESULT_MARKER"]
_chart_dir = os.environ.get("ATLAS_CHART_DIR", "/tmp")

# --- Import guard (sidecar-side enforcement) ---
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

# --- Data injection ---
_stdin_data = sys.stdin.read()
_atlas_data = None
if _stdin_data.strip():
    _atlas_data = json.loads(_stdin_data)

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

/** Read up to `max` bytes from a stream. */
async function readLimited(stream: ReadableStream, max: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        chunks.push(value.slice(0, max - (total - value.byteLength)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Parse a positive integer from an env var, returning defaultValue on invalid input. */
function parsePositiveInt(envVar: string, defaultValue: number, name: string): number {
  const raw = process.env[envVar];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    log.warn({ envVar, raw, default: defaultValue }, `Invalid ${envVar} for ${name}, using default`);
    return defaultValue;
  }
  return parsed;
}

/** Build nsjail args for Python execution. */
export function buildPythonNsjailArgs(
  nsjailPath: string,
  tmpDir: string,
  codeFile: string,
  wrapperFile: string,
  chartDir: string,
  resultMarker: string,
): string[] {
  const timeLimit = parsePositiveInt("ATLAS_NSJAIL_TIME_LIMIT", DEFAULT_TIME_LIMIT, "time limit");
  const memoryLimit = parsePositiveInt("ATLAS_NSJAIL_MEMORY_LIMIT", DEFAULT_MEMORY_LIMIT, "memory limit");
  const nproc = DEFAULT_NPROC;

  return [
    nsjailPath,
    "--mode", "o",

    // Read-only bind mounts: system libs + Python runtime
    "-R", "/bin",
    "-R", "/usr/bin",
    "-R", "/usr/local/bin",
    "-R", "/lib",
    "-R", "/lib64",
    "-R", "/usr/lib",
    "-R", "/usr/local/lib",

    // Minimal /dev
    "-R", "/dev/null",
    "-R", "/dev/zero",
    "-R", "/dev/urandom",

    // /proc for correct namespace operation
    "--proc_path", "/proc",

    // Writable tmpfs for scratch
    "-T", "/tmp",

    // Bind-mount code files and chart dir into the jail (read-write for charts)
    "-R", `${wrapperFile}:/tmp/wrapper.py`,
    "-R", `${codeFile}:/tmp/user_code.py`,
    "-B", `${chartDir}:/tmp/charts`,

    // Working directory
    "--cwd", "/tmp",

    // Time limit
    "-t", String(timeLimit),

    // Resource limits (higher than explore for data science workloads)
    "--rlimit_as", String(memoryLimit),
    "--rlimit_fsize", "50",  // 50 MB for chart output
    "--rlimit_nproc", String(nproc),
    "--rlimit_nofile", "128",

    // Run as nobody
    "-u", "65534",
    "-g", "65534",

    // Pass stdin through
    "--pass_fd", "0",

    // Suppress nsjail info logs
    "--quiet",

    // Command: python3 wrapper.py user_code.py
    "--",
    "/usr/bin/python3", "/tmp/wrapper.py", "/tmp/user_code.py",
  ];
}

/** Minimal env for the Python jail — no secrets. */
function buildJailEnv(resultMarker: string): Record<string, string> {
  return {
    PATH: "/bin:/usr/bin:/usr/local/bin",
    HOME: "/tmp",
    LANG: "C.UTF-8",
    MPLBACKEND: "Agg",
    ATLAS_CHART_DIR: "/tmp/charts",
    ATLAS_RESULT_MARKER: resultMarker,
  };
}

/** Create a PythonBackend that executes code via nsjail. */
export function createPythonNsjailBackend(nsjailPath: string): PythonBackend {
  return {
    exec: async (code, data): Promise<PythonResult> => {
      const execId = randomUUID();
      const resultMarker = `__ATLAS_RESULT_${execId}__`;
      const tmpDir = join("/tmp", `pyexec-${execId}`);
      const codeFile = join(tmpDir, "user_code.py");
      const wrapperFile = join(tmpDir, "wrapper.py");
      const chartDir = join(tmpDir, "charts");

      log.debug({ execId, codeLen: code.length }, "python nsjail execution starting");

      try {
        // Prepare tmpfs files
        try {
          mkdirSync(chartDir, { recursive: true });
          writeFileSync(codeFile, code);
          writeFileSync(wrapperFile, PYTHON_WRAPPER);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log.error({ err: detail, tmpDir, execId }, "Failed to prepare Python execution files");
          return { success: false, error: `Infrastructure error preparing Python sandbox: ${detail}` };
        }

        const args = buildPythonNsjailArgs(nsjailPath, tmpDir, codeFile, wrapperFile, chartDir, resultMarker);
        const env = buildJailEnv(resultMarker);
        const stdinPayload = data ? JSON.stringify(data) : "";

        let proc;
        try {
          proc = Bun.spawn(args, {
            env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log.error({ err: detail, execId }, "nsjail spawn failed for Python execution");
          return { success: false, error: `nsjail infrastructure error: ${detail}` };
        }

        // Write data to stdin
        try {
          proc.stdin.write(stdinPayload);
          proc.stdin.end();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log.warn({ err: detail, execId }, "stdin write error during Python execution");
          if (data) {
            proc.kill();
            return { success: false, error: `Failed to inject data into Python sandbox: ${detail}` };
          }
        }

        const [stdout, stderr] = await Promise.all([
          readLimited(proc.stdout, MAX_OUTPUT),
          readLimited(proc.stderr, MAX_OUTPUT),
        ]);
        const exitCode = await proc.exited;

        log.debug({ execId, exitCode, stdoutLen: stdout.length }, "python nsjail execution finished");

        // Extract structured result from the last marker line
        const lines = stdout.split("\n");
        const resultLine = lines.findLast((l) => l.startsWith(resultMarker));

        if (resultLine) {
          try {
            return JSON.parse(resultLine.slice(resultMarker.length)) as PythonResult;
          } catch {
            log.warn({ execId, resultLine: resultLine.slice(0, 500) }, "failed to parse Python result JSON");
            return {
              success: false,
              error: `Python produced unparseable output. stderr: ${stderr.trim().slice(0, 500)}`,
            };
          }
        }

        // No structured result — process errored before the wrapper could emit one
        if (stdout.length >= MAX_OUTPUT) {
          return {
            success: false,
            error: "Python output exceeded 1 MB limit — the result was likely truncated. " +
              "Reduce print() output or use _atlas_table for large results.",
          };
        }

        if (exitCode > 128) {
          const signal = exitCode - 128;
          const signalNames: Record<number, string> = { 6: "SIGABRT", 9: "SIGKILL", 11: "SIGSEGV", 15: "SIGTERM" };
          const name = signalNames[signal] ?? `signal ${signal}`;
          log.warn({ execId, signal, name }, "Python process killed by signal");
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
          error: stderr.trim() || `Python execution failed (exit code ${exitCode})`,
        };
      } finally {
        // Cleanup tmpfs
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log.warn({ err: detail, tmpDir }, "failed to clean up Python tmpdir");
        }
      }
    },
  };
}
