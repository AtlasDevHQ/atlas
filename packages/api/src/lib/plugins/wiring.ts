/**
 * Plugin wiring — bridges plugins into existing Atlas registries.
 *
 * Each function accepts DI params for testability. When registries are
 * omitted, the global singletons are used.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { PluginRegistry, PluginLike } from "./registry";
import type { ConnectionRegistry } from "@atlas/api/lib/db/connection";
import type { ToolRegistry, AtlasTool, AtlasAction } from "@atlas/api/lib/tools/registry";
// Statically imported, unlike the tool registry below it: that one is a
// DEFAULT for an optional DI parameter and only needed when the caller omits
// it, while the action-type registry is used on every wired action. Nothing in
// the handler's graph reaches back here, so there is no cycle to defer around.
import {
  defineActionExecutor,
  getActionExecutorForType,
} from "@atlas/api/lib/tools/actions/handler";
// The dependency-free manifest, deliberately — see its header. Importing the
// action modules here to ask which types they own would defeat the point of
// the check, and would drag them into the boot graph ahead of the router that
// is supposed to load them.
import { isBuiltinActionType } from "@atlas/api/lib/tools/actions/manifest";

const log = createLogger("plugins:wiring");

// ---------------------------------------------------------------------------
// Structural checks for plugin subtypes (avoids SDK dependency)
// ---------------------------------------------------------------------------

interface ContextShape {
  contextProvider: {
    load(): Promise<string>;
    refresh?(): Promise<void>;
  };
}

interface DatasourceShape {
  connection: {
    // Optional: adapter-only plugins (SaaS per-workspace model) omit `create`
    // and expose only `createFromConfig`, consulted by the datasource bridge
    // for DB-stored installs. They are skipped for static boot-time wiring.
    create?(): Promise<{ query(sql: string, timeoutMs?: number): Promise<unknown>; close(): Promise<void> }> | { query(sql: string, timeoutMs?: number): Promise<unknown>; close(): Promise<void> };
    dbType: string;
    validate?(query: string): { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>;
    parserDialect?: string;
    forbiddenPatterns?: RegExp[];
  };
  entities?: unknown[] | (() => Promise<unknown[]> | unknown[]);
  dialect?: string;
}

// The plugin's `actions` array IS the AtlasAction shape — this used to
// restate all seven fields as an anonymous third spelling of the same record
// (beside `AtlasAction` and the plugin SDK's published type), which is two
// chances to drift for zero checking: `hasActions` only ever verifies
// Array.isArray, so the field-level claim is a typed assertion either way.
// Making it `AtlasAction` names the contract and lets `registry.register`
// accept the entries with no cast.
interface ActionShape {
  actions: ReadonlyArray<AtlasAction>;
}

interface InteractionShape {
  routes: (app: unknown) => void;
}

function hasContextProvider(p: PluginLike): p is PluginLike & ContextShape {
  return (
    p.types.includes("context") &&
    typeof (p as Record<string, unknown>).contextProvider === "object" &&
    (p as Record<string, unknown>).contextProvider !== null &&
    typeof ((p as Record<string, unknown>).contextProvider as Record<string, unknown>)?.load === "function"
  );
}

function hasDatasource(p: PluginLike): p is PluginLike & DatasourceShape {
  return (
    p.types.includes("datasource") &&
    typeof (p as Record<string, unknown>).connection === "object" &&
    (p as Record<string, unknown>).connection !== null
  );
}

function hasActions(p: PluginLike): p is PluginLike & ActionShape {
  return p.types.includes("action") && Array.isArray((p as Record<string, unknown>).actions);
}

function hasRoutes(p: PluginLike): p is PluginLike & InteractionShape {
  return p.types.includes("interaction") && typeof (p as Record<string, unknown>).routes === "function";
}

// ---------------------------------------------------------------------------
// Wiring functions
// ---------------------------------------------------------------------------

export interface DialectHint {
  readonly pluginId: string;
  /**
   * The engine this dialect guidance describes — the datasource plugin's
   * `connection.dbType`. Carried so the dialect-specialist registry
   * (`lib/dialect-specialist.ts`, #4515) can resolve a plugin's module BY
   * dbType and compose it for the groups in scope, keyed the same way as the
   * core modules.
   */
  readonly dbType: string;
  readonly dialect: string;
}

/**
 * For each healthy datasource plugin, call `connection.create()` and register
 * the resulting DBConnection in the ConnectionRegistry. Also resolves
 * plugin-provided entities and collects dialect hints.
 */
export async function wireDatasourcePlugins(
  pluginRegistry: PluginRegistry,
  connectionRegistry?: ConnectionRegistry,
): Promise<{ wired: string[]; failed: Array<{ pluginId: string; error: string }>; dialectHints: DialectHint[]; entityFailures: Array<{ pluginId: string; error: string }> }> {
  const connRegistry = connectionRegistry ?? (await import("@atlas/api/lib/db/connection")).connections;
  const datasources = pluginRegistry.getByType("datasource");
  const wired: string[] = [];
  const failed: Array<{ pluginId: string; error: string }> = [];
  const dialectHints: DialectHint[] = [];
  const entityFailures: Array<{ pluginId: string; error: string }> = [];

  for (const plugin of datasources) {
    if (!hasDatasource(plugin)) {
      log.warn({ pluginId: plugin.id }, "Datasource plugin missing connection property — skipped");
      continue;
    }
    // Adapter-only plugins (SaaS per-workspace model) have no static
    // config-defined connection — they implement only `createFromConfig` and
    // are consulted by the datasource bridge via the registry's `getAll()` for
    // DB-stored installs. They stay registered; there's just nothing to wire
    // statically. (Entities/dialect hints attach to a static connection, so
    // they're skipped here too — DB-stored connections carry their own
    // validation dialect via ConnectionPluginMeta at register time.)
    const createConn = plugin.connection.create?.bind(plugin.connection);
    if (typeof createConn !== "function") {
      log.debug(
        { pluginId: plugin.id, dbType: plugin.connection.dbType },
        "Adapter-only datasource plugin — no static connection to wire",
      );
      continue;
    }
    try {
      const conn = await createConn();
      const { parserDialect, forbiddenPatterns } = plugin.connection;
      const meta = (parserDialect || forbiddenPatterns)
        ? {
            ...(parserDialect !== undefined ? { parserDialect } : {}),
            ...(forbiddenPatterns !== undefined ? { forbiddenPatterns } : {}),
          }
        : undefined;
      connRegistry.registerDirect(
        plugin.id,
        conn as Parameters<ConnectionRegistry["registerDirect"]>[1],
        plugin.connection.dbType as Parameters<ConnectionRegistry["registerDirect"]>[2],
        plugin.name ?? plugin.id,
        plugin.connection.validate,
        meta,
      );
      wired.push(plugin.id);
      log.info({ pluginId: plugin.id, dbType: plugin.connection.dbType }, "Datasource plugin wired");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ pluginId: plugin.id, error: msg });
      log.error(
        { pluginId: plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
        "Failed to wire datasource plugin",
      );
      continue;
    }

    // Resolve plugin-provided entities (in-memory, no disk writes)
    if (plugin.entities !== undefined) {
      try {
        const resolved = typeof plugin.entities === "function"
          ? await plugin.entities()
          : plugin.entities;
        if (resolved != null && !Array.isArray(resolved)) {
          const msg = `entities factory returned non-array (${typeof resolved})`;
          log.error({ pluginId: plugin.id, type: typeof resolved }, msg);
          entityFailures.push({ pluginId: plugin.id, error: msg });
        } else if (Array.isArray(resolved) && resolved.length === 0) {
          log.warn({ pluginId: plugin.id }, "Plugin entities factory returned empty array");
        } else if (Array.isArray(resolved) && resolved.length > 0) {
          // Validate per-element shape: must have string name and yaml
          const valid: Array<{ name: string; yaml: string }> = [];
          for (const el of resolved) {
            if (
              el != null &&
              typeof el === "object" &&
              typeof (el as Record<string, unknown>).name === "string" &&
              typeof (el as Record<string, unknown>).yaml === "string"
            ) {
              valid.push(el as { name: string; yaml: string });
            } else {
              log.error(
                { pluginId: plugin.id, element: el },
                "Invalid entity element — expected { name: string; yaml: string }, skipping",
              );
            }
          }
          if (valid.length > 0) {
            const { registerPluginEntities } = await import("@atlas/api/lib/semantic");
            registerPluginEntities(plugin.id, valid);
            log.info({ pluginId: plugin.id, entityCount: valid.length }, "Plugin entities registered");
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        entityFailures.push({ pluginId: plugin.id, error: msg });
        log.error(
          { pluginId: plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
          "Failed to resolve plugin entities — connection still wired",
        );
      }
    }

    // Collect dialect hints, keyed by the plugin's engine so the
    // dialect-specialist registry (#4515) can resolve them by dbType.
    if (typeof plugin.dialect === "string" && plugin.dialect.trim()) {
      dialectHints.push({
        pluginId: plugin.id,
        dbType: plugin.connection.dbType,
        dialect: plugin.dialect,
      });
    }
  }

  return { wired, failed, dialectHints, entityFailures };
}

/**
 * Register one plugin action's executor, refusing the collisions that would
 * make it ambiguous whose code runs for an approved row (#5570).
 *
 * Two refusals, both at error level and both leaving the incumbent in place:
 *
 * **A built-in's type.** `plugins/jira` already declares `jira:create` and
 * `plugins/email` declares `email:send` — the same types the built-in modules
 * own. An executor decides which system a payload is sent to and which
 * workspace's credentials open it, so letting an installed plugin take
 * `email:send` would hand it every approved email's recipients, subject and
 * body for the requester's workspace. The check reads the static manifest, not
 * the live registry, so the answer does not depend on whether wiring happened
 * to run before or after the action modules loaded.
 *
 * **Another plugin's type.** First wiring wins. Arbitrary, but deterministic
 * and stated, which "last wins" was not.
 *
 * Overriding a built-in is a coherent thing to want and this is not a claim
 * that it should never exist — it needs its own design (an explicit operator
 * opt-in, at minimum), and shipping it as a silent side effect of installing a
 * plugin is not that design.
 */
function registerPluginExecutor(
  pluginId: string,
  action: AtlasAction,
  executor: NonNullable<AtlasAction["executor"]>,
): void {
  if (isBuiltinActionType(action.actionType)) {
    log.error(
      { pluginId, action: action.name, actionType: action.actionType },
      "Action plugin executor REFUSED — a built-in action module owns this action type. The built-in continues to execute approved rows of this type; the plugin's tool is still wired. Give the plugin action its own action type.",
    );
    return;
  }

  const incumbent = getActionExecutorForType(action.actionType);
  if (incumbent) {
    log.error(
      { pluginId, action: action.name, actionType: action.actionType },
      "Action plugin executor REFUSED — another plugin already registered an executor for this action type. The first registration continues to execute approved rows of this type.",
    );
    return;
  }

  defineActionExecutor(action.actionType, executor);
  log.info(
    { pluginId, action: action.name, actionType: action.actionType },
    "Action plugin executor registered",
  );
}

/**
 * For each healthy action plugin, register each PluginAction as an AtlasTool
 * in the ToolRegistry — and, when it declares one, its executor in the
 * action-type registry.
 *
 * ## Why the executor is registered HERE (#5570)
 *
 * The five built-in action modules call `defineActionExecutor` themselves, at
 * module load, beside the `AtlasAction` they belong to. A plugin cannot: it is
 * loaded dynamically, it must not import `@atlas/api`, and there is no moment
 * in its own lifecycle that corresponds to "the host's action registry is
 * ready". Wiring is that moment, and it is already the point where the
 * plugin's actions become visible to the rest of Atlas.
 *
 * The important property is that this is the SAME registry, not a parallel
 * one. An approved `webhook:post` row is executable by any instance that
 * wired the plugin, on exactly the terms a built-in `jira:create` row is —
 * so the restart gap this issue closes closes for plugin actions too, rather
 * than leaving them as the one path that still strands.
 */
export async function wireActionPlugins(
  pluginRegistry: PluginRegistry,
  toolRegistry?: ToolRegistry,
): Promise<{ wired: string[]; failed: Array<{ pluginId: string; error: string }> }> {
  const registry = toolRegistry ?? (await import("@atlas/api/lib/tools/registry")).defaultRegistry;
  const actionPlugins = pluginRegistry.getByType("action");
  const wired: string[] = [];
  const failed: Array<{ pluginId: string; error: string }> = [];

  for (const plugin of actionPlugins) {
    if (!hasActions(plugin)) {
      log.warn({ pluginId: plugin.id }, "Action plugin missing actions array — skipped");
      continue;
    }
    for (const action of plugin.actions) {
      try {
        registry.register(action);

        if (action.executor) {
          registerPluginExecutor(plugin.id, action, action.executor);
        } else if (action.defaultApproval !== "auto") {
          // An action that PENDS and declares no executor is a dead end: the
          // approval will report `approved_not_executed` and re-dispatch will
          // answer 503, forever. `warn`, not `debug` — debug is below the
          // default level on every deploy, so the author would get no signal
          // at all until an admin hit the wall.
          log.warn(
            { pluginId: plugin.id, action: action.name, actionType: action.actionType, defaultApproval: action.defaultApproval },
            "Action plugin declares no executor but its action pends for approval — approvals for this action type can never execute or be re-dispatched. Declare `executor` on the action (see the plugin authoring guide).",
          );
        } else {
          // Genuinely fine: an auto-approval action executes inline in its own
          // tool and never reaches the deferred path.
          log.debug(
            { pluginId: plugin.id, action: action.name, actionType: action.actionType },
            "Action plugin declares no executor — auto-approval action, executes inline",
          );
        }

        wired.push(action.name);
        log.info({ pluginId: plugin.id, action: action.name }, "Action plugin tool wired");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push({ pluginId: plugin.id, error: msg });
        log.error(
          { pluginId: plugin.id, action: action.name, err: err instanceof Error ? err : new Error(String(err)) },
          "Failed to wire action plugin tool",
        );
      }
    }
  }

  return { wired, failed };
}

/**
 * For each healthy interaction plugin, call `routes(app)` to mount Hono routes.
 */
export async function wireInteractionPlugins(
  pluginRegistry: PluginRegistry,
  app: unknown,
): Promise<{ wired: string[]; failed: Array<{ pluginId: string; error: string }> }> {
  const interactionPlugins = pluginRegistry.getByType("interaction");
  const wired: string[] = [];
  const failed: Array<{ pluginId: string; error: string }> = [];

  for (const plugin of interactionPlugins) {
    if (!hasRoutes(plugin)) {
      log.debug({ pluginId: plugin.id }, "Interaction plugin has no routes — skipping route wiring");
      continue;
    }
    try {
      // Scope plugin routes under /api/plugins/:pluginId to prevent auth bypass
      const { Hono } = await import("hono");
      const subApp = new Hono();
      plugin.routes(subApp);
      (app as { route(path: string, app: unknown): void }).route(`/api/plugins/${plugin.id}`, subApp);
      wired.push(plugin.id);
      log.info({ pluginId: plugin.id, prefix: `/api/plugins/${plugin.id}` }, "Interaction plugin routes mounted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ pluginId: plugin.id, error: msg });
      log.error(
        { pluginId: plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
        "Failed to wire interaction plugin routes",
      );
    }
  }

  return { wired, failed };
}

// ---------------------------------------------------------------------------
// Sandbox plugins
// ---------------------------------------------------------------------------

/**
 * Duplicated from @useatlas/plugin-sdk/types to avoid runtime SDK dependency.
 * Keep in sync — explore-sdk-compat.test.ts verifies structural equivalence.
 */
const SANDBOX_DEFAULT_PRIORITY = 60;

/**
 * Sandbox execution backend interface.
 * Canonical definition lives in backends/types.ts. Re-exported here for
 * backward compatibility with plugins that reference SandboxExecBackend.
 */
import type { ExploreBackend } from "@atlas/api/lib/tools/backends/types";
export type SandboxExecBackend = ExploreBackend;

interface SandboxShape {
  sandbox: {
    create(root: string): Promise<SandboxExecBackend> | SandboxExecBackend;
    priority?: number;
  };
}

function hasSandbox(p: PluginLike): p is PluginLike & SandboxShape {
  return (
    p.types.includes("sandbox") &&
    typeof (p as Record<string, unknown>).sandbox === "object" &&
    (p as Record<string, unknown>).sandbox !== null &&
    typeof ((p as Record<string, unknown>).sandbox as Record<string, unknown>)?.create === "function"
  );
}

/**
 * Discover sandbox plugins, sort by priority (highest first), and try to
 * create a backend from each until one succeeds.
 *
 * Unlike other wire functions, sandbox plugins are not registered into a
 * global registry — the caller receives a single backend instance directly.
 *
 * NOTE: In practice, called lazily from getExploreBackend() on the first
 * explore command (not at startup), because the explore backend is cached
 * as a singleton and depends on runtime environment detection.
 */
export async function wireSandboxPlugins(
  pluginRegistry: PluginRegistry,
  semanticRoot: string,
): Promise<{
  backend: SandboxExecBackend | null;
  pluginId: string | null;
  failed: Array<{ pluginId: string; error: string }>;
}> {
  const sandboxPlugins = pluginRegistry.getByType("sandbox");
  const failed: Array<{ pluginId: string; error: string }> = [];

  if (sandboxPlugins.length === 0) {
    return { backend: null, pluginId: null, failed };
  }

  // Filter to valid sandbox plugins, sort by priority descending
  const valid = sandboxPlugins.filter(hasSandbox);
  if (valid.length === 0) {
    for (const sp of sandboxPlugins) {
      log.warn({ pluginId: sp.id }, "Sandbox plugin missing sandbox.create() — skipped");
    }
    return { backend: null, pluginId: null, failed };
  }

  const sorted = [...valid].sort((a, b) => {
    const pa = a.sandbox.priority ?? SANDBOX_DEFAULT_PRIORITY;
    const pb = b.sandbox.priority ?? SANDBOX_DEFAULT_PRIORITY;
    return pb - pa;
  });

  for (const sp of sorted) {
    try {
      const backend = await sp.sandbox.create(semanticRoot);
      if (!backend || typeof backend.exec !== "function") {
        const msg = "create() returned invalid backend (missing exec method)";
        failed.push({ pluginId: sp.id, error: msg });
        log.error({ pluginId: sp.id }, msg);
        continue;
      }
      log.info({ pluginId: sp.id }, "Using sandbox plugin for explore backend");
      return { backend, pluginId: sp.id, failed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ pluginId: sp.id, error: msg });
      log.error(
        { pluginId: sp.id, err: err instanceof Error ? err : new Error(String(err)) },
        "Sandbox plugin create() failed, trying next",
      );
    }
  }

  log.error({ count: sorted.length }, "All sandbox plugins failed to create a backend");
  return { backend: null, pluginId: null, failed };
}

/**
 * For each healthy context plugin, call `contextProvider.load()` and collect
 * the returned text fragments. Fragments are injected into the agent system
 * prompt to provide additional context from plugins.
 */
export async function wireContextPlugins(
  pluginRegistry: PluginRegistry,
): Promise<{ fragments: string[]; failed: Array<{ pluginId: string; error: string }> }> {
  const contextPlugins = pluginRegistry.getByType("context");
  const fragments: string[] = [];
  const failed: Array<{ pluginId: string; error: string }> = [];

  for (const plugin of contextPlugins) {
    if (!hasContextProvider(plugin)) {
      log.warn({ pluginId: plugin.id }, "Context plugin missing contextProvider — skipped");
      continue;
    }
    try {
      const fragment = await plugin.contextProvider.load();
      if (fragment.trim()) {
        fragments.push(fragment);
      }
      log.info({ pluginId: plugin.id, fragmentLength: fragment.length }, "Context plugin loaded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ pluginId: plugin.id, error: msg });
      log.error(
        { pluginId: plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
        "Failed to load context plugin",
      );
    }
  }

  return { fragments, failed };
}
