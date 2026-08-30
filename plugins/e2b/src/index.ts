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
  createFileTransportPythonBackend,
  directoryEntryNames,
  enforcePythonEgress,
  installPythonPackages,
  isNotFoundSdkError,
  requireSandboxMethod,
  runHealthCheckWithTimeout,
  shellQuote,
} from "@useatlas/plugin-sdk";
import type {
  AtlasSandboxPlugin,
  EnforceablePythonEgress,
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

const E2BSandboxConfigSchema = z.object({
  /** E2B API key. */
  apiKey: z.string().min(1, "E2B API key must not be empty"),
  /** Sandbox template ID (optional — uses default template when omitted). */
  template: z.string().optional(),
  /** Command timeout in seconds. */
  timeoutSec: z.number().int().positive().optional().default(30),
  /**
   * Packages installed into the sandbox before the first Python execution.
   * Set to `[]` when the configured `template` already bakes them in — the
   * install is the slowest part of a cold Python run.
   */
  pythonPackages: z
    .array(z.string())
    .optional()
    .default(["pandas", "numpy", "matplotlib", "scipy", "scikit-learn", "statsmodels"]),
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
// Python execution (#4665)
// ---------------------------------------------------------------------------

/** The sandbox directory Python executions are staged under. */
const E2B_PYTHON_WORK_DIR = "/home/user/atlas-python";

/**
 * Apply the host's per-request egress bound to a live E2B sandbox.
 *
 * `updateNetwork` is the *post-create* form deliberately: the sandbox has to
 * reach PyPI for `installPythonPackages` before it is narrowed. The update
 * replaces the egress configuration atomically — every field omitted here is
 * cleared server-side, which is what makes this a bound rather than an addition
 * to whatever the sandbox already carried.
 *
 * `deny-all` goes through `allowInternetAccess: false`, which E2B documents as
 * equivalent to denying `0.0.0.0/0`. An allowlist sends the datasource hosts as
 * `allowOut` — which accepts bare domain names — over a deny of everything.
 *
 * ⚠️ The deny half asks the SDK for its own `allTraffic` token via the callback
 * form rather than naming a CIDR. Today that token is exactly `"0.0.0.0/0"`, and
 * the 2.45.0 surface has no IPv6 notion at all — but a hardcoded IPv4 CIDR is
 * the kind of literal that stays IPv4 after the provider grows a second address
 * family, leaving an allowlisted sandbox unbounded over the new one. Deferring
 * to the SDK's constant means that widening arrives with the dependency bump.
 * The deny half must be addresses either way: E2B's schema states that "domain
 * names are not supported for deny rules". Pairing it with `allowOut` is
 * unambiguous rather than a guess about rule ordering — the same schema states
 * that "allowed entries always take precedence over denied entries".
 *
 * Verified against `e2b` 2.45.0; the peer range requires it.
 */
async function applyE2BEgress(
  // The provider SDK is an optional peer dependency loaded through `require`,
  // so it carries no compile-time types here — the same reason every other
  // sandbox handle in this file is `any`.
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  sandbox: any,
  policy: EnforceablePythonEgress,
): Promise<void> {
  requireSandboxMethod(sandbox, "updateNetwork", "e2b", ">=2.45.0");
  if (policy.mode === "deny-all") {
    await sandbox.updateNetwork({ allowInternetAccess: false });
    return;
  }
  await sandbox.updateNetwork({
    allowOut: [...policy.hosts],
    denyOut: ({ allTraffic }: { allTraffic: string }) => [allTraffic],
  });
}

/**
 * Adapt an E2B sandbox to the SDK's {@link PythonSandboxSession} primitives.
 * The file-transport protocol itself (argv order, env vars, chart readback,
 * output cap, timeout) lives in the SDK — this only maps four operations onto
 * the E2B API.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
function e2bPythonSession(
  sandbox: any,
  log?: { warn(msg: string): void },
): PythonSandboxSession {
  return {
    workDir: E2B_PYTHON_WORK_DIR,
    async mkdir(path: string): Promise<void> {
      await sandbox.files.makeDir(path);
    },
    async writeFile(path: string, content: string): Promise<void> {
      await sandbox.files.write(path, content);
    },
    async run(
      command: string,
      args: string[],
      env: Record<string, string>,
      timeoutMs: number,
    ): Promise<PythonSandboxRunResult> {
      const line = [command, ...args].map(shellQuote).join(" ");
      try {
        const result = await sandbox.commands.run(line, {
          cwd: E2B_PYTHON_WORK_DIR,
          envs: env,
          timeoutMs,
        });
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? 0,
        };
      } catch (err) {
        // E2B throws on non-zero exit. That is an ordinary Python failure, not
        // an infrastructure fault, and the wrapper's result file is usually
        // already written — so report it as a completed run and let the shared
        // backend decide from the result file, rather than tearing the sandbox
        // down and losing the diagnosis.
        const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
        if (typeof e?.exitCode === "number") {
          return {
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? e.message ?? "",
            exitCode: e.exitCode,
          };
        }
        throw err;
      }
    },
    async readFile(path: string): Promise<Uint8Array | null> {
      try {
        const bytes = await sandbox.files.read(path, { format: "bytes" });
        return bytes == null ? null : new Uint8Array(bytes);
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
        const entries = await sandbox.files.list(path);
        return directoryEntryNames(entries);
      } catch (err) {
        if (isNotFoundSdkError(err)) return [];
        throw err;
      }
    },
    async destroy(): Promise<void> {
      try {
        await sandbox.kill();
      } catch (err) {
        // Best-effort teardown: the sandbox is already being discarded and
        // E2B reaps it on its own timeout, so a failure here must not mask the
        // error that prompted the teardown — but it is still logged, because a
        // provider that never reaps leaks the org's sandboxes silently.
        (log ?? console).warn(
          `[e2b-sandbox] Failed to kill Python sandbox: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
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

      /**
       * Python execution on the org's own E2B account (#4665).
       *
       * Built per request (the host re-reads credentials on every Python call),
       * with the E2B sandbox itself created lazily on first `exec` by the
       * shared backend. The wrapper — and with it the in-sandbox import guard —
       * comes from the host in `options.wrapperSource`; this plugin supplies
       * transport only.
       */
      async createPython(options: PluginPythonOptions): Promise<PluginPythonBackend> {
        return createFileTransportPythonBackend(
          options,
          {
            providerName: "E2B",
            async createSession() {
              const sandbox = await createE2BSandbox(config);
              const session = e2bPythonSession(sandbox, log);
              try {
                await session.mkdir(E2B_PYTHON_WORK_DIR);
                await installPythonPackages(session, config.pythonPackages, "E2B", log);
                // After the install, before any agent code — see
                // `enforcePythonEgress` for why that ordering is the contract.
                await enforcePythonEgress(options.networkPolicy, "E2B", (policy) =>
                  applyE2BEgress(sandbox, policy),
                );
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
       * The host's per-request REST egress bound IS applied here, via
       * `sandbox.updateNetwork` after the package install and before any agent
       * code runs — see `applyE2BEgress`. Verified against the `e2b` SDK
       * 2.45.0, which is why the peer range requires it.
       *
       * This read `"unsupported"` until the re-verify on issue 4666: #5500
       * declared it on the basis that E2B exposed no per-sandbox host
       * allowlist, and by then it did.
       *
       * "Enforced" is upheld by failing closed, not by assuming the call
       * succeeds — a rejected policy (an outdated SDK, a deployment that does
       * not support egress rules) fails the Python run rather than downgrading
       * it silently.
       */
      pythonEgressControl: "enforced",
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
