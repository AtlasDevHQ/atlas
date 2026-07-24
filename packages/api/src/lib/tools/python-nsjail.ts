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
import { PYTHON_SECURITY_AND_SETUP, PYTHON_EXEC_AND_COLLECT } from "./python-wrapper";
import { readLimited, MAX_OUTPUT } from "./backends/shared";
import { buildPythonNsjailArgs, BASE_JAIL_ENV } from "./backends/nsjail";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("python-nsjail");

// Re-export the nsjail arg builder from its canonical home (backends/nsjail.ts,
// co-located with the explore twin) for callers/tests importing it here.
export { buildPythonNsjailArgs };

/**
 * Non-streaming Python wrapper for nsjail. Composes shared fragments
 * (PYTHON_SECURITY_AND_SETUP, PYTHON_EXEC_AND_COLLECT) with stdin-based
 * data injection and marker-based result emission.
 */
const PYTHON_WRAPPER = `
import sys, json, io, base64, glob, os, ast

_marker = os.environ["ATLAS_RESULT_MARKER"]
_chart_dir = os.environ.get("ATLAS_CHART_DIR", "/tmp")

def _report_error(msg):
    print(_marker + json.dumps({"success": False, "error": msg}))
    sys.exit(0)

${PYTHON_SECURITY_AND_SETUP}

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

${PYTHON_EXEC_AND_COLLECT}
`;

/**
 * Minimal env for the Python jail — no secrets. Spreads the shared
 * {@link BASE_JAIL_ENV} (HOME/LANG), widens PATH to reach the Python runtime
 * under /usr/local/bin, and adds the matplotlib backend + chart dir + result
 * marker the wrapper reads.
 */
function buildJailEnv(resultMarker: string): Record<string, string> {
  return {
    ...BASE_JAIL_ENV,
    PATH: "/bin:/usr/bin:/usr/local/bin",
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
          // fire-and-forget: Bun FileSink write/end return number|Promise; original code never awaited and relies on Bun's buffering
          void proc.stdin.write(stdinPayload);
          void proc.stdin.end();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log.warn({ err: detail, execId }, "stdin write error during Python execution");
          if (data) {
            proc.kill();
            return { success: false, error: `Failed to inject data into Python sandbox: ${detail}` };
          }
        }

        const [stdoutRead, stderrRead] = await Promise.all([
          readLimited(proc.stdout, MAX_OUTPUT),
          readLimited(proc.stderr, MAX_OUTPUT),
        ]);
        const stdout = stdoutRead.text;
        const stderr = stderrRead.text;
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

        // No structured result — process errored before the wrapper could emit
        // one. Use readLimited's byte-accurate truncation flag rather than the
        // decoded string length, which under-counts multi-byte UTF-8 output and
        // would misreport a truncated non-ASCII result as a generic failure.
        if (stdoutRead.truncated) {
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
