/**
 * Shared Python-backend machinery for sandbox plugins (#3414).
 *
 * A provider that can write files, run `python3`, and read files back can
 * implement the whole Python surface by supplying those four primitives — the
 * transport protocol the host's wrapper speaks (argv positions, env var names,
 * `chart_*.png` readback, the output cap, the timeout, credential scrubbing)
 * lives here, once. Two plugins hand-rolling it is two chances to get the cap
 * or the timeout subtly wrong, and the drift would be invisible until a chart
 * went missing or a run hung past its budget.
 *
 * This module deliberately does NOT contain any Python source: the wrapper —
 * and with it the in-sandbox import guard — is handed down by the host in
 * {@link PluginPythonOptions.wrapperSource}, so no plugin ships its own copy
 * of a security control.
 */

import {
  PLUGIN_PYTHON_CHART_DIR_ENV,
  PLUGIN_PYTHON_CHART_PATTERN,
  PLUGIN_PYTHON_RESULT_FILE_ENV,
  type PluginPythonBackend,
  type PluginPythonData,
  type PluginPythonOptions,
  type PluginPythonResult,
} from "./types";

/** Minimal logger surface (pino / PluginLogger compatible). */
export interface PythonBackendLogger {
  warn(msg: string): void;
}

/** Result of running a command inside a provider sandbox. */
export interface PythonSandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A live provider sandbox, reduced to the primitives the file-transport
 * protocol needs. All paths are absolute paths inside the sandbox.
 */
export interface PythonSandboxSession {
  /** Absolute directory the backend may create per-execution subdirectories in. */
  readonly workDir: string;
  /** Create a directory, including parents. */
  mkdir(path: string): Promise<void>;
  /** Write a UTF-8 text file, creating it if absent. */
  writeFile(path: string, content: string): Promise<void>;
  /** Run a command. Implementations SHOULD honour `timeoutMs`; the caller also enforces it. */
  run(
    command: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<PythonSandboxRunResult>;
  /** Read a file as bytes, or `null` when it does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** List entry names (not paths) in a directory. Empty array when absent. */
  listDir(path: string): Promise<string[]>;
  /** Tear the sandbox down. Best-effort; must not throw. */
  destroy(): Promise<void>;
}

/** Everything the shared backend needs beyond a live session. */
export interface PythonBackendAdapter {
  /** Human-readable provider name, used in error text. */
  readonly providerName: string;
  /** Create a fresh sandbox. Called lazily on first exec, and again after an infra failure. */
  createSession(): Promise<PythonSandboxSession>;
}

/** Matches the in-tree backends' 1 MB rejection message verbatim. */
const OUTPUT_TOO_LARGE_ERROR =
  "Python output exceeded 1 MB limit — reduce print() output or use _atlas_table for large results.";

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function base64Of(bytes: Uint8Array): string {
  // Buffer is present on every runtime Atlas plugins run under (node, bun);
  // the btoa path keeps this honest for a stray runtime without it.
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(e: string): string } } })
    .Buffer;
  if (B) return B.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A unique per-execution directory name. */
function execId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Deterministic-enough fallback: the directory only needs to be unique
  // within one sandbox's lifetime.
  return `x${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Build a {@link PluginPythonBackend} on top of a provider's file/exec
 * primitives, implementing the host's file-transport protocol.
 *
 * The session is created lazily on first `exec` and reused; an infrastructure
 * failure discards it (and tears the old one down) so the next call starts
 * clean, mirroring the in-tree Vercel backend's lifecycle.
 */
export function createFileTransportPythonBackend(
  options: PluginPythonOptions,
  adapter: PythonBackendAdapter,
  logger?: PythonBackendLogger,
): PluginPythonBackend {
  const scrub = options.scrubErrorDetail ?? ((detail: string) => detail);
  let sessionPromise: Promise<PythonSandboxSession> | null = null;

  const detailOf = (err: unknown): string =>
    scrub(err instanceof Error ? err.message : String(err));

  function invalidate(): void {
    const old = sessionPromise;
    sessionPromise = null;
    if (!old) return;
    old
      .then((session) => session.destroy())
      .catch((err: unknown) => {
        logger?.warn(
          `[${adapter.providerName}] Failed to destroy Python sandbox during cleanup: ${detailOf(err)}`,
        );
      });
  }

  /**
   * Enforce the budget host-side too. A provider `run` that ignores its
   * `timeoutMs` would otherwise let a runaway script hold the tool call open
   * indefinitely — the timeout has to be a property of this backend, not a
   * hope about the SDK.
   */
  async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    // A cancel closure rather than a `handle | undefined` variable: the return
    // type of setTimeout is environment-dependent, and unioning it with
    // undefined widens to `any` under type-aware lint.
    let cancelTimer = (): void => {};
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          const handle = setTimeout(
            () => reject(new Error(`Python execution timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          cancelTimer = () => clearTimeout(handle);
        }),
      ]);
    } finally {
      cancelTimer();
    }
  }

  async function exec(
    code: string,
    data?: PluginPythonData,
  ): Promise<PluginPythonResult> {
    if (!sessionPromise) sessionPromise = adapter.createSession();
    const pending = sessionPromise;

    let session: PythonSandboxSession;
    try {
      session = await pending;
    } catch (err) {
      invalidate();
      return {
        success: false,
        error: `Failed to start ${adapter.providerName} Python sandbox: ${detailOf(err)}`,
      };
    }

    const dir = `${session.workDir}/exec-${execId()}`;
    const chartDir = `${dir}/charts`;
    const wrapperPath = `${dir}/wrapper.py`;
    const codePath = `${dir}/user_code.py`;
    const dataPath = `${dir}/data.json`;
    const resultPath = `${dir}/result.json`;

    try {
      await session.mkdir(chartDir);
      await Promise.all([
        session.writeFile(wrapperPath, options.wrapperSource),
        session.writeFile(codePath, code),
        ...(data ? [session.writeFile(dataPath, JSON.stringify(data))] : []),
      ]);
    } catch (err) {
      invalidate();
      return {
        success: false,
        error: `Failed to stage Python execution in the ${adapter.providerName} sandbox: ${detailOf(err)}`,
      };
    }

    const args = data ? [wrapperPath, codePath, dataPath] : [wrapperPath, codePath];
    const env: Record<string, string> = {
      [PLUGIN_PYTHON_RESULT_FILE_ENV]: resultPath,
      [PLUGIN_PYTHON_CHART_DIR_ENV]: chartDir,
      MPLBACKEND: "Agg",
      HOME: "/tmp",
      LANG: "C.UTF-8",
    };

    let run: PythonSandboxRunResult;
    try {
      run = await withTimeout(
        session.run("python3", args, env, options.timeoutMs),
        options.timeoutMs,
      );
    } catch (err) {
      const detail = detailOf(err);
      // A timeout leaves the sandbox healthy — only this execution was slow —
      // so it does NOT invalidate, matching the in-tree backend. Anything else
      // is infrastructure.
      if (!/timed out/i.test(detail)) invalidate();
      return { success: false, error: detail };
    }

    let resultBytes: Uint8Array | null;
    try {
      resultBytes = await session.readFile(resultPath);
    } catch (err) {
      invalidate();
      return {
        success: false,
        error: `Failed to read Python result from the ${adapter.providerName} sandbox: ${detailOf(err)}`,
      };
    }

    if (!resultBytes) {
      // No result file: the process died before the wrapper could write one.
      const stderr = scrub(run.stderr).trim();
      return {
        success: false,
        error: stderr
          ? stderr.slice(0, 500)
          : `Python execution failed (exit code ${run.exitCode}) with no output.`,
      };
    }

    if (resultBytes.length > options.maxOutputBytes) {
      return { success: false, error: OUTPUT_TOO_LARGE_ERROR };
    }

    let parsed: PluginPythonResult;
    try {
      parsed = JSON.parse(textOf(resultBytes)) as PluginPythonResult;
    } catch (err) {
      logger?.warn(
        `[${adapter.providerName}] Failed to parse Python result JSON: ${detailOf(err)}`,
      );
      const stderr = scrub(run.stderr).trim();
      return {
        success: false,
        error: `Python produced unparseable output.${stderr ? ` stderr: ${stderr.slice(0, 500)}` : ""}`,
      };
    }

    if (!parsed.success) return parsed;

    let charts: string[] = [];
    try {
      const names = (await session.listDir(chartDir))
        .filter((name) => PLUGIN_PYTHON_CHART_PATTERN.test(name))
        .sort();
      const buffers = await Promise.all(
        names.map((name) => session.readFile(`${chartDir}/${name}`)),
      );
      charts = buffers
        .filter((b): b is Uint8Array => b != null)
        .map((b) => base64Of(b));
    } catch (err) {
      // Charts are an artifact of a run that already succeeded — losing them is
      // worth a warning, not a failed result the agent has to retry.
      logger?.warn(
        `[${adapter.providerName}] Failed to read Python chart artifacts: ${detailOf(err)}`,
      );
    }

    const totalBytes =
      resultBytes.length + charts.reduce((n, chart) => n + chart.length, 0);
    if (totalBytes > options.maxOutputBytes) {
      return { success: false, error: OUTPUT_TOO_LARGE_ERROR };
    }

    return charts.length > 0
      ? {
          ...parsed,
          charts: charts.map((base64) => ({ base64, mimeType: "image/png" as const })),
        }
      : parsed;
  }

  return {
    exec,
    close: async () => {
      const old = sessionPromise;
      sessionPromise = null;
      if (!old) return;
      try {
        await (await old).destroy();
      } catch (err) {
        logger?.warn(
          `[${adapter.providerName}] Failed to destroy Python sandbox on close: ${detailOf(err)}`,
        );
      }
    },
  };
}
