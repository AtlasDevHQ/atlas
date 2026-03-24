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

import type { ExploreBackend, ExecResult } from "./backends/types";
import { readLimited, MAX_OUTPUT } from "./backends/shared";
import { findNsjailBinary, buildNsjailArgs } from "./backends/nsjail";
import { createLogger } from "@atlas/api/lib/logger";
import * as fs from "fs";

const log = createLogger("nsjail-sandbox");

// Re-export nsjail detection utilities for backward compatibility.
// startup.ts dynamically imports these from this module path.
export { findNsjailBinary, isNsjailAvailable, testNsjailCapabilities } from "./backends/nsjail";

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
        const args = buildNsjailArgs(nsjailPath, semanticRoot, command, log);
        proc = Bun.spawn(args, {
          env: JAIL_ENV,
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (err) {
        // Spawn itself failed — infrastructure error
        const detail = err instanceof Error ? err.message : String(err);
        log.error({ err: detail }, "nsjail spawn failed");
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
        log.error(
          { err: detail, command },
          "nsjail process I/O error",
        );
        throw new Error(
          `nsjail process I/O error: ${detail}`,
          { cause: err },
        );
      }

      // Interpret nsjail-specific exit codes
      if (exitCode === 109) {
        log.error(
          { exitCode, stderr },
          "nsjail setup failure (exit 109) — sandbox may not have been applied",
        );
        // Mark nsjail as permanently failed so the system falls back to just-bash
        // (when ATLAS_SANDBOX=nsjail, getExploreBackend will still throw hard)
        callbacks.onNsjailFailed();
      }
      if (exitCode > 128) {
        const signal = exitCode - 128;
        log.warn(
          { signal, command },
          "nsjail child killed by signal",
        );
      }

      return { stdout, stderr, exitCode };
    },
  };
}
