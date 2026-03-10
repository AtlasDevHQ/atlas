/**
 * Vercel Sandbox Plugin — extracts the built-in @vercel/sandbox explore
 * backend into a first-class AtlasSandboxPlugin.
 *
 * Supports two authentication modes:
 * - **Auto-detected OIDC** (default on Vercel) — no config needed
 * - **Access token** — pass `accessToken` + `teamId` for non-Vercel environments
 *
 * **Security:** Firecracker microVM with deny-all network policy.
 * Filesystem is ephemeral — writes do not affect the host.
 * Semantic layer files are copied in at creation time.
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { vercelSandboxPlugin } from "@useatlas/vercel-sandbox";
 *
 * // On Vercel (auto-detected OIDC):
 * export default defineConfig({
 *   plugins: [vercelSandboxPlugin({})],
 * });
 *
 * // Off Vercel (access token):
 * export default defineConfig({
 *   plugins: [vercelSandboxPlugin({ accessToken: "...", teamId: "team_..." })],
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
// Sensitive pattern regex (copied from @atlas/api/lib/security.ts —
// plugins must not import from @atlas/api)
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS =
  /password|secret|credential|connection.?string|pg_hba\.conf|SSL|certificate|Access denied for user|ER_ACCESS_DENIED_ERROR|ER_DBACCESS_DENIED_ERROR|ER_BAD_HOST_ERROR|ER_HOST_NOT_PRIVILEGED|ER_SPECIFIC_ACCESS_DENIED_ERROR|PROTOCOL_CONNECTION_LOST|Can't connect to MySQL server|Authentication failed|DB::Exception.*Authentication|UNKNOWN_USER|WRONG_PASSWORD|REQUIRED_PASSWORD|IP_ADDRESS_NOT_ALLOWED|ALL_CONNECTION_TRIES_FAILED|CLIENT_HAS_CONNECTED_TO_WRONG_PORT|AUTHENTICATION_FAILED|INVALID_SESSION_ID|LOGIN_MUST_USE_SECURITY_TOKEN|INVALID_LOGIN|INVALID_CLIENT_ID/i;

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const VercelSandboxConfigSchema = z
  .object({
    /** Access token for non-Vercel environments. Auto-detected OIDC used when omitted on Vercel. */
    accessToken: z.string().optional(),
    /** Team ID — required when using access token. */
    teamId: z.string().optional(),
  })
  .refine(
    (c) => !c.accessToken || c.teamId,
    "teamId is required when using accessToken",
  );

export type VercelSandboxConfig = z.infer<typeof VercelSandboxConfigSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an error for logging, with extra detail from @vercel/sandbox APIError json/text fields. */
export function sandboxErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const detail = err.message;
  // APIError from @vercel/sandbox carries json/text with the server response.
  const json = (err as unknown as Record<string, unknown>).json;
  const text = (err as unknown as Record<string, unknown>).text;
  if (json) {
    try {
      return `${detail} — response: ${JSON.stringify(json)}`;
    } catch {
      return `${detail} — response: [unserializable object]`;
    }
  }
  if (typeof text === "string" && text) return `${detail} — body: ${text.slice(0, 500)}`;
  return detail;
}

/** Recursively collect all files under `localDir` into `{ path, content }` tuples. */
export function collectSemanticFiles(
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
            // Symlink escapes semantic root — skip for safety
            continue;
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
          // Unreadable symlink — skip
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
          // Unreadable file — skip
        }
      }
    }
  }

  walk(localDir, sandboxDir);
  return results;
}

// Prefix for sandbox file paths: the SDK resolves relative paths under /vercel/sandbox/.
const SANDBOX_SEMANTIC_REL = "semantic";
// Must match the absolute resolution of SANDBOX_SEMANTIC_REL (used as runCommand cwd).
const SANDBOX_SEMANTIC_CWD = "/vercel/sandbox/semantic";

// ---------------------------------------------------------------------------
// Lazy import helper
// ---------------------------------------------------------------------------

/**
 * Lazily import @vercel/sandbox using require() so the peer dependency is
 * optional at install time.
 */
function loadSandboxModule(): { Sandbox: SandboxConstructor } {
  let mod: { Sandbox: SandboxConstructor };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("@vercel/sandbox");
  } catch (err) {
    const isNotFound =
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    if (isNotFound) {
      throw new Error(
        "Vercel Sandbox requires the @vercel/sandbox package. " +
          "Install it with: bun add @vercel/sandbox",
      );
    }
    throw new Error(
      `Failed to load @vercel/sandbox: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return mod;
}

// Minimal structural type for the Sandbox class from @vercel/sandbox.
// We avoid importing the real types since it's an optional peer dependency.
interface SandboxInstance {
  mkDir(path: string): Promise<void>;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  runCommand(opts: {
    cmd: string;
    args: string[];
    cwd: string;
  }): Promise<{
    stdout(): Promise<string>;
    stderr(): Promise<string>;
    exitCode: number;
  }>;
  stop(): Promise<void>;
}

interface SandboxConstructor {
  create(opts: Record<string, unknown>): Promise<SandboxInstance>;
}

// ---------------------------------------------------------------------------
// Backend factory
// ---------------------------------------------------------------------------

async function createVercelExploreBackend(
  semanticRoot: string,
  config: VercelSandboxConfig,
): Promise<PluginExploreBackend> {
  // 1. Load the optional dependency
  const { Sandbox } = loadSandboxModule();

  // 2. Create the sandbox
  const createOpts: Record<string, unknown> = {
    runtime: "node24",
    networkPolicy: "deny-all",
  };
  if (config.accessToken) {
    createOpts.accessToken = config.accessToken;
    createOpts.teamId = config.teamId;
  }

  let sandbox: SandboxInstance;
  try {
    sandbox = await Sandbox.create(createOpts);
  } catch (err) {
    const detail = sandboxErrorDetail(err);
    throw new Error(
      `Failed to create Vercel Sandbox: ${detail}. ` +
        "Check your Vercel deployment configuration and sandbox quotas.",
      { cause: err },
    );
  }

  try {
    // 3. Collect semantic layer files
    let files: { path: string; content: Buffer }[];
    try {
      files = collectSemanticFiles(semanticRoot, SANDBOX_SEMANTIC_REL);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot read semantic layer at ${semanticRoot}: ${detail}. ` +
          "Ensure the semantic/ directory exists and is readable.",
        { cause: err },
      );
    }

    if (files.length === 0) {
      throw new Error(
        "No semantic layer files found. " +
          "Run 'bun run atlas -- init' to generate a semantic layer, then redeploy.",
      );
    }

    // 4. Create directories and upload files
    const dirs = new Set<string>();
    for (const f of files) {
      let dir = path.posix.dirname(f.path);
      while (dir !== "/" && dir !== ".") {
        dirs.add(dir);
        dir = path.posix.dirname(dir);
      }
    }

    for (const dir of [...dirs].sort()) {
      try {
        await sandbox.mkDir(dir);
      } catch (err) {
        const detail = sandboxErrorDetail(err);
        const safeDetail = SENSITIVE_PATTERNS.test(detail)
          ? "sandbox API error (details in server logs)"
          : detail;
        throw new Error(
          `Failed to create directory "${dir}" in sandbox: ${safeDetail}.`,
          { cause: err },
        );
      }
    }

    try {
      await sandbox.writeFiles(files);
    } catch (err) {
      const detail = sandboxErrorDetail(err);
      const safeDetail = SENSITIVE_PATTERNS.test(detail)
        ? "sandbox API error (details in server logs)"
        : detail;
      throw new Error(
        `Failed to upload ${files.length} semantic files to sandbox: ${safeDetail}.`,
        { cause: err },
      );
    }
  } catch (err) {
    // Clean up the sandbox before re-throwing
    try {
      await sandbox.stop();
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }

  return {
    exec: async (command: string): Promise<PluginExecResult> => {
      try {
        const result = await sandbox.runCommand({
          cmd: "sh",
          args: ["-c", command],
          cwd: SANDBOX_SEMANTIC_CWD,
        });
        return {
          stdout: await result.stdout(),
          stderr: await result.stderr(),
          exitCode: result.exitCode,
        };
      } catch (err) {
        const detail = sandboxErrorDetail(err);
        // Stop the broken sandbox — it cannot be reused
        try {
          await sandbox.stop();
        } catch {
          // Swallow stop errors during cleanup
        }
        throw new Error(
          `Sandbox infrastructure error: ${detail}`,
          { cause: err },
        );
      }
    },
    close: async () => {
      try {
        await sandbox.stop();
      } catch {
        // Ignore close errors
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

export function buildVercelSandboxPlugin(
  config: VercelSandboxConfig,
): AtlasSandboxPlugin<VercelSandboxConfig> {
  return {
    id: "vercel-sandbox",
    types: ["sandbox"] as const,
    version: "0.1.0",
    name: "Vercel Sandbox",
    config,

    sandbox: {
      async create(semanticRoot: string): Promise<PluginExploreBackend> {
        return createVercelExploreBackend(semanticRoot, config);
      },
      priority: 100,
    },

    security: {
      networkIsolation: true,
      filesystemIsolation: true,
      unprivilegedExecution: false,
      description:
        "Firecracker microVM with deny-all network policy. " +
        "Ephemeral filesystem — writes do not affect the host. " +
        "Semantic layer files copied in at creation time.",
    },

    async initialize(ctx) {
      const mode = config.accessToken ? "access token" : "auto-detected OIDC";
      ctx.logger.info(`Vercel sandbox plugin initialized (auth: ${mode})`);
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      const TIMEOUT = 30_000;
      let sandbox: SandboxInstance | null = null;
      let timer: ReturnType<typeof setTimeout>;
      try {
        const result = await Promise.race([
          (async () => {
            const { Sandbox } = loadSandboxModule();

            const createOpts: Record<string, unknown> = {
              runtime: "node24",
              networkPolicy: "deny-all",
            };
            if (config.accessToken) {
              createOpts.accessToken = config.accessToken;
              createOpts.teamId = config.teamId;
            }

            sandbox = await Sandbox.create(createOpts);
            const res = await sandbox.runCommand({
              cmd: "sh",
              args: ["-c", "echo vercel-ok"],
              cwd: "/tmp",
            });
            const stdout = await res.stdout();
            await sandbox.stop();
            sandbox = null;

            if (res.exitCode === 0 && stdout.includes("vercel-ok")) {
              return { healthy: true as const };
            }
            return {
              healthy: false as const,
              message: `Sandbox test command failed (exit ${res.exitCode})`,
            };
          })(),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), TIMEOUT);
          }),
        ]).finally(() => clearTimeout(timer!));

        const latencyMs = Math.round(performance.now() - start);
        if (result === "timeout") {
          // Best-effort cleanup — sandbox may still be creating if create() is what's slow
          if (sandbox) {
            try { await sandbox.stop(); } catch { /* best-effort */ }
          }
          return { healthy: false, message: `Health check timed out after ${TIMEOUT}ms`, latencyMs };
        }
        return { ...result, latencyMs };
      } catch (err) {
        if (sandbox) {
          try { await sandbox.stop(); } catch { /* best-effort */ }
        }
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
 * // On Vercel (auto-detected OIDC):
 * plugins: [vercelSandboxPlugin({})]
 *
 * // Off Vercel (access token):
 * plugins: [vercelSandboxPlugin({ accessToken: "...", teamId: "team_..." })]
 * ```
 */
export const vercelSandboxPlugin = createPlugin({
  configSchema: VercelSandboxConfigSchema,
  create: buildVercelSandboxPlugin,
});
