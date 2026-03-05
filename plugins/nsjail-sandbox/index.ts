/**
 * nsjail Sandbox Plugin — reference implementation for @useatlas/plugin-sdk.
 *
 * Demonstrates how the AtlasSandboxPlugin interface wraps the nsjail
 * isolation backend extracted from packages/api/src/lib/tools/explore-nsjail.ts.
 *
 * **Security:** This plugin provides full Linux namespace isolation:
 * - Network: disabled (nsjail default)
 * - Filesystem: read-only bind-mount of semantic/ directory
 * - User: runs as nobody (65534:65534)
 * - Resources: time limit, memory limit, process limit
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { nsjailSandboxPlugin } from "@atlas/plugin-nsjail-sandbox";
 *
 * export default defineConfig({
 *   plugins: [
 *     nsjailSandboxPlugin({ timeLimitSec: 15, memoryLimitMb: 512 }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import { createPlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasSandboxPlugin,
  PluginExploreBackend,
  PluginExecResult,
  PluginHealthResult,
} from "@useatlas/plugin-sdk";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const NsjailConfigSchema = z.object({
  /** Explicit path to the nsjail binary. Auto-detected on PATH when omitted. */
  nsjailPath: z.string().optional(),
  /** Per-command time limit in seconds. */
  timeLimitSec: z.number().int().positive().default(10),
  /** Per-command memory limit in MB. */
  memoryLimitMb: z.number().int().positive().default(256),
});

export type NsjailSandboxConfig = z.infer<typeof NsjailConfigSchema>;

// ---------------------------------------------------------------------------
// nsjail binary discovery
// ---------------------------------------------------------------------------

/** Resolve the nsjail binary path, or null if unavailable. */
export function findNsjailBinary(explicit?: string): string | null {
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
        `[nsjail-sandbox] nsjailPath="${explicit}" is not executable (${code})`,
      );
      return null;
    }
  }

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

// ---------------------------------------------------------------------------
// Backend factory
// ---------------------------------------------------------------------------

/** Maximum bytes to read from stdout/stderr (1 MB). */
const MAX_OUTPUT = 1024 * 1024;

/** Minimal env passed into the jail — no secrets. */
const JAIL_ENV: Record<string, string> = {
  PATH: "/bin:/usr/bin",
  HOME: "/tmp",
  LANG: "C.UTF-8",
};

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

function buildNsjailArgs(
  nsjailPath: string,
  semanticRoot: string,
  command: string,
  config: NsjailSandboxConfig,
): string[] {
  return [
    nsjailPath,
    "--mode", "o",

    // Read-only bind mounts
    "-R", `${semanticRoot}:/semantic`,
    "-R", "/bin",
    "-R", "/usr/bin",
    "-R", "/lib",
    "-R", "/lib64",
    "-R", "/usr/lib",

    // Minimal /dev
    "-R", "/dev/null",
    "-R", "/dev/zero",
    "-R", "/dev/urandom",

    // /proc for correct namespace operation
    "--proc_path", "/proc",

    // Writable tmpfs for scratch
    "-T", "/tmp",

    // Working directory
    "--cwd", "/semantic",

    // Time limit
    "-t", String(config.timeLimitSec),

    // Resource limits
    "--rlimit_as", String(config.memoryLimitMb),
    "--rlimit_fsize", "10",
    "--rlimit_nproc", "5",
    "--rlimit_nofile", "64",

    // Run as nobody
    "-u", "65534",
    "-g", "65534",

    // Suppress nsjail info logs
    "--quiet",

    // Command to execute
    "--",
    "/bin/bash", "-c", command,
  ];
}

function createNsjailExploreBackend(
  nsjailPath: string,
  semanticRoot: string,
  config: NsjailSandboxConfig,
): PluginExploreBackend {
  return {
    exec: async (command: string): Promise<PluginExecResult> => {
      const args = buildNsjailArgs(nsjailPath, semanticRoot, command, config);
      const proc = Bun.spawn(args, {
        env: JAIL_ENV,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr] = await Promise.all([
        readLimited(proc.stdout, MAX_OUTPUT),
        readLimited(proc.stderr, MAX_OUTPUT),
      ]);
      const exitCode = await proc.exited;

      return { stdout, stderr, exitCode };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

export function buildNsjailSandboxPlugin(
  config: NsjailSandboxConfig,
): AtlasSandboxPlugin<NsjailSandboxConfig> {
  return {
    id: "nsjail-sandbox",
    type: "sandbox" as const,
    version: "0.1.0",
    name: "nsjail Sandbox",
    config,

    sandbox: {
      create(semanticRoot: string): PluginExploreBackend {
        const nsjailPath = findNsjailBinary(config.nsjailPath);
        if (!nsjailPath) {
          throw new Error(
            "nsjail binary not found. Install nsjail or set nsjailPath in the plugin config.",
          );
        }

        // Validate semantic root exists
        try {
          fs.accessSync(semanticRoot, fs.constants.R_OK);
        } catch {
          throw new Error(
            `Semantic layer directory not readable: ${semanticRoot}. ` +
            "Run 'bun run atlas -- init' to generate a semantic layer.",
          );
        }

        return createNsjailExploreBackend(nsjailPath, semanticRoot, config);
      },
      priority: 75,
    },

    security: {
      networkIsolation: true,
      filesystemIsolation: true,
      unprivilegedExecution: true,
      description:
        "Linux namespace isolation via nsjail. No network access, read-only " +
        "semantic/ bind-mount, writable tmpfs for scratch, runs as nobody:65534.",
    },

    async initialize(ctx) {
      const nsjailPath = findNsjailBinary(config.nsjailPath);
      if (nsjailPath) {
        ctx.logger.info(`nsjail sandbox plugin initialized (binary: ${nsjailPath})`);
      } else {
        ctx.logger.warn("nsjail binary not found — plugin will fail on first use");
      }
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const nsjailPath = findNsjailBinary(config.nsjailPath);
      if (!nsjailPath) {
        return { healthy: false, message: "nsjail binary not found" };
      }

      const start = performance.now();
      try {
        const args = buildNsjailArgs(nsjailPath, "/tmp", "echo nsjail-ok", config);
        const proc = Bun.spawn(args, {
          env: JAIL_ENV,
          stdout: "pipe",
          stderr: "pipe",
        });

        const timer = setTimeout(() => proc.kill(), 5000);
        try {
          const [stdout] = await Promise.all([
            readLimited(proc.stdout, MAX_OUTPUT),
            readLimited(proc.stderr, MAX_OUTPUT),
          ]);
          const exitCode = await proc.exited;
          clearTimeout(timer);

          if (exitCode === 0 && stdout.includes("nsjail-ok")) {
            return {
              healthy: true,
              latencyMs: Math.round(performance.now() - start),
            };
          }

          return {
            healthy: false,
            message: `nsjail test command failed (exit ${exitCode})`,
            latencyMs: Math.round(performance.now() - start),
          };
        } catch (err) {
          clearTimeout(timer);
          throw err;
        }
      } catch (err) {
        return {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          latencyMs: Math.round(performance.now() - start),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory export
// ---------------------------------------------------------------------------

/**
 * Factory function for use in atlas.config.ts plugins array.
 *
 * @example
 * ```typescript
 * plugins: [nsjailSandboxPlugin({ timeLimitSec: 15, memoryLimitMb: 512 })]
 * ```
 */
export const nsjailSandboxPlugin = createPlugin({
  configSchema: NsjailConfigSchema,
  create: buildNsjailSandboxPlugin,
});
