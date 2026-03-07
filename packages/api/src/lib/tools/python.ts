/**
 * Python execution tool for data analysis and visualization.
 *
 * Runs Python code in the sandbox sidecar — an isolated Docker container
 * with no secrets, no host access, and a minimal environment. The sidecar
 * handles data serialization, chart collection, and structured output.
 *
 * Security model:
 * - AST-based import guard runs first as defense-in-depth (catches obvious mistakes)
 * - The sidecar container is the actual security boundary (no secrets, no network to host)
 * - Requires ATLAS_SANDBOX_URL — refuses to run without a sidecar
 */

import { tool } from "ai";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { withSpan } from "@atlas/api/lib/tracing";

const log = createLogger("python");

// --- Import guard (defense-in-depth) ---

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
  // Network modules
  "http",
  "urllib",
  "requests",
  "httpx",
  "aiohttp",
  "webbrowser",
  // Dangerous serialization/filesystem
  "pickle",
  "tempfile",
  "pathlib",
]);

const BLOCKED_BUILTINS = new Set([
  "compile",
  "exec",
  "eval",
  "__import__",
  "open",
  "breakpoint",
  "getattr",
  "globals",
  "locals",
  "vars",
  "dir",
  "delattr",
  "setattr",
]);

/**
 * Validate Python code for blocked imports and dangerous builtins.
 *
 * Uses Python's own `ast` module to parse the code, then checks for:
 * - `import X` / `from X import ...` where X is in BLOCKED_MODULES
 * - Calls to blocked builtins (exec, eval, compile, __import__, open, getattr, etc.)
 *
 * This is defense-in-depth — the sidecar container is the security boundary.
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

  let proc;
  try {
    proc = Bun.spawn(["python3", "-c", checkerScript], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: detail }, "python3 not available for AST validation — guard skipped, sidecar will enforce");
    // If python3 isn't available locally, skip the guard.
    // The sidecar is the security boundary, not this check.
    return { safe: true };
  }

  try {
    proc.stdin.write(code);
    proc.stdin.end();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ err: detail }, "Failed to write to python3 stdin");
    return { safe: false, reason: `Code analysis failed: ${detail}` };
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
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
  type: "line" | "bar" | "pie";
  data: Record<string, unknown>[];
  categoryKey: string;
  valueKeys: string[];
}

export type PythonResult =
  | {
      success: true;
      output?: string;
      table?: { columns: string[]; rows: unknown[][] };
      charts?: PythonChart[];
      rechartsCharts?: RechartsChart[];
    }
  | {
      success: false;
      error: string;
      output?: string;
    };

// --- Tool definition ---

export const executePython = tool({
  description: `Execute Python code for data analysis and visualization.

The code runs in an isolated Python sandbox with access to common data science libraries (pandas, numpy, matplotlib, scipy, scikit-learn, statsmodels).

When data is provided (from a previous SQL query), it is available as:
- \`df\`: a pandas DataFrame (if pandas is installed)
- \`data\`: the raw dict with "columns" and "rows" keys

Output options:
- Table: set \`_atlas_table = {"columns": [...], "rows": [...]}\`
- Interactive chart (Recharts): set \`_atlas_chart = {"type": "line", "data": [...], "categoryKey": "month", "valueKeys": ["revenue"]}\` (type can be line, bar, pie)
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
    // 0. Require sidecar
    const sidecarUrl = process.env.ATLAS_SANDBOX_URL;
    if (!sidecarUrl) {
      log.error("ATLAS_SANDBOX_URL is required for Python execution");
      return {
        success: false,
        error: "Python execution requires a sandbox sidecar (ATLAS_SANDBOX_URL). See deployment docs.",
      };
    }

    // 1. Validate imports (defense-in-depth — sidecar is the real boundary)
    const validation = await validatePythonCode(code);
    if (!validation.safe) {
      log.warn({ reason: validation.reason }, "Python code rejected by import guard");
      return { success: false, error: validation.reason };
    }

    // 2. Execute via sidecar
    const start = performance.now();
    try {
      const { executePythonViaSidecar } = await import("./python-sidecar");
      const result = await withSpan(
        "atlas.python.execute",
        { "code.length": code.length },
        () => executePythonViaSidecar(sidecarUrl, code, data),
      );
      const durationMs = Math.round(performance.now() - start);

      log.debug(
        { durationMs, success: result.success, hasCharts: result.success && !!result.charts?.length },
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
