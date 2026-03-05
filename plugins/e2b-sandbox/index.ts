/**
 * E2B Sandbox Plugin — managed microVM isolation for @useatlas/plugin-sdk.
 *
 * Wraps the E2B sandbox API to run explore commands in an ephemeral
 * Firecracker microVM. Semantic layer files are uploaded into the sandbox
 * at creation time.
 *
 * **Security:** This plugin provides full microVM isolation:
 * - Network: isolated (E2B Firecracker microVM)
 * - Filesystem: ephemeral VM filesystem (no host access)
 * - User: unprivileged execution inside the VM
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { e2bSandboxPlugin } from "@atlas/plugin-e2b-sandbox";
 *
 * export default defineConfig({
 *   plugins: [
 *     e2bSandboxPlugin({ apiKey: process.env.E2B_API_KEY! }),
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
import * as path from "path";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const E2BSandboxConfigSchema = z.object({
  /** E2B API key. */
  apiKey: z.string().min(1, "E2B API key must not be empty"),
  /** Sandbox template ID (optional — uses default template when omitted). */
  template: z.string().optional(),
  /** Command timeout in seconds. */
  timeoutSec: z.number().int().positive().optional().default(30),
});

export type E2BSandboxConfig = z.infer<typeof E2BSandboxConfigSchema>;

// ---------------------------------------------------------------------------
// Lazy SDK loader
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadE2BSDK(): { Sandbox: any } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("e2b");
    return { Sandbox: mod.Sandbox };
  } catch (err) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    if (isNotFound) {
      throw new Error(
        "E2B support requires the e2b package. Install it with: bun add e2b",
      );
    }
    throw new Error(
      `Failed to load e2b: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Semantic file collector (adapted from explore-sandbox.ts)
// ---------------------------------------------------------------------------

function collectSemanticFiles(
  localDir: string,
  sandboxDir: string,
): { path: string; data: string }[] {
  const results: { path: string; data: string }[] = [];

  function walk(dir: string, relative: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const localPath = path.join(dir, entry.name);
      const remotePath = `${relative}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        try {
          const realPath = fs.realpathSync(localPath);
          if (!realPath.startsWith(localDir)) {
            console.warn(`[e2b-sandbox] Skipping symlink escaping semantic root: ${localPath} -> ${realPath}`);
            continue;
          }
          const stat = fs.statSync(localPath);
          if (stat.isDirectory()) {
            walk(localPath, remotePath);
          } else if (stat.isFile()) {
            results.push({
              path: remotePath,
              data: fs.readFileSync(localPath, "utf-8"),
            });
          }
        } catch {
          continue;
        }
      } else if (entry.isDirectory()) {
        walk(localPath, remotePath);
      } else if (entry.isFile()) {
        try {
          results.push({
            path: remotePath,
            data: fs.readFileSync(localPath, "utf-8"),
          });
        } catch {
          continue;
        }
      }
    }
  }

  walk(localDir, sandboxDir);
  return results;
}

// ---------------------------------------------------------------------------
// Shared helper — create an E2B sandbox instance
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createE2BSandbox(config: E2BSandboxConfig): Promise<any> {
  const { Sandbox: SandboxClass } = loadE2BSDK();

  return SandboxClass.create({
    apiKey: config.apiKey,
    ...(config.template ? { template: config.template } : {}),
  });
}

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

export function buildE2BSandboxPlugin(
  config: E2BSandboxConfig,
): AtlasSandboxPlugin<E2BSandboxConfig> {
  return {
    id: "e2b-sandbox",
    type: "sandbox" as const,
    version: "0.1.0",
    name: "E2B Sandbox",
    config,

    sandbox: {
      async create(semanticRoot: string): Promise<PluginExploreBackend> {
        const sandbox = await createE2BSandbox(config);

        try {
          // Collect and upload semantic layer files
          const files = collectSemanticFiles(semanticRoot, "semantic");

          if (files.length > 0) {
            await sandbox.files.write(files);
          }
        } catch (err) {
          // Clean up sandbox on file upload failure
          try {
            await sandbox.kill();
          } catch {
            // Ignore cleanup errors
          }
          throw new Error(
            `Failed to upload semantic files to E2B sandbox: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }

        return {
          exec: async (command: string): Promise<PluginExecResult> => {
            try {
              const result = await sandbox.commands.run(command, {
                cwd: "/home/user/semantic",
                timeout: config.timeoutSec,
              });
              return {
                stdout: result.stdout ?? "",
                stderr: result.stderr ?? "",
                exitCode: result.exitCode ?? 1,
              };
            } catch (err) {
              return {
                stdout: "",
                stderr: err instanceof Error ? err.message : String(err),
                exitCode: 1,
              };
            }
          },
          close: async (): Promise<void> => {
            try {
              await sandbox.kill();
            } catch {
              // Ignore cleanup errors
            }
          },
        };
      },
      priority: 90,
    },

    security: {
      networkIsolation: true,
      filesystemIsolation: true,
      unprivilegedExecution: true,
      description:
        "E2B Firecracker microVM (managed). Ephemeral VM with isolated " +
        "network and filesystem. Semantic files uploaded at sandbox creation.",
    },

    async initialize(ctx) {
      ctx.logger.info("E2B sandbox plugin initialized");
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      try {
        const sandbox = await createE2BSandbox(config);
        await sandbox.kill();
        return {
          healthy: true,
          latencyMs: Math.round(performance.now() - start),
        };
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
 * plugins: [e2bSandboxPlugin({ apiKey: process.env.E2B_API_KEY! })]
 * ```
 */
export const e2bSandboxPlugin = createPlugin({
  configSchema: E2BSandboxConfigSchema,
  create: buildE2BSandboxPlugin,
});
