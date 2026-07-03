/**
 * Shared nsjail detection, args building, and capability testing.
 *
 * These functions are nsjail-platform-generic — they detect whether nsjail
 * is available and can create namespaces. Both explore and python backends
 * use them, as does startup.ts (via explore-nsjail.ts re-exports) for
 * pre-flight checks. python.ts imports directly from this module.
 */

import * as fs from "fs";
import { createLogger } from "@atlas/api/lib/logger";
import { readLimited, MAX_OUTPUT, parsePositiveInt } from "./shared";

const log = createLogger("nsjail-sandbox");

/** Resolve the nsjail binary path, or null if unavailable. */
export function findNsjailBinary(): string | null {
  // 1. Explicit path from env
  const explicit = process.env.ATLAS_NSJAIL_PATH;
  if (explicit) {
    try {
      fs.accessSync(explicit, fs.constants.X_OK);
      return explicit;
    } catch (err) {
      const code =
        err instanceof Error && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : "unknown";
      log.error(
        `ATLAS_NSJAIL_PATH="${explicit}" is not executable (${code})`,
      );
      return null;
    }
  }

  // 2. Search PATH
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    const candidate = `${dir}/nsjail`;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // intentionally ignored: file not found/not executable is the expected case when scanning PATH
      continue;
    }
  }

  return null;
}

/** Check whether nsjail is available on this system. */
export function isNsjailAvailable(): boolean {
  return findNsjailBinary() !== null;
}

/** Logger interface for buildNsjailArgs — avoids coupling to pino. */
interface NsjailLogger {
  warn: (...args: unknown[]) => void;
}

/**
 * Minimal /dev mounts every jail needs — no secrets, no device access beyond
 * the three benign character devices. Shared by every nsjail spec.
 */
const DEV_MOUNTS: readonly string[] = ["/dev/null", "/dev/zero", "/dev/urandom"];

/**
 * Declarative description of a single nsjail invocation. This is the ONE place
 * the actual `nsjail` flag sequence is assembled; the explore and Python arg
 * builders below differ only in the data they feed here (mounts, resource
 * limits, working directory, command), never in the flag-emission logic. That
 * keeps the two security-critical jail configs from drifting in how they set
 * `--mode`, `-u/-g`, `--quiet`, rlimits, etc. — a bug in the serialization can
 * only ever exist in one function.
 */
export interface NsjailSpec {
  readonly nsjailPath: string;
  /** Read-only bind mounts emitted before the `/dev` mounts (`-R <m>`). */
  readonly systemMounts: readonly string[];
  /**
   * Extra bind mounts emitted after the `/proc` + tmpfs setup and before
   * `--cwd`. Each carries its own flag so a spec can mix read-only (`-R`) and
   * writable (`-B`) mounts (e.g. Python's code files vs. its chart dir).
   */
  readonly extraMounts?: readonly { readonly flag: "-R" | "-B"; readonly value: string }[];
  readonly cwd: string;
  readonly timeLimitSec: number;
  readonly rlimitAs: number;
  readonly rlimitFsize: number;
  readonly rlimitNproc: number;
  readonly rlimitNofile: number;
  /** When true, pass fd 0 (stdin) through to the jailed process (`--pass_fd 0`). */
  readonly passStdin?: boolean;
  /** Program + args after the `--` separator. */
  readonly command: readonly string[];
}

/**
 * Assemble the nsjail CLI args from a {@link NsjailSpec}. The single source of
 * truth for the jail flag sequence shared by explore and Python (AC: nsjail
 * arg-building exists once). The constant hardening flags (`--mode o`,
 * run-as-nobody `65534`, `--quiet`, the `/dev` + `/proc` + tmpfs setup) are
 * baked in here so no caller can accidentally omit one.
 */
export function assembleNsjailArgs(spec: NsjailSpec): string[] {
  const args: string[] = [spec.nsjailPath, "--mode", "o"];

  // Read-only system bind mounts
  for (const mount of spec.systemMounts) {
    args.push("-R", mount);
  }

  // Minimal /dev
  for (const dev of DEV_MOUNTS) {
    args.push("-R", dev);
  }

  // /proc for correct namespace operation
  args.push("--proc_path", "/proc");

  // Writable tmpfs for scratch
  args.push("-T", "/tmp");

  // Spec-specific extra mounts (read-only code files, writable chart dir, …)
  for (const mount of spec.extraMounts ?? []) {
    args.push(mount.flag, mount.value);
  }

  // Working directory
  args.push("--cwd", spec.cwd);

  // Time limit
  args.push("-t", String(spec.timeLimitSec));

  // Resource limits
  args.push(
    "--rlimit_as",
    String(spec.rlimitAs),
    "--rlimit_fsize",
    String(spec.rlimitFsize),
    "--rlimit_nproc",
    String(spec.rlimitNproc),
    "--rlimit_nofile",
    String(spec.rlimitNofile),
  );

  // Run as nobody
  args.push("-u", "65534", "-g", "65534");

  // Pass stdin through (Python data injection)
  if (spec.passStdin) {
    args.push("--pass_fd", "0");
  }

  // Suppress nsjail info logs but keep error diagnostics
  args.push("--quiet");

  // Command to execute
  args.push("--", ...spec.command);

  return args;
}

/**
 * Build the nsjail CLI args for a single explore (shell) command execution.
 *
 * Shared between testNsjailCapabilities (capability check) and
 * createNsjailBackend (real execution) so both exercise the exact
 * same namespace config.
 */
export function buildNsjailArgs(
  nsjailPath: string,
  semanticRoot: string,
  command: string,
  nsjailLog: NsjailLogger = log,
): string[] {
  const timeLimit = parsePositiveInt(
    "ATLAS_NSJAIL_TIME_LIMIT",
    10,
    "time limit",
    nsjailLog,
  );
  const memoryLimit = parsePositiveInt(
    "ATLAS_NSJAIL_MEMORY_LIMIT",
    256,
    "memory limit",
    nsjailLog,
  );

  return assembleNsjailArgs({
    nsjailPath,
    systemMounts: [
      `${semanticRoot}:/semantic`,
      "/bin",
      "/usr/bin",
      "/lib",
      "/lib64",
      "/usr/lib",
    ],
    cwd: "/semantic",
    timeLimitSec: timeLimit,
    rlimitAs: memoryLimit,
    rlimitFsize: 10,
    rlimitNproc: 5,
    rlimitNofile: 64,
    command: ["/bin/bash", "-c", command],
  });
}

/** Default Python execution timeout in seconds. */
const PYTHON_DEFAULT_TIME_LIMIT = 30;

/** Default Python memory limit in MB. */
const PYTHON_DEFAULT_MEMORY_LIMIT = 512;

/** Default Python max processes. */
const PYTHON_DEFAULT_NPROC = 16;

/**
 * Build the nsjail CLI args for a single Python execution. Co-located with
 * {@link buildNsjailArgs} (the explore twin) so both nsjail arg builders live
 * in one module; delegates the flag serialization to {@link assembleNsjailArgs}.
 *
 * `_tmpDir` and `_resultMarker` are unused by arg-building (the tmp dir is
 * reflected in the code/chart mount paths; the marker is passed to the jail via
 * env — see python-nsjail.ts) but kept in the signature for call-site symmetry.
 */
export function buildPythonNsjailArgs(
  nsjailPath: string,
  _tmpDir: string,
  codeFile: string,
  wrapperFile: string,
  chartDir: string,
  _resultMarker: string,
): string[] {
  const timeLimit = parsePositiveInt(
    "ATLAS_NSJAIL_TIME_LIMIT",
    PYTHON_DEFAULT_TIME_LIMIT,
    "time limit",
    log,
  );
  const memoryLimit = parsePositiveInt(
    "ATLAS_NSJAIL_MEMORY_LIMIT",
    PYTHON_DEFAULT_MEMORY_LIMIT,
    "memory limit",
    log,
  );

  return assembleNsjailArgs({
    nsjailPath,
    // System libs + Python runtime (adds /usr/local/{bin,lib} over explore)
    systemMounts: [
      "/bin",
      "/usr/bin",
      "/usr/local/bin",
      "/lib",
      "/lib64",
      "/usr/lib",
      "/usr/local/lib",
    ],
    // Bind-mount code files (read-only) and chart dir (writable, -B) into the jail
    extraMounts: [
      { flag: "-R", value: `${wrapperFile}:/tmp/wrapper.py` },
      { flag: "-R", value: `${codeFile}:/tmp/user_code.py` },
      { flag: "-B", value: `${chartDir}:/tmp/charts` },
    ],
    cwd: "/tmp",
    timeLimitSec: timeLimit,
    rlimitAs: memoryLimit,
    rlimitFsize: 50, // 50 MB for chart output
    rlimitNproc: PYTHON_DEFAULT_NPROC,
    rlimitNofile: 128,
    passStdin: true,
    command: ["/usr/bin/python3", "/tmp/wrapper.py", "/tmp/user_code.py"],
  });
}

/**
 * Minimal env passed into an explore (shell) jail — no secrets. Also the base
 * for the Python jail env (python-nsjail.ts spreads this and adds
 * MPLBACKEND / ATLAS_CHART_DIR / ATLAS_RESULT_MARKER), so the shared
 * `HOME`/`LANG` no longer live in three places.
 */
export const BASE_JAIL_ENV: Record<string, string> = {
  PATH: "/bin:/usr/bin",
  HOME: "/tmp",
  LANG: "C.UTF-8",
};

/**
 * Run a minimal nsjail command to verify namespace support actually works.
 *
 * Uses the same buildNsjailArgs as real explore commands to exercise the
 * exact same namespace config (user, PID, mount, network). Returns
 * `{ ok: true }` if nsjail can create namespaces on this platform, or
 * `{ ok: false, error }` with a diagnostic message otherwise.
 */
export async function testNsjailCapabilities(
  nsjailPath: string,
  semanticRoot: string,
): Promise<{ ok: boolean; error?: string }> {
  const TIMEOUT_MS = 5000;
  try {
    const args = buildNsjailArgs(nsjailPath, semanticRoot, "echo nsjail-ok");
    const proc = Bun.spawn(args, {
      env: BASE_JAIL_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    try {
      const [stdout, stderr] = await Promise.all([
        readLimited(proc.stdout, MAX_OUTPUT),
        readLimited(proc.stderr, MAX_OUTPUT),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timer);

      if (exitCode === 0 && stdout.includes("nsjail-ok")) {
        return { ok: true };
      }

      return {
        ok: false,
        error: `nsjail exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`,
      };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
