/**
 * nsjail backend for the explore tool.
 *
 * Uses nsjail (Linux namespaces) to run shell commands in a
 * sandboxed process. Only loaded when nsjail is available on PATH,
 * ATLAS_NSJAIL_PATH is set, or ATLAS_SANDBOX=nsjail is configured.
 *
 * Security: the jail runs with no network (default in nsjail), read-only
 * bind-mount of semantic/, writable tmpfs for scratch, and no access
 * to .env or any host secrets. Process runs as nobody (65534:65534).
 */

import type { ExploreBackend, ExecResult } from "./explore";
import * as fs from "fs";

/** Maximum bytes to read from stdout/stderr (1 MB). */
const MAX_OUTPUT = 1024 * 1024;

/** Read up to `max` bytes from a stream, releasing the reader on completion or error. */
async function readLimited(
  stream: ReadableStream,
  max: number,
): Promise<string> {
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
function parsePositiveInt(
  envVar: string,
  defaultValue: number,
  name: string,
): number {
  const raw = process.env[envVar];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(
      `[atlas] Invalid ${envVar}="${raw}" for ${name}, using default: ${defaultValue}`,
    );
    return defaultValue;
  }
  return parsed;
}

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
      console.error(
        `[atlas] ATLAS_NSJAIL_PATH="${explicit}" is not executable (${code})`,
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
    const args = buildNsjailArgs(nsjailPath, semanticRoot, "echo nsjail-ok");
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

/** Build the nsjail CLI args for a single command execution. */
function buildNsjailArgs(
  nsjailPath: string,
  semanticRoot: string,
  command: string,
): string[] {
  const timeLimit = parsePositiveInt(
    "ATLAS_NSJAIL_TIME_LIMIT",
    10,
    "time limit",
  );
  const memoryLimit = parsePositiveInt(
    "ATLAS_NSJAIL_MEMORY_LIMIT",
    256,
    "memory limit",
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

    // Network namespace is enabled by default in nsjail (no network access).
    // Older versions used --clone_newnet to opt in; current versions use
    // --disable_clone_newnet to opt out. No flag needed.

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

/** Callbacks injected by the explore module to avoid circular dynamic imports. */
export interface NsjailCallbacks {
  onInfrastructureError: () => void;
  onNsjailFailed: () => void;
}

export async function createNsjailBackend(
  semanticRoot: string,
  callbacks: NsjailCallbacks,
): Promise<ExploreBackend> {
  // Validate nsjail binary
  const nsjailPath = findNsjailBinary();
  if (!nsjailPath) {
    throw new Error(
      "nsjail binary not found. Install nsjail or set ATLAS_NSJAIL_PATH. " +
        "In non-production environments, the system will fall back to just-bash.",
    );
  }

  // Validate semantic root exists
  try {
    fs.accessSync(semanticRoot, fs.constants.R_OK);
  } catch (err) {
    const code =
      err instanceof Error && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : "unknown";
    throw new Error(
      `Semantic layer directory not readable: ${semanticRoot} (${code}). ` +
        "Run 'bun run atlas -- init' to generate a semantic layer.",
      { cause: err },
    );
  }

  return {
    exec: async (command: string): Promise<ExecResult> => {
      let proc;
      try {
        const args = buildNsjailArgs(nsjailPath, semanticRoot, command);
        proc = Bun.spawn(args, {
          env: JAIL_ENV,
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (err) {
        // Spawn itself failed — infrastructure error
        const detail = err instanceof Error ? err.message : String(err);
        console.error("[atlas] nsjail spawn failed:", detail);
        callbacks.onInfrastructureError();
        throw new Error(
          `nsjail infrastructure error: ${detail}. Backend cache cleared; nsjail will be re-initialized on next explore call.`,
          { cause: err },
        );
      }

      let stdout: string, stderr: string, exitCode: number;
      try {
        [stdout, stderr] = await Promise.all([
          readLimited(proc.stdout, MAX_OUTPUT),
          readLimited(proc.stderr, MAX_OUTPUT),
        ]);
        exitCode = await proc.exited;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(
          `[atlas] nsjail process I/O error: ${detail} | command: ${command}`,
        );
        throw new Error(
          `nsjail process I/O error: ${detail}`,
          { cause: err },
        );
      }

      // Interpret nsjail-specific exit codes
      if (exitCode === 109) {
        console.error(
          "[atlas] nsjail setup failure (exit 109) — sandbox may not have been applied. stderr:",
          stderr,
        );
        // Mark nsjail as permanently failed so the system falls back to just-bash
        // (when ATLAS_SANDBOX=nsjail, getExploreBackend will still throw hard)
        callbacks.onNsjailFailed();
      }
      if (exitCode > 128) {
        const signal = exitCode - 128;
        console.warn(
          `[atlas] nsjail child killed by signal ${signal} | command: ${command}`,
        );
      }

      return { stdout, stderr, exitCode };
    },
  };
}
