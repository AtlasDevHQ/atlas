/**
 * LazyPluginLoader — milestone 1.5.2 slice 3 (#2657).
 *
 * Builds and caches per-Workspace plugin instances on first use. Reads
 * `workspace_plugins.config` once per `(workspaceId, catalogId)`,
 * delegates construction to a builder registered against the catalogId,
 * and returns the same instance on every subsequent call until `evict`
 * clears the entry (e.g. the disconnect path in #2656 tearing down an
 * install).
 *
 * Why this lives outside `registry.ts`:
 *   - `PluginRegistry` is the global, boot-time registry of statically
 *     loaded plugins (one instance per plugin id, shared across all
 *     workspaces). It mounts at server start and stays for the process
 *     lifetime.
 *   - LazyPluginLoader is per-Workspace, on-demand. Two Workspaces using
 *     the same `catalogId` (e.g. both connecting Salesforce with their
 *     own OAuth creds) MUST get distinct plugin instances — the
 *     per-install `config` blob feeds directly into the constructed
 *     plugin's credential surface. Sharing one instance across
 *     Workspaces would cross-talk credentials between tenants.
 *
 * Builders vs. registration: a builder is the catalog-side recipe
 * (`{ workspaceId, config } => PluginLike`) registered once per
 * catalogId at boot (Salesforce in #2658, Jira in #2659). The loader
 * looks up the builder by catalogId and invokes it on demand. This
 * matches the per-slug builder shape used by the chat AdapterRegistry
 * (`plugins/chat/src/adapter-registry.ts`), but keyed per-Workspace.
 *
 * Concurrency: overlapping `getOrInstantiate` calls for the same key
 * coalesce — the second caller awaits the first call's in-flight
 * construction Promise rather than firing a parallel build. This
 * matters because tool-call paths in the agent loop can dispatch
 * multiple plugin actions in parallel; without coalescing each one
 * would race to read `workspace_plugins.config` and call the builder.
 *
 * Failure semantics: a thrown builder does NOT poison the cache. The
 * pending Promise is cleared so a subsequent call retries from scratch
 * (transient OAuth refresh failures recover on the next tool call
 * rather than wedging the install until process restart).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { PluginLike } from "./registry";

const log = createLogger("plugins:lazy-loader");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LazyPluginBuilderArgs {
  readonly workspaceId: string;
  readonly catalogId: string;
  /**
   * Stored JSONB from `workspace_plugins.config`. Secret-marked fields
   * may be ciphertext — the builder owns decryption (it knows the
   * catalog schema; see `plugins/secrets.ts:decryptSecretFields`). The
   * loader stays generic so it doesn't need to load the catalog row.
   */
  readonly config: Record<string, unknown>;
}

/**
 * Recipe for constructing a per-Workspace plugin instance. Sync return
 * matches the common `definePlugin(...)` / `createPlugin()` path; the
 * Promise overload supports builders that pre-warm network state (e.g.
 * a token refresh) before returning the instance.
 */
export type LazyPluginBuilder = (
  args: LazyPluginBuilderArgs,
) => PluginLike | Promise<PluginLike>;

interface StoredRow extends Record<string, unknown> {
  config: unknown;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LazyPluginBuilderMissingError extends Error {
  readonly catalogId: string;
  constructor(catalogId: string) {
    super(`LazyPluginLoader: no builder registered for catalogId "${catalogId}"`);
    this.name = "LazyPluginBuilderMissingError";
    this.catalogId = catalogId;
  }
}

export class LazyPluginInstallNotFoundError extends Error {
  readonly workspaceId: string;
  readonly catalogId: string;
  constructor(workspaceId: string, catalogId: string) {
    super(
      `LazyPluginLoader: no install row in workspace_plugins for (workspaceId="${workspaceId}", catalogId="${catalogId}")`,
    );
    this.name = "LazyPluginInstallNotFoundError";
    this.workspaceId = workspaceId;
    this.catalogId = catalogId;
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const cacheKey = (workspaceId: string, catalogId: string): string =>
  // `::` is forbidden by the workspace_plugins.workspace_id format
  // (cuid2 / org-prefixed slugs) so no key collision risk.
  `${workspaceId}::${catalogId}`;

export class LazyPluginLoader {
  private builders = new Map<string, LazyPluginBuilder>();
  private instances = new Map<string, PluginLike>();
  private pending = new Map<string, Promise<PluginLike>>();

  registerBuilder(catalogId: string, builder: LazyPluginBuilder): void {
    if (!catalogId || !catalogId.trim()) {
      throw new Error("LazyPluginLoader.registerBuilder: catalogId must not be empty");
    }
    if (this.builders.has(catalogId)) {
      throw new Error(
        `LazyPluginLoader.registerBuilder: builder for catalogId "${catalogId}" is already registered`,
      );
    }
    this.builders.set(catalogId, builder);
    log.info({ catalogId }, "LazyPluginLoader: builder registered");
  }

  hasBuilder(catalogId: string): boolean {
    return this.builders.has(catalogId);
  }

  /**
   * Remove a builder registration. Cached instances stay until they're
   * explicitly evicted — the disconnect path (#2656) is responsible for
   * tearing those down.
   */
  unregisterBuilder(catalogId: string): boolean {
    return this.builders.delete(catalogId);
  }

  /**
   * Return the cached plugin instance for `(workspaceId, catalogId)`,
   * constructing it on first call from `workspace_plugins.config`.
   *
   * Concurrent calls for the same key share one in-flight build
   * Promise. A failed build clears the pending entry so the next call
   * retries from scratch.
   */
  async getOrInstantiate(workspaceId: string, catalogId: string): Promise<PluginLike> {
    const key = cacheKey(workspaceId, catalogId);

    const cached = this.instances.get(key);
    if (cached) return cached;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const builder = this.builders.get(catalogId);
    if (!builder) {
      throw new LazyPluginBuilderMissingError(catalogId);
    }

    const buildPromise = (async () => {
      const config = await this.readInstallConfig(workspaceId, catalogId);
      const instance = await builder({ workspaceId, catalogId, config });
      return instance;
    })();

    this.pending.set(key, buildPromise);

    try {
      const instance = await buildPromise;
      this.instances.set(key, instance);
      log.debug({ workspaceId, catalogId }, "LazyPluginLoader: instance constructed and cached");
      return instance;
    } catch (err) {
      log.warn(
        {
          workspaceId,
          catalogId,
          err: err instanceof Error ? err.message : String(err),
        },
        "LazyPluginLoader: builder failed — next call will retry from scratch",
      );
      throw err;
    } finally {
      // Clear pending regardless — on success the cached entry covers
      // subsequent calls; on failure we want the next call to retry.
      this.pending.delete(key);
    }
  }

  /**
   * Drop the cached instance for `(workspaceId, catalogId)`. Returns
   * `true` if an entry existed. Called by the install-teardown path
   * (#2656) so the next `getOrInstantiate` reconstructs against
   * freshly-stored config rather than a stale memoized instance.
   */
  evict(workspaceId: string, catalogId: string): boolean {
    return this.instances.delete(cacheKey(workspaceId, catalogId));
  }

  size(): number {
    return this.instances.size;
  }

  /** Reset all builder + instance state. Test-only. */
  _reset(): void {
    this.builders.clear();
    this.instances.clear();
    this.pending.clear();
  }

  private async readInstallConfig(
    workspaceId: string,
    catalogId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await internalQuery<StoredRow>(
      "SELECT config FROM workspace_plugins WHERE workspace_id = $1 AND catalog_id = $2 LIMIT 1",
      [workspaceId, catalogId],
    );
    if (rows.length === 0) {
      throw new LazyPluginInstallNotFoundError(workspaceId, catalogId);
    }
    const raw = rows[0].config;
    // JSONB legitimately holds primitives, arrays, or `null`. Anything
    // that isn't a plain object collapses to `{}` so the builder gets a
    // stable shape — matching the coercion that `validation.ts` uses.
    if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    return raw as Record<string, unknown>;
  }
}

/**
 * Global singleton. Mirrors the `plugins` export from `registry.ts` —
 * production callers reach for `lazyPluginLoader` and tests instantiate
 * a fresh `new LazyPluginLoader()` to keep state isolated.
 */
export const lazyPluginLoader = new LazyPluginLoader();
