/**
 * Railway Sandbox Plugin — ephemeral Railway microVM isolation for
 * @useatlas/plugin-sdk.
 *
 * Wraps the Railway Sandboxes SDK (`railway` package) to run explore
 * commands in an ephemeral Linux microVM on the same vendor Atlas's SaaS
 * deploys on. Semantic layer files are uploaded into the sandbox at
 * creation time via the native, binary-safe `sandbox.files` API (write +
 * mkdir; streamed, no shell — requires railway >= 3.3.0).
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

// Native binary-safe file surface (railway >= 3.3.0). We declare only the two
// operations the upload path needs; `write` accepts a Uint8Array (a Node Buffer
// at runtime, which the SDK accepts) and auto-creates parent directories,
// `mkdir` is `mkdir -p`. Optional defensively: an older SDK exposes no `files`
// getter, which the backend turns into a clear install-hint error rather than a
// crash.
interface RailwaySandboxFiles {
  write(path: string, content: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
}

interface RailwaySandboxInstance {
  exec(
    command: string,
    opts?: { timeoutSec?: number },
  ): Promise<RailwayExecResult>;
  files?: RailwaySandboxFiles;
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

// The semantic-tree walker (with its symlink-escape guard, the canonical
// path.relative-based containment check this plugin originated) now lives in
// @useatlas/plugin-sdk — `collectSemanticFiles` — shared across sandbox plugins.

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------

// Sandboxes boot from a clean Debian base; we own the layout under /atlas.
const SANDBOX_ROOT_DIR = "/atlas";
const SANDBOX_SEMANTIC_DIR = "/atlas/semantic";

/** POSIX single-quote a string for safe embedding in a shell command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function uploadSemanticFiles(
  sandbox: RailwaySandboxInstance,
  files: { path: string; content: Uint8Array }[],
): Promise<void> {
  // The native files API (railway >= 3.3.0) is binary-safe, streamed, and
  // creates parent dirs on write — none of the old base64-over-exec machinery
  // is needed. An older SDK exposes no `files` getter; surface a clear install
  // hint rather than crashing on a missing property.
  const sandboxFiles = sandbox.files;
  if (!sandboxFiles) {
    throw new Error(
      "Railway sandbox file API unavailable: sandbox.files requires " +
        "railway >= 3.3.0. Upgrade with: bun add railway@latest",
    );
  }

  try {
    // mkdir the semantic root up front so the explore cwd exists even before
    // the first file lands; files.write auto-creates the per-file parent dirs.
    await sandboxFiles.mkdir(SANDBOX_SEMANTIC_DIR);
    for (const f of files) {
      await sandboxFiles.write(`${SANDBOX_ROOT_DIR}/${f.path}`, f.content);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const safeDetail = SENSITIVE_PATTERNS.test(detail)
      ? "sandbox error (details in server logs)"
      : detail.slice(0, 500);
    throw new Error(
      `Failed to upload semantic files to Railway sandbox: ${safeDetail}`,
      { cause: err },
    );
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
// Shared sandbox helpers
// ---------------------------------------------------------------------------

/**
 * Build Sandbox.create() options. ISOLATED is the most restrictive mode
 * Railway offers — outbound internet egress is still allowed (see module
 * docs). PRIVATE is never used: the explore tool must not reach other
 * services on the Railway private network.
 */
function buildCreateOpts(
  config: RailwaySandboxConfig,
  idleTimeoutMinutes: number,
): Record<string, unknown> {
  const createOpts: Record<string, unknown> = {
    networkIsolation: "ISOLATED",
    idleTimeoutMinutes,
  };
  if (config.token) createOpts.token = config.token;
  if (config.environmentId) createOpts.environmentId = config.environmentId;
  return createOpts;
}

/** Destroy a sandbox, logging (never throwing) on failure. */
async function destroyQuietly(
  sandbox: RailwaySandboxInstance,
  log: { warn(msg: string): void } | undefined,
  context: string,
): Promise<void> {
  try {
    await sandbox.destroy();
  } catch (destroyErr) {
    log?.warn(
      `[railway-sandbox] Failed to destroy sandbox ${context}: ${
        destroyErr instanceof Error ? destroyErr.message : String(destroyErr)
      }`,
    );
  }
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
  let files: { path: string; content: Uint8Array }[];
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

  // 3. Create the sandbox (ISOLATED mode — see buildCreateOpts).
  let sandbox: RailwaySandboxInstance;
  try {
    sandbox = await Sandbox.create(buildCreateOpts(config, config.idleTimeoutMinutes));
  } catch (err) {
    throw new Error(createErrorMessage(err), { cause: err });
  }

  // 4. Upload the semantic tree; tear the sandbox down if the upload fails
  // so a half-initialized microVM never lingers (and never bills past the
  // idle backstop).
  try {
    await uploadSemanticFiles(sandbox, files);
  } catch (err) {
    await destroyQuietly(sandbox, log, "after upload failure");
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
      await destroyQuietly(sandbox, log, "on close");
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
      // The timeout race can win while the probe is still mid-create/exec, so
      // keep an explicit reference and destroy in every failing branch (same
      // rationale as the shared runHealthCheckWithTimeout helper's docs).
      let sandbox: RailwaySandboxInstance | null = null;
      return runHealthCheckWithTimeout(
        async () => {
          const { Sandbox } = await loadRailwaySdk();

          // Short backstop — a health-check sandbox should never outlive
          // its check by more than a minute even if destroy() fails.
          sandbox = await Sandbox.create(buildCreateOpts(config, 1));
          const res = await sandbox.exec("echo railway-ok", {
            timeoutSec: config.timeoutSec,
          });
          await destroyQuietly(sandbox, log, "after health check");
          sandbox = null;

          if (res.exitCode === 0 && (res.stdout ?? "").includes("railway-ok")) {
            return { healthy: true };
          }
          return {
            healthy: false,
            message: `Sandbox test command failed (exit ${res.exitCode ?? "unknown"})`,
          };
        },
        {
          timeoutMs: 30_000,
          logger: log,
          cleanup: async () => {
            // Best-effort cleanup — the probe may still be mid-create. Cast
            // needed: TS narrows `sandbox` to null (the probe ends with
            // sandbox = null) but the race means it may not have run.
            const sb = sandbox as RailwaySandboxInstance | null;
            if (sb) {
              await destroyQuietly(sb, log, "after health-check failure");
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
