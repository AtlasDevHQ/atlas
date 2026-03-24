/**
 * Shared nsjail detection and capability testing.
 *
 * These functions are nsjail-platform-generic — they detect whether nsjail
 * is available and can create namespaces. Both explore and python backends
 * use them, as does startup.ts for pre-flight checks.
 *
 * Extracted from explore-nsjail.ts to eliminate the cross-tool dependency
 * where python.ts and startup.ts imported nsjail detection from an
 * explore-specific module.
 */

import * as fs from "fs";
import { createLogger } from "@atlas/api/lib/logger";
import { readLimited, MAX_OUTPUT, parsePositiveInt } from "./shared";

const log = createLogger("nsjail");

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
      continue;
    }
  }

  return null;
}

/** Check whether nsjail is available on this system. */
export function isNsjailAvailable(): boolean {
  return findNsjailBinary() !== null;
}

/** Build minimal nsjail args for a capability test (echo nsjail-ok). */
function buildTestArgs(
  nsjailPath: string,
  semanticRoot: string,
  command: string,
): string[] {
  const timeLimit = parsePositiveInt(
    "ATLAS_NSJAIL_TIME_LIMIT",
    10,
    "time limit",
    log,
  );
  const memoryLimit = parsePositiveInt(
    "ATLAS_NSJAIL_MEMORY_LIMIT",
    256,
    "memory limit",
    log,
  );

  return [
    nsjailPath,
    "--mode",
    "o",

    // Read-only bind mounts
    "-R",
    `${semanticRoot}:/semantic`,
    "-R",
    "/bin",
    "-R",
    "/usr/bin",
    "-R",
    "/lib",
    "-R",
    "/lib64",
    "-R",
    "/usr/lib",

    // Minimal /dev
    "-R",
    "/dev/null",
    "-R",
    "/dev/zero",
    "-R",
    "/dev/urandom",

    // /proc for correct namespace operation
    "--proc_path",
    "/proc",

    // Writable tmpfs for scratch
    "-T",
    "/tmp",

    // Working directory
    "--cwd",
    "/semantic",

    // Time limit
    "-t",
    String(timeLimit),

    // Resource limits
    "--rlimit_as",
    String(memoryLimit),
    "--rlimit_fsize",
    "10",
    "--rlimit_nproc",
    "5",
    "--rlimit_nofile",
    "64",

    // Run as nobody
    "-u",
    "65534",
    "-g",
    "65534",

    // Suppress nsjail info logs but keep error diagnostics
    "--quiet",

    // Command to execute
    "--",
    "/bin/bash",
    "-c",
    command,
  ];
}

/** Minimal env passed into the jail — no secrets. */
const JAIL_ENV: Record<string, string> = {
  PATH: "/bin:/usr/bin",
  HOME: "/tmp",
  LANG: "C.UTF-8",
};

/**
 * Run a minimal nsjail command to verify namespace support actually works.
 *
 * Exercises the exact same namespace config (user, PID, mount, network)
 * that real explore commands use. Returns `{ ok: true }` if nsjail can
 * create namespaces on this platform, or `{ ok: false, error }` with
 * a diagnostic message otherwise.
 */
export async function testNsjailCapabilities(
  nsjailPath: string,
  semanticRoot: string,
): Promise<{ ok: boolean; error?: string }> {
  const TIMEOUT_MS = 5000;
  try {
    const args = buildTestArgs(nsjailPath, semanticRoot, "echo nsjail-ok");
    const proc = Bun.spawn(args, {
      env: JAIL_ENV,
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
