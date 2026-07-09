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
 * import { e2bSandboxPlugin } from "@useatlas/e2b";
 *
 * export default defineConfig({
 *   plugins: [
 *     e2bSandboxPlugin({ apiKey: process.env.E2B_API_KEY! }),
 *   ],
 * });
 * ```
 */

import { z } from "zod";
import {
  createPlugin,
  collectSemanticFiles,
  runHealthCheckWithTimeout,
} from "@useatlas/plugin-sdk";
import type {
  AtlasSandboxPlugin,
  PluginExploreBackend,
  PluginExecResult,
  PluginHealthResult,
} from "@useatlas/plugin-sdk";

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

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
function loadE2BSDK(): { Sandbox: any } {
  try {
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("e2b");
    return { Sandbox: mod.Sandbox };
  } catch (err) {
    const isNotFound =
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    // Only surface the install hint when the missing module is THIS package, not
    // a transitive dep that failed to load (same MODULE_NOT_FOUND code, different
    // named module). Node and bun both name the missing request quoted in the
    // message, so a transitive failure won't match our own specifier.
    const ownPackageMissing =
      isNotFound &&
      (err instanceof Error ? err.message : String(err)).includes("'e2b'");
    if (ownPackageMissing) {
      throw new Error(
        "E2B support requires the e2b package. Install it with: bun add e2b",
        { cause: err },
      );
    }
    throw new Error(
      `Failed to load e2b: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// The semantic-tree walker (with its symlink-escape guard) now lives in
// @useatlas/plugin-sdk — `collectSemanticFiles`. E2B's `files.write` wants
// `{ path, data: string }`, so the call site decodes the shared `Uint8Array`
// content via `Buffer.from(content).toString("utf-8")`.

// ---------------------------------------------------------------------------
// Shared helper — create an E2B sandbox instance
// ---------------------------------------------------------------------------

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
  let log: { warn(msg: string): void } | undefined;

  return {
    id: "e2b-sandbox",
    types: ["sandbox"] as const,
    version: "0.1.0",
    name: "E2B Sandbox",
    config,

    sandbox: {
      async create(semanticRoot: string): Promise<PluginExploreBackend> {
        const sandbox = await createE2BSandbox(config);

        try {
          // Collect and upload semantic layer files. The shared collector is
          // binary-safe (Uint8Array content); E2B's files.write wants string
          // data, so decode each via Buffer.
          const files = collectSemanticFiles(semanticRoot, "semantic", log).map(
            (f) => ({ path: f.path, data: Buffer.from(f.content).toString("utf-8") }),
          );

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
      log = ctx.logger;
      ctx.logger.info("E2B sandbox plugin initialized");
    },

    async healthCheck(): Promise<PluginHealthResult> {
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      let sandbox: any = null;
      return runHealthCheckWithTimeout(
        async () => {
          sandbox = await createE2BSandbox(config);
          await sandbox.kill();
          sandbox = null;
          return { healthy: true };
        },
        {
          timeoutMs: 30_000,
          logger: log,
          cleanup: async () => {
            if (sandbox) {
              try {
                await sandbox.kill();
              } catch (err) {
                log?.warn(
                  `[e2b-sandbox] Failed to kill health-check sandbox: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
              sandbox = null;
            }
          },
        },
      );
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
