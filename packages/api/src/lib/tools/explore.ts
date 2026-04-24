/**
 * Semantic layer exploration tool.
 *
 * Abstracts the shell backend behind an ExploreBackend interface so the
 * explore tool works across five isolation levels:
 * - sandbox plugin: pluggable explore backend via the Plugin SDK (priority-sorted)
 * - @vercel/sandbox: ephemeral microVM with networkPolicy "deny-all" (Vercel)
 * - nsjail: Linux namespace sandbox (self-hosted Docker)
 * - sidecar: HTTP-isolated container with no secrets (Railway)
 * - just-bash: OverlayFs ensures read-only access; writes stay in memory (dev, or production fallback)
 *
 * Default selection priority: sandbox plugin > Vercel sandbox > nsjail (explicit) > sidecar > nsjail (auto-detect) > just-bash.
 * Operators can override the built-in priority via `sandbox.priority` in atlas.config.ts
 * or `ATLAS_SANDBOX_PRIORITY` env var. Plugin backends always take highest priority.
 * A production warning is logged when falling back to just-bash.
 *
 * Org scoping: when an activeOrganizationId is present in the request
 * context, the explore tool reads from `semantic/.orgs/{orgId}/` instead
 * of `semantic/`. Each org's directory is maintained by the dual-write
 * sync layer (semantic-sync.ts). Backends are cached per semantic root.
 */

import { tool } from "ai";
import { z } from "zod";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { withSpan } from "@atlas/api/lib/tracing";
import { getConfig, type SandboxBackendName } from "@atlas/api/lib/config";
import { getSemanticRoot, ensureOrgModeSemanticRoot } from "@atlas/api/lib/semantic/sync";
import { getSetting } from "@atlas/api/lib/settings";
import { useVercelSandbox, useSidecar } from "./backends/detect";

const log = createLogger("explore");

// --- Backend interface (canonical source: ./backends/types.ts) ---

export type { ExecResult, ExploreBackend } from "./backends/types";
import type { ExploreBackend } from "./backends/types";

// --- Self-hosted backend (just-bash) ---

async function createBashBackend(
  semanticRoot: string
): Promise<ExploreBackend> {
  let Bash, OverlayFs;
  try {
    ({ Bash, OverlayFs } = await import("just-bash"));
  } catch (err) {
    const detail = errorMessage(err);
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

let _nsjailAvailable: boolean | null = null;

function useNsjail(): boolean {
  if (process.env.ATLAS_SANDBOX === "nsjail") return true;
  if (_nsjailAvailable !== null) return _nsjailAvailable;
  // Auto-detect nsjail on PATH (deferred require to avoid loading module at startup)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isNsjailAvailable } = require("./backends/nsjail");
    _nsjailAvailable = isNsjailAvailable();
  } catch (err) {
    if (
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
    ) {
      _nsjailAvailable = false;
    } else {
      log.error(
        { error: errorMessage(err) },
        "Unexpected error loading nsjail module",
      );
      _nsjailAvailable = false;
    }
  }
  return _nsjailAvailable ?? false;
}

/** Track nsjail init failures to avoid infinite retry loops. */
let _nsjailFailed = false;

/** Track sidecar init failures so the health endpoint reports accurately. */
let _sidecarFailed = false;

export type ExploreBackendType = SandboxBackendName | "plugin";

/** Name of the active sandbox plugin (if any). Set during backend init. */
let _activeSandboxPluginId: string | null = null;

/** Returns the active sandbox plugin id (if any, for health/startup reporting). */
export function getActiveSandboxPluginId(): string | null {
  return _activeSandboxPluginId;
}

/**
 * Check if a specific backend is available (sync, for health reporting).
 */
function isBackendAvailable(name: SandboxBackendName): boolean {
  switch (name) {
    case "vercel-sandbox":
      return useVercelSandbox();
    case "nsjail":
      if (_nsjailFailed) return false;
      return process.env.ATLAS_SANDBOX === "nsjail" || useNsjail();
    case "sidecar":
      return useSidecar() && !_sidecarFailed;
    case "just-bash":
      return true;
  }
}

/**
 * Returns which explore backend is active (for health endpoint).
 *
 * Plugin detection is lazy — _activeSandboxPluginId is only set after the
 * first explore command triggers getExploreBackend(). Before that, this
 * function falls through to the built-in detection chain.
 *
 * When `sandbox.priority` is configured, the first available backend in the
 * priority list is returned instead of the hardcoded chain.
 */
export function getExploreBackendType(): ExploreBackendType {
  if (_activeSandboxPluginId) return "plugin";

  // Config-driven priority
  const configPriority = getConfig()?.sandbox?.priority;
  if (configPriority && configPriority.length > 0) {
    for (const name of configPriority) {
      if (isBackendAvailable(name)) return name;
    }
    return "just-bash";
  }

  // Default chain
  if (useVercelSandbox()) return "vercel-sandbox";
  // Explicit nsjail (ATLAS_SANDBOX=nsjail) — hard-fail if unavailable
  if (process.env.ATLAS_SANDBOX === "nsjail" && !_nsjailFailed) return "nsjail";
  // Sidecar takes priority over nsjail auto-detection (Railway sets ATLAS_SANDBOX_URL)
  if (useSidecar() && !_sidecarFailed) return "sidecar";
  // nsjail auto-detect (binary on PATH)
  if (!_nsjailFailed && useNsjail()) return "nsjail";
  return "just-bash";
}

/**
 * Try to create a specific backend by name. Returns null if the backend
 * is not available (env vars not set, binary not found, etc.).
 */
async function tryCreateBackend(name: SandboxBackendName, semanticRoot: string, orgId?: string): Promise<ExploreBackend | null> {
  switch (name) {
    case "vercel-sandbox": {
      if (!useVercelSandbox()) return null;
      try {
        const { createSandboxBackend } = await import("./explore-sandbox");
        return createSandboxBackend(semanticRoot);
      } catch (err) {
        const detail = errorMessage(err);
        log.warn(
          { error: detail },
          "vercel-sandbox backend failed to initialize — trying next in priority",
        );
        return null;
      }
    }

    case "nsjail": {
      if (_nsjailFailed) return null;
      // Check if nsjail is available (explicit or auto-detect)
      if (process.env.ATLAS_SANDBOX !== "nsjail" && !useNsjail()) return null;
      try {
        const { createNsjailBackend } = await import("./explore-nsjail");
        return await createNsjailBackend(semanticRoot, {
          onInfrastructureError: invalidateExploreBackend,
          onNsjailFailed: markNsjailFailed,
        });
      } catch (err) {
        _nsjailFailed = true;
        const detail = errorMessage(err);
        log.warn(
          { error: detail },
          "nsjail backend failed to initialize — trying next in priority",
        );
        return null;
      }
    }

    case "sidecar": {
      // Workspace-level URL override takes priority over env var
      const wsSidecarUrl = orgId ? getSetting("ATLAS_SANDBOX_URL", orgId) : undefined;
      const sidecarUrl = wsSidecarUrl ?? process.env.ATLAS_SANDBOX_URL;
      if ((!sidecarUrl && !useSidecar()) || _sidecarFailed) return null;
      if (!sidecarUrl) return null;
      try {
        const { createSidecarBackend } = await import("./explore-sidecar");
        return createSidecarBackend(sidecarUrl, { semanticRoot });
      } catch (err) {
        _sidecarFailed = true;
        const detail = errorMessage(err);
        log.warn(
          { error: detail },
          "sidecar backend failed to initialize — trying next in priority",
        );
        return null;
      }
    }

    case "just-bash": {
      if (process.env.NODE_ENV === "production") {
        log.warn(
          "SECURITY DEGRADATION: Explore tool running without process isolation (just-bash fallback). " +
            "In production, this means shell commands execute directly on the host with only OverlayFs " +
            "read-only protection — no namespace, network, or resource isolation. " +
            "Install nsjail, configure a sidecar (ATLAS_SANDBOX_URL), or deploy on Vercel for sandboxed execution. " +
            "See: https://github.com/google/nsjail",
        );
      } else {
        log.debug("Explore tool using just-bash backend (acceptable for development)");
      }
      return createBashBackend(semanticRoot);
    }
  }
}

/**
 * Backend cache keyed by semantic root path.
 *
 * For self-hosted (no orgs), there's exactly one entry. For multi-tenant,
 * each org gets its own backend instance (most backends are cheap to create).
 */
const backendCache = new Map<string, Promise<ExploreBackend>>();

/** Clear cached backends so the next call recreates them. */
export function invalidateExploreBackend(): void {
  backendCache.clear();
  _activeSandboxPluginId = null;
}

/** Permanently mark nsjail as failed and clear the backend cache.
 *  Called from explore-nsjail.ts on exit code 109 (sandbox setup failure). */
export function markNsjailFailed(): void {
  _nsjailFailed = true;
  backendCache.clear();
}

/** Permanently mark the sidecar as failed so health reports "just-bash".
 *  Called from startup.ts when the sidecar health check fails. */
export function markSidecarFailed(): void {
  _sidecarFailed = true;
}

function getExploreBackend(semanticRoot: string, orgId?: string): Promise<ExploreBackend> {
  // Workspace override changes the effective backend, so include it in the cache key
  const wsOverride = orgId ? getSetting("ATLAS_SANDBOX_BACKEND", orgId) : undefined;
  const cacheKeyVal = wsOverride ? `${semanticRoot}\0${wsOverride}` : semanticRoot;

  let promise = backendCache.get(cacheKeyVal);
  if (!promise) {
    promise = (async (): Promise<ExploreBackend> => {
      // Priority -1: Workspace-level backend override (SaaS self-serve)
      if (wsOverride) {
        log.info(
          { backend: wsOverride, orgId, source: "workspace-setting" },
          "Workspace sandbox override: %s",
          wsOverride,
        );
        // Check if override is a built-in backend name
        const builtInNames: readonly string[] = ["vercel-sandbox", "nsjail", "sidecar", "just-bash"];
        if (builtInNames.includes(wsOverride)) {
          const backend = await tryCreateBackend(wsOverride as SandboxBackendName, semanticRoot, orgId);
          if (backend) return backend;
          log.warn(
            { backend: wsOverride, orgId },
            "Workspace sandbox override %s unavailable — falling through to default",
            wsOverride,
          );
        } else {
          // Try as a plugin ID
          try {
            const { plugins } = await import("@atlas/api/lib/plugins/registry");
            const { wireSandboxPlugins } = await import("@atlas/api/lib/plugins/wiring");
            const result = await wireSandboxPlugins(plugins, semanticRoot);
            if (result.backend && result.pluginId === wsOverride) {
              _activeSandboxPluginId = result.pluginId;
              return result.backend as ExploreBackend;
            }
          } catch (err) {
            const detail = errorMessage(err);
            log.warn(
              { backend: wsOverride, orgId, err: detail },
              "Workspace sandbox plugin override %s failed — falling through to default",
              wsOverride,
            );
          }
        }
        // Override not available — fall through to normal chain
      }

      // Priority 0: Sandbox plugins (sorted by priority, highest first)
      // Skipped when ATLAS_SANDBOX=nsjail — operator explicitly wants nsjail only
      if (process.env.ATLAS_SANDBOX !== "nsjail") {
        try {
          const { plugins } = await import("@atlas/api/lib/plugins/registry");
          const { wireSandboxPlugins } = await import("@atlas/api/lib/plugins/wiring");
          const result = await wireSandboxPlugins(plugins, semanticRoot);
          if (result.failed.length > 0) {
            log.warn(
              { failed: result.failed, selectedPlugin: result.pluginId },
              "Some sandbox plugins failed during create()",
            );
          }
          if (result.backend) {
            _activeSandboxPluginId = result.pluginId;
            return result.backend as ExploreBackend;
          }
        } catch (err) {
          const detail = errorMessage(err);
          const isModuleError = err != null && typeof err === "object" && "code" in err
            && (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
          if (isModuleError) {
            log.debug({ err: detail }, "Plugin modules not available — skipping sandbox plugins");
          } else {
            log.error({ err: detail }, "Unexpected error during sandbox plugin wiring");
          }
        }
      }

      // --- Config-driven priority ---
      const configPriority = getConfig()?.sandbox?.priority;
      if (configPriority && configPriority.length > 0) {
        log.info(
          { priority: configPriority },
          "Using configured sandbox priority: %s",
          configPriority.join(" > "),
        );
        for (const name of configPriority) {
          const backend = await tryCreateBackend(name, semanticRoot, orgId);
          if (backend) {
            log.info(
              { backend: name, source: "config" },
              "Explore backend selected: %s (config priority)",
              name,
            );
            return backend;
          }
          log.debug({ backend: name }, "Backend %s unavailable — trying next in priority", name);
        }
        // All config backends failed
        if (configPriority.includes("just-bash")) {
          // just-bash was in the list but somehow failed (should not happen) — try once more
          log.warn(
            { priority: configPriority },
            "All higher-priority backends in sandbox.priority unavailable — using just-bash",
          );
          return createBashBackend(semanticRoot);
        }
        // Operator did NOT include just-bash — respect their intent
        throw new Error(
          `All backends in sandbox.priority (${configPriority.join(", ")}) failed to initialize. ` +
          "Add 'just-bash' to the priority list if you want an unsandboxed fallback, " +
          "or fix the backend configuration.",
        );
      }

      // --- Default priority chain ---

      // Priority 1: Vercel Sandbox (Firecracker VM)
      if (useVercelSandbox()) {
        const { createSandboxBackend } = await import("./explore-sandbox");
        return createSandboxBackend(semanticRoot);
      }

      // Priority 2: nsjail explicit (ATLAS_SANDBOX=nsjail) — hard-fail if init fails
      if (process.env.ATLAS_SANDBOX === "nsjail" && !_nsjailFailed) {
        try {
          const { createNsjailBackend } = await import("./explore-nsjail");
          return await createNsjailBackend(semanticRoot, {
            onInfrastructureError: invalidateExploreBackend,
            onNsjailFailed: markNsjailFailed,
          });
        } catch (err) {
          // @atlas-ok-ternary: detail is concatenated into a thrown Error message
          // — per #1829 non-goal, don't modify throw new Error(...) constructors.
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            "nsjail was explicitly requested (ATLAS_SANDBOX=nsjail) but failed to initialize: " +
              detail + ". Fix the nsjail installation or remove ATLAS_SANDBOX to allow fallback.",
            { cause: err },
          );
        }
      }

      // Priority 3: Sidecar service (HTTP-isolated microservice)
      // When ATLAS_SANDBOX_URL is set, sidecar is the intended backend (Railway).
      // Skips nsjail auto-detection entirely — no noisy namespace warnings.
      if (useSidecar()) {
        const { createSidecarBackend } = await import("./explore-sidecar");
        return createSidecarBackend(process.env.ATLAS_SANDBOX_URL!, { semanticRoot });
      }

      // Priority 4: nsjail auto-detect (binary on PATH, graceful fallback)
      if (!_nsjailFailed && useNsjail()) {
        try {
          const { createNsjailBackend } = await import("./explore-nsjail");
          return await createNsjailBackend(semanticRoot, {
            onInfrastructureError: invalidateExploreBackend,
            onNsjailFailed: markNsjailFailed,
          });
        } catch (err) {
          const detail = errorMessage(err);
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
          "SECURITY DEGRADATION: Explore tool running without process isolation (just-bash fallback). " +
            "In production, this means shell commands execute directly on the host with only OverlayFs " +
            "read-only protection — no namespace, network, or resource isolation. " +
            "Install nsjail, configure a sidecar (ATLAS_SANDBOX_URL), or deploy on Vercel for sandboxed execution. " +
            "See: https://github.com/google/nsjail",
        );
      } else {
        log.debug("Explore tool using just-bash backend (acceptable for development)");
      }
      return createBashBackend(semanticRoot);
    })().catch((err) => {
      backendCache.delete(cacheKeyVal); // allow retry on next call
      throw err;
    });
    backendCache.set(cacheKeyVal, promise);
  }
  return promise;
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
    // Resolve org-scoped, mode-specific semantic root from request context.
    // Mode isolation: published-mode users see only published entities;
    // developer-mode users see the draft overlay. Self-hosted (no orgId)
    // continues to use the base semantic root.
    const reqCtx = getRequestContext();
    const orgId = reqCtx?.user?.activeOrganizationId;
    const atlasMode = reqCtx?.atlasMode ?? "published";
    let semanticRoot: string;
    try {
      semanticRoot = orgId
        ? await ensureOrgModeSemanticRoot(orgId, atlasMode)
        : getSemanticRoot();
    } catch (err) {
      const detail = errorMessage(err);
      log.error({ err: detail, orgId, atlasMode }, "Failed to prepare org semantic root for explore");
      return `Error: Explore tool is unavailable — ${detail}`;
    }

    let backend: ExploreBackend;
    try {
      backend = await getExploreBackend(semanticRoot, orgId);
    } catch (err) {
      const detail = errorMessage(err);
      log.error({ err: detail, orgId }, "Explore backend initialization failed");
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
        const detail = errorMessage(err);
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
        {
          "atlas.command": execCommand.slice(0, 200),
          "atlas.backend": getExploreBackendType(),
          ...(orgId ? { "atlas.org_id": orgId } : {}),
        },
        () => backend.exec(execCommand),
      );
      const durationMs = Math.round(performance.now() - start);

      log.debug(
        { command: execCommand, durationMs, exitCode: result.exitCode, orgId },
        "explore command",
      );

      if (result.exitCode !== 0) {
        return `Error (exit ${result.exitCode}):\n${result.stderr}`;
      }

      const output = result.stdout || "(no output)";
      await dispatchHook("afterExplore", { command: execCommand, output });

      return output;
    } catch (err) {
      const detail = errorMessage(err);
      log.error({ err: detail, command }, "Explore command failed");
      return `Error: ${detail}`;
    }
  },
});
