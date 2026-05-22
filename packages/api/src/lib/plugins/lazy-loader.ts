/**
 * LazyPluginLoader.
 *
 * Builds and caches per-Workspace plugin instances on first use. Reads
 * `workspace_plugins.config` once per `(workspaceId, catalogId)`,
 * delegates construction to a builder registered against the catalogId,
 * and memoizes the instance until `evict` clears the entry.
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
 * Concurrency: overlapping `getOrInstantiate` calls for the same key
 * coalesce — the second caller awaits the first call's in-flight
 * construction Promise rather than firing a parallel build. The agent
 * loop's tool-call paths can dispatch multiple plugin actions in
 * parallel; without coalescing each one would race to read
 * `workspace_plugins.config` and call the builder.
 *
 * Eviction during an in-flight build: `evict` is the source of truth.
 * Once it clears the pending entry, any build still running will return
 * its instance to its original caller but will NOT repopulate the
 * cache — the next `getOrInstantiate` reconstructs against the current
 * stored config. Combined with `instance.teardown?.()` on evict, this
 * is how install teardown stays consistent without coordinating with
 * mid-flight tool calls.
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
      `LazyPluginLoader: no enabled install row in workspace_plugins for (workspaceId="${workspaceId}", catalogId="${catalogId}")`,
    );
    this.name = "LazyPluginInstallNotFoundError";
    this.workspaceId = workspaceId;
    this.catalogId = catalogId;
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

interface PendingBuild {
  readonly promise: Promise<PluginLike>;
  readonly generation: number;
}

const cacheKey = (workspaceId: string, catalogId: string): string =>
  // `::` is forbidden by the workspace_plugins.workspace_id format
  // (cuid2 / org-prefixed slugs) so no key collision risk.
  `${workspaceId}::${catalogId}`;

export class LazyPluginLoader {
  private builders = new Map<string, LazyPluginBuilder>();
  private instances = new Map<string, PluginLike>();
  private pending = new Map<string, PendingBuild>();
  private generationCounter = 0;

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
   * explicitly evicted.
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
   * retries from scratch. An `evict` that races with an in-flight
   * build is honored — the build resolves to its original caller, but
   * the result is not cached.
   */
  async getOrInstantiate(workspaceId: string, catalogId: string): Promise<PluginLike> {
    const key = cacheKey(workspaceId, catalogId);

    const cached = this.instances.get(key);
    if (cached) return cached;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight.promise;

    const builder = this.builders.get(catalogId);
    if (!builder) {
      throw new LazyPluginBuilderMissingError(catalogId);
    }

    const generation = ++this.generationCounter;
    const buildPromise = (async () => {
      const config = await this.readInstallConfig(workspaceId, catalogId);
      return builder({ workspaceId, catalogId, config });
    })();

    this.pending.set(key, { promise: buildPromise, generation });

    try {
      const instance = await buildPromise;
      // If the pending entry was cleared (evict raced with us) or
      // replaced by a newer generation, drop our result on the floor —
      // the caller still gets their instance back, but it doesn't go
      // into the shared cache.
      const current = this.pending.get(key);
      if (current?.generation === generation) {
        this.instances.set(key, instance);
        this.pending.delete(key);
        log.debug(
          { workspaceId, catalogId },
          "LazyPluginLoader: instance constructed and cached",
        );
      }
      return instance;
    } catch (err) {
      const current = this.pending.get(key);
      if (current?.generation === generation) {
        this.pending.delete(key);
      }
      log.warn(
        {
          workspaceId,
          catalogId,
          err: err instanceof Error ? err.message : String(err),
        },
        "LazyPluginLoader: builder failed — next call will retry from scratch",
      );
      throw err;
    }
  }

  /**
   * Drop the cached instance for `(workspaceId, catalogId)` and call
   * its `teardown()` hook so any sockets / timers / refresh handles
   * are released. Returns `true` if an entry existed.
   *
   * Clearing `pending` here is what makes an `evict` racing with an
   * in-flight `getOrInstantiate` consistent — the build will resolve
   * but its `set` into `instances` is skipped (see `getOrInstantiate`).
   *
   * Teardown errors are caught and logged; they cannot block the next
   * `getOrInstantiate` from reconstructing.
   */
  async evict(workspaceId: string, catalogId: string): Promise<boolean> {
    const key = cacheKey(workspaceId, catalogId);
    this.pending.delete(key);
    const instance = this.instances.get(key);
    if (!instance) return false;
    this.instances.delete(key);
    if (typeof instance.teardown === "function") {
      try {
        await instance.teardown();
      } catch (err) {
        log.warn(
          {
            workspaceId,
            catalogId,
            err: err instanceof Error ? err.message : String(err),
          },
          "LazyPluginLoader: teardown threw during evict — instance is dropped anyway",
        );
      }
    }
    return true;
  }

  size(): number {
    return this.instances.size;
  }

  /** Reset all builder + instance state. Test-only. */
  _reset(): void {
    this.builders.clear();
    this.instances.clear();
    this.pending.clear();
    this.generationCounter = 0;
  }

  private async readInstallConfig(
    workspaceId: string,
    catalogId: string,
  ): Promise<Record<string, unknown>> {
    // `enabled = true` gate: a disabled install is treated as
    // not-installed for execution purposes. Admin surfaces that need
    // to inspect a disabled install read the table directly — they
    // don't go through the loader.
    const rows = await internalQuery<StoredRow>(
      "SELECT config FROM workspace_plugins WHERE workspace_id = $1 AND catalog_id = $2 AND enabled = true LIMIT 1",
      [workspaceId, catalogId],
    );
    if (rows.length === 0) {
      throw new LazyPluginInstallNotFoundError(workspaceId, catalogId);
    }
    const raw = rows[0].config;
    if (raw === null || raw === undefined) {
      // `workspace_plugins.config` is `NOT NULL DEFAULT '{}'` so JSON
      // `null` is data drift, not a default state — warn so ops can
      // catch a buggy write path. Still collapse to `{}` to keep the
      // builder shape stable.
      log.warn(
        { workspaceId, catalogId },
        "LazyPluginLoader: workspace_plugins.config is JSON null — coercing to {}",
      );
      return {};
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      log.warn(
        {
          workspaceId,
          catalogId,
          actualType: Array.isArray(raw) ? "array" : typeof raw,
        },
        "LazyPluginLoader: workspace_plugins.config is not a JSON object — coercing to {}",
      );
      return {};
    }
    return raw as Record<string, unknown>;
  }
}

/**
 * Process-wide singleton. Production callers reach for
 * `lazyPluginLoader`; tests instantiate a fresh `new LazyPluginLoader()`
 * to keep state isolated.
 */
export const lazyPluginLoader = new LazyPluginLoader();
