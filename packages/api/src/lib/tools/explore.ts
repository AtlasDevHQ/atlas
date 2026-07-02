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
import { getWorkspaceSandboxOverride } from "@atlas/api/lib/sandbox/workspace-override";
import { useVercelSandbox, useSidecar } from "./backends/detect";
import { capOutput } from "./backends/shared";
import { EXPLORE_TOOL_DESCRIPTION } from "./descriptions";

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
 * Try to create a specific backend by name. Returns a backend on success,
 * otherwise a sanitized reason suitable for operator-facing config errors.
 */
interface BackendInitFailure {
  name: SandboxBackendName;
  reason: string;
}

interface BackendInitResult {
  backend: ExploreBackend | null;
  failure?: BackendInitFailure;
}

function unavailable(name: SandboxBackendName, reason: string): BackendInitResult {
  return { backend: null, failure: { name, reason } };
}

function formatSandboxPriorityFailure(
  priority: readonly SandboxBackendName[],
  failures: readonly BackendInitFailure[],
  deployMode: "saas" | "self-hosted" | undefined,
): string {
  const summary = failures.length > 0
    ? ` Failed backends: ${failures.map((f) => `${f.name}: ${f.reason}`).join("; ")}.`
    : "";
  const guidance: string[] = [];
  if (priority.includes("vercel-sandbox")) {
    guidance.push("For Vercel Sandbox off-Vercel, set VERCEL_TEAM_ID, VERCEL_PROJECT_ID, and VERCEL_TOKEN.");
  }
  if (priority.includes("sidecar")) {
    guidance.push("For sidecar, set ATLAS_SANDBOX_URL.");
  }
  if (deployMode !== "saas") {
    guidance.push("Add 'just-bash' to the priority list if you want an unsandboxed fallback.");
  }
  guidance.push("Fix the backend configuration.");

  return `All backends in sandbox.priority (${priority.join(", ")}) failed to initialize.${summary} ${guidance.join(" ")}`;
}

export const _formatSandboxPriorityFailureForTest = formatSandboxPriorityFailure;

async function tryCreateBackend(name: SandboxBackendName, semanticRoot: string, orgId?: string): Promise<BackendInitResult> {
  switch (name) {
    case "vercel-sandbox": {
      if (!useVercelSandbox()) {
        return unavailable(
          name,
          "not configured (set ATLAS_RUNTIME=vercel, VERCEL=1, or all of VERCEL_TEAM_ID / VERCEL_PROJECT_ID / VERCEL_TOKEN)",
        );
      }
      try {
        const { createSandboxBackend } = await import("./explore-sandbox");
        return { backend: await createSandboxBackend(semanticRoot) };
      } catch (err) {
        const detail = errorMessage(err);
        log.warn(
          { error: detail },
          "vercel-sandbox backend failed to initialize — trying next in priority",
        );
        return unavailable(name, detail);
      }
    }

    case "nsjail": {
      if (_nsjailFailed) return unavailable(name, "previous initialization failed");
      // Check if nsjail is available (explicit or auto-detect)
      if (process.env.ATLAS_SANDBOX !== "nsjail" && !useNsjail()) {
        return unavailable(name, "nsjail binary not available");
      }
      try {
        const { createNsjailBackend } = await import("./explore-nsjail");
        return {
          backend: await createNsjailBackend(semanticRoot, {
            onInfrastructureError: invalidateExploreBackend,
            onNsjailFailed: markNsjailFailed,
          }),
        };
      } catch (err) {
        _nsjailFailed = true;
        const detail = errorMessage(err);
        log.warn(
          { error: detail },
          "nsjail backend failed to initialize — trying next in priority",
        );
        return unavailable(name, detail);
      }
    }

    case "sidecar": {
      // Workspace-level URL override takes priority over env var
      const wsSidecarUrl = orgId ? getSetting("ATLAS_SANDBOX_URL", orgId) : undefined;
      const sidecarUrl = wsSidecarUrl ?? process.env.ATLAS_SANDBOX_URL;
      if (_sidecarFailed) return unavailable(name, "previous initialization failed");
      if (!sidecarUrl) {
        return unavailable(name, "not configured (set ATLAS_SANDBOX_URL)");
      }
      try {
        const { createSidecarBackend } = await import("./explore-sidecar");
        return { backend: await createSidecarBackend(sidecarUrl, { semanticRoot }) };
      } catch (err) {
        _sidecarFailed = true;
        const detail = errorMessage(err);
        log.warn(
          { error: detail },
          "sidecar backend failed to initialize — trying next in priority",
        );
        return unavailable(name, detail);
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
      return { backend: await createBashBackend(semanticRoot) };
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

/**
 * Cache keys created under an org, for targeted invalidation when that org's
 * BYOC sandbox credentials change (#3370). Mirrors how the ConnectionRegistry
 * drains a workspace's pools on datasource credential edits
 * (drainWorkspacePool, #3109).
 */
const orgBackendKeys = new Map<string, Set<string>>();

/** Best-effort close of a cached backend's resources (logs, never throws). */
function closeCachedBackend(promise: Promise<ExploreBackend>, cacheKey: string): void {
  promise
    .then((backend) => backend.close?.())
    .catch((err) => {
      // warn, not debug: for BYOC backends a failed teardown leaves a remote
      // sandbox billing the org's provider account until its idle timeout.
      log.warn(
        { err: errorMessage(err), cacheKey },
        "Failed to close invalidated explore backend",
      );
    });
}

/** Clear cached backends so the next call recreates them. */
export function invalidateExploreBackend(): void {
  // Close before clearing — BYOC backends (#3370) hold live remote sandboxes
  // (E2B/Daytona/Railway containers, Vercel sessions) that would otherwise
  // bill until the provider's idle timeout reaps them.
  for (const [key, cached] of backendCache) {
    closeCachedBackend(cached, key);
  }
  backendCache.clear();
  orgBackendKeys.clear();
  _activeSandboxPluginId = null;
}

/**
 * Drop (and close) every cached backend created for an org. Called when the
 * org's BYOC sandbox credentials are saved or deleted so the next explore
 * call rebuilds against the new credential state.
 *
 * Per-process only: in a multi-replica deployment, other replicas keep
 * their cached backend until restart or their own invalidation — same
 * limitation as the ConnectionRegistry workspace-pool drain it mirrors.
 */
export function invalidateOrgExploreBackends(orgId: string): void {
  const keys = orgBackendKeys.get(orgId);
  if (!keys) return;
  orgBackendKeys.delete(orgId);
  for (const key of keys) {
    const cached = backendCache.get(key);
    if (cached) {
      backendCache.delete(key);
      closeCachedBackend(cached, key);
    }
  }
}

/** Permanently mark nsjail as failed and clear the backend cache.
 *  Called from explore-nsjail.ts on exit code 109 (sandbox setup failure). */
export function markNsjailFailed(): void {
  _nsjailFailed = true;
  for (const [key, cached] of backendCache) {
    closeCachedBackend(cached, key);
  }
  backendCache.clear();
  orgBackendKeys.clear();
}

/** Permanently mark the sidecar as failed so health reports "just-bash".
 *  Called from startup.ts when the sidecar health check fails. */
export function markSidecarFailed(): void {
  _sidecarFailed = true;
}

function getExploreBackend(semanticRoot: string, orgId?: string): Promise<ExploreBackend> {
  // Workspace override changes the effective backend, so include it in the cache key.
  // Normalized to backend-id vocabulary BEFORE building the cache key, so legacy
  // provider-key spellings share one entry (#3375); the read+normalize pair is
  // shared with the Python tool via getWorkspaceSandboxOverride.
  const wsOverride = getWorkspaceSandboxOverride(orgId);
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
        // Priority -1a: BYOC — the org connected its own provider credentials
        // and selected that provider's backend (#3370). Built from the stored
        // credentials on the org's own account. Returns null when not engaged
        // (no/incomplete credentials, runtime not installed) and the override
        // resolves through the operator chain below; throws when engaged but
        // construction fails, which propagates so explore fails closed
        // instead of silently running on the operator's account.
        if (orgId) {
          const { tryCreateByocBackend } = await import("@atlas/api/lib/sandbox/runtime");
          const byocBackend = await tryCreateByocBackend(orgId, wsOverride, semanticRoot);
          if (byocBackend) {
            log.info(
              { backend: wsOverride, orgId, source: "byoc" },
              "Explore backend selected: %s (org BYOC credentials)",
              wsOverride,
            );
            return byocBackend;
          }
        }
        // Check if override is a built-in backend name
        const builtInNames: readonly string[] = ["vercel-sandbox", "nsjail", "sidecar", "just-bash"];
        if (builtInNames.includes(wsOverride)) {
          const result = await tryCreateBackend(wsOverride as SandboxBackendName, semanticRoot, orgId);
          if (result.backend) return result.backend;
          log.warn(
            { backend: wsOverride, orgId, reason: result.failure?.reason },
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
        const failures: BackendInitFailure[] = [];
        for (const name of configPriority) {
          const result = await tryCreateBackend(name, semanticRoot, orgId);
          if (result.backend) {
            log.info(
              { backend: name, source: "config" },
              "Explore backend selected: %s (config priority)",
              name,
            );
            return result.backend;
          }
          if (result.failure) {
            failures.push(result.failure);
          }
          log.debug(
            { backend: name, reason: result.failure?.reason },
            "Backend %s unavailable — trying next in priority",
            name,
          );
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
        throw new Error(formatSandboxPriorityFailure(configPriority, failures, getConfig()?.deployMode));
      }

      // --- Default priority chain ---

      // Priority 1: Vercel Sandbox (Firecracker VM)
      // Init failures fall through to the next backend in the chain, mirroring
      // `tryCreateBackend` (the config-priority path). Without this local
      // try/catch the throw escapes to the outer IIFE `.catch` below, which
      // only invalidates the cache and rethrows — it does NOT degrade to
      // nsjail/sidecar/just-bash that are sitting right there in the chain.
      // SaaS is unaffected: it pins `sandbox.priority: ["vercel-sandbox"]` and
      // takes the config-priority path above, which fails closed by design.
      if (useVercelSandbox()) {
        try {
          const { createSandboxBackend } = await import("./explore-sandbox");
          return await createSandboxBackend(semanticRoot);
        } catch (err) {
          const detail = errorMessage(err);
          log.warn(
            { error: detail },
            "vercel-sandbox backend failed to initialize — falling through to next backend in default priority",
          );
        }
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
      // Same fall-through fix as the Vercel branch above: an init failure
      // (e.g. malformed ATLAS_SANDBOX_URL) logs and degrades to the next
      // backend instead of hard-failing the explore tool. We deliberately do
      // NOT set the process-global `_sidecarFailed` flag here (#3196 review):
      // that flag is for a *deliberate, permanent* mark (the startup health
      // probe via markSidecarFailed). A transient init failure on this path
      // should be retried on the next backend-cache resolution — the resolved
      // backend is cached per semantic root, so a down sidecar isn't re-probed
      // every request, and recovery happens when the cache is invalidated
      // (invalidateExploreBackend). Pinning the flag here would strand the
      // deployment on the weaker fallback until process restart even after the
      // sidecar recovers.
      if (useSidecar()) {
        try {
          const { createSidecarBackend } = await import("./explore-sidecar");
          return await createSidecarBackend(process.env.ATLAS_SANDBOX_URL!, { semanticRoot });
        } catch (err) {
          const detail = errorMessage(err);
          log.warn(
            { error: detail },
            "sidecar backend failed to initialize — falling through to next backend in default priority (retried on the next backend-cache resolution)",
          );
        }
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
      // Identity-guarded: if invalidation already evicted this promise and a
      // newer backend was cached under the same key, deleting blindly would
      // orphan that live backend (it would never be close()d).
      if (backendCache.get(cacheKeyVal) === promise) {
        backendCache.delete(cacheKeyVal); // allow retry on next call
      }
      throw err;
    });
    backendCache.set(cacheKeyVal, promise);
    if (orgId) {
      let keys = orgBackendKeys.get(orgId);
      if (!keys) {
        keys = new Set();
        orgBackendKeys.set(orgId, keys);
      }
      keys.add(cacheKeyVal);
    }
  }
  return promise;
}

// --- Tool definition ---

export const explore = tool({
  description: EXPLORE_TOOL_DESCRIPTION,

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

      // Cap output at the tool seam so every backend is covered — nsjail caps
      // at stream-read time, but Vercel/just-bash/plugin/BYOC backends return
      // whole buffered outputs that would otherwise flow into agent context
      // (and the MCP/REST explore surfaces) unbounded.
      if (result.exitCode !== 0) {
        return `Error (exit ${result.exitCode}):\n${capOutput(result.stderr)}`;
      }

      const output = capOutput(result.stdout) || "(no output)";
      await dispatchHook("afterExplore", { command: execCommand, output });

      return output;
    } catch (err) {
      const detail = errorMessage(err);
      log.error({ err: detail, command }, "Explore command failed");
      return `Error: ${detail}`;
    }
  },
});
