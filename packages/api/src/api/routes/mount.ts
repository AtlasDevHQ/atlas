/**
 * Trailing-slash-tolerant sub-router mounting.
 *
 * Hono matches trailing slashes strictly: mounting a child at "/audit" makes
 * its root route answer `GET /audit` but NOT `GET /audit/` (and vice versa),
 * so every mount historically needed a hand-written pair —
 * `admin.route("/audit", x)` + `admin.route("/audit/", x)`. With ~50 such
 * pairs a new sub-router could be half-registered (one variant only) with no
 * signal (#4202 — `/organizations` shipped exactly that way).
 *
 * `mountBoth` is the single registration seam: one call registers both
 * variants, so the invariant "route behavior is identical with and without a
 * trailing slash" holds by construction. Sub-paths are unaffected either way
 * (Hono's mergePath collapses the double slash), so the pair only matters for
 * the child's root ("/") routes.
 */

import type { Env, Hono, Schema } from "hono";

/**
 * Mount `child` on `parent` at both `path` and `path + "/"`.
 *
 * Registration order is preserved relative to other mounts — the bare path is
 * registered first, then the trailing-slash variant, exactly like the manual
 * pairs this replaces. When `parent` is an `OpenAPIHono`, its `.route()`
 * override still runs (runtime dispatch), so OpenAPI registry merging is
 * unchanged.
 *
 * @throws Error at registration (boot) time when `path` ends with "/" — the
 * variant is added automatically, and accepting one would silently register
 * `path` and `path + "//"` instead of the intended pair.
 */
export function mountBoth<
  E extends Env,
  S extends Schema,
  BasePath extends string,
  SubEnv extends Env,
  SubSchema extends Schema,
  SubBasePath extends string,
>(
  parent: Hono<E, S, BasePath>,
  path: string,
  child: Hono<SubEnv, SubSchema, SubBasePath>,
): void {
  if (path.endsWith("/")) {
    throw new Error(
      `mountBoth: path must not end with "/" (got "${path}") — the trailing-slash variant is registered automatically`,
    );
  }
  parent.route(path, child);
  parent.route(`${path}/`, child);
}
