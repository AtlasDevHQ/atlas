/**
 * Validation + identity helpers shared between the admin connection-group
 * routes and the admin connections routes. Extracted so the connection
 * create / update routes can accept inline `newGroupName` and re-attach
 * via `connectionGroupId` without cross-route imports — `lib/` cannot
 * import from `api/routes/` (see CLAUDE.md "lib/ must not import from
 * api/routes/").
 */

/**
 * Validation regex matching the existing connection-id rule. Reused so a
 * group renamed to a value that would later collide with a connection id
 * stays predictable; group rename also normalizes through this so the
 * `name` column cannot accumulate trailing whitespace that would shadow a
 * legitimate value.
 */
export const GROUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

/**
 * Constraint name from migration 0062. Centralised so a future rename
 * surfaces in this one spot rather than in several string-equality checks.
 */
export const UNIQUE_NAME_CONSTRAINT = "uq_connection_groups_org_name";

/**
 * Generate a random `g_<rand>` group id. The hex tag avoids collisions
 * with the `g_<connection_id>` shape that migration 0062 uses for the
 * 1:1 legacy backfill — keeps user-created groups distinguishable from
 * auto-singletons even before the heuristic in `isAutoBackfilledSingleton`
 * (web) kicks in. The (id, org_id) PK is the final collision check; at
 * ~64 bits of entropy a retry-on-23505 path isn't load-bearing but
 * callers wire it correctly so the user never sees a misleading "name
 * conflict" for what was actually a PK collision.
 */
export function generateGroupId(): string {
  return `g_${Math.random().toString(36).slice(2, 10)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Narrow a thrown Postgres error to its `code` + `constraint` fields
 * without leaking `any`. `pg` populates both on driver-thrown errors;
 * non-driver throws come through with neither set, and the caller falls
 * through to its generic 500 path.
 *
 * Walks `.cause` chains so a wrapped pg error (Effect `Cause.fail`,
 * `new Error(msg, { cause: pgErr })`, retry-wrapping `internalQuery`)
 * still surfaces its driver fields — without this, the moment any
 * caller wraps the query, every 23505 disambiguation in this codebase
 * silently degrades to a generic 500. Depth-bounded at 5 to defend
 * against pathological cycles.
 */
export function pgErrorMeta(err: unknown): { code?: string; constraint?: string } {
  let cursor: unknown = err;
  for (let depth = 0; depth < 5 && cursor instanceof Error; depth++) {
    const code = "code" in cursor && typeof cursor.code === "string" ? cursor.code : undefined;
    const constraint =
      "constraint" in cursor && typeof cursor.constraint === "string" ? cursor.constraint : undefined;
    if (code || constraint) return { code, constraint };
    cursor = "cause" in cursor ? cursor.cause : undefined;
  }
  return {};
}
