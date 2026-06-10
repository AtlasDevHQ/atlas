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
 * `invokeOnUninstallHook` is that seam. Both uninstall paths call it
 * BEFORE removing the install row and credential stores (the marketplace
 * `DELETE /api/v1/admin/marketplace/:id` route and
 * `WorkspaceInstaller.uninstall`), so the plugin can still authenticate
 * against the external platform while revoking.
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
 * Failure contract: NOTHING in here throws. Builder failures, missing
 * rows, and hook throws are logged (`log.warn` with plugin id +
 * workspaceId) and reported in the returned summary — the caller's
 * install-row removal always proceeds. Callers still wrap the call
 * defensively so even a defect here can't abort an uninstall.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { lazyPluginLoader, type LazyPluginLoader } from "./lazy-loader";
import { plugins, type PluginLike, type PluginRegistry, type PluginType } from "./registry";

const log = createLogger("plugins:uninstall-hook");

const PLUGIN_TYPES: readonly PluginType[] = [
  "datasource",
  "context",
  "interaction",
  "action",
  "sandbox",
];

export interface InvokeOnUninstallArgs {
  /** Workspace the plugin is being uninstalled from. */
  readonly workspaceId: string;
  /** `plugin_catalog.id` of the uninstalled entry (e.g. `catalog:jira`). */
  readonly catalogId: string;
  /** `plugin_catalog.slug` when known (e.g. `jira`). */
  readonly catalogSlug?: string | null;
  /** Test seam — defaults to the process-wide `lazyPluginLoader`. */
  readonly loader?: Pick<LazyPluginLoader, "hasBuilder" | "getOrInstantiate">;
  /** Test seam — defaults to the process-wide `plugins` registry. */
  readonly registry?: Pick<PluginRegistry, "get">;
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
    try {
      await plugin.onUninstall(workspaceId);
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
        "onUninstall hook threw — external subscriptions may be orphaned; uninstall proceeds",
      );
    }
  }

  return { invoked, failures };
}

interface InstallRowForUninstall extends Record<string, unknown> {
  catalog_id: string;
  slug: string | null;
}

/**
 * Marketplace-route variant: resolve `(catalogId, slug)` from the
 * installation row first, then delegate to {@link invokeOnUninstallHook}.
 * The route only has the installation `id`; this lookup MUST run before
 * the route's `DELETE … RETURNING` so the hook sees the row (and the
 * plugin its credentials) while they still exist.
 *
 * Never throws: a lookup failure (or a missing row — the route's own 404
 * path) logs and returns without invoking anything.
 */
export async function invokeOnUninstallHookForInstallRow(args: {
  readonly workspaceId: string;
  readonly installationId: string;
  /** Test seam — defaults to `internalQuery`. */
  readonly queryFn?: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
  readonly loader?: Pick<LazyPluginLoader, "hasBuilder" | "getOrInstantiate">;
  readonly registry?: Pick<PluginRegistry, "get">;
}): Promise<OnUninstallInvocationResult> {
  const { workspaceId, installationId } = args;
  const queryFn = args.queryFn ?? internalQuery;

  let rows: InstallRowForUninstall[];
  try {
    rows = await queryFn<InstallRowForUninstall>(
      `SELECT wp.catalog_id, pc.slug
         FROM workspace_plugins wp
         LEFT JOIN plugin_catalog pc ON pc.id = wp.catalog_id
        WHERE wp.id = $1 AND wp.workspace_id = $2
        LIMIT 1`,
      [installationId, workspaceId],
    );
  } catch (err) {
    log.warn(
      {
        workspaceId,
        installationId,
        err: err instanceof Error ? err.message : String(err),
      },
      "onUninstall: install-row lookup failed — skipping hook (uninstall proceeds)",
    );
    return { invoked: [], failures: [] };
  }

  if (rows.length === 0) {
    // Row already gone (or never existed) — the route's DELETE will 404.
    return { invoked: [], failures: [] };
  }

  return invokeOnUninstallHook({
    workspaceId,
    catalogId: rows[0].catalog_id,
    catalogSlug: rows[0].slug,
    ...(args.loader ? { loader: args.loader } : {}),
    ...(args.registry ? { registry: args.registry } : {}),
  });
}
