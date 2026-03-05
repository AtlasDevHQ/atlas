/**
 * Plugin hook dispatch runtime.
 *
 * Dispatches lifecycle hooks (beforeQuery, afterQuery, beforeExplore,
 * afterExplore, onRequest, onResponse) to all healthy plugins that
 * define matching hook entries. Zero overhead when no plugins are registered.
 *
 * Mutable hooks (beforeQuery, beforeExplore) can return a mutation object
 * to rewrite the SQL/command, or throw to reject the operation. All other
 * hooks are observation-only (void return — handler return values are
 * discarded). Mutations chain in registration order across healthy plugins
 * — unhealthy plugins are silently skipped.
 */

import { plugins } from "./registry";
import type { PluginRegistry } from "./registry";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("plugins:hooks");

interface HookEntry<T> {
  matcher?: (ctx: T) => boolean;
  handler: (ctx: T) => Promise<unknown> | unknown;
}

type HookName = "beforeQuery" | "afterQuery" | "beforeExplore" | "afterExplore" | "onRequest" | "onResponse";

/** Hook names that support mutation via dispatchMutableHook. */
type MutableHookName = "beforeQuery" | "beforeExplore";

/**
 * Dispatch a named hook to all healthy plugins (observation-only —
 * handler return values are discarded).
 *
 * - Skips entirely when no plugins are registered (zero overhead).
 * - Respects `matcher` filters on individual hook entries.
 * - Catches and logs errors from hook handlers — never crashes the caller.
 *
 * @param registry - Optional plugin registry override (default: global singleton). For testing.
 */
export async function dispatchHook<T>(
  hookName: HookName,
  context: T,
  registry?: PluginRegistry,
): Promise<void> {
  const reg = registry ?? plugins;
  if (reg.size === 0) return;

  const healthyPlugins = reg.getAllHealthy();
  if (healthyPlugins.length === 0) return;

  for (const plugin of healthyPlugins) {
    const hooks = (plugin as Record<string, unknown>).hooks as Record<string, HookEntry<T>[]> | undefined;
    if (!hooks?.[hookName]) continue;

    for (const entry of hooks[hookName]) {
      try {
        if (entry.matcher && !entry.matcher(context)) continue;
        await entry.handler(context);
      } catch (err) {
        log.warn(
          { pluginId: plugin.id, hookName, err: err instanceof Error ? err : new Error(String(err)) },
          "Plugin hook failed",
        );
      }
    }
  }
}

/**
 * Dispatch a mutable hook and return the final mutated value.
 *
 * - Chains mutations in plugin registration order across healthy plugins.
 * - Each hook handler receives a context with the latest mutated value applied.
 * - Handlers that return `void`/`undefined` pass through without mutation.
 * - Handlers that return a mutation object (e.g. `{ sql }`) update the value
 *   for subsequent hooks.
 * - If any handler **throws**, the error propagates immediately — the caller
 *   should treat this as a rejection (e.g. deny the query).
 * - Matcher errors are caught and logged (skipping the entry), NOT treated
 *   as rejections.
 *
 * @param hookName   - "beforeQuery" or "beforeExplore"
 * @param context    - The initial hook context
 * @param mutateKey  - The context key to mutate (e.g. "sql" or "command")
 * @param registry   - Optional plugin registry override. For testing.
 * @returns The final mutated value (or the original if no hooks mutated it).
 */
export async function dispatchMutableHook<
  T extends Record<string, unknown>,
  K extends string & keyof T,
>(
  hookName: MutableHookName,
  context: T,
  mutateKey: K,
  registry?: PluginRegistry,
): Promise<T[K]> {
  const reg = registry ?? plugins;
  let currentValue = context[mutateKey];

  if (reg.size === 0) return currentValue;

  const healthyPlugins = reg.getAllHealthy();
  if (healthyPlugins.length === 0) return currentValue;

  // Build a mutable copy of the context so each hook sees the latest value
  const mutableCtx = { ...context };

  for (const plugin of healthyPlugins) {
    const hooks = (plugin as Record<string, unknown>).hooks as Record<string, HookEntry<T>[]> | undefined;
    if (!hooks?.[hookName]) continue;

    for (const entry of hooks[hookName]) {
      // Matcher errors are bugs, not rejections — catch and skip
      if (entry.matcher) {
        let matched: boolean;
        try {
          matched = entry.matcher(mutableCtx);
        } catch (matcherErr) {
          log.error(
            { pluginId: plugin.id, hookName, err: matcherErr instanceof Error ? matcherErr : new Error(String(matcherErr)) },
            "Plugin hook matcher threw — skipping entry",
          );
          continue;
        }
        if (!matched) continue;
      }

      // Handler throws propagate — intentional for "deny" use cases
      let result: unknown;
      try {
        result = await entry.handler(mutableCtx);
      } catch (err) {
        log.warn(
          { pluginId: plugin.id, hookName, err: err instanceof Error ? err : new Error(String(err)) },
          "Plugin hook rejected operation",
        );
        throw err;
      }

      // Apply mutation if the handler returned one
      if (result != null && typeof result === "object" && mutateKey in (result as Record<string, unknown>)) {
        const newValue = (result as Record<string, unknown>)[mutateKey];
        if (typeof newValue !== typeof currentValue) {
          log.error(
            { pluginId: plugin.id, hookName, mutateKey, expectedType: typeof currentValue, gotType: typeof newValue },
            "Plugin returned wrong type for mutated value — ignoring mutation",
          );
          continue;
        }
        currentValue = newValue as T[K];
        (mutableCtx as Record<string, unknown>)[mutateKey] = currentValue;
        log.debug(
          { pluginId: plugin.id, hookName, mutateKey },
          "Plugin mutated hook value",
        );
      }
    }
  }

  return currentValue;
}
