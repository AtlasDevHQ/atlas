/**
 * Semantic layer exploration tool.
 *
 * Abstracts the shell backend behind an ExploreBackend interface so the
 * explore tool works across five isolation levels:
 * - sandbox plugin: pluggable explore backend via the Plugin SDK (priority-sorted)
 * - @vercel/sandbox: ephemeral microVM with networkPolicy "deny-all" (Vercel)
 * - nsjail: Linux namespace sandbox (self-hosted Docker)
 * - sidecar: HTTP-isolated container with no secrets (Railway/Render)
 * - just-bash: OverlayFs ensures read-only access; writes stay in memory (dev, or production fallback)
 *
 * Runtime selection priority: sandbox plugin > Vercel sandbox > nsjail (explicit) > sidecar > nsjail (auto-detect) > just-bash.
 * A production warning is logged when falling back to just-bash.
 */

import { tool } from "ai";
import { z } from "zod";
import * as path from "path";
import { createLogger } from "@atlas/api/lib/logger";
import { withSpan } from "@atlas/api/lib/tracing";

/** Must match SANDBOX_DEFAULT_PRIORITY in @useatlas/plugin-sdk/types. */
const SANDBOX_DEFAULT_PRIORITY = 60;

const log = createLogger("explore");

const SEMANTIC_ROOT = path.resolve(process.cwd(), "semantic");

// --- Backend interface ---

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Shell backend for the explore tool.
 *
 * Implementations MUST provide read-only filesystem access scoped to the
 * semantic layer directory. Commands execute within /semantic as the working
 * directory. Writes should be silently discarded or cause errors, never
 * modify the host filesystem.
 */
export interface ExploreBackend {
  exec(command: string): Promise<ExecResult>;
  close?(): Promise<void>;
}

// --- Self-hosted backend (just-bash) ---

async function createBashBackend(
  semanticRoot: string
): Promise<ExploreBackend> {
  let Bash, OverlayFs;
  try {
    ({ Bash, OverlayFs } = await import("just-bash"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: detail }, "Failed to import just-bash");
    throw new Error(
      "Failed to load the just-bash runtime for the explore tool. " +
        "Ensure 'just-bash' is installed ('bun install'). " +
        "If running on Vercel, set ATLAS_RUNTIME=vercel.",
      { cause: err }
    );
  }

  const overlay = new OverlayFs({
    root: semanticRoot,
    mountPoint: "/semantic",
  });
  const bash = new Bash({
    fs: overlay,
    cwd: "/semantic",
    executionLimits: {
      maxCommandCount: 5000,
      maxLoopIterations: 1000,
    },
  });
  return {
    exec: async (command: string) => {
      const result = await bash.exec(command);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}

// --- Runtime detection ---

function useVercelSandbox(): boolean {
  return process.env.ATLAS_RUNTIME === "vercel" || !!process.env.VERCEL;
}

let _nsjailAvailable: boolean | null = null;

function useNsjail(): boolean {
  if (process.env.ATLAS_SANDBOX === "nsjail") return true;
  if (_nsjailAvailable !== null) return _nsjailAvailable;
  // Auto-detect nsjail on PATH (deferred require to avoid loading module at startup)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isNsjailAvailable } = require("./explore-nsjail");
    _nsjailAvailable = isNsjailAvailable();
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
    ) {
      _nsjailAvailable = false;
    } else {
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "Unexpected error loading explore-nsjail module",
      );
      _nsjailAvailable = false;
    }
  }
  return _nsjailAvailable ?? false;
}

function useSidecar(): boolean {
  return !!process.env.ATLAS_SANDBOX_URL;
}

/** Track nsjail init failures to avoid infinite retry loops. */
let _nsjailFailed = false;

/** Track sidecar init failures so the health endpoint reports accurately. */
let _sidecarFailed = false;

export type ExploreBackendType = "vercel-sandbox" | "nsjail" | "sidecar" | "just-bash" | "plugin";

/** Name of the active sandbox plugin (if any). Set during backend init. */
let _activeSandboxPluginId: string | null = null;

/** Returns the active sandbox plugin id (if any, for health/startup reporting). */
export function getActiveSandboxPluginId(): string | null {
  return _activeSandboxPluginId;
}

/**
 * Returns which explore backend is active (for health endpoint).
 *
 * Plugin detection is lazy — _activeSandboxPluginId is only set after the
 * first explore command triggers getExploreBackend(). Before that, this
 * function falls through to the built-in detection chain.
 */
export function getExploreBackendType(): ExploreBackendType {
  if (_activeSandboxPluginId) return "plugin";
  if (useVercelSandbox()) return "vercel-sandbox";
  // Explicit nsjail (ATLAS_SANDBOX=nsjail) — hard-fail if unavailable
  if (process.env.ATLAS_SANDBOX === "nsjail" && !_nsjailFailed) return "nsjail";
  // Sidecar takes priority over nsjail auto-detection (Railway/Render set ATLAS_SANDBOX_URL)
  if (useSidecar() && !_sidecarFailed) return "sidecar";
  // nsjail auto-detect (binary on PATH)
  if (!_nsjailFailed && useNsjail()) return "nsjail";
  return "just-bash";
}

let backendPromise: Promise<ExploreBackend> | null = null;

/** Clear cached backend so the next call recreates it. */
export function invalidateExploreBackend(): void {
  backendPromise = null;
  _activeSandboxPluginId = null;
}

/** Permanently mark nsjail as failed and clear the backend cache.
 *  Called from explore-nsjail.ts on exit code 109 (sandbox setup failure). */
export function markNsjailFailed(): void {
  _nsjailFailed = true;
  backendPromise = null;
}

/** Permanently mark the sidecar as failed so health reports "just-bash".
 *  Called from startup.ts when the sidecar health check fails. */
export function markSidecarFailed(): void {
  _sidecarFailed = true;
}

function getExploreBackend(): Promise<ExploreBackend> {
  if (!backendPromise) {
    backendPromise = (async (): Promise<ExploreBackend> => {
      // Priority 0: Sandbox plugins (sorted by priority, highest first)
      // Skipped when ATLAS_SANDBOX=nsjail — operator explicitly wants nsjail only
      if (process.env.ATLAS_SANDBOX !== "nsjail") {
        let sandboxPlugins: Array<{ id: string; [k: string]: unknown }> = [];
        try {
          const { plugins } = await import("@atlas/api/lib/plugins/registry");
          sandboxPlugins = plugins.getByType("sandbox");
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log.debug({ err: detail }, "Plugin registry not available for sandbox check");
        }

        if (sandboxPlugins.length > 0) {
          type SandboxShape = { sandbox: { create(root: string): Promise<ExploreBackend> | ExploreBackend; priority?: number } };
          const sorted = [...sandboxPlugins].sort((a, b) => {
            const pa = (a as unknown as SandboxShape).sandbox.priority ?? SANDBOX_DEFAULT_PRIORITY;
            const pb = (b as unknown as SandboxShape).sandbox.priority ?? SANDBOX_DEFAULT_PRIORITY;
            return pb - pa;
          });
          for (const sp of sorted) {
            const sandbox = (sp as unknown as SandboxShape).sandbox;
            try {
              const backend = await sandbox.create(SEMANTIC_ROOT);
              _activeSandboxPluginId = sp.id;
              log.info({ pluginId: sp.id }, "Using sandbox plugin for explore backend");
              return backend;
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              log.error({ pluginId: sp.id, err: detail }, "Sandbox plugin create() failed, trying next");
            }
          }
          log.error({ count: sorted.length }, "All sandbox plugins failed to create a backend");
        }
      }

      // Priority 1: Vercel Sandbox (Firecracker VM)
      if (useVercelSandbox()) {
        const { createSandboxBackend } = await import("./explore-sandbox");
        return createSandboxBackend(SEMANTIC_ROOT);
      }

      // Priority 2: nsjail explicit (ATLAS_SANDBOX=nsjail) — hard-fail if init fails
      if (process.env.ATLAS_SANDBOX === "nsjail" && !_nsjailFailed) {
        try {
          const { createNsjailBackend } = await import("./explore-nsjail");
          return await createNsjailBackend(SEMANTIC_ROOT, {
            onInfrastructureError: invalidateExploreBackend,
            onNsjailFailed: markNsjailFailed,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            "nsjail was explicitly requested (ATLAS_SANDBOX=nsjail) but failed to initialize: " +
              detail + ". Fix the nsjail installation or remove ATLAS_SANDBOX to allow fallback.",
            { cause: err },
          );
        }
      }

      // Priority 3: Sidecar service (HTTP-isolated microservice)
      // When ATLAS_SANDBOX_URL is set, sidecar is the intended backend (Railway/Render).
      // Skips nsjail auto-detection entirely — no noisy namespace warnings.
      if (useSidecar()) {
        const { createSidecarBackend } = await import("./explore-sidecar");
        return createSidecarBackend(process.env.ATLAS_SANDBOX_URL!);
      }

      // Priority 4: nsjail auto-detect (binary on PATH, graceful fallback)
      if (!_nsjailFailed && useNsjail()) {
        try {
          const { createNsjailBackend } = await import("./explore-nsjail");
          return await createNsjailBackend(SEMANTIC_ROOT, {
            onInfrastructureError: invalidateExploreBackend,
            onNsjailFailed: markNsjailFailed,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          _nsjailFailed = true;
          log.error(
            { error: detail, fallback: "just-bash" },
            "nsjail backend failed to initialize, falling back to just-bash",
          );
        }
      }

      // Priority 5: just-bash (no process isolation)
      if (process.env.NODE_ENV === "production") {
        log.warn(
          "Explore tool running without process isolation. " +
            "Install nsjail, configure a sidecar (ATLAS_SANDBOX_URL), or deploy on Vercel for sandboxed execution. " +
            "See: https://github.com/google/nsjail",
        );
      }
      return createBashBackend(SEMANTIC_ROOT);
    })().catch((err) => {
      backendPromise = null; // allow retry on next call
      throw err;
    });
  }
  return backendPromise;
}

// --- Tool definition ---

export const explore = tool({
  description: `Run bash commands to explore the semantic layer (YAML files describing the data model). The working directory is /semantic.

Available commands include: ls, cat, head, tail, grep, find, wc, tree, sort, uniq, cut, awk, sed, and more. Use pipes and flags freely.

The semantic directory contains:
- catalog.yml: Index of all entities and their descriptions
- entities/*.yml: Default connection table schemas with columns, types, sample values, joins
- metrics/*.yml: Default connection metric definitions with authoritative SQL
- glossary.yml: Business term definitions and disambiguation
- {source}/entities/*.yml: Per-source table schemas (e.g. warehouse/entities/)
- {source}/metrics/*.yml: Per-source metric definitions
- {source}/glossary.yml: Source-specific glossary (optional)

When multiple data sources are configured, each source has its own subdirectory.
Entity YAMLs may contain \`cross_source_joins\` describing relationships to tables on other sources — these cannot be SQL-JOINed directly; query each source separately.
Always start by listing the root directory to see what sources are available.`,

  inputSchema: z.object({
    command: z
      .string()
      .describe(
        'A bash command to run, e.g. \'cat catalog.yml\', \'grep -r revenue entities/\', \'find . -name "*.yml"\''
      ),
  }),

  execute: async ({ command }) => {
    let backend: ExploreBackend;
    try {
      backend = await getExploreBackend();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error({ err: detail }, "Explore backend initialization failed");
      return `Error: Explore tool is unavailable — ${detail}`;
    }

    try {
      const { dispatchHook, dispatchMutableHook } = await import("@atlas/api/lib/plugins/hooks");
      let execCommand: string;
      try {
        const hookCtx = { command } as const;
        execCommand = await dispatchMutableHook(
          "beforeExplore",
          hookCtx,
          "command",
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log.warn({ err: detail, command }, "Explore command rejected by plugin");
        return `Error: Command rejected by plugin: ${detail}`;
      }

      // No command re-validation needed — the explore backend (nsjail/sidecar/OverlayFs)
      // enforces read-only scoping regardless of command content
      if (execCommand !== command) {
        log.debug({ original: command, rewritten: execCommand }, "Explore command rewritten by plugin");
      }

      const start = performance.now();
      const result = await withSpan(
        "atlas.explore",
        { command: execCommand.slice(0, 200) },
        () => backend.exec(execCommand),
      );
      const durationMs = Math.round(performance.now() - start);

      log.debug(
        { command: execCommand, durationMs, exitCode: result.exitCode },
        "explore command",
      );

      if (result.exitCode !== 0) {
        return `Error (exit ${result.exitCode}):\n${result.stderr}`;
      }

      const output = result.stdout || "(no output)";
      await dispatchHook("afterExplore", { command: execCommand, output });

      return output;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error({ err: detail, command }, "Explore command failed");
      return `Error: ${detail}`;
    }
  },
});
