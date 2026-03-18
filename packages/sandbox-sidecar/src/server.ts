/**
 * Sandbox sidecar — minimal HTTP server for isolated command execution.
 *
 * Designed to run as a separate container with NO secrets and only semantic/
 * files mounted. Provides per-request subprocess isolation: each POST /exec
 * creates a temporary directory for HOME/TMPDIR scratch space, runs the
 * command with cwd set to SEMANTIC_DIR, and cleans up.
 *
 * Endpoints:
 *   GET  /health        — { status: "ok" }
 *   POST /exec          — { command, timeout? } → { stdout, stderr, exitCode }
 *   POST /exec-python   — { code, data?, timeout? } → PythonResult
 *   POST /exec-python-stream — { code, data?, timeout? } → NDJSON stream
 */

import type {
  SidecarExecRequest,
  SidecarExecResponse,
  SidecarPythonRequest,
  SidecarPythonResponse,
} from "@atlas/api/lib/sidecar-types";
import { randomUUID } from "crypto";
import { readdirSync, writeFileSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join } from "path";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const SEMANTIC_DIR = process.env.SEMANTIC_DIR ?? "/semantic";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

const AUTH_TOKEN = process.env.SIDECAR_AUTH_TOKEN;

let activeExecs = 0;
const MAX_CONCURRENT = 10;

// --- Python defaults ---
const PYTHON_DEFAULT_TIMEOUT_MS = 30_000;
const PYTHON_MAX_TIMEOUT_MS = 120_000;

/** Read up to `max` bytes from a ReadableStream. */
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
    await reader.cancel().catch(() => { /* stream cancel errors are non-critical */ });
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Shared auth check. Returns a 401 Response if auth fails, null if OK. */
function checkAuth(req: Request): Response | null {
  if (!AUTH_TOKEN) return null;
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/** Clamp a timeout value to [min, max]. */
function clampTimeout(value: number | undefined, defaultMs: number, maxMs: number): number {
  return Math.min(Math.max(value ?? defaultMs, 1000), maxMs);
}

// --- Shell exec handler ---

async function handleExec(req: Request): Promise<Response> {
  const authErr = checkAuth(req);
  if (authErr) return authErr;

  // Concurrency control
  if (activeExecs >= MAX_CONCURRENT) {
    return Response.json({ error: "Too many concurrent executions" }, { status: 429 });
  }

  let body: SidecarExecRequest;
  try {
    body = (await req.json()) as SidecarExecRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.command || typeof body.command !== "string") {
    return Response.json({ error: "Missing or invalid 'command' field" }, { status: 400 });
  }

  const timeout = clampTimeout(body.timeout, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  // Resolve working directory — must be strictly under SEMANTIC_DIR to prevent traversal
  let cwd = SEMANTIC_DIR;
  if (body.cwd) {
    const resolved = join(SEMANTIC_DIR, body.cwd.replace(/^\/semantic\/?/, ""));
    if (resolved !== SEMANTIC_DIR && !resolved.startsWith(SEMANTIC_DIR + "/")) {
      return Response.json({ error: "cwd must be under SEMANTIC_DIR" }, { status: 400 });
    }
    cwd = resolved;
  }

  // Per-request isolation: unique temp directory
  const execId = randomUUID();
  const tmpDir = join("/tmp", `exec-${execId}`);

  console.log(`[sandbox-sidecar] exec=${execId} command=${body.command.slice(0, 200)} timeout=${timeout}`);

  const startTime = Date.now();
  activeExecs++;
  try {
    await mkdir(tmpDir, { recursive: true });

    const proc = Bun.spawn(["bash", "-c", body.command], {
      cwd,
      env: {
        PATH: "/bin:/usr/bin",
        HOME: tmpDir,
        LANG: "C.UTF-8",
        TMPDIR: tmpDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Timeout enforcement
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);

    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr] = await Promise.all([
        readLimited(proc.stdout, MAX_OUTPUT_BYTES),
        readLimited(proc.stderr, MAX_OUTPUT_BYTES),
      ]);
      exitCode = await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    const duration = Date.now() - startTime;
    console.log(`[sandbox-sidecar] exec=${execId} exitCode=${exitCode} stdoutLen=${stdout.length} duration=${duration}ms`);

    const result: SidecarExecResponse = { stdout, stderr, exitCode };
    return Response.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[sandbox-sidecar] exec=${execId} error=${detail}`);
    return Response.json(
      { error: `Execution failed: ${detail}`, stdout: "", stderr: detail, exitCode: 1 },
      { status: 500 },
    );
  } finally {
    activeExecs--;
    rm(tmpDir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[sandbox-sidecar] Failed to clean up ${tmpDir}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// --- Shared Python wrapper code ---

/**
 * Common Python code shared between streaming and non-streaming wrappers.
 *
 * Expects the caller to have already imported: sys, json, os, ast
 *
 * Expects the caller to have already defined:
 * - _chart_dir: str — path to chart output directory
 * - _report_error(msg: str) — emit error and exit the process
 *
 * Enforces the AST-based import guard (exits via _report_error on violation),
 * injects data from stdin, configures a headless matplotlib backend, and
 * makes available: _user_code, data, df, chart_path().
 */
const PYTHON_COMMON = `# --- Import guard (sidecar-side enforcement) ---
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
    _report_error(f"SyntaxError: {e.msg} (line {e.lineno})")

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
    _report_error(_blocked)

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
    return os.path.join(_chart_dir, f"chart_{n}.png")`;

// --- Python exec handler ---

/**
 * Non-streaming Python wrapper. Composes PYTHON_COMMON with stdout capture
 * and a single structured result emitted via a randomized marker.
 *
 * Security:
 * - AST-based import guard runs before exec (via PYTHON_COMMON)
 * - User code runs in an isolated namespace (cannot see/modify wrapper vars)
 * - Per-execution randomized result marker prevents stdout spoofing
 */
const PYTHON_WRAPPER = `
import sys, json, io, base64, glob, os, ast

_marker = os.environ["ATLAS_RESULT_MARKER"]
_chart_dir = os.environ.get("ATLAS_CHART_DIR", "/tmp")

def _report_error(msg):
    print(_marker + json.dumps({"success": False, "error": msg}))
    sys.exit(0)

${PYTHON_COMMON}

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

async function handleExecPython(req: Request): Promise<Response> {
  const authErr = checkAuth(req);
  if (authErr) return authErr;

  if (activeExecs >= MAX_CONCURRENT) {
    return Response.json({ error: "Too many concurrent executions" }, { status: 429 });
  }

  let body: SidecarPythonRequest;
  try {
    body = (await req.json()) as SidecarPythonRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.code || typeof body.code !== "string") {
    return Response.json({ error: "Missing or invalid 'code' field" }, { status: 400 });
  }

  const timeout = clampTimeout(body.timeout, PYTHON_DEFAULT_TIMEOUT_MS, PYTHON_MAX_TIMEOUT_MS);

  const execId = randomUUID();
  const resultMarker = `__ATLAS_RESULT_${execId}__`;
  const tmpDir = join("/tmp", `pyexec-${execId}`);
  const codeFile = join(tmpDir, "user_code.py");
  const wrapperFile = join(tmpDir, "wrapper.py");
  const chartDir = join(tmpDir, "charts");

  console.log(`[sandbox-sidecar] python=${execId} codeLen=${body.code.length} timeout=${timeout}`);

  const startTime = Date.now();
  activeExecs++;
  try {
    await mkdir(chartDir, { recursive: true });
    writeFileSync(codeFile, body.code);
    writeFileSync(wrapperFile, PYTHON_WRAPPER);

    const stdinPayload = body.data ? JSON.stringify(body.data) : "";

    const proc = Bun.spawn(["python3", wrapperFile, codeFile], {
      cwd: tmpDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: "/bin:/usr/bin:/usr/local/bin",
        HOME: tmpDir,
        LANG: "C.UTF-8",
        TMPDIR: tmpDir,
        MPLBACKEND: "Agg",
        ATLAS_CHART_DIR: chartDir,
        ATLAS_RESULT_MARKER: resultMarker,
      },
    });

    // SIGKILL — not catchable by Python
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeout);

    try {
      proc.stdin.write(stdinPayload);
      proc.stdin.end();
    } catch (err) {
      // EPIPE: python3 died before consuming stdin — will be caught by exit code
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[sandbox-sidecar] python=${execId} stdin write error: ${detail}`);
    }

    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr] = await Promise.all([
        readLimited(proc.stdout, MAX_OUTPUT_BYTES),
        readLimited(proc.stderr, MAX_OUTPUT_BYTES),
      ]);
      exitCode = await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    const duration = Date.now() - startTime;

    if (timedOut) {
      console.log(`[sandbox-sidecar] python=${execId} timed out after ${timeout}ms`);
      const result: SidecarPythonResponse = {
        success: false,
        error: `Python execution timed out after ${timeout}ms`,
      };
      return Response.json(result);
    }

    // Extract structured result from the last marker line
    const lines = stdout.split("\n");
    const resultLine = lines.findLast((l) => l.startsWith(resultMarker));

    if (resultLine) {
      try {
        const parsed = JSON.parse(resultLine.slice(resultMarker.length)) as SidecarPythonResponse;
        console.log(`[sandbox-sidecar] python=${execId} success=${parsed.success} exitCode=${exitCode} duration=${duration}ms`);
        return Response.json(parsed);
      } catch {
        console.warn(`[sandbox-sidecar] python=${execId} failed to parse result JSON, exitCode=${exitCode}`);
        const result: SidecarPythonResponse = {
          success: false,
          error: `Python produced unparseable output. stderr: ${stderr.trim().slice(0, 500)}`,
        };
        return Response.json(result);
      }
    }

    // No structured result — process errored before the wrapper could emit one
    console.log(`[sandbox-sidecar] python=${execId} no result line, exitCode=${exitCode} stderr=${stderr.slice(0, 200)} duration=${duration}ms`);
    const result: SidecarPythonResponse = {
      success: false,
      error: stderr.trim() || `Python execution failed (exit code ${exitCode})`,
    };
    return Response.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[sandbox-sidecar] python=${execId} error=${detail}`);
    const result: SidecarPythonResponse = {
      success: false,
      error: `Execution failed: ${detail}`,
    };
    return Response.json(result, { status: 500 });
  } finally {
    activeExecs--;
    rm(tmpDir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[sandbox-sidecar] Failed to clean up ${tmpDir}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// --- Streaming Python exec handler ---

/**
 * Streaming Python wrapper. Composes PYTHON_COMMON with real-time NDJSON
 * event emission via _emit(), a savefig hook for chart streaming, and
 * a _StreamingStdout class that intercepts print() calls.
 *
 * Protocol: each stdout line is prefixed with the stream marker. Lines are
 * JSON objects with `type` and `data` fields. The sidecar reads these and
 * forwards them directly to the client as NDJSON.
 */
const PYTHON_WRAPPER_STREAMING = `
import sys, json, io, base64, glob, os, ast

_stream_marker = os.environ["ATLAS_STREAM_MARKER"]
_chart_dir = os.environ.get("ATLAS_CHART_DIR", "/tmp")

# Save real stdout before any redirection
_real_stdout = sys.stdout

def _emit(event_type, data):
    """Write a streaming event line to stdout (bypassing user stdout capture)."""
    _real_stdout.write(_stream_marker + json.dumps({"type": event_type, "data": data}) + "\\n")
    _real_stdout.flush()

def _report_error(msg):
    _emit("error", {"error": msg})
    sys.exit(0)

${PYTHON_COMMON}

# Hook savefig for streaming chart emission
try:
    import matplotlib.pyplot as plt
    _orig_savefig = plt.Figure.savefig
    def _atlas_savefig(self, fname, *args, **kwargs):
        _orig_savefig(self, fname, *args, **kwargs)
        if isinstance(fname, str) and fname.startswith(_chart_dir):
            try:
                with open(fname, "rb") as fh:
                    b64 = base64.b64encode(fh.read()).decode()
                _emit("chart", {"base64": b64, "mimeType": "image/png"})
            except Exception as _chart_err:
                _emit("stdout", f"[Warning: chart streaming failed: {_chart_err}]\\n")
    plt.Figure.savefig = _atlas_savefig
except ImportError:
    pass

# --- Streaming stdout capture ---
class _StreamingStdout:
    """Intercepts print() calls and emits them as streaming events."""
    def __init__(self):
        self._buf = ""
    def write(self, s):
        if not s:
            return
        self._buf += s
        # Flush on newlines for line-buffered streaming
        while "\\n" in self._buf:
            line, self._buf = self._buf.split("\\n", 1)
            _emit("stdout", line + "\\n")
    def flush(self):
        if self._buf:
            _emit("stdout", self._buf)
            self._buf = ""
    def isatty(self):
        return False

sys.stdout = _StreamingStdout()

# --- Execute user code in isolated namespace ---
_user_ns = {"chart_path": chart_path, "data": data, "df": df}
_atlas_error = None
try:
    exec(_user_code, _user_ns)
except Exception as e:
    _atlas_error = f"{type(e).__name__}: {e}"

# Flush any remaining buffered stdout
sys.stdout.flush()
sys.stdout = _real_stdout

# --- Emit structured results ---
if _atlas_error:
    _emit("error", {"error": _atlas_error})
else:
    _done = {"success": True, "exitCode": 0}
    if "_atlas_table" in _user_ns:
        _emit("table", _user_ns["_atlas_table"])
        _done["hasTable"] = True
    if "_atlas_chart" in _user_ns:
        _ac = _user_ns["_atlas_chart"]
        if isinstance(_ac, dict):
            _emit("recharts", _ac)
        elif isinstance(_ac, list):
            for _c in _ac:
                _emit("recharts", _c)
    _emit("done", _done)
`;

async function handleExecPythonStream(req: Request): Promise<Response> {
  const authErr = checkAuth(req);
  if (authErr) return authErr;

  if (activeExecs >= MAX_CONCURRENT) {
    return Response.json({ error: "Too many concurrent executions" }, { status: 429 });
  }

  let body: SidecarPythonRequest;
  try {
    body = (await req.json()) as SidecarPythonRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.code || typeof body.code !== "string") {
    return Response.json({ error: "Missing or invalid 'code' field" }, { status: 400 });
  }

  const timeout = clampTimeout(body.timeout, PYTHON_DEFAULT_TIMEOUT_MS, PYTHON_MAX_TIMEOUT_MS);

  const execId = randomUUID();
  const streamMarker = `__ATLAS_STREAM_${execId}__`;
  const tmpDir = join("/tmp", `pyexec-${execId}`);
  const codeFile = join(tmpDir, "user_code.py");
  const wrapperFile = join(tmpDir, "wrapper_stream.py");
  const chartDir = join(tmpDir, "charts");

  console.log(`[sandbox-sidecar] python-stream=${execId} codeLen=${body.code.length} timeout=${timeout}`);

  const startTime = Date.now();
  activeExecs++;

  // Create a ReadableStream that sends NDJSON events
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let controllerClosed = false;
      function send(line: string) {
        if (controllerClosed) return;
        try {
          controller.enqueue(encoder.encode(line + "\n"));
        } catch (err) {
          controllerClosed = true;
          console.warn(`[sandbox-sidecar] python-stream=${execId} controller closed, dropping events: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      try {
        await mkdir(chartDir, { recursive: true });
        writeFileSync(codeFile, body.code);
        writeFileSync(wrapperFile, PYTHON_WRAPPER_STREAMING);

        const stdinPayload = body.data ? JSON.stringify(body.data) : "";

        const proc = Bun.spawn(["python3", wrapperFile, codeFile], {
          cwd: tmpDir,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: "/bin:/usr/bin:/usr/local/bin",
            HOME: tmpDir,
            LANG: "C.UTF-8",
            TMPDIR: tmpDir,
            MPLBACKEND: "Agg",
            ATLAS_CHART_DIR: chartDir,
            ATLAS_STREAM_MARKER: streamMarker,
          },
        });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill(9);
        }, timeout);

        try {
          proc.stdin.write(stdinPayload);
          proc.stdin.end();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.warn(`[sandbox-sidecar] python-stream=${execId} stdin write error: ${detail}`);
        }

        // Read stdout line by line and forward streaming events.
        // Enforce MAX_OUTPUT_BYTES to match non-streaming handler safety.
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let totalBytes = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;
            if (totalBytes > MAX_OUTPUT_BYTES) {
              proc.kill(9);
              send(JSON.stringify({ type: "error", data: { error: `Output exceeded ${MAX_OUTPUT_BYTES} byte limit` } }));
              break;
            }

            buffer += decoder.decode(value, { stream: true });

            // Process complete lines
            let newlineIdx;
            while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, newlineIdx);
              buffer = buffer.slice(newlineIdx + 1);

              if (line.startsWith(streamMarker)) {
                send(line.slice(streamMarker.length));
              } else if (line.trim()) {
                // Non-marker output (C extensions writing to fd 1, python warnings)
                console.debug(`[sandbox-sidecar] python-stream=${execId} non-marker stdout: ${line.slice(0, 200)}`);
              }
            }
          }

          // Process any remaining buffer content
          if (buffer.trim() && buffer.startsWith(streamMarker)) {
            send(buffer.slice(streamMarker.length));
          }

          const exitCode = await proc.exited;

          // Read stderr for error context
          let stderr: string;
          try {
            stderr = await new Response(proc.stderr).text();
          } catch (err) {
            console.warn(`[sandbox-sidecar] python-stream=${execId} failed to read stderr: ${err instanceof Error ? err.message : String(err)}`);
            stderr = "(stderr unavailable)";
          }

          const duration = Date.now() - startTime;

          if (timedOut) {
            console.log(`[sandbox-sidecar] python-stream=${execId} timed out after ${timeout}ms`);
            send(JSON.stringify({ type: "error", data: { error: `Python execution timed out after ${timeout}ms` } }));
          } else if (exitCode !== 0 && stderr.trim()) {
            console.log(`[sandbox-sidecar] python-stream=${execId} exitCode=${exitCode} duration=${duration}ms`);
            send(JSON.stringify({ type: "error", data: { error: stderr.trim().slice(0, 500) } }));
          } else {
            console.log(`[sandbox-sidecar] python-stream=${execId} exitCode=${exitCode} duration=${duration}ms`);
          }
        } finally {
          clearTimeout(timer);
          reader.releaseLock();
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[sandbox-sidecar] python-stream=${execId} error=${detail}`);
        send(JSON.stringify({ type: "error", data: { error: `Execution failed: ${detail}` } }));
      } finally {
        activeExecs--;
        controller.close();
        rm(tmpDir, { recursive: true, force: true }).catch((err) => {
          console.warn(`[sandbox-sidecar] Failed to clean up ${tmpDir}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

// --- Health endpoint ---

function handleHealth(): Response {
  try {
    const entries = readdirSync(SEMANTIC_DIR);

    // Check python3 availability
    let pythonAvailable = false;
    try {
      const proc = Bun.spawnSync(["python3", "--version"]);
      pythonAvailable = proc.exitCode === 0;
    } catch {
      // python3 not found
    }

    return Response.json({
      status: "ok",
      semanticDir: SEMANTIC_DIR,
      fileCount: entries.length,
      pythonAvailable,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return Response.json(
      { status: "error", error: `SEMANTIC_DIR not readable: ${detail}` },
      { status: 503 },
    );
  }
}

// --- Server ---

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return handleHealth();
    }

    if (url.pathname === "/exec" && req.method === "POST") {
      return handleExec(req);
    }

    if (url.pathname === "/exec-python" && req.method === "POST") {
      return handleExecPython(req);
    }

    if (url.pathname === "/exec-python-stream" && req.method === "POST") {
      return handleExecPythonStream(req);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`[sandbox-sidecar] listening on :${PORT}`);
