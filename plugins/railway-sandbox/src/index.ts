/**
 * Railway Sandbox Plugin — ephemeral Railway microVM isolation for
 * @useatlas/plugin-sdk.
 *
 * Wraps the Railway Sandboxes SDK (`railway` package) to run explore
 * commands in an ephemeral Linux microVM on the same vendor Atlas's SaaS
 * deploys on. Semantic layer files are uploaded into the sandbox at
 * creation time (base64 over `exec` — the SDK has no bulk file API).
 *
 * **⚠ Security (read before adopting):** Railway Sandboxes offer only
 * `ISOLATED` (outbound internet via NAT) and `PRIVATE` (private network +
 * outbound internet) network modes — **neither blocks outbound egress**.
 * A compromised or malicious command can phone home. This is a strictly
 * weaker posture than a deny-all backend (e.g. Vercel Sandbox with
 * `networkPolicy: "deny-all"`), so this plugin is suitable for
 * single-tenant/self-hosted deployments that accept that trade-off, and is
 * NOT suitable for multi-tenant SaaS until Railway ships a no-egress mode.
 * See https://github.com/AtlasDevHQ/atlas/issues/3231.
 *
 * Usage in atlas.config.ts:
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { railwaySandboxPlugin } from "@useatlas/railway-sandbox";
 *
 * // On Railway (RAILWAY_API_TOKEN / RAILWAY_ENVIRONMENT_ID env fallback):
 * export default defineConfig({
 *   plugins: [railwaySandboxPlugin({})],
 * });
 *
 * // Explicit credentials:
 * export default defineConfig({
 *   plugins: [
 *     railwaySandboxPlugin({
 *       token: process.env.RAILWAY_API_TOKEN!,
 *       environmentId: process.env.RAILWAY_ENVIRONMENT_ID!,
 *     }),
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
// Sensitive pattern regex (subset of @atlas/api/lib/security.ts adapted for
// Railway API errors — plugins must not import from @atlas/api)
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS =
  /password|secret|credential|connection.?string|token|Authorization|Authentication failed/i;

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const RailwaySandboxConfigSchema = z.object({
  /** Railway API token. Falls back to RAILWAY_API_TOKEN when omitted. */
  token: z.string().min(1, "Railway token must not be empty").optional(),
  /** Railway environment ID to create sandboxes in. Falls back to RAILWAY_ENVIRONMENT_ID when omitted. */
  environmentId: z
    .string()
    .min(1, "Railway environment ID must not be empty")
    .optional(),
  /**
   * Idle-timeout backstop (minutes, 1–120). Railway destroys the sandbox
   * after this much idle time even if close() never runs — keeps leaked
   * sandboxes from billing indefinitely. close() destroys eagerly; this is
   * the safety net.
   */
  idleTimeoutMinutes: z.number().int().min(1).max(120).optional().default(10),
  /** Command timeout in seconds. */
  timeoutSec: z.number().int().positive().optional().default(30),
});

export type RailwaySandboxConfig = z.infer<typeof RailwaySandboxConfigSchema>;

// ---------------------------------------------------------------------------
// Structural SDK types (the `railway` package is an optional peer — we never
// import its types; this local structural shape is the contract)
// ---------------------------------------------------------------------------

// Fields optional defensively: the SDK is beta ("may change in breaking ways
// between releases") and the backend must degrade to an error result, never
// crash, if a field goes missing.
interface RailwayExecResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  timedOut?: boolean;
}

interface RailwaySandboxInstance {
  exec(
    command: string,
    opts?: { timeoutSec?: number },
  ): Promise<RailwayExecResult>;
  destroy(): Promise<void>;
}

interface RailwaySandboxConstructor {
  create(opts?: Record<string, unknown>): Promise<RailwaySandboxInstance>;
}

// ---------------------------------------------------------------------------
// Lazy import helper
// ---------------------------------------------------------------------------

/**
 * Lazily load the `railway` SDK via dynamic `import()` so the peer dependency
 * stays optional at install time (matches the @vercel/sandbox loader pattern).
 */
async function loadRailwaySdk(): Promise<{ Sandbox: RailwaySandboxConstructor }> {
  try {
    return (await import("railway")) as unknown as {
      Sandbox: RailwaySandboxConstructor;
    };
  } catch (err) {
    const code =
      err != null && typeof err === "object" && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    const isNotFound =
      code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
    // Only surface the install hint when the missing module is THIS package, not
    // a transitive dep that failed to load (same not-found code, different named
    // module). Node and bun both name the missing request quoted in the message.
    const ownPackageMissing =
      isNotFound &&
      (err instanceof Error ? err.message : String(err)).includes("'railway'");
    if (ownPackageMissing) {
      throw new Error(
        "Railway Sandbox requires the railway package. " +
          "Install it with: bun add railway",
        { cause: err },
      );
    }
    throw new Error(
      `Failed to load railway: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Semantic file collection (mirrors explore-sandbox.ts; symlink-escape guarded)
// ---------------------------------------------------------------------------

export function collectSemanticFiles(
  localDir: string,
  sandboxDir: string,
  logger?: { warn(msg: string): void },
): { path: string; content: Buffer }[] {
  const results: { path: string; content: Buffer }[] = [];

  function walk(dir: string, relative: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      logger?.warn(`[railway-sandbox] Skipping unreadable directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const entry of entries) {
      const localPath = path.join(dir, entry.name);
      const remotePath = `${relative}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        try {
          const realPath = fs.realpathSync(localPath);
          if (!realPath.startsWith(localDir)) {
            logger?.warn(`[railway-sandbox] Skipping symlink escaping semantic root: ${localPath} -> ${realPath}`);
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
        } catch (err) {
          logger?.warn(`[railway-sandbox] Skipping unreadable symlink ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (entry.isDirectory()) {
        walk(localPath, remotePath);
      } else if (entry.isFile()) {
        try {
          results.push({
            path: remotePath,
            content: fs.readFileSync(localPath),
          });
        } catch (err) {
          logger?.warn(`[railway-sandbox] Skipping unreadable file ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  walk(localDir, sandboxDir);
  return results;
}

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------

// Sandboxes boot from a clean Debian base; we own the layout under /atlas.
const SANDBOX_ROOT_DIR = "/atlas";
const SANDBOX_SEMANTIC_DIR = "/atlas/semantic";

// The SDK has no bulk file API ("use exec or SSH" per Railway docs), so files
// travel as base64 inside exec commands. Keep each command comfortably under
// API payload limits; base64 inflates content 4/3.
const UPLOAD_BATCH_MAX_CHARS = 180_000;
// Uploads can carry the whole semantic tree — give them more headroom than
// a single explore command gets.
const UPLOAD_TIMEOUT_SEC = 120;

/** POSIX single-quote a string for safe embedding in a shell command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Build the per-file upload lines, batched to stay under the command-size cap. */
export function buildUploadBatches(
  files: { path: string; content: Buffer }[],
): string[] {
  const batches: string[] = [];
  let lines: string[] = [];
  let size = 0;

  for (const f of files) {
    const b64 = f.content.toString("base64");
    const line = `printf '%s' '${b64}' | base64 -d > ${shellQuote(`${SANDBOX_ROOT_DIR}/${f.path}`)}`;
    if (size + line.length > UPLOAD_BATCH_MAX_CHARS && lines.length > 0) {
      batches.push(`set -e\n${lines.join("\n")}`);
      lines = [];
      size = 0;
    }
    lines.push(line);
    size += line.length;
  }
  if (lines.length > 0) {
    batches.push(`set -e\n${lines.join("\n")}`);
  }
  return batches;
}

async function uploadSemanticFiles(
  sandbox: RailwaySandboxInstance,
  files: { path: string; content: Buffer }[],
): Promise<void> {
  // mkdir -p every leaf directory first (creates parents).
  const dirs = [
    ...new Set(
      files.map((f) => path.posix.dirname(`${SANDBOX_ROOT_DIR}/${f.path}`)),
    ),
  ].sort();
  const commands = [
    `mkdir -p ${dirs.map(shellQuote).join(" ")}`,
    ...buildUploadBatches(files),
  ];

  for (const command of commands) {
    const res = await sandbox.exec(command, { timeoutSec: UPLOAD_TIMEOUT_SEC });
    if (res.exitCode !== 0) {
      const detail = res.stderr || res.stdout || `exit ${res.exitCode}`;
      const safeDetail = SENSITIVE_PATTERNS.test(detail)
        ? "sandbox error (details in server logs)"
        : detail.slice(0, 500);
      throw new Error(
        `Failed to upload semantic files to Railway sandbox: ${safeDetail}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Error shaping
// ---------------------------------------------------------------------------

/**
 * Railway caps sandboxes per *environment* (Trial/Free 10, Hobby 50,
 * Pro/Enterprise 100; only CREATING/RUNNING count). The SDK's error text for
 * the cap is undocumented, so this matches broadly and the create error
 * always explains the cap when it looks limit-shaped.
 */
function looksLikeSandboxCap(detail: string): boolean {
  return /limit|cap(ped)?\b|maximum|too many/i.test(detail);
}

function createErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const safeDetail = SENSITIVE_PATTERNS.test(detail)
    ? "Railway API error (details in server logs)"
    : detail;
  if (looksLikeSandboxCap(detail)) {
    return (
      `Failed to create Railway sandbox: ${safeDetail}. ` +
      "Your Railway environment may have reached its sandbox cap " +
      "(10 on Trial/Free, 50 on Hobby, 100 on Pro/Enterprise — only CREATING/RUNNING sandboxes count). " +
      "Destroy idle sandboxes, wait for idle timeouts to reap them, or upgrade the plan."
    );
  }
  return (
    `Failed to create Railway sandbox: ${safeDetail}. ` +
    "Check RAILWAY_API_TOKEN / RAILWAY_ENVIRONMENT_ID (or the plugin's token/environmentId config) and your Railway plan's sandbox quota."
  );
}

function appendNote(stderr: string, note: string): string {
  return stderr ? `${stderr}\n[railway-sandbox] ${note}` : `[railway-sandbox] ${note}`;
}

// ---------------------------------------------------------------------------
// Backend factory
// ---------------------------------------------------------------------------

async function createRailwayExploreBackend(
  semanticRoot: string,
  config: RailwaySandboxConfig,
  log?: { warn(msg: string): void },
): Promise<PluginExploreBackend> {
  // 1. Load the optional dependency
  const { Sandbox } = await loadRailwaySdk();

  // 2. Collect semantic layer files BEFORE creating the sandbox — no point
  // paying for a microVM when the semantic dir is empty/unreadable.
  let files: { path: string; content: Buffer }[];
  try {
    files = collectSemanticFiles(semanticRoot, "semantic", log);
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

  // 3. Create the sandbox. ISOLATED is the most restrictive mode Railway
  // offers — outbound internet egress is still allowed (see module docs).
  // PRIVATE is never used here: the explore tool must not reach other
  // services on the Railway private network.
  const createOpts: Record<string, unknown> = {
    networkIsolation: "ISOLATED",
    idleTimeoutMinutes: config.idleTimeoutMinutes,
  };
  if (config.token) createOpts.token = config.token;
  if (config.environmentId) createOpts.environmentId = config.environmentId;

  let sandbox: RailwaySandboxInstance;
  try {
    sandbox = await Sandbox.create(createOpts);
  } catch (err) {
    throw new Error(createErrorMessage(err), { cause: err });
  }

  const destroyQuietly = async (context: string) => {
    try {
      await sandbox.destroy();
    } catch (destroyErr) {
      log?.warn(
        `[railway-sandbox] Failed to destroy sandbox ${context}: ${
          destroyErr instanceof Error ? destroyErr.message : String(destroyErr)
        }`,
      );
    }
  };

  // 4. Upload the semantic tree; tear the sandbox down if the upload fails
  // so a half-initialized microVM never lingers (and never bills past the
  // idle backstop).
  try {
    await uploadSemanticFiles(sandbox, files);
  } catch (err) {
    await destroyQuietly("after upload failure");
    throw err instanceof Error
      ? err
      : new Error(`Failed to upload semantic files: ${String(err)}`);
  }

  return {
    exec: async (command: string): Promise<PluginExecResult> => {
      try {
        // exec() has no cwd option — run the command in a child shell whose
        // cwd is the semantic dir, preserving the command's own semantics
        // (`;`, `&&`, pipes) exactly as the cwd-native backends do.
        const wrapped = `cd ${shellQuote(SANDBOX_SEMANTIC_DIR)} && sh -c ${shellQuote(command)}`;
        const result = await sandbox.exec(wrapped, {
          timeoutSec: config.timeoutSec,
        });
        let stderr = result.stderr ?? "";
        if (result.timedOut) {
          stderr = appendNote(stderr, `command timed out after ${config.timeoutSec}s`);
        }
        if (result.truncated) {
          stderr = appendNote(stderr, "output truncated by Railway");
        }
        return {
          stdout: result.stdout ?? "",
          stderr,
          exitCode: result.exitCode ?? 1,
        };
      } catch (err) {
        log?.warn(`[railway-sandbox] Sandbox exec error: ${err instanceof Error ? err.message : String(err)}`);
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        };
      }
    },
    close: async () => {
      await destroyQuietly("on close");
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

export function buildRailwaySandboxPlugin(
  config: RailwaySandboxConfig,
): AtlasSandboxPlugin<RailwaySandboxConfig> {
  let log: { warn(msg: string): void } | undefined;

  return {
    id: "railway-sandbox",
    types: ["sandbox"] as const,
    version: "0.1.0",
    name: "Railway Sandbox",
    config,

    sandbox: {
      async create(semanticRoot: string): Promise<PluginExploreBackend> {
        return createRailwayExploreBackend(semanticRoot, config, log);
      },
      priority: 80,
    },

    security: {
      // Honest: Railway has no deny-all mode. ISOLATED still allows outbound
      // internet via NAT — a data-exfiltration vector under crafted input.
      networkIsolation: false,
      filesystemIsolation: true,
      unprivilegedExecution: false,
      description:
        "Railway ephemeral microVM (ISOLATED mode). Filesystem is ephemeral and " +
        "isolated, but outbound internet egress is NOT blocked — Railway has no " +
        "deny-all network mode. Suitable for single-tenant/self-hosted use; not " +
        "for multi-tenant SaaS until Railway ships a no-egress mode.",
    },

    async initialize(ctx) {
      log = ctx.logger;
      const mode = config.token
        ? "explicit token"
        : "RAILWAY_API_TOKEN env fallback";
      ctx.logger.info(`Railway sandbox plugin initialized (auth: ${mode})`);
      ctx.logger.warn(
        "Railway sandboxes cannot block outbound network egress (no deny-all mode) — " +
          "explore commands can reach the internet. Do not use for multi-tenant deployments.",
      );
    },

    // Note: each health check creates (and destroys) a Railway sandbox.
    // Avoid calling at high frequency — creations bill and count toward the
    // per-environment sandbox cap.
    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      const TIMEOUT = 30_000;
      // The timeout race can win while the IIFE is still mid-create/exec, so
      // keep an explicit reference and destroy in every branch (same rationale
      // as the vercel-sandbox plugin's health check).
      let sandbox: RailwaySandboxInstance | null = null;
      let timer: ReturnType<typeof setTimeout>;
      const destroyQuietly = async (sb: RailwaySandboxInstance) => {
        try {
          await sb.destroy();
        } catch (destroyErr) {
          log?.warn(
            `[railway-sandbox] Failed to destroy health-check sandbox: ${
              destroyErr instanceof Error ? destroyErr.message : String(destroyErr)
            }`,
          );
        }
      };
      try {
        const result = await Promise.race([
          (async () => {
            const { Sandbox } = await loadRailwaySdk();

            const createOpts: Record<string, unknown> = {
              networkIsolation: "ISOLATED",
              // Short backstop — a health-check sandbox should never outlive
              // its check by more than a minute even if destroy() fails.
              idleTimeoutMinutes: 1,
            };
            if (config.token) createOpts.token = config.token;
            if (config.environmentId) createOpts.environmentId = config.environmentId;

            sandbox = await Sandbox.create(createOpts);
            const res = await sandbox.exec("echo railway-ok", {
              timeoutSec: config.timeoutSec,
            });
            await destroyQuietly(sandbox);
            sandbox = null;

            if (res.exitCode === 0 && (res.stdout ?? "").includes("railway-ok")) {
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
          // Best-effort cleanup — the IIFE may still be mid-create. Cast needed:
          // TS narrows `sandbox` to null (the IIFE ends with sandbox = null) but
          // the race means it may not have run to completion.
          const sb = sandbox as RailwaySandboxInstance | null;
          if (sb) await destroyQuietly(sb);
          return { healthy: false, message: `Health check timed out after ${TIMEOUT}ms`, latencyMs };
        }
        return { ...result, latencyMs };
      } catch (err) {
        const sb = sandbox as RailwaySandboxInstance | null;
        if (sb) await destroyQuietly(sb);
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
 * // On Railway (env fallback):
 * plugins: [railwaySandboxPlugin({})]
 *
 * // Explicit credentials:
 * plugins: [railwaySandboxPlugin({ token: "...", environmentId: "..." })]
 * ```
 */
export const railwaySandboxPlugin = createPlugin({
  configSchema: RailwaySandboxConfigSchema,
  create: buildRailwaySandboxPlugin,
});
