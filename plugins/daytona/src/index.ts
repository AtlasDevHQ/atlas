/**
 * Daytona Sandbox Plugin — managed sandbox backend for @useatlas/plugin-sdk.
 *
 * Wraps the Daytona SDK (@daytonaio/sdk) to provide cloud-hosted sandbox
 * isolation for the explore tool. Semantic layer files are uploaded into
 * an ephemeral Daytona sandbox and commands are executed remotely.
 *
 * **Security:** Daytona managed sandboxes provide:
 * - Network: isolated sandbox environment
 * - Filesystem: ephemeral, isolated per sandbox
 * - User: unprivileged execution inside the sandbox
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { daytonaSandboxPlugin } from "@useatlas/daytona";
 *
 * export default defineConfig({
 *   plugins: [
 *     daytonaSandboxPlugin({ apiKey: process.env.DAYTONA_API_KEY! }),
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
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const DaytonaSandboxConfigSchema = z.object({
  /** Daytona API key. */
  apiKey: z.string().min(1, "Daytona API key must not be empty"),
  /** Daytona API URL (defaults to cloud endpoint). */
  apiUrl: z.string().url().optional(),
  /** Command timeout in seconds. */
  timeoutSec: z.number().int().positive().optional().default(30),
});

export type DaytonaSandboxConfig = z.infer<typeof DaytonaSandboxConfigSchema>;

// ---------------------------------------------------------------------------
// Lazy SDK loader
// ---------------------------------------------------------------------------

/** Lazy-load the Daytona SDK, or throw with a helpful message. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadDaytonaSdk(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let DaytonaClass: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ Daytona: DaytonaClass } = require("@daytonaio/sdk"));
  } catch (err) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    if (isNotFound) {
      throw new Error(
        "Daytona support requires the @daytonaio/sdk package. Install it with: bun add @daytonaio/sdk",
      );
    }
    throw new Error(
      `Failed to load @daytonaio/sdk: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return DaytonaClass;
}

/** Create a Daytona client instance from validated config. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createDaytonaClient(DaytonaClass: any, config: DaytonaSandboxConfig): any {
  return new DaytonaClass({
    apiKey: config.apiKey,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
  });
}

// ---------------------------------------------------------------------------
// Semantic file collection (copied from explore-sandbox.ts)
// ---------------------------------------------------------------------------

function collectSemanticFiles(
  localDir: string,
  sandboxDir: string,
): { path: string; content: Buffer }[] {
  const results: { path: string; content: Buffer }[] = [];

  function walk(dir: string, relative: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const localPath = path.join(dir, entry.name);
      const remotePath = `${relative}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        try {
          const realPath = fs.realpathSync(localPath);
          if (!realPath.startsWith(localDir)) {
            continue; // Skip symlinks escaping semantic root
          }
          const stat = fs.statSync(localPath);
          if (stat.isDirectory()) {
            walk(localPath, remotePath);
          } else if (stat.isFile()) {
            results.push({
              path: remotePath,
              content: fs.readFileSync(localPath),
            });
          }
        } catch {
          continue; // Skip unreadable symlinks
        }
      } else if (entry.isDirectory()) {
        walk(localPath, remotePath);
      } else if (entry.isFile()) {
        try {
          results.push({
            path: remotePath,
            content: fs.readFileSync(localPath),
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(localDir, sandboxDir);
  return results;
}

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

export function buildDaytonaSandboxPlugin(
  config: DaytonaSandboxConfig,
): AtlasSandboxPlugin<DaytonaSandboxConfig> {
  let log: { warn(msg: string): void } | undefined;

  return {
    id: "daytona-sandbox",
    types: ["sandbox"] as const,
    version: "0.1.0",
    name: "Daytona Sandbox",
    config,

    sandbox: {
      async create(semanticRoot: string): Promise<PluginExploreBackend> {
        const DaytonaClass = loadDaytonaSdk();

        const daytona = createDaytonaClient(DaytonaClass, config);

        // Create sandbox
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let sandbox: any;
        try {
          sandbox = await daytona.create();
        } catch (err) {
          throw new Error(
            `Failed to create Daytona sandbox: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }

        // Collect and upload semantic layer files
        try {
          const files = collectSemanticFiles(semanticRoot, "semantic");

          if (files.length === 0) {
            throw new Error(
              "No semantic layer files found. " +
                "Run 'bun run atlas -- init' to generate a semantic layer.",
            );
          }

          // Collect unique parent directories and create them before uploading.
          // Daytona's uploadFile may not auto-create parent directories, so
          // nested files (e.g. semantic/entities/users.yml) would fail.
          const dirs = new Set<string>();
          for (const file of files) {
            const remotePath = `/home/daytona/${file.path}`;
            let dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
            while (dir && dir !== "/home/daytona" && dir !== "/home") {
              dirs.add(dir);
              dir = dir.substring(0, dir.lastIndexOf("/"));
            }
          }
          if (dirs.size > 0) {
            await sandbox.process.executeCommand(
              `mkdir -p ${[...dirs].sort().join(" ")}`,
            );
          }

          for (const file of files) {
            await sandbox.fs.uploadFile(
              file.content,
              `/home/daytona/${file.path}`,
            );
          }
        } catch (err) {
          // Clean up sandbox on upload failure
          try {
            await daytona.delete(sandbox);
          } catch {
            // Swallow cleanup errors
          }
          throw new Error(
            `Failed to upload semantic files to Daytona sandbox: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }

        return {
          async exec(command: string): Promise<PluginExecResult> {
            try {
              const response = await sandbox.process.executeCommand(
                command,
                "/home/daytona/semantic",
                undefined,
                config.timeoutSec,
              );
              return {
                stdout: response.result ?? "",
                stderr: "", // Daytona combines output into result
                exitCode: response.exitCode,
              };
            } catch (err) {
              return {
                stdout: "",
                stderr: err instanceof Error ? err.message : String(err),
                exitCode: 1,
              };
            }
          },

          async close(): Promise<void> {
            try {
              await daytona.delete(sandbox);
            } catch (err) {
              (log ?? console).warn(`[daytona-sandbox] Failed to delete sandbox: ${err instanceof Error ? err.message : String(err)}`);
            }
          },
        };
      },
      priority: 85,
    },

    security: {
      networkIsolation: true,
      filesystemIsolation: true,
      unprivilegedExecution: true,
      description:
        "Daytona managed sandbox. Cloud-hosted ephemeral environment with " +
        "network isolation, filesystem isolation, and unprivileged execution.",
    },

    async initialize(ctx) {
      log = ctx.logger;
      ctx.logger.info("Daytona sandbox plugin ready");
    },

    // Note: each health check creates a Daytona sandbox instance.
    // Avoid calling at high frequency to minimize API costs.
    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      const TIMEOUT = 30_000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let sandbox: any = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let daytonaRef: any = null;
      let timer: ReturnType<typeof setTimeout>;

      const cleanupSandbox = async () => {
        if (sandbox && daytonaRef) {
          try {
            await daytonaRef.delete(sandbox);
          } catch (e) {
            (log ?? console).warn(`[daytona-sandbox] Failed to clean up health-check sandbox: ${e instanceof Error ? e.message : String(e)}`);
          }
          sandbox = null;
        }
      };

      try {
        const result = await Promise.race([
          (async () => {
            const DaytonaClass = loadDaytonaSdk();
            daytonaRef = createDaytonaClient(DaytonaClass, config);

            try {
              sandbox = await daytonaRef.create();
            } catch (err) {
              return {
                healthy: false as const,
                message: `Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`,
              };
            }

            try {
              const response = await sandbox.process.executeCommand(
                "echo daytona-ok",
                "/home/daytona",
                undefined,
                config.timeoutSec,
              );

              if (response.exitCode === 0 && (response.result ?? "").includes("daytona-ok")) {
                return { healthy: true as const };
              }

              return {
                healthy: false as const,
                message: `Health check command failed (exit ${response.exitCode})`,
              };
            } finally {
              await cleanupSandbox();
            }
          })(),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), TIMEOUT);
          }),
        ]).finally(() => clearTimeout(timer!));

        const latencyMs = Math.round(performance.now() - start);
        if (result === "timeout") {
          await cleanupSandbox();
          return { healthy: false, message: `Health check timed out after ${TIMEOUT}ms`, latencyMs };
        }
        return { ...result, latencyMs };
      } catch (err) {
        await cleanupSandbox();
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
 * plugins: [daytonaSandboxPlugin({ apiKey: process.env.DAYTONA_API_KEY! })]
 * ```
 */
export const daytonaSandboxPlugin = createPlugin({
  configSchema: DaytonaSandboxConfigSchema,
  create: buildDaytonaSandboxPlugin,
});
