/**
 * Python execution tool for data analysis and visualization.
 *
 * Runs Python code in a sandboxed environment with optional data injection.
 * The just-bash backend spawns python3 with a wrapper script that handles
 * data serialization (JSON on stdin) and structured output (JSON on stdout).
 *
 * Security: An AST-based import guard blocks dangerous modules before execution.
 * Future backends (nsjail, sidecar, Vercel) will add process-level isolation.
 */

import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createLogger } from "@atlas/api/lib/logger";
import { withSpan } from "@atlas/api/lib/tracing";

const log = createLogger("python");

// --- Import guard ---

const BLOCKED_MODULES = new Set([
  "subprocess",
  "os",
  "socket",
  "shutil",
  "sys",
  "ctypes",
  "importlib",
  "code",
  "signal",
  "multiprocessing",
  "threading",
  "pty",
  "fcntl",
  "termios",
  "resource",
  "posixpath",
]);

const BLOCKED_BUILTINS = new Set([
  "compile",
  "exec",
  "eval",
  "__import__",
  "open",
  "breakpoint",
]);

/**
 * Validate Python code for blocked imports and dangerous builtins.
 *
 * Uses Python's own `ast` module to parse the code, then checks for:
 * - `import X` / `from X import ...` where X is in BLOCKED_MODULES
 * - Calls to blocked builtins (exec, eval, compile, __import__, open, breakpoint)
 *
 * Returns { safe: true } or { safe: false, reason: string }.
 */
export async function validatePythonCode(
  code: string,
): Promise<{ safe: true } | { safe: false; reason: string }> {
  // Build a Python script that uses ast to extract imports and dangerous calls
  const checkerScript = `
import ast, json, sys

code = sys.stdin.read()
try:
    tree = ast.parse(code)
except SyntaxError as e:
    json.dump({"error": f"SyntaxError: {e.msg} (line {e.lineno})"}, sys.stdout)
    sys.exit(0)

imports = []
calls = []

for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            imports.append(alias.name.split('.')[0])
    elif isinstance(node, ast.ImportFrom):
        if node.module:
            imports.append(node.module.split('.')[0])
    elif isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name):
            calls.append(node.func.id)
        elif isinstance(node.func, ast.Attribute):
            calls.append(node.func.attr)

json.dump({"imports": imports, "calls": calls}, sys.stdout)
`;

  const proc = Bun.spawn(["python3", "-c", checkerScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(code);
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    log.warn({ stderr, exitCode }, "Python AST checker failed");
    return { safe: false, reason: `Code analysis failed: ${stderr.trim() || "unknown error"}` };
  }

  let result: { error?: string; imports?: string[]; calls?: string[] };
  try {
    result = JSON.parse(stdout);
  } catch {
    return { safe: false, reason: "Code analysis produced invalid output" };
  }

  if (result.error) {
    return { safe: false, reason: result.error };
  }

  // Check imports
  for (const mod of result.imports ?? []) {
    if (BLOCKED_MODULES.has(mod)) {
      return { safe: false, reason: `Blocked import: "${mod}" is not allowed` };
    }
  }

  // Check dangerous builtins
  for (const call of result.calls ?? []) {
    if (BLOCKED_BUILTINS.has(call)) {
      return { safe: false, reason: `Blocked builtin: "${call}()" is not allowed` };
    }
  }

  return { safe: true };
}

// --- Output types ---

export interface PythonChart {
  base64: string;
  mimeType: "image/png";
}

export interface RechartsChart {
  type: "line" | "bar" | "area" | "scatter" | "pie";
  data: Record<string, unknown>[];
  categoryKey: string;
  valueKeys: string[];
}

export interface PythonResult {
  success: boolean;
  output?: string;
  error?: string;
  table?: { columns: string[]; rows: unknown[][] };
  charts?: PythonChart[];
  rechartsCharts?: RechartsChart[];
}

// --- Execution timeout (ms) — read at call time so tests can override ---
function getPythonTimeout(): number {
  return parseInt(process.env.ATLAS_PYTHON_TIMEOUT ?? "30000", 10);
}

/**
 * Python execution backend interface.
 *
 * Implementations run Python code with optional data injection and return
 * structured results. The just-bash backend is the dev-mode default;
 * nsjail (#42), sidecar (#43), and Vercel (#45) backends will follow.
 */
// TODO(#42, #43, #45): Extract PythonBackend interface when adding nsjail/sidecar/Vercel backends
// interface PythonBackend {
//   execute(code: string, data?: { columns: string[]; rows: unknown[][] }): Promise<PythonResult>;
//   close?(): Promise<void>;
// }

// --- Wrapper script ---

/**
 * Python wrapper that handles:
 * - Reading data from stdin as JSON
 * - Making it available as a pandas DataFrame (if pandas is installed) or dict
 * - Capturing print output
 * - Detecting and reading chart files saved to ATLAS_CHART_DIR/chart_*.png
 * - Returning structured JSON on stdout (last line, prefixed with __ATLAS_RESULT__)
 *
 * The chart directory is unique per execution (passed via ATLAS_CHART_DIR env var)
 * to avoid collisions between concurrent requests.
 *
 * User code can also set:
 * - _atlas_table = {"columns": [...], "rows": [...]}  — structured table output
 * - _atlas_chart = {"type": "line", "data": [...], "categoryKey": "month", "valueKeys": ["revenue"]}
 *   or a list of such dicts — Recharts-native interactive chart output
 */
const PYTHON_WRAPPER = `
import sys, json, io, base64, glob, os

_chart_dir = os.environ.get("ATLAS_CHART_DIR", "/tmp")

# Read data payload from stdin
_stdin_data = sys.stdin.read()
_atlas_data = None
if _stdin_data.strip():
    _atlas_data = json.loads(_stdin_data)

# Make data available as DataFrame if pandas is installed
data = None
df = None
if _atlas_data:
    try:
        import pandas as pd
        df = pd.DataFrame(_atlas_data["rows"], columns=_atlas_data["columns"])
        data = df
    except ImportError:
        data = _atlas_data

# Capture stdout
_old_stdout = sys.stdout
sys.stdout = _captured = io.StringIO()

# Configure matplotlib for headless rendering with chart dir
try:
    import matplotlib
    matplotlib.use('Agg')
except ImportError:
    pass

# Make chart_path helper available to user code
def chart_path(n=0):
    return os.path.join(_chart_dir, f"chart_{n}.png")

# Execute user code
_atlas_error = None
try:
    exec(open(sys.argv[1]).read())
except Exception as e:
    _atlas_error = f"{type(e).__name__}: {e}"

# Collect output
_output = _captured.getvalue()
sys.stdout = _old_stdout

# Collect PNG charts from the per-execution chart dir
_charts = []
for f in sorted(glob.glob(os.path.join(_chart_dir, "chart_*.png"))):
    with open(f, "rb") as fh:
        _charts.append({"base64": base64.b64encode(fh.read()).decode(), "mimeType": "image/png"})

# Build result
_result = {"success": _atlas_error is None}
if _output.strip():
    _result["output"] = _output.strip()
if _atlas_error:
    _result["error"] = _atlas_error

# Check if user code produced a table result via _atlas_table
if "_atlas_table" in dir():
    _result["table"] = _atlas_table

# Check if user code produced Recharts-native chart(s) via _atlas_chart
if "_atlas_chart" in dir():
    _ac = _atlas_chart
    if isinstance(_ac, dict):
        _result["rechartsCharts"] = [_ac]
    elif isinstance(_ac, list):
        _result["rechartsCharts"] = _ac

if _charts:
    _result["charts"] = _charts

print("__ATLAS_RESULT__" + json.dumps(_result), file=_old_stdout)
`;

// --- Just-bash backend ---

export async function executePythonCode(
  code: string,
  data?: { columns: string[]; rows: unknown[][] },
): Promise<PythonResult> {
  const tmpDir = os.tmpdir();
  const execId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const codeFile = path.join(tmpDir, `atlas_py_${execId}.py`);
  const wrapperFile = path.join(tmpDir, `atlas_pyw_${execId}.py`);
  // Per-execution chart directory avoids collisions between concurrent requests
  const chartDir = path.join(tmpDir, `atlas_charts_${execId}`);

  try {
    fs.mkdirSync(chartDir, { recursive: true });
    fs.writeFileSync(codeFile, code);
    fs.writeFileSync(wrapperFile, PYTHON_WRAPPER);

    const stdinPayload = data ? JSON.stringify(data) : "";

    const proc = Bun.spawn(["python3", wrapperFile, codeFile], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MPLBACKEND: "Agg",
        ATLAS_CHART_DIR: chartDir,
      },
    });

    // Kill the process after timeout to prevent runaway execution
    const timeout = getPythonTimeout();
    const timer = setTimeout(() => proc.kill(), timeout);

    proc.stdin.write(stdinPayload);
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    clearTimeout(timer);

    // Killed by timeout — exitCode is null/non-zero, stderr may be empty
    if (exitCode !== 0 && !stdout.includes("__ATLAS_RESULT__")) {
      const isTimeout = exitCode === null || exitCode === 137 || exitCode === 9;
      if (isTimeout) {
        return {
          success: false,
          error: `Python execution timed out after ${timeout}ms`,
        };
      }
    }

    // Extract structured result from the last __ATLAS_RESULT__ line
    const lines = stdout.split("\n");
    const resultLine = lines.findLast((l) => l.startsWith("__ATLAS_RESULT__"));

    if (resultLine) {
      try {
        return JSON.parse(resultLine.slice("__ATLAS_RESULT__".length));
      } catch {
        log.warn("Failed to parse Python result JSON");
      }
    }

    // Fallback: no structured result
    if (exitCode !== 0) {
      return {
        success: false,
        error: stderr.trim() || `Python exited with code ${exitCode}`,
      };
    }

    return {
      success: true,
      output: stdout.trim() || undefined,
    };
  } finally {
    // Clean up temp files and chart directory
    try { fs.unlinkSync(codeFile); } catch { /* ignore */ }
    try { fs.unlinkSync(wrapperFile); } catch { /* ignore */ }
    try { fs.rmSync(chartDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// --- Tool definition ---

export const executePython = tool({
  description: `Execute Python code for data analysis and visualization.

The code runs in a sandboxed Python environment with access to common data science libraries (pandas, numpy, matplotlib, etc. if installed).

When data is provided (from a previous SQL query), it is available as:
- \`df\`: a pandas DataFrame (if pandas is installed)
- \`data\`: the raw dict with "columns" and "rows" keys

Output options:
- Table: set \`_atlas_table = {"columns": [...], "rows": [...]}\`
- Interactive chart (Recharts): set \`_atlas_chart = {"type": "line", "data": [...], "categoryKey": "month", "valueKeys": ["revenue"]}\` (type can be line, bar, area, scatter, pie)
- PNG chart (matplotlib): save to \`chart_path(0)\`, \`chart_path(1)\`, etc.
- Text: use \`print()\` for narrative output

Blocked: subprocess, os, socket, shutil, sys, ctypes, importlib, exec(), eval(), open(), compile().`,

  inputSchema: z.object({
    code: z.string().describe("Python code to execute"),
    explanation: z.string().describe("Brief explanation of what this code does and why"),
    data: z
      .object({
        columns: z.array(z.string()),
        rows: z.array(z.array(z.unknown())),
      })
      .optional()
      .describe("Optional data payload from a previous SQL query (columns + rows)"),
  }),

  execute: async ({ code, explanation, data }) => {
    // 1. Validate imports
    const validation = await validatePythonCode(code);
    if (!validation.safe) {
      log.warn({ reason: validation.reason }, "Python code rejected by import guard");
      return { success: false, error: validation.reason };
    }

    // 2. Execute
    const start = performance.now();
    try {
      const result = await withSpan(
        "atlas.python.execute",
        { "code.length": code.length },
        () => executePythonCode(code, data),
      );
      const durationMs = Math.round(performance.now() - start);

      log.debug(
        { durationMs, success: result.success, hasCharts: !!result.charts?.length },
        "python execution",
      );

      return {
        ...result,
        explanation,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error({ err: detail }, "Python execution failed");
      return { success: false, error: detail };
    }
  },
});
