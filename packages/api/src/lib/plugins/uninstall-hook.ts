/**
 * Per-workspace `onUninstall` hook invocation (#3188).
 *
 * Plugin uninstall is a DB-row removal, not a process event — the SDK's
 * `teardown()` only runs at server shutdown. Before this module, a plugin
 * that registered an external webhook subscription (Slack, GitHub,
 * Stripe, …) had NO seam to revoke it at uninstall time, so the
 * subscription kept delivering events to a workspace that no longer had
 * the plugin installed.
 *
 * `invokeOnUninstallHook` is that seam. It is step 1 of
 * `tearDownWorkspaceInstall` (`plugins/teardown.ts`) — the single teardown
 * orchestrator every route-level uninstall path runs — and is also called
 * directly by `WorkspaceInstaller.uninstall`, which needs the hook + the
 * two-store teardown under its own stricter (ADR-0003) failure posture.
 * Every caller runs it BEFORE removing the install row and credential
 * stores, so the plugin can still authenticate against the external
 * platform while revoking.
 *
 * #4353 — a former `invokeOnUninstallHookForInstallRow` shim resolved
 * `(catalogId, slug)` from an `installationId` and then ran the hook ONLY,
 * skipping credential + scheduled-task teardown. That row lookup now lives
 * inside `tearDownWorkspaceInstall` (its `installationId` identity form), so
 * an uninstall entry point can no longer opt into the hook alone. Do NOT
 * re-add an id-resolving wrapper here.
 *
 * Resolution — which plugin instance(s) get the hook:
 *
 *   1. **Per-workspace lazy instance** (`LazyPluginLoader`, keyed by
 *      `catalogId`). The SaaS / marketplace model: the instance closes
 *      over the workspace's own decrypted credentials, so its
 *      `onUninstall` revokes exactly that workspace's external state.
 *      The instance is built on demand if not cached — the install row
 *      still exists at invocation time, so the build can read config.
 *   2. **Globally-registered plugins** (`PluginRegistry`) whose `id`
 *      matches the uninstalled catalog entry: the slug itself, the
 *      catalog id, or `<slug>-<type>` — the naming convention every
 *      bundled plugin follows (`jira-action`, `email-action`,
 *      `webhook-interaction`, …). Exact matches only: no prefix
 *      wildcards, so `email` can never accidentally resolve
 *      `email-digest`.
 *
 * Candidates are deduplicated by reference and each is invoked at most
 * once. Distinct instances matched by both branches each revoke their
 * own external state (per-workspace OAuth grant vs operator-config
 * credential), which is the correct per-credential semantics.
 *
 * Each hook runs against a host-side deadline
 * ({@link ON_UNINSTALL_HOOK_TIMEOUT_MS}) so a hung plugin HTTP call can
 * never hang the admin DELETE indefinitely; a timeout is recorded as a
 * failure entry. After the candidates run, the loader entry for
 * `(workspaceId, catalogId)` is evicted — resolution step 1 warms (and
 * caches) a credentialed instance, and without the evict the marketplace
 * DELETE route would leak that socket-holding instance until process restart.
 * (`WorkspaceInstaller.uninstall` evicts again afterwards; evicting an
 * absent key is a no-op, so the double-evict is harmless.)
 *
 * Failure contract: NOTHING in here throws. Builder failures, missing
 * rows, hook throws, hook timeouts, and evict failures are logged
 * (`log.warn` with plugin id + workspaceId) and — except for evict —
 * reported in the returned summary; the caller's install-row removal
 * always proceeds. Callers still wrap the call defensively so even a
 * defect here can't abort an uninstall.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { lazyPluginLoader, type LazyPluginLoader } from "./lazy-loader";
import { plugins, type PluginLike, type PluginRegistry, type PluginType } from "./registry";

const log = createLogger("plugins:uninstall-hook");

// Record-keyed so a new `PluginType` union member is a compile error here
// (a missing key fails tsc) instead of a silently-unmatched `<slug>-<type>`
// candidate id.
const PLUGIN_TYPE_MAP: Record<PluginType, true> = {
  datasource: true,
  context: true,
  interaction: true,
  action: true,
  sandbox: true,
};
const PLUGIN_TYPES = Object.keys(PLUGIN_TYPE_MAP) as readonly PluginType[];

/**
 * Host-side deadline for a single plugin's `onUninstall` hook. A plugin
 * whose revocation HTTP call hangs (dead upstream, no client timeout)
 * must not hang the admin DELETE — the hook is raced against this
 * deadline and a timeout is recorded as a failure entry.
 */
export const ON_UNINSTALL_HOOK_TIMEOUT_MS = 15_000;

export interface InvokeOnUninstallArgs {
  /** Workspace the plugin is being uninstalled from. */
  readonly workspaceId: string;
  /** `plugin_catalog.id` of the uninstalled entry (e.g. `catalog:jira`). */
  readonly catalogId: string;
  /** `plugin_catalog.slug` when known (e.g. `jira`). */
  readonly catalogSlug?: string | null;
  /** Test seam — defaults to the process-wide `lazyPluginLoader`. */
  readonly loader?: Pick<LazyPluginLoader, "hasBuilder" | "getOrInstantiate" | "evict">;
  /** Test seam — defaults to the process-wide `plugins` registry. */
  readonly registry?: Pick<PluginRegistry, "get">;
  /** Test seam — per-hook deadline; defaults to {@link ON_UNINSTALL_HOOK_TIMEOUT_MS}. */
  readonly hookTimeoutMs?: number;
}

export interface OnUninstallInvocationResult {
  /** Plugin ids whose `onUninstall` ran to completion. */
  readonly invoked: string[];
  /** Hook throws / builder failures, normalized to messages. */
  readonly failures: Array<{ pluginId: string; error: string }>;
}

/**
 * Invoke `onUninstall(workspaceId)` on every plugin instance resolved
 * for the uninstalled catalog entry. Never throws — see module JSDoc
 * for the resolution + failure contract.
 */
export async function invokeOnUninstallHook(
  args: InvokeOnUninstallArgs,
): Promise<OnUninstallInvocationResult> {
  const { workspaceId, catalogId, catalogSlug } = args;
  const loader = args.loader ?? lazyPluginLoader;
  const registry = args.registry ?? plugins;
  const hookTimeoutMs = args.hookTimeoutMs ?? ON_UNINSTALL_HOOK_TIMEOUT_MS;

  const invoked: string[] = [];
  const failures: Array<{ pluginId: string; error: string }> = [];
  const candidates: PluginLike[] = [];

  // 1) Per-workspace lazy instance. Built on demand — the install row
  //    still exists at this point, so the builder can read config /
  //    credentials. A builder failure (expired OAuth refresh, decrypt
  //    error) is logged and skipped; it must not block the uninstall.
  if (loader.hasBuilder(catalogId)) {
    try {
      candidates.push(await loader.getOrInstantiate(workspaceId, catalogId));
    } catch (err) {
      log.warn(
        {
          workspaceId,
          catalogId,
          err: err instanceof Error ? err.message : String(err),
        },
        "onUninstall: lazy plugin instantiation failed — skipping per-workspace hook (uninstall proceeds)",
      );
      failures.push({
        pluginId: catalogId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2) Globally-registered plugins by exact id match: slug, catalog id,
  //    or `<slug>-<type>`. No prefix wildcards (see module JSDoc).
  const globalIds = new Set<string>([catalogId]);
  if (catalogSlug) {
    globalIds.add(catalogSlug);
    for (const t of PLUGIN_TYPES) globalIds.add(`${catalogSlug}-${t}`);
  }
  for (const id of globalIds) {
    const plugin = registry.get(id);
    if (plugin && !candidates.includes(plugin)) candidates.push(plugin);
  }

  for (const plugin of candidates) {
    if (typeof plugin.onUninstall !== "function") continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hookPromise = Promise.resolve(plugin.onUninstall(workspaceId));
      // A hook that rejects AFTER the deadline already recorded the
      // timeout would otherwise surface as an unhandled rejection.
      hookPromise.catch((err: unknown) => {
        // intentionally swallowed: the race below is the reporting path —
        // this branch only matters for a post-timeout late rejection.
        log.debug(
          {
            pluginId: plugin.id,
            workspaceId,
            err: err instanceof Error ? err.message : String(err),
          },
          "onUninstall hook rejected (possibly after the host deadline)",
        );
      });
      await Promise.race([
        hookPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`onUninstall timed out after ${hookTimeoutMs}ms`),
              ),
            hookTimeoutMs,
          );
        }),
      ]);
      invoked.push(plugin.id);
      log.info(
        { pluginId: plugin.id, workspaceId, catalogId },
        "onUninstall hook completed",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ pluginId: plugin.id, error: message });
      log.warn(
        { pluginId: plugin.id, workspaceId, catalogId, err: message },
        "onUninstall hook threw or timed out — external subscriptions may be orphaned; uninstall proceeds",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // Step 1 above may have warmed (and cached) a credentialed,
  // socket-holding instance. `WorkspaceInstaller.uninstall` evicts after
  // calling this helper, but the marketplace DELETE route does not — so
  // evict here, covering both paths with one seam. Evicting an absent
  // key is a no-op inside the loader, so the installer's later evict is
  // a harmless double-evict.
  try {
    await loader.evict(workspaceId, catalogId);
  } catch (err) {
    log.warn(
      {
        workspaceId,
        catalogId,
        err: err instanceof Error ? err.message : String(err),
      },
      "onUninstall: loader evict failed — a stale plugin instance may persist until process restart; uninstall proceeds",
    );
  }

  return { invoked, failures };
}
