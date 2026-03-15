/**
 * Re-exports from Hono for plugin authors.
 *
 * The `hono` package is an optional peer dependency of `@useatlas/plugin-sdk`.
 * Install it when your plugin mounts HTTP routes (interaction plugins).
 *
 * @example
 * ```typescript
 * import { Hono } from "@useatlas/plugin-sdk/hono";
 * import type { Context } from "@useatlas/plugin-sdk/hono";
 *
 * function mountRoutes(app: Hono) {
 *   app.get("/api/my-plugin/health", (c: Context) => c.json({ ok: true }));
 * }
 * ```
 */

export { Hono } from "hono";
export type { Context, MiddlewareHandler } from "hono";
