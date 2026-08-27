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
import {
  createPlugin,
  collectSemanticFiles,
  createFileTransportPythonBackend,
  directoryEntryNames,
  installPythonPackages,
  isNotFoundSdkError,
  runHealthCheckWithTimeout,
  shellQuote,
} from "@useatlas/plugin-sdk";
import type {
  AtlasSandboxPlugin,
  PluginExploreBackend,
  PluginExecResult,
  PluginHealthResult,
  PluginPythonBackend,
  PluginPythonOptions,
  PythonSandboxRunResult,
  PythonSandboxSession,
} from "@useatlas/plugin-sdk";

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
  /**
   * Daytona target region for created sandboxes (e.g. `"us"`, `"eu"`). This is
   * the field that makes a Daytona BYOC connection a residency answer rather
   * than only an isolation one — both explore and Python land where it says.
   * Omitted means the Daytona account's own default.
   */
  target: z.string().optional(),
  /**
   * Packages installed into the sandbox before the first Python execution.
   * Set to `[]` when the configured Daytona image already bakes them in — the
   * install is the slowest part of a cold Python run.
   */
  pythonPackages: z
    .array(z.string())
    .optional()
    .default(["pandas", "numpy", "matplotlib", "scipy", "scikit-learn", "statsmodels"]),
});

export type DaytonaSandboxConfig = z.infer<typeof DaytonaSandboxConfigSchema>;

// ---------------------------------------------------------------------------
// Lazy SDK loader
// ---------------------------------------------------------------------------

/** Lazy-load the Daytona SDK, or throw with a helpful message. */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
function loadDaytonaSdk(): any {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  let DaytonaClass: any;
  try {
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    ({ Daytona: DaytonaClass } = require("@daytonaio/sdk"));
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
      (err instanceof Error ? err.message : String(err)).includes(
        "'@daytonaio/sdk'",
      );
    if (ownPackageMissing) {
      throw new Error(
        "Daytona support requires the @daytonaio/sdk package. Install it with: bun add @daytonaio/sdk",
        { cause: err },
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
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
function createDaytonaClient(DaytonaClass: any, config: DaytonaSandboxConfig): any {
  return new DaytonaClass({
    apiKey: config.apiKey,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
  });
}

/**
 * Parameters for `daytona.create()`. Carries the region `target` when
 * configured, so explore and Python land in the same place — a Daytona
 * connection is only a residency answer if BOTH tools honour it.
 */
function daytonaCreateParams(config: DaytonaSandboxConfig): Record<string, unknown> {
  return config.target ? { target: config.target } : {};
}

// The semantic-tree walker (with its symlink-escape guard) now lives in
// @useatlas/plugin-sdk — `collectSemanticFiles` — returning binary-safe
// `{ path, content: Uint8Array }` tuples (a Node Buffer at runtime) that
// daytona uploads via fs.uploadFile.

// ---------------------------------------------------------------------------
// Python execution (#4665)
// ---------------------------------------------------------------------------

/** The sandbox directory Python executions are staged under. */
const DAYTONA_PYTHON_WORK_DIR = "/home/daytona/atlas-python";

/**
 * Adapt a Daytona sandbox to the SDK's {@link PythonSandboxSession}
 * primitives. The file-transport protocol (argv order, env vars, chart
 * readback, output cap, timeout) lives in the SDK — this maps four operations
 * onto the Daytona API.
 */
function daytonaPythonSession(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  daytona: any,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  sandbox: any,
  log?: { warn(msg: string): void },
): PythonSandboxSession {
  const toBytes = (value: unknown): Uint8Array | null => {
    if (value == null) return null;
    if (value instanceof Uint8Array) return value;
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return null;
  };

  return {
    workDir: DAYTONA_PYTHON_WORK_DIR,
    async mkdir(path: string): Promise<void> {
      // `createFolder` is the typed API, but older SDK builds only ship the
      // process surface — fall back rather than fail the whole Python path on
      // a method name.
      if (typeof sandbox.fs?.createFolder === "function") {
        await sandbox.fs.createFolder(path, "755");
        return;
      }
      await sandbox.process.executeCommand(`mkdir -p ${shellQuote(path)}`);
    },
    async writeFile(path: string, content: string): Promise<void> {
      await sandbox.fs.uploadFile(Buffer.from(content, "utf-8"), path);
    },
    async run(
      command: string,
      args: string[],
      env: Record<string, string>,
      timeoutMs: number,
    ): Promise<PythonSandboxRunResult> {
      const line = [command, ...args].map(shellQuote).join(" ");
      const response = await sandbox.process.executeCommand(
        line,
        DAYTONA_PYTHON_WORK_DIR,
        env,
        Math.ceil(timeoutMs / 1000),
      );
      // Daytona merges the two streams into `result`. Reporting it as stdout
      // and leaving stderr empty would lose the only diagnosis available when
      // the wrapper never wrote a result file, so it goes to stderr on a
      // failing exit code and stdout otherwise.
      const merged = response.result ?? "";
      const exitCode = response.exitCode ?? 0;
      return {
        stdout: exitCode === 0 ? merged : "",
        stderr: exitCode === 0 ? "" : merged,
        exitCode,
      };
    },
    async readFile(path: string): Promise<Uint8Array | null> {
      try {
        return toBytes(await sandbox.fs.downloadFile(path));
      } catch (err) {
        // A missing result file is a normal outcome (the interpreter died
        // before the wrapper wrote one) and the shared backend handles `null`;
        // anything else is a real read failure and must propagate.
        if (isNotFoundSdkError(err)) return null;
        throw err;
      }
    },
    async listDir(path: string): Promise<string[]> {
      try {
        const entries = await sandbox.fs.listFiles(path);
        return directoryEntryNames(entries);
      } catch (err) {
        if (isNotFoundSdkError(err)) return [];
        throw err;
      }
    },
    async destroy(): Promise<void> {
      try {
        await daytona.delete(sandbox);
      } catch (err) {
        // Best-effort teardown: the sandbox is already being discarded, so a
        // failure here must not mask the error that prompted it — but it is
        // still logged, because a sandbox that is never deleted is a live cost
        // on the org's Daytona account. Uses the same `(log ?? console)` idiom
        // as this plugin's explore close().
        (log ?? console).warn(
          `[daytona-sandbox] Failed to delete Python sandbox: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
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
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any
        let sandbox: any;
        try {
          sandbox = await daytona.create(daytonaCreateParams(config));
        } catch (err) {
          throw new Error(
            `Failed to create Daytona sandbox: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }

        // Collect and upload semantic layer files
        try {
          const files = collectSemanticFiles(semanticRoot, "semantic", log);

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

      /**
       * Python execution on the org's own Daytona account (#4665).
       *
       * Built per request (the host re-reads credentials on every Python call),
       * with the Daytona sandbox created lazily on first `exec` by the shared
       * backend and placed in the configured `target` region. The wrapper — and
       * with it the in-sandbox import guard — comes from the host in
       * `options.wrapperSource`; this plugin supplies transport only.
       */
      async createPython(options: PluginPythonOptions): Promise<PluginPythonBackend> {
        return createFileTransportPythonBackend(
          options,
          {
            providerName: "Daytona",
            async createSession() {
              const DaytonaClass = loadDaytonaSdk();
              const daytona = createDaytonaClient(DaytonaClass, config);
              const sandbox = await daytona.create(daytonaCreateParams(config));
              const session = daytonaPythonSession(daytona, sandbox, log);
              try {
                await session.mkdir(DAYTONA_PYTHON_WORK_DIR);
                await installPythonPackages(session, config.pythonPackages, "Daytona", log);
              } catch (err) {
                await session.destroy();
                throw err;
              }
              return session;
            },
          },
          log,
        );
      },

      /**
       * Daytona sandboxes have outbound network access with no per-sandbox host
       * allowlist, so the host's per-request REST egress bound cannot be applied
       * here — declared rather than implied by omission (#4665). What Daytona
       * does control is placement: see `target`.
       */
      pythonEgressControl: "unsupported",
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      let sandbox: any = null;
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      let daytonaRef: any = null;

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

      return runHealthCheckWithTimeout(
        async () => {
          const DaytonaClass = loadDaytonaSdk();
          daytonaRef = createDaytonaClient(DaytonaClass, config);

          try {
            sandbox = await daytonaRef.create(daytonaCreateParams(config));
          } catch (err) {
            return {
              healthy: false,
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
              return { healthy: true };
            }

            return {
              healthy: false,
              message: `Health check command failed (exit ${response.exitCode})`,
            };
          } finally {
            await cleanupSandbox();
          }
        },
        { timeoutMs: 30_000, cleanup: cleanupSandbox, logger: log },
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
 * plugins: [daytonaSandboxPlugin({ apiKey: process.env.DAYTONA_API_KEY! })]
 * ```
 */
export const daytonaSandboxPlugin = createPlugin({
  configSchema: DaytonaSandboxConfigSchema,
  create: buildDaytonaSandboxPlugin,
});
